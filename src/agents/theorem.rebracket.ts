// ============================================================================
// Theorem Guild rebracketing engine
// Merge order is chosen from the Tamari lattice of binary bracketings.
// Each bracket acts like a merge "lens" over the pod tree.
// ============================================================================

import type { Chain } from "../core/types.js";
import type { TheoremEvent } from "../modules/theorem.js";

export type BracketTree = string | [BracketTree, BracketTree];
export type MergeLens = { bracket: string; tree: BracketTree };

export const THEOREM_PODS = [
  { id: "A", label: "Explorer A", agents: ["explorer_a"] },
  { id: "B", label: "Explorer B", agents: ["explorer_b"] },
  { id: "C", label: "Explorer C", agents: ["explorer_c"] },
  { id: "D", label: "Critic Pod", agents: ["lemma_miner", "skeptic", "verifier", "synthesizer"] },
];

export const MERGE_LENSES: ReadonlyArray<MergeLens> = [
  { bracket: "(((A o B) o C) o D)", tree: [[["A", "B"], "C"], "D"] },
  { bracket: "((A o (B o C)) o D)", tree: [["A", ["B", "C"]], "D"] },
  { bracket: "((A o B) o (C o D))", tree: [["A", "B"], ["C", "D"]] },
  { bracket: "(A o ((B o C) o D))", tree: ["A", [["B", "C"], "D"]] },
  { bracket: "(A o (B o (C o D)))", tree: ["A", ["B", ["C", "D"]]] },
];

export const podByAgent = new Map<string, string>(
  THEOREM_PODS.flatMap((pod) => pod.agents.map((agent) => [agent, pod.id] as const))
);

export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

const containsLeaf = (tree: BracketTree, leaf: string): boolean => {
  if (typeof tree === "string") return tree === leaf;
  return containsLeaf(tree[0], leaf) || containsLeaf(tree[1], leaf);
};

const lcaDepth = (tree: BracketTree, a: string, b: string, depth = 0): number => {
  if (typeof tree === "string") return -1;
  const leftHasA = containsLeaf(tree[0], a);
  const leftHasB = containsLeaf(tree[0], b);
  const rightHasA = containsLeaf(tree[1], a);
  const rightHasB = containsLeaf(tree[1], b);

  if (leftHasA && leftHasB) return lcaDepth(tree[0], a, b, depth + 1);
  if (rightHasA && rightHasB) return lcaDepth(tree[1], a, b, depth + 1);
  if ((leftHasA && rightHasB) || (leftHasB && rightHasA)) return depth;
  return -1;
};

const scoreBracket = (tree: BracketTree, weights: Map<string, number>): number => {
  const leaves = THEOREM_PODS.map((p) => p.id);
  let score = 0;
  for (let i = 0; i < leaves.length; i += 1) {
    for (let j = i + 1; j < leaves.length; j += 1) {
      const a = leaves[i];
      const b = leaves[j];
      const weight = weights.get(pairKey(a, b)) ?? 0;
      if (weight <= 0) continue;
      const depth = lcaDepth(tree, a, b, 0);
      score += weight * Math.max(0, depth + 1);
    }
  }
  return score;
};

type ParallelStats = {
  readonly leaves: number;
  readonly potential: number;
};

const parallelStats = (tree: BracketTree): ParallelStats => {
  if (typeof tree === "string") {
    return { leaves: 1, potential: 0 };
  }

  const left = parallelStats(tree[0]);
  const right = parallelStats(tree[1]);
  const leaves = left.leaves + right.leaves;
  const ratio = Math.min(left.leaves, right.leaves) / Math.max(left.leaves, right.leaves);

  // Balanced internal nodes are easier to merge in parallel.
  const local = leaves >= 4 ? ratio : 0;
  return {
    leaves,
    potential: left.potential + right.potential + local,
  };
};

const parallelMergePotential = (tree: BracketTree): number => parallelStats(tree).potential;

export const bracketString = (tree: BracketTree): string =>
  typeof tree === "string" ? tree : `(${bracketString(tree[0])} o ${bracketString(tree[1])})`;

export const treeForBracket = (bracket: string): BracketTree =>
  MERGE_LENSES.find((b) => b.bracket === bracket)?.tree ?? MERGE_LENSES[0].tree;

