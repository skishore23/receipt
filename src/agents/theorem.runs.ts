// ============================================================================
// Theorem Guild run slicing + views
// ============================================================================

import type { Chain } from "../core/types.js";
import { fold } from "../core/chain.js";
import type { TheoremEvent } from "../modules/theorem.js";
import { reduce as reduceTheorem, initial as initialTheorem } from "../modules/theorem.js";
import { getLatestRunId } from "../engine/runtime/workflow.js";

export type TheoremRunSummary = {
  readonly runId: string;
  readonly problem: string;
  readonly status: "running" | "done" | "failed";
  readonly startedAt?: number;
  readonly count: number;
};

export const getLatestTheoremRunId = (chain: Chain<TheoremEvent>): string | undefined =>
  getLatestRunId(chain, "problem.set");

export const sliceTheoremChain = (chain: Chain<TheoremEvent>, runId?: string): Chain<TheoremEvent> => {
  if (!runId) return chain;
  return chain.filter((r) => ("runId" in r.body ? r.body.runId === runId : false));
};

export const buildTheoremRuns = (chain: Chain<TheoremEvent>): TheoremRunSummary[] => {
  const runs: TheoremRunSummary[] = [];
  for (let i = 0; i < chain.length; i += 1) {
    const event = chain[i].body;
    if (event.type !== "problem.set") continue;
    const runId = event.runId;
    const slice = sliceTheoremChain(chain, runId);
    if (slice.length === 0) continue;
    const state = fold(slice, reduceTheorem, initialTheorem);
    const status =
      state.status === "completed"
        ? "done"
        : state.status === "failed"
          ? "failed"
          : "running";
    runs.push({
      runId,
      problem: state.problem,
      status,
      startedAt: slice[0]?.ts,
      count: slice.length,
    });
  }
  return runs.reverse();
};

export const buildTheoremSteps = (chain: Chain<TheoremEvent>): Array<{ step: number; index: number }> => {
  const seen = new Set<string>();
  const steps: Array<{ step: number; index: number }> = [];

  const keyFor = (event: TheoremEvent): string | null => {
    switch (event.type) {
      case "problem.set":
        return `problem:${event.runId}`;
      case "run.configured":
        return `config:${event.runId}`;
      case "failure.report":
        return `failure:${event.failure.failureClass}:${event.failure.stage}`;
      case "run.status":
        return `status:${event.status}`;
      case "branch.created":
        return `branch:${event.branchId}`;
      case "attempt.proposed":
        return `attempt:${event.claimId}`;
      case "lemma.proposed":
        return `lemma:${event.claimId}`;
      case "critique.raised":
        return `critique:${event.claimId}`;
      case "patch.applied":
        return `patch:${event.claimId}`;
      case "summary.made":
        return `summary:${event.claimId}`;
      case "agent.status":
        return `agent:${event.agentId}:${event.status}:${event.round ?? 0}:${event.phase ?? ""}`;
      case "phase.parallel":
        return `parallel:${event.phase}:${event.round ?? 0}`;
      case "verification.report":
        return `verify:${event.status}`;
      case "rebracket.applied":
        return `rebracket:${event.bracket}`;
      case "solution.finalized":
        return `solution:${event.agentId}`;
      default:
        return null;
    }
  };

  chain.forEach((r, idx) => {
    const key = keyFor(r.body);
    if (!key || seen.has(key)) return;
    seen.add(key);
    steps.push({ step: steps.length + 1, index: idx + 1 });
  });

  return steps;
};

export const sliceTheoremChainByStep = (chain: Chain<TheoremEvent>, step: number | null): Chain<TheoremEvent> => {
  if (step === null) return chain;
  if (step <= 0) return [];
  const steps = buildTheoremSteps(chain);
  if (steps.length === 0) return chain;
  if (step >= steps.length) return chain;
  const limit = steps[step - 1]?.index ?? chain.length;
  return chain.slice(0, limit);
};
