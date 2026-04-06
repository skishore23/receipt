import { expect, test } from "bun:test";

import { createQueuedBudgetContinuation, nextIterationBudget, parseContinuationDepth } from "../../src/agents/agent-continuation";
import { buildAgentRunResult } from "../../src/agents/agent.result";
import { AGENT_DEFAULT_CONFIG, isStuckProgress, type AgentRunProgress } from "../../src/agents/agent";
import { initial as initialAgent, reduce as reduceAgent, type AgentEvent } from "../../src/modules/agent";

test("queued budget continuation enqueues a follow-up run with a larger budget", async () => {
  let enqueued: Record<string, unknown> | undefined;
  const handler = createQueuedBudgetContinuation({
    queue: {
      enqueue: async (input) => {
        enqueued = input as unknown as Record<string, unknown>;
        return { id: "job_follow_up_1" };
      },
    },
    agentId: "agent",
    jobKind: "agent.run",
    stream: "agents/agent",
    payload: {
      kind: "agent.run",
      stream: "agents/agent",
      runId: "run_start",
      config: AGENT_DEFAULT_CONFIG,
    },
    continuationDepth: 0,
  });

  const healthyProgress: AgentRunProgress = {
    iterationsUsed: 10,
    toolCallsSucceeded: 6,
    toolCallsFailed: 1,
    distinctToolsUsed: 3,
  };
  const continuation = await handler({
    runId: "run_start",
    runStream: "agents/agent/runs/run_start",
    problem: "Finish the sidebar update.",
    config: AGENT_DEFAULT_CONFIG,
    runtime: undefined as never,
    now: () => 0,
    progress: healthyProgress,
  });

  expect(enqueued).toMatchObject({
    agentId: "agent",
    payload: {
      kind: "agent.run",
      stream: "agents/agent",
      problem: "Finish the sidebar update.",
      continuationDepth: 1,
      config: {
        maxIterations: 20,
      },
    },
  });
  expect(typeof enqueued?.payload?.runId).toBe("string");
  expect(continuation?.nextJobId).toBe("job_follow_up_1");
  expect(continuation?.events?.[0]).toMatchObject({
    type: "run.continued",
    nextJobId: "job_follow_up_1",
    previousMaxIterations: 10,
    nextMaxIterations: 20,
    continuationDepth: 1,
  });
});

test("stuck agent does not escalate", async () => {
  const handler = createQueuedBudgetContinuation({
    queue: { enqueue: async () => ({ id: "job_should_not_exist" }) },
    agentId: "agent",
    jobKind: "agent.run",
    stream: "agents/agent",
    payload: { kind: "agent.run", stream: "agents/agent", runId: "run_stuck", config: AGENT_DEFAULT_CONFIG },
    continuationDepth: 0,
  });
  const stuckProgress: AgentRunProgress = {
    iterationsUsed: 10,
    toolCallsSucceeded: 0,
    toolCallsFailed: 8,
    distinctToolsUsed: 0,
  };
  const result = await handler({
    runId: "run_stuck",
    runStream: "agents/agent/runs/run_stuck",
    problem: "Fix something.",
    config: AGENT_DEFAULT_CONFIG,
    runtime: undefined as never,
    now: () => 0,
    progress: stuckProgress,
  });
  expect(result).toBeUndefined();
});

test("isStuckProgress detects zero successes", () => {
  expect(isStuckProgress({ iterationsUsed: 8, toolCallsSucceeded: 0, toolCallsFailed: 0, distinctToolsUsed: 0 })).toBe(true);
  expect(isStuckProgress({ iterationsUsed: 8, toolCallsSucceeded: 0, toolCallsFailed: 5, distinctToolsUsed: 0 })).toBe(true);
});

test("isStuckProgress detects failure-dominated runs", () => {
  expect(isStuckProgress({ iterationsUsed: 10, toolCallsSucceeded: 1, toolCallsFailed: 3, distinctToolsUsed: 1 })).toBe(true);
  expect(isStuckProgress({ iterationsUsed: 10, toolCallsSucceeded: 1, toolCallsFailed: 2, distinctToolsUsed: 1 })).toBe(false);
  expect(isStuckProgress({ iterationsUsed: 10, toolCallsSucceeded: 5, toolCallsFailed: 2, distinctToolsUsed: 3 })).toBe(false);
});

test("next iteration budget stops after the configured ladder", () => {
  expect(nextIterationBudget(10)).toBe(20);
  expect(nextIterationBudget(20)).toBe(40);
  expect(nextIterationBudget(40)).toBe(80);
  expect(nextIterationBudget(80)).toBe(undefined);
  expect(parseContinuationDepth(99)).toBe(16);
});

test("response.finalized preserves a failed status and exposes continuation metadata", () => {
  const events: AgentEvent[] = [
    {
      type: "problem.set",
      runId: "run_1",
      agentId: "orchestrator",
      problem: "Do work",
    },
    {
      type: "run.status",
      runId: "run_1",
      agentId: "orchestrator",
      status: "failed",
      note: "iteration budget exhausted (10)",
    },
    {
      type: "response.finalized",
      runId: "run_1",
      agentId: "orchestrator",
      content: "Stopped after hitting max iterations.",
    },
    {
      type: "run.continued",
      runId: "run_1",
      agentId: "orchestrator",
      nextRunId: "run_2",
      nextJobId: "job_2",
      previousMaxIterations: 10,
      nextMaxIterations: 20,
      continuationDepth: 1,
      summary: "Continuing automatically.",
    },
  ];

  const state = events.reduce((current, event, index) => reduceAgent(current, event, index + 1), initialAgent);
  expect(state.status).toBe("failed");
  expect(state.finalResponse).toBe("Stopped after hitting max iterations.");

  const result = buildAgentRunResult({
    runId: "run_1",
    stream: "agents/agent",
    runStream: "agents/agent/runs/run_1",
    state,
  });
  expect(result.status).toBe("failed");
  expect(result.followUpJobId).toBe("job_2");
  expect(result.followUpRunId).toBe("run_2");
});
