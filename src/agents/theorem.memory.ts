// ============================================================================
// Theorem Guild memory selection (bracket-aware, core-context powered)
// ============================================================================

import { buildRankedContext } from "../lib/memory.js";
import type { Chain } from "../core/types.js";
import type { TheoremEvent } from "../modules/theorem.js";
import { collectLeaves, podByAgent, podProximity, treeForBracket } from "./theorem.rebracket.js";

export type MemoryPhase = "attempt" | "lemma" | "critique" | "patch" | "merge";

export type MemoryOptions = {
  readonly phase: MemoryPhase;
  readonly window: number;
  readonly maxChars: number;
  readonly targetClaimId?: string;
  readonly bracket?: string;
};

export type MemorySliceItem = {
  readonly kind: TheoremEvent["type"];
  readonly claimId?: string;
  readonly targetClaimId?: string;
  readonly agentId?: string;
};

export type MemorySlice = {
  readonly text: string;
  readonly items: ReadonlyArray<MemorySliceItem>;
  readonly truncated: boolean;
  readonly maxChars: number;
};

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

export const memoryBudget = (window: number, phase: MemoryPhase): number => {
  const base = 500;
  const per = 24;
  const boost = phase === "merge" ? 300 : phase === "patch" ? 180 : phase === "critique" ? 120 : 140;
  return clamp(base + window * per + boost, 700, 2800);
};

type MemoryItem = {
  readonly kind: TheoremEvent["type"];
  readonly claimId?: string;
  readonly targetClaimId?: string;
  readonly agentId?: string;
  readonly content: string;
  readonly ts: number;
  readonly uses?: ReadonlyArray<string>;
  readonly pods: ReadonlyArray<string>;
};

const PHASE_TYPES: Record<MemoryPhase, ReadonlyArray<TheoremEvent["type"]>> = {
  attempt: ["summary.made", "critique.raised", "patch.applied"],
  lemma: ["summary.made"],
  critique: ["summary.made", "critique.raised", "patch.applied"],
  patch: ["summary.made", "critique.raised"],
  merge: ["summary.made", "lemma.proposed", "critique.raised", "patch.applied"],
};

const PHASE_LIMITS: Record<MemoryPhase, number> = {
  attempt: 4,
  lemma: 2,
  critique: 4,
  patch: 4,
  merge: 6,
};

const TARGET_FILTER_TYPES = new Set<TheoremEvent["type"]>(["critique.raised", "patch.applied"]);

const CLAIM_OWNER_TYPES = new Set<TheoremEvent["type"]>([
  "attempt.proposed",
  "lemma.proposed",
  "critique.raised",
  "patch.applied",
]);

const isClaimOwnerEvent = (
  event: TheoremEvent
): event is Extract<TheoremEvent, { claimId: string; agentId: string }> =>
  CLAIM_OWNER_TYPES.has(event.type);

const TYPE_SCORE: Readonly<Record<TheoremEvent["type"], number>> = {
  "problem.set": 0,
  "problem.appended": 0,
  "run.configured": 0,
  "run.status": 0,
  "failure.report": 0,
  "attempt.proposed": 1.8,
  "lemma.proposed": 2.1,
  "critique.raised": 2.6,
  "patch.applied": 2.4,
  "branch.created": 0,
  "summary.made": 3.4,
  "phase.parallel": 0,
  "prompt.context": 0,
  "orchestrator.decision": 0,
  "memory.slice": 0,
  "context.pruned": 0,
  "context.compacted": 0,
  "overflow.recovered": 0,
  "tool.called": 0,
  "subagent.merged": 0,
  "agent.status": 0,
  "verification.report": 2.2,
  "rebracket.applied": 0,
  "merge.evidence.computed": 0,
  "merge.candidate.scored": 0,
  "merge.applied": 0,
  "solution.finalized": 0,
};

const formatItem = (item: MemoryItem): string => {
  const agent = item.agentId ?? "system";
  if (item.kind === "summary.made") return `Summary (${agent}): ${item.content}`;
  if (item.kind === "lemma.proposed") return `Lemma (${agent}): ${item.content}`;
  if (item.kind === "critique.raised") return `Critique (${agent}): ${item.content}`;
  if (item.kind === "patch.applied") return `Patch (${agent}): ${item.content}`;
  return `Attempt (${agent}): ${item.content}`;
};

const unique = <T>(values: ReadonlyArray<T>): T[] => [...new Set(values)];

const podSetForEvent = (
  event: Extract<TheoremEvent, { content: string }>,
  claimOwner: ReadonlyMap<string, string>
): string[] => {
  const pods: string[] = [];
  const agentPod = typeof event.agentId === "string" ? podByAgent.get(event.agentId) : undefined;
  if (agentPod) pods.push(agentPod);

  if ("targetClaimId" in event && typeof event.targetClaimId === "string") {
    const targetAgent = claimOwner.get(event.targetClaimId);
    const targetPod = targetAgent ? podByAgent.get(targetAgent) : undefined;
    if (targetPod) pods.push(targetPod);
  }

  if (event.type === "summary.made") {
    const uses = Array.isArray(event.uses) ? event.uses : [];
    uses.forEach((claimId) => {
      const owner = claimOwner.get(claimId);
      const pod = owner ? podByAgent.get(owner) : undefined;
      if (pod) pods.push(pod);
    });
  }

  return unique(pods);
};

const latestSummaryFocusPods = (items: ReadonlyArray<MemoryItem>): string[] => {
  const summaries = items.filter((item) => item.kind === "summary.made");
  summaries.sort((a, b) => b.ts - a.ts);
  return summaries[0]?.pods ? [...summaries[0].pods] : [];
};

