import type { AgentState } from "../../modules/agent";
import type { QueueJob } from "../../adapters/sqlite-queue";
import { summarizeFactoryQueueJob } from "../../views/factory/job-presenters";
import type {
  FactoryLiveChildCard,
  FactoryLiveCodexCard,
  FactoryLiveRunCard,
  FactoryRunStep,
} from "../../views/factory-models";

import { buildChatLink } from "./links";
import { compactJsonValue, humanizeKey, truncateInline, tryParseJson } from "./formatters";
import {
  asObject,
  asString,
  isDescendantStream,
  isTerminalJobStatus,
  jobParentRunId,
  jobRunId,
  normalizedWorkerId,
  type AgentRunChain,
} from "./shared";
import { projectAgentRun } from "./run-projection";

export const summarizeJob = (job: QueueJob): string => {
  const payloadProblem = asString(job.payload.problem);
  if (payloadProblem) return payloadProblem.replace(/\s+/g, " ").slice(0, 120);
  return summarizeFactoryQueueJob(job, {
    preferNoteBeforeMessage: true,
    preferTerminalSummary: false,
    clipTaskAt: 120,
  });
};

const LIVE_JOB_STALE_AFTER_MS = 90_000;

const jobProgressAt = (job: QueueJob): number | undefined => {
  const result = asObject(job.result);
  return typeof result?.progressAt === "number" && Number.isFinite(result.progressAt)
    ? result.progressAt
    : undefined;
};

const liveJobStatus = (job: QueueJob): string => {
  if (isTerminalJobStatus(job.status)) return job.status;
  const progressAt = jobProgressAt(job);
  if (job.status === "running" && typeof progressAt === "number" && Date.now() - progressAt >= LIVE_JOB_STALE_AFTER_MS) {
    return "stalled";
  }
  return job.status;
};

const liveJobUpdatedAt = (job: QueueJob): number => jobProgressAt(job) ?? job.updatedAt;

const codexJobPriority = (job: QueueJob): number => {
  if (!isTerminalJobStatus(job.status)) return 0;
  if (job.status === "failed") return 1;
  if (job.status === "completed") return 2;
  return 3;
};

const liveChildPriority = (job: QueueJob): number => {
  if (!isTerminalJobStatus(job.status)) return 0;
  if (job.status === "failed") return 1;
  if (job.status === "canceled") return 2;
  return 3;
};

const seedSet = (values: ReadonlyArray<string | undefined>): Set<string> =>
  new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0));

const linkRunId = (pending: string[], seen: ReadonlySet<string>, value: string | undefined): void => {
  const runId = value?.trim();
  if (!runId || seen.has(runId) || pending.includes(runId)) return;
  pending.push(runId);
};

export const collectRunIds = (chain: AgentRunChain): ReadonlyArray<string> => {
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

export const collectRunLineageIds = (
  seedRunIds: ReadonlyArray<string | undefined>,
  runChainsById: ReadonlyMap<string, AgentRunChain>,
  jobs: ReadonlyArray<QueueJob>,
): ReadonlySet<string> => {
  const related = new Set<string>();
  const pending = [...seedSet(seedRunIds)];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || related.has(current)) continue;
    related.add(current);

    const currentChain = runChainsById.get(current);
    if (currentChain) {
      for (const receipt of currentChain) {
        const event = receipt.body;
        if (event.type === "run.continued") {
          linkRunId(pending, related, event.runId);
          linkRunId(pending, related, event.nextRunId);
          continue;
        }
        if (event.type === "subagent.merged") {
          linkRunId(pending, related, event.runId);
          linkRunId(pending, related, event.subRunId);
          continue;
        }
        if (event.type === "tool.observed" && event.tool === "agent.delegate") {
          const parsed = tryParseJson(event.output);
          linkRunId(pending, related, asString(parsed?.runId));
          linkRunId(pending, related, asString(parsed?.parentRunId));
        }
      }
    }

    for (const [candidateRunId, candidateChain] of runChainsById.entries()) {
      for (const receipt of candidateChain) {
        const event = receipt.body;
        if (event.type === "run.continued" && event.nextRunId === current) {
          linkRunId(pending, related, candidateRunId);
          continue;
        }
        if (event.type === "subagent.merged" && event.subRunId === current) {
          linkRunId(pending, related, event.runId);
          continue;
        }
        if (event.type === "tool.observed" && event.tool === "agent.delegate") {
          const parsed = tryParseJson(event.output);
          if (asString(parsed?.runId) === current) linkRunId(pending, related, candidateRunId);
        }
      }
    }

    for (const job of jobs) {
      const payloadRun = jobRunId(job);
      const parentRun = jobParentRunId(job);
      if (parentRun === current) linkRunId(pending, related, payloadRun);
      if (payloadRun === current) linkRunId(pending, related, parentRun);
    }
  }
  return related;
};

