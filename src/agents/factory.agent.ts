import path from "node:path";

import type { Hono } from "hono";

import { LocalCodexExecutor } from "../adapters/codex-executor.js";
import type { MemoryTools } from "../adapters/memory-tools.js";
import { fold } from "../core/chain.js";
import type { Runtime } from "../core/runtime.js";
import {
  emptyHtml,
  html,
  json,
  optionalTrimmedString,
  readRecordBody,
  requireTrimmedString,
  text,
  trimmedString,
} from "../framework/http.js";
import type { AgentLoaderContext, AgentRouteModule } from "../framework/agent-types.js";
import {
  type AgentRunConfig,
} from "./agent.js";
import { agentRunStream } from "./agent.streams.js";
import {
  FACTORY_CHAT_DEFAULT_CONFIG,
  normalizeFactoryChatConfig,
} from "./factory-chat.js";
import type { AgentCmd, AgentEvent, AgentState } from "../modules/agent.js";
import { initial as initialAgent, reduce as reduceAgent } from "../modules/agent.js";
import {
  factoryChatStream,
  discoverFactoryChatProfiles,
  resolveFactoryChatProfile,
} from "../services/factory-chat-profiles.js";
import {
  FactoryService,
  FactoryServiceError,
  type FactoryLiveOutputTargetKind,
  type FactoryObjectiveDetail,
  type FactoryTaskView,
} from "../services/factory-service.js";
import {
  factoryChatIsland,
  factoryChatShell,
  factoryInspectorIsland,
  factorySidebarIsland,
  type FactoryChatIslandModel,
  type FactoryChatItem,
  type FactoryChatObjectiveNav,
  type FactoryChatProfileNav,
  type FactoryChatShellModel,
  type FactoryChatJobNav,
  type FactorySidebarModel,
  type FactoryLiveCodexCard,
  type FactorySelectedObjectiveCard,
  type FactoryWorkCard,
} from "../views/factory-chat.js";
import {
  factoryMissionControlShell,
  factoryMissionInspectorIsland,
  factoryMissionLiveOutputIsland,
  factoryMissionMainIsland,
  factoryMissionRailIsland,
  type FactoryMissionFocusKind,
  type FactoryMissionFocusModel,
  type FactoryMissionJobSummary,
  type FactoryMissionObjectiveNav,
  type FactoryMissionPanel,
  type FactoryMissionReceiptSummary,
  type FactoryMissionRunSummary,
  type FactoryMissionSectionKey,
  type FactoryMissionSelectedModel,
  type FactoryMissionShellModel,
  type FactoryMissionTaskSummary,
} from "../views/factory-mission-control.js";
import type { QueueJob } from "../adapters/jsonl-queue.js";

const isActiveJobStatus = (status?: string): boolean =>
  status === "queued" || status === "leased" || status === "running";

const parseChecks = (value: unknown): ReadonlyArray<string> | undefined => {
  if (typeof value === "string") {
    const lines = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    return lines.length > 0 ? lines : undefined;
  }
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
};

const deriveObjectiveTitle = (prompt: string): string => {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const sentence = compact.split(/[.!?]/)[0] ?? compact;
  return sentence.slice(0, 96).trim();
};

const parsePolicy = (value: unknown): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      throw new FactoryServiceError(400, "Malformed policy JSON");
    }
    throw new FactoryServiceError(400, "Policy must be an object");
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new FactoryServiceError(400, "Policy must be an object");
};

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const tryParseJson = (value: string): Record<string, unknown> | undefined => {
  try {
    return asObject(JSON.parse(value));
  } catch {
    return undefined;
  }
};

const summarizeJob = (job: QueueJob): string => {
  const result = asObject(job.result);
  const failure = asObject(result?.failure);
  const resultSummary = asString(result?.summary)
    ?? asString(result?.finalResponse)
    ?? asString(result?.note)
    ?? asString(result?.message)
    ?? asString(failure?.message);
  if (resultSummary) return resultSummary;
  if (job.lastError) return job.lastError;
  const payloadProblem = asString(job.payload.problem);
  if (payloadProblem) return payloadProblem.replace(/\s+/g, " ").slice(0, 120);
  const kind = asString(job.payload.kind);
  if (kind) return kind;
  return `${job.agentId} job`;
};

const isRelevantShellJob = (job: QueueJob, stream: string, objectiveId?: string): boolean => {
  const payloadObjectiveId = asString(job.payload.objectiveId);
  const payloadStream = asString(job.payload.stream);
  const parentStream = asString(job.payload.parentStream);
  return payloadStream === stream
    || parentStream === stream
    || (Boolean(objectiveId) && payloadObjectiveId === objectiveId);
};

const isTerminalJobStatus = (status: string | undefined): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const codexJobPriority = (job: QueueJob): number => {
  if (!isTerminalJobStatus(job.status)) return 0;
  if (job.status === "failed") return 1;
  if (job.status === "completed") return 2;
  return 3;
};

const buildActiveCodexCard = (jobs: ReadonlyArray<QueueJob>): FactoryLiveCodexCard | undefined => {
  const codexJob = [...jobs]
    .filter((job) => job.agentId === "factory-codex" || job.agentId === "codex")
    .sort((left, right) =>
      codexJobPriority(left) - codexJobPriority(right)
      || right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
      || right.id.localeCompare(left.id)
    )[0];
  if (!codexJob) return undefined;
  const result = asObject(codexJob.result);
  return {
    jobId: codexJob.id,
    status: codexJob.status,
    summary: summarizeJob(codexJob),
    latestNote: asString(result?.lastMessage) ?? asString(result?.message),
    stderrTail: asString(result?.stderrTail),
    stdoutTail: asString(result?.stdoutTail),
    runId: asString(codexJob.payload.parentRunId) ?? asString(codexJob.payload.runId),
    task: asString(codexJob.payload.task)
      ?? asString(codexJob.payload.prompt)
      ?? asString(codexJob.payload.problem)
      ?? asString(codexJob.payload.taskId),
    updatedAt: codexJob.updatedAt,
    abortRequested: codexJob.abortRequested === true,
    rawLink: `/jobs/${encodeURIComponent(codexJob.id)}`,
    running: !isTerminalJobStatus(codexJob.status),
  };
};

const interestingTools = new Set([
  "agent.delegate",
  "agent.status",
  "job.control",
  "codex.run",
  "factory.dispatch",
  "factory.status",
  "profile.handoff",
]);

type ToolObservation = {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly output?: string;
  readonly summary?: string;
  readonly error?: string;
  readonly durationMs?: number;
};

const overlayLiveJobState = (card: FactoryWorkCard, job: QueueJob | undefined): FactoryWorkCard => {
  if (!job) return card;
  const parsed = asObject(job.result);
  const failure = asObject(parsed?.failure);
  const terminalSummary = job.status === "failed"
    ? job.lastError ?? asString(failure?.message)
    : job.status === "canceled"
      ? job.canceledReason ?? asString(parsed?.note)
      : undefined;
  const summary = terminalSummary
    ?? asString(parsed?.summary)
    ?? asString(parsed?.finalResponse)
    ?? asString(parsed?.note)
    ?? asString(parsed?.message)
    ?? asString(failure?.message)
    ?? job.lastError
    ?? card.summary;
  const detail = [
    asString(parsed?.lastMessage),
    asString(parsed?.message),
    asString(parsed?.stderrTail),
    asString(parsed?.stdoutTail),
    card.detail,
  ].filter(Boolean).join("\n\n");
  return {
    ...card,
    status: job.status,
    summary,
    detail: detail || undefined,
    running: !isTerminalJobStatus(job.status),
  };
};

