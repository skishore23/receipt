// ============================================================================
// Background Job Worker - queue wakeups + leased execution + retries
// ============================================================================

import type { QueueCommandRecord, QueueJob, JsonlQueue } from "../../adapters/jsonl-queue";
import type { JobLane } from "../../modules/job";

export type JobLeaseProcessRegistration = {
  readonly pid: number;
  readonly label?: string;
};

export type JobExecutionContext = {
  readonly workerId: string;
  readonly pullCommands: (types?: ReadonlyArray<"steer" | "follow_up" | "abort">) => Promise<ReadonlyArray<QueueCommandRecord>>;
  readonly registerLeaseProcess: (process: JobLeaseProcessRegistration) => void;
  readonly clearLeaseProcess: () => void;
};

export type JobExecutionResult = {
  readonly ok: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly noRetry?: boolean;
};

export type JobHandler = (job: QueueJob, ctx: JobExecutionContext) => Promise<JobExecutionResult>;

export type JobWorkerOptions = {
  readonly queue: JsonlQueue;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly workerId: string;
  readonly leaseAgentIds?: ReadonlyArray<string>;
  readonly leaseLanes?: ReadonlyArray<JobLane>;
  readonly idleResyncMs?: number;
  readonly pollMs?: number;
  readonly leaseMs?: number;
  readonly concurrency?: number;
  readonly onTick?: () => void;
  readonly onError?: (error: Error) => void;
};

type ActiveLeaseState = {
  readonly jobId: string;
  readonly startedAt: number;
  readonly leaseMs: number;
  nextHeartbeatAt: number;
  renewAttempts: number;
  lastRenewOkAt?: number;
  process?: JobLeaseProcessRegistration;
};

const MAX_RENEW_ATTEMPTS = 5;
const RENEW_BASE_BACKOFF_MS = 250;
const RENEW_MAX_BACKOFF_MS = 5_000;

export class JobWorker {
  private readonly queue: JsonlQueue;
  private readonly handlers: Readonly<Record<string, JobHandler>>;
  private readonly workerId: string;
  private readonly leaseAgentIds?: ReadonlyArray<string>;
  private readonly leaseLanes?: ReadonlyArray<JobLane>;
  private readonly idleResyncMs: number;
  private readonly leaseMs: number;
  private readonly leaseHeartbeatMs: number;
  private readonly leasePollMs: number;
  private readonly concurrency: number;
  private readonly onTick?: () => void;
  private readonly onError?: (error: Error) => void;
  private readonly active = new Map<string, Promise<void>>();
  private readonly activeLeases = new Map<string, ActiveLeaseState>();
  private running = false;

  constructor(opts: JobWorkerOptions) {
    this.queue = opts.queue;
    this.handlers = opts.handlers;
    this.workerId = opts.workerId;
    this.leaseAgentIds = opts.leaseAgentIds?.map((agentId) => agentId.trim()).filter(Boolean);
    this.leaseLanes = opts.leaseLanes?.filter((lane) =>
      lane === "chat" || lane === "collect" || lane === "steer" || lane === "follow_up"
    );
    this.idleResyncMs = Math.max(1_000, opts.idleResyncMs ?? opts.pollMs ?? 5_000);
    this.leaseMs = Math.max(5_000, opts.leaseMs ?? 30_000);
    this.leaseHeartbeatMs = Math.max(1_000, Math.floor(this.leaseMs / 3));
    this.leasePollMs = Math.min(1_000, Math.max(250, Math.floor(this.leaseHeartbeatMs / 4)));
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.onTick = opts.onTick;
    this.onError = opts.onError;
  }

  private reportError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    try {
      this.onError?.(error);
    } catch {
      // Error reporting must not crash the worker loop.
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.leaseLoop().catch((err) => {
      this.reportError(err);
    });
    void this.loop().catch((err) => {
      this.running = false;
      this.reportError(err);
    });
  }

  stop(): void {
    this.running = false;
  }