export const jobMatchesRunIds = (job: QueueJob, runIds: ReadonlySet<string>): boolean => {
  if (runIds.size === 0) return false;
  const payloadRun = jobRunId(job);
  const parentRun = jobParentRunId(job);
  return (payloadRun !== undefined && runIds.has(payloadRun))
    || (parentRun !== undefined && runIds.has(parentRun));
};

export const buildActiveCodexCard = (jobs: ReadonlyArray<QueueJob>): FactoryLiveCodexCard | undefined => {
  const codexJob = [...jobs]
    .filter((job) => normalizedWorkerId(job.agentId) === "codex")
    .filter((job) => !isTerminalJobStatus(job.status))
    .sort((left, right) =>
      codexJobPriority(left) - codexJobPriority(right)
      || right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
      || right.id.localeCompare(left.id)
    )[0];
  if (!codexJob) return undefined;
  const result = asObject(codexJob.result);
  const status = liveJobStatus(codexJob);
  return {
    jobId: codexJob.id,
    status,
    summary: status === "stalled"
      ? asString(result?.summary) ?? "No recent Codex progress was observed."
      : summarizeJob(codexJob),
    latestNote: asString(result?.lastMessage) ?? asString(result?.message),
    tokensUsed: typeof result?.tokensUsed === "number" ? result.tokensUsed : undefined,
    stderrTail: asString(result?.stderrTail),
    stdoutTail: asString(result?.stdoutTail),
    runId: asString(codexJob.payload.parentRunId) ?? asString(codexJob.payload.runId),
    task: asString(codexJob.payload.task)
      ?? asString(codexJob.payload.prompt)
      ?? asString(codexJob.payload.problem)
      ?? asString(codexJob.payload.taskId),
    updatedAt: liveJobUpdatedAt(codexJob),
    abortRequested: codexJob.abortRequested === true,
    rawLink: `/jobs/${encodeURIComponent(codexJob.id)}`,
    running: !isTerminalJobStatus(codexJob.status) && status !== "stalled",
  };
};

const isLiveChildShellJob = (job: QueueJob, stream: string, objectiveId?: string): boolean => {
  const kind = asString(job.payload.kind);
  const payloadStream = asString(job.payload.stream);
  const parentStream = asString(job.payload.parentStream);
  const payloadObjectiveId = asString(job.payload.objectiveId);
  if (kind === "factory.run" && payloadStream === stream) return false;
  if (isDescendantStream(parentStream, stream)) return true;
  if (payloadStream?.startsWith(`${stream}/sub/`)) return true;
  if (Boolean(objectiveId) && payloadObjectiveId === objectiveId && kind !== "factory.run") return true;
  return false;
};

export const buildLiveChildCards = (
  jobs: ReadonlyArray<QueueJob>,
  stream: string,
  objectiveId?: string,
): ReadonlyArray<FactoryLiveChildCard> =>
  [...jobs]
    .filter((job) => isLiveChildShellJob(job, stream, objectiveId))
    .sort((left, right) =>
      liveChildPriority(left) - liveChildPriority(right)
      || right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
      || right.id.localeCompare(left.id)
    )
    .map((job) => {
      const result = asObject(job.result);
      const payloadStream = asString(job.payload.stream);
      const parentStream = asString(job.payload.parentStream);
      const worker = asString(result?.worker) ?? normalizedWorkerId(job.agentId);
      const status = liveJobStatus(job);
      return {
        jobId: job.id,
        agentId: job.agentId,
        worker,
        status,
        summary: status === "stalled"
          ? asString(result?.summary) ?? "No recent worker progress was observed."
          : summarizeJob(job),
        latestNote: asString(result?.lastMessage) ?? asString(result?.message),
        tokensUsed: typeof result?.tokensUsed === "number" ? result.tokensUsed : undefined,
        stderrTail: asString(result?.stderrTail),
        stdoutTail: asString(result?.stdoutTail),
        runId: asString(job.payload.runId) ?? asString(job.payload.parentRunId),
        parentRunId: asString(job.payload.parentRunId),
        stream: payloadStream,
        parentStream,
        task: asString(job.payload.task)
          ?? asString(job.payload.prompt)
          ?? asString(job.payload.problem)
          ?? asString(job.payload.taskId),
        updatedAt: liveJobUpdatedAt(job),
        abortRequested: job.abortRequested === true,
        rawLink: `/jobs/${encodeURIComponent(job.id)}`,
        running: !isTerminalJobStatus(job.status) && status !== "stalled",
      } satisfies FactoryLiveChildCard;
    });

