// ============================================================================
// Job Module - queue/runtime receipts for background scheduling
// ============================================================================

import type { Decide, Reducer } from "@receipt/core/types.js";

export type JobLane = "collect" | "steer" | "follow_up";
export type JobStatus = "queued" | "leased" | "running" | "completed" | "failed" | "canceled";
export type QueueCommandType = "steer" | "follow_up" | "abort";

export type JobEvent =
  | {
      readonly type: "job.enqueued";
      readonly jobId: string;
      readonly agentId: string;
      readonly lane: JobLane;
      readonly payload: Readonly<Record<string, unknown>>;
      readonly maxAttempts: number;
      readonly sessionKey?: string;
      readonly singletonMode?: "allow" | "cancel" | "steer";
      readonly createdAt?: number;
    }
  | {
      readonly type: "job.leased";
      readonly jobId: string;
      readonly workerId: string;
      readonly leaseMs: number;
      readonly attempt: number;
    }
  | {
      readonly type: "job.heartbeat";
      readonly jobId: string;
      readonly workerId: string;
      readonly leaseMs: number;
    }
  | {
      readonly type: "job.progress";
      readonly jobId: string;
      readonly workerId: string;
      readonly result?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "job.completed";
      readonly jobId: string;
      readonly workerId: string;
      readonly result?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "job.failed";
      readonly jobId: string;
      readonly workerId?: string;
      readonly error: string;
      readonly retryable: boolean;
      readonly willRetry: boolean;
      readonly result?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "job.canceled";
      readonly jobId: string;
      readonly reason?: string;
      readonly by?: string;
    }
  | {
      readonly type: "queue.command";
      readonly jobId: string;
      readonly commandId: string;
      readonly command: QueueCommandType;
      readonly lane: Exclude<JobLane, "collect">;
      readonly payload?: Readonly<Record<string, unknown>>;
      readonly by?: string;
      readonly createdAt?: number;
    }
  | {
      readonly type: "queue.command.consumed";
      readonly jobId: string;
      readonly commandId: string;
      readonly consumedAt: number;
    }
  | {
      readonly type: "job.lease_expired";
      readonly jobId: string;
      readonly retryable: boolean;
      readonly willRetry: boolean;
    };

