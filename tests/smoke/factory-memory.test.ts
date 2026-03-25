import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { type CodexExecutor } from "../../src/adapters/codex-executor";
import { createMemoryTools, decideMemory, initialMemoryState, reduceMemory, type MemoryCmd, type MemoryEvent, type MemoryTools, type MemoryState } from "../../src/adapters/memory-tools";
import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { jsonlQueue } from "../../src/adapters/jsonl-queue";
import { createRuntime } from "@receipt/core/runtime";
import { SseHub } from "../../src/framework/sse-hub";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";
import {
  FactoryService,
  type FactoryIntegrationJobPayload,
  type FactoryIntegrationPublishJobPayload,
  type FactoryTaskJobPayload,
} from "../../src/services/factory-service";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CLI_PATH = path.join(ROOT, "src", "cli.ts");
const BUN = process.env.BUN_BIN?.trim() || "bun";

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

const runObjectiveStartup = async (service: FactoryService, objectiveId: string): Promise<void> => {
  await service.runObjectiveControl({
    kind: "factory.objective.control",
    objectiveId,
    reason: "startup",
  });
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

const findObjectiveJob = async (
  queue: ReturnType<typeof jsonlQueue>,
  objectiveId: string,
  kind: "factory.task.run" | "factory.integration.validate" | "factory.integration.publish",
) => {
  const jobs = await queue.listJobs({ limit: 40 });
  return jobs
    .filter((job) => job.payload.kind === kind && job.payload.objectiveId === objectiveId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
};

const runReceiptCli = async (
  dataDir: string,
  args: ReadonlyArray<string>,
): Promise<unknown> => {
  const { stdout } = await execFileAsync(BUN, [CLI_PATH, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      RECEIPT_DATA_DIR: dataDir,
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
  expect(read.entries.map((entry) => entry.text)).toEqual([
    "second shared fact about promotion",
    "first durable fact",
  ]);

  const search = await runReceiptCli(dataDir, ["memory", "search", scope, "--query", "shared fact", "--limit", "2"]) as {
    entries: Array<{ text: string }>;
  };
  expect(search.entries[0]?.text).toBe("second shared fact about promotion");

  const summary = await runReceiptCli(dataDir, ["memory", "summarize", scope, "--query", "promotion", "--max-chars", "180"]) as {
    summary: string;
  };
  expect(summary.summary).toMatch(/second shared fact about promotion/);

  const diff = await runReceiptCli(dataDir, ["memory", "diff", scope, "--from-ts", String(second.entry.ts)]) as {
    entries: Array<{ text: string }>;
  };
  expect(diff.entries.map((entry) => entry.text)).toEqual(["second shared fact about promotion"]);
  expect(first.entry.ts < second.entry.ts).toBeTruthy();
});

test("factory worker packets expose a layered memory script for bounded recall and durable commits", async () => {
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
      expect(manifestName).toBeTruthy();
      const manifestPath = path.join(factoryDir, manifestName);
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
        readonly memory: {
          readonly scriptPath: string;
        };
      };
      const memoryScriptPath = manifest.memory.scriptPath;

      const runMemory = async (args: ReadonlyArray<string>): Promise<string> => {
        const { stdout } = await execFileAsync(BUN, [memoryScriptPath, ...args], {
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
      expect(resultPathMatch).toBeTruthy();
      const resultPath = resultPathMatch[1].trim();
      await fs.mkdir(path.dirname(resultPath), { recursive: true });
      await fs.writeFile(resultPath, JSON.stringify({
        outcome: "approved",
        summary: "Used the generated memory script to recall and store bounded context.",
        artifacts: [],
        scriptsRun: [{
          command: `bun ${memoryScriptPath} context 1800`,
          summary: "Read the bounded packet context before editing.",
          status: "ok",
        }, {
          command: `bun ${memoryScriptPath} overview memory 1400`,
          summary: "Reviewed scoped memory summaries before writing the durable note.",
          status: "ok",
        }],
        completion: {
          changed: [
            "Recalled bounded Factory context and committed a durable task note through the generated memory script.",
          ],
          proof: [
            "bun memory script context 1800 returned the layered task packet context.",
            "bun memory script overview memory 1400 returned the scoped memory summaries.",
          ],
          remaining: [],
        },
        nextAction: "Candidate is ready for integration.",
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
  expect(created.profile.rootProfileId).toBe("generalist");
  expect(created.profile.objectivePolicy.defaultWorkerType).toBe("codex");
  expect(created.contextSources.repoSharedMemoryScope).toBe("factory/repo/shared");
  expect(created.contextSources.sharedArtifactRefs.length).toBeGreaterThanOrEqual(2);
  await runObjectiveStartup(service, created.objectiveId);
  const ready = await service.getObjective(created.objectiveId);

  const task = ready.tasks[0];
  expect(task?.jobId).toBeTruthy();
  const job = await queue.getJob(task.jobId!);
  expect(job).toBeTruthy();
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
    readonly profile: {
      readonly rootProfileId: string;
      readonly promptPath: string;
      readonly selectedSkills: ReadonlyArray<string>;
    };
    readonly memory: {
      readonly scriptPath: string;
      readonly configPath: string;
      readonly scopes: Array<{ key: string }>;
    };
    readonly context: {
      readonly packPath: string;
    };
    readonly contextSources: {
      readonly repoSharedMemoryScope: string;
      readonly sharedArtifactRefs: ReadonlyArray<{ readonly kind: string; readonly ref: string }>;
    };
    readonly sharedArtifactRefs: ReadonlyArray<{ readonly kind: string; readonly ref: string }>;
  };
  expect(manifest.profile.rootProfileId).toBe("generalist");
  expect(manifest.profile.promptPath).toBe("profiles/generalist/PROFILE.md");
  expect(manifest.memory.scopes.map((scope) => scope.key)).toEqual([
    "agent",
    "repo",
    "objective",
    "task",
    "candidate",
    "integration",
  ]);
  expect(manifest.memory.scriptPath).toBe(payload.memoryScriptPath);
  expect(manifest.memory.configPath).toBe(payload.memoryConfigPath);
  expect(manifest.context.packPath).toBe(payload.contextPackPath);
  expect(manifest.contextSources.repoSharedMemoryScope).toBe("factory/repo/shared");
  expect(manifest.sharedArtifactRefs.length).toBeGreaterThanOrEqual(2);
  expect(payload.profile.rootProfileId).toBe("generalist");
  expect(payload.profilePromptHash.length).toBeGreaterThan(0);
  expect(payload.sharedArtifactRefs.length).toBeGreaterThanOrEqual(2);

  await service.runTask(job.payload);

  const promptBody = await fs.readFile(payload.promptPath, "utf-8");
  expect(promptBody).toMatch(/The prompt is bootstrap only\./);
  expect(promptBody).toMatch(/AGENTS\.md and skills\/factory-receipt-worker\/SKILL\.md/);
  expect(promptBody).toMatch(new RegExp(payload.manifestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(promptBody).toMatch(new RegExp(payload.contextPackPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(promptBody).toMatch(/Do not call `.+ factory inspect` from inside this task worktree\./);
  expect(promptBody).not.toMatch(new RegExp(`receipt factory inspect ${created.objectiveId} --json --panel debug`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(promptBody).toMatch(/## Memory Access/);
  expect(promptBody).toMatch(new RegExp(`bun ${payload.memoryScriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} context`));
  expect(promptBody).toMatch(new RegExp(`bun ${payload.memoryScriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} objective`));
  expect(promptBody).toMatch(new RegExp(`bun ${payload.memoryScriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} scope task`));
  expect(promptBody).toMatch(new RegExp(`bun ${payload.memoryScriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} search repo`));
  expect(promptBody).toMatch(/Always include scriptsRun and completion\./);

  expect(captured.context).toMatch(/Objective: Scripted memory objective/);
  expect(captured.context).toMatch(/Dependencies:|Candidate lineage:|Recent receipts:/);
  expect(captured.context).toMatch(/Objective frontier:|Objective-wide receipts:/);
  expect(captured.objective).toMatch(/Frontier tasks:|Recent objective receipts:/);
  expect(captured.overview).toMatch(/Agent memory \(codex\)|Objective memory|Task memory/);
  expect(captured.scope).toMatch(/task memory: reuse the generated memory script/i);
  expect(captured.search).toMatch(/shared fact: promotion must wait for green integration/i);

  const contextPack = JSON.parse(await fs.readFile(payload.contextPackPath, "utf-8")) as {
    readonly profile: { readonly rootProfileId: string; readonly promptPath: string };
    readonly task: { readonly taskId: string; readonly candidateId: string };
    readonly relatedTasks: Array<{ readonly taskId: string; readonly relations: string[] }>;
    readonly candidateLineage: Array<{ readonly candidateId: string }>;
    readonly recentReceipts: Array<{ readonly type: string }>;
    readonly objectiveSlice: {
      readonly frontierTasks: Array<{ readonly taskId: string }>;
      readonly recentObjectiveReceipts: Array<{ readonly type: string }>;
    };
    readonly contextSources: {
      readonly profileSkillRefs: ReadonlyArray<string>;
      readonly repoSharedMemoryScope: string;
      readonly sharedArtifactRefs: ReadonlyArray<{ readonly kind: string; readonly ref: string }>;
    };
  };
  expect(contextPack.profile.rootProfileId).toBe("generalist");
  expect(contextPack.profile.promptPath).toBe("profiles/generalist/PROFILE.md");
  expect(contextPack.task.taskId).toBe(task!.taskId);
  expect(contextPack.task.candidateId).toBe(payload.candidateId);
  expect(contextPack.relatedTasks.some((relatedTask) => relatedTask.taskId === task!.taskId && relatedTask.relations.includes("focus"))).toBeTruthy();
  expect(contextPack.candidateLineage.some((candidate) => candidate.candidateId === payload.candidateId)).toBeTruthy();
  expect(contextPack.recentReceipts.some((receipt) => receipt.type === "task.dispatched")).toBeTruthy();
  expect(contextPack.objectiveSlice.frontierTasks.some((frontierTask) => frontierTask.taskId === task!.taskId)).toBeTruthy();
  expect(contextPack.objectiveSlice.recentObjectiveReceipts.length >= 1).toBeTruthy();
  expect(contextPack.contextSources.repoSharedMemoryScope).toBe("factory/repo/shared");
  expect(contextPack.contextSources.sharedArtifactRefs.length).toBeGreaterThanOrEqual(2);

  const taskMemory = await memoryTools.read({
    scope: `factory/objectives/${created.objectiveId}/tasks/${task!.taskId}`,
    limit: 10,
  });
  expect(taskMemory.some((entry) => entry.text.includes("worker durable note from script"))).toBeTruthy();
  expect(taskMemory.some((entry) =>
    entry.text.includes("Scripts Run\n- ok: bun ")
    && entry.text.includes(`${path.basename(payload.memoryScriptPath)} context 1800`)
  )).toBeTruthy();

  const after = await service.getObjective(created.objectiveId);
  const afterTask = after.tasks.find((item) => item.taskId === task!.taskId);
  expect(afterTask?.candidate?.artifactRefs.memoryScript).toBeTruthy();
  expect(afterTask?.candidate?.artifactRefs.memoryConfig).toBeTruthy();
  expect(afterTask?.candidate?.scriptsRun?.map((item) => item.command)).toEqual([
    `bun ${payload.memoryScriptPath} context 1800`,
    `bun ${payload.memoryScriptPath} overview memory 1400`,
  ]);
}, 120_000);

test("factory investigation synthesis commits a sectioned operator report to objective memory", async () => {
  const dataDir = await createTempDir("receipt-factory-investigation-memory");
  const repoDir = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createTestMemoryTools(dataDir);

  const codexExecutor: CodexExecutor = {
    run: async (input) => {
      await fs.mkdir(path.dirname(input.promptPath), { recursive: true });
      await fs.writeFile(input.promptPath, input.prompt, "utf-8");
      await fs.writeFile(input.stdoutPath, "", "utf-8");
      await fs.writeFile(input.stderrPath, "", "utf-8");
      const raw = JSON.stringify({
        outcome: "approved",
        summary: "Collected the current AWS account inventory evidence.",
        artifacts: [{
          label: "Inventory snapshot",
          path: path.join(input.workspacePath, ".receipt", "factory", "inventory.json"),
          summary: "Machine-readable inventory evidence.",
        }],
        completion: {
          changed: [
            "Collected the current AWS inventory evidence and wrote the machine-readable snapshot.",
          ],
          proof: [
            "Inventory snapshot artifact was written to the task workspace.",
            "bash .receipt/factory/task_01_inventory.sh captured the inventory successfully.",
          ],
          remaining: [],
        },
        nextAction: "Investigation is ready for synthesis.",
        report: {
          conclusion: "The AWS inventory completed successfully and the evidence is internally consistent.",
          evidence: [{
            title: "AWS identity",
            summary: "Confirmed the active account before running the inventory script.",
            detail: null,
          }],
          scriptsRun: [{
            command: "bash .receipt/factory/task_01_inventory.sh",
            summary: "Captured the inventory and wrote a JSON snapshot.",
            status: "ok",
          }],
          disagreements: [],
          nextSteps: ["Escalate only if deeper service-specific attribution is required."],
        },
      });
      await fs.writeFile(input.lastMessagePath, raw, "utf-8");
      return {
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        lastMessage: raw,
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
    title: "Investigate AWS inventory",
    prompt: "Inspect the current AWS inventory and summarize the evidence.",
    objectiveMode: "investigation",
    checks: ["true"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const jobs = await queue.listJobs({ limit: 20 });
  const taskJob = jobs.find((job) => job.payload.kind === "factory.task.run" && job.payload.objectiveId === created.objectiveId);
  expect(taskJob).toBeTruthy();
  await service.runTask(taskJob!.payload as FactoryTaskJobPayload);

  const objectiveMemory = await memoryTools.read({
    scope: `factory/objectives/${created.objectiveId}`,
    limit: 10,
  });
  const richReport = objectiveMemory.find((entry) =>
    entry.text.includes("Conclusion\n")
    && entry.text.includes("Evidence\n- AWS identity:")
    && entry.text.includes("Scripts Run\n- ok: bash .receipt/factory/task_01_inventory.sh")
    && entry.text.includes("Artifacts\n-")
    && entry.text.includes("task result:")
    && entry.text.includes("Next Steps\n- Escalate only if deeper service-specific attribution is required."),
  );
  expect(richReport).toBeTruthy();
}, 120_000);

test("factory publish commits PR metadata to objective, integration, and publish memory", async () => {
  const dataDir = await createTempDir("receipt-factory-publish-memory");
  const repoDir = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createTestMemoryTools(dataDir);

  const codexExecutor: CodexExecutor = {
    run: async (input) => {
      await fs.mkdir(path.dirname(input.promptPath), { recursive: true });
      await fs.writeFile(input.promptPath, input.prompt, "utf-8");
      await fs.writeFile(input.stdoutPath, "", "utf-8");
      await fs.writeFile(input.stderrPath, "", "utf-8");
      if (input.taskId === "publish") {
        const raw = JSON.stringify({
          summary: "Published PR #42 for the software objective.",
          prUrl: "https://github.com/example/receipt/pull/42",
          prNumber: 42,
          headRefName: "codex/software-objective",
          baseRefName: "main",
        });
        await fs.writeFile(input.lastMessagePath, raw, "utf-8");
        return {
          exitCode: 0,
          signal: null,
          stdout: raw,
          stderr: "",
          lastMessage: raw,
        };
      }
      await fs.writeFile(path.join(input.workspacePath, "MEMORY_PUBLISH_TEST.txt"), "publish memory coverage\n", "utf-8");
      const raw = JSON.stringify({
        outcome: "approved",
        summary: "Implemented the software change and prepared it for integration.",
        artifacts: [],
        scriptsRun: [{
          command: "git status --short",
          summary: "Confirmed the task workspace recorded the publish memory fixture diff.",
          status: "ok",
        }],
        completion: {
          changed: [
            "Created MEMORY_PUBLISH_TEST.txt to exercise the publish-memory path.",
          ],
          proof: [
            "git status --short showed the workspace diff for MEMORY_PUBLISH_TEST.txt.",
          ],
          remaining: [],
        },
        nextAction: "Ready for integration.",
      });
      await fs.writeFile(input.lastMessagePath, raw, "utf-8");
      return {
        exitCode: 0,
        signal: null,
        stdout: raw,
        stderr: "",
        lastMessage: raw,
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
    title: "Publish software objective",
    prompt: "Implement the change and raise the PR.",
    profileId: "software",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await findObjectiveJob(queue, created.objectiveId, "factory.task.run");
  expect(taskJob).toBeTruthy();
  await service.runTask(taskJob!.payload as FactoryTaskJobPayload);

  const validateJob = await findObjectiveJob(queue, created.objectiveId, "factory.integration.validate");
  expect(validateJob).toBeTruthy();
  await service.runIntegrationValidation(validateJob!.payload as FactoryIntegrationJobPayload);

  const publishJob = await findObjectiveJob(queue, created.objectiveId, "factory.integration.publish");
  expect(publishJob).toBeTruthy();
  await service.runIntegrationPublish(publishJob!.payload as FactoryIntegrationPublishJobPayload);

  const objectiveMemory = await memoryTools.read({
    scope: `factory/objectives/${created.objectiveId}`,
    limit: 10,
  });
  const integrationMemory = await memoryTools.read({
    scope: `factory/objectives/${created.objectiveId}/integration`,
    limit: 10,
  });
  const publishMemory = await memoryTools.read({
    scope: `factory/objectives/${created.objectiveId}/publish`,
    limit: 10,
  });

  expect(objectiveMemory.some((entry) =>
    entry.text.includes("[publish/")
    && entry.text.includes("https://github.com/example/receipt/pull/42")
  )).toBeTruthy();
  expect(integrationMemory.some((entry) =>
    entry.text.includes("Published PR #42 for the software objective.")
    && entry.text.includes("https://github.com/example/receipt/pull/42")
  )).toBeTruthy();
  expect(publishMemory.some((entry) =>
    entry.text.includes("Published PR #42 for the software objective.")
    && entry.text.includes("https://github.com/example/receipt/pull/42")
  )).toBeTruthy();
}, 120_000);

test("factory publish failures still commit durable blocker notes to publish memory", async () => {
  const dataDir = await createTempDir("receipt-factory-publish-memory-failure");
  const repoDir = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createTestMemoryTools(dataDir);

  const codexExecutor: CodexExecutor = {
    run: async (input) => {
      await fs.mkdir(path.dirname(input.promptPath), { recursive: true });
      await fs.writeFile(input.promptPath, input.prompt, "utf-8");
      await fs.writeFile(input.stdoutPath, "", "utf-8");
      await fs.writeFile(input.stderrPath, "", "utf-8");
      if (input.taskId === "publish") {
        throw new Error("gh pr create failed: permission denied");
      }
      await fs.writeFile(path.join(input.workspacePath, "MEMORY_PUBLISH_FAILURE.txt"), "publish failure coverage\n", "utf-8");
      const raw = JSON.stringify({
        outcome: "approved",
        summary: "Prepared the delivery candidate for publishing.",
        artifacts: [],
        scriptsRun: [{
          command: "git status --short",
          summary: "Confirmed the task workspace diff before the publish failure path.",
          status: "ok",
        }],
        completion: {
          changed: [
            "Created MEMORY_PUBLISH_FAILURE.txt to exercise publish blocker memory handling.",
          ],
          proof: [
            "git status --short showed the workspace diff for MEMORY_PUBLISH_FAILURE.txt.",
          ],
          remaining: [],
        },
        nextAction: "Ready for integration.",
      });
      await fs.writeFile(input.lastMessagePath, raw, "utf-8");
      return {
        exitCode: 0,
        signal: null,
        stdout: raw,
        stderr: "",
        lastMessage: raw,
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
    title: "Publish failure memory objective",
    prompt: "Surface publish blockers durably.",
    profileId: "software",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await findObjectiveJob(queue, created.objectiveId, "factory.task.run");
  expect(taskJob).toBeTruthy();
  await service.runTask(taskJob!.payload as FactoryTaskJobPayload);
  const validateJob = await findObjectiveJob(queue, created.objectiveId, "factory.integration.validate");
  expect(validateJob).toBeTruthy();
  await service.runIntegrationValidation(validateJob!.payload as FactoryIntegrationJobPayload);
  const publishJob = await findObjectiveJob(queue, created.objectiveId, "factory.integration.publish");
  expect(publishJob).toBeTruthy();
  await service.runIntegrationPublish(publishJob!.payload as FactoryIntegrationPublishJobPayload);

  const publishMemory = await memoryTools.read({
    scope: `factory/objectives/${created.objectiveId}/publish`,
    limit: 10,
  });
  const integrationMemory = await memoryTools.read({
    scope: `factory/objectives/${created.objectiveId}/integration`,
    limit: 10,
  });

  expect(publishMemory.some((entry) => entry.text.includes("gh pr create failed: permission denied"))).toBeTruthy();
  expect(integrationMemory.some((entry) => entry.text.includes("Publishing failed: gh pr create failed: permission denied"))).toBeTruthy();
}, 120_000);
