// ============================================================================
// Writer Guild run slicing + views
// ============================================================================

import type { Chain } from "../core/types.js";
import { fold } from "../core/chain.js";
import type { WriterEvent } from "../modules/writer.js";
import { reduce as reduceWriter, initial as initialWriter } from "../modules/writer.js";

export type WriterRunSummary = {
  readonly runId: string;
  readonly problem: string;
  readonly status: "running" | "done" | "failed";
  readonly startedAt?: number;
  readonly count: number;
};

const getLatestRunId = <Event extends { readonly type: string; readonly runId?: string }>(
  chain: Chain<Event>,
  startType = "problem.set"
): string | undefined => {
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const event = chain[i].body;
    if (event.type === startType && event.runId) return event.runId;
  }
  return undefined;
};

export const getLatestWriterRunId = (chain: Chain<WriterEvent>): string | undefined =>
  getLatestRunId(chain, "problem.set");

export const sliceWriterChain = (chain: Chain<WriterEvent>, runId?: string): Chain<WriterEvent> => {
  if (!runId) return chain;
  return chain.filter((r) => ("runId" in r.body ? r.body.runId === runId : false));
};

export const buildWriterRuns = (chain: Chain<WriterEvent>): WriterRunSummary[] => {
  const runs: WriterRunSummary[] = [];
  for (let i = 0; i < chain.length; i += 1) {
    const event = chain[i].body;
    if (event.type !== "problem.set") continue;
    const runId = event.runId;
    const slice = sliceWriterChain(chain, runId);
    if (slice.length === 0) continue;
    const state = fold(slice, reduceWriter, initialWriter);
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

export const buildWriterSteps = (chain: Chain<WriterEvent>): Array<{ step: number; index: number }> =>
  chain.map((_r, idx) => ({ step: idx + 1, index: idx + 1 }));

export const sliceWriterChainByStep = (chain: Chain<WriterEvent>, step: number | null): Chain<WriterEvent> => {
  if (step === null) return chain;
  if (step <= 0) return [];
  if (step >= chain.length) return chain;
  return chain.slice(0, step);
};
