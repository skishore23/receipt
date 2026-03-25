import { fold } from "@receipt/core/chain";

import { initial as initialAgent, reduce as reduceAgent, type AgentState } from "../../modules/agent";
import type { QueueJob } from "../../adapters/jsonl-queue";
import type { FactoryChatItem, FactoryWorkCard } from "../../views/factory-models";

import { buildDetail, compactJsonValue, jsonRecordToMarkdown, truncateInline, tryParseJson } from "./formatters";
import {
  asObject,
  asString,
  isTerminalJobStatus,
  normalizedWorkerId,
  profileLabel,
  reverseFind,
  type AgentRunChain,
} from "./shared";

const asRecordArray = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];

const summarizeObservationJob = (record: Record<string, unknown>): string | undefined => {
  const result = asObject(record.result);
  const failure = asObject(result?.failure);
  return asString(record.summary)
    ?? asString(result?.summary)
    ?? asString(result?.finalResponse)
    ?? asString(result?.note)
    ?? asString(result?.message)
    ?? asString(failure?.message)
    ?? asString(record.lastError)
    ?? asString(asObject(record.payload)?.problem)
    ?? asString(asObject(record.payload)?.task)
    ?? asString(asObject(record.payload)?.kind);
};

const formatFactoryActiveJobs = (value: unknown): string | undefined => {
  const jobs = asRecordArray(value).slice(0, 5);
  if (jobs.length === 0) return undefined;
  return `Active jobs:\n${jobs.map((job) => {
    const jobId = asString(job.id) ?? asString(job.jobId) ?? "unknown";
    const worker = asString(job.agentId) ?? asString(job.worker) ?? "worker";
    const status = asString(job.status) ?? "unknown";
    const summary = summarizeObservationJob(job);
    return `- ${jobId}: ${worker} ${status}${summary ? ` — ${summary}` : ""}`;
  }).join("\n")}`;
};

const formatFactoryReceipts = (value: unknown): string | undefined => {
  const receipts = asRecordArray(value).slice(0, 6);
  if (receipts.length === 0) return undefined;
  return `Recent receipts:\n${receipts.map((receipt) => {
    const type = asString(receipt.type) ?? "receipt";
    const summary = asString(receipt.summary) ?? "No summary";
    return `- ${type}: ${summary}`;
  }).join("\n")}`;
};

const formatFactoryTaskWorktrees = (value: unknown): string | undefined => {
  const worktrees = asRecordArray(value).slice(0, 5);
  if (worktrees.length === 0) return undefined;
  return `Task worktrees:\n${worktrees.map((worktree) => {
    const taskId = asString(worktree.taskId) ?? "unknown";
    const exists = worktree.exists === true ? "exists" : "missing";
    const dirty = worktree.dirty === true ? "dirty" : "clean";
    const branch = asString(worktree.branch);
    const head = asString(worktree.head);
    const workspacePath = asString(worktree.workspacePath);
    const meta = [exists, dirty, branch, head].filter(Boolean).join(" · ");
    return `- ${taskId}: ${meta}${workspacePath ? ` — ${workspacePath}` : ""}`;
  }).join("\n")}`;
};

const formatFactoryContextPacks = (value: unknown): string | undefined => {
  const packs = asRecordArray(value).slice(0, 5);
  if (packs.length === 0) return undefined;
  return `Context packs:\n${packs.map((pack) => {
    const taskId = asString(pack.taskId) ?? "unknown";
    const candidateId = asString(pack.candidateId);
    const contextPackPath = asString(pack.contextPackPath);
    const memoryScriptPath = asString(pack.memoryScriptPath);
    const label = [taskId, candidateId].filter(Boolean).join(" · ");
    const pathLines = [
      contextPackPath ? `context: ${contextPackPath}` : undefined,
      memoryScriptPath ? `memory: ${memoryScriptPath}` : undefined,
    ].filter(Boolean).join(" · ");
    return `- ${label || "context"}${pathLines ? ` — ${pathLines}` : ""}`;
  }).join("\n")}`;
};

