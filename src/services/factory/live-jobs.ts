import type { QueueJob } from "../../adapters/jsonl-queue";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const LIVE_EXECUTION_JOB_KINDS = new Set([
  "factory.task.run",
  "factory.task.monitor",
  "factory.integration.validate",
  "factory.integration.publish",
]);

export const LIVE_JOB_STALE_AFTER_MS = 90_000;

export const isTerminalQueueJobStatus = (status?: string): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

export const isActiveQueueJobStatus = (status?: string): boolean =>
  status === "queued" || status === "leased" || status === "running";

export const isFactoryExecutionQueueJob = (job: Pick<QueueJob, "payload"> | undefined): boolean => {
  const payload = asRecord(job?.payload);
  return typeof payload?.kind === "string" && LIVE_EXECUTION_JOB_KINDS.has(payload.kind);
};

export const objectiveIdForLiveExecutionJob = (job: Pick<QueueJob, "payload"> | undefined): string | undefined => {
  if (!isFactoryExecutionQueueJob(job)) return undefined;
  const payload = asRecord(job?.payload);
  return typeof payload?.objectiveId === "string" && payload.objectiveId.trim().length > 0
    ? payload.objectiveId.trim()
    : undefined;
};

export const jobProgressAt = (job: Pick<QueueJob, "status" | "result"> | undefined): number | undefined => {
  const result = asRecord(job?.result);
  return typeof result?.progressAt === "number" && Number.isFinite(result.progressAt)
    ? result.progressAt
    : undefined;
};

export const liveJobFreshnessAt = (
  job: Pick<QueueJob, "payload" | "status" | "result" | "updatedAt" | "createdAt"> | undefined,
): number | undefined => {
  if (!job || !isActiveQueueJobStatus(job.status)) return undefined;
  if (!isFactoryExecutionQueueJob(job)) return undefined;
  if (job.status === "running") return jobProgressAt(job) ?? job.updatedAt ?? job.createdAt;
  return job.updatedAt ?? job.createdAt;
};

export const liveJobStaleAt = (
  job: Pick<QueueJob, "payload" | "status" | "result" | "updatedAt" | "createdAt"> | undefined,
  staleAfterMs = LIVE_JOB_STALE_AFTER_MS,
): number | undefined => {
  const freshnessAt = liveJobFreshnessAt(job);
  return typeof freshnessAt === "number" ? freshnessAt + staleAfterMs : undefined;
};

export const displayLiveJobStatus = (
  job: Pick<QueueJob, "payload" | "status" | "result" | "updatedAt" | "createdAt"> | undefined,
  now = Date.now(),
  staleAfterMs = LIVE_JOB_STALE_AFTER_MS,
): string | undefined => {
  if (!job) return undefined;
  if (isTerminalQueueJobStatus(job.status)) return job.status;
  const staleAt = liveJobStaleAt(job, staleAfterMs);
  if (typeof staleAt === "number" && staleAt <= now) {
    return "stalled";
  }
  if (job.status === "leased") return "running";
  return job.status;
};

export const liveExecutionSnapshotForJobs = (
  jobs: ReadonlyArray<Pick<QueueJob, "payload" | "status" | "result" | "updatedAt" | "createdAt">>,
  now = Date.now(),
  staleAfterMs = LIVE_JOB_STALE_AFTER_MS,
): {
  readonly stalledObjectiveIds: ReadonlySet<string>;
  readonly nextStatusChangeAt?: number;
} => {
  const stalledObjectiveIds = new Set<string>();
  let nextStatusChangeAt: number | undefined;
  for (const job of jobs) {
    const objectiveId = objectiveIdForLiveExecutionJob(job);
    if (!objectiveId) continue;
    const displayStatus = displayLiveJobStatus(job, now, staleAfterMs);
    if (displayStatus === "stalled") {
      stalledObjectiveIds.add(objectiveId);
      continue;
    }
    const staleAt = liveJobStaleAt(job, staleAfterMs);
    if (typeof staleAt !== "number" || staleAt <= now) continue;
    if (nextStatusChangeAt === undefined || staleAt < nextStatusChangeAt) {
      nextStatusChangeAt = staleAt;
    }
  }
  return { stalledObjectiveIds, nextStatusChangeAt };
};
