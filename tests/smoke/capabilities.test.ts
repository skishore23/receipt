import { test, expect } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { createRuntime } from "@receipt/core/runtime";
import type { DelegationTools } from "../../src/adapters/delegation";
import type { MemoryTools } from "../../src/adapters/memory-tools";
import { sqliteBranchStore, sqliteReceiptStore } from "../../src/adapters/sqlite";
import {
  AgentCapabilityRegistry,
  capabilityDefinition,
  capabilityInput,
  codexRunCapability,
  createBuiltinAgentCapabilities,
  createCapabilitySpec,
  factoryDispatchCapability,
  factoryStatusCapability,
} from "../../src/agents/capabilities";
import { agentRunStream } from "../../src/agents/agent.streams";
import { decide as decideAgent, initial as initialAgent, reduce as reduceAgent, type AgentCmd, type AgentEvent, type AgentState } from "../../src/modules/agent";
import { repoKeyForRoot, factoryChatSessionStream } from "../../src/services/factory-chat-profiles";

const mkMemoryTools = (): MemoryTools => ({
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
});

const mkDelegationTools = (): DelegationTools => ({
  "agent.delegate": async () => ({ output: "", summary: "" }),
  "agent.status": async () => ({ output: "", summary: "" }),
  "agent.inspect": async () => ({ output: "", summary: "" }),
});

const createAgentRuntime = (dataDir: string) =>
  createRuntime<AgentCmd, AgentEvent, AgentState>(
    sqliteReceiptStore<AgentEvent>(dataDir),
    sqliteBranchStore(dataDir),
    decideAgent,
    reduceAgent,
    initialAgent,
  );

const emitIndexedAgentEvent = async (
  runtime: ReturnType<typeof createAgentRuntime>,
  sessionStream: string,
  runId: string,
  event: AgentEvent,
): Promise<void> => {
  const runStream = agentRunStream(sessionStream, runId);
  await runtime.execute(runStream, {
    type: "emit",
    event,
    eventId: `${runStream}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
  });
  await runtime.execute(sessionStream, {
    type: "emit",
    event,
    eventId: `${sessionStream}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
  });
};

test("capability registry filters allowlist and unavailable capabilities", () => {
  const registry = new AgentCapabilityRegistry({
    capabilities: [
      createCapabilitySpec(
        capabilityDefinition({
          id: "visible",
          description: "{} - Visible capability.",
          inputSchema: capabilityInput.empty,
        }),
        async () => ({ output: "ok", summary: "ok" }),
      ),
      createCapabilitySpec(
        capabilityDefinition({
          id: "hidden",
          description: "{} - Hidden capability.",
          inputSchema: capabilityInput.empty,
        }),
        async () => ({ output: "hidden", summary: "hidden" }),
        { isAvailable: () => false },
      ),
      createCapabilitySpec(
        capabilityDefinition({
          id: "other",
          description: "{} - Other capability.",
          inputSchema: capabilityInput.empty,
        }),
        async () => ({ output: "other", summary: "other" }),
      ),
    ],
    allowlist: ["visible", "hidden"],
  });

  expect(registry.ids()).toEqual(["visible"]);
  expect(registry.describe("hidden")).toBeUndefined();
  expect(registry.renderToolHelp()).toContain("- visible: {} - Visible capability.");
  expect(registry.renderToolHelp()).not.toContain("hidden");
});

