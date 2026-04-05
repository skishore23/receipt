import type { FactoryState, FactoryTaskRecord } from "../../../modules/factory";

export const resolveTaskBaseCommit = (
  state: FactoryState,
  task: FactoryTaskRecord,
): string => {
  if (task.candidateId) {
    const candidate = state.candidates[task.candidateId];
    if (candidate?.headCommit) return candidate.headCommit;
  }
  return state.integration.headCommit ?? task.baseCommit ?? state.baseHash;
};

export const taskPromptPath = (workspacePath: string, targetPath: string): string => {
  void workspacePath;
  return targetPath;
};
