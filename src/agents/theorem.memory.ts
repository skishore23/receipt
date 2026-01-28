// ============================================================================
// Theorem Guild memory selection
// ============================================================================

import type { Chain } from "../core/types.js";
import type { TheoremEvent } from "../modules/theorem.js";
import { computeWeights, THEOREM_PODS, podByAgent, pairKey } from "./theorem.rebracket.js";

export type MemoryPhase = "attempt" | "lemma" | "critique" | "patch" | "merge";

export type MemoryOptions = {
  readonly phase: MemoryPhase;
  readonly window: number;
  readonly maxChars: number;
  readonly targetClaimId?: string;
};

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

export const memoryBudget = (window: number, phase: MemoryPhase): number => {
  const base = 600;
  const per = 35;
  const boost = phase === "merge" ? 400 : phase === "patch" ? 250 : phase === "critique" ? 150 : 200;
  return clamp(base + window * per + boost, 800, 5000);
};

const buildClaimOwner = (chain: Chain<TheoremEvent>): Map<string, string> => {
  const map = new Map<string, string>();
  for (const r of chain) {
    const e = r.body;
    if (e.type === "attempt.proposed" || e.type === "lemma.proposed") {
      map.set(e.claimId, e.agentId);
    }
  }
  return map;
};

const buildPodFocus = (chain: Chain<TheoremEvent>): Map<string, number> => {
  const weights = computeWeights(chain);
  const focus = new Map<string, number>();
  for (const pod of THEOREM_PODS) {
    let score = 0;
    for (const other of THEOREM_PODS) {
      if (pod.id === other.id) continue;
      score += weights.get(pairKey(pod.id, other.id)) ?? 0;
    }
    focus.set(pod.id, score);
  }
  return focus;
};

type MemoryItem = {
  readonly kind: TheoremEvent["type"];
  readonly claimId?: string;
  readonly targetClaimId?: string;
  readonly agentId?: string;
  readonly content: string;
  readonly ts: number;
  readonly index: number;
  readonly score: number;
};

const scoreMemoryItem = (
  item: Omit<MemoryItem, "score">,
  opts: MemoryOptions,
  podFocus: Map<string, number>,
  claimOwner: Map<string, string>,
  maxIndex: number
): number => {
  const typeWeight =
    item.kind === "summary.made"
      ? 4
      : item.kind === "critique.raised"
        ? 3
        : item.kind === "patch.applied"
          ? 3
          : item.kind === "lemma.proposed"
            ? 2
            : 2;

  const recency = maxIndex > 0 ? (item.index / maxIndex) * 2 : 0;
  const conflict = /gap|invalid|counterexample|contradiction|missing/i.test(item.content) ? 1.5 : 0;

  let relevance = 0;
  if (opts.targetClaimId) {
    if (item.claimId === opts.targetClaimId) relevance += 3;
    if (item.targetClaimId === opts.targetClaimId) relevance += 4;
  }

  const owner = item.agentId ?? (item.targetClaimId ? claimOwner.get(item.targetClaimId) : undefined);
  const pod = owner ? podByAgent.get(owner) : undefined;
  const podScore = pod ? (podFocus.get(pod) ?? 0) * 0.2 : 0;

  return typeWeight + recency + conflict + relevance + podScore;
};

export const buildMemorySlice = (chain: Chain<TheoremEvent>, opts: MemoryOptions): string => {
  if (chain.length === 0) return "";
  const window = Math.max(1, opts.window);
  const slice = chain.slice(-window);
  const claimOwner = buildClaimOwner(chain);
  const podFocus = buildPodFocus(slice);
  const maxIndex = slice.length - 1;

  const items: MemoryItem[] = [];

  for (let i = 0; i < slice.length; i += 1) {
    const r = slice[i];
    const e = r.body;
    if (
      e.type !== "summary.made" &&
      e.type !== "critique.raised" &&
      e.type !== "patch.applied" &&
      e.type !== "lemma.proposed" &&
      e.type !== "attempt.proposed"
    ) continue;
    if (!("content" in e) || !e.content.trim()) continue;
    const base = {
      kind: e.type,
      claimId: "claimId" in e ? e.claimId : undefined,
      targetClaimId: "targetClaimId" in e ? e.targetClaimId : undefined,
      agentId: "agentId" in e ? e.agentId : undefined,
      content: e.content.trim(),
      ts: r.ts,
      index: i,
    };
    items.push({
      ...base,
      score: scoreMemoryItem(base, opts, podFocus, claimOwner, maxIndex),
    });
  }

  if (items.length === 0) return "";

  const byScore = [...items].sort((a, b) => b.score - a.score || b.ts - a.ts);
  const chosen: MemoryItem[] = [];
  const seenClaims = new Set<string>();

  const latestSummary = [...items].reverse().find((i) => i.kind === "summary.made");
  if (latestSummary) {
    if (latestSummary.claimId) seenClaims.add(latestSummary.claimId);
    chosen.push(latestSummary);
  }

  const pickBest = (kind: MemoryItem["kind"]) => {
    const candidate = byScore.find((i) => i.kind === kind && (!i.claimId || !seenClaims.has(i.claimId)));
    if (candidate) {
      if (candidate.claimId) seenClaims.add(candidate.claimId);
      chosen.push(candidate);
    }
  };

  if (opts.phase === "attempt" || opts.phase === "lemma") {
    pickBest("critique.raised");
    pickBest("patch.applied");
  }
  if (opts.phase === "critique" || opts.phase === "patch") {
    pickBest("attempt.proposed");
  }
  if (opts.phase === "merge") {
    pickBest("lemma.proposed");
  }

  for (const item of byScore) {
    if (chosen.length >= 8) break;
    if (item.claimId && seenClaims.has(item.claimId)) continue;
    if (item.claimId) seenClaims.add(item.claimId);
    chosen.push(item);
  }

  const parts: string[] = [];
  for (const item of chosen) {
    const agent = item.agentId ?? "system";
    if (item.kind === "summary.made") {
      parts.push(`Latest summary:\n${item.content}`);
      continue;
    }
    if (item.kind === "critique.raised") {
      const target = item.targetClaimId ? claimOwner.get(item.targetClaimId) : undefined;
      const label = target ? `Critique (${agent} -> ${target})` : `Critique (${agent})`;
      parts.push(`${label}: ${item.content}`);
      continue;
    }
    if (item.kind === "patch.applied") {
      const target = item.targetClaimId ? claimOwner.get(item.targetClaimId) : undefined;
      const label = target ? `Patch (${agent} -> ${target})` : `Patch (${agent})`;
      parts.push(`${label}: ${item.content}`);
      continue;
    }
    if (item.kind === "lemma.proposed") {
      parts.push(`Lemma (${agent}): ${item.content}`);
      continue;
    }
    parts.push(`Attempt (${agent}): ${item.content}`);
  }

  const joined = parts.join("\n\n").trim();
  return joined.length > opts.maxChars ? joined.slice(0, opts.maxChars) + "..." : joined;
};
