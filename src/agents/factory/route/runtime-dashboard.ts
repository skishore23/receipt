import { gte, max, sql } from "drizzle-orm";

import type { AgentLoaderContext } from "../../../framework/agent-types";
import type { Runtime } from "@receipt/core/runtime";
import { agentRunStream } from "../../agent.streams";
import type { AgentCmd, AgentEvent, AgentState } from "../../../modules/agent";
import type { QueueJob } from "../../../adapters/jsonl-queue";
import type { FactoryService } from "../../../services/factory-service";
import { getReceiptDb } from "../../../db/client";
import * as receiptSchema from "../../../db/schema";
import { toneForValue } from "../../../views/ui";
import type { RuntimeDashboardModel } from "../../../views/runtime";
import { projectAgentRun } from "../run-projection";
import {
  asString,
  compareJobsByRecency,
  displayJobStatus,
  displayJobUpdatedAt,
  isActiveJobStatus,
  jobObjectiveId,
  jobParentRunId,
  jobRunId,
} from "../shared";
import { summarizeJob } from "../live-jobs";

const RUNTIME_JOB_WINDOW = 200;
const RUNTIME_OBJECTIVE_LIMIT = 10;
const RUNTIME_JOB_LIMIT = 12;
const RUNTIME_RUN_LIMIT = 10;
const RUNTIME_ACTIVITY_LIMIT = 12;
const RUNTIME_RECEIPT_WINDOW_MINUTES = 5;
const TERMINAL_OBJECTIVE_STATUSES = new Set(["completed", "blocked", "failed", "canceled"]);

const isActiveObjectiveStatus = (status: string | undefined): boolean =>
  typeof status === "string" && !TERMINAL_OBJECTIVE_STATUSES.has(status);

