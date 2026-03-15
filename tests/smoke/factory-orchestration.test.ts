import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ZodTypeAny, infer as ZodInfer } from "zod";

import { type CodexExecutor } from "../../src/adapters/codex-executor.ts";
import { createMemoryTools, decideMemory, initialMemoryState, reduceMemory, type MemoryCmd, type MemoryEvent, type MemoryState } from "../../src/adapters/memory-tools.ts";
import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import { jsonlQueue } from "../../src/adapters/jsonl-queue.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import { SseHub } from "../../src/framework/sse-hub.ts";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job.ts";
import { FactoryService, type FactoryTaskJobPayload } from "../../src/services/factory-service.ts";
import { type FactoryOrchestrator } from "../../src/services/factory-orchestrator.ts";

const execFileAsync = promisify(execFile);

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
  const repoDir = await createTempDir("receipt-factory-orchestration-source");
  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.name", "Factory Orchestration Test"]);
  await git(repoDir, ["config", "user.email", "factory-orchestration@example.com"]);
  await fs.writeFile(path.join(repoDir, "README.md"), "# factory orchestration test\n", "utf-8");
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

const createMemoryToolsForTest = (dataDir: string) =>
  createMemoryTools({
    dir: dataDir,
    runtime: createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
      jsonlStore<MemoryEvent>(dataDir),
      jsonBranchStore(dataDir),
      decideMemory,
      reduceMemory,
      initialMemoryState,
    ),
  });

const findLatestFactoryJob = async (
  queue: ReturnType<typeof jsonlQueue>,
  objectiveId: string,
): Promise<FactoryTaskJobPayload> => {
  const jobs = await queue.listJobs({ limit: 20 });
  const match = jobs
    .filter((job) => job.payload.kind === "factory.task.run" && job.payload.objectiveId === objectiveId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  assert.ok(match, "factory task job not found");
  return match.payload as FactoryTaskJobPayload;
};

test("factory orchestrator: blocked tasks emit split/supersede mutation receipts at runtime", { timeout: 120_000 }, async () => {
  const dataDir = await createTempDir("receipt-factory-mutation");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const mutationChoices: string[] = [];
  const orchestrator: FactoryOrchestrator = {
    decide: async (input) => {
      const preferred = input.actions.find((action) => action.type === "split_task") ?? input.actions[0];
      assert.ok(preferred, "no mutation action available");
      mutationChoices.push(preferred.actionId);
      return {
        selectedActionId: preferred.actionId,
        reason: "Split the blocked task into unblock + implementation follow-up.",
        confidence: 0.92,
      };
    },
  };
  const codexExecutor: CodexExecutor = {
    run: async (input) => {
      await fs.writeFile(input.promptPath, input.prompt, "utf-8");
      await fs.writeFile(input.stdoutPath, "", "utf-8");
      await fs.writeFile(input.stderrPath, "", "utf-8");
      const resultPath = input.prompt.match(/Write JSON to (.+?) with:/)?.[1]?.trim();
      assert.ok(resultPath, "task result path missing");
      await fs.writeFile(resultPath, JSON.stringify({
        outcome: "blocked",
        summary: "Blocked by missing dependency details.",
        handoff: "Need a smaller unblock task before implementation can continue.",
      }, null, 2), "utf-8");
      await fs.writeFile(input.lastMessagePath, "Blocked by missing dependency details.", "utf-8");
      return { exitCode: 0, signal: null, stdout: "", stderr: "", lastMessage: "blocked" };
    },
  };
  const llmStructured = async <Schema extends ZodTypeAny>(opts: {
    readonly schemaName: string;
    readonly schema: Schema;
  }): Promise<{ readonly parsed: ZodInfer<Schema>; readonly raw: string }> => {
    const payload = opts.schemaName === "factory_task_decomposition"
      ? {
          tasks: [{
            title: "Build the implementation",
            prompt: "Implement the requested factory change.",
            workerType: "codex",
            dependsOn: [],
          }],
        }
      : {
          actions: [{
            type: "split_task",
            taskId: "task_01",
            reason: "The blocked implementation needs an unblock task before the final build step.",
            tasks: [
              { title: "Unblock implementation", prompt: "Investigate the blocker and write down the missing details.", workerType: "codex" },
              { title: "Finish implementation", prompt: "Resume implementation using the unblock task output.", workerType: "codex" },
            ],
          }],
        };
    return {
      parsed: opts.schema.parse(payload),
      raw: JSON.stringify(payload),
    };
  };
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime: createJobRuntime(dataDir),
    sse: new SseHub(),
    codexExecutor,
    memoryTools: createMemoryToolsForTest(dataDir),
    orchestrator,
    orchestratorMode: "enabled",
    llmStructured,
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Mutation objective",
    prompt: "Implement the feature but adapt runtime orchestration if blocked.",
    checks: ["git status --short"],
  });

  const firstJob = await findLatestFactoryJob(queue, created.objectiveId);
  await service.runTask(firstJob);

  const detail = await service.getObjective(created.objectiveId);
  assert.ok(mutationChoices.some((choice) => choice.startsWith("action_split_task_01")));
  assert.equal(detail.latestRebracket?.selectedActionId, mutationChoices.at(-1));
  assert.equal(detail.tasks.find((task) => task.taskId === "task_01")?.status, "superseded");
  assert.ok(detail.tasks.some((task) => task.title === "Unblock implementation"));
  assert.ok(detail.tasks.some((task) => task.title === "Finish implementation"));
});

