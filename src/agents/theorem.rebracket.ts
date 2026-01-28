// ============================================================================
// Theorem Guild rebracketing engine
// ============================================================================

import type { Chain } from "../core/types.js";
import type { TheoremEvent } from "../modules/theorem.js";

export type BracketTree = string | [BracketTree, BracketTree];

export const THEOREM_PODS = [
  { id: "A", label: "Explorer A", agents: ["explorer_a"] },
  { id: "B", label: "Explorer B", agents: ["explorer_b"] },
  { id: "C", label: "Explorer C", agents: ["explorer_c"] },
  { id: "D", label: "Critic Pod", agents: ["lemma_miner", "skeptic", "verifier", "synthesizer"] },
];

export const BRACKETS: Array<{ bracket: string; tree: BracketTree }> = [
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

export const bracketString = (tree: BracketTree): string =>
  typeof tree === "string" ? tree : `(${bracketString(tree[0])} o ${bracketString(tree[1])})`;

export const treeForBracket = (bracket: string): BracketTree =>
  BRACKETS.find((b) => b.bracket === bracket)?.tree ?? BRACKETS[0].tree;

export const collectLeaves = (tree: BracketTree, out: string[] = []): string[] => {
  if (typeof tree === "string") {
    out.push(tree);
    return out;
  }
  collectLeaves(tree[0], out);
  collectLeaves(tree[1], out);
  return out;
};

export const computeWeights = (chain: Chain<TheoremEvent>): Map<string, number> => {
  const weights = new Map<string, number>();
  const claimOwner = new Map<string, string>();

  for (const r of chain) {
    const e = r.body;
    if (e.type === "attempt.proposed" || e.type === "lemma.proposed") {
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
      bump(e.agentId, claimOwner.get(e.claimId), 1);
    }
  }

  return weights;
};

export const pickBestBracket = (chain: Chain<TheoremEvent>, current?: string) => {
  const weights = computeWeights(chain);
  let best = BRACKETS[0];
  let bestScore = scoreBracket(best.tree, weights);

  for (const candidate of BRACKETS.slice(1)) {
    const score = scoreBracket(candidate.tree, weights);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  const note = current && current !== best.bracket
    ? `Rotation applied (${current} -> ${best.bracket})`
    : `Rotation stable at ${best.bracket}`;

  return { bracket: best.bracket, score: bestScore, note };
};