const stepMeta = (iteration: number): string => `Step ${iteration}`;

const toneFromStatusLike = (value: string | undefined): FactoryRunStep["tone"] => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "neutral";
  if ([
    "completed",
    "ready",
    "approved",
    "success",
    "succeeded",
    "healthy",
    "ok",
  ].includes(normalized)) return "success";
  if ([
    "failed",
    "failure",
    "error",
    "blocked",
    "conflicted",
    "canceled",
    "cancelled",
    "needs_attention",
    "unhealthy",
  ].includes(normalized)) return "danger";
  if ([
    "queued",
    "pending",
    "waiting",
    "planning",
    "idle",
    "degraded",
  ].includes(normalized)) return "warning";
  if ([
    "running",
    "executing",
    "active",
    "leased",
    "processing",
    "reviewing",
    "in_progress",
  ].includes(normalized)) return "info";
  return "neutral";
};

const summarizeToolObservation = (output: string): {
  readonly summary?: string;
  readonly detail?: string;
  readonly tone?: FactoryRunStep["tone"];
} => {
  const parsed = tryParseJson(output);
  if (!parsed) {
    const summary = truncateInline(output);
    return summary ? { summary } : {};
  }
  const status = asString(parsed.status);
  const summary = asString(parsed.summary)
    ?? asString(parsed.message)
    ?? asString(parsed.note)
    ?? asString(parsed.lastMessage)
    ?? asString(parsed.error)
    ?? compactJsonValue(parsed);
  const title = asString(parsed.title);
  const detail = title && summary !== title
    ? `Target: ${truncateInline(title, 120)}`
    : undefined;
  return {
    summary: summary ? truncateInline(summary) : undefined,
    detail,
    tone: toneFromStatusLike(status ?? asString(parsed.error)),
  };
};

const normalizeStepSummary = (value: string | undefined): string =>
  value?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";

const shouldHideRunStep = (step: FactoryRunStep): boolean => {
  const normalizedSummary = normalizeStepSummary(step.summary);
  if (step.kind === "validation" && normalizedSummary === "native structured action parsed") return true;
  if (step.kind === "action" && normalizedSummary === "preparing the reply.") return true;
  return false;
};

const collapseNoisyRunSteps = (steps: ReadonlyArray<FactoryRunStep>): ReadonlyArray<FactoryRunStep> => {
  const collapsed: FactoryRunStep[] = [];
  for (const step of steps) {
    if (shouldHideRunStep(step)) continue;
    const prior = collapsed.at(-1);
    if (
      prior
      && prior.kind === step.kind
      && normalizeStepSummary(prior.summary) === normalizeStepSummary(step.summary)
      && (prior.detail ?? "") === (step.detail ?? "")
    ) {
      collapsed[collapsed.length - 1] = {
        ...step,
        meta: step.meta ?? prior.meta,
      };
      continue;
    }
    collapsed.push(step);
  }
  return collapsed;
};

