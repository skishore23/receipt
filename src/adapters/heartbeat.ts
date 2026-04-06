// ============================================================================
// Heartbeat - interval-based autonomous job enqueuer
// ============================================================================

import type { JobLane } from "../modules/job";

export type HeartbeatSpec = {
  readonly id: string;
  readonly agentId: string;
  readonly intervalMs: number;
  readonly payload: Record<string, unknown>;
  readonly lane?: JobLane;
  readonly sessionKey?: string;
  readonly singletonMode?: "allow" | "cancel" | "steer";
  readonly maxAttempts?: number;
};

export type HeartbeatDeps = {
  readonly enqueue: (opts: {
    readonly agentId: string;
    readonly payload: Record<string, unknown>;
    readonly lane: JobLane;
    readonly sessionKey?: string;
    readonly singletonMode: "allow" | "cancel" | "steer";
    readonly maxAttempts: number;
  }) => Promise<{ readonly id: string }>;
};

export type Heartbeat = {
  readonly start: () => void;
  readonly stop: () => void;
};

export const parseHeartbeatSpecsFromEnv = (env: NodeJS.ProcessEnv): ReadonlyArray<HeartbeatSpec> => {
  const specs: HeartbeatSpec[] = [];
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^HEARTBEAT_(\w+)_INTERVAL_MS$/);
    if (!match || !value) continue;
    const agentId = match[1].toLowerCase();
    const intervalMs = Number(value);
    if (!Number.isFinite(intervalMs) || intervalMs < 1_000) continue;
    specs.push({
      id: `heartbeat:${agentId}`,
      agentId,
      intervalMs,
      lane: "collect",
      singletonMode: "cancel",
      sessionKey: `heartbeat:${agentId}`,
      maxAttempts: 1,
      payload: { kind: `${agentId}.heartbeat` },
    });
  }
  return specs;
};

export const createHeartbeat = (spec: HeartbeatSpec, deps: HeartbeatDeps): Heartbeat => {
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start: () => {
      if (timer) return;
      timer = setInterval(() => {
        void deps.enqueue({
          agentId: spec.agentId,
          payload: spec.payload,
          lane: spec.lane ?? "collect",
          sessionKey: spec.sessionKey,
          singletonMode: spec.singletonMode ?? "cancel",
          maxAttempts: spec.maxAttempts ?? 1,
        }).catch((err) => {
          console.error(`heartbeat enqueue failed (${spec.id})`, err);
          if (timer) {
            clearInterval(timer);
            timer = undefined;
          }
        });
      }, spec.intervalMs);
    },
    stop: () => {
      if (timer) { clearInterval(timer); timer = undefined; }
    },
  };
};
