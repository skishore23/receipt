import type { Runtime } from "../core/runtime.js";
import { runAgentLoop, type ModernAgentSpec } from "../engine/runtime/agent-loop.js";
import { runWorkflow, type RunEvent, type RunLifecycle, type RunState, type WorkflowContext } from "../engine/runtime/workflow.js";
import type { ReceiptDeclaration } from "./receipt.js";

export type { ModernAgentSpec } from "../engine/runtime/agent-loop.js";

type LifecycleShape<Deps, Event extends RunEvent, State extends RunState, Config> =
  Omit<RunLifecycle<Deps, Event, State, Config>, "reducer" | "initial">;

export type LegacyAgentSpec<
  Cmd,
  Deps extends { runtime: Runtime<Cmd, Event, State> },
  Event extends RunEvent,
  State extends RunState,
  Config
> = {
  readonly id: string;
  readonly version: string;
  readonly reducer: RunLifecycle<Deps, Event, State, Config>["reducer"];
  readonly initial: State;
  readonly lifecycle: LifecycleShape<Deps, Event, State, Config>;
  readonly run: (ctx: WorkflowContext<Deps, Event, State>, config: Config) => Promise<void>;
};

export type AgentSpec<
  Cmd,
  Deps extends { runtime: Runtime<Cmd, Event, State> },
  Event extends RunEvent,
  State extends RunState,
  Config
> = LegacyAgentSpec<Cmd, Deps, Event, State, Config>
  | ModernAgentSpec<Readonly<Record<string, ReceiptDeclaration<unknown>>>, unknown, Record<string, unknown>>;

export type RunAgentInput<
  Cmd,
  Deps extends { runtime: Runtime<Cmd, Event, State> },
  Event extends RunEvent,
  State extends RunState,
  Config
> = {
  readonly spec: AgentSpec<Cmd, Deps, Event, State, Config>;
  readonly ctx: WorkflowContext<Deps, Event, State>;
  readonly config: Config;
  readonly deps?: Record<string, unknown>;
  readonly wrap?: (event: Event, meta: { readonly eventId: string; readonly expectedPrev?: string }) => Cmd;
};

export function defineAgent<
  Cmd,
  Deps extends { runtime: Runtime<Cmd, Event, State> },
  Event extends RunEvent,
  State extends RunState,
  Config
>(
  spec: LegacyAgentSpec<Cmd, Deps, Event, State, Config>
): LegacyAgentSpec<Cmd, Deps, Event, State, Config>;
export function defineAgent<
  Receipts extends Readonly<Record<string, ReceiptDeclaration<unknown>>>,
  View,
  Deps extends Record<string, unknown>
>(
  spec: ModernAgentSpec<Receipts, View, Deps>
): ModernAgentSpec<Receipts, View, Deps>;
export function defineAgent(spec: unknown): unknown {
  return spec;
}

const isLegacySpec = (spec: unknown): spec is LegacyAgentSpec<unknown, { runtime: Runtime<unknown, RunEvent, RunState> }, RunEvent, RunState, unknown> =>
  typeof spec === "object"
  && spec !== null
  && "lifecycle" in spec
  && "reducer" in spec
  && "initial" in spec;

const defaultWrap = <Cmd, Event extends { readonly type: string }>(
  event: Event,
  meta: { readonly eventId: string; readonly expectedPrev?: string }
): Cmd => ({
  type: "emit",
  event,
  eventId: meta.eventId,
  expectedPrev: meta.expectedPrev,
} as Cmd);

export async function runDefinedAgent<
  Cmd,
  Deps extends { runtime: Runtime<Cmd, Event, State> },
  Event extends RunEvent,
  State extends RunState,
  Config
>(
  input: RunAgentInput<Cmd, Deps, Event, State, Config>
): Promise<void> {
  const { spec, ctx, config } = input;

  if (isLegacySpec(spec)) {
    const legacy = spec as LegacyAgentSpec<Cmd, Deps, Event, State, Config>;
    const lifecycle: RunLifecycle<Deps, Event, State, Config> = {
      reducer: legacy.reducer,
      initial: legacy.initial,
      init: legacy.lifecycle.init,
      resume: legacy.lifecycle.resume,
      shouldIndex: legacy.lifecycle.shouldIndex,
    };

    await runWorkflow<Cmd, Deps, Config, Event, State>(
      {
        id: legacy.id,
        version: legacy.version,
        lifecycle,
        run: legacy.run,
      },
      ctx,
      config
    );
    return;
  }

  await runAgentLoop({
    spec: spec as unknown as ModernAgentSpec<Readonly<Record<string, ReceiptDeclaration<unknown>>>, unknown, Record<string, unknown>>,
    runtime: ctx.runtime as unknown as Runtime<Cmd, Event, State>,
    stream: ctx.stream,
    runId: ctx.runId,
    wrap: (input.wrap ?? defaultWrap<Cmd, Event>) as (event: Event, meta: { readonly eventId: string; readonly expectedPrev?: string }) => Cmd,
    deps: (input.deps ?? {}) as Record<string, unknown>,
    now: ctx.now,
  });
}

export const goal = <View>(fn: (ctx: { readonly view: View }) => boolean): ((ctx: { readonly view: View }) => boolean) => fn;
