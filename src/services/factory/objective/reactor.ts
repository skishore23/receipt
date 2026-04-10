import type {
  FactoryEvent,
  FactoryObjectiveStatus,
  FactoryState,
} from "../../../modules/factory";
import type {
  FactoryObjectivePlannerFacts,
  FactoryPlannerEffect,
} from "../effects";
import { planObjectiveReact } from "../planner";
import {
  selectFactoryRebracketEffect,
  type FactoryRebracketEffect,
  type FactoryRebracketSelection,
} from "../rebracket-policy";

type FactoryObjectiveDispatchEffect = Extract<FactoryPlannerEffect, { readonly type: "task.dispatch" }>;
type FactoryObjectiveFinalEffect = Exclude<FactoryRebracketEffect, { readonly type: "task.dispatch" }>;

export type FactoryObjectiveReactorOps = {
  readonly getObjectiveState: (objectiveId: string) => Promise<FactoryState>;
  readonly isTerminalObjectiveStatus: (status: FactoryObjectiveStatus) => boolean;
  readonly rebalanceObjectiveSlots: () => Promise<void>;
  readonly syncFailedActiveTasks: (state: FactoryState) => Promise<void>;
  readonly syncActiveTaskMonitors: (state: FactoryState) => Promise<void>;
  readonly redriveQueuedActiveTasks: (state: FactoryState) => Promise<void>;
  readonly stampCircuitBrokenTasks: (state: FactoryState) => Promise<void>;
  readonly derivePolicyBlockedReason: (state: FactoryState) => string | undefined;
  readonly buildObjectiveBlockedEvents: (state: FactoryState, reason: string) => Promise<ReadonlyArray<FactoryEvent>>;
  readonly emitObjectiveBatch: (objectiveId: string, events: ReadonlyArray<FactoryEvent>, expectedPrev?: string) => Promise<void>;
  readonly syncInvestigationSynthesisIfReady: (state: FactoryState) => Promise<boolean>;
  readonly collectObjectivePlannerFacts: (state: FactoryState) => Promise<FactoryObjectivePlannerFacts>;
  readonly applyObjectivePreparationEffects: (
    state: FactoryState,
    effects: ReadonlyArray<FactoryPlannerEffect>,
    facts: FactoryObjectivePlannerFacts,
  ) => Promise<boolean>;
  readonly applyObjectiveDispatchEffect: (
    state: FactoryState,
    effect: FactoryObjectiveDispatchEffect,
    selection?: FactoryRebracketSelection,
  ) => Promise<"applied" | "reconcile_scheduled">;
  readonly applyObjectiveFinalEffect: (
    state: FactoryState,
    effect: FactoryObjectiveFinalEffect,
    selection?: FactoryRebracketSelection,
  ) => Promise<"applied" | "retried" | "asked_human" | "reconcile_scheduled">;
};

export const reactFactoryObjective = async (
  objectiveId: string,
  ops: FactoryObjectiveReactorOps,
): Promise<void> => {
  await ops.rebalanceObjectiveSlots();
  const refreshState = () => ops.getObjectiveState(objectiveId);
  let state = await refreshState();

  if (ops.isTerminalObjectiveStatus(state.status)) {
    await ops.rebalanceObjectiveSlots();
    return;
  }
  if (state.scheduler.slotState === "queued") return;

  await ops.syncFailedActiveTasks(state);
  await ops.syncActiveTaskMonitors(state);
  await ops.redriveQueuedActiveTasks(state);
  state = await refreshState();
  if (ops.isTerminalObjectiveStatus(state.status)) {
    await ops.rebalanceObjectiveSlots();
    return;
  }

  await ops.stampCircuitBrokenTasks(state);
  state = await refreshState();

  const elapsedBlockedReason = ops.derivePolicyBlockedReason(state);
  if (elapsedBlockedReason) {
    await ops.emitObjectiveBatch(objectiveId, await ops.buildObjectiveBlockedEvents(state, elapsedBlockedReason));
    await ops.rebalanceObjectiveSlots();
    return;
  }

  let plannerPasses = 0;
  while (plannerPasses < 64) {
    plannerPasses += 1;
    state = await refreshState();
    if (ops.isTerminalObjectiveStatus(state.status) || state.scheduler.slotState === "queued") break;

    if (await ops.syncInvestigationSynthesisIfReady(state)) continue;
    state = await refreshState();
    if (ops.isTerminalObjectiveStatus(state.status) || state.scheduler.slotState === "queued") break;

    const facts = await ops.collectObjectivePlannerFacts(state);
    const effects = planObjectiveReact({
      state,
      facts,
    });
    if (await ops.applyObjectivePreparationEffects(state, effects, facts)) continue;
    if (effects.length === 0) break;

    const selected = selectFactoryRebracketEffect({
      state,
      facts,
      effects,
    });
    if (!selected) break;

    if (selected.effect.type === "task.dispatch") {
      const outcome = await ops.applyObjectiveDispatchEffect(state, selected.effect, selected);
      if (outcome === "reconcile_scheduled") {
        await ops.rebalanceObjectiveSlots();
        return;
      }
      continue;
    }

    const outcome = await ops.applyObjectiveFinalEffect(state, selected.effect, selected);
    if (outcome === "retried") {
      await reactFactoryObjective(objectiveId, ops);
      return;
    }
    if (outcome === "asked_human") {
      await ops.rebalanceObjectiveSlots();
      return;
    }
    if (outcome === "reconcile_scheduled") {
      await ops.rebalanceObjectiveSlots();
      return;
    }
  }

  await ops.rebalanceObjectiveSlots();
};
