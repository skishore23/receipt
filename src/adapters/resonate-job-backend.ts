import { ACTIVE_JOB_STATUSES, type JobBackend } from "./job-backend";
import type { EnqueueJobInput, QueueJob } from "./sqlite-queue";

type ResonateJobBackendOptions = {
  readonly base: JobBackend;
  readonly startDriver: (job: QueueJob) => Promise<void>;
  readonly onDispatchError?: (error: Error, job: QueueJob) => void;
};

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

const findActiveSessionJob = async (
  backend: JobBackend,
  input: EnqueueJobInput,
): Promise<QueueJob | undefined> => {
  const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey.trim() : "";
  if (!sessionKey || (input.singletonMode ?? "allow") !== "steer") return undefined;
  for (const status of ACTIVE_JOB_STATUSES) {
    const jobs = await backend.listJobs({ status, limit: 500 });
    const match = jobs.find((job) =>
      job.sessionKey === sessionKey
      && job.agentId === input.agentId
      && job.id !== input.jobId
    );
    if (match) return match;
  }
  return undefined;
};

export const resonateJobBackend = (opts: ResonateJobBackendOptions): JobBackend => ({
  ...opts.base,
  enqueue: async (input) => {
    const existingById = input.jobId ? await opts.base.getJob(input.jobId) : undefined;
    const steerTarget = await findActiveSessionJob(opts.base, input);
    const created = await opts.base.enqueue(input);
    const shouldDispatch = !existingById
      && !steerTarget
      && created.status === "queued";
    if (!shouldDispatch) return created;
    try {
      await opts.startDriver(created);
      return created;
    } catch (err) {
      const error = toError(err);
      opts.onDispatchError?.(error, created);
      await opts.base.cancel(created.id, `resonate driver dispatch failed: ${error.message}`, "resonate");
      throw error;
    }
  },
});
