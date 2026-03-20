import type { Runtime } from "@receipt/core/runtime.js";
import { runAgentLoop, type ModernAgentSpec } from "../engine/runtime/agent-loop.js";
import type { ReceiptDeclaration } from "./receipt.js";

export type { ModernAgentSpec } from "../engine/runtime/agent-loop.js";

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
    now: input.now,
  });
}

export const goal = <View>(fn: (ctx: { readonly view: View }) => boolean): ((ctx: { readonly view: View }) => boolean) => fn;
