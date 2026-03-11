// ============================================================================
// Background Job Worker - queue polling + leased execution + retries
// ============================================================================

import type { QueueCommandRecord, QueueJob, JsonlQueue } from "../../adapters/jsonl-queue.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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
  private readonly pollMs: number;
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
    this.pollMs = Math.max(50, opts.pollMs ?? 250);
    this.leaseMs = Math.max(5_000, opts.leaseMs ?? 30_000);
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.onTick = opts.onTick;
    this.onError = opts.onError;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop().catch((err) => {
      this.running = false;
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(error);
    });
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } finally {
        if (this.onTick) this.onTick();
      }
      await sleep(this.pollMs);
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
          this.running = false;
          const error = err instanceof Error ? err : new Error(String(err));
          this.onError?.(error);
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
      void this.queue.heartbeat(job.id, this.workerId, this.leaseMs);
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