export type JobCmd = {
  readonly type: "emit";
  readonly event: JobEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export type JobCommandRecord = {
  readonly id: string;
  readonly command: QueueCommandType;
  readonly lane: Exclude<JobLane, "collect">;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly by?: string;
  readonly createdAt: number;
  readonly consumedAt?: number;
};

export type JobRecord = {
  readonly id: string;
  readonly agentId: string;
  readonly lane: JobLane;
  readonly sessionKey?: string;
  readonly singletonMode?: "allow" | "cancel" | "steer";
  readonly createdAt: number;
  readonly status: JobStatus;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly leaseUntil?: number;
  readonly workerId?: string;
  readonly lastError?: string;
  readonly canceledReason?: string;
  readonly abortRequested?: boolean;
  readonly commands: ReadonlyArray<JobCommandRecord>;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly updatedAt: number;
};

export type JobState = {
  readonly jobs: Readonly<Record<string, JobRecord>>;
};

export const initial: JobState = { jobs: {} };

export const decide: Decide<JobCmd, JobEvent> = (cmd) => [cmd.event];

const upsert = (state: JobState, next: JobRecord): JobState => ({
  ...state,
  jobs: {
    ...state.jobs,
    [next.id]: next,
  },
});

export const reduce: Reducer<JobState, JobEvent> = (state, event, ts) => {
  switch (event.type) {
    case "job.enqueued":
      return upsert(state, {
        id: event.jobId,
        agentId: event.agentId,
        lane: event.lane,
        sessionKey: event.sessionKey,
        singletonMode: event.singletonMode,
        createdAt: event.createdAt ?? ts,
        status: "queued",
        payload: event.payload,
        attempt: 0,
        maxAttempts: event.maxAttempts,
        commands: [],
        updatedAt: ts,
      });
    case "job.leased": {
      const prev = state.jobs[event.jobId];
      if (!prev) throw new Error(`Invariant: no job ${event.jobId} for ${event.type}`);
      return upsert(state, {
        ...prev,
        status: "leased",
        attempt: event.attempt,
        workerId: event.workerId,
        leaseUntil: ts + event.leaseMs,
        updatedAt: ts,
      });
    }
    case "job.heartbeat": {
      const prev = state.jobs[event.jobId];
      if (!prev) throw new Error(`Invariant: no job ${event.jobId} for ${event.type}`);
      if (prev.status !== "leased" && prev.status !== "running") {
        throw new Error(`Invariant: invalid heartbeat status ${prev.status} for ${event.jobId}`);
      }
      return upsert(state, {
        ...prev,
        status: "running",
        workerId: event.workerId,
        leaseUntil: ts + event.leaseMs,
        updatedAt: ts,
      });
    }
    case "job.progress": {
      const prev = state.jobs[event.jobId];
      if (!prev) throw new Error(`Invariant: no job ${event.jobId} for ${event.type}`);
      if (prev.status !== "leased" && prev.status !== "running") {
        throw new Error(`Invariant: invalid progress status ${prev.status} for ${event.jobId}`);
      }
      return upsert(state, {
        ...prev,
        status: "running",
        workerId: event.workerId,
        result: event.result ? { ...(prev.result ?? {}), ...event.result } : prev.result,
        updatedAt: ts,
      });
    }
    case "job.completed": {
      const prev = state.jobs[event.jobId];
      if (!prev) throw new Error(`Invariant: no job ${event.jobId} for ${event.type}`);
      return upsert(state, {
        ...prev,
        status: "completed",
        workerId: event.workerId,
        leaseUntil: undefined,
        result: event.result,
        updatedAt: ts,
      });
    }
    case "job.failed": {
      const prev = state.jobs[event.jobId];
      if (!prev) throw new Error(`Invariant: no job ${event.jobId} for ${event.type}`);
      return upsert(state, {
        ...prev,
        status: event.willRetry ? "queued" : "failed",
        workerId: event.workerId,
        leaseUntil: undefined,
        lastError: event.error,
        result: event.result ?? prev.result,
        updatedAt: ts,
      });
    }
    case "job.canceled": {
      const prev = state.jobs[event.jobId];
      if (!prev) throw new Error(`Invariant: no job ${event.jobId} for ${event.type}`);
      return upsert(state, {
        ...prev,
        status: "canceled",
        leaseUntil: undefined,
        canceledReason: event.reason,
        abortRequested: true,
        updatedAt: ts,
      });
    }
    case "queue.command": {
      const prev = state.jobs[event.jobId];
      if (!prev) throw new Error(`Invariant: no job ${event.jobId} for ${event.type}`);
      const command: JobCommandRecord = {
        id: event.commandId,
        command: event.command,
        lane: event.lane,
        payload: event.payload,
        by: event.by,
        createdAt: event.createdAt ?? ts,
      };
      return upsert(state, {
        ...prev,
        abortRequested: event.command === "abort" ? true : prev.abortRequested,
        commands: [...prev.commands, command],
        updatedAt: ts,
      });
    }
    case "queue.command.consumed": {
      const prev = state.jobs[event.jobId];
      if (!prev) throw new Error(`Invariant: no job ${event.jobId} for ${event.type}`);
      return upsert(state, {
        ...prev,
        commands: prev.commands.map((command) => (
          command.id === event.commandId ? { ...command, consumedAt: event.consumedAt } : command
        )),
        updatedAt: ts,
      });
    }
    case "job.lease_expired": {
      const prev = state.jobs[event.jobId];
      if (!prev) throw new Error(`Invariant: no job ${event.jobId} for ${event.type}`);
      return upsert(state, {
        ...prev,
        status: event.willRetry ? "queued" : "failed",
        leaseUntil: undefined,
        workerId: undefined,
        lastError: "lease expired",
        updatedAt: ts,
      });
    }
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
};
