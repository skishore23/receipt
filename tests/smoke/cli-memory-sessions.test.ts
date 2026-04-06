import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createRuntime } from "@receipt/core/runtime";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { agentRunStream } from "../../src/agents/agent.streams";
import { syncChangedChatContextProjections } from "../../src/db/projectors";
import { decide as decideAgent, initial as initialAgent, reduce as reduceAgent, type AgentCmd, type AgentEvent, type AgentState } from "../../src/modules/agent";
import { factoryChatSessionStream } from "../../src/services/factory-chat-profiles";

const execFileAsync = promisify(execFile);
const CLI_PATH = new URL("../../src/cli.ts", import.meta.url).pathname;

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const initGitRepo = async (repoRoot: string): Promise<void> => {
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.email", "tests@example.com"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "Tests"], { cwd: repoRoot });
};

const createAgentRuntime = (dataDir: string) =>
  createRuntime<AgentCmd, AgentEvent, AgentState>(
    jsonlStore<AgentEvent>(dataDir),
    jsonBranchStore(dataDir),
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

test("cli memory prefs and sessions commands operate on layered preferences and session history", async () => {
  const repoRoot = await createTempDir("receipt-cli-memory-sessions-repo");
  await initGitRepo(repoRoot);
  const dataDir = path.join(repoRoot, ".receipt", "data");
  await fs.mkdir(dataDir, { recursive: true });
  const runtime = createAgentRuntime(dataDir);
  const sessionStream = factoryChatSessionStream(repoRoot, "generalist", "cli_chat");

  await emitIndexedAgentEvent(runtime, sessionStream, "run_01", {
    type: "problem.set",
    runId: "run_01",
    problem: "Deploy the Docker image to staging after PostgreSQL is ready.",
    agentId: "orchestrator",
  });
  await emitIndexedAgentEvent(runtime, sessionStream, "run_01", {
    type: "response.finalized",
    runId: "run_01",
    agentId: "orchestrator",
    content: "The Docker image is blocked on PostgreSQL credentials.",
  });
  await syncChangedChatContextProjections(dataDir);

  const added = await runCli(repoRoot, ["memory", "prefs", "add", "--text", "Keep answers concise."]);
  const entryId = typeof added === "object" && added && "entry" in added
    ? (added as { readonly entry?: { readonly id?: string } }).entry?.id
    : undefined;
  expect(entryId).toBeTruthy();

  const listed = await runCli(repoRoot, ["memory", "prefs", "list", "--scope", "repo"]);
  expect(JSON.stringify(listed)).toContain("Keep answers concise.");

  const search = await runCli(repoRoot, ["sessions", "search", "--query", "docker postgres staging"]);
  expect(JSON.stringify(search)).toContain("Docker image");

  const read = await runCli(repoRoot, ["sessions", "read", "cli_chat"]);
  expect(JSON.stringify(read)).toContain("Deploy the Docker image to staging");

  const removed = await runCli(repoRoot, ["memory", "prefs", "remove", String(entryId), "--scope", "repo"]);
  expect(removed).toEqual(expect.objectContaining({ removed: true }));

  const listedAfter = await runCli(repoRoot, ["memory", "prefs", "list", "--scope", "repo"]);
  expect(JSON.stringify(listedAfter)).not.toContain("Keep answers concise.");
});