export const collectLeaves = (tree: BracketTree, out: string[] = []): string[] => {
  if (typeof tree === "string") {
    out.push(tree);
    return out;
  }
  collectLeaves(tree[0], out);
  collectLeaves(tree[1], out);
  return out;
};

export const podProximity = (bracket: string, a: string, b: string): number => {
  if (a === b) return 4;
  const tree = treeForBracket(bracket);
  const depth = lcaDepth(tree, a, b, 0);
  return Math.max(0, depth + 1);
};

export const computeWeights = (chain: Chain<TheoremEvent>): Map<string, number> => {
  const weights = new Map<string, number>();
  const claimOwner = new Map<string, string>();

  for (const r of chain) {
    const e = r.body;
    if (
      e.type === "attempt.proposed"
      || e.type === "lemma.proposed"
      || e.type === "critique.raised"
      || e.type === "patch.applied"
    ) {
      claimOwner.set(e.claimId, e.agentId);
    }
  }

  const bump = (a: string | undefined, b: string | undefined, amount = 1) => {
    if (!a || !b) return;
    const podA = podByAgent.get(a);
    const podB = podByAgent.get(b);
    if (!podA || !podB || podA === podB) return;
    const key = pairKey(podA, podB);
    weights.set(key, (weights.get(key) ?? 0) + amount);
  };

  for (const r of chain) {
    const e = r.body;
    if (e.type === "critique.raised" || e.type === "patch.applied") {
      bump(e.agentId, claimOwner.get(e.targetClaimId), 2);
    }
    if (e.type === "summary.made") {
      const uses = Array.isArray(e.uses) ? e.uses : [];
      const pods = [...new Set(
        uses
          .map((claimId) => claimOwner.get(claimId))
          .filter((agentId): agentId is string => Boolean(agentId))
          .map((agentId) => podByAgent.get(agentId))
          .filter((pod): pod is string => Boolean(pod))
      )];
      for (let i = 0; i < pods.length; i += 1) {
        for (let j = i + 1; j < pods.length; j += 1) {
          const key = pairKey(pods[i], pods[j]);
          weights.set(key, (weights.get(key) ?? 0) + 1);
        }
      }
    }
  }

  return weights;
};

export const pickBestBracket = (chain: Chain<TheoremEvent>, current?: string) => {
  const weights = computeWeights(chain);
  let best = MERGE_LENSES[0];
  let bestScore = scoreBracket(best.tree, weights);
  let bestParallel = parallelMergePotential(best.tree);
  let bestReason: "causal" | "parallel" | "stability" | "lexical" = "causal";
  if (current && best.bracket === current) {
    bestReason = "stability";
  }

  const betterCandidate = (candidate: MergeLens, score: number, parallel: number) => {
    if (score > bestScore) return { better: true, reason: "causal" as const };
    if (score < bestScore) return { better: false, reason: "causal" as const };

    if (parallel > bestParallel) return { better: true, reason: "parallel" as const };
    if (parallel < bestParallel) return { better: false, reason: "parallel" as const };

    const candidateStable = current ? candidate.bracket === current : false;
    const bestStable = current ? best.bracket === current : false;
    if (candidateStable && !bestStable) return { better: true, reason: "stability" as const };
    if (!candidateStable && bestStable) return { better: false, reason: "stability" as const };

    if (candidate.bracket < best.bracket) return { better: true, reason: "lexical" as const };
    return { better: false, reason: "lexical" as const };
  };

  for (const candidate of MERGE_LENSES.slice(1)) {
    const score = scoreBracket(candidate.tree, weights);
    const parallel = parallelMergePotential(candidate.tree);
    const decision = betterCandidate(candidate, score, parallel);
    if (decision.better) {
      best = candidate;
      bestScore = score;
      bestParallel = parallel;
      bestReason = decision.reason;
    }
  }

  const reasonText =
    bestReason === "causal"
      ? "causal score"
      : bestReason === "parallel"
        ? "parallel merge potential tie-break"
        : bestReason === "stability"
          ? "current bracket stability tie-break"
          : "deterministic lexical tie-break";

  const note = current && current !== best.bracket
    ? `Rotation applied (${current} -> ${best.bracket}) via ${reasonText}`
    : `Rotation stable at ${best.bracket} (${reasonText})`;

  return { bracket: best.bracket, score: bestScore, note };
};
