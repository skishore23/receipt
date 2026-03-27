import { test, expect } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import type { DelegationTools } from "../../src/adapters/delegation";
import type { MemoryTools } from "../../src/adapters/memory-tools";
import {
  AgentCapabilityRegistry,
  capabilityDefinition,
  capabilityInput,
  codexRunCapability,
  createBuiltinAgentCapabilities,
  createCapabilitySpec,
  factoryDispatchCapability,
} from "../../src/agents/capabilities";

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
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
