import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createRuntime } from "@receipt/core/runtime";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import {
  createMemoryTools,
  decideMemory,
  initialMemoryState,
  reduceMemory,
  type MemoryCmd,
  type MemoryEvent,
  type MemoryState,
} from "../../src/adapters/memory-tools";
import type { DelegationTools } from "../../src/adapters/delegation";
import { runAgent } from "../../src/agents/agent";
import { agentRunStream } from "../../src/agents/agent.streams";
import { syncChangedChatContextProjections } from "../../src/db/projectors";
import { decide as decideAgent, initial as initialAgent, reduce as reduceAgent, type AgentCmd, type AgentEvent, type AgentState } from "../../src/modules/agent";
import {
  commitUserPreference,
  loadConversationProjection,
} from "../../src/services/conversation-memory";
import {
  factoryChatSessionStream,
  repoKeyForRoot,
} from "../../src/services/factory-chat-profiles";

const execFileAsync = promisify(execFile);
const CLI_PATH = new URL("../../src/cli.ts", import.meta.url).pathname;

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const initGitRepo = async (repoRoot: string): Promise<string> => {
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.email", "tests@example.com"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "Tests"], { cwd: repoRoot });
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], { cwd: repoRoot });
  return stdout.trim() || repoRoot;
};

const createAgentRuntime = (dataDir: string) =>
  createRuntime<AgentCmd, AgentEvent, AgentState>(
    jsonlStore<AgentEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideAgent,
    reduceAgent,
    initialAgent,
  );

const createMemoryRuntime = (dataDir: string) =>
  createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
    jsonlStore<MemoryEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideMemory,
    reduceMemory,
    initialMemoryState,
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

const runCli = async (cwd: string, args: ReadonlyArray<string>): Promise<unknown> => {
  const dataDir = path.join(cwd, ".receipt", "data");
  const dbPath = path.join(dataDir, "receipt.db");
  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      RECEIPT_DATA_DIR: dataDir,
      RECEIPT_DB_PATH: dbPath,
      RECEIPT_REPO_ROOT: cwd,
    },
  });
  return JSON.parse(stdout);
};

const createNoopDelegationTools = (): DelegationTools => ({
  "agent.delegate": async () => ({ output: "", summary: "" }),
  "agent.status": async () => ({ output: "", summary: "" }),
  "agent.inspect": async () => ({ output: "", summary: "" }),
});

test("conversation memory centralization: one stored preference/session state drives service, agent prompt, and CLI projections", async () => {
  // Requirements under test:
  // 1. Durable user preferences live in shared repo/global scopes, not chat-local memory.
  // 2. Session recall reads prior repo/profile chat history from the SQLite projection.
  // 3. The shared conversation-memory service is the single source for the agent prompt.
  // 4. CLI commands are projections over the same stored preference/session state.
  const repoRoot = await initGitRepo(await createTempDir("receipt-conversation-memory-centralization-repo"));
  const dataDir = path.join(repoRoot, ".receipt", "data");
  await fs.mkdir(dataDir, { recursive: true });

  const agentRuntime = createAgentRuntime(dataDir);
  const memoryRuntime = createMemoryRuntime(dataDir);
  const memoryTools = createMemoryTools({ dir: dataDir, runtime: memoryRuntime });
  const repoKey = repoKeyForRoot(repoRoot);
  const profileId = "generalist";

  await commitUserPreference({
    memoryTools,
    repoKey,
    text: "Keep answers concise and operator-facing.",
    source: "explicit_user",
    runId: "pref_repo_01",
    actor: "test",
  });
  await commitUserPreference({
    memoryTools,
    text: "Use headings only when they add signal.",
    source: "explicit_user",
    runId: "pref_global_01",
    actor: "test",
  });

  const priorSessionStream = factoryChatSessionStream(repoRoot, profileId, "prior_chat");
  await emitIndexedAgentEvent(agentRuntime, priorSessionStream, "run_01", {
    type: "problem.set",
    runId: "run_01",
    problem: "Set up PostgreSQL on port 5433 for staging.",
    agentId: "orchestrator",
  });
  await emitIndexedAgentEvent(agentRuntime, priorSessionStream, "run_01", {
    type: "response.finalized",
    runId: "run_01",
    agentId: "orchestrator",
    content: "Staging should use PostgreSQL on port 5433.",
  });
  await syncChangedChatContextProjections(dataDir);

  const currentSessionStream = factoryChatSessionStream(repoRoot, profileId, "current_chat");
  const projection = await loadConversationProjection({
    memoryTools,
    repoKey,
    profileId,
    sessionStream: currentSessionStream,
    dataDir,
    query: "What was the PostgreSQL staging port again?",
    runId: "projection_01",
    actor: "test",
  });

  expect(projection.userPreferences).toContain("Keep answers concise and operator-facing.");
  expect(projection.userPreferences).toContain("Use headings only when they add signal.");
  expect(projection.sessionRecall.some((entry) => entry.text.includes("5433"))).toBe(true);

  let capturedPrompt = "";
  const result = await runAgent({
    stream: currentSessionStream,
    runId: "run_current_01",
    problem: "What was the PostgreSQL staging port again?",
    config: {
      maxIterations: 1,
      maxToolOutputChars: 4_000,
      memoryScope: "agent",
      workspace: ".",
    },
    runtime: agentRuntime,
    prompts: {
      system: "",
      user: {
        loop: [
          "User preferences:",
          "{{user_preferences}}",
          "",
          "Session recall:",
          "{{session_recall}}",
          "",
          "Problem:",
          "{{problem}}",
        ].join("\n"),
      },
    },
    llmText: async () => "",
    llmStructured: async ({ schema, user }) => {
      capturedPrompt = user;
      return {
        parsed: schema.parse({
          thought: "answer from recalled state",
          action: {
            type: "final",
            name: null,
            input: "{}",
            text: "It was port 5433.",
          },
        }),
        raw: JSON.stringify({
          thought: "answer from recalled state",
          action: {
            type: "final",
            name: null,
            input: "{}",
            text: "It was port 5433.",
          },
        }),
      };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    extraConfig: {
      repoRoot,
      repoKey,
      profileId,
      dataDir,
      stream: currentSessionStream,
    },
  });

  expect(result.status).toBe("completed");
  expect(capturedPrompt).toContain("Keep answers concise and operator-facing.");
  expect(capturedPrompt).toContain("Use headings only when they add signal.");
  expect(capturedPrompt).toContain("5433");

  const listedRepo = await runCli(repoRoot, ["memory", "prefs", "list", "--scope", "repo"]);
  expect(JSON.stringify(listedRepo)).toContain("Keep answers concise and operator-facing.");

  const listedGlobal = await runCli(repoRoot, ["memory", "prefs", "list", "--scope", "global"]);
  expect(JSON.stringify(listedGlobal)).toContain("Use headings only when they add signal.");

  const search = await runCli(repoRoot, ["sessions", "search", "--query", "postgresql staging port"]);
  expect(JSON.stringify(search)).toContain("5433");

  const read = await runCli(repoRoot, ["sessions", "read", "prior_chat"]);
  expect(JSON.stringify(read)).toContain("Set up PostgreSQL on port 5433 for staging.");
});
