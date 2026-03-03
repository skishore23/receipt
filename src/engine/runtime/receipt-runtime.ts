// ============================================================================
// Receipt Runtime - thin runWorkflow wrapper
// ============================================================================

import type { Reducer } from "../../core/types.js";
import type { Runtime } from "../../core/runtime.js";
import { runWorkflow, type RunEvent, type RunLifecycle, type RunState, type WorkflowContext } from "./workflow.js";

type LifecycleShape<Deps, Event extends RunEvent, State extends RunState, Config> =
  Omit<RunLifecycle<Deps, Event, State, Config>, "reducer" | "initial">;

export type ReceiptAgentSpec<
  Cmd,
  Deps extends { runtime: Runtime<Cmd, Event, State> },
  Event extends RunEvent,
  State extends RunState,
  Config
> = {
  readonly id: string;
  readonly version: string;
  readonly reducer: Reducer<State, Event>;
  readonly initial: State;
  readonly lifecycle: LifecycleShape<Deps, Event, State, Config>;
  readonly run: (ctx: WorkflowContext<Deps, Event, State>, config: Config) => Promise<void>;
};

export type RunReceiptAgentInput<
  Cmd,
  Deps extends { runtime: Runtime<Cmd, Event, State> },
  Event extends RunEvent,
  State extends RunState,
  Config
> = {
  readonly spec: ReceiptAgentSpec<Cmd, Deps, Event, State, Config>;
  readonly ctx: WorkflowContext<Deps, Event, State>;
  readonly config: Config;
};

export const defineReceiptAgent = <
  Cmd,
  Deps extends { runtime: Runtime<Cmd, Event, State> },
  Event extends RunEvent,
  State extends RunState,
  Config
>(
  spec: ReceiptAgentSpec<Cmd, Deps, Event, State, Config>
): ReceiptAgentSpec<Cmd, Deps, Event, State, Config> => spec;

export const runReceiptAgent = async <
  Cmd,
  Deps extends { runtime: Runtime<Cmd, Event, State> },
  Event extends RunEvent,
  State extends RunState,
  Config
>(
  input: RunReceiptAgentInput<Cmd, Deps, Event, State, Config>
): Promise<void> => {
  const { spec, ctx, config } = input;
  const lifecycle: RunLifecycle<Deps, Event, State, Config> = {
    reducer: spec.reducer,
    initial: spec.initial,
    init: spec.lifecycle.init,
    resume: spec.lifecycle.resume,
    shouldIndex: spec.lifecycle.shouldIndex,
  };

  await runWorkflow<Cmd, Deps, Config, Event, State>(
    {
      id: spec.id,
      version: spec.version,
      lifecycle,
      run: spec.run,
    },
    ctx as WorkflowContext<Deps, Event, State>,
    config
  );
};
