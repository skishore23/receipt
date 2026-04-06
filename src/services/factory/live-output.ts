import type { FactoryTaskStatus } from "../../modules/factory";
import type { FactoryLiveOutputTargetKind, FactoryObjectiveDetail } from "../factory-types";

const isActiveJobStatus = (status?: string): boolean =>
  status === "queued" || status === "leased" || status === "running";

export const isTerminalTaskStatus = (status?: FactoryTaskStatus): boolean =>
  status === "approved" || status === "integrated" || status === "blocked" || status === "superseded";

export const inferObjectiveLiveOutputFocusFromDetail = (detail: FactoryObjectiveDetail): {
  readonly focusKind: FactoryLiveOutputTargetKind;
  readonly focusId: string;
  readonly inferredBy: "single_active_task" | "single_nonterminal_task" | "single_task";
} | undefined => {
  const activeTasks = detail.tasks.filter((task) =>
    isActiveJobStatus(task.jobStatus)
    || task.status === "running"
    || task.status === "reviewing");
  if (activeTasks.length === 1) {
    return {
      focusKind: "task",
      focusId: activeTasks[0]!.taskId,
      inferredBy: "single_active_task",
    };
  }

  const nonterminalTasks = detail.tasks.filter((task) => !isTerminalTaskStatus(task.status));
  if (nonterminalTasks.length === 1) {
    return {
      focusKind: "task",
      focusId: nonterminalTasks[0]!.taskId,
      inferredBy: "single_nonterminal_task",
    };
  }

  if (detail.tasks.length === 1) {
    return {
      focusKind: "task",
      focusId: detail.tasks[0]!.taskId,
      inferredBy: "single_task",
    };
  }

  return undefined;
};
