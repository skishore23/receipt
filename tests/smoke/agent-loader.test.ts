import assert from "node:assert/strict";
import test from "node:test";

import { loadAgentRoutes } from "../../src/framework/agent-loader.ts";
import type { AgentLoaderContext } from "../../src/framework/agent-types.ts";

const dummyRuntime = {
  execute: async () => [],
  state: async () => ({}),
  stateAt: async () => ({}),
  chain: async () => [],
  chainAt: async () => [],
  verify: async () => ({ ok: true, count: 0 }),
  fork: async (stream: string, _at: number, _name: string) => ({ name: stream, createdAt: Date.now() }),
  branch: async () => undefined,
  branches: async () => [],
  children: async () => [],
};

const dummyQueue = {
  enqueue: async () => ({ id: "job", status: "queued", commands: [] }),
  leaseNext: async () => undefined,
  heartbeat: async () => undefined,
  complete: async () => undefined,
  fail: async () => undefined,
  cancel: async () => undefined,
  queueCommand: async () => ({ id: "cmd" }),
  consumeCommands: async () => [],
  getJob: async () => undefined,
  listJobs: async () => [],
  waitForJob: async () => undefined,
};

const ctx: AgentLoaderContext = {
  dataDir: "data",
  sse: {
    publish: () => {},
    publishData: () => {},
    subscribe: () => new Response(""),
  } as AgentLoaderContext["sse"],
  llmText: async () => "",
  enqueueJob: async () => {},
  queue: dummyQueue as AgentLoaderContext["queue"],
  jobRuntime: dummyRuntime as AgentLoaderContext["jobRuntime"],
  runtimes: {
    todo: dummyRuntime,
    theorem: dummyRuntime,
    "axiom-simple": dummyRuntime,
    writer: dummyRuntime,
    agent: dummyRuntime,
    axiom: dummyRuntime,
    inspector: dummyRuntime,
    selfImprovement: dummyRuntime,
    memory: dummyRuntime,
  },
  prompts: {
    theorem: {},
    writer: {},
    inspector: {},
    agent: {},
    axiom: {},
  },
  promptHashes: {
    theorem: "",
    writer: "",
    inspector: "",
    agent: "",
    axiom: "",
  },
  promptPaths: {
    theorem: "",
    writer: "",
    inspector: "",
    agent: "",
    axiom: "",
  },
  models: {
    theorem: "",
    writer: "",
    inspector: "",
    agent: "",
    axiom: "",
  },
  helpers: {},
};

test("agent loader auto-discovers route modules", async () => {
  const routes = await loadAgentRoutes(ctx);
  const ids = routes.map((route) => route.id).sort();
  assert.equal(ids.includes("todo"), true);
  assert.equal(ids.includes("axiom"), true);
  assert.equal(ids.includes("axiom-simple"), true);
  assert.equal(ids.includes("theorem"), true);
  assert.equal(ids.includes("writer"), true);
  assert.equal(ids.includes("agent"), true);
  assert.equal(ids.includes("receipt-inspector"), true);
});
