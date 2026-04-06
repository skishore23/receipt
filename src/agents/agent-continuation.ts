import type { EnqueueJobInput } from "../adapters/sqlite-queue";
import type { AgentIterationBudgetHandler } from "./agent";
import { isStuckProgress } from "./agent";

export const AGENT_AUTO_CONTINUATION_LADDER = [10, 20, 40, 80] as const;

const MAX_CONTINUATION_DEPTH = 16;

const nextRunId = (): string =>
  `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export const parseContinuationDepth = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(Math.floor(value), MAX_CONTINUATION_DEPTH))
    : 0;

export const nextIterationBudget = (
  current: number,
  ladder: ReadonlyArray<number> = AGENT_AUTO_CONTINUATION_LADDER,
): number | undefined =>
  ladder.find((candidate) => candidate > current);

type QueueLike = {
  readonly enqueue: (input: EnqueueJobInput) => Promise<{ readonly id: string }>;
};

type QueuedBudgetContinuationOptions = {
  readonly queue: QueueLike;
  readonly agentId: string;
  readonly jobKind: string;
  readonly stream: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly continuationDepth?: number;
  readonly sessionKey?: string;
  readonly budgetLadder?: ReadonlyArray<number>;
  readonly summaryPrefix?: string;
};

export const createQueuedBudgetContinuation = (
  opts: QueuedBudgetContinuationOptions,
): AgentIterationBudgetHandler =>
  async ({ runId, problem, config, progress }) => {
    if (isStuckProgress(progress)) return undefined;
    const depth = opts.continuationDepth ?? 0;
    const nextMaxIterations = nextIterationBudget(config.maxIterations, opts.budgetLadder);
    if (nextMaxIterations === undefined) return undefined;

    const nextRun = nextRunId();
    const priorConfig = typeof opts.payload.config === "object" && opts.payload.config && !Array.isArray(opts.payload.config)
      ? opts.payload.config as Record<string, unknown>
      : {};

    const created = await opts.queue.enqueue({
      agentId: opts.agentId,
      lane: "collect",
      sessionKey: opts.sessionKey ?? `${opts.agentId}:${opts.stream}`,
      singletonMode: "allow",
      maxAttempts: 1,
      payload: {
        ...opts.payload,
        kind: opts.jobKind,
        stream: opts.stream,
        runId: nextRun,
        problem,
        config: {
          ...priorConfig,
          maxIterations: nextMaxIterations,
        },
        continuationDepth: depth + 1,
      },
    });

    const lead = opts.summaryPrefix?.trim() || "Reached the current iteration slice.";
    const summary = `${lead} Continuing automatically as ${nextRun} with a ${nextMaxIterations}-step budget.`;
    return {
      finalText: `${summary}\n\nLive updates will continue on the follow-up run.`,
      note: `continued automatically as ${nextRun}`,
      nextRunId: nextRun,
      nextJobId: created.id,
      events: [{
        type: "run.continued",
        runId,
        agentId: "orchestrator",
        nextRunId: nextRun,
        nextJobId: created.id,
        previousMaxIterations: config.maxIterations,
        nextMaxIterations,
        continuationDepth: depth + 1,
        summary,
      }],
    };
  };