const summarizeStructuredSupervisorFinal = (
  content: string,
  jobsById: ReadonlyMap<string, QueueJob>,
  fallbackChildCard?: FactoryWorkCard,
): { readonly title: string; readonly body: string; readonly childCard?: FactoryWorkCard } | undefined => {
  const parsed = tryParseJson(content);
  if (!parsed) return undefined;
  const codex = asObject(parsed.codex);
  const otherRelevant = asObject(parsed.otherRelevant);
  if (!codex && !otherRelevant) return undefined;

  let childCard = fallbackChildCard;
  const lines: string[] = [];
  const codexJobId = asString(codex?.jobId);
  const codexJob = codexJobId ? jobsById.get(codexJobId) : undefined;
  const codexStatus = asString(codex?.status) ?? codexJob?.status;
  const codexTask = asString(codex?.task);
  const codexLatestNote = asString(codex?.latestNote);
  if (codex) {
    const synthesizedCard: FactoryWorkCard = {
      key: `codex-final-${codexJobId ?? "snapshot"}`,
      title: "Codex child status",
      worker: "codex",
      status: codexStatus ?? "running",
      summary: codexLatestNote ?? codexTask ?? "Codex child is still processing this request.",
      detail: [codexTask, codexLatestNote]
        .filter((value, index, list) => value && list.indexOf(value) === index)
        .join("\n\n") || undefined,
      jobId: codexJobId,
      running: !isTerminalJobStatus(codexStatus),
    };
    childCard = childCard
      ? overlayLiveJobState(childCard, codexJob)
      : overlayLiveJobState(synthesizedCard, codexJob);
    lines.push(`Codex child ${childCard.jobId ?? codexJobId ?? "unknown"} is ${childCard.status}.`);
    if (childCard.summary) lines.push(`Latest child summary: ${childCard.summary}`);
  }

  const relevantLines = Object.entries(otherRelevant ?? {})
    .map(([label, value]) => {
      const entry = asObject(value);
      if (!entry) return undefined;
      const jobId = asString(entry.jobId) ?? "unknown";
      const status = asString(entry.status) ?? "unknown";
      const result = asString(entry.result) ?? asString(entry.summary);
      return `${label}: ${jobId} is ${status}${result ? ` — ${result}` : ""}`;
    })
    .filter((value): value is string => Boolean(value));
  if (relevantLines.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...relevantLines);
  }

  return {
    title: childCard?.running ? "Supervisor waiting on child" : "Supervisor snapshot",
    body: lines.join("\n"),
    childCard,
  };
};

const workCardFromObservation = (observation: ToolObservation): FactoryWorkCard | undefined => {
  if (!interestingTools.has(observation.tool)) return undefined;
  const durationLabel = typeof observation.durationMs === "number" && Number.isFinite(observation.durationMs)
    ? `${Math.max(1, Math.round(observation.durationMs / 1000))}s`
    : undefined;

  if (observation.error) {
    return {
      key: `${observation.tool}-error-${observation.summary ?? observation.error}`,
      title: observation.tool,
      worker: observation.tool.split(".")[0] ?? "tool",
      status: "failed",
      summary: observation.error,
      detail: observation.summary,
      meta: durationLabel,
      running: false,
    };
  }

  const parsed = observation.output ? tryParseJson(observation.output) : undefined;
  if (observation.tool === "agent.delegate") {
    const delegatedTo = asString(parsed?.delegatedTo) ?? asString(observation.input.agentId) ?? "agent";
    return {
      key: `${observation.tool}-${asString(parsed?.jobId) ?? observation.summary ?? "delegate"}`,
      title: `Delegated to ${delegatedTo}`,
      worker: delegatedTo,
      status: asString(parsed?.status) ?? "queued",
      summary: asString(parsed?.summary) ?? observation.summary ?? "Delegated work queued.",
      detail: observation.output,
      meta: durationLabel,
      jobId: asString(parsed?.jobId),
      running: !isTerminalJobStatus(asString(parsed?.status)),
    };
  }
  if (observation.tool === "agent.status") {
    return {
      key: `${observation.tool}-${asString(parsed?.jobId) ?? observation.summary ?? "status"}`,
      title: "Child job status",
      worker: asString(parsed?.worker) ?? "agent",
      status: asString(parsed?.status) ?? "unknown",
      summary: asString(parsed?.summary) ?? observation.summary ?? `Job ${asString(parsed?.jobId) ?? "unknown"}`,
      detail: observation.output,
      meta: durationLabel,
      jobId: asString(parsed?.jobId),
      running: !isTerminalJobStatus(asString(parsed?.status)),
    };
  }
  if (observation.tool === "job.control") {
    return {
      key: `${observation.tool}-${asString(parsed?.jobId) ?? observation.summary ?? "job-control"}`,
      title: "Job command queued",
      worker: "queue",
      status: asString(parsed?.status) ?? "queued",
      summary: observation.summary ?? "Queued a command for a child job.",
      detail: observation.output,
      meta: [asString(parsed?.command), durationLabel].filter(Boolean).join(" · "),
      jobId: asString(parsed?.jobId),
      running: false,
    };
  }
  if (observation.tool === "codex.run") {
    return {
      key: `${observation.tool}-${asString(parsed?.jobId) ?? observation.summary ?? "codex"}`,
      title: "Codex run",
      worker: asString(parsed?.worker) ?? "codex",
      status: asString(parsed?.status) ?? "queued",
      summary: asString(parsed?.summary) ?? observation.summary ?? "Codex run queued.",
      detail: [
        asString(parsed?.lastMessage),
        asString(parsed?.stderrTail),
        asString(parsed?.stdoutTail),
      ].filter(Boolean).join("\n\n") || observation.output,
      meta: durationLabel,
      link: asString(parsed?.link),
      jobId: asString(parsed?.jobId),
      running: !isTerminalJobStatus(asString(parsed?.status)),
    };
  }
  if (observation.tool === "factory.dispatch" || observation.tool === "factory.status") {
    const action = asString(parsed?.action);
    return {
      key: `${observation.tool}-${asString(parsed?.objectiveId) ?? observation.summary ?? "factory"}`,
      title: observation.tool === "factory.status"
        ? "Thread status"
        : action === "create"
          ? "Thread started"
          : action === "react"
            ? "Thread updated"
            : action === "promote"
              ? "Thread promoted"
              : action === "cancel"
                ? "Thread stopped"
                : action === "cleanup"
                  ? "Worktrees removed"
                  : action === "archive"
                    ? "Thread archived"
                    : "Factory thread",
      worker: asString(parsed?.worker) ?? "factory",
      status: asString(parsed?.status) ?? "updated",
      summary: asString(parsed?.summary) ?? observation.summary ?? "Factory updated.",
      detail: observation.output,
      meta: [action, durationLabel].filter(Boolean).join(" · "),
      link: asString(parsed?.link),
      objectiveId: asString(parsed?.objectiveId),
      running: !isTerminalJobStatus(asString(parsed?.status)),
    };
  }
  if (observation.tool === "profile.handoff") {
    return {
      key: `${observation.tool}-${asString(parsed?.toProfileId) ?? observation.summary ?? "handoff"}`,
      title: "Profile handoff",
      worker: "profile",
      status: asString(parsed?.status) ?? "queued",
      summary: asString(parsed?.summary) ?? observation.summary ?? "Continuation queued on another profile.",
      detail: observation.output,
      meta: durationLabel,
      link: asString(parsed?.link),
      jobId: asString(parsed?.jobId),
      running: !isTerminalJobStatus(asString(parsed?.status)),
    };
  }
  return undefined;
};

