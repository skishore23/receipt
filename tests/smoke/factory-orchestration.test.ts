import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { type CodexExecutor } from "../../src/adapters/codex-executor";
import { createMemoryTools, decideMemory, initialMemoryState, reduceMemory, type MemoryCmd, type MemoryEvent, type MemoryState } from "../../src/adapters/memory-tools";
import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { jsonlQueue } from "../../src/adapters/jsonl-queue";
import { createRuntime } from "@receipt/core/runtime";
import { SseHub } from "../../src/framework/sse-hub";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";
import { FactoryService, type FactoryTaskJobPayload } from "../../src/services/factory-service";

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

const expectObjectiveReconcileIntent = async (
  queue: ReturnType<typeof jsonlQueue>,
  objectiveId: string,
): Promise<void> => {
  const controlJob = await findLatestObjectiveJob(queue, objectiveId, "factory.objective.control");
  expect(controlJob).toBeTruthy();
  const payload = controlJob!.payload as {
    readonly kind?: string;
    readonly objectiveId?: string;
    readonly reason?: string;
  };
  if (payload.reason === "reconcile") return;

  const commands = await queue.consumeCommands(controlJob!.id, ["steer"]);
  expect(commands.some((command) => {
    const commandPayload = command.payload as {
      readonly payload?: {
        readonly kind?: string;
        readonly objectiveId?: string;
        readonly reason?: string;
      };
    };
    return commandPayload.payload?.kind === "factory.objective.control"
      && commandPayload.payload.objectiveId === objectiveId
      && commandPayload.payload.reason === "reconcile";
  })).toBe(true);
};

