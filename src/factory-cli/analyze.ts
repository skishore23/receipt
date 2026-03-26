import { fold } from "@receipt/core/chain";
import type { Receipt } from "@receipt/core/types";

import { jsonlStore } from "../adapters/jsonl";
import type { AgentEvent } from "../modules/agent";
import { initial as initialAgent, reduce as reduceAgent } from "../modules/agent";
import type {
  FactoryCandidateRecord,
  FactoryEvent,
  FactoryObjectivePolicy,
  FactoryTaskRecord,
} from "../modules/factory";
import { buildFactoryProjection, initialFactoryState, reduceFactory } from "../modules/factory";
import type { JobEvent } from "../modules/job";
import { initial as initialJob, reduce as reduceJob } from "../modules/job";

type AnalysisSeverity = "high" | "medium" | "low";

type ObjectiveSequenceItem = {
  readonly at: number;
  readonly type: FactoryEvent["type"];
  readonly summary: string;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly jobId?: string;
};

type ToolMetric = {
  readonly tool: string;
  readonly count: number;
  readonly errorCount: number;
  readonly observedCount: number;
  readonly truncatedObservations: number;
  readonly totalDurationMs: number;
  readonly avgDurationMs?: number;
};

type ToolTransitionMetric = {
  readonly fromTool: string;
  readonly toTool: string;
  readonly count: number;
};

type TaskAnalysis = {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly candidateId?: string;
  readonly jobId?: string;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly createdAt: number;
  readonly readyAt?: number;
  readonly startedAt?: number;
  readonly reviewingAt?: number;
  readonly completedAt?: number;
  readonly waitDurationMs?: number;
  readonly runDurationMs?: number;
  readonly totalDurationMs?: number;
};

type CandidateAnalysis = {
  readonly candidateId: string;
  readonly taskId: string;
  readonly status: string;
  readonly summary?: string;
  readonly latestReason?: string;
  readonly tokensUsed?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly approvedAt?: number;
  readonly integratedAt?: number;
};

type JobCommandAnalysis = {
  readonly commandId: string;
  readonly command: string;
  readonly by?: string;
  readonly createdAt: number;
  readonly consumedAt?: number;
};

type JobAnalysis = {
  readonly stream: string;
  readonly jobId: string;
  readonly agentId: string;
  readonly lane: string;
  readonly payloadKind?: string;
  readonly payloadObjectiveId?: string;
  readonly payloadTaskId?: string;
  readonly payloadCandidateId?: string;
  readonly payloadRunId?: string;
  readonly sessionKey?: string;
  readonly singletonMode?: string;
  readonly status: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly receiptCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly durationMs?: number;
  readonly progressEvents: number;
  readonly heartbeats: number;
  readonly retryCount: number;
  readonly abortRequested: boolean;
  readonly lastError?: string;
  readonly canceledReason?: string;
  readonly summary?: string;
  readonly tokensUsed?: number;
  readonly commands: ReadonlyArray<JobCommandAnalysis>;
};

type AgentRunError = {
  readonly at: number;
  readonly kind: "tool" | "validation" | "failure";
  readonly summary: string;
  readonly tool?: string;
};

type AgentRunAnalysis = {
  readonly stream: string;
  readonly runId: string;
  readonly problem: string;
  readonly status: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly configuredObjectiveId?: string;
  readonly startupObjectiveId?: string;
  readonly latestBoundObjectiveId?: string;
  readonly boundObjectiveIds: ReadonlyArray<string>;
  readonly mismatchedObjectiveIds: ReadonlyArray<string>;
  readonly receiptCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly durationMs: number;
  readonly iterations: number;
  readonly actionPlans: number;
  readonly thoughts: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly memorySlices: number;
  readonly memoryChars: number;
  readonly validationsOk: number;
  readonly validationsFailed: number;
  readonly contextPrunes: number;
  readonly contextCompactions: number;
  readonly overflowRecoveries: number;
  readonly delegated: number;
  readonly mergedSubagents: number;
  readonly continuations: number;
  readonly maxContinuationDepth: number;
  readonly finalResponsePreview?: string;
  readonly topTools: ReadonlyArray<ToolMetric>;
  readonly toolTransitions: ReadonlyArray<ToolTransitionMetric>;
  readonly errors: ReadonlyArray<AgentRunError>;
};

type AnalysisAnomaly = {
  readonly kind: string;
  readonly severity: AnalysisSeverity;
  readonly summary: string;
  readonly at?: number;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly jobId?: string;
  readonly runId?: string;
  readonly stream?: string;
};

