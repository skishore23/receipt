import { test, expect } from "bun:test";

import type { Runtime } from "../../src/core/runtime.ts";
import type { Branch, Chain } from "../../src/core/types.ts";
import { receipt } from "../../src/core/chain.ts";
import type { TodoCmd, TodoEvent, TodoState } from "../../src/modules/todo.ts";
import type { TheoremCmd, TheoremEvent, TheoremState } from "../../src/modules/theorem.ts";
import type { WriterCmd, WriterEvent, WriterState } from "../../src/modules/writer.ts";
import type { AgentEvent } from "../../src/modules/agent.ts";
import { initial as theoremInitial } from "../../src/modules/theorem.ts";
import { initial as writerInitial } from "../../src/modules/writer.ts";
import { THEOREM_DEFAULT_CONFIG } from "../../src/agents/theorem.ts";
import { WRITER_DEFAULT_CONFIG } from "../../src/agents/writer.ts";
import { AGENT_DEFAULT_CONFIG } from "../../src/agents/agent.ts";
import { translateTodoCmdIntent } from "../../src/agents/todo.agent.ts";
import { resolveTheoremResumeAnchor, translateTheoremRunStartIntent } from "../../src/agents/theorem.agent.ts";
import { translateWriterRunStartIntent } from "../../src/agents/writer.agent.ts";
import { translateAgentRunStartIntent } from "../../src/agents/monitor.agent.ts";

const stubBranch = (name = "b"): Branch => ({ name, createdAt: Date.now() });

const stubRuntime = <Cmd, Event, State>(initialState: State): Runtime<Cmd, Event, State> => ({
  execute: async () => [],
  state: async () => initialState,
  stateAt: async () => initialState,
  chain: async () => [],
  chainAt: async () => [],
  verify: async () => ({ ok: true, count: 0 }),
  fork: async (_stream, _at, newName) => stubBranch(newName),
  branch: async () => undefined,
  branches: async () => [],
  children: async () => [],
  listStreams: async () => [],
});

const theoremReceipt = (body: TheoremEvent): Chain<TheoremEvent>[number] => ({
  id: "r1",
  ts: Date.now(),
  stream: "theorem/runs/r1",
  body,
  hash: "h1",
});

const writerReceipt = (body: WriterEvent): Chain<WriterEvent>[number] => ({
  id: "r1",
  ts: Date.now(),
  stream: "writer/runs/r1",
  body,
  hash: "h1",
});

test("framework translators: todo command intent maps to emit + broadcast", () => {
  const ops = translateTodoCmdIntent({
    stream: "todo",
    cmd: { type: "add", text: "ship it" },
  });

  expect(ops.length).toBe(2);
  expect(ops[0]?.type).toBe("emit");
  expect(ops[1]?.type).toBe("broadcast");
});

test("framework translators: theorem run intent emits fork/append/enqueue/redirect on resume", () => {
  const runtime = stubRuntime<TheoremCmd, TheoremEvent, TheoremState>(theoremInitial);
  const ops = translateTheoremRunStartIntent({
    stream: "theorem",
    runId: "run_1",
    runStream: "theorem/runs/run_1",
    sourceStream: "theorem/runs/run_1",
    sourceChain: [theoremReceipt({ type: "problem.set", runId: "run_1", problem: "p" })],
    at: null,
    append: "appendix",
    resolvedProblem: "problem",
    config: THEOREM_DEFAULT_CONFIG,
    resumeRequested: true,
  });

  const kinds = ops.map((op) => op.type);
  expect(kinds).toEqual(["fork", "emit", "emit", "enqueue_job", "redirect"]);
});

test("framework translators: writer run intent emits fork/append/enqueue/redirect on resume", () => {
  const runtime = stubRuntime<WriterCmd, WriterEvent, WriterState>(writerInitial);
  const ops = translateWriterRunStartIntent({
    stream: "writer",
    runId: "run_1",
    runStream: "writer/runs/run_1",
    sourceStream: "writer/runs/run_1",
    sourceChain: [writerReceipt({ type: "problem.set", runId: "run_1", problem: "p" })],
    at: null,
    append: "appendix",
    resolvedProblem: "problem",
    config: WRITER_DEFAULT_CONFIG,
    resumeRequested: true,
  });

  const kinds = ops.map((op) => op.type);
  expect(kinds).toEqual(["fork", "emit", "enqueue_job", "redirect"]);
});

test("framework translators: theorem fresh run omits fork and append", () => {
  const runtime = stubRuntime<TheoremCmd, TheoremEvent, TheoremState>(theoremInitial);
  const ops = translateTheoremRunStartIntent({
    stream: "theorem",
    runId: "run_2",
    runStream: "theorem/runs/run_2",
    sourceStream: "theorem/runs/run_2",
    sourceChain: [],
    at: null,
    resolvedProblem: "problem",
    config: THEOREM_DEFAULT_CONFIG,
    resumeRequested: false,
  });

  const kinds = ops.map((op) => op.type);
  expect(kinds).toEqual(["enqueue_job", "redirect"]);
});

test("framework translators: theorem resume anchor follows the visible branch receipt", () => {
  const runStream = "theorem/runs/run_1";
  const branchStream = `${runStream}/branches/resume_demo_3`;
  let rootPrev: string | undefined;
  let branchPrev: string | undefined;

  const rootReceipt = (body: TheoremEvent, ts: number): Chain<TheoremEvent>[number] => {
    const next = receipt(runStream, rootPrev, body, ts);
    rootPrev = next.hash;
    return next;
  };
  const branchReceipt = (body: TheoremEvent, ts: number): Chain<TheoremEvent>[number] => {
    const next = receipt(branchStream, branchPrev, body, ts);
    branchPrev = next.hash;
    return next;
  };

  const displayChain: Chain<TheoremEvent> = [
    rootReceipt({ type: "problem.set", runId: "run_1", problem: "p" }, 1),
    rootReceipt({
      type: "attempt.proposed",
      runId: "run_1",
      claimId: "claim_root",
      agentId: "explorer_a",
      content: "root attempt",
    }, 2),
    rootReceipt({
      type: "branch.created",
      runId: "run_1",
      branchId: branchStream,
      forkAt: 2,
    }, 3),
    branchReceipt({
      type: "attempt.proposed",
      runId: "run_1",
      claimId: "claim_branch",
      agentId: "explorer_b",
      content: "branch attempt",
    }, 4),
    branchReceipt({
      type: "summary.made",
      runId: "run_1",
      claimId: "summary_branch",
      agentId: "synthesizer",
      bracket: "((A o B) o (C o D))",
      content: "branch summary",
    }, 5),
  ];

  const anchor = resolveTheoremResumeAnchor(displayChain, runStream, 5);
  expect(anchor?.stream).toBe(branchStream);
  expect(anchor?.hash).toBe(displayChain[4]?.hash);
});

test("framework translators: agent run intent emits enqueue + redirect", () => {
  const ops = translateAgentRunStartIntent({
    agentId: "agent",
    stream: "agent",
    runId: "run_1",
    problem: "Inspect files",
    config: AGENT_DEFAULT_CONFIG,
  });

  const kinds = ops.map((op) => op.type);
  expect(kinds).toEqual(["enqueue_job", "redirect"]);
  const enqueue = ops[0];
  expect(enqueue?.type).toBe("enqueue_job");
  if (enqueue?.type === "enqueue_job") {
    expect(enqueue.job.agentId).toBe("agent");
    expect(enqueue.job.singletonMode).toBe("cancel");
  }
});
