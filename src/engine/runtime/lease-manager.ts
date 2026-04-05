import type { JsonlQueue } from "../../adapters/jsonl-queue";

export type LeaseRenewalEvent =
  | { readonly type: "renew_success"; readonly jobId: string; readonly leaseId: string; readonly leaseUntil?: number }
  | { readonly type: "renew_failure"; readonly jobId: string; readonly leaseId: string; readonly consecutiveFailures: number; readonly error: Error }
  | { readonly type: "time_to_lease_expiry"; readonly jobId: string; readonly leaseId: string; readonly millis: number };

export type LeaseKeepaliveOptions = {
  readonly queue: Pick<JsonlQueue, "heartbeat" | "getJob">;
  readonly jobId: string;
  readonly leaseId: string;
  readonly workerId: string;
  readonly ttlMs: number;
  readonly onError?: (error: Error) => void;
  readonly onEvent?: (event: LeaseRenewalEvent) => void;
};

type KeepaliveHandle = {
  readonly stop: () => void;
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const jitter = (value: number): number => {
  const spread = Math.max(1, Math.floor(value * 0.15));
  return clamp(value + Math.floor((Math.random() * (spread * 2 + 1)) - spread), 250, value * 2);
};

export const startKeepalive = (opts: LeaseKeepaliveOptions): KeepaliveHandle => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let consecutiveFailures = 0;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, Math.max(0, delayMs));
  };

  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };

  const renewOnce = async (): Promise<boolean> => {
    const startedAt = Date.now();
    const remaining = Math.max(0, opts.ttlMs - startedAt);
    opts.onEvent?.({ type: "time_to_lease_expiry", jobId: opts.jobId, leaseId: opts.leaseId, millis: remaining });
    const current = await opts.queue.heartbeat(opts.jobId, opts.workerId, opts.ttlMs);
    if (!current || current.id !== opts.jobId) {
      throw new Error(`lease ${opts.leaseId} could not be renewed for job ${opts.jobId}`);
    }
    consecutiveFailures = 0;
    opts.onEvent?.({ type: "renew_success", jobId: opts.jobId, leaseId: opts.leaseId, leaseUntil: current.leaseUntil });
    return true;
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    inFlight = inFlight.then(async () => {
      if (stopped) return;
      let backoffMs = clamp(Math.floor(opts.ttlMs / 10), 250, 5_000);
      for (let attempt = 0; !stopped; attempt += 1) {
        try {
          const renewed = await renewOnce();
          if (!renewed) return;
          schedule(jitter(Math.floor(opts.ttlMs / 3)));
          return;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          consecutiveFailures += 1;
          opts.onEvent?.({ type: "renew_failure", jobId: opts.jobId, leaseId: opts.leaseId, consecutiveFailures, error });
          opts.onError?.(new Error(`lease keepalive failed for job ${opts.jobId} (attempt ${consecutiveFailures}): ${error.message}`));
          if (consecutiveFailures >= 3) {
            stop();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          backoffMs = clamp(backoffMs * 2, 250, 10_000);
        }
      }
    });
    await inFlight;
  };

  schedule(0);
  return { stop };
};
