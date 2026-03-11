import type { Chain } from "../core/types.js";
import { fold } from "../core/chain.js";
import { getLatestRunId } from "../engine/runtime/workflow.js";
import type { AxiomSimpleEvent } from "../modules/axiom-simple.js";
import { initial as initialAxiomSimple, reduce as reduceAxiomSimple } from "../modules/axiom-simple.js";

export type AxiomSimpleRunSummary = {
  readonly runId: string;
  readonly problem: string;
  readonly status: "running" | "done" | "failed";
  readonly startedAt?: number;
  readonly count: number;
};

export const getLatestAxiomSimpleRunId = (chain: Chain<AxiomSimpleEvent>): string | undefined =>
  getLatestRunId(chain, "problem.set");

export const sliceAxiomSimpleChain = (
  chain: Chain<AxiomSimpleEvent>,
  runId?: string,
): Chain<AxiomSimpleEvent> => {
  if (!runId) return chain;
  return chain.filter((receipt) => ("runId" in receipt.body ? receipt.body.runId === runId : false));
};

export const buildAxiomSimpleRuns = (chain: Chain<AxiomSimpleEvent>): AxiomSimpleRunSummary[] => {
  const runs: AxiomSimpleRunSummary[] = [];
  for (let index = 0; index < chain.length; index += 1) {
    const event = chain[index]?.body;
    if (!event || event.type !== "problem.set") continue;
    const runId = event.runId;
    const slice = sliceAxiomSimpleChain(chain, runId);
    if (slice.length === 0) continue;
    const state = fold(slice, reduceAxiomSimple, initialAxiomSimple);
    runs.push({
      runId,
      problem: state.problem,
      status: state.status === "completed" ? "done" : state.status === "failed" ? "failed" : "running",
      startedAt: slice[0]?.ts,
      count: slice.length,
    });
  }
  return runs.reverse();
};

export const buildAxiomSimpleSteps = (
  chain: Chain<AxiomSimpleEvent>,
): Array<{ readonly step: number; readonly index: number }> =>
  chain.map((_receipt, index) => ({ step: index + 1, index: index + 1 }));

export const sliceAxiomSimpleChainByStep = (
  chain: Chain<AxiomSimpleEvent>,
  step: number | null,
): Chain<AxiomSimpleEvent> => {
  if (step === null) return chain;
  if (step <= 0) return [];
  if (step >= chain.length) return chain;
  return chain.slice(0, step);
};