test("factory scheduling: queued objectives preserve FIFO order without invoking llm decomposition", async () => {
  const dataDir = await createTempDir("receipt-factory-scheduling-fifo");
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

test("factory scheduling: startImmediately boots an admitted objective inline and queues codex work directly", async () => {
  const dataDir = await createTempDir("receipt-factory-start-immediate");
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
    title: "Start immediately",
    prompt: "Rename Skill to Profile in the sidebar and update related profile copy.",
    checks: ["git status --short"],
    startImmediately: true,
  });

  const taskJob = await findLatestObjectiveJob(queue, created.objectiveId, "factory.task.run");
  expect(taskJob).toBeTruthy();
  expect(taskJob?.status).toBe("queued");
  expect(await countObjectiveControlJobs(queue, created.objectiveId)).toBe(0);

  const refreshed = await service.getObjective(created.objectiveId);
  expect(refreshed.recentReceipts.some((receipt) => receipt.type === "task.dispatched")).toBe(true);
  expect(refreshed.nextAction).toBe("Wait for the active task pass to finish.");
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
  expect(admitted.phase).toBe("planning");
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

test("factory scheduling: canceling an active objective drains in-flight work without spawning replacements", async () => {
  const dataDir = await createTempDir("receipt-factory-cancel-drain");
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
    title: "Cancelable active objective",
    prompt: "Start a task, then cancel it mid-run.",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const beforeCancel = await service.getObjective(created.objectiveId);
  const rebracketsBefore = beforeCancel.recentReceipts.filter((receipt) => receipt.type === "rebracket.applied").length;
  const controlJobsBefore = await countObjectiveControlJobs(queue, created.objectiveId);
  const taskJob = await findLatestObjectiveJob(queue, created.objectiveId, "factory.task.run");
  expect(taskJob).toBeTruthy();

  await service.cancelObjective(created.objectiveId, "ui cancellation");

  const afterCancel = await service.getObjective(created.objectiveId);
  expect(afterCancel.status).toBe("canceled");
  expect(afterCancel.recentReceipts.filter((receipt) => receipt.type === "rebracket.applied").length).toBe(rebracketsBefore);
  expect(await countObjectiveControlJobs(queue, created.objectiveId)).toBe(controlJobsBefore);
  expect(taskJob ? (await queue.getJob(taskJob.id))?.status : undefined).toBe("canceled");
  const controlJobsAfter = (await queue.listJobs({ limit: 80 }))
    .filter((job) => {
      const payload = job.payload as { readonly kind?: string; readonly objectiveId?: string };
      return payload.kind === "factory.objective.control" && payload.objectiveId === created.objectiveId;
    });
  expect(controlJobsAfter.some((job) => job.status === "queued" || job.status === "running" || job.status === "leased")).toBe(false);
}, 120_000);

test("factory runtime: blocked tasks stay blocked instead of spawning mutation follow-ups", async () => {
  const dataDir = await createTempDir("receipt-factory-mutation");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const codexExecutor: CodexExecutor = {
    run: async (input) => {
      await fs.writeFile(input.promptPath, input.prompt, "utf-8");
      await fs.writeFile(input.stdoutPath, "", "utf-8");
      await fs.writeFile(input.stderrPath, "", "utf-8");
      const structured = {
        outcome: "blocked",
        summary: "Blocked by missing dependency details.",
        handoff: "Need a smaller unblock task before implementation can continue.",
      };
      const raw = JSON.stringify(structured);
      await fs.writeFile(input.lastMessagePath, raw, "utf-8");
      return { exitCode: 0, signal: null, stdout: raw, stderr: "", lastMessage: raw };
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
    title: "Mutation objective",
    prompt: "Implement the feature but adapt runtime orchestration if blocked.",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const firstJob = await findLatestFactoryJob(queue, created.objectiveId);
  await service.runTask(firstJob);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.latestRebracket?.source).toBe("runtime");
  expect(detail.tasks).toHaveLength(1);
  expect(detail.tasks.find((task) => task.taskId === "task_01")?.status).toBe("blocked");
  expect(detail.tasks.some((task) => task.title.startsWith("Unblock "))).toBe(false);
  expect(detail.tasks.some((task) => task.title.startsWith("Finish "))).toBe(false);
  expect(detail.blockedReason ?? "").toMatch(/No runnable tasks remained|blocked|Autonomous recovery stopped/i);
}, 120_000);

test("factory runtime: transient blocked tasks retry once automatically before asking for help", async () => {
  const dataDir = await createTempDir("receipt-factory-autonomous-retry");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  let runs = 0;
  const codexExecutor: CodexExecutor = {
    run: async (input) => {
      runs += 1;
      await fs.writeFile(input.promptPath, input.prompt, "utf-8");
      await fs.writeFile(input.stdoutPath, "", "utf-8");
      await fs.writeFile(input.stderrPath, "", "utf-8");
      const structured = {
        outcome: "blocked",
        summary: "Task runner timed out unexpectedly while Codex was preparing the result.",
        handoff: "Retry the task once because the failure looks transient.",
      };
      const raw = JSON.stringify(structured);
      await fs.writeFile(input.lastMessagePath, raw, "utf-8");
      return { exitCode: 0, signal: null, stdout: raw, stderr: "", lastMessage: raw };
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
    title: "Autonomous retry objective",
    prompt: "Retry one clearly transient failure automatically.",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const firstJob = await findLatestFactoryJob(queue, created.objectiveId);
  expect(firstJob.candidateId).toBe("task_01_candidate_01");
  await service.runTask(firstJob);

  const secondJob = await findLatestFactoryJob(queue, created.objectiveId);
  expect(secondJob.candidateId).toBe("task_01_candidate_02");

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("executing");
  expect(detail.recentReceipts.some((receipt) =>
    receipt.type === "rebracket.applied" && receipt.summary.includes("retry_task_01")
  )).toBe(true);
  expect(detail.tasks.find((task) => task.taskId === "task_01")?.status).toBe("running");
  expect(runs).toBe(1);
}, 120_000);

test("factory runtime: transient dispatch failures queue reconcile instead of blocking the objective", async () => {
  const dataDir = await createTempDir("receipt-factory-transient-dispatch");
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
    memoryTools: createMemoryToolsForTest(dataDir),
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Transient dispatch recovery objective",
    prompt: "Retry objective control when dispatch hits a transient lock.",
    checks: ["git status --short"],
  });

  const internals = service as unknown as {
    dispatchTask(
      state: Awaited<ReturnType<FactoryService["getObjectiveState"]>>,
      task: Awaited<ReturnType<FactoryService["getObjectiveState"]>>["workflow"]["tasksById"][string],
      opts?: { readonly expectedPrev?: string; readonly prefixEvents?: ReadonlyArray<unknown> },
    ): Promise<void>;
  };
  const originalDispatchTask = internals.dispatchTask.bind(service);
  let dispatchAttempts = 0;
  internals.dispatchTask = async () => {
    dispatchAttempts += 1;
    throw new Error("database is locked");
  };
  try {
    await runObjectiveStartup(service, created.objectiveId);
  } finally {
    internals.dispatchTask = originalDispatchTask;
  }

  expect(dispatchAttempts).toBe(1);
  await expectObjectiveReconcileIntent(queue, created.objectiveId);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).not.toBe("blocked");
  expect(detail.blockedReason).toBeUndefined();
  expect(detail.recentReceipts.some((receipt) =>
    receipt.type === "objective.blocked" || receipt.type === "task.blocked"
  )).toBe(false);
}, 120_000);

test("factory runtime: transient integration queue failures reconcile instead of blocking the objective", async () => {
  const dataDir = await createTempDir("receipt-factory-transient-integration");
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
    memoryTools: createMemoryToolsForTest(dataDir),
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Transient integration recovery objective",
    prompt: "Retry integration queueing when a transient controller failure happens.",
    checks: ["git status --short"],
  });

  const internals = service as unknown as {
    emitObjective(objectiveId: string, event: unknown): Promise<void>;
    queueIntegration(
      state: Awaited<ReturnType<FactoryService["getObjectiveState"]>>,
      candidateId: string,
      opts?: { readonly expectedPrev?: string; readonly prefixEvents?: ReadonlyArray<unknown> },
    ): Promise<void>;
  };
  await internals.emitObjective(created.objectiveId, {
    type: "task.ready",
    objectiveId: created.objectiveId,
    taskId: "task_01",
    readyAt: created.createdAt + 4,
  });
  await internals.emitObjective(created.objectiveId, {
    type: "candidate.created",
    objectiveId: created.objectiveId,
    createdAt: created.createdAt + 5,
    candidate: {
      candidateId: "task_01_candidate_01",
      taskId: "task_01",
      status: "planned",
      baseCommit: created.baseHash,
      checkResults: [],
      artifactRefs: {},
      createdAt: created.createdAt + 5,
      updatedAt: created.createdAt + 5,
    },
  });
  await internals.emitObjective(created.objectiveId, {
    type: "candidate.produced",
    objectiveId: created.objectiveId,
    candidateId: "task_01_candidate_01",
    taskId: "task_01",
    headCommit: created.baseHash,
    summary: "Produced the candidate.",
    handoff: "Ready for integration.",
    completion: {
      changed: ["Prepared the candidate."],
      proof: ["Validation is ready for integration."],
      remaining: [],
    },
    checkResults: [],
    scriptsRun: [],
    artifactRefs: {},
    producedAt: created.createdAt + 6,
  });
  await internals.emitObjective(created.objectiveId, {
    type: "task.review.requested",
    objectiveId: created.objectiveId,
    taskId: "task_01",
    reviewRequestedAt: created.createdAt + 6,
  });
  await internals.emitObjective(created.objectiveId, {
    type: "candidate.reviewed",
    objectiveId: created.objectiveId,
    candidateId: "task_01_candidate_01",
    taskId: "task_01",
    status: "approved",
    summary: "Approved candidate.",
    handoff: "Queue for integration.",
    reviewedAt: created.createdAt + 7,
  });

  const originalQueueIntegration = internals.queueIntegration.bind(service);
  let queueAttempts = 0;
  internals.queueIntegration = async () => {
    queueAttempts += 1;
    throw new Error("another git process seems to be running in this repository");
  };
  try {
    await service.reactObjective(created.objectiveId);
  } finally {
    internals.queueIntegration = originalQueueIntegration;
  }

  expect(queueAttempts).toBe(1);
  await expectObjectiveReconcileIntent(queue, created.objectiveId);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).not.toBe("blocked");
  expect(detail.integration.status).not.toBe("conflicted");
  expect(detail.recentReceipts.some((receipt) => receipt.type === "integration.conflicted")).toBe(false);
}, 120_000);

