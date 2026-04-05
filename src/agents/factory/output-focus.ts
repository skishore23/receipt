import type { FactoryService, FactoryObjectiveDetail } from "../../services/factory-service";
import { inferObjectiveLiveOutputFocusFromDetail } from "../../services/factory/live-output";

export type FactoryOutputFocus = {
  readonly focusKind: "task" | "job";
  readonly focusId: string;
};

export type FactoryOutputFocusResolutionInput = {
  readonly factoryService: Pick<FactoryService, "getObjective" | "inferObjectiveLiveOutputFocus">;
  readonly objectiveId: string;
  readonly taskId?: string;
  readonly jobId?: string;
  readonly focusKind?: string;
  readonly focusId?: string;
  readonly env?: NodeJS.ProcessEnv;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const buildAmbiguousError = (detail: FactoryObjectiveDetail): Error => {
  const taskIds = detail.tasks.map((task) => task.taskId);
  const exampleTaskId = taskIds[0];
  const example = exampleTaskId
    ? `Example: factory.output { objectiveId: "${detail.objectiveId}", taskId: "${exampleTaskId}" }`
    : undefined;
  return new Error([
    "factory.output requires focusKind/focusId, taskId/jobId, or an objective with exactly one task",
    `Available taskIds: ${taskIds.join(", ")}`,
    example,
  ].filter(Boolean).join(". "));
};

export const resolveFactoryOutputFocus = async (input: FactoryOutputFocusResolutionInput): Promise<FactoryOutputFocus> => {
  if (input.taskId) return { focusKind: "task", focusId: input.taskId };
  if (input.jobId) return { focusKind: "job", focusId: input.jobId };
  if (input.focusKind === "task" || input.focusKind === "job") {
    if (!input.focusId) throw new Error("factory.output requires focusId");
    return { focusKind: input.focusKind, focusId: input.focusId };
  }
  if (input.focusKind) throw new Error("factory.output requires focusKind of 'task' or 'job'");
  if (input.focusId) throw new Error("factory.output requires focusKind when focusId is provided");

  const env = input.env ?? process.env;
  const envJobId = asString(env.FACTORY_JOB_ID);
  if (envJobId) return { focusKind: "job", focusId: envJobId };
  const envTaskId = asString(env.FACTORY_TASK_ID);
  if (envTaskId) return { focusKind: "task", focusId: envTaskId };

  const detail = await input.factoryService.getObjective(input.objectiveId);
  const inferred = inferObjectiveLiveOutputFocusFromDetail(detail);
  if (inferred) return inferred;
  throw buildAmbiguousError(detail);
};