const formatRunMeta = (runId: string, state: AgentState, firstTs?: number): string => {
  const parts = [`Run ${runId}`];
  if (typeof firstTs === "number") parts.push(new Date(firstTs).toLocaleString());
  parts.push(state.status);
  return parts.join(" · ");
};

const reverseFind = <T,>(items: ReadonlyArray<T>, predicate: (item: T) => boolean): T | undefined => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return item;
  }
  return undefined;
};

export const buildChatItemsForRun = (
  runId: string,
  chain: Awaited<ReturnType<Runtime<AgentCmd, AgentEvent, AgentState>["chain"]>>,
  jobsById: ReadonlyMap<string, QueueJob>,
): ReadonlyArray<FactoryChatItem> => {
  const items: FactoryChatItem[] = [];
  const state = fold(chain, reduceAgent, initialAgent);
  const firstTs = chain[0]?.ts;
  const problem = chain.find((receipt) => receipt.body.type === "problem.set")?.body;
  if (problem?.type === "problem.set") {
    items.push({
      key: `${runId}-user`,
      kind: "user",
      body: problem.problem,
      meta: formatRunMeta(runId, state, firstTs),
    });
  }

  for (const receipt of chain) {
    const event = receipt.body;
    if (event.type === "profile.selected") {
      items.push({
        key: `${runId}-profile-selected-${receipt.hash}`,
        kind: "system",
        title: `Profile ${event.profileId} active`,
        body: `Selection reason: ${event.reason}`,
        meta: new Date(receipt.ts).toLocaleString(),
      });
      continue;
    }
    if (event.type === "profile.handoff") {
      items.push({
        key: `${runId}-profile-handoff-${receipt.hash}`,
        kind: "system",
        title: `Handed off to ${event.toProfileId}`,
        body: event.reason,
        meta: new Date(receipt.ts).toLocaleString(),
      });
      continue;
    }
    if (event.type === "subagent.merged") {
      const job = jobsById.get(event.subJobId);
      const worker = job?.agentId === "factory-codex"
        ? "codex"
        : asString(asObject(job?.result)?.worker) ?? "subagent";
      const baseCard: FactoryWorkCard = {
        key: `${runId}-subagent-${receipt.hash}`,
        title: worker === "codex" ? "Codex child update" : "Child update",
        worker,
        status: job?.status ?? "running",
        summary: event.summary,
        detail: event.task,
        meta: new Date(receipt.ts).toLocaleString(),
        jobId: event.subJobId,
        running: !isTerminalJobStatus(job?.status),
      };
      items.push({
        key: `${runId}-subagent-${receipt.hash}`,
        kind: "work",
        card: overlayLiveJobState(baseCard, job),
      });
      continue;
    }
  }

  const pending = new Map<string, ToolObservation>();
  for (const receipt of chain) {
    const event = receipt.body;
    if (event.type === "tool.called") {
      const key = `${event.iteration}:${event.tool}`;
      pending.set(key, {
        tool: event.tool,
        input: event.input,
        summary: event.summary,
        error: event.error,
        durationMs: event.durationMs,
      });
      if (event.error) {
        const card = workCardFromObservation({
          tool: event.tool,
          input: event.input,
          summary: event.summary,
          error: event.error,
          durationMs: event.durationMs,
        });
        if (card) items.push({ key: `${runId}-tool-error-${receipt.hash}`, kind: "work", card });
      }
      continue;
    }
    if (event.type === "tool.observed") {
      const key = `${event.iteration}:${event.tool}`;
      const prior = pending.get(key);
      const card = workCardFromObservation({
        tool: event.tool,
        input: prior?.input ?? {},
        output: event.output,
        summary: prior?.summary,
        error: prior?.error,
        durationMs: prior?.durationMs,
      });
      if (card) {
        items.push({
          key: `${runId}-tool-${receipt.hash}`,
          kind: "work",
          card: card.worker === "queue"
            ? card
            : overlayLiveJobState(card, card.jobId ? jobsById.get(card.jobId) : undefined),
        });
      }
      pending.delete(key);
    }
  }

  const final = reverseFind(chain, (receipt) => receipt.body.type === "response.finalized")?.body;
  const latestChildCard = [...items].reverse().find((item): item is Extract<FactoryChatItem, { kind: "work" }> =>
    item.kind === "work" && Boolean(item.card.jobId) && item.card.worker === "codex"
  )?.card;
  const latestObjectiveCard = [...items].reverse().find((item): item is Extract<FactoryChatItem, { kind: "work" }> =>
    item.kind === "work" && Boolean(item.card.objectiveId)
  )?.card;
  if (final?.type === "response.finalized") {
    const structuredFinal = summarizeStructuredSupervisorFinal(final.content, jobsById, latestChildCard);
    if (structuredFinal) {
      items.push({
        key: `${runId}-structured-final`,
        kind: "system",
        title: structuredFinal.title,
        body: structuredFinal.body,
        meta: structuredFinal.childCard?.running ? "child running" : (state.statusNote ?? state.status),
      });
      if (!latestChildCard && structuredFinal.childCard) {
        items.push({
          key: `${runId}-structured-final-card`,
          kind: "work",
          card: structuredFinal.childCard,
        });
      }
    } else if (state.failure?.failureClass === "iteration_budget_exhausted" && latestChildCard) {
      const childStatus = latestChildCard.running
        ? `still running as ${latestChildCard.jobId}`
        : `${latestChildCard.status}${latestChildCard.jobId ? ` (${latestChildCard.jobId})` : ""}`;
      items.push({
        key: `${runId}-child-status`,
        kind: "system",
        title: "Orchestrator paused",
        body: `The parent profile hit its 8-turn budget, but the Codex child is ${childStatus}.\n\n${latestChildCard.summary}`,
        meta: state.statusNote ?? state.status,
      });
    } else if (state.failure?.failureClass === "iteration_budget_exhausted" && latestObjectiveCard) {
      items.push({
        key: `${runId}-objective-status`,
        kind: "system",
        title: "Thread continues",
        body: `The parent profile hit its 8-turn budget after updating this thread. The work is still ${latestObjectiveCard.status}.\n\n${latestObjectiveCard.summary}`,
        meta: state.statusNote ?? state.status,
      });
    } else {
      items.push({
        key: `${runId}-assistant-final`,
        kind: "assistant",
        body: final.content,
        meta: state.statusNote ?? state.status,
      });
    }
  } else if (state.status === "running") {
    items.push({
      key: `${runId}-running`,
      kind: "system",
      title: "Working",
      body: "The active profile is still processing this turn.",
      meta: state.status,
    });
  } else if (state.status === "failed") {
    items.push({
      key: `${runId}-failed`,
      kind: "system",
      title: "Run failed",
      body: state.failure?.message ?? state.statusNote ?? "The run ended without a final response.",
      meta: state.failure?.failureClass ?? state.status,
    });
  }
  return items;
};

const collectRunIds = (chain: Awaited<ReturnType<Runtime<AgentCmd, AgentEvent, AgentState>["chain"]>>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const receipt of chain) {
    const event = receipt.body;
    if (event.type !== "problem.set" || !event.runId || seen.has(event.runId)) continue;
    seen.add(event.runId);
    ordered.push(event.runId);
  }
  return ordered.slice(-12);
};

const parseMissionPanel = (value: string | undefined): FactoryMissionPanel => (
  value === "execution" || value === "live" || value === "receipts" || value === "debug"
    ? value
    : "overview"
);

const parseMissionFocusKind = (value: string | undefined): FactoryMissionFocusKind => (
  value === "run" || value === "job" || value === "task"
    ? value
    : "mission"
);

