import type { Runtime } from "@receipt/core/runtime";
import { runAgentLoop, type ModernAgentSpec } from "../engine/runtime/agent-loop";
import type { ReceiptDeclaration } from "./receipt";

export type { ModernAgentSpec } from "../engine/runtime/agent-loop";

export type RunAgentInput<
  Cmd,
  Event extends { readonly type: string },
  State,
  Receipts extends Readonly<Record<string, ReceiptDeclaration<unknown>>>,
  View,
  Deps extends Record<string, unknown>
> = {
  readonly spec: ModernAgentSpec<Receipts, View, Deps>;
  readonly runtime: Runtime<Cmd, Event, State>;
  readonly stream: string;
  readonly runId: string;
  readonly deps: Deps;
  readonly remoteActionDeps?: Deps;
  readonly remoteActions?: Parameters<typeof runAgentLoop<Cmd, Event, State, Receipts, View, Deps>>[0]["remoteActions"];
  readonly now?: () => number;
  readonly wrap?: (event: Event, meta: { readonly eventId: string; readonly expectedPrev?: string }) => Cmd;
};

export function defineAgent<
  Receipts extends Readonly<Record<string, ReceiptDeclaration<unknown>>>,
  View,
  Deps extends Record<string, unknown>
>(
  spec: ModernAgentSpec<Receipts, View, Deps>
): ModernAgentSpec<Receipts, View, Deps> {
  return spec;
}

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
  Event extends { readonly type: string },
  State,
  Receipts extends Readonly<Record<string, ReceiptDeclaration<unknown>>>,
  View,
  Deps extends Record<string, unknown>
>(
  input: RunAgentInput<Cmd, Event, State, Receipts, View, Deps>
): Promise<void> {
  await runAgentLoop({
    spec: input.spec,
    runtime: input.runtime,
    stream: input.stream,
    runId: input.runId,
    wrap: input.wrap ?? defaultWrap<Cmd, Event>,
    deps: input.deps,
    remoteActionDeps: input.remoteActionDeps,
    remoteActions: input.remoteActions,
    now: input.now,
  });
}

export const goal = <View>(fn: (ctx: { readonly view: View }) => boolean): ((ctx: { readonly view: View }) => boolean) => fn;