export type ObjectiveAnalysis = {
  readonly objectiveId: string;
  readonly stream: string;
  readonly title: string;
  readonly status: string;
  readonly objectiveMode: string;
  readonly severity: number;
  readonly profile: {
    readonly rootProfileId: string;
    readonly rootProfileLabel: string;
    readonly selectedSkills: ReadonlyArray<string>;
  };
  readonly policy: FactoryObjectivePolicy;
  readonly receiptCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly durationMs: number;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly sequence: ReadonlyArray<ObjectiveSequenceItem>;
  readonly tasks: ReadonlyArray<TaskAnalysis>;
  readonly candidates: ReadonlyArray<CandidateAnalysis>;
  readonly jobs: ReadonlyArray<JobAnalysis>;
  readonly agentRuns: ReadonlyArray<AgentRunAnalysis>;
  readonly metrics: {
    readonly objective: {
      readonly receipts: number;
      readonly durationMs: number;
      readonly operatorNotes: number;
      readonly dispatches: number;
      readonly rebrackets: number;
      readonly taskRunsUsed: number;
      readonly maxObservedActiveTasks: number;
      readonly concurrencyLimit: number;
      readonly candidatePassesByTask: Readonly<Record<string, number>>;
      readonly eventCounts: Readonly<Record<string, number>>;
    };
    readonly tasks: {
      readonly total: number;
      readonly byStatus: Readonly<Record<string, number>>;
      readonly avgRunDurationMs?: number;
      readonly avgTotalDurationMs?: number;
    };
    readonly candidates: {
      readonly total: number;
      readonly byStatus: Readonly<Record<string, number>>;
      readonly totalTokensUsed: number;
    };
    readonly jobs: {
      readonly total: number;
      readonly byStatus: Readonly<Record<string, number>>;
      readonly failed: number;
      readonly canceled: number;
      readonly retrying: number;
      readonly abortCommands: number;
      readonly controlJobs: number;
      readonly totalTokensUsed: number;
    };
    readonly agent: {
      readonly runCount: number;
      readonly completedRuns: number;
      readonly continuations: number;
      readonly maxContinuationDepth: number;
      readonly toolCalls: number;
      readonly toolErrors: number;
      readonly actionPlans: number;
      readonly thoughts: number;
      readonly memorySlices: number;
      readonly memoryChars: number;
      readonly validationsOk: number;
      readonly validationsFailed: number;
      readonly contextPrunes: number;
      readonly contextCompactions: number;
      readonly overflowRecoveries: number;
      readonly delegated: number;
      readonly mergedSubagents: number;
      readonly mismatchedRuns: number;
      readonly models: ReadonlyArray<string>;
      readonly topTools: ReadonlyArray<ToolMetric>;
      readonly topTransitions: ReadonlyArray<ToolTransitionMetric>;
    };
  };
  readonly anomalies: ReadonlyArray<AnalysisAnomaly>;
  readonly recommendations: ReadonlyArray<string>;
};

type ToolMetricAccumulator = {
  count: number;
  errorCount: number;
  observedCount: number;
  truncatedObservations: number;
  totalDurationMs: number;
};

