// ============================================================================
// Receipt-native Queue Adapter - derives queue state from job receipts
// ============================================================================

import { randomUUID } from "node:crypto";

import type { Runtime } from "../core/runtime.js";
import type { JobCmd, JobCommandRecord, JobEvent, JobLane, JobRecord, JobState, JobStatus, QueueCommandType } from "../modules/job.js";

export type QueueCommandRecord = {
  readonly id: string;
  readonly command: QueueCommandType;
  readonly lane: Exclude<JobLane, "collect">;
  readonly payload?: Record<string, unknown>;
  readonly by?: string;
  readonly createdAt: number;
  readonly consumedAt?: number;
};

export type JobPayload = Readonly<Record<string, unknown>> & {
  readonly runId?: string;
  readonly runStream?: string;
  readonly stream?: string;
};

export type QueueJob = {
  readonly id: string;
  readonly agentId: string;
  readonly lane: JobLane;
  readonly sessionKey?: string;
  readonly singletonMode?: "allow" | "cancel" | "steer";
  readonly payload: JobPayload;
  readonly status: JobStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly leaseOwner?: string;
  readonly leaseUntil?: number;
  readonly lastError?: string;
  readonly result?: Record<string, unknown>;
  readonly canceledReason?: string;
  readonly abortRequested?: boolean;
  readonly commands: ReadonlyArray<QueueCommandRecord>;
};

export type EnqueueJobInput = {
  readonly jobId?: string;
  readonly agentId: string;
  readonly lane?: JobLane;
  readonly sessionKey?: string;
  readonly singletonMode?: "allow" | "cancel" | "steer";
  readonly payload: JobPayload;
  readonly maxAttempts?: number;
};

export type LeaseOptions = {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly agentId?: string;
};

export type QueueCommandInput = {
  readonly jobId: string;
  readonly command: QueueCommandType;
  readonly payload?: Record<string, unknown>;
  readonly by?: string;
};

export type JsonlQueue = {
  readonly enqueue: (input: EnqueueJobInput) => Promise<QueueJob>;
  readonly leaseNext: (opts: LeaseOptions) => Promise<QueueJob | undefined>;
  readonly heartbeat: (jobId: string, workerId: string, leaseMs: number) => Promise<QueueJob | undefined>;
  readonly complete: (jobId: string, workerId: string, result?: Record<string, unknown>) => Promise<QueueJob | undefined>;
  readonly fail: (jobId: string, workerId: string, error: string, noRetry?: boolean) => Promise<QueueJob | undefined>;
  readonly cancel: (jobId: string, reason?: string, by?: string) => Promise<QueueJob | undefined>;
  readonly queueCommand: (input: QueueCommandInput) => Promise<QueueCommandRecord | undefined>;
  readonly consumeCommands: (
    jobId: string,
    filter?: ReadonlyArray<QueueCommandType>
  ) => Promise<ReadonlyArray<QueueCommandRecord>>;
  readonly getJob: (jobId: string) => Promise<QueueJob | undefined>;
  readonly listJobs: (opts?: { readonly status?: JobStatus; readonly limit?: number }) => Promise<ReadonlyArray<QueueJob>>;
  readonly waitForJob: (jobId: string, timeoutMs?: number, pollMs?: number) => Promise<QueueJob | undefined>;
};

type JsonlQueueOptions = {
  readonly runtime: Runtime<JobCmd, JobEvent, JobState>;
  readonly stream: string;
  readonly now?: () => number;
  readonly onJobChange?: (jobIds: ReadonlyArray<string>) => Promise<void> | void;
};

const TERMINAL = new Set<JobStatus>(["completed", "failed", "canceled"]);

const lanePriority: Record<JobLane, number> = {
  steer: 0,
  collect: 1,
  follow_up: 2,
};

const commandLane = (command: QueueCommandType): Exclude<JobLane, "collect"> =>
  command === "follow_up" ? "follow_up" : "steer";

const cloneJob = (job: QueueJob): QueueJob => ({
  ...job,
  payload: { ...job.payload },
  result: job.result ? { ...job.result } : undefined,
  commands: job.commands.map((cmd) => ({
    ...cmd,
    payload: cmd.payload ? { ...cmd.payload } : undefined,
  })),
});