test("skill.read resolves registry-backed docs for built-in and shared capabilities", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-capabilities-"));
  try {
    const registry = new AgentCapabilityRegistry({
      capabilities: [
        ...createBuiltinAgentCapabilities({
          workspaceRoot: dir,
          defaultMemoryScope: "agent",
          maxToolOutputChars: 4000,
          memoryTools: mkMemoryTools(),
          delegationTools: mkDelegationTools(),
        }),
        createCapabilitySpec(
          capabilityDefinition({
            id: "test.custom",
            description: '{"value"?: string} - Custom capability.',
            inputSchema: capabilityInput.empty,
          }),
          async () => ({ output: "custom", summary: "custom" }),
        ),
        createCapabilitySpec(
          codexRunCapability,
          async () => ({ output: "codex", summary: "codex" }),
        ),
        createCapabilitySpec(
          factoryDispatchCapability,
          async () => ({ output: "factory", summary: "factory" }),
        ),
      ],
      allowlist: ["skill.read", "ls", "test.custom", "codex.run", "factory.dispatch"],
    });

    const builtIn = await registry.execute("skill.read", { name: "ls" });
    const custom = await registry.execute("skill.read", { name: "test.custom" });
    const codex = await registry.execute("skill.read", { name: "codex.run" });
    const factory = await registry.execute("skill.read", { name: "factory.dispatch" });

    expect(builtIn.output).toContain('ls: {"path"?: string}');
    expect(custom.output).toContain('test.custom: {"value"?: string} - Custom capability.');
    expect(codex.output).toContain('codex.run: {"prompt": string, "timeoutMs"?: number}');
    expect(factory.output).toContain('factory.dispatch: {"action"?: "create"|"react"|"promote"|"cancel"|"cleanup"|"archive"');
    expect(factory.output).not.toContain('"profileId"?: string');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("session.search and session.read expose projected transcript recall", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-capabilities-session-"));
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-capabilities-session-repo-"));
  try {
    const runtime = createAgentRuntime(dir);
    const sessionStream = factoryChatSessionStream(repoRoot, "generalist", "chat_search");
    await emitIndexedAgentEvent(runtime, sessionStream, "run_01", {
      type: "problem.set",
      runId: "run_01",
      problem: "Deploy the Docker image to staging.",
      agentId: "orchestrator",
    });
    await emitIndexedAgentEvent(runtime, sessionStream, "run_01", {
      type: "response.finalized",
      runId: "run_01",
      agentId: "orchestrator",
      content: "The Docker image should go to staging after PostgreSQL is ready.",
    });
    const registry = new AgentCapabilityRegistry({
      capabilities: createBuiltinAgentCapabilities({
        workspaceRoot: repoRoot,
        defaultMemoryScope: "agent",
        maxToolOutputChars: 4000,
        memoryTools: mkMemoryTools(),
        delegationTools: mkDelegationTools(),
        sessionHistoryDataDir: dir,
        sessionHistoryContext: {
          repoKey: repoKeyForRoot(repoRoot),
          profileId: "generalist",
          sessionStream,
        },
      }),
      allowlist: ["session.search", "session.read"],
    });

    const search = await registry.execute("session.search", { query: "docker staging postgres" });
    const read = await registry.execute("session.read", {});

    expect(search.output).toContain("Docker image");
    expect(read.output).toContain("Deploy the Docker image to staging.");
    expect(read.output).toContain("PostgreSQL");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("capability registry resolves the factory.objective compatibility alias", async () => {
  const registry = new AgentCapabilityRegistry({
    capabilities: [
      createCapabilitySpec(
        factoryStatusCapability,
        async (input) => ({ output: JSON.stringify(input), summary: "status" }),
      ),
    ],
    allowlist: ["factory.status"],
  });

  const result = await registry.execute("factory.objective", { objectiveId: "objective_demo" });

  expect(result.summary).toBe("status");
  expect(result.output).toContain('"objectiveId":"objective_demo"');
});

test("factory.dispatch accepts a single checks string and normalizes it to an array", async () => {
  const registry = new AgentCapabilityRegistry({
    capabilities: [
      createCapabilitySpec(
        factoryDispatchCapability,
        async (input) => ({ output: JSON.stringify(input), summary: "dispatch" }),
      ),
    ],
    allowlist: ["factory.dispatch"],
  });

  const result = await registry.execute("factory.dispatch", {
    action: "create",
    prompt: "Add pagination.",
    checks: "repo_profile",
  });

  expect(result.summary).toBe("dispatch");
  expect(result.output).toContain('"checks":["repo_profile"]');
});
