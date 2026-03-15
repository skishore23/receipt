import { z } from "zod";

import type {
  ObjectiveCandidateRecord,
  ObjectiveCandidateScoreVector,
  ObjectivePhase,
  ObjectiveRebracketRecord,
} from "../modules/hub-objective.js";

export type HubOrchestratorActionType =
  | "spawn_builder_from_planner"
  | "spawn_builder_revision"
  | "spawn_alternative_builder_branch"
  | "spawn_reviewer"
  | "promote_to_awaiting_confirmation"
  | "supersede_candidate"
  | "block_objective"
  | "reconcile_with_source_head";

export type HubOrchestratorAction = {
  readonly actionId: string;
  readonly type: HubOrchestratorActionType;
  readonly label: string;
  readonly candidateId?: string;
  readonly parentCandidateId?: string;
  readonly phase?: ObjectivePhase;
  readonly baseCommit?: string;
  readonly dependsOn: ReadonlyArray<string>;
};

export type HubOrchestratorCandidate = Pick<
  ObjectiveCandidateRecord,
  | "candidateId"
  | "parentCandidateId"
  | "baseCommit"
  | "headCommit"
  | "status"
  | "latestSummary"
  | "latestHandoff"
  | "latestDecision"
  | "buildCount"
  | "reviewCount"
  | "retryCount"
  | "lastScore"
  | "lastScoreVector"
  | "lastScoreReason"
  | "latestReason"
  | "createdAt"
  | "updatedAt"
  | "approvedAt"
> & {
  readonly latestCheckOk?: boolean;
  readonly latestCheckCommand?: string;
  readonly touchedFiles: ReadonlyArray<string>;
  readonly diffSummary?: string;
  readonly divergenceFromSourceHead: boolean;
};

export type HubOrchestratorInput = {
  readonly objectiveId: string;
  readonly title: string;
  readonly prompt: string;
  readonly baseHash: string;
  readonly sourceHead?: string;
  readonly plannerPassId?: string;
  readonly frontierCandidateIds: ReadonlyArray<string>;
  readonly latestRebracket?: ObjectiveRebracketRecord;
  readonly maxFrontierSize: number;
  readonly maxBuilderRevisions: number;
  readonly candidates: ReadonlyArray<HubOrchestratorCandidate>;
  readonly actions: ReadonlyArray<HubOrchestratorAction>;
};

export type HubOrchestratorDecision = {
  readonly selectedActionId: string;
  readonly frontierOrder: ReadonlyArray<string>;
  readonly reason: string;
  readonly confidence: number;
  readonly supersedeCandidateIds?: ReadonlyArray<string>;
  readonly raw?: string;
};

export type HubOrchestrator = {
  readonly decide: (input: HubOrchestratorInput) => Promise<HubOrchestratorDecision>;
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
  frontierOrder: z.array(z.string().min(1)).max(16),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  supersedeCandidateIds: z.array(z.string().min(1)).max(8).optional(),
});

const unique = (values: ReadonlyArray<string>): string[] => [...new Set(values.filter(Boolean))];

const normalizedFrontier = (
  input: HubOrchestratorInput,
  chosenActionId: string,
  supersedeCandidateIds?: ReadonlyArray<string>,
): string[] => {
  const candidateIds = new Set(input.candidates.map((candidate) => candidate.candidateId));
  const superseded = new Set(supersedeCandidateIds ?? []);
  const ordered = [
    ...input.frontierCandidateIds,
    ...input.candidates.map((candidate) => candidate.candidateId),
  ].filter((candidateId) => candidateIds.has(candidateId) && !superseded.has(candidateId));
  const action = input.actions.find((item) => item.actionId === chosenActionId);
  if (action?.candidateId && !ordered.includes(action.candidateId) && candidateIds.has(action.candidateId) && !superseded.has(action.candidateId)) {
    return [action.candidateId, ...ordered];
  }
  return unique(ordered);
};

export const createOpenAiHubOrchestrator = (opts: {
  readonly llmStructured: StructuredFn;
  readonly systemPrompt: string;
}): HubOrchestrator => ({
  decide: async (input) => {
    const { parsed, raw } = await opts.llmStructured({
      system: opts.systemPrompt,
      user: JSON.stringify(input, null, 2),
      schema: decisionSchema,
      schemaName: "hub_orchestrator_decision",
    });
    return {
      ...parsed,
      frontierOrder: unique(parsed.frontierOrder),
      supersedeCandidateIds: parsed.supersedeCandidateIds ? unique(parsed.supersedeCandidateIds) : undefined,
      raw,
    };
  },
});

const pickPreferredAction = (input: HubOrchestratorInput, strategy: string): HubOrchestratorAction | undefined => {
  const byType = (type: HubOrchestratorActionType): HubOrchestratorAction[] =>
    input.actions.filter((action) => action.type === type);
  const first = (actions: ReadonlyArray<HubOrchestratorAction>): HubOrchestratorAction | undefined => actions[0];

  if (strategy === "branch-first") {
    const canBranch = first(byType("spawn_alternative_builder_branch"));
    if (canBranch && input.candidates.length < 2) return canBranch;
  }

  return (
    first(byType("spawn_reviewer"))
    ?? first(byType("spawn_builder_revision"))
    ?? first(byType("promote_to_awaiting_confirmation"))
    ?? first(byType("spawn_alternative_builder_branch"))
    ?? first(byType("spawn_builder_from_planner"))
    ?? first(byType("reconcile_with_source_head"))
    ?? first(byType("supersede_candidate"))
    ?? first(byType("block_objective"))
    ?? input.actions[0]
  );
};

export const createTestHubOrchestrator = (strategy = "branch-first"): HubOrchestrator => ({
  decide: async (input) => {
    const selected = pickPreferredAction(input, strategy);
    if (!selected) {
      throw new Error("hub orchestrator test strategy received no actions");
    }
    const frontierOrder = normalizedFrontier(input, selected.actionId);
    return {
      selectedActionId: selected.actionId,
      frontierOrder,
      reason: `test orchestrator chose ${selected.type}`,
      confidence: 0.92,
      supersedeCandidateIds: undefined,
      raw: JSON.stringify({ strategy, selectedActionId: selected.actionId }),
    };
  },
});

export const fallbackHubOrchestratorDecision = (
  input: HubOrchestratorInput,
  preferredActionId: string,
  reason: string,
): HubOrchestratorDecision => ({
  selectedActionId: preferredActionId,
  frontierOrder: normalizedFrontier(input, preferredActionId),
  reason,
  confidence: 1,
});

export const scoreTotal = (vector: ObjectiveCandidateScoreVector | undefined): number =>
  Object.values(vector ?? {}).reduce((sum, value) => sum + Number(value || 0), 0);
