import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  expect(match).toBeTruthy();
  return match.payload as FactoryTaskJobPayload;
};

const findLatestObjectiveJob = async (
  queue: ReturnType<typeof jsonlQueue>,
  objectiveId: string,
  kind: string,
) => {
  const jobs = await queue.listJobs({ limit: 80 });
  return jobs
    .filter((job) => {
      const payload = job.payload as { readonly kind?: string; readonly objectiveId?: string };
      return payload.kind === kind && payload.objectiveId === objectiveId;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
};

const countObjectiveControlJobs = async (
  queue: ReturnType<typeof jsonlQueue>,
  objectiveId: string,
): Promise<number> => {
  const jobs = await queue.listJobs({ limit: 80 });
  return jobs.filter((job) => {
    const payload = job.payload as {
      readonly kind?: string;
      readonly objectiveId?: string;
    };
    return payload.kind === "factory.objective.control" && payload.objectiveId === objectiveId;
  }).length;
};

test("factory scheduling: queued objectives preserve FIFO order without invoking llm decomposition", async () => {
  const dataDir = await createTempDir("receipt-factory-scheduling-fifo");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  let llmCalls = 0;
  const llmStructured = async <Schema extends ZodTypeAny>(opts: {
    readonly schemaName: string;
    readonly schema: Schema;
  }): Promise<{ readonly parsed: ZodInfer<Schema>; readonly raw: string }> => {
    llmCalls += 1;
    const payload = {
      tasks: [{
        title: "Should not run during queue admission",
        prompt: "This decomposition path should stay untouched in this test.",
        workerType: "codex",
        dependsOn: [],
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
    codexExecutor: {
      run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    },
    llmStructured,
    repoRoot,
  });

  const first = await service.createObjective({
    title: "First queued scheduling objective",
    prompt: "Keep the repo slot and do not start decomposition yet.",
    checks: ["git status --short"],
  });
  const second = await service.createObjective({
    title: "Second queued scheduling objective",
    prompt: "Wait behind the first objective in FIFO order.",
    checks: ["git status --short"],
  });
  const third = await service.createObjective({
    title: "Third queued scheduling objective",
    prompt: "Wait behind the second objective in FIFO order.",
    checks: ["git status --short"],
  });

  expect(llmCalls).toBe(0);
  expect(first.scheduler.slotState).toBe("active");
  expect(second.scheduler.slotState).toBe("queued");
  expect(second.scheduler.queuePosition).toBe(1);
  expect(second.phase).toBe("waiting_for_slot");
  expect(second.nextAction).toBe("Waiting for the repo execution slot (1 in queue).");
  expect(third.scheduler.slotState).toBe("queued");
  expect(third.scheduler.queuePosition).toBe(2);
  expect(third.phase).toBe("waiting_for_slot");
  expect(third.nextAction).toBe("Waiting for the repo execution slot (2 in queue).");
}, 120_000);

test("factory scheduling: archiving an active objective cancels queued task jobs and admits the next objective immediately", async () => {
  const dataDir = await createTempDir("receipt-factory-archive-rebalance");
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

  const first = await service.createObjective({
    title: "Archive source objective",
    prompt: "Dispatch a task so archive cleanup has a live queue job to cancel.",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, first.objectiveId);

  const queuedTaskJob = await findLatestObjectiveJob(queue, first.objectiveId, "factory.task.run");
  expect(queuedTaskJob).toBeTruthy();
  expect(queuedTaskJob?.status).toBe("queued");

  const second = await service.createObjective({
    title: "Queued follow-up objective",
    prompt: "Wait for the first objective to release the repo execution slot.",
    checks: ["git status --short"],
  });
  expect(second.scheduler.slotState).toBe("queued");
  expect(second.scheduler.queuePosition).toBe(1);

  await service.archiveObjective(first.objectiveId);

  const canceledTaskJob = queuedTaskJob ? await queue.getJob(queuedTaskJob.id) : undefined;
  expect(canceledTaskJob?.status).toBe("canceled");

  const archived = await service.getObjective(first.objectiveId);
  expect(archived.archivedAt).toBeTruthy();
  expect(archived.recentReceipts.some((receipt) =>
    receipt.type === "objective.slot.released" && /archived/i.test(receipt.summary)
  )).toBe(true);

  const admitted = await service.getObjective(second.objectiveId);
  expect(admitted.scheduler.slotState).toBe("active");
  expect(admitted.phase).toBe("preparing_repo");
  const admittedControlJob = await findLatestObjectiveJob(queue, second.objectiveId, "factory.objective.control");
  const admittedPayload = admittedControlJob?.payload as {
    readonly kind?: string;
    readonly reason?: string;
  } | undefined;
  expect(admittedPayload?.reason).toBe("admitted");
}, 120_000);

test("factory scheduling: resume ignores archived objectives instead of re-enqueueing control work for them", async () => {
  const dataDir = await createTempDir("receipt-factory-archive-resume");
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

  const first = await service.createObjective({
    title: "Archived resume source objective",
    prompt: "Archive this objective after it dispatches once.",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, first.objectiveId);

  const second = await service.createObjective({
    title: "Resume target objective",
    prompt: "This objective should inherit the slot after archive.",
    checks: ["git status --short"],
  });
  expect(second.scheduler.slotState).toBe("queued");

  await service.archiveObjective(first.objectiveId);
  const archivedControlJobsBefore = await countObjectiveControlJobs(queue, first.objectiveId);

  await service.resumeObjectives();

  const archivedControlJobsAfter = await countObjectiveControlJobs(queue, first.objectiveId);
  expect(archivedControlJobsAfter).toBe(archivedControlJobsBefore);

  const active = await service.getObjective(second.objectiveId);
  expect(active.scheduler.slotState).toBe("active");
}, 120_000);

test("factory runtime: blocked tasks emit split/supersede mutation receipts at runtime", async () => {
  const dataDir = await createTempDir("receipt-factory-mutation");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const codexExecutor: CodexExecutor = {
    run: async (input) => {
      await fs.writeFile(input.promptPath, input.prompt, "utf-8");
      await fs.writeFile(input.stdoutPath, "", "utf-8");
      await fs.writeFile(input.stderrPath, "", "utf-8");
      const resultPath = input.prompt.match(/Write JSON to (.+?) with:/)?.[1]?.trim();
      expect(resultPath).toBeTruthy();
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
    const payload = {
      tasks: [{
        title: "Build the implementation",
        prompt: "Implement the requested factory change.",
        workerType: "codex",
        dependsOn: [],
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
    llmStructured,
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Mutation objective",
    prompt: "Implement the feature but adapt runtime orchestration if blocked.",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const firstJob = await findLatestFactoryJob(queue, created.objectiveId);
  await service.runTask(firstJob);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.latestRebracket?.source).toBe("runtime");
  expect(detail.tasks.find((task) => task.taskId === "task_01")?.status).toBe("superseded");
  expect(detail.tasks.some((task) => task.title.startsWith("Unblock "))).toBeTruthy();
  expect(detail.tasks.some((task) => task.title.startsWith("Finish "))).toBeTruthy();
}, 120_000);

test("factory candidate lineage: rework dispatch mints a fresh candidate id", async () => {
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
      expect(resultPath).toBeTruthy();
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
  await runObjectiveStartup(service, created.objectiveId);

  const firstJob = await findLatestFactoryJob(queue, created.objectiveId);
  expect(firstJob.candidateId).toBe("task_01_candidate_01");
  await service.runTask(firstJob);

  const secondJob = await findLatestFactoryJob(queue, created.objectiveId);
  expect(secondJob.candidateId).toBe("task_01_candidate_02");
  const detail = await service.getObjective(created.objectiveId);
  expect(detail.candidates.some((candidate) => candidate.candidateId === "task_01_candidate_01" && candidate.status === "changes_requested")).toBeTruthy();
  expect(detail.candidates.some((candidate) => candidate.candidateId === "task_01_candidate_02")).toBeTruthy();
}, 120_000);

test("factory profile policy: workers marked non-worktree are rejected from task dispatch", async () => {
  const dataDir = await createTempDir("receipt-factory-profile-policy");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const llmStructured = async <Schema extends ZodTypeAny>(opts: {
    readonly schemaName: string;
    readonly schema: Schema;
  }): Promise<{ readonly parsed: ZodInfer<Schema>; readonly raw: string }> => {
    const payload = {
      tasks: [{
        title: "Review release notes",
        prompt: "Summarize the release implications without editing code.",
        workerType: "writer",
        dependsOn: [],
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
    codexExecutor: {
      run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    },
    memoryTools: createMemoryToolsForTest(dataDir),
    llmStructured,
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Non-worktree writer objective",
    prompt: "Review the release notes.",
    checks: ["git status --short"],
    profileId: "generalist",
  });

  await expect(runObjectiveStartup(service, created.objectiveId)).rejects.toThrow(/configured without a task worktree/i);
  const detail = await service.getObjective(created.objectiveId);
  expect(detail.profile.rootProfileId).toBe("generalist");
  expect(detail.tasks[0]?.workerType).toBe("writer");
}, 120_000);

test("factory no-diff discovery tasks are bypassed so downstream implementation can continue", async () => {
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
      expect(resultPath).toBeTruthy();
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
  await runObjectiveStartup(service, created.objectiveId);

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
  expect(firstJob.taskId).toBe("task_01");
  await service.runTask(firstJob);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("executing");
  expect(detail.tasks.find((task) => task.taskId === "task_01")?.status).toBe("superseded");
  expect(detail.tasks.find((task) => task.taskId === "task_02")?.status).toBe("running");
  const nextJob = await findLatestFactoryJob(queue, created.objectiveId);
  expect(nextJob.taskId).toBe("task_02");
}, 120_000);

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
  await runObjectiveStartup(service, created.objectiveId);

  const internals = service as unknown as {
    currentHeadHash(objectiveId: string): Promise<string | undefined>;
    emitObjective(objectiveId: string, event: unknown): Promise<void>;
    emitObjectiveBatch(objectiveId: string, events: ReadonlyArray<unknown>, expectedPrev?: string): Promise<void>;
  };
  const staleHead = await internals.currentHeadHash(created.objectiveId);
  expect(staleHead).toBeTruthy();

  await internals.emitObjective(created.objectiveId, {
    type: "objective.blocked",
    objectiveId: created.objectiveId,
    reason: "Advance the objective head before the stale mutation lands.",
    summary: "Advance the objective head before the stale mutation lands.",
    blockedAt: created.createdAt + 10,
  });

  await expect(internals.emitObjectiveBatch(created.objectiveId, [{
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
    }], staleHead)).rejects.toThrow(/advanced before applying a mutation/);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.tasks.length).toBe(1);
  expect(detail.tasks.some((task) => task.taskId === "task_02")).toBe(false);
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
  await runObjectiveStartup(service, created.objectiveId);

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
  expect(taskIds.includes("task_02")).toBeTruthy();
  expect(taskIds.includes("task_03")).toBeTruthy();
  expect(new Set(taskIds).size).toBe(taskIds.length);
});