test("factory candidate lineage: rework dispatch mints a fresh candidate id", { timeout: 120_000 }, async () => {
  const dataDir = await createTempDir("receipt-factory-candidate-lineage");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  let runs = 0;
  const codexExecutor: CodexExecutor = {
    run: async (input) => {
      runs += 1;
      await fs.writeFile(input.promptPath, input.prompt, "utf-8");
      await fs.writeFile(input.stdoutPath, "", "utf-8");
      await fs.writeFile(input.stderrPath, "", "utf-8");
      await fs.writeFile(path.join(input.workspacePath, "LINEAGE_TEST.txt"), `run ${runs}\n`, "utf-8");
      const resultPath = input.prompt.match(/Write JSON to (.+?) with:/)?.[1]?.trim();
      assert.ok(resultPath, "task result path missing");
      await fs.writeFile(resultPath, JSON.stringify({
        outcome: runs === 1 ? "changes_requested" : "approved",
        summary: runs === 1 ? "Need another pass before review can approve." : "Second pass is ready.",
        handoff: runs === 1 ? "Run another implementation pass with the latest diff." : "Ready for integration.",
      }, null, 2), "utf-8");
      await fs.writeFile(input.lastMessagePath, `run ${runs}`, "utf-8");
      return { exitCode: 0, signal: null, stdout: "", stderr: "", lastMessage: `run ${runs}` };
    },
  };
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime: createJobRuntime(dataDir),
    sse: new SseHub(),
    codexExecutor,
    memoryTools: createMemoryToolsForTest(dataDir),
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Lineage objective",
    prompt: "Keep revising until the candidate is approved.",
    checks: ["git status --short"],
  });

  const firstJob = await findLatestFactoryJob(queue, created.objectiveId);
  assert.equal(firstJob.candidateId, "task_01_candidate_01");
  await service.runTask(firstJob);

  const secondJob = await findLatestFactoryJob(queue, created.objectiveId);
  assert.equal(secondJob.candidateId, "task_01_candidate_02");
  const detail = await service.getObjective(created.objectiveId);
  assert.ok(detail.candidates.some((candidate) => candidate.candidateId === "task_01_candidate_01" && candidate.status === "changes_requested"));
  assert.ok(detail.candidates.some((candidate) => candidate.candidateId === "task_01_candidate_02"));
});

test("factory no-diff discovery tasks are bypassed so downstream implementation can continue", { timeout: 120_000 }, async () => {
  const dataDir = await createTempDir("receipt-factory-no-diff-bypass");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  let runs = 0;
  const codexExecutor: CodexExecutor = {
    run: async (input) => {
      runs += 1;
      await fs.writeFile(input.promptPath, input.prompt, "utf-8");
      await fs.writeFile(input.stdoutPath, "", "utf-8");
      await fs.writeFile(input.stderrPath, "", "utf-8");
      const resultPath = input.prompt.match(/Write JSON to (.+?) with:/)?.[1]?.trim();
      assert.ok(resultPath, "task result path missing");
      if (runs >= 2) {
        await fs.writeFile(path.join(input.workspacePath, "IMPLEMENTED.txt"), `run ${runs}\n`, "utf-8");
      }
      await fs.writeFile(resultPath, JSON.stringify({
        outcome: "approved",
        summary: runs === 1
          ? "Located the Factory header link source but intentionally made no repository changes."
          : "Removed the header link and produced a repository diff.",
        handoff: runs === 1
          ? "Proceed to the implementation task now that the link source is known."
          : "Ready for review.",
      }, null, 2), "utf-8");
      await fs.writeFile(input.lastMessagePath, `run ${runs}`, "utf-8");
      return { exitCode: 0, signal: null, stdout: "", stderr: "", lastMessage: `run ${runs}` };
    },
  };
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime: createJobRuntime(dataDir),
    sse: new SseHub(),
    codexExecutor,
    memoryTools: createMemoryToolsForTest(dataDir),
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Locate the Factory header link source",
    prompt: "Search the repo to find where the /factory page renders the legacy header link and record the file path.",
    checks: ["git status --short"],
  });

  const internals = service as unknown as {
    emitObjective(objectiveId: string, event: unknown): Promise<void>;
  };
  await internals.emitObjective(created.objectiveId, {
    type: "task.added",
    objectiveId: created.objectiveId,
    createdAt: created.createdAt + 1,
    task: {
      nodeId: "task_02",
      taskId: "task_02",
      taskKind: "planned",
      title: "Remove the legacy header link",
      prompt: "Edit the Factory page so the legacy header link is removed.",
      workerType: "codex",
      baseCommit: created.baseHash,
      dependsOn: ["task_01"],
      status: "pending",
      skillBundlePaths: [],
      contextRefs: [],
      artifactRefs: {},
      createdAt: created.createdAt + 1,
    },
  });

  const firstJob = await findLatestFactoryJob(queue, created.objectiveId);
  assert.equal(firstJob.taskId, "task_01");
  await service.runTask(firstJob);

  const detail = await service.getObjective(created.objectiveId);
  assert.equal(detail.status, "executing");
  assert.equal(detail.tasks.find((task) => task.taskId === "task_01")?.status, "superseded");
  assert.equal(detail.tasks.find((task) => task.taskId === "task_02")?.status, "running");
  const nextJob = await findLatestFactoryJob(queue, created.objectiveId);
  assert.equal(nextJob.taskId, "task_02");
});