const objectiveReplayStream = (objectiveIdOrStream: string): {
  readonly objectiveId: string;
  readonly stream: string;
} => {
  const raw = objectiveIdOrStream.trim();
  const stream = raw.startsWith("factory/objectives/") ? raw : `factory/objectives/${raw}`;
  const objectiveId = stream.replace(/^factory\/objectives\//, "");
  return { objectiveId, stream };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const truncateInline = (value: string | undefined, max = 180): string | undefined => {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}\u2026`;
};

const formatDurationMs = (durationMs: number | undefined): string => {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return "n/a";
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
};

const formatTimestamp = (ts: number | undefined): string =>
  typeof ts === "number" && Number.isFinite(ts)
    ? new Date(ts).toISOString()
    : "unknown";

const increment = (counts: Map<string, number>, key: string, delta = 1): void => {
  counts.set(key, (counts.get(key) ?? 0) + delta);
};

const countsToObject = (counts: Map<string, number>): Record<string, number> =>
  [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .reduce<Record<string, number>>((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});

const average = (values: ReadonlyArray<number>): number | undefined =>
  values.length > 0 ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : undefined;

const sortToolMetrics = (metrics: Map<string, ToolMetricAccumulator>): ReadonlyArray<ToolMetric> =>
  [...metrics.entries()]
    .map(([tool, value]) => ({
      tool,
      count: value.count,
      errorCount: value.errorCount,
      observedCount: value.observedCount,
      truncatedObservations: value.truncatedObservations,
      totalDurationMs: value.totalDurationMs,
      avgDurationMs: value.count > 0 && value.totalDurationMs > 0
        ? Math.round(value.totalDurationMs / value.count)
        : undefined,
    }))
    .sort((left, right) =>
      right.count - left.count
      || right.errorCount - left.errorCount
      || left.tool.localeCompare(right.tool));

const sortToolTransitions = (counts: Map<string, number>): ReadonlyArray<ToolTransitionMetric> =>
  [...counts.entries()]
    .map(([key, count]) => {
      const [fromTool, toTool] = key.split("\u0000");
      return {
        fromTool: fromTool ?? "unknown",
        toTool: toTool ?? "unknown",
        count,
      };
    })
    .sort((left, right) =>
      right.count - left.count
      || left.fromTool.localeCompare(right.fromTool)
      || left.toTool.localeCompare(right.toTool));

const objectiveEventSummary = (event: FactoryEvent): string => {
  switch (event.type) {
    case "objective.created":
      return `Objective created: ${event.title}`;
    case "objective.operator.noted":
      return `Operator note: ${truncateInline(event.message, 220)}`;
    case "planning.receipt":
      return `Planning receipt: ${event.plan.taskGraph.length} task(s), ${event.plan.acceptanceCriteria.length} acceptance criteria`;
    case "objective.slot.queued":
      return "Objective queued for execution slot";
    case "objective.slot.admitted":
      return "Objective admitted to execution slot";
    case "objective.slot.released":
      return `Objective slot released: ${event.reason}`;
    case "task.added":
      return `${event.task.taskId} added: ${event.task.title}`;
    case "task.ready":
      return `${event.taskId} ready`;
    case "task.dispatched":
      return `${event.taskId} dispatched as ${event.candidateId}`;
    case "task.review.requested":
      return `${event.taskId} review requested`;
    case "task.approved":
      return `${event.taskId} approved: ${truncateInline(event.summary)}`;
    case "task.integrated":
      return `${event.taskId} integrated: ${truncateInline(event.summary)}`;
    case "task.blocked":
      return `${event.taskId} blocked: ${truncateInline(event.reason, 220)}`;
    case "task.unblocked":
      return `${event.taskId} unblocked`;
    case "task.superseded":
      return `${event.taskId} superseded: ${truncateInline(event.reason, 220)}`;
    case "candidate.created":
      return `${event.candidate.candidateId} created for ${event.candidate.taskId}`;
    case "candidate.produced":
      return `${event.candidateId} produced: ${truncateInline(event.summary)}`;
    case "candidate.reviewed":
      return `${event.candidateId} ${event.status}: ${truncateInline(event.summary)}`;
    case "investigation.reported":
      return `${event.taskId} reported: ${truncateInline(event.summary)}`;
    case "investigation.synthesized":
      return `Investigation synthesized: ${truncateInline(event.summary)}`;
    case "candidate.conflicted":
      return `${event.candidateId} conflicted: ${truncateInline(event.reason, 220)}`;
    case "rebracket.applied":
      return `Rebracketed: ${truncateInline(event.reason, 220)}`;
    case "merge.applied":
      return `${event.candidateId} merged: ${truncateInline(event.summary)}`;
    case "integration.queued":
      return `${event.candidateId} queued for integration`;
    case "integration.merging":
      return `${event.candidateId} integration merging`;
    case "integration.validating":
      return `${event.candidateId} integration validating`;
    case "integration.validated":
      return `${event.candidateId} integration validated: ${truncateInline(event.summary)}`;
    case "integration.ready_to_promote":
      return `${event.candidateId} ready to promote: ${truncateInline(event.summary)}`;
    case "integration.promoting":
      return `${event.candidateId} promoting`;
    case "integration.promoted":
      return `${event.candidateId} promoted: ${truncateInline(event.summary)}`;
    case "integration.conflicted":
      return `Integration conflicted: ${truncateInline(event.reason, 220)}`;
    case "objective.completed":
      return `Objective completed: ${truncateInline(event.summary)}`;
    case "objective.blocked":
      return `Objective blocked: ${truncateInline(event.reason, 220)}`;
    case "objective.failed":
      return `Objective failed: ${truncateInline(event.reason, 220)}`;
    case "objective.canceled":
      return `Objective canceled: ${truncateInline(event.reason ?? "canceled", 220)}`;
    case "objective.archived":
      return "Objective archived";
    default:
      return "unknown";
  }
};

const buildObjectiveSequence = (
  chain: ReadonlyArray<Receipt<FactoryEvent>>,
): {
  readonly sequence: ReadonlyArray<ObjectiveSequenceItem>;
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly maxObservedActiveTasks: number;
  readonly knownJobIds: ReadonlySet<string>;
} => {
  const eventCounts = new Map<string, number>();
  const activeTasks = new Set<string>();
  const knownJobIds = new Set<string>();
  let maxObservedActiveTasks = 0;
  const sequence = chain.map((receipt) => {
    const event = receipt.body;
    increment(eventCounts, event.type);
    if (event.type === "task.dispatched") {
      activeTasks.add(event.taskId);
      knownJobIds.add(event.jobId);
      maxObservedActiveTasks = Math.max(maxObservedActiveTasks, activeTasks.size);
    }
    if (event.type === "task.blocked" || event.type === "task.approved" || event.type === "task.integrated" || event.type === "task.superseded") {
      activeTasks.delete(event.taskId);
    }
    return {
      at: receipt.ts,
      type: event.type,
      summary: objectiveEventSummary(event),
      taskId: "taskId" in event ? event.taskId : undefined,
      candidateId: "candidateId" in event ? event.candidateId : undefined,
      jobId: event.type === "task.dispatched" ? event.jobId : undefined,
    } satisfies ObjectiveSequenceItem;
  });
  return {
    sequence,
    eventCounts: countsToObject(eventCounts),
    maxObservedActiveTasks,
    knownJobIds,
  };
};

const buildTaskAnalysis = (task: FactoryTaskRecord): TaskAnalysis => ({
  taskId: task.taskId,
  title: task.title,
  status: task.status,
  dependsOn: task.dependsOn,
  candidateId: task.candidateId,
  jobId: task.jobId,
  latestSummary: task.latestSummary,
  blockedReason: task.blockedReason,
  createdAt: task.createdAt,
  readyAt: task.readyAt,
  startedAt: task.startedAt,
  reviewingAt: task.reviewingAt,
  completedAt: task.completedAt,
  waitDurationMs: typeof task.readyAt === "number" && typeof task.startedAt === "number"
    ? Math.max(0, task.startedAt - task.readyAt)
    : undefined,
  runDurationMs: typeof task.startedAt === "number" && typeof task.completedAt === "number"
    ? Math.max(0, task.completedAt - task.startedAt)
    : undefined,
  totalDurationMs: typeof task.completedAt === "number"
    ? Math.max(0, task.completedAt - task.createdAt)
    : undefined,
});

const buildCandidateAnalysis = (candidate: FactoryCandidateRecord): CandidateAnalysis => ({
  candidateId: candidate.candidateId,
  taskId: candidate.taskId,
  status: candidate.status,
  summary: candidate.summary,
  latestReason: candidate.latestReason,
  tokensUsed: candidate.tokensUsed,
  createdAt: candidate.createdAt,
  updatedAt: candidate.updatedAt,
  approvedAt: candidate.approvedAt,
  integratedAt: candidate.integratedAt,
});

const readJobAnalysis = async (dataDir: string, stream: string): Promise<JobAnalysis | undefined> => {
  const store = jsonlStore<JobEvent>(dataDir);
  const chain = await store.read(stream);
  if (chain.length === 0) return undefined;
  const state = fold(chain, reduceJob, initialJob);
  const jobId = stream.replace(/^jobs\//, "");
  const job = state.jobs[jobId];
  if (!job) return undefined;
  let progressEvents = 0;
  let heartbeats = 0;
  let summary: string | undefined;
  let tokensUsed: number | undefined;
  for (const receipt of chain) {
    const event = receipt.body;
    if (event.type === "job.heartbeat") {
      heartbeats += 1;
      continue;
    }
    if (event.type === "job.progress") {
      progressEvents += 1;
      const result = asRecord(event.result);
      summary = asString(result?.summary) ?? summary;
      tokensUsed = asNumber(result?.tokensUsed) ?? tokensUsed;
      continue;
    }
    if (event.type === "job.completed") {
      const result = asRecord(event.result);
      summary = asString(result?.summary) ?? summary;
      tokensUsed = asNumber(result?.tokensUsed) ?? tokensUsed;
    }
  }
  const terminalTs = chain.at(-1)?.ts;
  return {
    stream,
    jobId: job.id,
    agentId: job.agentId,
    lane: job.lane,
    payloadKind: asString(job.payload.kind),
    payloadObjectiveId: asString(job.payload.objectiveId),
    payloadTaskId: asString(job.payload.taskId),
    payloadCandidateId: asString(job.payload.candidateId),
    payloadRunId: asString(job.payload.runId) ?? asString(job.payload.parentRunId),
    sessionKey: job.sessionKey,
    singletonMode: job.singletonMode,
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    receiptCount: chain.length,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    durationMs: typeof terminalTs === "number" ? Math.max(0, terminalTs - job.createdAt) : undefined,
    progressEvents,
    heartbeats,
    retryCount: Math.max(0, job.attempt - 1),
    abortRequested: Boolean(job.abortRequested),
    lastError: job.lastError,
    canceledReason: job.canceledReason,
    summary: truncateInline(summary ?? job.lastError ?? job.canceledReason),
    tokensUsed,
    commands: job.commands.map((command) => ({
      commandId: command.id,
      command: command.command,
      by: command.by,
      createdAt: command.createdAt,
      consumedAt: command.consumedAt,
    })),
  };
};

const readRelatedJobs = async (
  dataDir: string,
  objectiveId: string,
  knownJobIds: ReadonlySet<string>,
): Promise<ReadonlyArray<JobAnalysis>> => {
  const store = jsonlStore<JobEvent>(dataDir);
  const jobStreams = store.listStreams ? await store.listStreams("jobs/") : [];
  const related = new Set<string>();
  for (const stream of jobStreams) {
    const jobId = stream.replace(/^jobs\//, "");
    if (knownJobIds.has(jobId) || stream.includes(objectiveId)) {
      related.add(stream);
      continue;
    }
    const head = await store.take(stream, 1);
    const first = head[0]?.body;
    if (!first || first.type !== "job.enqueued") continue;
    const payload = asRecord(first.payload);
    const matchesObjective = asString(payload?.objectiveId) === objectiveId;
    const matchesStream = [
      asString(payload?.stream),
      asString(payload?.runStream),
      asString(payload?.parentStream),
      first.sessionKey,
    ].some((value) => value?.includes(objectiveId));
    if (matchesObjective || matchesStream) related.add(stream);
  }
  const analyses: JobAnalysis[] = [];
  for (const stream of [...related].sort((left, right) => left.localeCompare(right))) {
    const analysis = await readJobAnalysis(dataDir, stream);
    if (analysis) analyses.push(analysis);
  }
  return analyses.sort((left, right) => left.createdAt - right.createdAt || left.jobId.localeCompare(right.jobId));
};

const buildAgentRunAnalysis = (
  stream: string,
  objectiveId: string,
  chain: ReadonlyArray<Receipt<AgentEvent>>,
): AgentRunAnalysis | undefined => {
  if (chain.length === 0) return undefined;
  const state = fold(chain, reduceAgent, initialAgent);
  const runId = state.runId || asString(chain[0]?.body.runId);
  if (!runId) return undefined;
  const toolMetrics = new Map<string, ToolMetricAccumulator>();
  const toolTransitions = new Map<string, number>();
  const boundObjectiveIds = new Set<string>();
  const configuredObjectiveIds = new Set<string>();
  const errors: AgentRunError[] = [];
  let startupObjectiveId: string | undefined;
  let latestBoundObjectiveId: string | undefined;
  let model: string | undefined;
  let profileId: string | undefined;
  let iterations = 0;
  let actionPlans = 0;
  let thoughts = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let memorySlices = 0;
  let memoryChars = 0;
  let validationsOk = 0;
  let validationsFailed = 0;
  let contextPrunes = 0;
  let contextCompactions = 0;
  let overflowRecoveries = 0;
  let delegated = 0;
  let mergedSubagents = 0;
  let continuations = 0;
  let maxContinuationDepth = 0;
  let previousTool: string | undefined;

  for (const receipt of chain) {
    const event = receipt.body;
    switch (event.type) {
      case "run.configured": {
        model = event.model;
        const extra = asRecord(event.config.extra);
        profileId = asString(extra?.profileId) ?? profileId;
        const configuredObjectiveId = asString(extra?.objectiveId);
        if (configuredObjectiveId) configuredObjectiveIds.add(configuredObjectiveId);
        break;
      }
      case "iteration.started":
        iterations = Math.max(iterations, event.iteration);
        break;
      case "thought.logged":
        thoughts += 1;
        break;
      case "action.planned":
        actionPlans += 1;
        break;
      case "tool.called": {
        toolCalls += 1;
        const current = toolMetrics.get(event.tool) ?? {
          count: 0,
          errorCount: 0,
          observedCount: 0,
          truncatedObservations: 0,
          totalDurationMs: 0,
        };
        current.count += 1;
        current.totalDurationMs += Math.max(0, event.durationMs ?? 0);
        if (event.error) {
          current.errorCount += 1;
          toolErrors += 1;
          errors.push({
            at: receipt.ts,
            kind: "tool",
            tool: event.tool,
            summary: truncateInline(event.error, 220) ?? "tool error",
          });
        }
        toolMetrics.set(event.tool, current);
        if (previousTool) increment(toolTransitions, `${previousTool}\u0000${event.tool}`);
        previousTool = event.tool;
        break;
      }
      case "tool.observed": {
        const current = toolMetrics.get(event.tool) ?? {
          count: 0,
          errorCount: 0,
          observedCount: 0,
          truncatedObservations: 0,
          totalDurationMs: 0,
        };
        current.observedCount += 1;
        if (event.truncated) current.truncatedObservations += 1;
        toolMetrics.set(event.tool, current);
        break;
      }
      case "memory.slice":
        memorySlices += 1;
        memoryChars += event.chars;
        break;
      case "validation.report":
        if (event.ok) validationsOk += 1;
        else {
          validationsFailed += 1;
          errors.push({
            at: receipt.ts,
            kind: "validation",
            summary: truncateInline(event.summary, 220) ?? "validation failed",
            tool: event.evidence?.tool,
          });
        }
        break;
      case "context.pruned":
        contextPrunes += 1;
        break;
      case "context.compacted":
        contextCompactions += 1;
        break;
      case "overflow.recovered":
        overflowRecoveries += 1;
        break;
      case "agent.delegated":
        delegated += 1;
        break;
      case "subagent.merged":
        mergedSubagents += 1;
        break;
      case "failure.report":
        errors.push({
          at: receipt.ts,
          kind: "failure",
          tool: event.failure.tool,
          summary: truncateInline(event.failure.message, 220) ?? "failure",
        });
        break;
      case "thread.bound":
        boundObjectiveIds.add(event.objectiveId);
        if (event.reason === "startup" && !startupObjectiveId) startupObjectiveId = event.objectiveId;
        latestBoundObjectiveId = event.objectiveId;
        break;
      case "run.continued":
        continuations += 1;
        maxContinuationDepth = Math.max(maxContinuationDepth, event.continuationDepth);
        break;
      default:
        break;
    }
  }

  const mismatchedObjectiveIds = [...new Set([
    ...configuredObjectiveIds,
    ...boundObjectiveIds,
  ])].filter((candidate) => candidate !== objectiveId);

  return {
    stream,
    runId,
    problem: state.problem,
    status: state.status,
    model,
    profileId,
    configuredObjectiveId: [...configuredObjectiveIds][0],
    startupObjectiveId,
    latestBoundObjectiveId,
    boundObjectiveIds: [...boundObjectiveIds],
    mismatchedObjectiveIds,
    receiptCount: chain.length,
    createdAt: chain[0]!.ts,
    updatedAt: chain.at(-1)!.ts,
    durationMs: Math.max(0, chain.at(-1)!.ts - chain[0]!.ts),
    iterations,
    actionPlans,
    thoughts,
    toolCalls,
    toolErrors,
    memorySlices,
    memoryChars,
    validationsOk,
    validationsFailed,
    contextPrunes,
    contextCompactions,
    overflowRecoveries,
    delegated,
    mergedSubagents,
    continuations,
    maxContinuationDepth,
    finalResponsePreview: truncateInline(state.finalResponse, 220),
    topTools: sortToolMetrics(toolMetrics),
    toolTransitions: sortToolTransitions(toolTransitions),
    errors,
  };
};

const readRelatedAgentRuns = async (
  dataDir: string,
  objectiveId: string,
): Promise<ReadonlyArray<AgentRunAnalysis>> => {
  const store = jsonlStore<AgentEvent>(dataDir);
  const streams = store.listStreams ? await store.listStreams("agents/") : [];
  const runStreams = streams.filter((stream) => stream.includes(`/objectives/${objectiveId}/runs/`));
  const analyses: AgentRunAnalysis[] = [];
  if (runStreams.length > 0) {
    for (const stream of runStreams.sort((left, right) => left.localeCompare(right))) {
      const chain = await store.read(stream);
      const analysis = buildAgentRunAnalysis(stream, objectiveId, chain);
      if (analysis) analyses.push(analysis);
    }
    return analyses.sort((left, right) => left.createdAt - right.createdAt || left.runId.localeCompare(right.runId));
  }

  const aggregateStreams = streams.filter((stream) => stream.includes(`/objectives/${objectiveId}`));
  for (const stream of aggregateStreams.sort((left, right) => left.localeCompare(right))) {
    const chain = await store.read(stream);
    const runChains = new Map<string, Array<Receipt<AgentEvent>>>();
    for (const receipt of chain) {
      const runId = asString(receipt.body.runId);
      if (!runId) continue;
      const bucket = runChains.get(runId) ?? [];
      bucket.push(receipt);
      runChains.set(runId, bucket);
    }
    for (const [runId, runChain] of [...runChains.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
      const analysis = buildAgentRunAnalysis(`${stream}/runs/${runId}`, objectiveId, runChain);
      if (analysis) analyses.push(analysis);
    }
  }
  return analyses.sort((left, right) => left.createdAt - right.createdAt || left.runId.localeCompare(right.runId));
};

const severityRank: Record<AnalysisSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const addAnomaly = (items: AnalysisAnomaly[], anomaly: AnalysisAnomaly): void => {
  items.push(anomaly);
};

const buildRecommendations = (anomalies: ReadonlyArray<AnalysisAnomaly>): ReadonlyArray<string> => {
  const recommendations = new Set<string>();
  for (const anomaly of anomalies) {
    if (anomaly.kind === "tool_error" && anomaly.summary.includes("factory.output requires focusKind/focusId")) {
      recommendations.add("When inspecting a multi-task objective, do not call `factory.output` with only `objectiveId`. Pass `taskId`, `jobId`, or both `focusKind` and `focusId`.");
    }
    if (anomaly.summary.includes("/usr/src/cli.ts")) {
      recommendations.add("Stop assuming `/usr/src/cli.ts` exists inside worker containers. Resolve the checked-in Receipt entrypoint from the mounted workspace or use the direct AWS CLI path already present in the task prompt.");
    }
    if (anomaly.kind === "repeated_control_job") {
      recommendations.add("Deduplicate `factory.objective.control` enqueues for the same objective session key, or switch the queue behavior so repeated reconcile attempts coalesce instead of piling up.");
    }
    if (anomaly.kind === "cross_objective_run") {
      recommendations.add("Reset objective-bound run routing when follow-up objectives are created. A run stream under one objective should not carry a different objective binding in `thread.bound` or `run.configured.extra.objectiveId`.");
    }
    if (anomaly.summary.includes("no tracked diff")) {
      recommendations.add("Before creating another task attempt, check whether the previous attempt already integrated the only diff. If nothing changed, surface a terminal 'already applied' outcome instead of a blocked rerun.");
    }
    if (anomaly.summary.includes("api.github.com") || anomaly.summary.toLowerCase().includes("publish failed")) {
      recommendations.add("Separate transient publish/network failures from integration conflicts in the UI. Report the publish job failure directly and preserve the already-integrated candidate state.");
    }
  }
  return [...recommendations];
};

export const readObjectiveAnalysis = async (
  dataDir: string,
  objectiveIdOrStream: string,
): Promise<ObjectiveAnalysis> => {
  const { objectiveId, stream } = objectiveReplayStream(objectiveIdOrStream);
  const objectiveChain = await jsonlStore<FactoryEvent>(dataDir).read(stream);
  if (objectiveChain.length === 0) {
    throw new Error(`No receipts found for ${stream}`);
  }

  const state = fold(objectiveChain, reduceFactory, initialFactoryState);
  const projection = buildFactoryProjection(state);
  const { sequence, eventCounts, maxObservedActiveTasks, knownJobIds } = buildObjectiveSequence(objectiveChain);
  const tasks = projection.tasks.map(buildTaskAnalysis);
  const candidates = projection.candidates.map(buildCandidateAnalysis);
  const [jobs, agentRuns] = await Promise.all([
    readRelatedJobs(dataDir, objectiveId, knownJobIds),
    readRelatedAgentRuns(dataDir, objectiveId),
  ]);

  const taskStatusCounts = new Map<string, number>();
  const candidateStatusCounts = new Map<string, number>();
  const jobStatusCounts = new Map<string, number>();
  const aggregateTools = new Map<string, ToolMetricAccumulator>();
  const aggregateTransitions = new Map<string, number>();
  const models = new Set<string>();

  for (const task of tasks) increment(taskStatusCounts, task.status);
  for (const candidate of candidates) increment(candidateStatusCounts, candidate.status);
  for (const job of jobs) increment(jobStatusCounts, job.status);
  for (const run of agentRuns) {
    if (run.model) models.add(run.model);
    for (const tool of run.topTools) {
      const current = aggregateTools.get(tool.tool) ?? {
        count: 0,
        errorCount: 0,
        observedCount: 0,
        truncatedObservations: 0,
        totalDurationMs: 0,
      };
      current.count += tool.count;
      current.errorCount += tool.errorCount;
      current.observedCount += tool.observedCount;
      current.truncatedObservations += tool.truncatedObservations;
      current.totalDurationMs += tool.totalDurationMs;
      aggregateTools.set(tool.tool, current);
    }
    for (const transition of run.toolTransitions) {
      increment(aggregateTransitions, `${transition.fromTool}\u0000${transition.toTool}`, transition.count);
    }
  }

  const anomalies: AnalysisAnomaly[] = [];
  for (const receipt of objectiveChain) {
    const event = receipt.body;
    if (event.type === "task.blocked") {
      addAnomaly(anomalies, {
        kind: "task_blocked",
        severity: event.reason.includes("Module not found") ? "high" : "medium",
        summary: `${event.taskId}: ${truncateInline(event.reason, 220)}`,
        at: receipt.ts,
        taskId: event.taskId,
      });
    }
    if (event.type === "objective.blocked") {
      addAnomaly(anomalies, {
        kind: "objective_blocked",
        severity: "high",
        summary: truncateInline(`${event.reason} — ${event.summary}`, 220) ?? event.reason,
        at: receipt.ts,
      });
    }
    if (event.type === "integration.conflicted") {
      addAnomaly(anomalies, {
        kind: "integration_conflicted",
        severity: "high",
        summary: truncateInline(event.reason, 220) ?? "integration conflicted",
        at: receipt.ts,
        candidateId: event.candidateId,
      });
    }
    if (event.type === "candidate.reviewed" && event.status !== "approved") {
      addAnomaly(anomalies, {
        kind: "candidate_review",
        severity: event.status === "rejected" ? "high" : "medium",
        summary: `${event.candidateId}: ${truncateInline(event.summary, 220)}`,
        at: receipt.ts,
        taskId: event.taskId,
        candidateId: event.candidateId,
      });
    }
  }

  for (const job of jobs) {
    if (job.status === "failed") {
      addAnomaly(anomalies, {
        kind: "job_failed",
        severity: "high",
        summary: `${job.jobId}: ${truncateInline(job.lastError ?? job.summary ?? "job failed", 220)}`,
        at: job.updatedAt,
        jobId: job.jobId,
      });
    }
    if (job.status === "canceled") {
      addAnomaly(anomalies, {
        kind: "job_canceled",
        severity: job.abortRequested ? "medium" : "low",
        summary: `${job.jobId}: ${truncateInline(job.canceledReason ?? job.summary ?? "job canceled", 220)}`,
        at: job.updatedAt,
        jobId: job.jobId,
      });
    }
    for (const command of job.commands) {
      if (command.command === "abort") {
        addAnomaly(anomalies, {
          kind: "job_abort_command",
          severity: "medium",
          summary: `${job.jobId}: abort requested`,
          at: command.createdAt,
          jobId: job.jobId,
        });
      }
    }
  }

  const controlJobsBySession = new Map<string, number>();
  for (const job of jobs) {
    if (job.payloadKind === "factory.objective.control" && job.sessionKey) {
      increment(controlJobsBySession, job.sessionKey);
    }
  }
  for (const [sessionKey, count] of controlJobsBySession.entries()) {
    if (count > 1) {
      addAnomaly(anomalies, {
        kind: "repeated_control_job",
        severity: "medium",
        summary: `${count} control jobs used session ${sessionKey}`,
      });
    }
  }

  for (const run of agentRuns) {
    for (const error of run.errors) {
      addAnomaly(anomalies, {
        kind: error.kind === "tool" ? "tool_error" : error.kind === "validation" ? "validation_failure" : "run_failure",
        severity: error.kind === "failure" ? "high" : "medium",
        summary: `${run.runId}${error.tool ? ` ${error.tool}` : ""}: ${error.summary}`,
        at: error.at,
        runId: run.runId,
        stream: run.stream,
      });
    }
    if (run.contextCompactions > 0) {
      addAnomaly(anomalies, {
        kind: "context_compaction",
        severity: "low",
        summary: `${run.runId}: context compacted ${run.contextCompactions} time(s)`,
        runId: run.runId,
        stream: run.stream,
      });
    }
    if (run.overflowRecoveries > 0) {
      addAnomaly(anomalies, {
        kind: "overflow_recovery",
        severity: "medium",
        summary: `${run.runId}: recovered from context overflow ${run.overflowRecoveries} time(s)`,
        runId: run.runId,
        stream: run.stream,
      });
    }
    if (run.mismatchedObjectiveIds.length > 0) {
      addAnomaly(anomalies, {
        kind: "cross_objective_run",
        severity: "high",
        summary: `${run.runId}: run stream for ${objectiveId} carried objective ${run.mismatchedObjectiveIds.join(", ")}`,
        runId: run.runId,
        stream: run.stream,
      });
    }
  }

  const sortedAnomalies = [...anomalies].sort((left, right) =>
    severityRank[left.severity] - severityRank[right.severity]
    || (left.at ?? Number.MAX_SAFE_INTEGER) - (right.at ?? Number.MAX_SAFE_INTEGER)
    || left.summary.localeCompare(right.summary));

  const taskRunDurations = tasks
    .map((task) => task.runDurationMs)
    .filter((value): value is number => typeof value === "number");
  const taskTotalDurations = tasks
    .map((task) => task.totalDurationMs)
    .filter((value): value is number => typeof value === "number");

  return {
    objectiveId,
    stream,
    title: state.title,
    status: projection.status,
    objectiveMode: state.objectiveMode,
    severity: state.severity,
    profile: {
      rootProfileId: state.profile.rootProfileId,
      rootProfileLabel: state.profile.rootProfileLabel,
      selectedSkills: state.profile.selectedSkills,
    },
    policy: state.policy,
    receiptCount: objectiveChain.length,
    createdAt: state.createdAt,
    updatedAt: projection.updatedAt,
    durationMs: Math.max(0, projection.updatedAt - state.createdAt),
    latestSummary: projection.latestSummary,
    blockedReason: projection.blockedReason,
    sequence,
    tasks,
    candidates,
    jobs,
    agentRuns,
    metrics: {
      objective: {
        receipts: objectiveChain.length,
        durationMs: Math.max(0, projection.updatedAt - state.createdAt),
        operatorNotes: eventCounts["objective.operator.noted"] ?? 0,
        dispatches: eventCounts["task.dispatched"] ?? 0,
        rebrackets: eventCounts["rebracket.applied"] ?? 0,
        taskRunsUsed: state.taskRunsUsed,
        maxObservedActiveTasks,
        concurrencyLimit: state.policy.concurrency.maxActiveTasks,
        candidatePassesByTask: state.candidatePassesByTask,
        eventCounts,
      },
      tasks: {
        total: tasks.length,
        byStatus: countsToObject(taskStatusCounts),
        avgRunDurationMs: average(taskRunDurations),
        avgTotalDurationMs: average(taskTotalDurations),
      },
      candidates: {
        total: candidates.length,
        byStatus: countsToObject(candidateStatusCounts),
        totalTokensUsed: candidates.reduce((sum, candidate) => sum + (candidate.tokensUsed ?? 0), 0),
      },
      jobs: {
        total: jobs.length,
        byStatus: countsToObject(jobStatusCounts),
        failed: jobs.filter((job) => job.status === "failed").length,
        canceled: jobs.filter((job) => job.status === "canceled").length,
        retrying: jobs.filter((job) => job.retryCount > 0).length,
        abortCommands: jobs.reduce((sum, job) => sum + job.commands.filter((command) => command.command === "abort").length, 0),
        controlJobs: jobs.filter((job) => job.payloadKind === "factory.objective.control").length,
        totalTokensUsed: jobs.reduce((sum, job) => sum + (job.tokensUsed ?? 0), 0),
      },
      agent: {
        runCount: agentRuns.length,
        completedRuns: agentRuns.filter((run) => run.status === "completed").length,
        continuations: agentRuns.reduce((sum, run) => sum + run.continuations, 0),
        maxContinuationDepth: agentRuns.reduce((max, run) => Math.max(max, run.maxContinuationDepth), 0),
        toolCalls: agentRuns.reduce((sum, run) => sum + run.toolCalls, 0),
        toolErrors: agentRuns.reduce((sum, run) => sum + run.toolErrors, 0),
        actionPlans: agentRuns.reduce((sum, run) => sum + run.actionPlans, 0),
        thoughts: agentRuns.reduce((sum, run) => sum + run.thoughts, 0),
        memorySlices: agentRuns.reduce((sum, run) => sum + run.memorySlices, 0),
        memoryChars: agentRuns.reduce((sum, run) => sum + run.memoryChars, 0),
        validationsOk: agentRuns.reduce((sum, run) => sum + run.validationsOk, 0),
        validationsFailed: agentRuns.reduce((sum, run) => sum + run.validationsFailed, 0),
        contextPrunes: agentRuns.reduce((sum, run) => sum + run.contextPrunes, 0),
        contextCompactions: agentRuns.reduce((sum, run) => sum + run.contextCompactions, 0),
        overflowRecoveries: agentRuns.reduce((sum, run) => sum + run.overflowRecoveries, 0),
        delegated: agentRuns.reduce((sum, run) => sum + run.delegated, 0),
        mergedSubagents: agentRuns.reduce((sum, run) => sum + run.mergedSubagents, 0),
        mismatchedRuns: agentRuns.filter((run) => run.mismatchedObjectiveIds.length > 0).length,
        models: [...models].sort((left, right) => left.localeCompare(right)),
        topTools: sortToolMetrics(aggregateTools),
        topTransitions: sortToolTransitions(aggregateTransitions),
      },
    },
    anomalies: sortedAnomalies,
    recommendations: buildRecommendations(sortedAnomalies),
  };
};

export const renderObjectiveAnalysisText = (analysis: ObjectiveAnalysis): string => {
  const lines = [
    `${analysis.objectiveId} (${analysis.status})`,
    analysis.title,
    `Mode: ${analysis.objectiveMode} · Severity: ${analysis.severity} · Profile: ${analysis.profile.rootProfileId}`,
    `Receipts: ${analysis.receiptCount} · Duration: ${formatDurationMs(analysis.durationMs)} · Active tasks: ${analysis.metrics.objective.maxObservedActiveTasks}/${analysis.metrics.objective.concurrencyLimit}`,
    analysis.latestSummary ? `Summary: ${truncateInline(analysis.latestSummary, 240)}` : undefined,
    analysis.blockedReason ? `Blocked: ${truncateInline(analysis.blockedReason, 240)}` : undefined,
    "",
    "Metrics:",
    `- Tasks: ${analysis.metrics.tasks.total} total · dispatches ${analysis.metrics.objective.dispatches} · approved ${analysis.metrics.tasks.byStatus.approved ?? 0} · blocked ${analysis.metrics.tasks.byStatus.blocked ?? 0} · superseded ${analysis.metrics.tasks.byStatus.superseded ?? 0}`,
    `- Jobs: ${analysis.metrics.jobs.total} total · completed ${analysis.metrics.jobs.byStatus.completed ?? 0} · failed ${analysis.metrics.jobs.failed} · canceled ${analysis.metrics.jobs.canceled} · abort commands ${analysis.metrics.jobs.abortCommands}`,
    `- Agent: ${analysis.metrics.agent.runCount} runs · continuations ${analysis.metrics.agent.continuations} · tool calls ${analysis.metrics.agent.toolCalls} · tool errors ${analysis.metrics.agent.toolErrors} · memory slices ${analysis.metrics.agent.memorySlices}`,
    analysis.metrics.agent.models.length > 0 ? `- Models: ${analysis.metrics.agent.models.join(", ")}` : undefined,
    "",
    "Anomalies:",
    ...(analysis.anomalies.length > 0
      ? analysis.anomalies.slice(0, 12).map((anomaly) =>
          `- [${anomaly.severity}] ${anomaly.summary}${anomaly.at ? ` · ${formatTimestamp(anomaly.at)}` : ""}`)
      : ["- none"]),
    "",
    "Recommendations:",
    ...(analysis.recommendations.length > 0
      ? analysis.recommendations.map((recommendation) => `- ${recommendation}`)
      : ["- none"]),
    "",
    "Top Tools:",
    ...(analysis.metrics.agent.topTools.length > 0
      ? analysis.metrics.agent.topTools.slice(0, 8).map((tool) =>
          `- ${tool.tool}: ${tool.count} calls · errors ${tool.errorCount} · avg ${formatDurationMs(tool.avgDurationMs)}`)
      : ["- none"]),
    "",
    "Top Tool Transitions:",
    ...(analysis.metrics.agent.topTransitions.length > 0
      ? analysis.metrics.agent.topTransitions.slice(0, 8).map((transition) =>
          `- ${transition.fromTool} -> ${transition.toTool}: ${transition.count}`)
      : ["- none"]),
    "",
    "Runs:",
    ...(analysis.agentRuns.length > 0
      ? analysis.agentRuns.map((run) =>
          `- ${run.runId} · ${run.status} · iter ${run.iterations} · tools ${run.toolCalls} · errors ${run.toolErrors}${run.mismatchedObjectiveIds.length > 0 ? ` · mismatch ${run.mismatchedObjectiveIds.join(", ")}` : ""}`)
      : ["- none"]),
    "",
    "Objective Sequence:",
    ...analysis.sequence.map((item) => `- ${formatTimestamp(item.at)} · ${item.summary}`),
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
};
