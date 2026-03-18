import { expect, test } from "bun:test";

import { createQueuedBudgetContinuation, nextIterationBudget, parseContinuationDepth } from "../../src/agents/agent-continuation.ts";
import { buildAgentRunResult } from "../../src/agents/agent.result.ts";
import { AGENT_DEFAULT_CONFIG } from "../../src/agents/agent.ts";
import { initial as initialAgent, reduce as reduceAgent, type AgentEvent } from "../../src/modules/agent.ts";

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

  const continuation = await handler({
    runId: "run_start",
    runStream: "agents/agent/runs/run_start",
    problem: "Finish the sidebar update.",
    config: AGENT_DEFAULT_CONFIG,
    runtime: undefined as never,
    now: () => 0,
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
