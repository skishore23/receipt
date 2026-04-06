import type { FactoryObjectiveMode, FactoryState, FactoryTaskRecord } from "../../../modules/factory";
import type { FactoryCloudProvider } from "../../factory-cloud-context";
import { rewriteInfrastructureTaskPromptForExecution } from "../../factory-infrastructure-guidance";

export const effectiveFactoryTaskPrompt = (input: {
  readonly profileCloudProvider?: FactoryCloudProvider;
  readonly objectiveMode: FactoryObjectiveMode;
  readonly taskPrompt: string;
}): string =>
  rewriteInfrastructureTaskPromptForExecution({
    profileCloudProvider: input.profileCloudProvider,
    objectiveMode: input.objectiveMode,
    taskPrompt: input.taskPrompt,
  });

export const factoryTaskOwnsBroadValidation = (
  task: Pick<FactoryTaskRecord, "title" | "prompt">,
): boolean => {
  const haystack = `${task.title}\n${task.prompt}`.toLowerCase();
  return haystack.includes("validation suite")
    || haystack.includes("run validation")
    || haystack.includes("lint")
    || haystack.includes("typecheck")
    || haystack.includes("build");
};

const shouldDeferBroadValidation = (
  state: FactoryState,
  task: FactoryTaskRecord,
): boolean => {
  if (factoryTaskOwnsBroadValidation(task)) return false;
  const taskIndex = state.workflow.taskIds.indexOf(task.taskId);
  const laterTaskIds = taskIndex >= 0 ? state.workflow.taskIds.slice(taskIndex + 1) : [];
  return laterTaskIds
    .map((taskId) => state.workflow.tasksById[taskId])
    .some((candidate) => Boolean(candidate) && factoryTaskOwnsBroadValidation(candidate));
};

export const renderFactoryTaskValidationSection = (
  state: FactoryState,
  task: FactoryTaskRecord,
): string[] => {
  if (state.objectiveMode === "investigation" && !factoryTaskOwnsBroadValidation(task)) {
    return [
      `## Validation Guidance`,
      `This is a CLI investigation task. Do not run the broad repo validation suite unless you changed repo files or this task explicitly owns validation.`,
      `Helper evidence files written under .receipt/ do not count as repo changes for this purpose and should not trigger bun run build, bun run verify, or the full repo suite.`,
      ...(state.checks.length > 0
        ? [
            `Reserved full-suite commands if later evidence requires them:`,
            state.checks.map((check) => `- ${check}`).join("\n"),
          ]
        : []),
    ];
  }
  if (!shouldDeferBroadValidation(state, task)) {
    return [
      `## Checks`,
      state.checks.map((check) => `- ${check}`).join("\n") || "- none",
      `Run the relevant repo validation for this task and capture failures precisely in the handoff.`,
    ];
  }
  return [
    `## Validation Guidance`,
    `A later task in this objective owns the broad repo validation suite.`,
    `Do not run the full repo checks here unless this task is itself the validation pass or a tiny targeted check is strictly needed to de-risk the change.`,
    ...(state.checks.length > 0
      ? [
          `Reserved full-suite commands for later:`,
          state.checks.map((check) => `- ${check}`).join("\n"),
        ]
      : []),
  ];
};
