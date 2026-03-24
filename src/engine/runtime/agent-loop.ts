import type { Runtime } from "@receipt/core/runtime";
import type { Chain } from "@receipt/core/types";
import type { AgentAction } from "../../sdk/actions";
import type { MergePolicy } from "../../sdk/merge";
import type { ReceiptBody, ReceiptDeclaration } from "../../sdk/receipt";
import { runMergePolicy } from "../merge/policy";
import { CONTROL_POLICY_VERSION, type ControlReceipt } from "./control-receipts";
import { SCHEDULER_POLICY_VERSION, selectDeterministicActions } from "./scheduler-policy";

type AnyEvent = {
  readonly type: string;
  readonly [key: string]: unknown;
};

type ReceiptMap = Readonly<Record<string, ReceiptDeclaration<unknown>>>;

type DomainEvent<Receipts extends ReceiptMap> = {
  [K in keyof Receipts & string]: { readonly type: K } & ReceiptBody<Receipts[K]>;
}[keyof Receipts & string];

type ViewHelpers<Receipts extends ReceiptMap> = {
  readonly on: <K extends keyof Receipts & string>(type: K) => {
    readonly all: () => ReadonlyArray<DomainEvent<Receipts> & { readonly type: K }>;
    readonly last: () => (DomainEvent<Receipts> & { readonly type: K }) | undefined;
    readonly exists: () => boolean;
  };
  readonly chain: () => Chain<AnyEvent>;
};

type MergeResult = ReturnType<typeof runMergePolicy<any, any>>;

export type ModernAgentSpec<
  Receipts extends ReceiptMap,
  View,
  Deps extends Record<string, unknown> = Record<string, unknown>
> = {
  readonly id: string;
  readonly version: string;
  readonly receipts: Receipts;
  readonly view: (helpers: ViewHelpers<Receipts>) => View;
  readonly actions: (deps: Deps) => ReadonlyArray<AgentAction<View, <K extends keyof Receipts & string>(type: K, body: ReceiptBody<Receipts[K]>) => Promise<void> | void>>;
  readonly goal: (ctx: { readonly view: View }) => boolean;
  readonly mergePolicy?: MergePolicy<{ readonly view: View; readonly chain: Chain<AnyEvent>; readonly runId: string }, any>;
  readonly onMergeResult?: (ctx: {
    readonly view: View;
    readonly chain: Chain<AnyEvent>;
    readonly runId: string;
    readonly result: MergeResult;
    readonly deps: Deps;
    readonly emit: <K extends keyof Receipts & string>(type: K, body: ReceiptBody<Receipts[K]>) => Promise<void>;
  }) => Promise<void> | void;
  readonly runtimePolicyVersion?: string;
  readonly maxIterations?: number;
  readonly maxConcurrency?: number;
};

export type AgentLoopInput<
  Cmd,
  Event extends AnyEvent,
  State,
  Receipts extends ReceiptMap,
  View,
  Deps extends Record<string, unknown>
> = {
  readonly spec: ModernAgentSpec<Receipts, View, Deps>;
  readonly runtime: Runtime<Cmd, Event, State>;
  readonly stream: string;
  readonly runId: string;
  readonly wrap: (event: Event, meta: { readonly eventId: string; readonly expectedPrev?: string }) => Cmd;
  readonly deps: Deps;
  readonly now?: () => number;
  readonly afterEmit?: (event: Event | ControlReceipt) => void | Promise<void>;
};

const toErrorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const isEventType = (event: AnyEvent, type: string): boolean => event.type === type;

const buildView = <Receipts extends ReceiptMap, View>(
  chain: Chain<AnyEvent>,
  spec: ModernAgentSpec<Receipts, View, Record<string, unknown>>
): View => {
  const helpers: ViewHelpers<Receipts> = {
    on: (type) => ({
      all: () => chain
        .map((receipt) => receipt.body)
        .filter((body): body is DomainEvent<Receipts> & { readonly type: typeof type } => isEventType(body, type)),
      last: () => {
        for (let i = chain.length - 1; i >= 0; i -= 1) {
          const body = chain[i]?.body;
          if (body && isEventType(body, type)) {
            return body as DomainEvent<Receipts> & { readonly type: typeof type };
          }
        }
        return undefined;
      },
      exists: () => chain.some((receipt) => isEventType(receipt.body, type)),
    }),
    chain: () => chain,
  };

  return spec.view(helpers);
};

export const runAgentLoop = async <
  Cmd,
  Event extends AnyEvent,
  State,
  Receipts extends ReceiptMap,
  View,
  Deps extends Record<string, unknown>
