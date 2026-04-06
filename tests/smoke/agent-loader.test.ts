import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadAgentRoutes } from "../../src/framework/agent-loader";
import type { AgentLoaderContext } from "../../src/framework/agent-types";

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

const baseCtx: AgentLoaderContext = {
  dataDir: "",
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
    agent: dummyRuntime,
    memory: dummyRuntime,
  },
  prompts: {
    agent: {},
  },
  promptHashes: {
    agent: "",
  },
  promptPaths: {
    agent: "",
  },
  models: {
    agent: "",
  },
  helpers: {},
};

test("agent loader auto-discovers route modules", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-agent-loader-"));
  try {
    const routes = await loadAgentRoutes({
      ...baseCtx,
      dataDir,
    });
    const ids = routes.map((route) => route.id).sort();
    expect(ids).toContain("factory");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
