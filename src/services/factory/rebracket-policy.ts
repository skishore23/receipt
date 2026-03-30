import { bestScoredCandidate, runMergePolicy, type ScoredCandidate } from "../../engine/merge/policy";
import { rebracket, type MergeCandidate, type MergePolicy, type MergeScoreVector } from "../../sdk/merge";
import type { FactoryState } from "../../modules/factory";
import type { FactoryObjectivePlannerFacts, FactoryPlannerEffect } from "./effects";

export type FactoryRebracketEffect = Extract<
  FactoryPlannerEffect,
  | { readonly type: "task.dispatch" }
  | { readonly type: "integration.queue" }
  | { readonly type: "integration.ready_to_promote" }
  | { readonly type: "integration.promote" }
  | { readonly type: "objective.complete" }
  | { readonly type: "objective.block" }
>;

type FactoryRebracketCandidate = MergeCandidate & {
  readonly meta: {
    readonly effect: FactoryRebracketEffect;
    readonly actionId: string;
    readonly effectIndex: number;
  };
};

type FactoryRebracketEvidence = {
  readonly dispatchCapacity: number;
  readonly activeTaskCount: number;
  readonly integrationStatus: FactoryState["integration"]["status"];
  readonly objectiveMode: FactoryState["objectiveMode"];
  readonly taskOrder: Readonly<Record<string, number>>;
};

type FactoryRebracketContext = {
  readonly state: FactoryState;
  readonly facts: FactoryObjectivePlannerFacts;
  readonly candidates: ReadonlyArray<FactoryRebracketCandidate>;
};

export type FactoryRebracketSelection = {
  readonly effect: FactoryRebracketEffect;
  readonly actionId: string;
  readonly reason: string;
  readonly scored: ReadonlyArray<ScoredCandidate>;
  readonly score: MergeScoreVector;
  readonly evidence: FactoryRebracketEvidence;
};

const isFactoryRebracketEffect = (
  effect: FactoryPlannerEffect,
): effect is FactoryRebracketEffect =>
  effect.type === "task.dispatch"
  || effect.type === "integration.queue"
  || effect.type === "integration.ready_to_promote"
  || effect.type === "integration.promote"
  || effect.type === "objective.complete"
  || effect.type === "objective.block";

export const factoryRebracketActionId = (effect: FactoryRebracketEffect): string => {
  switch (effect.type) {
    case "task.dispatch":
      return `dispatch_${effect.taskId}`;
    case "integration.queue":
      return `queue_integration_${effect.candidateId}`;
    case "integration.ready_to_promote":
      return `ready_to_promote_${effect.candidateId}`;
    case "integration.promote":
      return `promote_integration_${effect.candidateId}`;
    case "objective.complete":
      return "complete_objective";
    case "objective.block":
      return "block_objective";
  }
};

export const factoryRebracketReason = (effect: FactoryRebracketEffect): string => {
  switch (effect.type) {
    case "task.dispatch":
      return `Dispatch ready task ${effect.taskId}.`;
    case "integration.queue":
      return `Queue approved candidate ${effect.candidateId} for integration.`;
    case "integration.ready_to_promote":
      return `Mark integrated candidate ${effect.candidateId} ready to promote.`;
    case "integration.promote":
      return `Promote integrated candidate ${effect.candidateId}.`;
    case "objective.complete":
      return trimmedDecision(effect.summary, "Complete the objective.");
    case "objective.block":
      return trimmedDecision(effect.summary, trimmedDecision(effect.reason, "Block the objective."));
  }
};

const trimmedDecision = (value: string | undefined, fallback: string): string => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
};

const factoryRebracketPolicy: MergePolicy<FactoryRebracketContext, FactoryRebracketEvidence> = rebracket({
  id: "factory-objective-react",
  version: "v1",
  candidates: (ctx) => ctx.candidates,
  evidence: (ctx) => ({
    dispatchCapacity: ctx.facts.dispatchCapacity,
    activeTaskCount: ctx.state.workflow.activeTaskIds.length,
    integrationStatus: ctx.state.integration.status,
    objectiveMode: ctx.state.objectiveMode,
    taskOrder: Object.fromEntries(ctx.state.workflow.taskIds.map((taskId, index) => [taskId, index])),
  }),
  score: (candidate, evidence) => {
    const effect = (candidate as FactoryRebracketCandidate).meta.effect;
    const dispatchPriority = effect.type === "task.dispatch" ? 1 : 0;
    const taskIndex = effect.type === "task.dispatch"
      ? (evidence.taskOrder[effect.taskId] ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    return {
      a_dispatch_priority: dispatchPriority,
      b_effect_order: -((candidate as FactoryRebracketCandidate).meta.effectIndex),
      c_task_order: -taskIndex,
    };
  },
  choose: (scored) => {
    const best = bestScoredCandidate(scored);
    if (!best) return { candidateId: "", reason: "No rebracket candidate was available." };
    return {
      candidateId: best.candidate.id,
      reason: factoryRebracketReason((best.candidate as FactoryRebracketCandidate).meta.effect),
    };
  },
});

export const selectFactoryRebracketEffect = (input: {
  readonly state: FactoryState;
  readonly facts: FactoryObjectivePlannerFacts;
  readonly effects: ReadonlyArray<FactoryPlannerEffect>;
}): FactoryRebracketSelection | undefined => {
  const candidates = input.effects
    .flatMap((effect, effectIndex): ReadonlyArray<FactoryRebracketCandidate> =>
      isFactoryRebracketEffect(effect)
        ? [{
            id: factoryRebracketActionId(effect),
            meta: {
              effect,
              actionId: factoryRebracketActionId(effect),
              effectIndex,
            },
          }]
        : []
    );
  if (candidates.length === 0) return undefined;

  const result = runMergePolicy(factoryRebracketPolicy, {
    state: input.state,
    facts: input.facts,
    candidates,
  });
  const selected = candidates.find((candidate) => candidate.id === result.decision.candidateId) ?? candidates[0];
  const winningScore = result.scored.find((entry) => entry.candidate.id === selected.id)?.score ?? {};
  return {
    effect: selected.meta.effect,
    actionId: selected.meta.actionId,
    reason: result.decision.reason ?? factoryRebracketReason(selected.meta.effect),
    scored: result.scored,
    score: winningScore,
    evidence: result.evidence,
  };
};
