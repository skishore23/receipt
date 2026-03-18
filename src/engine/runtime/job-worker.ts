// ============================================================================
// Background Job Worker - queue wakeups + leased execution + retries
// ============================================================================

import type { QueueCommandRecord, QueueJob, JsonlQueue } from "../../adapters/jsonl-queue.js";

export type JobExecutionContext = {
  readonly workerId: string;
  readonly pullCommands: (types?: ReadonlyArray<"steer" | "follow_up" | "abort">) => Promise<ReadonlyArray<QueueCommandRecord>>;
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
  readonly idleResyncMs?: number;
  readonly pollMs?: number;
  readonly leaseMs?: number;
  readonly concurrency?: number;
  readonly onTick?: () => void;
  readonly onError?: (error: Error) => void;
};

export class JobWorker {
  private readonly queue: JsonlQueue;
  private readonly handlers: Readonly<Record<string, JobHandler>>;
  private readonly workerId: string;
  private readonly idleResyncMs: number;
  private readonly leaseMs: number;
  private readonly concurrency: number;
  private readonly onTick?: () => void;
  private readonly onError?: (error: Error) => void;
  private readonly active = new Map<string, Promise<void>>();
  private running = false;

  constructor(opts: JobWorkerOptions) {
    this.queue = opts.queue;
    this.handlers = opts.handlers;
    this.workerId = opts.workerId;
    this.idleResyncMs = Math.max(1_000, opts.idleResyncMs ?? opts.pollMs ?? 5_000);
    this.leaseMs = Math.max(5_000, opts.leaseMs ?? 30_000);
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
    void this.loop().catch((err) => {
      this.running = false;
      this.reportError(err);
    });
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    let seenVersion = this.queue.snapshot().version;
    while (this.running) {
      try {
        await this.tick();
        const current = this.queue.snapshot();
        seenVersion = current.version;
        if (current.queued > 0 && this.active.size < this.concurrency) {
          continue;
        }
        if (this.active.size > 0) {
          if (this.active.size >= this.concurrency || current.queued === 0) {
            await Promise.race(this.active.values());
            seenVersion = this.queue.snapshot().version;
            continue;
          }
        }
        const next = await this.queue.waitForWork({
          sinceVersion: seenVersion,
          timeoutMs: this.idleResyncMs,
        });
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

  private async tick(): Promise<void> {
    while (this.active.size < this.concurrency) {
      const leased = await this.queue.leaseNext({
        workerId: this.workerId,
        leaseMs: this.leaseMs,
      });
      if (!leased) break;
      const runPromise = this.runLeased(leased)
        .catch((err) => {
          this.reportError(err);
        })
        .finally(() => {
          this.active.delete(leased.id);
        });
      this.active.set(leased.id, runPromise);
    }
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

    await this.queue.heartbeat(job.id, this.workerId, this.leaseMs);

    const heartbeat = setInterval(() => {
      void this.queue.heartbeat(job.id, this.workerId, this.leaseMs).catch((err) => {
        this.reportError(err);
      });
    }, Math.max(1_000, Math.floor(this.leaseMs / 2)));

    try {
      const handler = this.handlers[job.agentId];
      if (!handler) {
        await this.queue.fail(job.id, this.workerId, `No handler for agent '${job.agentId}'`, true);
        return;
      }

      const result = await handler(job, {
        workerId: this.workerId,
        pullCommands,
      });
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
      const message = err instanceof Error ? err.message : String(err);
      await this.queue.fail(job.id, this.workerId, message);
    } finally {
      clearInterval(heartbeat);
    }
  }
}
