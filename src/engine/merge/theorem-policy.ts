import type { Chain } from "../../core/types.js";
import { merge, type MergePolicy, type MergeScoreVector } from "../../sdk/merge.js";
import type { TheoremEvent } from "../../modules/theorem.js";
import { MERGE_LENSES, pickBestBracket } from "../../agents/theorem.rebracket.js";
import { evaluateRoundRebracketEvidence } from "../../agents/theorem.evidence.js";

export type TheoremMergeCtx = {
  readonly chain: Chain<TheoremEvent>;
  readonly round: number;
  readonly branchThreshold: number;
  readonly currentBracket?: string;
};

type Evidence = {
  readonly bestBracket: string;
  readonly shouldRebracket: boolean;
  readonly note: string;
};

const scoreForCandidate = (
  candidateBracket: string,
  evidence: Evidence,
  ctx: TheoremMergeCtx
): MergeScoreVector => {
  const preferred = candidateBracket === evidence.bestBracket ? 1 : 0;
  const stable = candidateBracket === (ctx.currentBracket ?? "") ? 1 : 0;
  return {
    causal: preferred,
    stability: stable,
    rebracket: evidence.shouldRebracket ? 1 : 0,
  };
};

export const theoremMergePolicy: MergePolicy<TheoremMergeCtx, Evidence> = merge({
  id: "theorem-rebracket",
  version: "1.0.0",
  shouldRecompute: (ctx) => {
    const roundEvidence = evaluateRoundRebracketEvidence(ctx.chain, ctx.round, ctx.branchThreshold);
    return roundEvidence.shouldRebracket;
  },
  candidates: () => MERGE_LENSES.map((lens) => ({ id: lens.bracket })),
  evidence: (ctx) => {
    const roundEvidence = evaluateRoundRebracketEvidence(ctx.chain, ctx.round, ctx.branchThreshold);
    const best = pickBestBracket(ctx.chain, ctx.currentBracket);
    return {
      bestBracket: best.bracket,
      shouldRebracket: roundEvidence.shouldRebracket,
      note: `${best.note}; ${roundEvidence.note}`,
    };
  },
  score: (candidate, evidence, ctx) => scoreForCandidate(candidate.id, evidence, ctx),
  choose: (scored) => {
    const best = [...scored].sort((left, right) => {
      const leftScore = Number(left.score.causal ?? 0) + Number(left.score.stability ?? 0) + Number(left.score.rebracket ?? 0);
      const rightScore = Number(right.score.causal ?? 0) + Number(right.score.stability ?? 0) + Number(right.score.rebracket ?? 0);
      if (rightScore !== leftScore) return rightScore - leftScore;
      return left.candidate.id.localeCompare(right.candidate.id);
    })[0];

    if (!best) {
      return { candidateId: MERGE_LENSES[0]?.bracket ?? "" };
    }
    return { candidateId: best.candidate.id };
  },
});
