import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRuntime } from "@receipt/core/runtime";

import { sqliteBranchStore, sqliteReceiptStore } from "../../src/adapters/sqlite";
import { agentRunStream } from "../../src/agents/agent.streams";
import { emitToContinuedRun, resolveContinuedRunTarget } from "../../src/agents/run-target";
import { makeEventId } from "../../src/framework/http";
import { decide as decideAgent, initial as initialAgent, reduce as reduceAgent, type AgentCmd, type AgentEvent, type AgentState } from "../../src/modules/agent";

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const createAgentRuntime = (dataDir: string) =>
  createRuntime<AgentCmd, AgentEvent, AgentState>(
    sqliteReceiptStore<AgentEvent>(dataDir),
    sqliteBranchStore(dataDir),
    decideAgent,
    reduceAgent,
    initialAgent,
  );

const emit = async (
  runtime: ReturnType<typeof createAgentRuntime>,
  baseStream: string,
  runId: string,
  event: AgentEvent,
): Promise<void> => {
  const stream = agentRunStream(baseStream, runId);
  await runtime.execute(stream, {
    type: "emit",
    eventId: makeEventId(stream),
    event,
  });
};

test("resolveContinuedRunTarget follows unfinished continuation targets", async () => {
  const dataDir = await createTempDir("receipt-agent-run-target");
  const runtime = createAgentRuntime(dataDir);
  const baseStream = "agents/factory/demo";

  await emit(runtime, baseStream, "run_parent", {
    type: "problem.set",
    runId: "run_parent",
    problem: "Keep this thread active.",
    agentId: "orchestrator",
  });
  await emit(runtime, baseStream, "run_parent", {
    type: "run.continued",
    runId: "run_parent",
    agentId: "orchestrator",
    nextRunId: "run_next",
    nextJobId: "job_next",
    previousMaxIterations: 8,
    nextMaxIterations: 12,
    continuationDepth: 1,
    summary: "Continue on run_next.",
  });

  const target = await resolveContinuedRunTarget({
    runtime,
    baseStream,
    parentRunId: "run_parent",
  });

  expect(target).toEqual({
    runId: "run_next",
    jobId: "job_next",
    continued: true,
    depth: 1,
  });
});

test("emitToContinuedRun routes late child merges to the latest continued slice", async () => {
  const dataDir = await createTempDir("receipt-agent-run-routed-merge");
  const runtime = createAgentRuntime(dataDir);
  const baseStream = "agents/factory/demo";

  await emit(runtime, baseStream, "run_parent", {
    type: "problem.set",
    runId: "run_parent",
    problem: "Keep this thread active.",
    agentId: "orchestrator",
  });
  await emit(runtime, baseStream, "run_parent", {
    type: "run.continued",
    runId: "run_parent",
    agentId: "orchestrator",
    nextRunId: "run_next",
    nextJobId: "job_next",
    previousMaxIterations: 8,
    nextMaxIterations: 12,
    continuationDepth: 1,
    summary: "Continue on run_next.",
  });
  await emit(runtime, baseStream, "run_next", {
    type: "problem.set",
    runId: "run_next",
    problem: "Continuation slice.",
    agentId: "orchestrator",
  });
  await emit(runtime, baseStream, "run_next", {
    type: "run.continued",
    runId: "run_next",
    agentId: "orchestrator",
    nextRunId: "run_latest",
    nextJobId: "job_latest",
    previousMaxIterations: 12,
    nextMaxIterations: 20,
    continuationDepth: 2,
    summary: "Continue on run_latest.",
  });

  const target = await emitToContinuedRun({
    runtime,
    baseStream,
    parentRunId: "run_parent",
    eventIdForStream: makeEventId,
    eventForRun: (runId) => ({
      type: "subagent.merged",
      runId,
      agentId: "orchestrator",
      subJobId: "job_codex_probe",
      subRunId: "job_codex_probe",
      task: "Read result.json",
      summary: "Codex probe failed.",
    }),
  });

  expect(target.runId).toBe("run_latest");
  expect(target.jobId).toBe("job_latest");

  const parentChain = await runtime.chain(agentRunStream(baseStream, "run_parent"));
  const nextChain = await runtime.chain(agentRunStream(baseStream, "run_next"));
  const latestChain = await runtime.chain(agentRunStream(baseStream, "run_latest"));

  expect(parentChain.some((receipt) => receipt.body.type === "subagent.merged")).toBe(false);
  expect(nextChain.some((receipt) => receipt.body.type === "subagent.merged")).toBe(false);
  expect(latestChain.findLast((receipt) => receipt.body.type === "subagent.merged")?.body).toMatchObject({
    type: "subagent.merged",
    runId: "run_latest",
    subJobId: "job_codex_probe",
    summary: "Codex probe failed.",
  });
});
