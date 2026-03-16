import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import type { DelegationTools } from "../../src/adapters/delegation.ts";
import type { MemoryTools } from "../../src/adapters/memory-tools.ts";
import { runInfra, normalizeInfraConfig } from "../../src/agents/infra.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import type { AgentCmd, AgentEvent, AgentState } from "../../src/modules/agent.ts";
import { decide as decideAgent, reduce as reduceAgent, initial as initialAgent } from "../../src/modules/agent.ts";
import { hashInfraPrompts, loadInfraPrompts } from "../../src/prompts/infra.ts";

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

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findLastEvent = <T extends AgentEvent["type"]>(
  chain: Awaited<ReturnType<ReturnType<typeof mkRuntime>["chain"]>>,
  type: T,
): Extract<AgentEvent, { type: T }> | undefined =>
  chain.findLast((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: T }> } => receipt.body.type === type)?.body;

test("normalizeInfraConfig defaults the memory scope to infra", () => {
  const config = normalizeInfraConfig({});
  expect(config.memoryScope).toBe("infra");
  expect(config.workspace).toBe(".");
});

test("infra runner exposes aws.cli in prompts and executes a stubbed AWS CLI", async () => {
  const dir = await mkTmp("receipt-infra-agent");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  const awsFile = process.platform === "win32" ? path.join(binDir, "aws.cmd") : path.join(binDir, "aws");

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });

  if (process.platform === "win32") {
    await fs.writeFile(awsFile, "@echo off\r\necho {\"Arn\":\"arn:aws:iam::123456789012:user/test\"}\r\n", "utf-8");
  } else {
    await fs.writeFile(awsFile, "#!/bin/sh\nprintf '%s\\n' '{\"Arn\":\"arn:aws:iam::123456789012:user/test\"}'\n", "utf-8");
    await fs.chmod(awsFile, 0o755);
  }

  const runtime = mkRuntime(dataDir);
  const prompts = loadInfraPrompts();
  const promptHash = hashInfraPrompts(prompts);
  const memoryTools = mkMemoryTools();
  const delegationTools = mkDelegationTools();

  const users: string[] = [];
  const systems: string[] = [];
  let textCalls = 0;
  let structuredCalls = 0;
  const priorPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${priorPath ?? ""}`;

  try {
    const result = await runInfra({
      stream: "agents/infra",
      runId: "infra_prompt_tooling",
      problem: "Inspect AWS caller identity and summarize it.",
      config: normalizeInfraConfig({
        maxIterations: 2,
        maxToolOutputChars: 2000,
        workspace: ".",
      }),
      runtime,
      prompts,
      llmText: async () => {
        textCalls += 1;
        return "";
      },
      llmStructured: async ({ system, user }) => {
        structuredCalls += 1;
        systems.push(system ?? "");
        users.push(user);
        if (structuredCalls === 1) {
          return {
            parsed: {
              thought: "Query AWS directly.",
              action: {
                type: "tool",
                name: "aws.cli",
                input: "{\"args\":[\"sts\",\"get-caller-identity\"]}",
                text: null,
              },
            },
            raw: "{\"thought\":\"Query AWS directly.\",\"action\":{\"type\":\"tool\",\"name\":\"aws.cli\",\"input\":\"{\\\"args\\\":[\\\"sts\\\",\\\"get-caller-identity\\\"]}\",\"text\":null}}",
          };
        }
        return {
          parsed: {
            thought: "Done.",
            action: {
              type: "final",
              name: null,
              input: "{}",
              text: "Caller identity inspected.",
            },
          },
          raw: "{\"thought\":\"Done.\",\"action\":{\"type\":\"final\",\"name\":null,\"input\":\"{}\",\"text\":\"Caller identity inspected.\"}}",
        };
      },
      model: "test-model",
      promptHash,
      promptPath: "prompts/infra.prompts.json",
      apiReady: true,
      memoryTools,
      delegationTools,
      workspaceRoot,
    });

    const runChain = await runtime.chain("agents/infra/runs/infra_prompt_tooling");
    const configured = findLastEvent(runChain, "run.configured");
    const toolCalled = runChain.find((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "tool.called" }> } =>
      receipt.body.type === "tool.called" && receipt.body.tool === "aws.cli"
    )?.body;
    const observed = runChain.find((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "tool.observed" }> } =>
      receipt.body.type === "tool.observed" && receipt.body.tool === "aws.cli"
    )?.body;
    const final = findLastEvent(runChain, "response.finalized");

    expect(result.status).toBe("completed");
    expect(textCalls).toBe(0);
    expect(structuredCalls).toBe(2);
    expect(systems[0] ?? "").toMatch(/AWS/i);
    expect(users[0] ?? "").toMatch(/aws\.cli/);
    expect(configured?.workflow.id).toBe("infra-v1");
    expect(configured?.config.memoryScope).toBe("infra");
    expect(configured?.promptPath).toBe("prompts/infra.prompts.json");
    expect(toolCalled?.summary ?? "").toMatch(/aws sts get-caller-identity -> exit 0/);
    expect(toolCalled?.error).toBe(undefined);
    expect(observed?.output ?? "").toMatch(/arn:aws:iam::123456789012:user\/test/);
    expect(final?.content ?? "").toMatch(/Caller identity inspected/);
  } finally {
    process.env.PATH = priorPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("infra runner resolves aws.cli cwd from config.workspace and relative overrides", async () => {
  const dir = await mkTmp("receipt-infra-agent-workspace");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace-root");
  const configuredWorkspace = path.join(workspaceRoot, "nested-workspace");
  const childWorkspace = path.join(configuredWorkspace, "child-dir");
  const binDir = path.join(dir, "bin");
  const awsFile = process.platform === "win32" ? path.join(binDir, "aws.cmd") : path.join(binDir, "aws");

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(childWorkspace, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });

  if (process.platform === "win32") {
    await fs.writeFile(awsFile, "@echo off\r\necho %CD%\r\n", "utf-8");
  } else {
    await fs.writeFile(awsFile, "#!/bin/sh\npwd\n", "utf-8");
    await fs.chmod(awsFile, 0o755);
  }

  const runtime = mkRuntime(dataDir);
  const prompts = loadInfraPrompts();
  const memoryTools = mkMemoryTools();
  const delegationTools = mkDelegationTools();
  let structuredCalls = 0;
  const priorPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${priorPath ?? ""}`;

  try {
    const result = await runInfra({
      stream: "agents/infra",
      runId: "infra_workspace_resolution",
      problem: "Inspect the configured infrastructure workspace.",
      config: normalizeInfraConfig({
        maxIterations: 3,
        maxToolOutputChars: 2000,
        workspace: "nested-workspace",
      }),
      runtime,
      prompts,
      llmText: async () => "",
      llmStructured: async () => {
        structuredCalls += 1;
        if (structuredCalls === 1) {
          return {
            parsed: {
              thought: "Inspect the default workspace root.",
              action: {
                type: "tool",
                name: "aws.cli",
                input: "{\"args\":[\"sts\",\"get-caller-identity\"]}",
                text: null,
              },
            },
            raw: "{\"thought\":\"Inspect the default workspace root.\",\"action\":{\"type\":\"tool\",\"name\":\"aws.cli\",\"input\":\"{\\\"args\\\":[\\\"sts\\\",\\\"get-caller-identity\\\"]}\",\"text\":null}}",
          };
        }
        if (structuredCalls === 2) {
          return {
            parsed: {
              thought: "Inspect a relative child directory from the configured workspace.",
              action: {
                type: "tool",
                name: "aws.cli",
                input: "{\"args\":[\"sts\",\"get-caller-identity\"],\"cwd\":\"child-dir\"}",
                text: null,
              },
            },
            raw: "{\"thought\":\"Inspect a relative child directory from the configured workspace.\",\"action\":{\"type\":\"tool\",\"name\":\"aws.cli\",\"input\":\"{\\\"args\\\":[\\\"sts\\\",\\\"get-caller-identity\\\"],\\\"cwd\\\":\\\"child-dir\\\"}\",\"text\":null}}",
          };
        }
        return {
          parsed: {
            thought: "Done.",
            action: {
              type: "final",
              name: null,
              input: "{}",
              text: "Workspace inspection complete.",
            },
          },
          raw: "{\"thought\":\"Done.\",\"action\":{\"type\":\"final\",\"name\":null,\"input\":\"{}\",\"text\":\"Workspace inspection complete.\"}}",
        };
      },
      model: "test-model",
      apiReady: true,
      memoryTools,
      delegationTools,
      workspaceRoot,
    });

    const runChain = await runtime.chain("agents/infra/runs/infra_workspace_resolution");
    const observed = runChain
      .filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "tool.observed" }> } =>
        receipt.body.type === "tool.observed" && receipt.body.tool === "aws.cli"
      )
      .map((receipt) => receipt.body.output ?? "");

    expect(result.status).toBe("completed");
    expect(structuredCalls).toBe(3);
    expect(observed.length).toBe(2);
    expect(observed[0] ?? "").toMatch(new RegExp(`${escapeRegExp(configuredWorkspace)}\\s*$`));
    expect(observed[1] ?? "").toMatch(new RegExp(`${escapeRegExp(childWorkspace)}\\s*$`));
  } finally {
    process.env.PATH = priorPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("infra runner reports a clean error when AWS CLI is unavailable", async () => {
  const dir = await mkTmp("receipt-infra-agent-missing-cli");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace");
  const emptyBinDir = path.join(dir, "empty-bin");

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(emptyBinDir, { recursive: true });

  const runtime = mkRuntime(dataDir);
  const prompts = loadInfraPrompts();
  const memoryTools = mkMemoryTools();
  const delegationTools = mkDelegationTools();
  let structuredCalls = 0;
  const priorPath = process.env.PATH;
  process.env.PATH = emptyBinDir;

  try {
    const result = await runInfra({
      stream: "agents/infra",
      runId: "infra_missing_cli",
      problem: "Attempt an AWS call and then summarize the failure.",
      config: normalizeInfraConfig({
        maxIterations: 2,
        maxToolOutputChars: 2000,
        workspace: ".",
      }),
      runtime,
      prompts,
      llmText: async () => "",
      llmStructured: async () => {
        structuredCalls += 1;
        if (structuredCalls === 1) {
          return {
            parsed: {
              thought: "Try AWS CLI first.",
              action: {
                type: "tool",
                name: "aws.cli",
                input: "{\"args\":[\"sts\",\"get-caller-identity\"]}",
                text: null,
              },
            },
            raw: "{\"thought\":\"Try AWS CLI first.\",\"action\":{\"type\":\"tool\",\"name\":\"aws.cli\",\"input\":\"{\\\"args\\\":[\\\"sts\\\",\\\"get-caller-identity\\\"]}\",\"text\":null}}",
          };
        }
        return {
          parsed: {
            thought: "Report completion.",
            action: {
              type: "final",
              name: null,
              input: "{}",
              text: "AWS CLI missing.",
            },
          },
          raw: "{\"thought\":\"Report completion.\",\"action\":{\"type\":\"final\",\"name\":null,\"input\":\"{}\",\"text\":\"AWS CLI missing.\"}}",
        };
      },
      model: "test-model",
      apiReady: true,
      memoryTools,
      delegationTools,
      workspaceRoot,
    });

    const runChain = await runtime.chain("agents/infra/runs/infra_missing_cli");
    const toolCalled = runChain.find((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "tool.called" }> } =>
      receipt.body.type === "tool.called" && receipt.body.tool === "aws.cli"
    )?.body;
    const final = findLastEvent(runChain, "response.finalized");

    expect(result.status).toBe("completed");
    expect(toolCalled?.error ?? "").toMatch(/AWS CLI is not installed or not on PATH/);
    expect(final?.content ?? "").toMatch(/AWS CLI missing/);
  } finally {
    process.env.PATH = priorPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
