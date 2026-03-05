import type { MergeCandidate, MergeDecision, MergePolicy, MergeScoreVector } from "../../sdk/merge.js";

export type ScoredCandidate = {
  readonly candidate: MergeCandidate;
  readonly score: MergeScoreVector;
};

const numeric = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export const compareScoreVectors = (a: MergeScoreVector, b: MergeScoreVector): number => {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    const delta = numeric(a[key]) - numeric(b[key]);
    if (delta !== 0) return delta;
  }
  return 0;
};

export const bestScoredCandidate = (candidates: ReadonlyArray<ScoredCandidate>): ScoredCandidate | undefined =>
  [...candidates]
    .sort((left, right) => {
      const scoreCmp = compareScoreVectors(right.score, left.score);
      if (scoreCmp !== 0) return scoreCmp;
      return left.candidate.id.localeCompare(right.candidate.id);
    })[0];

export const runMergePolicy = <Ctx, Evidence>(
  policy: MergePolicy<Ctx, Evidence>,
  ctx: Ctx
): {
  readonly evidence: Evidence;
  readonly scored: ReadonlyArray<ScoredCandidate>;
  readonly decision: MergeDecision;
} => {
  const evidence = policy.evidence(ctx);
  const scored = policy.candidates(ctx).map((candidate) => ({
    candidate,
    score: policy.score(candidate, evidence, ctx),
  }));

  if (scored.length === 0) {
    throw new Error(`merge policy '${policy.id}' returned no candidates`);
  }

  const fallback = bestScoredCandidate(scored);
  if (!fallback) {
    throw new Error(`merge policy '${policy.id}' produced no scored candidates`);
  }

  const decision = policy.choose(scored);
  if (decision.candidateId) {
    return { evidence, scored, decision };
  }

  return {
    evidence,
    scored,
    decision: {
      candidateId: fallback.candidate.id,
      reason: decision.reason,
    },
  };
};