  private async leaseLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.tickLeases();
      } catch (err) {
        this.reportError(err);
      }
      if (!this.running) break;
      await new Promise((resolve) => {
        setTimeout(resolve, this.leasePollMs);
      });
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      return code === "EPERM";
    }
  }

  private registerActiveLease(jobId: string): ActiveLeaseState {
    const state: ActiveLeaseState = {
      jobId,
      startedAt: Date.now(),
      leaseMs: this.leaseMs,
      nextHeartbeatAt: 0,
      renewAttempts: 0,
    };
    this.activeLeases.set(jobId, state);
    return state;
  }

  private clearActiveLease(jobId: string): void {
    this.activeLeases.delete(jobId);
  }

  private async heartbeatLease(state: ActiveLeaseState): Promise<void> {
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(this.leaseHeartbeatMs / 10)));
    const deadline = Date.now() + jitter;
    if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, deadline - Date.now()));
    }
    const startedAt = Date.now();
    let attempt = 0;
    while (attempt < MAX_RENEW_ATTEMPTS && this.running) {
      attempt += 1;
      state.renewAttempts += 1;
      try {
        const current = await this.queue.heartbeat(state.jobId, this.workerId, state.leaseMs);
        state.lastRenewOkAt = Date.now();
        if (!current || current.status === "completed" || current.status === "failed" || current.status === "canceled") {
          this.clearActiveLease(state.jobId);
          return;
        }
        state.nextHeartbeatAt = Date.now() + this.leaseHeartbeatMs;
        return;
      } catch (err) {
        if (attempt >= MAX_RENEW_ATTEMPTS) break;
        const backoff = Math.min(RENEW_MAX_BACKOFF_MS, RENEW_BASE_BACKOFF_MS * (2 ** (attempt - 1)));
        await new Promise((resolve) => setTimeout(resolve, backoff + Math.floor(Math.random() * backoff * 0.25)));
      }
    }
    this.clearActiveLease(state.jobId);
    throw new Error(`lease renewal failed for job ${state.jobId} after ${state.renewAttempts} attempts (lease_ttl_ms=${state.leaseMs}, renew_latency_ms=${Date.now() - startedAt}, last_renew_ok_at=${state.lastRenewOkAt ?? 0})`);
  }

  private async failDeadLeaseProcess(state: ActiveLeaseState): Promise<void> {
    this.clearActiveLease(state.jobId);
    const label = state.process?.label?.trim() || "job child process";
    const reason = `factory task failed: ${label} exited unexpectedly before the worker completed`;
    await this.queue.fail(state.jobId, this.workerId, reason, true, {
      status: "failed",
      summary: reason,
    });
  }

  private async tickLeases(): Promise<void> {
    const now = Date.now();
    for (const state of [...this.activeLeases.values()]) {
      const registeredProcess = state.process;
      if (registeredProcess && !this.isProcessAlive(registeredProcess.pid)) {
        await this.failDeadLeaseProcess(state);
        continue;
      }
      if (now < state.nextHeartbeatAt) continue;
      try {
        await this.heartbeatLease(state);
      } catch (err) {
        this.reportError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private async waitForQueueAdvance(sinceVersion: number): Promise<ReturnType<JsonlQueue["snapshot"]>> {
    const waited = await this.queue.waitForWork({
      sinceVersion,
      timeoutMs: this.idleResyncMs,
      wakeOnQueued: false,
    });
    if (waited.queued > 0 || waited.version > sinceVersion) {
      return waited;
    }
    return this.queue.refresh();
  }

  private async loop(): Promise<void> {
    let seenVersion = this.queue.snapshot().version;
    while (this.running) {
      try {
        const leasedAny = await this.tick();
        const current = this.queue.snapshot();
        seenVersion = current.version;
        if (leasedAny && this.active.size < this.concurrency) {
          continue;
        }
        if (this.active.size > 0) {
          const next = await Promise.race([
            Promise.race(this.active.values()).then(() => ({
              kind: "active" as const,
            })),
            this.waitForQueueAdvance(seenVersion).then((snapshot) => ({
              kind: "queue" as const,
              snapshot,
            })),
          ]);
          seenVersion = next.kind === "queue"
            ? next.snapshot.version
            : this.queue.snapshot().version;
          continue;
        }
        const next = await this.waitForQueueAdvance(seenVersion);
        seenVersion = next.version;
      } catch (err) {
        this.reportError(err);
        if (!this.running) break;
        await new Promise((resolve) => {
          setTimeout(resolve, Math.min(this.idleResyncMs, 1_000));
        });
        seenVersion = this.queue.snapshot().version;
      } finally {
        if (this.onTick) this.onTick();
      }
    }
  }

  private async tick(): Promise<boolean> {
    let leasedAny = false;
    while (this.active.size < this.concurrency) {
      const leased = await this.queue.leaseNext({
        workerId: this.workerId,
        leaseMs: this.leaseMs,
        ...(this.leaseAgentIds?.length ? { agentIds: this.leaseAgentIds } : {}),
        ...(this.leaseLanes?.length ? { lanes: this.leaseLanes } : {}),
      });
      if (!leased) break;
      leasedAny = true;
      const runPromise = this.runLeased(leased)
        .catch((err) => {
          this.reportError(err);
        })
        .finally(() => {
          this.active.delete(leased.id);
        });
      this.active.set(leased.id, runPromise);
    }
    return leasedAny;
  }

  private async runLeased(job: QueueJob): Promise<void> {
    const pullCommands = async (
      types?: ReadonlyArray<"steer" | "follow_up" | "abort">
    ): Promise<ReadonlyArray<QueueCommandRecord>> => this.queue.consumeCommands(job.id, types);

    const preAbort = await pullCommands(["abort"]);
    if (preAbort.length > 0 || job.abortRequested) {
      await this.queue.cancel(job.id, "abort requested", this.workerId);
      return;
    }

    const activeLease = this.registerActiveLease(job.id);
    await this.heartbeatLease(activeLease);
    if (!this.activeLeases.has(job.id)) return;

    const handler = this.handlers[job.agentId];
    if (!handler) {
      this.clearActiveLease(job.id);
      await this.queue.fail(job.id, this.workerId, `No handler for agent '${job.agentId}'`, true);
      return;
    }

    try {
      const result = await handler(job, {
        workerId: this.workerId,
        pullCommands,
        registerLeaseProcess: (process) => {
          if (!Number.isInteger(process.pid) || process.pid <= 0) return;
          activeLease.process = {
            pid: process.pid,
            label: process.label?.trim() || undefined,
          };
        },
        clearLeaseProcess: () => {
          activeLease.process = undefined;
        },
      });
      this.clearActiveLease(job.id);
      const postAbort = await pullCommands(["abort"]);
      if (postAbort.length > 0) {
        await this.queue.cancel(job.id, "abort requested", this.workerId);
        return;
      }
      if (result.ok) {
        await this.queue.complete(job.id, this.workerId, result.result);
      } else {
        await this.queue.fail(job.id, this.workerId, result.error ?? "job failed", result.noRetry, result.result);
      }
    } catch (err) {
      this.clearActiveLease(job.id);
      const message = err instanceof Error ? err.message : String(err);
      await this.queue.fail(job.id, this.workerId, message);
    }
  }
}
