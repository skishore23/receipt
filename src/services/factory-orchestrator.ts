import { z } from "zod";

import type {
  FactoryCandidateRecord,
  FactoryIntegrationRecord,
  FactoryTaskRecord,
} from "../modules/factory.js";

export type FactoryActionType =
  | "split_task"
  | "reassign_task"
  | "update_dependencies"
  | "unblock_task"
  | "supersede_task"
  | "queue_integration"
  | "promote_integration"
  | "block_objective";

export type FactoryActionTaskDraft = {
  readonly title: string;
  readonly prompt: string;
  readonly workerType: string;
};

export type FactoryAction = {
  readonly actionId: string;
  readonly type: FactoryActionType;
  readonly label: string;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly workerType?: string;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly tasks?: ReadonlyArray<FactoryActionTaskDraft>;
  readonly summary?: string;
};

export type FactoryOrchestratorInput = {
  readonly objectiveId: string;
  readonly title: string;
  readonly prompt: string;
  readonly baseHash: string;
  readonly tasks: ReadonlyArray<Pick<FactoryTaskRecord, "taskId" | "title" | "status" | "workerType" | "dependsOn" | "latestSummary" | "blockedReason">>;
  readonly candidates: ReadonlyArray<Pick<FactoryCandidateRecord, "candidateId" | "taskId" | "status" | "summary" | "headCommit" | "lastScore" | "lastScoreReason">>;
  readonly integration: Pick<FactoryIntegrationRecord, "status" | "headCommit" | "activeCandidateId" | "queuedCandidateIds" | "conflictReason">;
  readonly actions: ReadonlyArray<FactoryAction>;
  readonly basedOn?: string;
};

export type FactoryOrchestratorDecision = {
  readonly selectedActionId: string;
  readonly reason: string;
  readonly confidence: number;
  readonly raw?: string;
};

export type FactoryOrchestrator = {
  readonly decide: (input: FactoryOrchestratorInput) => Promise<FactoryOrchestratorDecision>;
};

type StructuredResult<T> = {
  readonly parsed: T;
  readonly raw: string;
};

type StructuredFn = <Schema extends z.ZodTypeAny>(opts: {
  readonly system?: string;
  readonly user: string;
  readonly schema: Schema;
  readonly schemaName: string;
}) => Promise<StructuredResult<z.infer<Schema>>>;

const decisionSchema = z.object({
  selectedActionId: z.string().min(1),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const firstAction = (
  input: FactoryOrchestratorInput,
  type: FactoryActionType,
): FactoryAction | undefined => input.actions.find((action) => action.type === type);

export const fallbackFactoryDecision = (
  input: FactoryOrchestratorInput,
): FactoryOrchestratorDecision => {
  const preferred = (
    firstAction(input, "queue_integration")
    ?? firstAction(input, "promote_integration")
    ?? firstAction(input, "split_task")
    ?? firstAction(input, "reassign_task")
    ?? firstAction(input, "update_dependencies")
    ?? firstAction(input, "unblock_task")
    ?? firstAction(input, "supersede_task")
    ?? firstAction(input, "block_objective")
    ?? input.actions[0]
  );
  if (!preferred) {
    throw new Error("factory orchestrator received no actions");
  }
  return {
    selectedActionId: preferred.actionId,
    reason: `deterministic fallback chose ${preferred.type}`,
    confidence: 1,
  };
};

export const createOpenAiFactoryOrchestrator = (opts: {
  readonly llmStructured: StructuredFn;
  readonly systemPrompt: string;
}): FactoryOrchestrator => ({
  decide: async (input) => {
    const { parsed, raw } = await opts.llmStructured({
      system: opts.systemPrompt,
      user: JSON.stringify(input, null, 2),
      schema: decisionSchema,
      schemaName: "factory_orchestrator_decision",
    });
    return { ...parsed, raw };
  },
});

export const createTestFactoryOrchestrator = (): FactoryOrchestrator => ({
  decide: async (input) => fallbackFactoryDecision(input),
});