const eventId = (): string => `jobevt_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;

export const jsonlQueue = (opts: JsonlQueueOptions): JsonlQueue => {
  const nowTs = opts.now ?? Date.now;
  let indexState: JobState | undefined;
  const jobStateCache = new Map<string, JobState>();
  let lock = Promise.resolve();

  const withLock = async <T>(op: () => Promise<T>): Promise<T> => {
    const next = lock.then(op);
    lock = next.then(() => undefined, () => undefined);
    return next;
  };

  const jobStream = (jobId: string): string => `${opts.stream}/${jobId}`;

  const emitToStream = async (stream: string, event: JobEvent, hint?: string): Promise<void> => {
    await opts.runtime.execute(stream, {
      type: "emit",
      event,
      eventId: hint ?? eventId(),
    });
  };

  const emitEvent = async (event: JobEvent): Promise<void> => {
    const marker = eventId();
    if ("jobId" in event) {
      await emitToStream(jobStream(event.jobId), event, `${marker}:job`);
      jobStateCache.set(event.jobId, await opts.runtime.state(jobStream(event.jobId)));
    }
    await emitToStream(opts.stream, event, `${marker}:index`);
    indexState = await opts.runtime.state(opts.stream);
    if ("jobId" in event) await opts.onJobChange?.([event.jobId]);
  };

  const ensureIndexState = async (): Promise<JobState> => {
    if (indexState) return indexState;
    indexState = await opts.runtime.state(opts.stream);
    return indexState;
  };

  const ensureJobState = async (jobId: string): Promise<JobState> => {
    const cached = jobStateCache.get(jobId);
    if (cached) return cached;
    const loaded = await opts.runtime.state(jobStream(jobId));
    jobStateCache.set(jobId, loaded);
    return loaded;
  };

  const jobsMap = async (): Promise<Readonly<Record<string, JobRecord>>> => (await ensureIndexState()).jobs;

  const toCommandRecord = (command: JobCommandRecord): QueueCommandRecord => ({
    id: command.id,
    command: command.command,
    lane: command.lane,
    payload: command.payload ? { ...command.payload } : undefined,
    by: command.by,
    createdAt: command.createdAt,
    consumedAt: command.consumedAt,
  });

  const toQueueJob = (record: JobRecord): QueueJob => ({
    id: record.id,
    agentId: record.agentId,
    lane: record.lane,
    sessionKey: record.sessionKey,
    singletonMode: record.singletonMode,
    payload: { ...record.payload },
    status: record.status,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    leaseOwner: record.workerId,
    leaseUntil: record.leaseUntil,
    lastError: record.lastError,
    result: record.result ? { ...record.result } : undefined,
    canceledReason: record.canceledReason,
    abortRequested: record.abortRequested,
    commands: record.commands.map(toCommandRecord),
  });

  const getQueueJob = async (jobId: string): Promise<QueueJob | undefined> => {
    const record = (await ensureJobState(jobId)).jobs[jobId];
    return record ? toQueueJob(record) : undefined;
  };

  const listAllJobs = async (): Promise<ReadonlyArray<QueueJob>> =>
    Object.values(await jobsMap()).map((job) => toQueueJob(job));

  const handleExpiredLeases = async (timestamp: number): Promise<void> => {
    for (const job of await listAllJobs()) {
      if ((job.status !== "leased" && job.status !== "running") || !job.leaseUntil) continue;
      if (job.leaseUntil > timestamp) continue;
      const retryable = job.attempt < job.maxAttempts;
      await emitEvent({
        type: "job.lease_expired",
        jobId: job.id,
        retryable,
        willRetry: retryable,
      });
    }
  };

  const sortedJobs = (all: ReadonlyArray<QueueJob>): QueueJob[] =>
    [...all].sort((a, b) =>
      lanePriority[a.lane] - lanePriority[b.lane]
      || a.createdAt - b.createdAt
      || a.id.localeCompare(b.id)
    );

  const sortedByRecent = (all: ReadonlyArray<QueueJob>): QueueJob[] =>
    [...all].sort((a, b) =>
      b.updatedAt - a.updatedAt
      || b.createdAt - a.createdAt
      || b.id.localeCompare(a.id)
    );

  const activeBySession = async (sessionKey: string, excludeId?: string): Promise<QueueJob[]> =>
    (await listAllJobs()).filter((job) =>
      job.sessionKey === sessionKey
      && !TERMINAL.has(job.status)
      && job.id !== excludeId
    );

  const requestAbort = async (job: QueueJob, reason: string): Promise<void> => {
    if (job.status === "queued") {
      await emitEvent({
        type: "job.canceled",
        jobId: job.id,
        reason,
      });
      return;
    }
    const ts = nowTs();
    const commandId = `cmd_${ts.toString(36)}_${randomUUID().slice(0, 6)}`;
    await emitEvent({
      type: "queue.command",
      jobId: job.id,
      commandId,
      command: "abort",
      lane: "steer",
      payload: { reason },
      createdAt: ts,
    });
  };

  const requestSteer = async (job: QueueJob, payload: Record<string, unknown>): Promise<void> => {
    const ts = nowTs();
    const commandId = `cmd_${ts.toString(36)}_${randomUUID().slice(0, 6)}`;
    await emitEvent({
      type: "queue.command",
      jobId: job.id,
      commandId,
      command: "steer",
      lane: "steer",
      payload,
      createdAt: ts,
    });
  };

  return {
    enqueue: async (input) => withLock(async () => {
      const ts = nowTs();
      const jobId = input.jobId ?? `job_${ts.toString(36)}_${randomUUID().slice(0, 6)}`;
      const existing = await getQueueJob(jobId);
      if (existing) {
        return cloneJob(existing);
      }
      const singletonMode = input.singletonMode ?? "allow";
      const sessionKey = typeof input.sessionKey === "string" && input.sessionKey.trim()
        ? input.sessionKey.trim()
        : undefined;
      if (sessionKey) {
        const active = sortedByRecent(await activeBySession(sessionKey, jobId));
        if (singletonMode === "cancel" && active.length > 0) {
          for (const prior of active) {
            await requestAbort(prior, "singleton cancel");
          }
        } else if (singletonMode === "steer" && active.length > 0) {
          const target = active[0];
          if (target) {
            await requestSteer(target, {
              fromSessionKey: sessionKey,
              fromEnqueue: true,
              payload: input.payload,
            });
            return cloneJob(target);
          }
        }
      }
      const job: QueueJob = {
        id: jobId,
        agentId: input.agentId,
        lane: input.lane ?? "collect",
        sessionKey,
        singletonMode,
        payload: input.payload,
        status: "queued",
        attempt: 0,
        maxAttempts: Math.max(1, Math.min(input.maxAttempts ?? 2, 8)),
        createdAt: ts,
        updatedAt: ts,
        commands: [],
      };
      await emitEvent({
        type: "job.enqueued",
        jobId: job.id,
        agentId: job.agentId,
        lane: job.lane,
        payload: job.payload,
        maxAttempts: job.maxAttempts,
        sessionKey: job.sessionKey,
        singletonMode: job.singletonMode,
        createdAt: job.createdAt,
      });
      const created = await getQueueJob(job.id);
      if (!created) throw new Error(`Invariant: missing job ${job.id} after enqueue`);
      return cloneJob(created);
    }),

    leaseNext: async (lease) => withLock(async () => {
      const ts = nowTs();
      await handleExpiredLeases(ts);
      const candidates = sortedJobs(
        (await listAllJobs()).filter((job) =>
          job.status === "queued"
          && !job.abortRequested
          && (!lease.agentId || job.agentId === lease.agentId)
        )
      );
      const next = candidates[0];
      if (!next) return undefined;
      const attempt = next.attempt + 1;
      await emitEvent({
        type: "job.leased",
        jobId: next.id,
        workerId: lease.workerId,
        leaseMs: Math.max(1_000, lease.leaseMs),
        attempt,
      });
      return getQueueJob(next.id);
    }),

    heartbeat: async (jobId, workerId, leaseMs) => withLock(async () => {
      const current = await getQueueJob(jobId);
      if (!current) return undefined;
      if (TERMINAL.has(current.status)) return cloneJob(current);
      if (current.leaseOwner && current.leaseOwner !== workerId) return undefined;
      await emitEvent({
        type: "job.heartbeat",
        jobId,
        workerId,
        leaseMs: Math.max(1_000, leaseMs),
      });
      return getQueueJob(jobId);
    }),

    complete: async (jobId, workerId, result) => withLock(async () => {
      const current = await getQueueJob(jobId);
      if (!current) return undefined;
      if (TERMINAL.has(current.status)) return cloneJob(current);
      if (current.leaseOwner && current.leaseOwner !== workerId) return undefined;
      await emitEvent({
        type: "job.completed",
        jobId,
        workerId,
        result,
      });
      return getQueueJob(jobId);
    }),

    fail: async (jobId, workerId, error, noRetry) => withLock(async () => {
      const current = await getQueueJob(jobId);
      if (!current) return undefined;
      if (TERMINAL.has(current.status)) return cloneJob(current);
      if (current.leaseOwner && current.leaseOwner !== workerId) return undefined;

      const retryable = current.attempt < current.maxAttempts && !noRetry;
      await emitEvent({
        type: "job.failed",
        jobId,
        workerId,
        error,
        retryable,
        willRetry: retryable,
      });
      return getQueueJob(jobId);
    }),

    cancel: async (jobId, reason, by) => withLock(async () => {
      const current = await getQueueJob(jobId);
      if (!current) return undefined;
      if (TERMINAL.has(current.status)) return cloneJob(current);
      await emitEvent({
        type: "job.canceled",
        jobId,
        reason,
        by,
      });
      return getQueueJob(jobId);
    }),

    queueCommand: async (input) => withLock(async () => {
      const current = await getQueueJob(input.jobId);
      if (!current) return undefined;
      const ts = nowTs();
      const command: QueueCommandRecord = {
        id: `cmd_${ts.toString(36)}_${randomUUID().slice(0, 6)}`,
        command: input.command,
        lane: commandLane(input.command),
        payload: input.payload,
        by: input.by,
        createdAt: ts,
      };
      await emitEvent({
        type: "queue.command",
        jobId: input.jobId,
        commandId: command.id,
        command: input.command,
        lane: commandLane(input.command),
        payload: input.payload,
        by: input.by,
        createdAt: ts,
      });
      if (input.command === "abort") {
        if (current.status === "queued") {
          await emitEvent({
            type: "job.canceled",
            jobId: input.jobId,
            reason: "abort requested",
            by: input.by,
          });
        }
      }
      return command;
    }),

    consumeCommands: async (jobId, filter) => withLock(async () => {
      const current = await getQueueJob(jobId);
      if (!current) return [];
      const wanted = new Set(filter ?? ["steer", "follow_up", "abort"]);
      const unconsumed = current.commands.filter((cmd) => !cmd.consumedAt && wanted.has(cmd.command));
      if (unconsumed.length === 0) return [];
      const ts = nowTs();
      for (const cmd of unconsumed) {
        await emitEvent({
          type: "queue.command.consumed",
          jobId,
          commandId: cmd.id,
          consumedAt: ts,
        });
      }
      return unconsumed.map((cmd) => ({ ...cmd, consumedAt: ts }));
    }),

    getJob: async (jobId) => withLock(async () => {
      const found = await getQueueJob(jobId);
      return found ? cloneJob(found) : undefined;
    }),

    listJobs: async (options) => withLock(async () => {
      const limit = Math.max(1, Math.min(options?.limit ?? 50, 500));
      const values = (await listAllJobs())
        .filter((job) => (options?.status ? job.status === options.status : true))
        .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
      return values.slice(0, limit).map(cloneJob);
    }),

    waitForJob: async (jobId, timeoutMs = 15_000, pollMs = 200) => {
      const end = nowTs() + Math.max(0, timeoutMs);
      while (nowTs() <= end) {
        const current = await getQueueJob(jobId);
        if (current && TERMINAL.has(current.status)) return cloneJob(current);
        await new Promise((resolve) => setTimeout(resolve, Math.max(20, pollMs)));
      }
      const current = await getQueueJob(jobId);
      return current ? cloneJob(current) : undefined;
    },
  };
};
