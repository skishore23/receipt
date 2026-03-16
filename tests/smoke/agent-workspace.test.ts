import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { zodTextFormat } from "openai/helpers/zod";

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

const structuredFromText = (llmText: AgentRunInput["llmText"]): AgentRunInput["llmStructured"] =>
  (async ({ system, user }) => {
    const raw = await llmText({ system, user });
    return {
      parsed: JSON.parse(raw) as never,
      raw,
    };
  }) as AgentRunInput["llmStructured"];

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
  const llmText: AgentRunInput["llmText"] = async () => {
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
  };
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
    llmText,
    llmStructured: structuredFromText(llmText),
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

    expect(toolObserved.some((event) => event.output.includes("TOP_SECRET"))).toBe(false);

    const readCall = toolCalled.find((event) => event.tool === "read");
    expect(readCall).toBeTruthy();
    expect(readCall.error).toBeTruthy();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("agent emits structured failure receipts when native structured output is invalid", async () => {
  const dir = await mkTmp("receipt-agent-parse-terminal");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace");

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });

  const runtime = mkRuntime(dataDir);
  const memoryTools = mkMemoryTools();
  const delegationTools = mkDelegationTools();

  const result = await runAgent({
    stream: "agents/agent",
    runId: "parse_terminal",
    problem: "Finish immediately.",
    config: {
      maxIterations: 1,
      maxToolOutputChars: 2000,
      memoryScope: "agent",
      workspace: ".",
    },
    runtime,
    prompts: {
      system: "",
      user: {
        loop: "{{problem}}\\n{{transcript}}\\n{{memory}}\\n{{workspace}}",
      },
    },
    llmText: async () => "text fallback should remain unused",
    llmStructured: async () => ({
      parsed: {
        thought: "done",
        action: {
          type: "final",
        },
      },
      raw: "{\"thought\":\"done\",\"action\":{\"type\":\"final\"}}",
    }),
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools,
    workspaceRoot,
  });

  try {
    const runChain = await runtime.chain("agents/agent/runs/parse_terminal");
    const failureReport = runChain.findLast((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "failure.report" }> } =>
      receipt.body.type === "failure.report"
    );
    const finalStatus = runChain.findLast((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "run.status" }> } =>
      receipt.body.type === "run.status"
    );

    expect(result.status).toBe("failed");
    expect(result.failure?.failureClass).toBe("model_json_parse");
    expect(failureReport).toBeTruthy();
    expect(failureReport?.body.failure.failureClass).toBe("model_json_parse");
    expect(failureReport?.body.failure.message ?? "").toMatch(/model final action missing text/i);
    expect(finalStatus?.body.status).toBe("failed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("agent uses native structured actions when available", async () => {
  const dir = await mkTmp("receipt-agent-structured");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace");

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "note.txt"), "hello", "utf-8");

  const runtime = mkRuntime(dataDir);
  const memoryTools = mkMemoryTools();
  const delegationTools = mkDelegationTools();

  let textCalls = 0;
  let structuredCalls = 0;
  const input: AgentRunInput = {
    stream: "agents/agent",
    runId: "structured_actions",
    problem: "Read note.txt and finish.",
    config: {
      maxIterations: 3,
      maxToolOutputChars: 2000,
      memoryScope: "agent",
      workspace: ".",
    },
    runtime,
    prompts: {
      system: "",
      user: {
        loop: "{{problem}}\\n{{transcript}}\\n{{memory}}\\n{{workspace}}",
      },
    },
    llmText: async () => {
      textCalls += 1;
      return JSON.stringify({
        thought: "unexpected text fallback",
        action: {
          type: "final",
          text: "fallback",
        },
      });
    },
    llmStructured: async ({ schema, schemaName }) => {
      structuredCalls += 1;
      const jsonSchema = zodTextFormat(schema, schemaName).schema as {
        readonly properties?: {
          readonly action?: {
            readonly properties?: {
              readonly input?: { readonly type?: string; readonly propertyNames?: unknown; readonly additionalProperties?: unknown };
              readonly name?: { readonly anyOf?: ReadonlyArray<{ readonly type?: string }> };
              readonly text?: { readonly anyOf?: ReadonlyArray<{ readonly type?: string }> };
            };
            readonly required?: ReadonlyArray<string>;
          };
        };
      };
      if (structuredCalls === 1) {
        const actionSchema = jsonSchema.properties?.action;
        expect(actionSchema?.required).toEqual(["type", "name", "input", "text"]);
        expect(actionSchema?.properties?.name?.anyOf?.some((branch) => branch.type === "null")).toBe(true);
        expect(actionSchema?.properties?.text?.anyOf?.some((branch) => branch.type === "null")).toBe(true);
        expect(actionSchema?.properties?.input?.type).toBe("string");
        expect("propertyNames" in (actionSchema?.properties?.input ?? {})).toBe(false);
        expect("additionalProperties" in (actionSchema?.properties?.input ?? {})).toBe(false);
      }
      if (structuredCalls === 1) {
        return {
          parsed: {
            thought: "read the file",
            action: {
              type: "tool",
              name: "read",
              input: "{\"path\":\"note.txt\"}",
              text: null,
            },
          },
          raw: "{\"thought\":\"read the file\",\"action\":{\"type\":\"tool\",\"name\":\"read\",\"input\":\"{\\\"path\\\":\\\"note.txt\\\"}\",\"text\":null}}",
        };
      }
      return {
        parsed: {
          thought: "done",
          action: {
            type: "final",
            name: null,
            input: "{}",
            text: "complete",
          },
        },
        raw: "{\"thought\":\"done\",\"action\":{\"type\":\"final\",\"name\":null,\"input\":\"{}\",\"text\":\"complete\"}}",
      };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools,
    workspaceRoot,
  };

  try {
    await runAgent(input);

    const runChain = await runtime.chain("agents/agent/runs/structured_actions");
    const final = runChain.findLast((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "response.finalized" }> } =>
      receipt.body.type === "response.finalized"
    );
    const readObserved = runChain.find((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "tool.observed" }> } =>
      receipt.body.type === "tool.observed" && receipt.body.tool === "read"
    );
    const jsonValidationEvents = runChain.filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "validation.report" }> } =>
      receipt.body.type === "validation.report" && receipt.body.gate === "model_json"
    );

    expect(textCalls).toBe(0);
    expect(structuredCalls).toBe(2);
    expect(readObserved?.body.output ?? "").toMatch(/hello/);
    expect(final?.body.content ?? "").toMatch(/complete/);
    expect(
      jsonValidationEvents.some((receipt) => receipt.body.ok === true && /native structured action parsed/.test(receipt.body.summary))
    ).toBeTruthy();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("agent fails fast when native structured action fails", async () => {
  const dir = await mkTmp("receipt-agent-structured-fallback");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace");

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "note.txt"), "hello", "utf-8");

  const runtime = mkRuntime(dataDir);
  const memoryTools = mkMemoryTools();
  const delegationTools = mkDelegationTools();

  let textCalls = 0;
  let structuredCalls = 0;
  const input: AgentRunInput = {
    stream: "agents/agent",
    runId: "structured_fallback",
    problem: "Read note.txt and finish.",
    config: {
      maxIterations: 3,
      maxToolOutputChars: 2000,
      memoryScope: "agent",
      workspace: ".",
    },
    runtime,
    prompts: {
      system: "",
      user: {
        loop: "{{problem}}\\n{{transcript}}\\n{{memory}}\\n{{workspace}}",
      },
    },
    llmText: async () => {
      textCalls += 1;
      if (textCalls === 1) {
        return JSON.stringify({
          thought: "read the file",
          action: {
            type: "tool",
            name: "read",
            input: { path: "note.txt" },
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
    llmStructured: async () => {
      structuredCalls += 1;
      throw new Error("structured outputs unavailable");
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools,
    workspaceRoot,
  };

  try {
    const result = await runAgent(input);

    const runChain = await runtime.chain("agents/agent/runs/structured_fallback");
    const finalStatus = runChain.findLast((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "run.status" }> } =>
      receipt.body.type === "run.status"
    );
    const jsonValidationEvents = runChain.filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "validation.report" }> } =>
      receipt.body.type === "validation.report" && receipt.body.gate === "model_json"
    );

    expect(result.status).toBe("failed");
    expect(structuredCalls).toBe(1);
    expect(textCalls).toBe(0);
    expect(finalStatus?.body.status).toBe("failed");
    expect(
      jsonValidationEvents.some((receipt) => receipt.body.ok === false && /native structured action failed/.test(receipt.body.summary))
    ).toBeTruthy();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
