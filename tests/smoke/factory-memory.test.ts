import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { type CodexExecutor } from "../../src/adapters/codex-executor.ts";
import { createMemoryTools, decideMemory, initialMemoryState, reduceMemory, type MemoryCmd, type MemoryEvent, type MemoryTools, type MemoryState } from "../../src/adapters/memory-tools.ts";
import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import { jsonlQueue } from "../../src/adapters/jsonl-queue.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import { SseHub } from "../../src/framework/sse-hub.ts";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job.ts";
import { FactoryService, type FactoryTaskJobPayload } from "../../src/services/factory-service.ts";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CLI_PATH = path.join(ROOT, "src", "cli.ts");
const TSX_LOADER = path.join(ROOT, "node_modules", "tsx", "dist", "loader.mjs");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
};

const createSourceRepo = async (): Promise<string> => {
  const repoDir = await createTempDir("receipt-factory-memory-source");
  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.name", "Factory Memory Test"]);
  await git(repoDir, ["config", "user.email", "factory-memory@example.com"]);
  await fs.writeFile(path.join(repoDir, "README.md"), "# factory memory test\n", "utf-8");
  await git(repoDir, ["add", "README.md"]);
  await git(repoDir, ["commit", "-m", "initial commit"]);
  await git(repoDir, ["branch", "-M", "main"]);
  return repoDir;
};

const createJobRuntime = (dataDir: string) =>
  createRuntime<JobCmd, JobEvent, JobState>(
    jsonlStore<JobEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideJob,
    reduceJob,
    initialJob,
  );

const createTestMemoryTools = (dataDir: string): MemoryTools => {
  const runtime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
    jsonlStore<MemoryEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideMemory,
    reduceMemory,
    initialMemoryState,
  );
  return createMemoryTools({
    dir: dataDir,
    runtime,
  });
};