const buildMissionLink = (input: {
  readonly objectiveId?: string;
  readonly panel?: FactoryMissionPanel;
  readonly focusKind?: FactoryMissionFocusKind;
  readonly focusId?: string;
}): string => {
  const params = new URLSearchParams();
  if (input.objectiveId) params.set("objective", input.objectiveId);
  if (input.panel) params.set("panel", input.panel);
  if (input.focusKind) params.set("focusKind", input.focusKind);
  if (input.focusId) params.set("focusId", input.focusId);
  const query = params.toString();
  return `/factory/control${query ? `?${query}` : ""}`;
};

const buildChatLink = (input: {
  readonly profileId?: string;
  readonly objectiveId?: string;
  readonly runId?: string;
  readonly jobId?: string;
}): string => {
  const params = new URLSearchParams();
  if (input.profileId) params.set("profile", input.profileId);
  if (input.objectiveId) params.set("objective", input.objectiveId);
  if (input.runId) params.set("run", input.runId);
  if (input.jobId) params.set("job", input.jobId);
  const query = params.toString();
  return `/factory${query ? `?${query}` : ""}`;
};

const chatItemPreview = (item: FactoryChatItem): string => {
  if (item.kind === "user" || item.kind === "assistant") return item.body;
  if (item.kind === "system") return `${item.title}: ${item.body}`;
  return `${item.card.title}: ${item.card.summary}`;
};

const summarizeRunItems = (items: ReadonlyArray<FactoryChatItem>): { readonly summary: string; readonly previewLines: ReadonlyArray<string> } => {
  const preview = items.slice(-4).map(chatItemPreview).filter(Boolean);
  return {
    summary: preview.at(-1) ?? "No run output yet.",
    previewLines: preview,
  };
};

const objectiveSummary = (detail: FactoryObjectiveDetail): string | undefined =>
  detail.latestSummary
  ?? detail.nextAction
  ?? detail.blockedExplanation?.summary
  ?? detail.blockedReason;

const runFocusId = (profileId: string, runId: string): string => `${profileId}:${runId}`;

const buildMissionTaskSummary = (
  objectiveId: string,
  panel: FactoryMissionPanel,
  task: FactoryTaskView,
  selectedTaskId?: string,
): FactoryMissionTaskSummary => ({
  taskId: task.taskId,
  title: task.title,
  workerType: String(task.workerType),
  status: task.status,
  summary: task.latestSummary ?? task.candidate?.summary ?? task.blockedReason,
  candidateId: task.candidateId,
  candidateStatus: task.candidate?.status,
  jobId: task.jobId,
  jobStatus: task.jobStatus,
  workspaceExists: task.workspaceExists,
  workspaceDirty: task.workspaceDirty,
  selected: selectedTaskId === task.taskId,
  controlLink: buildMissionLink({
    objectiveId,
    panel,
    focusKind: "task",
    focusId: task.taskId,
  }),
});

const buildMissionJobSummary = (
  objectiveId: string,
  panel: FactoryMissionPanel,
  job: QueueJob,
  selectedJobId?: string,
): FactoryMissionJobSummary => ({
  jobId: job.id,
  agentId: job.agentId,
  status: job.status,
  summary: summarizeJob(job),
  updatedAt: job.updatedAt,
  runId: asString(job.payload.runId) ?? asString(job.payload.parentRunId),
  taskId: asString(job.payload.taskId),
  candidateId: asString(job.payload.candidateId),
  selected: selectedJobId === job.id,
  controlLink: buildMissionLink({
    objectiveId,
    panel,
    focusKind: "job",
    focusId: job.id,
  }),
  rawLink: `/jobs/${encodeURIComponent(job.id)}`,
});

const buildMissionRunSummary = (
  input: {
    readonly objectiveId: string;
    readonly panel: FactoryMissionPanel;
    readonly profileId: string;
    readonly profileLabel: string;
    readonly runId: string;
    readonly runChain: Awaited<ReturnType<Runtime<AgentCmd, AgentEvent, AgentState>["chain"]>>;
    readonly jobsById: ReadonlyMap<string, QueueJob>;
    readonly selectedFocusId?: string;
  },
): FactoryMissionRunSummary => {
  const items = buildChatItemsForRun(input.runId, input.runChain, input.jobsById);
  const state = fold(input.runChain, reduceAgent, initialAgent);
  const problem = input.runChain.find((receipt) => receipt.body.type === "problem.set")?.body;
  const summarized = summarizeRunItems(items);
  const focusId = runFocusId(input.profileId, input.runId);
  return {
    focusId,
    runId: input.runId,
    profileId: input.profileId,
    profileLabel: input.profileLabel,
    status: state.statusNote ?? state.status,
    summary: summarized.summary,
    prompt: problem?.type === "problem.set" ? problem.problem : undefined,
    updatedAt: input.runChain.at(-1)?.ts,
    startedAt: input.runChain[0]?.ts,
    selected: input.selectedFocusId === focusId,
    chatLink: buildChatLink({
      profileId: input.profileId,
      objectiveId: input.objectiveId,
      runId: input.runId,
    }),
    controlLink: buildMissionLink({
      objectiveId: input.objectiveId,
      panel: input.panel,
      focusKind: "run",
      focusId,
    }),
    previewLines: summarized.previewLines,
  };
};

