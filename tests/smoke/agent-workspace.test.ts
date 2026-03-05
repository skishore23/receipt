import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import type { DelegationTools } from "../../src/adapters/delegation.ts";
import type { MemoryTools } from "../../src/adapters/memory-tools.ts";
import { runAgent, type AgentRunInput } from "../../src/agents/agent.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import type { AgentCmd, AgentEvent, AgentState } from "../../src/modules/agent.ts";
import { decide as decideAgent, reduce as reduceAgent, initial as initialAgent } from "../../src/modules/agent.ts";

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const mkRuntime = (dir: string) => createRuntime<AgentCmd, AgentEvent, AgentState>(
  jsonlStore<AgentEvent>(dir),
  jsonBranchStore(dir),
  decideAgent,
  reduceAgent,
  initialAgent
);

test("agent workspace config scopes tools to configured subdirectory", async () => {
  const dir = await mkTmp("receipt-agent-workspace");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace-root");
  const workspace = path.join(workspaceRoot, "sandbox");

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "outside.txt"), "TOP_SECRET", "utf-8");
  await fs.writeFile(path.join(workspace, "inside.txt"), "inside", "utf-8");

  const runtime = mkRuntime(dataDir);

  const memoryTools: MemoryTools = {
    read: async () => [],
    search: async () => [],
    summarize: async () => ({ summary: "", entries: [] }),
    commit: async (input) => ({
      id: `mem_${Date.now().toString(36)}`,
      scope: input.scope,
      text: input.text,
      tags: input.tags,
      meta: input.meta,
      ts: Date.now(),
    }),
    diff: async () => [],
    reindex: async () => 0,
  };

  const delegationTools: DelegationTools = {
    "agent.delegate": async () => ({ output: "", summary: "" }),
    "agent.status": async () => ({ output: "", summary: "" }),
    "agent.inspect": async () => ({ output: "", summary: "" }),
  };

  let llmCalls = 0;
  const input: AgentRunInput = {
    stream: "agents/agent",
    runId: "workspace_scope",
    problem: "Try reading outside file",
    config: {
      maxIterations: 2,
      maxToolOutputChars: 2000,
      memoryScope: "agent",
      workspace: "sandbox",
    },
    runtime,
    prompts: {
      system: "",
      user: {
        loop: "{{problem}}\\n{{transcript}}\\n{{memory}}\\n{{workspace}}",
      },
    },
    llmText: async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return JSON.stringify({
          thought: "read candidate file",
          action: {
            type: "tool",
            name: "read",
            input: { path: "outside.txt" },
          },
        });
      }
      return JSON.stringify({
        thought: "done",
        action: {
          type: "final",
          text: "complete",
        },
      });
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools,
    workspaceRoot,
  };

  try {
    await runAgent(input);

    const runChain = await runtime.chain("agents/agent/runs/workspace_scope");
    const toolObserved = runChain
      .map((receipt) => receipt.body)
      .filter((event): event is Extract<AgentEvent, { type: "tool.observed" }> => event.type === "tool.observed");
    const toolCalled = runChain
      .map((receipt) => receipt.body)
      .filter((event): event is Extract<AgentEvent, { type: "tool.called" }> => event.type === "tool.called");

    assert.equal(toolObserved.some((event) => event.output.includes("TOP_SECRET")), false, "tool output leaked outside workspace content");

    const readCall = toolCalled.find((event) => event.tool === "read");
    assert.ok(readCall, "expected read tool call");
    assert.ok(readCall.error, "expected read tool call to fail outside configured workspace");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