const gapSignal = (text: string): number =>
  /\b(gap|missing|issue|counterexample|false|unresolved)\b/i.test(text) ? 0.9 : 0;

export const buildMemorySlice = (chain: Chain<TheoremEvent>, opts: MemoryOptions): MemorySlice => {
  if (chain.length === 0) return { text: "", items: [], truncated: false, maxChars: opts.maxChars };
  const window = Math.max(1, opts.window);
  const slice = chain.slice(-window);
  const allowed = new Set(PHASE_TYPES[opts.phase]);
  const limit = PHASE_LIMITS[opts.phase] ?? 4;
  const claimOwner = new Map<string, string>();
  for (const receipt of chain) {
    const event = receipt.body;
    if (!isClaimOwnerEvent(event)) continue;
    claimOwner.set(event.claimId, event.agentId);
  }

  const candidates: MemoryItem[] = [];
  for (const r of slice) {
    const e = r.body;
    if (!allowed.has(e.type)) continue;
    if (!("content" in e) || !e.content.trim()) continue;
    if (opts.targetClaimId && TARGET_FILTER_TYPES.has(e.type)) {
      if (!("targetClaimId" in e) || e.targetClaimId !== opts.targetClaimId) continue;
    }
    const typedEvent = e as Extract<TheoremEvent, { content: string }>;
    candidates.push({
      kind: e.type,
      claimId: "claimId" in e ? e.claimId : undefined,
      targetClaimId: "targetClaimId" in e ? e.targetClaimId : undefined,
      agentId: "agentId" in e ? e.agentId : undefined,
      content: e.content.trim(),
      ts: r.ts,
      uses: e.type === "summary.made" ? (Array.isArray(e.uses) ? e.uses : undefined) : undefined,
      pods: podSetForEvent(typedEvent, claimOwner),
    });
  }

  if (candidates.length === 0) return { text: "", items: [], truncated: false, maxChars: opts.maxChars };

  const bracketLeaves = opts.bracket ? new Set(collectLeaves(treeForBracket(opts.bracket))) : undefined;
  const targetPod = opts.targetClaimId
    ? (() => {
        const owner = claimOwner.get(opts.targetClaimId!);
        return owner ? podByAgent.get(owner) : undefined;
      })()
    : undefined;
  const focusPods = unique(
    targetPod ? [targetPod] : latestSummaryFocusPods(candidates)
  ).filter((pod) => (bracketLeaves ? bracketLeaves.has(pod) : true));
  const focusSet = new Set(focusPods);

  const phaseMultiplier = opts.phase === "merge"
    ? 1.5
    : (opts.phase === "patch" || opts.phase === "critique" ? 1.2 : 0.8);
  const scoreItem = (item: MemoryItem): number => {
    const typeScore = TYPE_SCORE[item.kind] ?? 1;
    const targetBonus =
      opts.targetClaimId && item.targetClaimId === opts.targetClaimId ? 3 : 0;
    const signalBonus = gapSignal(item.content);
    let bracketBonus = 0;
    const bracket = opts.bracket;
    if (bracket && focusSet.size > 0 && item.pods.length > 0) {
      for (const pod of item.pods) {
        for (const focusPod of focusSet.values()) {
          bracketBonus = Math.max(
            bracketBonus,
            podProximity(bracket, pod, focusPod) * phaseMultiplier
          );
        }
      }
    }
    return typeScore + targetBonus + signalBonus + bracketBonus;
  };

  const latestSummary = [...candidates]
    .filter((item) => item.kind === "summary.made")
    .sort((a, b) => scoreItem(b) - scoreItem(a) || b.ts - a.ts)[0];

  const ranked = buildRankedContext({
    items: candidates,
    score: scoreItem,
    ts: (item) => item.ts,
    line: formatItem,
    maxChars: opts.maxChars,
    maxItems: limit,
    maxLineChars: 320,
    pinned: latestSummary ? [latestSummary] : [],
    key: (item) =>
      `${item.kind}:${item.claimId ?? ""}:${item.targetClaimId ?? ""}:${item.agentId ?? ""}:${item.ts}`,
  });
  const selected = ranked.items as MemoryItem[];

  if (!opts.targetClaimId || selected.length >= limit) {
    const sliceItems: MemorySliceItem[] = selected.map((item) => ({
      kind: item.kind,
      claimId: item.claimId,
      targetClaimId: item.targetClaimId,
      agentId: item.agentId,
    }));
    return { text: ranked.text, items: sliceItems, truncated: ranked.truncated, maxChars: opts.maxChars };
  }

  const recovery = candidates.filter((item) =>
    TARGET_FILTER_TYPES.has(item.kind)
    && item.targetClaimId === opts.targetClaimId
  );
  const combined = unique([...selected, ...recovery]);
  const recovered = buildRankedContext({
    items: combined,
    score: scoreItem,
    ts: (item) => item.ts,
    line: formatItem,
    maxChars: opts.maxChars,
    maxItems: limit,
    maxLineChars: 320,
    key: (item) =>
      `${item.kind}:${item.claimId ?? ""}:${item.targetClaimId ?? ""}:${item.agentId ?? ""}:${item.ts}`,
  });

  const sliceItems: MemorySliceItem[] = (recovered.items as MemoryItem[]).map((item) => ({
    kind: item.kind,
    claimId: item.claimId,
    targetClaimId: item.targetClaimId,
    agentId: item.agentId,
  }));
  return {
    text: recovered.text,
    items: sliceItems,
    truncated: recovered.truncated,
    maxChars: opts.maxChars,
  };
};