const buildActiveRunSteps = (
  runId: string,
  runChain: AgentRunChain,
): ReadonlyArray<FactoryRunStep> => {
  const steps: FactoryRunStep[] = [];
  const toolStepIndex = new Map<string, number>();

  for (const receipt of runChain) {
    const event = receipt.body;
    switch (event.type) {
      case "thought.logged": {
        const summary = truncateInline(event.content, 260);
        if (!summary) break;
        steps.push({
          key: `${runId}-thought-${receipt.hash}`,
          kind: "thought",
          label: "Thinking",
          summary,
          meta: stepMeta(event.iteration),
          tone: "info",
          at: receipt.ts,
        });
        break;
      }
      case "action.planned": {
        const summary = event.actionType === "final"
          ? "Preparing the reply."
          : event.name
            ? `Planning ${humanizeKey(event.name)}.`
            : "Planning the next tool call.";
        const detail = compactJsonValue(event.input);
        steps.push({
          key: `${runId}-action-${receipt.hash}`,
          kind: "action",
          label: "Plan",
          summary,
          detail: detail ? truncateInline(detail, 200) : undefined,
          meta: stepMeta(event.iteration),
          tone: event.actionType === "final" ? "success" : "neutral",
          at: receipt.ts,
        });
        break;
      }
      case "tool.called": {
        steps.push({
          key: `${runId}-tool-${receipt.hash}`,
          kind: "tool",
          label: "Tool",
          summary: truncateInline(event.summary ?? `Running ${humanizeKey(event.tool)}.`),
          detail: compactJsonValue(event.input),
          meta: stepMeta(event.iteration),
          tone: event.error ? "danger" : "info",
          at: receipt.ts,
        });
        toolStepIndex.set(`${event.iteration}:${event.tool}`, steps.length - 1);
        break;
      }
      case "tool.observed": {
        const summary = summarizeToolObservation(event.output);
        const lookupKey = `${event.iteration}:${event.tool}`;
        const index = toolStepIndex.get(lookupKey);
        if (typeof index === "number") {
          const prior = steps[index];
          if (prior) {
            steps[index] = {
              ...prior,
              summary: summary.summary ?? prior.summary,
              detail: summary.detail ?? prior.detail,
              tone: summary.tone ?? prior.tone,
              at: receipt.ts,
            };
            break;
          }
        }
        steps.push({
          key: `${runId}-tool-observed-${receipt.hash}`,
          kind: "tool",
          label: "Tool",
          summary: summary.summary ?? `Updated ${humanizeKey(event.tool)}.`,
          detail: summary.detail,
          meta: stepMeta(event.iteration),
          tone: summary.tone ?? "info",
          at: receipt.ts,
        });
        break;
      }
      case "memory.slice": {
        const summary = event.itemCount > 0
          ? `Loaded ${event.itemCount.toLocaleString()} memory item${event.itemCount === 1 ? "" : "s"} from ${event.scope}.`
          : `Checked ${event.scope}.`;
        const detailParts = [
          event.query ? `Query: ${truncateInline(event.query, 120)}` : undefined,
          `${event.chars.toLocaleString()} chars`,
          event.truncated ? "truncated" : undefined,
        ].filter((part): part is string => Boolean(part));
        steps.push({
          key: `${runId}-memory-${receipt.hash}`,
          kind: "memory",
          label: "Memory",
          summary,
          detail: detailParts.length > 0 ? detailParts.join(" · ") : undefined,
          meta: stepMeta(event.iteration),
          tone: "neutral",
          at: receipt.ts,
        });
        break;
      }
      case "validation.report": {
        const detailParts = [
          event.target ? `Target: ${event.target}` : undefined,
          event.details ? truncateInline(event.details, 200) : undefined,
        ].filter((part): part is string => Boolean(part));
        steps.push({
          key: `${runId}-validation-${receipt.hash}`,
          kind: "validation",
          label: event.ok ? "Validated" : "Check",
          summary: truncateInline(event.summary, 260),
          detail: detailParts.length > 0 ? detailParts.join(" · ") : undefined,
          meta: stepMeta(event.iteration),
          tone: event.ok ? "success" : "danger",
          at: receipt.ts,
        });
        break;
      }
      default:
        break;
    }
  }

  const recentSteps = collapseNoisyRunSteps(steps).slice(-8);
  return recentSteps.map((step, index) => (
    index === recentSteps.length - 1
      ? { ...step, active: true }
      : step
  ));
};

const describeRunActivity = (
  profileLabel: string,
  state: AgentState,
  finalContent?: string,
): string => {
  const tool = state.lastTool?.name?.trim().toLowerCase();
  if (state.status === "failed") return "Needs attention.";
  if (state.status === "completed") return "Run completed.";
  if (tool === "jobs.list") return `${profileLabel} is checking live jobs.`;
  if (tool === "agent.status") return `${profileLabel} is checking child status.`;
  if (tool === "codex.status") return `${profileLabel} is checking Codex progress.`;
  if (tool === "factory.status") return `${profileLabel} is checking thread status.`;
  if (tool === "repo.status") return `${profileLabel} is checking repo state.`;
  if (tool === "agent.inspect") return `${profileLabel} is tracing child activity.`;
  if (tool === "factory.dispatch") return `${profileLabel} is updating the thread.`;
  if (tool === "codex.run") return `${profileLabel} queued Codex work and is waiting for progress.`;
  if (tool === "agent.delegate") return `${profileLabel} delegated follow-up work.`;
  if (tool && tool.length > 0) return `${profileLabel} is using ${tool}.`;
  if (finalContent?.trim()) return "Run completed.";
  if (state.status === "running") return `${profileLabel} is still working.`;
  return "No run receipts yet.";
};

