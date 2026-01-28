// ============================================================================
// Workflow runner - minimal orchestration harness
//
// Keeps workflows reusable while staying Receipt-native.
// ============================================================================

import type { Runtime } from "../core/runtime.js";

export type EmitFn<Event> = (event: Event) => Promise<void>;

export type WorkflowContext<Deps, Event> = Deps & {
  readonly stream: string;
  readonly runId: string;
  readonly emit: EmitFn<Event>;
  readonly now: () => number;
};

export type WorkflowSpec<Deps, Config, Event> = {
  readonly id: string;
  readonly version: string;
  readonly run: (ctx: WorkflowContext<Deps, Event>, config: Config) => Promise<void>;
};

export const createQueuedEmitter = <Cmd, Event, State>(opts: {
  readonly runtime: Runtime<Cmd, Event, State>;
  readonly stream: string;
  readonly wrap: (event: Event) => Cmd;
  readonly onEmit?: (event: Event) => void | Promise<void>;
  readonly onError?: (err: unknown) => void;
}): EmitFn<Event> => {
  let queue = Promise.resolve();
  return (event: Event) => {
    queue = queue
      .then(async () => {
        await opts.runtime.execute(opts.stream, opts.wrap(event));
        if (opts.onEmit) await opts.onEmit(event);
      })
      .catch((err) => {
        if (opts.onError) opts.onError(err);
        else console.error("emit failed", err);
      });
    return queue;
  };
};

export const runWorkflow = async <Deps, Config, Event>(
  spec: WorkflowSpec<Deps, Config, Event>,
  ctx: WorkflowContext<Deps, Event>,
  config: Config
): Promise<void> => {
  await spec.run(ctx, config);
};
