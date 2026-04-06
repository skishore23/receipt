import type { FactoryState } from "../../modules/factory";

export type FactoryObjectiveControlHooks = {
  readonly getObjectiveState: (objectiveId: string) => Promise<FactoryState>;
  readonly isTerminalObjectiveStatus: (status: FactoryState["status"]) => boolean;
  readonly rebalanceObjectiveSlots: () => Promise<void>;
  readonly reactObjective: (objectiveId: string) => Promise<unknown>;
};

const continueActiveObjective = async (
  hooks: FactoryObjectiveControlHooks,
  objectiveId: string,
): Promise<void> => {
  await hooks.rebalanceObjectiveSlots();
  const state = await hooks.getObjectiveState(objectiveId);
  if (hooks.isTerminalObjectiveStatus(state.status) || state.status === "blocked") {
    await hooks.rebalanceObjectiveSlots();
    return;
  }
  if (state.scheduler.slotState !== "active") return;
  await hooks.reactObjective(objectiveId);
};

export const processObjectiveStartupControl = async (
  hooks: FactoryObjectiveControlHooks,
  objectiveId: string,
): Promise<void> =>
  continueActiveObjective(hooks, objectiveId);

export const processObjectiveReconcileControl = async (
  hooks: FactoryObjectiveControlHooks,
  objectiveId: string,
): Promise<void> =>
  continueActiveObjective(hooks, objectiveId);
