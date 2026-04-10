import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { receipt } from "@receipt/core/chain";
import { createRuntime } from "@receipt/core/runtime";

import { sqliteBranchStore, sqliteReceiptStore } from "../../src/adapters/sqlite";
import { agentRunStream } from "../../src/agents/agent.streams";
import { buildChatItemsForRun } from "../../src/agents/factory/chat-items";
import type { FactoryChatContextProjection } from "../../src/agents/factory/chat-context";
import { readChatContextProjection, syncChangedChatContextProjections } from "../../src/db/projectors";
import { readSessionHistory, searchSessionHistory } from "../../src/services/session-history";
import { decide as decideAgent, initial as initialAgent, reduce as reduceAgent, type AgentCmd, type AgentEvent, type AgentState } from "../../src/modules/agent";
import { factoryChatSessionStream } from "../../src/services/factory-chat-profiles";

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

const emitAgentEvent = async (
  runtime: ReturnType<typeof createAgentRuntime>,
  stream: string,
  event: AgentEvent,
): Promise<void> => {
  await runtime.execute(stream, {
    type: "emit",
    event,
    eventId: `${stream}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
  });
};

const emitIndexedAgentEvent = async (
  runtime: ReturnType<typeof createAgentRuntime>,
  sessionStream: string,
  runId: string,
  event: AgentEvent,
): Promise<void> => {
  const runStream = agentRunStream(sessionStream, runId);
  await emitAgentEvent(runtime, runStream, event);
  await emitAgentEvent(runtime, sessionStream, event);
};

const createChatContextFixture = (overrides: Partial<FactoryChatContextProjection> = {}): FactoryChatContextProjection => ({
  version: 2,
  chatId: "chat_demo",
  profileId: "generalist",
  updatedAt: 1,
  conversation: [{
    role: "user",
    text: "Who are you?",
    runId: "run_01",
    ts: 1,
    refs: [{
      stream: "agents/factory/demo/sessions/chat_demo",
      eventType: "problem.set",
      ts: 1,
      receiptHash: "hash_problem",
    }],
  }, {
    role: "assistant",
    text: "I am the active engineer for this chat.",
    runId: "run_01",
    ts: 2,
    refs: [{
      stream: "agents/factory/demo/sessions/chat_demo",
      eventType: "response.finalized",
      ts: 2,
      receiptHash: "hash_final",
    }],
  }],
  runs: [{
    runId: "run_01",
    objectiveId: "objective_demo",
    status: "completed",
    firstTs: 1,
    updatedAt: 2,
    terminal: true,
  }],
  bindings: {
    chatId: "chat_demo",
    profileId: "generalist",
    objectiveId: "objective_demo",
    latestRunId: "run_01",
  },
  imports: {
    objective: {
      objectiveId: "objective_demo",
      title: "Demo objective",
      status: "active",
      phase: "collecting_evidence",
      summary: "Demo objective is executing.",
      importedBecause: "requested",
    },
    runtime: {
      summary: "task task_01 is still running.",
      importedBecause: "requested",
      objectiveId: "objective_demo",
      focusKind: "task",
      focusId: "task_01",
      active: true,
    },
  },
  style: {
    responseStyle: "conversational",
    latestUserText: "Who are you?",
  },
  source: {
    sessionStream: "agents/factory/demo/sessions/chat_demo",
    runStreams: ["agents/factory/demo/sessions/chat_demo/runs/run_01"],
    lastGlobalSeq: 2,
    receiptRefs: [{
      stream: "agents/factory/demo/sessions/chat_demo",
      eventType: "problem.set",
      ts: 1,
      receiptHash: "hash_problem",
    }, {
      stream: "agents/factory/demo/sessions/chat_demo",
      eventType: "response.finalized",
      ts: 2,
      receiptHash: "hash_final",
    }],
  },
  ...overrides,
});

test("factory chat context projection: builds a conversation-only transcript and ignores internal telemetry", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-context");
  const repoRoot = await createTempDir("receipt-factory-chat-context-repo");
  const runtime = createAgentRuntime(dataDir);
  const sessionStream = factoryChatSessionStream(repoRoot, "generalist", "chat_context");

  await emitIndexedAgentEvent(runtime, sessionStream, "run_01", {
    type: "problem.set",
    runId: "run_01",
    problem: "What is the current status?",
    agentId: "orchestrator",
  });
  await emitAgentEvent(runtime, agentRunStream(sessionStream, "run_01"), {
    type: "thought.logged",
    runId: "run_01",
    iteration: 1,
    agentId: "orchestrator",
    content: "internal thought that should not appear",
  });
  await emitAgentEvent(runtime, agentRunStream(sessionStream, "run_01"), {
    type: "tool.called",
    runId: "run_01",
    iteration: 1,
    agentId: "orchestrator",
    tool: "factory.status",
    input: {},
    summary: "checked status",
  });
  await emitAgentEvent(runtime, agentRunStream(sessionStream, "run_01"), {
    type: "validation.report",
    runId: "run_01",
    iteration: 1,
    agentId: "orchestrator",
    gate: "model_json",
    ok: true,
    summary: "validated",
  });
  await emitIndexedAgentEvent(runtime, sessionStream, "run_01", {
    type: "thread.bound",
    runId: "run_01",
    agentId: "orchestrator",
    objectiveId: "objective_demo",
    chatId: "chat_context",
    reason: "startup",
  });
  await emitIndexedAgentEvent(runtime, sessionStream, "run_01", {
    type: "response.finalized",
    runId: "run_01",
    agentId: "orchestrator",
    content: "Current status is active.",
  });

  await syncChangedChatContextProjections(dataDir);
  const projection = readChatContextProjection(dataDir, sessionStream);

  expect(projection?.conversation).toEqual([
    expect.objectContaining({ role: "user", text: "What is the current status?", runId: "run_01" }),
    expect.objectContaining({ role: "assistant", text: "Current status is active.", runId: "run_01" }),
  ]);
  expect(projection?.conversation).toHaveLength(2);
  expect(JSON.stringify(projection)).not.toContain("internal thought that should not appear");
  expect(JSON.stringify(projection)).not.toContain("checked status");
  expect(projection?.bindings.objectiveId).toBe("objective_demo");
  expect(projection?.runs).toEqual([
    expect.objectContaining({
      runId: "run_01",
      objectiveId: "objective_demo",
      status: "completed",
      terminal: true,
    }),
  ]);
  expect(projection?.source.runStreams).toContain(agentRunStream(sessionStream, "run_01"));
});

test("factory chat context projection: refreshes from change log and only binds objectives after thread.bound", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-context-refresh");
  const repoRoot = await createTempDir("receipt-factory-chat-context-refresh-repo");
  const runtime = createAgentRuntime(dataDir);
  const sessionStream = factoryChatSessionStream(repoRoot, "generalist", "chat_refresh");

  await emitIndexedAgentEvent(runtime, sessionStream, "run_01", {
    type: "problem.set",
    runId: "run_01",
    problem: "hello",
    agentId: "orchestrator",
  });
  await emitIndexedAgentEvent(runtime, sessionStream, "run_01", {
    type: "response.finalized",
    runId: "run_01",
    agentId: "orchestrator",
    content: "hi",
  });

  await syncChangedChatContextProjections(dataDir);
  const firstProjection = readChatContextProjection(dataDir, sessionStream);
  expect(firstProjection?.bindings.objectiveId).toBeUndefined();
  expect(firstProjection?.bindings.latestRunId).toBe("run_01");

  await emitIndexedAgentEvent(runtime, sessionStream, "run_01", {
    type: "thread.bound",
    runId: "run_01",
    agentId: "orchestrator",
    objectiveId: "objective_bound",
    chatId: "chat_refresh",
    reason: "startup",
  });
  await emitIndexedAgentEvent(runtime, sessionStream, "run_02", {
    type: "problem.set",
    runId: "run_02",
    problem: "follow up",
    agentId: "orchestrator",
  });
  await emitIndexedAgentEvent(runtime, sessionStream, "run_02", {
    type: "response.finalized",
    runId: "run_02",
    agentId: "orchestrator",
    content: "follow up answer",
  });

  await syncChangedChatContextProjections(dataDir);
  const refreshedProjection = readChatContextProjection(dataDir, sessionStream);
  expect(refreshedProjection?.bindings.objectiveId).toBe("objective_bound");
  expect(refreshedProjection?.bindings.latestRunId).toBe("run_02");
  expect(refreshedProjection?.runs).toEqual([
    expect.objectContaining({ runId: "run_01", objectiveId: "objective_bound" }),
    expect.objectContaining({ runId: "run_02" }),
  ]);
  expect(refreshedProjection?.conversation.map((message) => message.runId)).toEqual([
    "run_01",
    "run_01",
    "run_02",
    "run_02",
  ]);
});

test("factory chat context projection: prefers finalized handoff interpretations over raw handoff summaries", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-context-handoff");
  const repoRoot = await createTempDir("receipt-factory-chat-context-handoff-repo");
  const runtime = createAgentRuntime(dataDir);
  const sessionStream = factoryChatSessionStream(repoRoot, "generalist", "chat_handoff");

  await emitIndexedAgentEvent(runtime, sessionStream, "run_handoff", {
    type: "objective.handoff",
    runId: "run_handoff",
    agentId: "orchestrator",
    objectiveId: "objective_demo",
    title: "Investigate NAT gateway cost spike",
    status: "blocked",
    summary: "We proved it was a NAT data-processing surge.",
    blocker: "Historical flow logs are gone.",
    nextAction: "Use /react with retained evidence.",
    handoffKey: "handoff_demo",
    sourceUpdatedAt: 1_710_000_000_000,
  });
  await emitIndexedAgentEvent(runtime, sessionStream, "run_handoff", {
    type: "response.finalized",
    runId: "run_handoff",
    agentId: "orchestrator",
    content: "The NAT surge is confirmed, but attribution is still blocked because the historical flow logs are gone.",
  });

  await syncChangedChatContextProjections(dataDir);
  const projection = readChatContextProjection(dataDir, sessionStream);

  expect(projection?.conversation).toEqual([
    expect.objectContaining({
      role: "assistant",
      runId: "run_handoff",
      text: "The NAT surge is confirmed, but attribution is still blocked because the historical flow logs are gone.",
    }),
  ]);
});

test("factory chat context projection: rebuilds session message history and supports FTS search", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-session-search");
  const repoRoot = await createTempDir("receipt-factory-chat-session-search-repo");
  const runtime = createAgentRuntime(dataDir);
  const sessionStream = factoryChatSessionStream(repoRoot, "generalist", "chat_search");

  await emitIndexedAgentEvent(runtime, sessionStream, "run_01", {
    type: "problem.set",
    runId: "run_01",
    problem: "Please use PostgreSQL on port 5433 for staging.",
    agentId: "orchestrator",
  });
  await emitIndexedAgentEvent(runtime, sessionStream, "run_01", {
    type: "response.finalized",
    runId: "run_01",
    agentId: "orchestrator",
    content: "PostgreSQL is configured for staging on port 5433.",
  });
  await emitIndexedAgentEvent(runtime, sessionStream, "run_02", {
    type: "problem.set",
    runId: "run_02",
    problem: "The Docker container needs PostgreSQL credentials as well.",
    agentId: "orchestrator",
  });
  await emitIndexedAgentEvent(runtime, sessionStream, "run_02", {
    type: "response.finalized",
    runId: "run_02",
    agentId: "orchestrator",
    content: "I noted the Docker credentials requirement.",
  });

  await syncChangedChatContextProjections(dataDir);
  const messages = await readSessionHistory({
    dataDir,
    sessionStream,
  });
  const hits = await searchSessionHistory({
    dataDir,
    query: "postgres docker 5433",
    limit: 3,
  });

  expect(messages.map((message) => message.text)).toEqual([
    "Please use PostgreSQL on port 5433 for staging.",
    "PostgreSQL is configured for staging on port 5433.",
    "The Docker container needs PostgreSQL credentials as well.",
    "I noted the Docker credentials requirement.",
  ]);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]?.sessionStream).toBe(sessionStream);
  expect(hits.map((hit) => `${hit.role}:${hit.text}`).join("\n")).toContain("Docker container");
});

test("factory chat UI: chat items consume projected chat context", () => {
  const sessionStream = "agents/factory/demo/sessions/chat_demo";
  const chain = [
    receipt(agentRunStream(sessionStream, "run_01"), undefined, {
      type: "problem.set",
      runId: "run_01",
      problem: "Old problem",
      agentId: "orchestrator",
    }, 1),
    receipt(agentRunStream(sessionStream, "run_01"), undefined, {
      type: "response.finalized",
      runId: "run_01",
      agentId: "orchestrator",
      content: "Old final",
    }, 2),
  ];
  const chatContext = createChatContextFixture();
  const items = buildChatItemsForRun("run_01", chain, new Map(), {
    conversation: chatContext.conversation.filter((message) => message.runId === "run_01"),
  });
  expect(items.find((item) => item.kind === "user" && item.body === "Who are you?")).toBeTruthy();
  expect(items.find((item) => item.kind === "assistant" && item.body.includes("active engineer"))).toBeTruthy();
});