const interestingTools = new Set([
  "agent.delegate",
  "agent.status",
  "codex.status",
  "job.control",
  "codex.run",
  "factory.dispatch",
  "factory.status",
  "factory.output",
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
      detail: buildDetail(
        asString(parsed?.summary),
        asString(parsed?.jobId) ? `Job ${asString(parsed?.jobId)}` : undefined,
        asString(parsed?.runId) ? `Run ${asString(parsed?.runId)}` : undefined,
      ),
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
      detail: buildDetail(
        asString(parsed?.task) ? `Task: ${asString(parsed?.task)}` : undefined,
        asString(parsed?.lastMessage) ? `Latest note: ${asString(parsed?.lastMessage)}` : undefined,
        asString(parsed?.stderrTail) ? `stderr:\n${asString(parsed?.stderrTail)}` : undefined,
        asString(parsed?.stdoutTail) ? `stdout:\n${asString(parsed?.stdoutTail)}` : undefined,
      ),
      meta: durationLabel,
      jobId: asString(parsed?.jobId),
      running: !isTerminalJobStatus(asString(parsed?.status)),
    };
  }
  if (observation.tool === "codex.status") {
    const jobs = Array.isArray(parsed?.jobs)
      ? parsed.jobs.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [];
    const latest = (parsed?.latest && typeof parsed.latest === "object" && !Array.isArray(parsed.latest)
      ? parsed.latest
      : jobs[0]) as Record<string, unknown> | undefined;
    const latestStatus = asString(latest?.status);
    return {
      key: `${observation.tool}-${asString(latest?.jobId) ?? observation.summary ?? "codex-status"}`,
      title: "Codex status",
      worker: "codex",
      status: latestStatus ?? "unknown",
      summary: observation.summary ?? asString(latest?.summary) ?? "Checked Codex status.",
      detail: buildDetail(
        typeof parsed?.activeCount === "number" ? `${parsed.activeCount} active Codex job${parsed.activeCount === 1 ? "" : "s"}` : undefined,
        asString(latest?.task) ? `Task: ${asString(latest?.task)}` : undefined,
        asString(latest?.lastMessage) ? `Latest note: ${asString(latest?.lastMessage)}` : undefined,
        jobs.length > 1
          ? `Recent jobs:\n${jobs.slice(0, 5).map((job) => `- ${asString(job.jobId) ?? "unknown"}: ${asString(job.status) ?? "unknown"}${asString(job.summary) ? ` — ${asString(job.summary)}` : ""}`).join("\n")}`
          : undefined,
      ),
      meta: durationLabel,
      jobId: asString(latest?.jobId),
      running: typeof parsed?.activeCount === "number"
        ? parsed.activeCount > 0
        : !isTerminalJobStatus(latestStatus),
    };
  }
  if (observation.tool === "job.control") {
    return {
      key: `${observation.tool}-${asString(parsed?.jobId) ?? observation.summary ?? "job-control"}`,
      title: "Job command queued",
      worker: "queue",
      status: asString(parsed?.status) ?? "queued",
      summary: observation.summary ?? "Queued a command for a child job.",
      detail: buildDetail(
        asString(parsed?.command) ? `Command: ${asString(parsed?.command)}` : undefined,
        asString(parsed?.jobId) ? `Job ${asString(parsed?.jobId)}` : undefined,
        compactJsonValue(parsed?.payload),
      ),
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
      detail: buildDetail(
        asString(parsed?.task) ? `Task: ${asString(parsed?.task)}` : undefined,
        asString(parsed?.jobId) ? `Job ${asString(parsed?.jobId)}` : undefined,
        asString(parsed?.lastMessage),
        asString(parsed?.stderrTail),
        asString(parsed?.stdoutTail),
      ),
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
      detail: buildDetail(
        asString(parsed?.title) ? `Title: ${asString(parsed?.title)}` : undefined,
        asString(parsed?.phase) ? `Stage: ${asString(parsed?.phase)}` : undefined,
        asString(parsed?.integrationStatus) ? `Integration: ${asString(parsed?.integrationStatus)}` : undefined,
        asString(parsed?.latestCommitHash) ? `Commit: ${asString(parsed?.latestCommitHash)}` : undefined,
        asString(parsed?.prUrl) ? `PR: ${asString(parsed?.prUrl)}` : undefined,
        formatFactoryActiveJobs(parsed?.activeJobs),
        formatFactoryReceipts(parsed?.recentReceipts),
        formatFactoryTaskWorktrees(parsed?.taskWorktrees),
        formatFactoryContextPacks(parsed?.latestContextPacks),
      ),
      meta: [action, durationLabel].filter(Boolean).join(" · "),
      link: asString(parsed?.link),
      objectiveId: asString(parsed?.objectiveId),
      running: !isTerminalJobStatus(asString(parsed?.status)),
    };
  }
  if (observation.tool === "factory.output") {
    const focusKind = asString(parsed?.focusKind);
    const focusLabel = focusKind === "job"
      ? "Live job output"
      : focusKind === "task"
        ? "Live task output"
        : "Live output";
    const status = asString(parsed?.status) ?? "unknown";
    const active = parsed?.active === true || !isTerminalJobStatus(status);
    return {
      key: `${observation.tool}-${asString(parsed?.jobId) ?? asString(parsed?.focusId) ?? observation.summary ?? "factory-output"}`,
      title: focusLabel,
      worker: asString(parsed?.worker) ?? "factory",
      status,
      summary: asString(parsed?.summary) ?? observation.summary ?? asString(parsed?.title) ?? "Captured live task output.",
      detail: buildDetail(
        asString(parsed?.title) ? `Title: ${asString(parsed?.title)}` : undefined,
        focusKind && asString(parsed?.focusId) ? `Focus: ${focusKind} ${asString(parsed?.focusId)}` : undefined,
        asString(parsed?.taskId) ? `Task: ${asString(parsed?.taskId)}` : undefined,
        asString(parsed?.candidateId) ? `Candidate: ${asString(parsed?.candidateId)}` : undefined,
        asString(parsed?.jobId) ? `Job ${asString(parsed?.jobId)}` : undefined,
        asString(parsed?.artifactSummary) ? `Artifacts: ${asString(parsed?.artifactSummary)}` : undefined,
        asString(parsed?.lastMessage) ? `Latest note: ${asString(parsed?.lastMessage)}` : undefined,
        asString(parsed?.stderrTail) ? `stderr:\n${asString(parsed?.stderrTail)}` : undefined,
        asString(parsed?.stdoutTail) ? `stdout:\n${asString(parsed?.stdoutTail)}` : undefined,
      ),
      meta: durationLabel,
      objectiveId: asString(parsed?.objectiveId),
      jobId: asString(parsed?.jobId),
      running: active,
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

export const buildChatItemsForRun = (
  runId: string,
  chain: AgentRunChain,
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
      continue;
    }
    if (event.type === "subagent.merged") {
      const job = jobsById.get(event.subJobId);
      const worker = asString(asObject(job?.result)?.worker) ?? normalizedWorkerId(job?.agentId);
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
        input: (typeof event.input === "string" ? tryParseJson(event.input) : event.input) as Record<string, unknown> ?? {},
        summary: event.summary,
        error: event.error,
        durationMs: event.durationMs,
      });
      if (event.error) {
        const card = workCardFromObservation({
          tool: event.tool,
          input: (typeof event.input === "string" ? tryParseJson(event.input) : event.input) as Record<string, unknown> ?? {},
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
      const inputObj = prior?.input as Record<string, unknown> | undefined;
      const outputObj = (typeof event.output === "string" ? tryParseJson(event.output) : event.output) as Record<string, unknown> | undefined;

      if (event.tool === "factory.dispatch" && (inputObj?.action === "create" || inputObj?.action === "promote")) {
        const objectiveId = (outputObj?.objectiveId as string | undefined) ?? (inputObj?.objectiveId as string | undefined) ?? "";
        items.push({
          key: `${runId}-tool-${receipt.hash}`,
          kind: "objective_event",
          title: inputObj.action === "create" ? "Objective Started" : "Objective Promoted",
          summary: prior?.summary ?? "Objective updated",
          objectiveId,
        });
      } else {
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
      }
      pending.delete(key);
    }
  }

  const hasRunningWorkCard = (): boolean =>
    items.some((item) => item.kind === "work" && Boolean(item.card.running));

  const final = reverseFind(chain, (receipt) => receipt.body.type === "response.finalized")?.body;
  const continued = reverseFind(chain, (receipt) => receipt.body.type === "run.continued")?.body;
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
    } else if (continued?.type === "run.continued") {
      items.push({
        key: `${runId}-continued`,
        kind: "system",
        title: "Thread continues automatically",
        body: `${continued.summary}\n\nNext run: ${continued.nextRunId}\nNext job: ${continued.nextJobId}`,
        meta: `${continued.previousMaxIterations} -> ${continued.nextMaxIterations} steps`,
      });
    } else if (state.failure?.failureClass === "iteration_budget_exhausted" && latestChildCard) {
      const childStatus = latestChildCard.running
        ? `still running as ${latestChildCard.jobId}`
        : `${latestChildCard.status}${latestChildCard.jobId ? ` (${latestChildCard.jobId})` : ""}`;
      items.push({
        key: `${runId}-child-status`,
        kind: "system",
        title: "Orchestrator paused",
        body: `The parent skill hit its 8-turn budget, but the Codex child is ${childStatus}.\n\n${latestChildCard.summary}`,
        meta: state.statusNote ?? state.status,
      });
    } else if (state.failure?.failureClass === "iteration_budget_exhausted" && latestObjectiveCard) {
      items.push({
        key: `${runId}-objective-status`,
        kind: "system",
        title: "Thread continues",
        body: `The parent skill hit its 8-turn budget after updating this thread. The thread is still ${latestObjectiveCard.status}.\n\n${latestObjectiveCard.summary}`,
        meta: state.statusNote ?? state.status,
      });
    } else {
      const parsedFinal = tryParseJson(final.content);
      items.push({
        key: `${runId}-assistant-final`,
        kind: "assistant",
        body: parsedFinal ? (jsonRecordToMarkdown(parsedFinal) ?? final.content) : final.content,
        meta: state.statusNote ?? state.status,
      });
    }
  } else if (state.status === "running") {
    const activeProfile = profileLabel(state.profile?.profileId);
    const activityLine = state.lastTool?.name
      ? `${activeProfile} is using ${state.lastTool.name}${state.lastTool.summary ? `.\n\n${state.lastTool.summary}` : ""}${state.lastTool.error ? `\n\n${state.lastTool.error}` : ""}`
      : `${activeProfile} is shaping the next step in this thread. Live updates will appear here.`;
    if (!hasRunningWorkCard()) {
      items.push({
        key: `${runId}-running`,
        kind: "system",
        title: `${activeProfile} working`,
        body: activityLine,
        meta: state.status,
      });
    }
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