test("factory runtime: blocked tasks can record an explicit ask-human decision", async () => {
  const dataDir = await createTempDir("receipt-factory-ask-human");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const codexExecutor: CodexExecutor = {
    run: async (input) => {
      await fs.writeFile(input.promptPath, input.prompt, "utf-8");
      await fs.writeFile(input.stdoutPath, "", "utf-8");
      await fs.writeFile(input.stderrPath, "", "utf-8");
      const structured = {
        outcome: "blocked",
        summary: "Need the operator to choose the API contract before implementation can continue.",
        handoff: "Ask the human to choose the contract, then retry with that decision.",
      };
      const raw = JSON.stringify(structured);
      await fs.writeFile(input.lastMessagePath, raw, "utf-8");
      return { exitCode: 0, signal: null, stdout: raw, stderr: "", lastMessage: raw };
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
    title: "Ask human objective",
    prompt: "If the worker needs a product decision, record that explicitly.",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const firstJob = await findLatestFactoryJob(queue, created.objectiveId);
  await service.runTask(firstJob);

  const jobs = await queue.listJobs({ limit: 20 });
  const taskJobs = jobs.filter((job) => job.payload.kind === "factory.task.run" && job.payload.objectiveId === created.objectiveId);
  expect(taskJobs).toHaveLength(1);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("blocked");
  expect(detail.latestDecision?.selectedActionId).toBe("ask_human_task_01");
  expect(detail.latestDecision?.summary ?? "").toContain("Human input requested for task_01");
  expect(detail.blockedReason ?? "").toContain("Human input requested for task_01");
  expect(detail.tasks.find((task) => task.taskId === "task_01")?.status).toBe("blocked");
}, 120_000);

test("factory runtime: blocked objectives stay inert on bare react but follow-up guidance queues a new attempt", async () => {
  const dataDir = await createTempDir("receipt-factory-blocked-react");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const codexExecutor: CodexExecutor = {
    run: async (input) => {
      await fs.writeFile(input.promptPath, input.prompt, "utf-8");
      await fs.writeFile(input.stdoutPath, "", "utf-8");
      await fs.writeFile(input.stderrPath, "", "utf-8");
      const structured = {
        outcome: "blocked",
        summary: "Need the operator to choose the API contract before implementation can continue.",
        handoff: "Ask the human to choose the contract, then retry with that decision.",
      };
      const raw = JSON.stringify(structured);
      await fs.writeFile(input.lastMessagePath, raw, "utf-8");
      return { exitCode: 0, signal: null, stdout: raw, stderr: "", lastMessage: raw };
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
    title: "Blocked react objective",
    prompt: "Only continue when the operator provides the missing contract choice.",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const firstJob = await findLatestFactoryJob(queue, created.objectiveId);
  await service.runTask(firstJob);

  await service.reactObjective(created.objectiveId);

  let detail = await service.getObjective(created.objectiveId);
  let jobs = await queue.listJobs({ limit: 20 });
  let taskJobs = jobs.filter((job) =>
    job.payload.kind === "factory.task.run" && job.payload.objectiveId === created.objectiveId);
  expect(detail.status).toBe("blocked");
  expect(detail.tasks).toHaveLength(1);
  expect(detail.tasks[0]?.status).toBe("blocked");
  expect(detail.recentReceipts.some((receipt) => receipt.type === "task.unblocked")).toBe(false);
  expect(taskJobs).toHaveLength(1);

  await service.reactObjectiveWithNote(created.objectiveId, "Use the CLI contract for the next pass.");

  detail = await service.getObjective(created.objectiveId);
  jobs = await queue.listJobs({ limit: 20 });
  taskJobs = jobs.filter((job) =>
    job.payload.kind === "factory.task.run" && job.payload.objectiveId === created.objectiveId);
  expect(detail.status).toBe("executing");
  expect(detail.tasks).toHaveLength(2);
  expect(detail.tasks[0]?.status).toBe("superseded");
  expect(detail.tasks[1]?.taskId).toBe("task_02");
  expect(detail.tasks[1]?.prompt).toContain("Operator follow-up for this attempt:");
  expect(detail.tasks[1]?.prompt).toContain("Use the CLI contract for the next pass.");
  expect(taskJobs).toHaveLength(2);
  expect(taskJobs.some((job) => job.payload.taskId === "task_02")).toBe(true);
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
      const structured = {
        outcome: runs === 1 ? "changes_requested" : "approved",
        summary: runs === 1 ? "Need another pass before review can approve." : "Second pass is ready.",
        handoff: runs === 1 ? "Run another implementation pass with the latest diff." : "Ready for integration.",
      };
      const raw = JSON.stringify(structured);
      await fs.writeFile(input.lastMessagePath, raw, "utf-8");
      return { exitCode: 0, signal: null, stdout: raw, stderr: "", lastMessage: raw };
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

test("factory profile policy: non-worktree specialist workers are normalized to codex task execution", async () => {
  const dataDir = await createTempDir("receipt-factory-profile-policy");
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
    memoryTools: createMemoryToolsForTest(dataDir),
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Non-worktree writer objective",
    prompt: "Review the release notes.",
    checks: ["git status --short"],
    profileId: "generalist",
  });

  await runObjectiveStartup(service, created.objectiveId);
  const detail = await service.getObjective(created.objectiveId);
  expect(detail.profile.rootProfileId).toBe("generalist");
  expect(detail.tasks[0]?.workerType).toBe("codex");
  const taskJob = await findLatestFactoryJob(queue, created.objectiveId);
  expect(taskJob.workerType).toBe("codex");
  const queuedJob = await findLatestObjectiveJob(queue, created.objectiveId, "factory.task.run");
  expect(queuedJob?.agentId).toBe("codex");
}, 120_000);

test("factory no-diff discovery tasks integrate as no-op passes and unlock dependent work", async () => {
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
      if (runs >= 2) {
        await fs.writeFile(path.join(input.workspacePath, "IMPLEMENTED.txt"), `run ${runs}\n`, "utf-8");
      }
      const structured = {
        outcome: "approved",
        summary: runs === 1
          ? "Located the Factory header link source but intentionally made no repository changes."
          : "Removed the header link and produced a repository diff.",
        handoff: runs === 1
          ? "Proceed to the implementation task now that the link source is known."
          : "Ready for review.",
      };
      const raw = JSON.stringify(structured);
      await fs.writeFile(input.lastMessagePath, raw, "utf-8");
      return { exitCode: 0, signal: null, stdout: raw, stderr: "", lastMessage: raw };
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
    prompt: "Search the repo to find where the /factory page renders the header link and record the file path.",
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
      title: "Remove the header link",
      prompt: "Edit the Factory page so the header link is removed.",
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
  expect(detail.phase).toBe("executing");
  expect(detail.tasks.find((task) => task.taskId === "task_01")?.status).toBe("approved");
  expect(detail.tasks.find((task) => task.taskId === "task_01")?.blockedReason).toBeUndefined();
  expect(detail.recentReceipts.some((receipt) => receipt.type === "task.noop_completed" && receipt.taskId === "task_01")).toBe(true);
  expect(detail.tasks.find((task) => task.taskId === "task_02")?.status).toBe("running");
}, 120_000);

test("factory runtime: final no-diff task with satisfied operator guidance completes the objective", async () => {
  const dataDir = await createTempDir("receipt-factory-no-diff-complete");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const codexExecutor: CodexExecutor = {
    run: async (input) => {
      await fs.writeFile(input.promptPath, input.prompt, "utf-8");
      await fs.writeFile(input.stdoutPath, "", "utf-8");
      await fs.writeFile(input.stderrPath, "", "utf-8");
      const structured = {
        outcome: "approved",
        summary: "Validation passed with the existing repository state; no code changes were required for this objective.",
        handoff: "The current repository state already satisfies the objective.",
      };
      const raw = JSON.stringify(structured);
      await fs.writeFile(input.lastMessagePath, raw, "utf-8");
      return { exitCode: 0, signal: null, stdout: raw, stderr: "", lastMessage: raw };
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
    title: "CLI-first objective",
    prompt: "Create a CLI-first Factory objective.",
    checks: ["git status --short"],
  });
  await service.reactObjectiveWithNote(created.objectiveId, "Continue with the operator guidance.");

  const taskJob = await findLatestFactoryJob(queue, created.objectiveId);
  expect(taskJob.taskId).toBe("task_02");
  await service.runTask(taskJob);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("completed");
  expect(detail.phase).toBe("completed");
  expect(detail.blockedReason).toBeUndefined();
  expect(detail.tasks).toHaveLength(2);
  expect(detail.tasks[0]?.status).toBe("superseded");
  expect(detail.tasks[1]?.status).toBe("approved");
  expect(detail.integration.status).toBe("idle");
  expect(detail.recentReceipts.some((receipt) => receipt.type === "task.noop_completed" && receipt.taskId === "task_02")).toBe(true);
  expect(detail.evidenceCards.some((card) => card.receiptType === "task.noop_completed")).toBe(true);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "objective.completed")).toBe(true);
  expect(await findLatestObjectiveJob(queue, created.objectiveId, "factory.integration.validate")).toBeUndefined();
}, 120_000);

test("factory dispatch refreshes stale state before pinning the task workspace base", async () => {
  const dataDir = await createTempDir("receipt-factory-dispatch-refresh");
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
    memoryTools: createMemoryToolsForTest(dataDir),
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Dispatch refresh objective",
    prompt: "Ensure stale dispatches pick up the latest integration head.",
    checks: ["true"],
  });

  const internals = service as unknown as {
    emitObjective(objectiveId: string, event: unknown): Promise<void>;
    currentHeadHash(objectiveId: string): Promise<string | undefined>;
    dispatchTask(
      state: Awaited<ReturnType<FactoryService["getObjectiveState"]>>,
      task: Awaited<ReturnType<FactoryService["getObjectiveState"]>>["graph"]["nodes"][string],
      opts?: { readonly expectedPrev?: string },
    ): Promise<void>;
  };

  const taskCreatedAt = created.createdAt + 1;
  await internals.emitObjective(created.objectiveId, {
    type: "task.added",
    objectiveId: created.objectiveId,
    createdAt: taskCreatedAt,
    task: {
      nodeId: "task_01",
      taskId: "task_01",
      taskKind: "planned",
      title: "Validate the generated module",
      prompt: "Confirm the expected generated module already exists and only validate it.",
      workerType: "codex",
      baseCommit: created.baseHash,
      dependsOn: [],
      status: "ready",
      skillBundlePaths: [],
      contextRefs: [],
      artifactRefs: {},
      createdAt: taskCreatedAt,
    },
  });

  const staleState = await service.getObjectiveState(created.objectiveId);
  const staleTask = staleState.workflow.tasksById.task_01;
  expect(staleTask).toBeTruthy();
  await service.git.createWorkspace({
    workspaceId: `${created.objectiveId}_task_01_task_01_candidate_01`,
    agentId: "codex",
    baseHash: created.baseHash,
  });

  await fs.writeFile(path.join(repoRoot, "SECOND.txt"), "second commit\n", "utf-8");
  await git(repoRoot, ["add", "SECOND.txt"]);
  await git(repoRoot, ["commit", "-m", "second commit"]);
  const integrationHead = await git(repoRoot, ["rev-parse", "HEAD"]);

  await internals.emitObjective(created.objectiveId, {
    type: "integration.validated",
    objectiveId: created.objectiveId,
    candidateId: "task_00_candidate_01",
    headCommit: integrationHead,
    validationResults: [],
    summary: "Integration advanced to a newer commit.",
    validatedAt: taskCreatedAt + 10,
  });
  const headHash = await internals.currentHeadHash(created.objectiveId);
  expect(headHash).toBeTruthy();

  const originalGetObjectiveState = service.getObjectiveState.bind(service);
  service.getObjectiveState = async () => staleState;
  try {
    await internals.dispatchTask(staleState, staleTask, { expectedPrev: headHash ?? undefined });
  } finally {
    service.getObjectiveState = originalGetObjectiveState;
  }

  const taskJob = await findLatestFactoryJob(queue, created.objectiveId);
  expect(taskJob.baseCommit).toBe(integrationHead);
  expect(await git(taskJob.workspacePath, ["rev-parse", "HEAD"])).toBe(integrationHead);

  const manifest = JSON.parse(await fs.readFile(taskJob.manifestPath, "utf-8")) as {
    readonly task: { readonly baseCommit: string };
  };
  expect(manifest.task.baseCommit).toBe(integrationHead);
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
        taskKind: "planned",
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