export const createRuntimeDashboardLoader = (input: {
  readonly ctx: AgentLoaderContext;
  readonly service: FactoryService;
  readonly agentRuntime: Runtime<AgentCmd, AgentEvent, AgentState>;
  readonly loadRecentJobs: (limit?: number) => Promise<ReadonlyArray<QueueJob>>;
}) => async (): Promise<RuntimeDashboardModel> => {
  type RuntimeRunBundle = {
    readonly card: RuntimeDashboardModel["runs"][number];
    readonly mergedChildRunCount: number;
    readonly recentToolNames: ReadonlyArray<string>;
  };

  const [recentJobs, objectives] = await Promise.all([
    input.loadRecentJobs(RUNTIME_JOB_WINDOW),
    input.service.listObjectives(),
  ]);
  const receiptDb = getReceiptDb(input.ctx.dataDir);
  const receiptWindowStart = Date.now() - (RUNTIME_RECEIPT_WINDOW_MINUTES * 60_000);

  const queueSnapshot = typeof (input.ctx.queue as { readonly snapshot?: unknown }).snapshot === "function"
    ? ((input.ctx.queue as { readonly snapshot: () => {
        readonly total: number;
        readonly queued: number;
        readonly leased: number;
        readonly running: number;
        readonly completed: number;
        readonly failed: number;
        readonly canceled: number;
        readonly updatedAt?: number;
      } }).snapshot())
    : undefined;
  const streamsCounts = receiptDb.orm.select({
    count: sql<number>`count(*)`,
    updatedAt: max(receiptSchema.streams.updatedAt),
  }).from(receiptSchema.streams).get();
  const receiptsCounts = receiptDb.orm.select({
    count: sql<number>`count(*)`,
    updatedAt: max(receiptSchema.receipts.ts),
  }).from(receiptSchema.receipts).get();
  const changeCounts = receiptDb.orm.select({
    count: sql<number>`count(*)`,
    updatedAt: max(receiptSchema.changeLog.changedAt),
  }).from(receiptSchema.changeLog).get();
  const jobProjectionCounts = receiptDb.orm.select({
    count: sql<number>`count(*)`,
    updatedAt: max(receiptSchema.jobProjection.updatedAt),
  }).from(receiptSchema.jobProjection).get();
  const objectiveProjectionCounts = receiptDb.orm.select({
    count: sql<number>`count(*)`,
    updatedAt: max(receiptSchema.objectiveProjection.updatedAt),
  }).from(receiptSchema.objectiveProjection).get();
  const chatProjectionCounts = receiptDb.orm.select({
    count: sql<number>`count(*)`,
    updatedAt: max(receiptSchema.chatContextProjection.updatedAt),
  }).from(receiptSchema.chatContextProjection).get();
  const memoryEntryCounts = receiptDb.orm.select({
    count: sql<number>`count(*)`,
    updatedAt: max(receiptSchema.memoryEntries.ts),
  }).from(receiptSchema.memoryEntries).get();
  const branchCounts = receiptDb.orm.select({
    count: sql<number>`count(*)`,
    updatedAt: max(receiptSchema.branches.createdAt),
  }).from(receiptSchema.branches).get();
  const dbCounts = {
    streams_count: streamsCounts?.count ?? 0,
    streams_updated_at: streamsCounts?.updatedAt ?? null,
    receipts_count: receiptsCounts?.count ?? 0,
    receipts_updated_at: receiptsCounts?.updatedAt ?? null,
    change_count: changeCounts?.count ?? 0,
    change_updated_at: changeCounts?.updatedAt ?? null,
    job_projection_count: jobProjectionCounts?.count ?? 0,
    job_projection_updated_at: jobProjectionCounts?.updatedAt ?? null,
    objective_projection_count: objectiveProjectionCounts?.count ?? 0,
    objective_projection_updated_at: objectiveProjectionCounts?.updatedAt ?? null,
    chat_projection_count: chatProjectionCounts?.count ?? 0,
    chat_projection_updated_at: chatProjectionCounts?.updatedAt ?? null,
    memory_entry_count: memoryEntryCounts?.count ?? 0,
    memory_entry_updated_at: memoryEntryCounts?.updatedAt ?? null,
    branch_count: branchCounts?.count ?? 0,
    branch_updated_at: branchCounts?.updatedAt ?? null,
  } satisfies {
    readonly streams_count?: number | null;
    readonly streams_updated_at?: number | null;
    readonly receipts_count?: number | null;
    readonly receipts_updated_at?: number | null;
    readonly change_count?: number | null;
    readonly change_updated_at?: number | null;
    readonly job_projection_count?: number | null;
    readonly job_projection_updated_at?: number | null;
    readonly objective_projection_count?: number | null;
    readonly objective_projection_updated_at?: number | null;
    readonly chat_projection_count?: number | null;
    readonly chat_projection_updated_at?: number | null;
    readonly memory_entry_count?: number | null;
    readonly memory_entry_updated_at?: number | null;
    readonly branch_count?: number | null;
    readonly branch_updated_at?: number | null;
  };
  const recentReceiptRow = receiptDb.orm.select({
    recent_receipt_count: sql<number>`count(*)`,
    recent_receipt_updated_at: max(receiptSchema.changeLog.changedAt),
  })
    .from(receiptSchema.changeLog)
    .where(gte(receiptSchema.changeLog.changedAt, receiptWindowStart))
    .get() as {
      readonly recent_receipt_count?: number | null;
      readonly recent_receipt_updated_at?: number | null;
    } | undefined;

  const runCandidates = new Map<string, { readonly runId: string; readonly stream: string; readonly job: QueueJob }>();
  for (const job of recentJobs) {
    const stream = asString(job.payload.stream) ?? asString(job.payload.parentStream);
    const runId = jobRunId(job) ?? jobParentRunId(job);
    if (!stream || !runId) continue;
    const key = `${stream}::${runId}`;
    const existing = runCandidates.get(key);
    if (!existing || compareJobsByRecency(job, existing.job) < 0) {
      runCandidates.set(key, { runId, stream, job });
    }
  }

  const runResults: ReadonlyArray<RuntimeRunBundle | undefined> = await Promise.all(
    [...runCandidates.values()]
      .sort((left, right) => compareJobsByRecency(left.job, right.job))
      .slice(0, RUNTIME_RUN_LIMIT)
      .map(async ({ runId, stream, job }): Promise<RuntimeRunBundle | undefined> => {
        const chain = await input.agentRuntime.chain(agentRunStream(stream, runId)).catch(() => []);
        if (chain.length === 0) return undefined;
        const projection = projectAgentRun(chain);
        const lastReceipt = chain[chain.length - 1];
        const rawLastToolBody = [...chain]
          .reverse()
          .find((receipt) => receipt.body.type === "tool.called")
          ?.body;
        const lastToolCall =
          rawLastToolBody !== undefined && rawLastToolBody.type === "tool.called"
            ? rawLastToolBody
            : undefined;
        const toolCount = chain.reduce((count, receipt) => count + (receipt.body.type === "tool.called" ? 1 : 0), 0);
        const mergedChildRunCount = chain.reduce((count, receipt) => count + (receipt.body.type === "subagent.merged" ? 1 : 0), 0);
        const recentToolNames = [...new Set(
          [...chain]
            .reverse()
            .flatMap((receipt) => receipt.body.type === "tool.called" ? [receipt.body.tool] : [])
        )].slice(0, 5);
        const summary = projection.state.statusNote
          ?? projection.state.lastTool?.summary
          ?? lastToolCall?.summary
          ?? projection.final?.content
          ?? projection.problem?.problem
          ?? "Run has live receipt activity.";
        const runStatus: string =
          projection.state.status === "idle" ? job.status : projection.state.status;
        return {
          card: {
            runId,
            stream,
            status: runStatus,
            objectiveId: projection.state.thread?.objectiveId ?? jobObjectiveId(job),
            iteration: projection.state.iteration,
            toolCount,
            lastTool: projection.state.lastTool?.name ?? lastToolCall?.tool,
            updatedAt: lastReceipt?.ts ?? job.updatedAt,
            worker: projection.state.profile?.profileId ?? job.agentId,
            problem: projection.problem?.problem,
            summary,
          } satisfies RuntimeDashboardModel["runs"][number],
          mergedChildRunCount,
          recentToolNames,
        };
      }),
  );
  const runBundles: ReadonlyArray<RuntimeRunBundle> = runResults.flatMap((item) =>
    item === undefined ? [] : [item],
  );
  const runCards: ReadonlyArray<RuntimeDashboardModel["runs"][number]> = runBundles
    .map((bundle) => bundle.card)
    .sort((left, right) =>
      (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      || right.runId.localeCompare(left.runId)
    );

  const objectiveCards = objectives
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, RUNTIME_OBJECTIVE_LIMIT)
    .map((objective) => ({
      objectiveId: objective.objectiveId,
      title: objective.title,
      status: objective.status,
      phase: objective.phase,
      scheduler: objective.scheduler.slotState,
      integrationStatus: objective.integrationStatus,
      activeTaskCount: objective.activeTaskCount,
      readyTaskCount: objective.readyTaskCount,
      taskCount: objective.taskCount,
      profileId: objective.profile.rootProfileId,
      updatedAt: objective.latestDecision?.at ?? objective.updatedAt,
      summary: objective.latestDecision?.summary
        ?? objective.blockedReason
        ?? objective.nextAction
        ?? objective.latestSummary,
    }));

  const jobCards = recentJobs
    .slice()
    .sort(compareJobsByRecency)
    .slice(0, RUNTIME_JOB_LIMIT)
    .map((job) => ({
      jobId: job.id,
      agentId: job.agentId,
      lane: job.lane,
      kind: asString(job.payload.kind),
      status: displayJobStatus(job),
      objectiveId: jobObjectiveId(job),
      runId: jobRunId(job) ?? jobParentRunId(job),
      stream: asString(job.payload.stream) ?? asString(job.payload.parentStream),
      updatedAt: displayJobUpdatedAt(job),
      leaseUntil: job.leaseUntil,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      summary: summarizeJob(job),
    }));

  const activity = [
    ...objectiveCards.map((objective) => ({
      id: `objective:${objective.objectiveId}`,
      kind: "objective" as const,
      title: objective.title,
      summary: objective.summary ?? `${objective.activeTaskCount} active tasks.`,
      at: objective.updatedAt,
      tone: toneForValue(objective.status),
    })),
    ...jobCards.map((job) => ({
      id: `job:${job.jobId}`,
      kind: "job" as const,
      title: job.jobId,
      summary: job.summary,
      at: job.updatedAt,
      tone: toneForValue(job.status),
    })),
    ...runCards.map((run) => ({
      id: `run:${run.runId}`,
      kind: "run" as const,
      title: run.runId,
      summary: run.summary,
      at: run.updatedAt,
      tone: toneForValue(run.status),
    })),
  ]
    .sort((left, right) =>
      (right.at ?? 0) - (left.at ?? 0)
      || left.id.localeCompare(right.id)
    )
    .slice(0, RUNTIME_ACTIVITY_LIMIT);
  const visibleToolCallCount = runCards.reduce((count, run) => count + run.toolCount, 0);
  const mergedChildRunCount = runBundles.reduce((count, result) => count + result.mergedChildRunCount, 0);
  const recentToolNames = [...new Set(runBundles.flatMap((result) => result.recentToolNames))].slice(0, 5);
  const delegatedJobCount = recentJobs.filter((job) =>
    Boolean(asString(job.payload.parentRunId) ?? asString(job.payload.parentStream))
  ).length;
  const activeChildJobCount = recentJobs.filter((job) =>
    Boolean(asString(job.payload.parentRunId) ?? asString(job.payload.parentStream))
    && isActiveJobStatus(job.status)
  ).length;
  const latestLeaseUntil = recentJobs.reduce<number | undefined>((latest, job) => {
    if (typeof job.leaseUntil !== "number") return latest;
    if (typeof latest !== "number") return job.leaseUntil;
    return Math.max(latest, job.leaseUntil);
  }, undefined);
  const recentBackgroundJobCount = recentJobs.filter((job) => {
    const kind = asString(job.payload.kind);
    return Boolean(kind && kind !== "factory.run" && kind !== "factory.task.run");
  }).length;
  const stores = [
    {
      name: "streams",
      kind: "RECEIPT CATALOG",
      description: "Known receipt streams and current heads.",
      count: Number(dbCounts?.streams_count ?? 0),
      updatedAt: dbCounts?.streams_updated_at ?? undefined,
    },
    {
      name: "receipts",
      kind: "EVENT LOG",
      description: "Immutable runtime receipts across every stream.",
      count: Number(dbCounts?.receipts_count ?? 0),
      updatedAt: dbCounts?.receipts_updated_at ?? undefined,
    },
    {
      name: "change_log",
      kind: "CHANGE FEED",
      description: "Cross-stream receipt activity used for live refresh.",
      count: Number(dbCounts?.change_count ?? 0),
      updatedAt: dbCounts?.change_updated_at ?? undefined,
    },
    {
      name: "job_projection",
      kind: "QUEUE PROJECTION",
      description: "Materialized queue/job status for runtime control.",
      count: Number(dbCounts?.job_projection_count ?? 0),
      updatedAt: dbCounts?.job_projection_updated_at ?? undefined,
    },
    {
      name: "objective_projection",
      kind: "OBJECTIVE PROJECTION",
      description: "Current factory objective cards and workflow counts.",
      count: Number(dbCounts?.objective_projection_count ?? 0),
      updatedAt: dbCounts?.objective_projection_updated_at ?? undefined,
    },
    {
      name: "chat_context_projection",
      kind: "CHAT PROJECTION",
      description: "Bound chat/objective context for the factory shell.",
      count: Number(dbCounts?.chat_projection_count ?? 0),
      updatedAt: dbCounts?.chat_projection_updated_at ?? undefined,
    },
    {
      name: "memory_entries",
      kind: "MEMORY STORE",
      description: "Persisted memory slices and summaries.",
      count: Number(dbCounts?.memory_entry_count ?? 0),
      updatedAt: dbCounts?.memory_entry_updated_at ?? undefined,
    },
    {
      name: "branches",
      kind: "BRANCH GRAPH",
      description: "Forked receipt branches and ancestry metadata.",
      count: Number(dbCounts?.branch_count ?? 0),
      updatedAt: dbCounts?.branch_updated_at ?? undefined,
    },
  ] satisfies RuntimeDashboardModel["stores"];
  const activeObjectiveTitles = objectiveCards
    .filter((objective) => isActiveObjectiveStatus(objective.status))
    .map((objective) => objective.title)
    .slice(0, 3);
  const recentObjectiveTitles = objectiveCards.map((objective) => objective.title).slice(0, 3);

  const latestUpdateAt = [
    queueSnapshot?.updatedAt,
    dbCounts?.change_updated_at ?? undefined,
    recentReceiptRow?.recent_receipt_updated_at ?? undefined,
    ...objectiveCards.map((objective) => objective.updatedAt),
    ...jobCards.map((job) => job.updatedAt),
    ...runCards.map((run) => run.updatedAt),
  ].reduce<number | undefined>((latest, candidate) => {
    if (typeof candidate !== "number") return latest;
    if (typeof latest !== "number") return candidate;
    return Math.max(latest, candidate);
  }, undefined);

  return {
    generatedAt: Date.now(),
    queue: {
      total: queueSnapshot?.total ?? recentJobs.length,
      queued: queueSnapshot?.queued ?? recentJobs.filter((job) => job.status === "queued").length,
      leased: queueSnapshot?.leased ?? recentJobs.filter((job) => job.status === "leased").length,
      running: queueSnapshot?.running ?? recentJobs.filter((job) => job.status === "running").length,
      completed: queueSnapshot?.completed ?? recentJobs.filter((job) => job.status === "completed").length,
      failed: queueSnapshot?.failed ?? recentJobs.filter((job) => job.status === "failed").length,
      canceled: queueSnapshot?.canceled ?? recentJobs.filter((job) => job.status === "canceled").length,
      updatedAt: queueSnapshot?.updatedAt,
      approximate: !queueSnapshot,
      visibleJobs: recentJobs.length,
    },
    objectiveCount: objectives.length,
    activeObjectiveCount: objectives.filter((objective) => isActiveObjectiveStatus(objective.status)).length,
    liveRunCount: runCards.filter((run) => run.status === "running").length,
    latestUpdateAt,
    objectives: objectiveCards,
    jobs: jobCards,
    runs: runCards,
    activity,
    stores,
    metrics: {
      recentReceiptCount: Number(recentReceiptRow?.recent_receipt_count ?? 0),
      receiptWindowMinutes: RUNTIME_RECEIPT_WINDOW_MINUTES,
      jobProjectionCount: Number(dbCounts?.job_projection_count ?? 0),
      objectiveProjectionCount: Number(dbCounts?.objective_projection_count ?? 0),
      chatProjectionCount: Number(dbCounts?.chat_projection_count ?? 0),
      memoryEntryCount: Number(dbCounts?.memory_entry_count ?? 0),
      streamCount: Number(dbCounts?.streams_count ?? 0),
      receiptCount: Number(dbCounts?.receipts_count ?? 0),
      changeCount: Number(dbCounts?.change_count ?? 0),
      branchCount: Number(dbCounts?.branch_count ?? 0),
      recentBackgroundJobCount,
      visibleToolCallCount,
      delegatedJobCount,
      activeChildJobCount,
      mergedChildRunCount,
      latestLeaseUntil,
      activeObjectiveTitles: activeObjectiveTitles.length > 0 ? activeObjectiveTitles : recentObjectiveTitles,
      recentToolNames,
    },
  };
};