>(
  input: AgentLoopInput<Cmd, Event, State, Receipts, View, Deps>
): Promise<void> => {
  const now = input.now ?? Date.now;
  let seq = 0;

  const nextEventId = (): string => {
    seq += 1;
    return `${input.stream}:${now().toString(36)}:${seq.toString(36)}`;
  };

  const emit = async (event: Event | ControlReceipt): Promise<void> => {
    await input.runtime.execute(
      input.stream,
      input.wrap(event as Event, { eventId: nextEventId() })
    );
    if (input.afterEmit) await input.afterEmit(event);
  };

  const spec = input.spec;
  const policyVersion = spec.runtimePolicyVersion ?? CONTROL_POLICY_VERSION;

  await emit({
    type: "run.started",
    runId: input.runId,
    agentId: spec.id,
    agentVersion: spec.version,
    runtimePolicyVersion: policyVersion,
    mergePolicyVersion: spec.mergePolicy?.version,
  });

  const maxIterations = Math.max(1, spec.maxIterations ?? 200);

  const applyMergePolicy = async (
    mergeChain: Chain<AnyEvent>,
    mergeView: View,
    emitDomain: <K extends keyof Receipts & string>(type: K, body: ReceiptBody<Receipts[K]>) => Promise<void>,
  ): Promise<boolean> => {
    if (!spec.mergePolicy) return false;
    if (!(spec.mergePolicy.shouldRecompute?.({ view: mergeView, chain: mergeChain, runId: input.runId }) ?? true)) {
      return false;
    }
    const candidates = spec.mergePolicy.candidates({ view: mergeView, chain: mergeChain, runId: input.runId });
    if (candidates.length === 0) return false;
    const mergeResult = runMergePolicy(spec.mergePolicy, { view: mergeView, chain: mergeChain, runId: input.runId });
    if (spec.onMergeResult) {
      await spec.onMergeResult({
        view: mergeView,
        chain: mergeChain,
        runId: input.runId,
        result: mergeResult,
        deps: input.deps,
        emit: emitDomain,
      });
    } else {
      await emit({
        type: "merge.applied",
        runId: input.runId,
        mergePolicyId: spec.mergePolicy.id,
        mergePolicyVersion: spec.mergePolicy.version,
        candidateId: mergeResult.decision.candidateId,
        reason: mergeResult.decision.reason,
      });
    }
    return true;
  };

  for (let iter = 0; iter < maxIterations; iter += 1) {
    const chain = await input.runtime.chain(input.stream) as Chain<AnyEvent>;
    const view = buildView(chain, spec as ModernAgentSpec<Receipts, View, Record<string, unknown>>);
    const emitDomain = <K extends keyof Receipts & string>(
      type: K,
      body: ReceiptBody<Receipts[K]>
    ): Promise<void> => emit({ type, ...(body as Record<string, unknown>) } as unknown as Event);

    if (spec.goal({ view })) {
      await emit({ type: "goal.completed", runId: input.runId });
      await emit({ type: "run.completed", runId: input.runId });
      return;
    }

    const actionList = [...spec.actions(input.deps)];
    const runnable = actionList.filter((candidate) => (candidate.when ? candidate.when({ view }) : true));
    const selection = selectDeterministicActions(runnable, spec.maxConcurrency ?? 1);

    await emit({
      type: "action.selected",
      runId: input.runId,
      actionIds: selection.selected.map((action) => action.id),
      reason: `${selection.reason} (${SCHEDULER_POLICY_VERSION})`,
      policyVersion: SCHEDULER_POLICY_VERSION,
    });

    if (selection.selected.length === 0) {
      const mergeChain = await input.runtime.chain(input.stream) as Chain<AnyEvent>;
      const mergeView = buildView(mergeChain, spec as ModernAgentSpec<Receipts, View, Record<string, unknown>>);
      const mergeApplied = await applyMergePolicy(mergeChain, mergeView, emitDomain);
      if (mergeApplied) continue;
      await emit({ type: "run.completed", runId: input.runId, note: "settled: no runnable actions" });
      return;
    }

    for (const current of selection.selected) {
      await emit({ type: "action.started", runId: input.runId, actionId: current.id, kind: current.kind });
      if (current.kind === "human") {
        await emit({ type: "human.requested", runId: input.runId, actionId: current.id });
      }

      try {
        const localEmits: Promise<void>[] = [];
        const bufferedEmitDomain = <K extends keyof Receipts & string>(
          type: K,
          body: ReceiptBody<Receipts[K]>
        ): Promise<void> => {
          const pending = emit({ type, ...(body as Record<string, unknown>) } as unknown as Event);
          localEmits.push(pending);
          return pending;
        };

        await current.run({
          ...(input.deps as Record<string, unknown>),
          view,
          emit: bufferedEmitDomain,
        } as Deps & { readonly view: View; readonly emit: typeof bufferedEmitDomain });

        await Promise.all(localEmits);

        if (current.kind === "human") {
          await emit({ type: "human.responded", runId: input.runId, actionId: current.id });
        }
        await emit({ type: "action.completed", runId: input.runId, actionId: current.id, kind: current.kind });
      } catch (err) {
        const error = toErrorMessage(err);
        await emit({ type: "action.failed", runId: input.runId, actionId: current.id, kind: current.kind, error });
        await emit({ type: "run.failed", runId: input.runId, error });
        throw err;
      }
    }

    const mergeChain = await input.runtime.chain(input.stream) as Chain<AnyEvent>;
    const mergeView = buildView(mergeChain, spec as ModernAgentSpec<Receipts, View, Record<string, unknown>>);
    await applyMergePolicy(mergeChain, mergeView, emitDomain);
  }

  await emit({
    type: "run.failed",
    runId: input.runId,
    error: `max iterations reached (${input.spec.maxIterations ?? 200})`,
  });
};