const runReceiptCli = async (
  dataDir: string,
  args: ReadonlyArray<string>,
): Promise<unknown> => {
  const { stdout } = await execFileAsync(process.execPath, ["--import", TSX_LOADER, CLI_PATH, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
    },
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
};

test("memory CLI: commit, read, search, summarize, and diff stay receipt-backed", async () => {
  const dataDir = await createTempDir("receipt-memory-cli");
  const scope = "factory/objectives/demo";

  const first = await runReceiptCli(dataDir, ["memory", "commit", scope, "--text", "first durable fact", "--tags", "factory,objective"]) as {
    entry: { ts: number; text: string };
  };
  await sleep(10);
  const second = await runReceiptCli(dataDir, ["memory", "commit", scope, "--text", "second shared fact about promotion"]) as {
    entry: { ts: number; text: string };
  };

  const read = await runReceiptCli(dataDir, ["memory", "read", scope, "--limit", "2"]) as {
    entries: Array<{ text: string }>;
  };
  assert.deepEqual(read.entries.map((entry) => entry.text), [
    "second shared fact about promotion",
    "first durable fact",
  ]);

  const search = await runReceiptCli(dataDir, ["memory", "search", scope, "--query", "shared fact", "--limit", "2"]) as {
    entries: Array<{ text: string }>;
  };
  assert.equal(search.entries[0]?.text, "second shared fact about promotion");

  const summary = await runReceiptCli(dataDir, ["memory", "summarize", scope, "--query", "promotion", "--max-chars", "180"]) as {
    summary: string;
  };
  assert.match(summary.summary, /second shared fact about promotion/);

  const diff = await runReceiptCli(dataDir, ["memory", "diff", scope, "--from-ts", String(second.entry.ts)]) as {
    entries: Array<{ text: string }>;
  };
  assert.deepEqual(diff.entries.map((entry) => entry.text), ["second shared fact about promotion"]);
  assert.ok(first.entry.ts < second.entry.ts);
});

test("factory worker packets expose a layered memory script for bounded recall and durable commits", { timeout: 120_000 }, async () => {
  const dataDir = await createTempDir("receipt-factory-memory");
  const repoDir = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createTestMemoryTools(dataDir);
  const captured = {
    context: "",
    objective: "",
    overview: "",
    scope: "",
    search: "",
  };

  const codexExecutor: CodexExecutor = {
    run: async (input) => {
      await fs.mkdir(path.dirname(input.promptPath), { recursive: true });
      await fs.writeFile(input.promptPath, input.prompt, "utf-8");
      await fs.writeFile(input.stdoutPath, "", "utf-8");
      await fs.writeFile(input.stderrPath, "", "utf-8");

      const factoryDir = path.join(input.workspacePath, ".receipt", "factory");
      const manifestName = (await fs.readdir(factoryDir)).find((name) => name.endsWith(".manifest.json"));
      assert.ok(manifestName, "factory manifest missing");
      const manifestPath = path.join(factoryDir, manifestName);
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
        readonly memory: {
          readonly scriptPath: string;
        };
      };
      const memoryScriptPath = manifest.memory.scriptPath;

      const runMemory = async (args: ReadonlyArray<string>): Promise<string> => {
        const { stdout } = await execFileAsync(process.execPath, [memoryScriptPath, ...args], {
          cwd: input.workspacePath,
          env: {
            ...process.env,
            ...input.env,
          },
          encoding: "utf-8",
          maxBuffer: 16 * 1024 * 1024,
        });
        return stdout.trim();
      };

      captured.context = await runMemory(["context", "1800"]);
      captured.objective = await runMemory(["objective", "1400"]);
      captured.overview = await runMemory(["overview", "memory", "1400"]);
      captured.scope = await runMemory(["scope", "task", "task memory", "900"]);
      captured.search = await runMemory(["search", "repo", "shared fact", "4"]);
      await runMemory(["commit", "task", "worker durable note from script"]);

      await fs.writeFile(
        path.join(input.workspacePath, "MEMORY_SCRIPT_TEST.txt"),
        `${captured.context}\n\n${captured.overview}\n\n${captured.scope}\n\n${captured.search}\n`,
        "utf-8",
      );

      const resultPathMatch = input.prompt.match(/Write JSON to (.+?) with:/);
      assert.ok(resultPathMatch, "result path contract missing from prompt");
      const resultPath = resultPathMatch[1].trim();
      await fs.mkdir(path.dirname(resultPath), { recursive: true });
      await fs.writeFile(resultPath, JSON.stringify({
        outcome: "approved",
        summary: "Used the generated memory script to recall and store bounded context.",
        handoff: "Candidate is ready for integration.",
      }, null, 2), "utf-8");
      await fs.writeFile(input.lastMessagePath, "Used the generated memory script.", "utf-8");
      return {
        exitCode: 0,
        signal: null,
        stdout: captured.overview,
        stderr: "",
        lastMessage: "Used the generated memory script.",
      };
    },
  };

  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor,
    memoryTools,
    repoRoot: repoDir,
  });

  const created = await service.createObjective({
    title: "Scripted memory objective",
    prompt: "Implement the task using layered receipt-backed memory.",
    checks: ["git status --short"],
  });

  const task = created.tasks[0];
  assert.ok(task?.jobId, "task dispatch should enqueue a job");
  const job = await queue.getJob(task.jobId!);
  assert.ok(job, "queued factory task job missing");
  const payload = job.payload as FactoryTaskJobPayload;

  await memoryTools.commit({
    scope: "factory/agents/codex",
    text: "agent guidance: prefer compact recall over raw transcript expansion",
    tags: ["agent"],
  });
  await memoryTools.commit({
    scope: "factory/repo/shared",
    text: "shared fact: promotion must wait for green integration",
    tags: ["repo"],
  });
  await memoryTools.commit({
    scope: `factory/objectives/${created.objectiveId}`,
    text: "objective context: keep orchestration receipt-native",
    tags: ["objective"],
  });
  await memoryTools.commit({
    scope: `factory/objectives/${created.objectiveId}/tasks/${task!.taskId}`,
    text: "task memory: reuse the generated memory script instead of a large summary",
    tags: ["task"],
  });
  await memoryTools.commit({
    scope: `factory/objectives/${created.objectiveId}/candidates/${payload.candidateId}`,
    text: "candidate memory: prior candidate was approved pending integration",
    tags: ["candidate"],
  });
  await memoryTools.commit({
    scope: `factory/objectives/${created.objectiveId}/integration`,
    text: "integration memory: promotion happens only after validation",
    tags: ["integration"],
  });

  const manifest = JSON.parse(await fs.readFile(payload.manifestPath, "utf-8")) as {
    readonly memory: {
      readonly scriptPath: string;
      readonly configPath: string;
      readonly scopes: Array<{ key: string }>;
    };
    readonly context: {
      readonly packPath: string;
    };
  };
  assert.deepEqual(manifest.memory.scopes.map((scope) => scope.key), [
    "agent",
    "repo",
    "objective",
    "task",
    "candidate",
    "integration",
  ]);
  assert.equal(manifest.memory.scriptPath, payload.memoryScriptPath);
  assert.equal(manifest.memory.configPath, payload.memoryConfigPath);
  assert.equal(manifest.context.packPath, payload.contextPackPath);

  await service.runTask(job.payload);

  const promptBody = await fs.readFile(payload.promptPath, "utf-8");
  assert.match(promptBody, /## Memory Access/);
  assert.match(promptBody, new RegExp(`node ${payload.memoryScriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} context`));
  assert.match(promptBody, new RegExp(`node ${payload.memoryScriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} objective`));
  assert.match(promptBody, new RegExp(`node ${payload.memoryScriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} overview`));

  assert.match(captured.context, /Objective: Scripted memory objective/);
  assert.match(captured.context, /Dependencies:|Candidate lineage:|Recent receipts:/);
  assert.match(captured.context, /Objective frontier:|Objective-wide receipts:/);
  assert.match(captured.objective, /Frontier tasks:|Recent objective receipts:/);
  assert.match(captured.overview, /Agent memory \(codex\)|Objective memory|Task memory/);
  assert.match(captured.scope, /task memory: reuse the generated memory script/i);
  assert.match(captured.search, /shared fact: promotion must wait for green integration/i);

  const contextPack = JSON.parse(await fs.readFile(payload.contextPackPath, "utf-8")) as {
    readonly task: { readonly taskId: string; readonly candidateId: string };
    readonly relatedTasks: Array<{ readonly taskId: string; readonly relations: string[] }>;
    readonly candidateLineage: Array<{ readonly candidateId: string }>;
    readonly recentReceipts: Array<{ readonly type: string }>;
    readonly objectiveSlice: {
      readonly frontierTasks: Array<{ readonly taskId: string }>;
      readonly recentObjectiveReceipts: Array<{ readonly type: string }>;
    };
  };
  assert.equal(contextPack.task.taskId, task!.taskId);
  assert.equal(contextPack.task.candidateId, payload.candidateId);
  assert.ok(contextPack.relatedTasks.some((relatedTask) => relatedTask.taskId === task!.taskId && relatedTask.relations.includes("focus")));
  assert.ok(contextPack.candidateLineage.some((candidate) => candidate.candidateId === payload.candidateId));
  assert.ok(contextPack.recentReceipts.some((receipt) => receipt.type === "task.dispatched"));
  assert.ok(contextPack.objectiveSlice.frontierTasks.some((frontierTask) => frontierTask.taskId === task!.taskId));
  assert.ok(contextPack.objectiveSlice.recentObjectiveReceipts.length >= 1);

  const taskMemory = await memoryTools.read({
    scope: `factory/objectives/${created.objectiveId}/tasks/${task!.taskId}`,
    limit: 10,
  });
  assert.ok(taskMemory.some((entry) => entry.text.includes("worker durable note from script")));

  const after = await service.getObjective(created.objectiveId);
  const afterTask = after.tasks.find((item) => item.taskId === task!.taskId);
  assert.ok(afterTask?.candidate?.artifactRefs.memoryScript);
  assert.ok(afterTask?.candidate?.artifactRefs.memoryConfig);
});