test("factory optimistic mutation append: stale heads are rejected without mutating the objective", async () => {
  const dataDir = await createTempDir("receipt-factory-stale-append");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime: createJobRuntime(dataDir),
    sse: new SseHub(),
    codexExecutor: {
      run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Stale mutation objective",
    prompt: "Verify optimistic mutation appends.",
    checks: ["git status --short"],
  });

  const internals = service as unknown as {
    currentHeadHash(objectiveId: string): Promise<string | undefined>;
    emitObjective(objectiveId: string, event: unknown): Promise<void>;
    emitObjectiveBatch(objectiveId: string, events: ReadonlyArray<unknown>, expectedPrev?: string): Promise<void>;
  };
  const staleHead = await internals.currentHeadHash(created.objectiveId);
  assert.ok(staleHead, "missing objective head");

  await internals.emitObjective(created.objectiveId, {
    type: "objective.blocked",
    objectiveId: created.objectiveId,
    reason: "Advance the objective head before the stale mutation lands.",
    summary: "Advance the objective head before the stale mutation lands.",
    blockedAt: created.createdAt + 10,
  });

  await assert.rejects(
    internals.emitObjectiveBatch(created.objectiveId, [{
      type: "task.added",
      objectiveId: created.objectiveId,
      createdAt: created.createdAt + 11,
      task: {
        nodeId: "task_02",
        taskId: "task_02",
        taskKind: "reconciliation",
        title: "Stale reconciliation task",
        prompt: "This mutation should be rejected.",
        workerType: "codex",
        baseCommit: created.baseHash,
        dependsOn: [],
        status: "pending",
        skillBundlePaths: [],
        contextRefs: [],
        artifactRefs: {},
        createdAt: created.createdAt + 11,
        basedOn: staleHead,
      },
    }], staleHead),
    /advanced before applying a mutation/,
  );

  const detail = await service.getObjective(created.objectiveId);
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks.some((task) => task.taskId === "task_02"), false);
});

test("factory reconciliation spawning refreshes stale state and keeps task ids unique", async () => {
  const dataDir = await createTempDir("receipt-factory-reconciliation-ids");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime: createJobRuntime(dataDir),
    sse: new SseHub(),
    codexExecutor: {
      run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Reconciliation ids objective",
    prompt: "Ensure stale reconciliation spawns do not collide.",
    checks: ["git status --short"],
  });

  const createdAt = created.createdAt + 10;
  const internals = service as unknown as {
    emitObjective(objectiveId: string, event: unknown): Promise<void>;
    spawnReconciliationTask(state: Awaited<ReturnType<FactoryService["getObjectiveState"]>>, candidateId: string, reason: string): Promise<void>;
  };
  await internals.emitObjective(created.objectiveId, {
    type: "candidate.created",
    objectiveId: created.objectiveId,
    createdAt,
    candidate: {
      candidateId: "task_01_candidate_01",
      taskId: "task_01",
      status: "approved",
      baseCommit: created.baseHash,
      checkResults: [],
      artifactRefs: {},
      createdAt,
      updatedAt: createdAt,
    },
  });

  const staleState = await service.getObjectiveState(created.objectiveId);
  await internals.spawnReconciliationTask(staleState, "task_01_candidate_01", "First reconciliation task.");
  await internals.spawnReconciliationTask(staleState, "task_01_candidate_01", "Second reconciliation task.");

  const detail = await service.getObjective(created.objectiveId);
  const taskIds = detail.tasks.map((task) => task.taskId);
  assert.ok(taskIds.includes("task_02"));
  assert.ok(taskIds.includes("task_03"));
  assert.equal(new Set(taskIds).size, taskIds.length);
});
