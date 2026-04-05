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
  nextHeartbeatAt: number;
  heartbeatTimer?: NodeJS.Timeout;
  consecutiveHeartbeatFailures: number;
  retryingHeartbeat: boolean;
  process?: JobLeaseProcessRegistration;
};

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
  private readonly maxHeartbeatFailures = 3;
  private readonly heartbeatRetryDelayMs = 250;
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
      nextHeartbeatAt: 0,
      consecutiveHeartbeatFailures: 0,
      retryingHeartbeat: false,
    };
    this.activeLeases.set(jobId, state);
    state.heartbeatTimer = setInterval(() => {
      void this.maybeHeartbeatLease(state);
    }, this.leaseHeartbeatMs);
    state.heartbeatTimer.unref?.();
    return state;
  }

  private clearActiveLease(jobId: string): void {
    const state = this.activeLeases.get(jobId);
    if (state?.heartbeatTimer) clearInterval(state.heartbeatTimer);
    this.activeLeases.delete(jobId);
  }

  private async heartbeatLease(state: ActiveLeaseState): Promise<void> {
    const current = await this.queue.heartbeat(state.jobId, this.workerId, this.leaseMs);
    if (!current || current.status === "completed" || current.status === "failed" || current.status === "canceled") {
      this.clearActiveLease(state.jobId);
      return;
    }
    state.nextHeartbeatAt = Date.now() + this.leaseHeartbeatMs;
  }

  private logLeaseMetric(event: string, state: ActiveLeaseState, extra?: Record<string, unknown>): void {
    console.info(JSON.stringify({
      event,
      job_id: state.jobId,
      lease_ttl_seconds: Math.round(this.leaseMs / 1000),
      job_runtime_seconds: Number(((Date.now() - state.startedAt) / 1000).toFixed(3)),
      consecutive_failures: state.consecutiveHeartbeatFailures,
      ...extra,
    }));
  }

  private async retryHeartbeatLease(state: ActiveLeaseState): Promise<void> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt < 3) {
      attempt += 1;
      try {
        await this.heartbeatLease(state);
        state.consecutiveHeartbeatFailures = 0;
        this.logLeaseMetric("renew_success", state, { attempt });
        return;
      } catch (err) {
        lastErr = err;
        state.consecutiveHeartbeatFailures += 1;
        this.logLeaseMetric("renew_fail", state, {
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
        if (attempt < 3) {
          const jitter = Math.floor(Math.random() * this.heartbeatRetryDelayMs);
          await new Promise((resolve) => setTimeout(resolve, this.heartbeatRetryDelayMs + jitter));
        }
      }
    }

    if (state.consecutiveHeartbeatFailures >= this.maxHeartbeatFailures) {
      this.clearActiveLease(state.jobId);
      const reason = `lease renewal failed ${state.consecutiveHeartbeatFailures} consecutive times`;
      await this.queue.fail(state.jobId, this.workerId, reason, true, {
        status: "failed",
        summary: reason,
        error: lastErr instanceof Error ? lastErr.message : String(lastErr ?? reason),
      });
      throw new Error(reason);
    }
  }

  private async maybeHeartbeatLease(state: ActiveLeaseState): Promise<void> {
    if (state.retryingHeartbeat || !this.activeLeases.has(state.jobId)) return;
    if (Date.now() < state.nextHeartbeatAt) return;
    state.retryingHeartbeat = true;
    try {
      await this.retryHeartbeatLease(state);
    } finally {
      state.retryingHeartbeat = false;
    }
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
        await this.maybeHeartbeatLease(state);
      } catch (err) {
        this.reportError(new Error(`Failed to heartbeat job ${state.jobId}: ${err}`));
        state.nextHeartbeatAt = Date.now() + this.leaseHeartbeatMs;
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
    await this.maybeHeartbeatLease(activeLease);
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
      await this.maybeHeartbeatLease(activeLease);
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
