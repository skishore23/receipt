import type {
  FactoryCandidateRecord,
  FactoryTaskCompletionRecord,
  FactoryTaskRecord,
  FactoryState,
} from "../../modules/factory";

const latestTaskCandidate = (
  state: FactoryState,
  taskId: string,
): FactoryCandidateRecord | undefined => {
  for (let index = state.candidateOrder.length - 1; index >= 0; index -= 1) {
    const candidateId = state.candidateOrder[index];
    const candidate = state.candidates[candidateId];
    if (candidate?.taskId === taskId) return candidate;
  }
  return undefined;
};

export const factoryTaskCompletionForTask = (
  state: FactoryState,
  taskId: string,
): FactoryTaskCompletionRecord | undefined =>
  state.investigation.reports[taskId]?.completion
  ?? latestTaskCandidate(state, taskId)?.completion;

export const factoryPromotionGateBlockedReason = (
  state: FactoryState,
): string | undefined => {
  if (state.objectiveMode === "investigation") return undefined;
  if (!state.planning) return "Promotion gate blocked: planning receipt is missing.";
  const tasks = state.workflow.taskIds
    .map((taskId) => state.workflow.tasksById[taskId])
    .filter((task): task is FactoryTaskRecord => Boolean(task));
  if (tasks.some((task) => task.status === "blocked")) {
    const blockedTask = tasks.find((task) => task.status === "blocked");
    return `Promotion gate blocked: ${blockedTask?.taskId ?? "a task"} is still blocked.`;
  }
  const integratedTasks = tasks.filter((task) => task.status === "integrated");
  if (integratedTasks.length === 0) return "Promotion gate blocked: no integrated task satisfied the objective.";
  for (const task of integratedTasks) {
    const completion = factoryTaskCompletionForTask(state, task.taskId);
    if (!completion) return `Promotion gate blocked: ${task.taskId} is missing its completion contract.`;
    if (completion.proof.length === 0) return `Promotion gate blocked: ${task.taskId} did not record proof for the completed work.`;
    if (completion.remaining.length > 0) return `Promotion gate blocked: ${task.taskId} still reports remaining work.`;
  }
  return undefined;
};