const createFactoryRoute = (ctx: AgentLoaderContext): AgentRouteModule => {
  const helpers = ctx.helpers ?? {};
  const service = (helpers.factoryService as FactoryService | undefined) ?? new FactoryService({
    dataDir: ctx.dataDir,
    queue: ctx.queue,
    jobRuntime: ctx.jobRuntime,
    sse: ctx.sse,
    codexExecutor: new LocalCodexExecutor(),
    memoryTools: helpers.memoryTools as MemoryTools | undefined,
  });
  const agentRuntime = ctx.runtimes.agent as Runtime<AgentCmd, AgentEvent, AgentState>;
  const profileRoot = path.resolve(typeof helpers.profileRoot === "string" ? helpers.profileRoot : process.cwd());

  const wrap = async <T>(
    fn: () => Promise<T>,
    render: (value: T) => Response,
  ): Promise<Response> => {
    try {
      return render(await fn());
    } catch (err) {
      if (err instanceof FactoryServiceError) return text(err.status, err.message);
      const message = err instanceof Error ? err.message : "factory server error";
      console.error(err);
      return text(500, message);
    }
  };

  const requestedObjectiveId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("objective"));

  const requestedProfileId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("profile"));

  const requestedRunId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("run"));

  const requestedJobId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("job"));

  const requestedPanel = (req: Request): FactoryMissionPanel =>
    parseMissionPanel(optionalTrimmedString(new URL(req.url).searchParams.get("panel")));

  const requestedFocusKind = (req: Request): FactoryMissionFocusKind =>
    parseMissionFocusKind(optionalTrimmedString(new URL(req.url).searchParams.get("focusKind")));

  const requestedFocusId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("focusId"));

  const buildChatShellModel = async (input: {
    readonly profileId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
  }): Promise<FactoryChatShellModel> => {
    await service.ensureBootstrap();
    const repoRoot = service.git.repoRoot;
    const resolved = await resolveFactoryChatProfile({
      repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const stream = factoryChatStream(repoRoot, resolved.root.id, input.objectiveId);
    const [profiles, objectives, selectedObjective, jobs, indexChain] = await Promise.all([
      discoverFactoryChatProfiles(profileRoot),
      service.listObjectives(),
      input.objectiveId ? service.getObjective(input.objectiveId) : Promise.resolve(undefined),
      ctx.queue.listJobs({ limit: 120 }),
      agentRuntime.chain(stream),
    ]);

    const allRunIds = collectRunIds(indexChain);
    const runIds = input.runId && allRunIds.includes(input.runId) ? [input.runId] : allRunIds;
    const runChains = await Promise.all(runIds.map((runId) => agentRuntime.chain(agentRunStream(stream, runId))));
    const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
    const chatItems = runChains.flatMap((runChain, index) => buildChatItemsForRun(runIds[index]!, runChain, jobsById));

    const profileNav: ReadonlyArray<FactoryChatProfileNav> = profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      selected: profile.id === resolved.root.id,
    }));
    const objectiveNav: ReadonlyArray<FactoryChatObjectiveNav> = objectives
      .slice(0, 16)
      .map((objective) => ({
        objectiveId: objective.objectiveId,
        title: objective.title,
        status: objective.status,
        phase: objective.phase,
        summary: objective.latestSummary ?? objective.nextAction,
        updatedAt: objective.updatedAt,
        selected: objective.objectiveId === input.objectiveId,
        slotState: objective.scheduler.slotState,
        activeTaskCount: objective.activeTaskCount,
        readyTaskCount: objective.readyTaskCount,
        taskCount: objective.taskCount,
        integrationStatus: objective.integrationStatus,
    }));
    const relevantQueueJobs = jobs.filter((job) => isRelevantShellJob(job, stream, input.objectiveId));
    const activeCodex = buildActiveCodexCard(relevantQueueJobs);
    const relevantJobs = relevantQueueJobs
      .slice(0, 12)
      .map((job) => ({
        jobId: job.id,
        agentId: job.agentId,
        status: job.status,
        summary: summarizeJob(job),
        runId: asString(job.payload.runId) ?? asString(job.payload.parentRunId),
        objectiveId: asString(job.payload.objectiveId) ?? asString(asObject(job.result)?.objectiveId),
        updatedAt: job.updatedAt,
        selected: job.id === input.jobId,
        link: buildChatLink({
          profileId: resolved.root.id,
          objectiveId: asString(job.payload.objectiveId) ?? asString(asObject(job.result)?.objectiveId),
          runId: asString(job.payload.runId) ?? asString(job.payload.parentRunId),
          jobId: job.id,
        }),
      } satisfies FactoryChatJobNav));

    const selectedObjectiveCard: FactorySelectedObjectiveCard | undefined = selectedObjective
      ? {
          objectiveId: selectedObjective.objectiveId,
          title: selectedObjective.title,
          status: selectedObjective.status,
          phase: selectedObjective.phase,
          summary: selectedObjective.latestSummary ?? selectedObjective.nextAction,
          debugLink: `/factory/api/objectives/${encodeURIComponent(selectedObjective.objectiveId)}/debug`,
          receiptsLink: `/factory/api/objectives/${encodeURIComponent(selectedObjective.objectiveId)}/receipts?limit=50`,
          nextAction: selectedObjective.nextAction,
          slotState: selectedObjective.scheduler.slotState,
          queuePosition: selectedObjective.scheduler.queuePosition,
          blockedReason: selectedObjective.blockedReason,
          blockedExplanation: selectedObjective.blockedExplanation?.summary,
          integrationStatus: selectedObjective.integrationStatus,
          activeTaskCount: selectedObjective.activeTaskCount,
          readyTaskCount: selectedObjective.readyTaskCount,
          taskCount: selectedObjective.taskCount,
          repoProfileStatus: selectedObjective.repoProfile.status,
          latestCommitHash: selectedObjective.latestCommitHash,
          checks: selectedObjective.checks,
          latestDecisionSummary: selectedObjective.latestDecision?.summary,
          latestDecisionAt: selectedObjective.latestDecision?.at,
        }
      : undefined;

    const chatModel: FactoryChatIslandModel = {
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      items: chatItems,
    };
    const sidebarModel: FactorySidebarModel = {
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      activeProfileTools: resolved.toolAllowlist,
      profiles: profileNav,
      objectives: objectiveNav,
      jobs: relevantJobs,
      selectedObjective: selectedObjectiveCard,
      activeCodex,
    };
    return {
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      objectiveId: input.objectiveId,
      runId: input.runId,
      jobId: input.jobId,
      chat: chatModel,
      sidebar: sidebarModel,
    };
  };

  const buildMissionShellModel = async (input: {
    readonly objectiveId?: string;
    readonly panel: FactoryMissionPanel;
    readonly focusKind: FactoryMissionFocusKind;
    readonly focusId?: string;
  }): Promise<FactoryMissionShellModel> => {
    await service.ensureBootstrap();
    const repoRoot = service.git.repoRoot;
    const board = await service.buildBoardProjection(input.objectiveId);
    const objectiveId = board.selectedObjectiveId;
    const objectives = board.objectives.map((objective) => ({
      objectiveId: objective.objectiveId,
      title: objective.title,
      status: objective.status,
      phase: objective.phase,
      slotState: objective.scheduler.slotState,
      section: objective.section as FactoryMissionSectionKey,
      summary: objective.latestSummary ?? objective.nextAction,
      updatedAt: objective.updatedAt,
      selected: objective.objectiveId === objectiveId,
      activeTaskCount: objective.activeTaskCount,
      readyTaskCount: objective.readyTaskCount,
      taskCount: objective.taskCount,
      integrationStatus: objective.integrationStatus,
      queuePosition: objective.scheduler.queuePosition,
    } satisfies FactoryMissionObjectiveNav));
    const sections: FactoryMissionShellModel["sections"] = {
      needs_attention: objectives.filter((objective) => objective.section === "needs_attention"),
      active: objectives.filter((objective) => objective.section === "active"),
      queued: objectives.filter((objective) => objective.section === "queued"),
      completed: objectives.filter((objective) => objective.section === "completed"),
    };
    if (!objectiveId) {
      return {
        objectiveId: undefined,
        panel: input.panel,
        focusKind: "mission",
        focusId: undefined,
        objectives,
        sections,
      };
    }

    const [detail, debug, jobs, profiles] = await Promise.all([
      service.getObjective(objectiveId),
      service.getObjectiveDebug(objectiveId),
      ctx.queue.listJobs({ limit: 120 }),
      discoverFactoryChatProfiles(profileRoot),
    ]);
    const objectiveJobs = jobs
      .filter((job) => (asString(job.payload.objectiveId) ?? asString(asObject(job.result)?.objectiveId)) === objectiveId)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    let resolvedFocusKind = input.focusKind;
    let resolvedFocusId = input.focusId;
    if ((input.panel === "live" || !resolvedFocusId) && resolvedFocusKind === "mission") {
      const activeTask = detail.tasks.find((task) => isActiveJobStatus(task.jobStatus));
      const activeJob = objectiveJobs.find((job) => !isTerminalJobStatus(job.status));
      if (input.panel === "live" && activeTask) {
        resolvedFocusKind = "task";
        resolvedFocusId = activeTask.taskId;
      } else if (input.panel === "live" && activeJob) {
        resolvedFocusKind = "job";
        resolvedFocusId = activeJob.id;
      }
    }

    const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
    const runSummaries = (await Promise.all(
      profiles.map(async (profile) => {
        const profileStream = factoryChatStream(repoRoot, profile.id, objectiveId);
        const indexChain = await agentRuntime.chain(profileStream);
        const runIds = collectRunIds(indexChain);
        const runChains = await Promise.all(runIds.map((runId) => agentRuntime.chain(agentRunStream(profileStream, runId))));
        return runChains.map((runChain, index) => buildMissionRunSummary({
          objectiveId,
          panel: input.panel,
          profileId: profile.id,
          profileLabel: profile.label,
          runId: runIds[index]!,
          runChain,
          jobsById,
          selectedFocusId: resolvedFocusId,
        }));
      }),
    ))
      .flat()
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, 20);

    const taskSummaries = detail.tasks.map((task) => buildMissionTaskSummary(
      objectiveId,
      input.panel,
      task,
      resolvedFocusKind === "task" ? resolvedFocusId : undefined,
    ));
    const jobSummaries = objectiveJobs.slice(0, 20).map((job) => buildMissionJobSummary(
      objectiveId,
      input.panel,
      job,
      resolvedFocusKind === "job" ? resolvedFocusId : undefined,
    ));

    const missionFocus = (): Extract<FactoryMissionFocusModel, { readonly kind: "mission" }> => ({
      kind: "mission",
      objectiveId: detail.objectiveId,
      title: detail.title,
      status: detail.status,
      phase: detail.phase,
      summary: objectiveSummary(detail),
      nextAction: detail.nextAction,
      blockedReason: detail.blockedReason,
      blockedExplanation: detail.blockedExplanation?.summary,
      debugLink: `/factory/api/objectives/${encodeURIComponent(detail.objectiveId)}/debug`,
      receiptsLink: `/factory/api/objectives/${encodeURIComponent(detail.objectiveId)}/receipts?limit=50`,
      slotState: detail.scheduler.slotState,
      queuePosition: detail.scheduler.queuePosition,
      integrationStatus: detail.integrationStatus,
      repoProfileStatus: detail.repoProfile.status,
      latestCommitHash: detail.latestCommitHash,
      latestDecisionSummary: detail.latestDecision?.summary,
      latestDecisionAt: detail.latestDecision?.at,
      checks: detail.checks,
      budgetElapsedMinutes: detail.budgetState.elapsedMinutes,
      budgetMaxMinutes: detail.policy.budgets.maxObjectiveMinutes,
      taskRunsUsed: detail.budgetState.taskRunsUsed,
      taskRunsMax: detail.policy.budgets.maxTaskRuns,
    });

    let focus: FactoryMissionFocusModel = missionFocus();
    if (resolvedFocusKind === "task" && resolvedFocusId) {
      const task = detail.tasks.find((item) => item.taskId === resolvedFocusId);
      if (task) {
        focus = {
          kind: "task",
          title: task.title,
          status: task.status,
          summary: task.latestSummary ?? task.candidate?.summary ?? task.blockedReason,
          taskId: task.taskId,
          workerType: String(task.workerType),
          candidateId: task.candidateId,
          candidateStatus: task.candidate?.status,
          jobId: task.jobId,
          jobStatus: task.jobStatus,
          workspaceExists: task.workspaceExists,
          workspaceDirty: task.workspaceDirty,
          workspacePath: task.workspacePath,
          workspaceHead: task.workspaceHead,
          lastMessage: task.lastMessage,
          stdoutTail: task.stdoutTail,
          stderrTail: task.stderrTail,
        };
      } else {
        resolvedFocusKind = "mission";
        resolvedFocusId = undefined;
      }
    } else if (resolvedFocusKind === "job" && resolvedFocusId) {
      const job = objectiveJobs.find((item) => item.id === resolvedFocusId);
      if (job) {
        focus = {
          kind: "job",
          title: summarizeJob(job),
          status: job.status,
          summary: summarizeJob(job),
          jobId: job.id,
          agentId: job.agentId,
          updatedAt: job.updatedAt,
          runId: asString(job.payload.runId) ?? asString(job.payload.parentRunId),
          taskId: asString(job.payload.taskId),
          candidateId: asString(job.payload.candidateId),
          rawLink: `/jobs/${encodeURIComponent(job.id)}`,
          payload: JSON.stringify(job.payload, null, 2),
          result: job.result ? JSON.stringify(job.result, null, 2) : undefined,
          lastError: job.lastError,
          canceledReason: job.canceledReason,
          active: !isTerminalJobStatus(job.status),
        };
      } else {
        resolvedFocusKind = "mission";
        resolvedFocusId = undefined;
      }
    } else if (resolvedFocusKind === "run" && resolvedFocusId) {
      const run = runSummaries.find((item) => item.focusId === resolvedFocusId);
      if (run) {
        focus = {
          kind: "run",
          title: `${run.profileLabel} · ${run.runId}`,
          status: run.status,
          summary: run.summary,
          runId: run.runId,
          profileLabel: run.profileLabel,
          prompt: run.prompt,
          updatedAt: run.updatedAt,
          startedAt: run.startedAt,
          chatLink: run.chatLink,
          previewLines: run.previewLines,
        };
      } else {
        resolvedFocusKind = "mission";
        resolvedFocusId = undefined;
      }
    }

    const liveOutput = input.panel === "live"
      && resolvedFocusId
      && (resolvedFocusKind === "task" || resolvedFocusKind === "job")
      ? await service.getObjectiveLiveOutput(objectiveId, resolvedFocusKind as FactoryLiveOutputTargetKind, resolvedFocusId)
      : undefined;

    const recentReceipts = detail.recentReceipts.map((receipt) => ({
      type: receipt.type,
      summary: receipt.summary,
      ts: receipt.ts,
      hash: receipt.hash,
      taskId: receipt.taskId,
      candidateId: receipt.candidateId,
    } satisfies FactoryMissionReceiptSummary));

    const integrationWorkspaceSummary = debug.integrationWorktree
      ? `${debug.integrationWorktree.exists ? "exists" : "missing"}${debug.integrationWorktree.branch ? ` · ${debug.integrationWorktree.branch}` : ""}${debug.integrationWorktree.dirty ? " · dirty" : ""}`
      : undefined;

    const selected: FactoryMissionSelectedModel = {
      objectiveId: detail.objectiveId,
      title: detail.title,
      status: detail.status,
      phase: detail.phase,
      prompt: detail.prompt,
      summary: objectiveSummary(detail),
      nextAction: detail.nextAction,
      blockedReason: detail.blockedReason,
      blockedExplanation: detail.blockedExplanation?.summary,
      slotState: detail.scheduler.slotState,
      queuePosition: detail.scheduler.queuePosition,
      integrationStatus: detail.integrationStatus,
      repoProfileStatus: detail.repoProfile.status,
      latestCommitHash: detail.latestCommitHash,
      latestDecisionSummary: detail.latestDecision?.summary,
      latestDecisionAt: detail.latestDecision?.at,
      activeTaskCount: detail.activeTaskCount,
      readyTaskCount: detail.readyTaskCount,
      taskCount: detail.taskCount,
      checks: detail.checks,
      budgetElapsedMinutes: detail.budgetState.elapsedMinutes,
      budgetMaxMinutes: detail.policy.budgets.maxObjectiveMinutes,
      taskRunsUsed: detail.budgetState.taskRunsUsed,
      taskRunsMax: detail.policy.budgets.maxTaskRuns,
      tasks: taskSummaries,
      runs: runSummaries,
      jobs: jobSummaries,
      recentReceipts,
      debugLink: `/factory/api/objectives/${encodeURIComponent(detail.objectiveId)}/debug`,
      receiptsLink: `/factory/api/objectives/${encodeURIComponent(detail.objectiveId)}/receipts?limit=50`,
      chatLink: buildChatLink({ objectiveId: detail.objectiveId }),
      repoProfileSummary: debug.repoProfile.summary,
      debugNextAction: debug.nextAction,
      activeJobCount: debug.activeJobs.length,
      recentJobCount: debug.lastJobs.length,
      contextPackCount: debug.latestContextPacks.length,
      worktreeCount: debug.taskWorktrees.length + (debug.integrationWorktree ? 1 : 0),
      integrationWorkspaceSummary,
      focus,
    };

    return {
      objectiveId,
      panel: input.panel,
      focusKind: resolvedFocusKind,
      focusId: resolvedFocusId,
      objectives,
      sections,
      selected,
      liveOutput,
    };
  };

  return {
    id: "factory",
    kind: "factory",
    paths: {
      shell: "/factory",
      state: "/factory/api/objectives",
      events: "/factory/events",
    },
    register: (app: Hono) => {
      app.get("/factory", async (c) => wrap(
        async () => buildChatShellModel({
          profileId: requestedProfileId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
        }),
        (model) => html(factoryChatShell(model))
      ));

      app.get("/factory/events", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          const resolved = await resolveFactoryChatProfile({
            repoRoot: service.git.repoRoot,
            profileRoot,
            requestedId: requestedProfileId(c.req.raw),
          });
          return {
            stream: factoryChatStream(
              service.git.repoRoot,
              resolved.root.id,
              requestedObjectiveId(c.req.raw),
            ),
            objectiveId: requestedObjectiveId(c.req.raw),
          };
        },
        (body) => ctx.sse.subscribeMany([
          { topic: "agent", stream: body.stream },
          ...(body.objectiveId ? [{ topic: "factory" as const, stream: body.objectiveId }] : []),
        ], c.req.raw.signal)
      ));

      app.get("/factory/island/chat", async (c) => wrap(
        async () => {
          const model = await buildChatShellModel({
            profileId: requestedProfileId(c.req.raw),
            objectiveId: requestedObjectiveId(c.req.raw),
            runId: requestedRunId(c.req.raw),
            jobId: requestedJobId(c.req.raw),
          });
          return model.chat;
        },
        (model) => html(factoryChatIsland(model))
      ));

      app.get("/factory/island/sidebar", async (c) => wrap(
        async () => {
          const model = await buildChatShellModel({
            profileId: requestedProfileId(c.req.raw),
            objectiveId: requestedObjectiveId(c.req.raw),
            runId: requestedRunId(c.req.raw),
            jobId: requestedJobId(c.req.raw),
          });
          return model.sidebar;
        },
        (model) => html(factorySidebarIsland(model))
      ));

      app.get("/factory/island/inspector", async (c) => wrap(
        async () => {
          const model = await buildChatShellModel({
            profileId: requestedProfileId(c.req.raw),
            objectiveId: requestedObjectiveId(c.req.raw),
            runId: requestedRunId(c.req.raw),
            jobId: requestedJobId(c.req.raw),
          });
          return model.sidebar;
        },
        (model) => html(factoryInspectorIsland(model))
      ));

      app.get("/factory/chat", async (c) => wrap(
        async () => buildChatLink({
          profileId: requestedProfileId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
        }),
        (location) => new Response(null, {
          status: 303,
          headers: {
            Location: location,
            "Cache-Control": "no-store",
          },
        })
      ));

      app.get("/factory/chat/events", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          const resolved = await resolveFactoryChatProfile({
            repoRoot: service.git.repoRoot,
            profileRoot,
            requestedId: requestedProfileId(c.req.raw),
          });
          return {
            stream: factoryChatStream(
              service.git.repoRoot,
              resolved.root.id,
              requestedObjectiveId(c.req.raw),
            ),
            objectiveId: requestedObjectiveId(c.req.raw),
          };
        },
        (body) => ctx.sse.subscribeMany([
          { topic: "agent", stream: body.stream },
          ...(body.objectiveId ? [{ topic: "factory" as const, stream: body.objectiveId }] : []),
        ], c.req.raw.signal)
      ));

      app.get("/factory/chat/island/chat", async (c) => wrap(
        async () => {
          const model = await buildChatShellModel({
            profileId: requestedProfileId(c.req.raw),
            objectiveId: requestedObjectiveId(c.req.raw),
            runId: requestedRunId(c.req.raw),
            jobId: requestedJobId(c.req.raw),
          });
          return model.chat;
        },
        (model) => html(factoryChatIsland(model))
      ));

      app.get("/factory/chat/island/sidebar", async (c) => wrap(
        async () => {
          const model = await buildChatShellModel({
            profileId: requestedProfileId(c.req.raw),
            objectiveId: requestedObjectiveId(c.req.raw),
            runId: requestedRunId(c.req.raw),
            jobId: requestedJobId(c.req.raw),
          });
          return model.sidebar;
        },
        (model) => html(factorySidebarIsland(model))
      ));

      app.get("/factory/chat/island/inspector", async (c) => wrap(
        async () => {
          const model = await buildChatShellModel({
            profileId: requestedProfileId(c.req.raw),
            objectiveId: requestedObjectiveId(c.req.raw),
            runId: requestedRunId(c.req.raw),
            jobId: requestedJobId(c.req.raw),
          });
          return model.sidebar;
        },
        (model) => html(factoryInspectorIsland(model))
      ));

      app.get("/factory/control", async (c) => wrap(
        async () => buildMissionShellModel({
          objectiveId: requestedObjectiveId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: requestedFocusKind(c.req.raw),
          focusId: requestedFocusId(c.req.raw),
        }),
        (model) => html(factoryMissionControlShell(model))
      ));

      app.get("/factory/control/events", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          return requestedObjectiveId(c.req.raw);
        },
        (objectiveId) => objectiveId
          ? ctx.sse.subscribe("factory", objectiveId, c.req.raw.signal)
          : ctx.sse.subscribe("receipt", undefined, c.req.raw.signal)
      ));

      app.get("/factory/control/island/rail", async (c) => wrap(
        async () => {
          const model = await buildMissionShellModel({
            objectiveId: requestedObjectiveId(c.req.raw),
            panel: requestedPanel(c.req.raw),
            focusKind: requestedFocusKind(c.req.raw),
            focusId: requestedFocusId(c.req.raw),
          });
          return model;
        },
        (model) => html(factoryMissionRailIsland(model))
      ));

      app.get("/factory/control/island/main", async (c) => wrap(
        async () => {
          const model = await buildMissionShellModel({
            objectiveId: requestedObjectiveId(c.req.raw),
            panel: requestedPanel(c.req.raw),
            focusKind: requestedFocusKind(c.req.raw),
            focusId: requestedFocusId(c.req.raw),
          });
          return model;
        },
        (model) => html(factoryMissionMainIsland(model))
      ));

      app.get("/factory/control/island/inspector", async (c) => wrap(
        async () => {
          const model = await buildMissionShellModel({
            objectiveId: requestedObjectiveId(c.req.raw),
            panel: requestedPanel(c.req.raw),
            focusKind: requestedFocusKind(c.req.raw),
            focusId: requestedFocusId(c.req.raw),
          });
          return model;
        },
        (model) => html(factoryMissionInspectorIsland(model))
      ));

      app.get("/factory/control/island/live-output", async (c) => wrap(
        async () => {
          const objectiveId = requestedObjectiveId(c.req.raw);
          const focusKind = requestedFocusKind(c.req.raw);
          const focusId = requestedFocusId(c.req.raw);
          const snapshot = objectiveId && focusId && (focusKind === "task" || focusKind === "job")
            ? await service.getObjectiveLiveOutput(objectiveId, focusKind as FactoryLiveOutputTargetKind, focusId)
            : undefined;
          return {
            objectiveId,
            focusKind,
            focusId,
            snapshot,
          };
        },
        (body) => html(factoryMissionLiveOutputIsland(body))
      ));

      app.get("/factory/api/live-output", async (c) => wrap(
        async () => {
          const objectiveId = requestedObjectiveId(c.req.raw);
          const focusKind = requestedFocusKind(c.req.raw);
          const focusId = requestedFocusId(c.req.raw);
          return {
            liveOutput: objectiveId && focusId && (focusKind === "task" || focusKind === "job")
              ? await service.getObjectiveLiveOutput(objectiveId, focusKind as FactoryLiveOutputTargetKind, focusId)
              : undefined,
          };
        },
        (body) => json(200, body)
      ));

      app.post("/factory/control/compose", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          const body = await readRecordBody(c.req.raw, (message) => new FactoryServiceError(400, message));
          const prompt = requireTrimmedString(body.prompt, "prompt required");
          const objectiveId = optionalTrimmedString(body.objective);
          const detail = objectiveId
            ? await (async () => {
                await service.addObjectiveNote(objectiveId, prompt);
                await service.reactObjective(objectiveId);
                return service.getObjective(objectiveId);
              })()
            : await service.createObjective({
                title: deriveObjectiveTitle(prompt),
                prompt,
              });
          const location = buildMissionLink({
            objectiveId: detail.objectiveId,
            panel: "overview",
            focusKind: "mission",
          });
          if (c.req.header("HX-Request") === "true") {
            return emptyHtml({
              "HX-Replace-Url": location,
              "HX-Trigger": JSON.stringify({
                "factory-control-selected": {
                  objectiveId: detail.objectiveId,
                  panel: "overview",
                  focusKind: "mission",
                },
              }),
            });
          }
          return new Response(null, {
            status: 303,
            headers: {
              Location: location,
              "Cache-Control": "no-store",
            },
          });
        },
        (response) => response
      ));

      app.post("/factory/run", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          const body = await readRecordBody(c.req.raw, (message) => new FactoryServiceError(400, message));
          const problem = requireTrimmedString(body.problem, "problem required");
          const objectiveId = optionalTrimmedString(body.objective);
          const requestedProfile = optionalTrimmedString(body.profile);
          const resolved = await resolveFactoryChatProfile({
            repoRoot: service.git.repoRoot,
            profileRoot,
            requestedId: requestedProfile,
            problem,
            allowDefaultOverride: true,
          });
          const stream = factoryChatStream(service.git.repoRoot, resolved.root.id, objectiveId);
          const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const config: AgentRunConfig = normalizeFactoryChatConfig(FACTORY_CHAT_DEFAULT_CONFIG);
          const created = await ctx.queue.enqueue({
            agentId: "factory",
            lane: "collect",
            sessionKey: `factory-chat:${stream}`,
            singletonMode: "allow",
            maxAttempts: 1,
            payload: {
              kind: "factory.run",
              stream,
              runId,
              problem,
              profileId: resolved.root.id,
              ...(objectiveId ? { objectiveId } : {}),
              config,
            },
          });
          ctx.sse.publish("jobs", created.id);
          const location = buildChatLink({
            profileId: resolved.root.id,
            objectiveId,
            runId,
            jobId: created.id,
          });
          if (c.req.header("HX-Request") === "true") {
            return emptyHtml({
              "HX-Replace-Url": location,
              "HX-Trigger": JSON.stringify({
                "factory-run-started": {
                  profileId: resolved.root.id,
                  profileLabel: resolved.root.label,
                  objectiveId: objectiveId ?? "",
                  jobId: created.id,
                  runId,
                  location,
                },
              }),
            });
          }
          return new Response(null, {
            status: 303,
            headers: {
              Location: location,
              "Cache-Control": "no-store",
            },
          });
        },
        (response) => response
      ));

      app.get("/factory/api/objectives", async (c) => wrap(
        async () => ({
          objectives: await service.listObjectives(),
          board: await service.buildBoardProjection(optionalTrimmedString(c.req.query("objective"))),
        }),
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives", async (c) => wrap(
        async () => {
          const body = await readRecordBody(c.req.raw, (message) => new FactoryServiceError(400, message));
          return {
            objective: await service.createObjective({
              title: trimmedString(body.title) ?? deriveObjectiveTitle(requireTrimmedString(body.prompt, "prompt required")),
              prompt: trimmedString(body.prompt),
              baseHash: optionalTrimmedString(body.baseHash),
              checks: parseChecks(body.validationCommands) ?? parseChecks(body.checks),
              channel: optionalTrimmedString(body.channel),
              policy: parsePolicy(body.policy),
            }),
          };
        },
        (body) => json(201, body)
      ));

      app.get("/factory/api/objectives/:id", async (c) => wrap(
        async () => ({ objective: await service.getObjective(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.get("/factory/api/objectives/:id/debug", async (c) => wrap(
        async () => ({ debug: await service.getObjectiveDebug(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.get("/factory/api/objectives/:id/receipts", async (c) => wrap(
        async () => ({
          receipts: await service.listObjectiveReceipts(
            c.req.param("id"),
            Number.parseInt(c.req.query("limit") ?? "40", 10),
          ),
        }),
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives/:id/react", async (c) => wrap(
        async () => ({ objective: await service.reactObjective(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives/:id/promote", async (c) => wrap(
        async () => ({ objective: await service.promoteObjective(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives/:id/cancel", async (c) => wrap(
        async () => {
          const body = await readRecordBody(c.req.raw, (message) => new FactoryServiceError(400, message));
          return { objective: await service.cancelObjective(c.req.param("id"), optionalTrimmedString(body.reason)) };
        },
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives/:id/archive", async (c) => wrap(
        async () => ({ objective: await service.archiveObjective(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives/:id/cleanup", async (c) => wrap(
        async () => ({ objective: await service.cleanupObjectiveWorkspaces(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.post("/factory/job/:id/steer", async (c) => wrap(
        async () => {
          const jobId = c.req.param("id");
          const body = await readRecordBody(c.req.raw, (msg) => new FactoryServiceError(400, msg));
          const payload: Record<string, unknown> = {};
          const problem = optionalTrimmedString(body.problem);
          const configRaw = optionalTrimmedString(body.config);
          if (problem) payload.problem = problem;
          if (configRaw) {
            const parsed = parsePolicy(configRaw);
            if (parsed) payload.config = parsed;
          }
          if (Object.keys(payload).length === 0) throw new FactoryServiceError(400, "provide problem and/or config");
          const queued = await ctx.queue.queueCommand({ jobId, command: "steer", payload, by: "factory.ui" });
          if (!queued) throw new FactoryServiceError(404, "job not found");
          ctx.sse.publish("jobs", jobId);
          return "Steer command queued.";
        },
        (msg) => text(202, msg)
      ));

      app.post("/factory/job/:id/follow-up", async (c) => wrap(
        async () => {
          const jobId = c.req.param("id");
          const body = await readRecordBody(c.req.raw, (msg) => new FactoryServiceError(400, msg));
          const note = requireTrimmedString(body.note, "note required");
          const queued = await ctx.queue.queueCommand({ jobId, command: "follow_up", payload: { note }, by: "factory.ui" });
          if (!queued) throw new FactoryServiceError(404, "job not found");
          ctx.sse.publish("jobs", jobId);
          return "Follow-up command queued.";
        },
        (msg) => text(202, msg)
      ));

      app.post("/factory/job/:id/abort", async (c) => wrap(
        async () => {
          const jobId = c.req.param("id");
          const body = await readRecordBody(c.req.raw, (msg) => new FactoryServiceError(400, msg));
          const reason = optionalTrimmedString(body.reason) ?? "abort requested";
          const queued = await ctx.queue.queueCommand({ jobId, command: "abort", payload: { reason }, by: "factory.ui" });
          if (!queued) throw new FactoryServiceError(404, "job not found");
          ctx.sse.publish("jobs", jobId);
          return "Abort command queued.";
        },
        (msg) => text(202, msg)
      ));
    },
  };
};

export default createFactoryRoute;
