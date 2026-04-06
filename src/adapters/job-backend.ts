import type { EnqueueJobInput, LeaseOptions, QueueCommandInput, QueueCommandRecord, QueueJob, QueueSnapshot, WaitForWorkOptions } from "./sqlite-queue";
import type { JobLane, JobStatus, QueueCommandType } from "../modules/job";

export type JobBackend = {
  readonly enqueue: (input: EnqueueJobInput) => Promise<QueueJob>;
  readonly leaseNext: (opts: LeaseOptions) => Promise<QueueJob | undefined>;
  readonly leaseJob: (jobId: string, workerId: string, leaseMs: number) => Promise<QueueJob | undefined>;
  readonly heartbeat: (jobId: string, workerId: string, leaseMs: number) => Promise<QueueJob | undefined>;
  readonly progress: (
    jobId: string,
    workerId: string,
    result?: Record<string, unknown>
  ) => Promise<QueueJob | undefined>;
  readonly complete: (jobId: string, workerId: string, result?: Record<string, unknown>) => Promise<QueueJob | undefined>;
  readonly fail: (
    jobId: string,
    workerId: string,
    error: string,
    noRetry?: boolean,
    result?: Record<string, unknown>
  ) => Promise<QueueJob | undefined>;
  readonly cancel: (jobId: string, reason?: string, by?: string) => Promise<QueueJob | undefined>;
  readonly queueCommand: (input: QueueCommandInput) => Promise<QueueCommandRecord | undefined>;
  readonly consumeCommands: (
    jobId: string,
    filter?: ReadonlyArray<QueueCommandType>
  ) => Promise<ReadonlyArray<QueueCommandRecord>>;
  readonly getJob: (jobId: string) => Promise<QueueJob | undefined>;
  readonly listJobs: (opts?: { readonly status?: JobStatus; readonly limit?: number }) => Promise<ReadonlyArray<QueueJob>>;
  readonly waitForJob: (jobId: string, timeoutMs?: number, pollMs?: number) => Promise<QueueJob | undefined>;
  readonly waitForWork: (opts?: WaitForWorkOptions) => Promise<QueueSnapshot>;
  readonly notifyWorkAvailable: () => void;
  readonly snapshot: () => QueueSnapshot;
  readonly refresh: () => Promise<QueueSnapshot>;
};

export const ACTIVE_JOB_STATUSES: ReadonlyArray<JobStatus> = ["queued", "leased", "running"];

export const isActiveJobStatus = (status: JobStatus): boolean =>
  ACTIVE_JOB_STATUSES.includes(status);

export const matchesLane = (job: QueueJob, lanes: ReadonlyArray<JobLane> | undefined): boolean =>
  !lanes || lanes.length === 0 || lanes.includes(job.lane);
