import type { Runtime } from "@receipt/core/runtime.js";
import type { Chain } from "@receipt/core/types.js";

export const clampNumber = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const parseFormNum = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

export type AgentRunCommand = {
  readonly command: "steer" | "follow_up";
  readonly payload?: Record<string, unknown>;
};

export type AgentRunControl = {
  readonly jobId?: string;
  readonly checkAbort?: () => Promise<boolean>;
  readonly pullCommands?: () => Promise<ReadonlyArray<AgentRunCommand>>;
};

export const getLatestRunId = <Event extends { readonly type: string; readonly runId?: string }>(
  chain: Chain<Event>,
  startType = "problem.set"
): string | undefined => {
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const event = chain[i].body;
    if (event.type === startType && event.runId) return event.runId;
  }
  return undefined;
};

export const runStream = (base: string, runId: string): string =>
  `${base}/runs/${runId}`;

export const branchStream = (base: string, branchId: string): string =>
  `${base}/branches/${branchId}`;

export type EmitFn<Event> = (event: Event) => Promise<void>;

export const createQueuedEmitter = <Cmd, Event, State>(opts: {
  readonly runtime: Runtime<Cmd, Event, State>;
  readonly stream: string;
  readonly wrap: (event: Event, meta: { readonly eventId: string }) => Cmd;
  readonly onEmit?: (event: Event) => void | Promise<void>;
  readonly onError?: (err: unknown) => void;
}): EmitFn<Event> => {
  let queue = Promise.resolve();
  let seq = 0;

  const nextEventId = () => {
    seq += 1;
    return `${opts.stream}:${Date.now().toString(36)}:${seq.toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  };

  return (event: Event) => {
    const eventId = nextEventId();
    queue = queue
      .then(async () => {
        await opts.runtime.execute(opts.stream, opts.wrap(event, { eventId }));
        if (opts.onEmit) await opts.onEmit(event);
      })
      .catch((err) => {
        if (opts.onError) opts.onError(err);
        else console.error("emit failed", err);
        throw err;
      });
    return queue;
  };
};
