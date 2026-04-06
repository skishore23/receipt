export type MergeScoreVector = Readonly<Record<string, number>>;

export type MergeCandidate = {
  readonly id: string;
  readonly meta?: Record<string, unknown>;
};

export type MergeDecision = {
  readonly candidateId: string;
  readonly reason?: string;
};

export type MergePolicy<Ctx, Evidence = unknown> = {
  readonly id: string;
  readonly version: string;
  readonly shouldRecompute?: (ctx: Ctx) => boolean;
  readonly candidates: (ctx: Ctx) => ReadonlyArray<MergeCandidate>;
  readonly evidence: (ctx: Ctx) => Evidence;
  readonly score: (candidate: MergeCandidate, evidence: Evidence, ctx: Ctx) => MergeScoreVector;
  readonly choose: (scored: ReadonlyArray<{ readonly candidate: MergeCandidate; readonly score: MergeScoreVector }>) => MergeDecision;
};

export const merge = <Ctx, Evidence>(policy: MergePolicy<Ctx, Evidence>): MergePolicy<Ctx, Evidence> => policy;
export const rebracket = merge;
