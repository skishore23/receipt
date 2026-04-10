import {
  factoryReadyTasks,
  type FactoryBudgetState,
  type FactoryObjectivePhase,
  type FactoryObjectiveStatus,
  type FactoryState,
  type FactoryTaskRecord,
} from "../../../modules/factory";
import type { FactoryObjectiveCard } from "../../factory-types";

export const objectiveElapsedMinutes = (state: FactoryState, now = Date.now()): number => {
  if (!state.createdAt) return 0;
  return Math.max(0, Math.floor((now - state.createdAt) / 60_000));
};

export const isTerminalObjectiveStatus = (status: FactoryObjectiveStatus): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

export const deriveObjectivePhase = (
  state: FactoryState,
  projection?: { readonly activeTasks: number; readonly readyTasks: number },
): FactoryObjectivePhase => {
  if (state.status === "completed") return "completed";
  if (state.status === "blocked" || state.status === "failed" || state.status === "canceled") return "blocked";
  if (state.status === "waiting_for_slot" || state.scheduler.slotState === "queued") return "waiting_for_slot";
  if (state.status === "integrating") return "integrating";
  if (state.status === "promoting" || state.integration.status === "ready_to_promote" || state.integration.status === "promoting" || state.integration.status === "promoted") {
    return "promoting";
  }
  if (state.status === "collecting_evidence" || state.status === "evidence_ready" || state.status === "synthesizing") {
    return state.status;
  }
  if (state.status === "planning") return "planning";
  if (projection && projection.activeTasks === 0 && projection.readyTasks === 0 && state.workflow.taskIds.length > 0) {
    return "blocked";
  }
  const activeTasks = state.workflow.activeTaskIds
    .map((taskId) => state.workflow.tasksById[taskId])
    .filter((task): task is FactoryTaskRecord => Boolean(task));
  const phases = new Set(activeTasks.map((task) => task.executionPhase ?? "collecting_evidence"));
  if (phases.has("synthesizing")) return "synthesizing";
  if (phases.has("evidence_ready")) return "evidence_ready";
  if (phases.has("collecting_evidence")) return "collecting_evidence";
  return "planning";
};

export const deriveLatestDecision = (state: FactoryState): FactoryObjectiveCard["latestDecision"] | undefined => {
  if (state.latestRebracket) {
    return {
      summary: state.latestRebracket.reason,
      at: state.latestRebracket.appliedAt,
      source: state.latestRebracket.source,
      selectedActionId: state.latestRebracket.selectedActionId,
    };
  }
  if (state.integration.status === "ready_to_promote" && state.integration.lastSummary) {
    return {
      summary: state.integration.lastSummary,
      at: state.integration.updatedAt,
      source: "system",
    };
  }
  return undefined;
};

export const deriveNextAction = (state: FactoryState, queuePosition?: number): string | undefined => {
  if (state.status === "completed") return state.objectiveMode === "investigation" ? "Investigation is complete." : "Objective is complete.";
  if (state.status === "canceled") return "Objective was canceled.";
  if (state.status === "failed") return "Objective failed.";
  if (state.status === "blocked") {
    return state.objectiveMode === "investigation"
      ? "Review the blocking receipt, adjust the investigation, or cancel the objective."
      : "Review the blocking receipt and react or cancel the objective.";
  }
  if (state.scheduler.slotState === "queued") {
    return queuePosition
      ? `Waiting for the repo execution slot (${queuePosition} in queue).`
      : "Waiting for the repo execution slot.";
  }
  if (state.wait?.kind === "control_reconcile") return state.wait.reason;
  if (state.wait?.kind === "synthesis_dispatch") return state.wait.reason;
  if (state.status === "planning") {
    return state.workflow.taskIds.length === 0
      ? "Preparing the objective."
      : "Preparing the next task attempt.";
  }
  if (state.integration.status === "ready_to_promote" && !state.policy.promotion.autoPromote) {
    return "Promote the integration branch into source when ready.";
  }
  if (state.integration.status === "conflicted") return "Review the integration conflict and react with the next task attempt.";
  const readyCount = factoryReadyTasks(state).length;
  if (readyCount > 0) {
    return readyCount === 1
      ? "One task is ready to dispatch."
      : `${readyCount} tasks are ready to dispatch.`;
  }
  if (state.workflow.activeTaskIds.length > 0) {
    const activeTasks = state.workflow.activeTaskIds
      .map((taskId) => state.workflow.tasksById[taskId])
      .filter((task): task is FactoryTaskRecord => Boolean(task));
    if (state.objectiveMode === "investigation") {
      if (activeTasks.some((task) => task.executionPhase === "synthesizing")) return "Wait for the synthesize-only pass to finish.";
      if (activeTasks.some((task) => task.executionPhase === "evidence_ready")) return "Controller has evidence and is preparing the synthesis pass.";
      return "Wait for evidence collection to finish.";
    }
    return "Wait for the active task pass to finish.";
  }
  if (state.integration.status === "queued" || state.integration.status === "merging" || state.integration.status === "validating") {
    return "Wait for integration validation to finish.";
  }
  return undefined;
};

export const buildBudgetState = (
  state: FactoryState,
  derivePolicyBlockedReason: (state: FactoryState, now: number) => string | undefined,
  now = Date.now(),
  policyBlockedReason?: string,
): FactoryBudgetState => {
  const failureEntries = Object.entries(state.consecutiveFailuresByTask).filter(([, value]) => value > 0);
  return {
    taskRunsUsed: state.taskRunsUsed,
    candidatePassesByTask: state.candidatePassesByTask,
    consecutiveFailuresByTask: failureEntries.length > 0
      ? Object.fromEntries(failureEntries)
      : {},
    elapsedMinutes: objectiveElapsedMinutes(state, now),
    lastDispatchAt: state.lastDispatchAt,
    policyBlockedReason: policyBlockedReason ?? derivePolicyBlockedReason(state, now),
  };
};