export const summarizePendingRunJob = (
  job: QueueJob,
  activeProfileLabel: string,
): FactoryLiveRunCard => {
  const summary = job.status === "queued"
    ? "Waiting for a worker to pick up this run."
    : job.status === "leased"
      ? "A worker claimed this run and is starting it."
      : job.status === "running"
        ? `${activeProfileLabel} is starting this run.`
        : job.status === "completed"
          ? "Run worker finished."
          : job.status === "canceled"
            ? (job.canceledReason ?? "Run was canceled.")
            : (job.lastError ?? "Run failed.");
  return {
    runId: asString(job.payload.runId) ?? asString(job.payload.parentRunId) ?? job.id,
    profileLabel: activeProfileLabel,
    status: job.status,
    summary,
    updatedAt: job.updatedAt,
    link: buildChatLink({
      profileId: asString(job.payload.profileId),
      chatId: asString(job.payload.chatId),
      objectiveId: asString(job.payload.objectiveId),
      runId: asString(job.payload.runId) ?? asString(job.payload.parentRunId),
      jobId: job.id,
    }),
    lastToolSummary: asString(job.payload.problem) ?? asString(job.payload.task) ?? asString(job.payload.kind),
  };
};

export const summarizeActiveRunCard = (input: {
  readonly runId: string;
  readonly runChain: AgentRunChain;
  readonly relatedJobs: ReadonlyArray<QueueJob>;
  readonly profileLabel: string;
  readonly profileId: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
}): FactoryLiveRunCard => {
  const projection = projectAgentRun(input.runChain);
  const state = projection.state;
  const final = projection.final;
  const failure = state.failure?.message;
  const finalContent = final?.type === "response.finalized"
    ? final.content.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim()
    : undefined;
  const relatedJobs = [...input.relatedJobs]
    .sort((left, right) =>
      right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
      || right.id.localeCompare(left.id)
    );
  const activeChild = relatedJobs.find((job) => !isTerminalJobStatus(job.status) && normalizedWorkerId(job.agentId) !== "factory");
  const latestFailedChild = relatedJobs.find((job) => job.status === "failed" && normalizedWorkerId(job.agentId) !== "factory");
  const latestTerminalChild = relatedJobs.find((job) => isTerminalJobStatus(job.status) && normalizedWorkerId(job.agentId) !== "factory");
  const tool = state.lastTool?.name?.trim().toLowerCase();
  const isPureStatusPoll = tool === "agent.status" || tool === "codex.status" || tool === "jobs.list" || tool === "factory.status" || tool === "repo.status" || tool === "agent.inspect";
  const derivedStatus = activeChild
    ? state.status
    : latestFailedChild && state.status === "running"
      ? "needs_attention"
      : isPureStatusPoll && state.status === "running"
        ? "idle"
        : state.status;
  const summary = activeChild
    ? summarizeJob(activeChild)
    : latestFailedChild
      ? `Latest child ${latestFailedChild.id} failed: ${summarizeJob(latestFailedChild)}`
      : latestTerminalChild && isPureStatusPoll
        ? `No active child jobs. Latest update: ${summarizeJob(latestTerminalChild)}`
        : state.lastTool?.error
          ?? failure
          ?? describeRunActivity(input.profileLabel, state, finalContent);
  return {
    runId: input.runId,
    profileLabel: input.profileLabel,
    status: derivedStatus,
    summary,
    updatedAt: input.runChain.at(-1)?.ts,
    lastToolName: state.lastTool?.name,
    lastToolSummary: latestFailedChild
      ? `${latestFailedChild.id}: ${summarizeJob(latestFailedChild)}`
      : state.lastTool?.summary ?? state.lastTool?.error,
    steps: buildActiveRunSteps(input.runId, input.runChain),
    link: buildChatLink({
      profileId: input.profileId,
      chatId: input.chatId,
      objectiveId: input.objectiveId,
      runId: input.runId,
    }),
  };
};
