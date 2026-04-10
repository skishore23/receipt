import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createRuntime } from "@receipt/core/runtime";
import { sqliteQueue } from "../../src/adapters/sqlite-queue";
import { sqliteBranchStore, sqliteReceiptStore } from "../../src/adapters/sqlite";
import { JobWorker } from "../../src/engine/runtime/job-worker";
import { SseHub } from "../../src/framework/sse-hub";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";
import { createFactoryWorkerHandlers } from "../../src/services/factory-runtime";
import {
  FACTORY_MONITOR_AGENT_ID,
  FactoryService,
} from "../../src/services/factory-service";

const execFileAsync = promisify(execFile);

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 2_000,
  pollMs = 20,
): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
};

const createRepo = async (): Promise<string> => {
  const repoDir = await createTempDir("receipt-factory-monitor-runtime");
  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.name", "Factory Monitor Runtime Test"]);
  await git(repoDir, ["config", "user.email", "factory-monitor-runtime@example.com"]);
  await fs.writeFile(path.join(repoDir, "README.md"), "# factory monitor runtime test\n", "utf-8");
  await git(repoDir, ["add", "README.md"]);
  await git(repoDir, ["commit", "-m", "initial commit"]);
  await git(repoDir, ["branch", "-M", "main"]);
  return repoDir;
};

const createJobRuntime = (dataDir: string) =>
  createRuntime<JobCmd, JobEvent, JobState>(
    sqliteReceiptStore<JobEvent>(dataDir),
    sqliteBranchStore(dataDir),
    decideJob,
    reduceJob,
    initialJob,
  );

const createService = async () => {
  const dataDir = await createTempDir("receipt-factory-monitor-runtime-data");
  const repoRoot = await createRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: {
      run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    },
    repoRoot,
  });
  return { dataDir, repoRoot, jobRuntime, queue, service };
};

test("factory runtime: codex task completion reacts after the queue marks the task job completed", async () => {
  const { queue, service } = await createService();
  const observedStatuses: string[] = [];
  service.runTask = async () => ({
    objectiveId: "objective_live_finalize",
    taskId: "task_01",
    candidateId: "task_01_candidate_01",
    status: "completed",
  });
  service.reactObjective = async (objectiveId: string) => {
    const latest = await queue.getJob(job.id);
    observedStatuses.push(`${objectiveId}:${latest?.status ?? "missing"}`);
  };
  const handlers = createFactoryWorkerHandlers(service);
  const worker = new JobWorker({
    queue,
    workerId: "worker_codex_finalize",
    leaseAgentIds: ["codex"],
    idleResyncMs: 20_000,
    leaseMs: 5_000,
    concurrency: 1,
    handlers,
  });
  const job = await queue.enqueue({
    agentId: "codex",
    lane: "collect",
    maxAttempts: 1,
    payload: {
      kind: "factory.task.run",
      objectiveId: "objective_live_finalize",
      taskId: "task_01",
      candidateId: "task_01_candidate_01",
      workspaceId: "workspace_live_finalize",
      workspacePath: path.join(os.tmpdir(), "workspace_live_finalize"),
      promptPath: path.join(os.tmpdir(), "task.prompt.md"),
      stdoutPath: path.join(os.tmpdir(), "task.stdout.log"),
      stderrPath: path.join(os.tmpdir(), "task.stderr.log"),
      resultPath: path.join(os.tmpdir(), "task.result.json"),
      evidencePath: path.join(os.tmpdir(), "task.evidence.json"),
      manifestPath: path.join(os.tmpdir(), "task.manifest.json"),
      contextPath: path.join(os.tmpdir(), "task.context.md"),
      contextPackPath: path.join(os.tmpdir(), "task.context-pack.json"),
      receiptCliPath: path.join(os.tmpdir(), "task.receipt-cli.md"),
      memoryScriptPath: path.join(os.tmpdir(), "task.memory.cjs"),
      memoryScopesPath: path.join(os.tmpdir(), "task.memory-scopes.json"),
      skillBundlePath: path.join(os.tmpdir(), "task.skill-bundle.json"),
      resultSchemaPath: path.join(os.tmpdir(), "task.result.schema.json"),
      taskPrompt: "Investigate live completion ordering.",
      profile: {
        rootProfileId: "infrastructure",
        rootProfileLabel: "Infrastructure",
        promptHash: "prompt_hash",
        promptPath: "profiles/infrastructure/PROFILE.md",
        resolvedProfileHash: "profile_hash",
      },
      objectiveMode: "investigation",
      executionMode: "worktree",
      severity: 2,
      workerType: "codex",
      baseCommit: "7360528d443dcb502ea4931226fb36717d6c7f33",
      contextRefs: [],
      skillBundlePaths: [],
      repoSkillPaths: [],
      taskPhase: "collecting_evidence",
      jobId: "job_live_finalize",
    },
  });

  worker.start();
  const settled = await queue.waitForJob(job.id, 2_000);
  await waitFor(() => observedStatuses.length === 1);
  worker.stop();

  expect(settled?.status).toBe("completed");
  expect(observedStatuses).toEqual(["objective_live_finalize:completed"]);
});

test("factory monitor runtime: monitor progress updates the leased monitor job", async () => {
  const { dataDir, queue, service } = await createService();
  const created = await service.createObjective({
    title: "Monitor live progress",
    prompt: "Investigate runtime stall behavior.",
    objectiveMode: "investigation",
    severity: 2,
  });
  const emitObjectiveBatch = (service as unknown as {
    emitObjectiveBatch: (objectiveId: string, events: ReadonlyArray<Record<string, unknown>>) => Promise<void>;
  }).emitObjectiveBatch.bind(service);
  const startedAt = Date.now();
  await emitObjectiveBatch(created.objectiveId, [
    {
      type: "candidate.created",
      objectiveId: created.objectiveId,
      createdAt: startedAt,
      candidate: {
        candidateId: "task_01_candidate_01",
        taskId: "task_01",
        status: "running",
        baseCommit: created.baseHash,
        checkResults: [],
        artifactRefs: {},
        createdAt: startedAt,
        updatedAt: startedAt,
      },
    },
    {
      type: "task.dispatched",
      objectiveId: created.objectiveId,
      taskId: "task_01",
      candidateId: "task_01_candidate_01",
      taskPhase: "collecting_evidence",
      jobId: "job_factory_objective_monitor_target",
      workspaceId: "workspace_monitor_runtime",
      workspacePath: path.join(dataDir, "workspace-monitor-runtime"),
      skillBundlePaths: [],
      contextRefs: [],
      startedAt: startedAt + 1,
    },
  ]);
  const stdoutPath = path.join(dataDir, "monitor.stdout.log");
  const stderrPath = path.join(dataDir, "monitor.stderr.log");
  const evidenceDir = path.join(dataDir, "evidence");
  await fs.writeFile(stdoutPath, "initial output\n", "utf-8");
  await fs.writeFile(stderrPath, "", "utf-8");
  await fs.mkdir(evidenceDir, { recursive: true });

  const codexJob = await queue.enqueue({
    jobId: "job_factory_objective_monitor_target",
    agentId: "codex",
    lane: "collect",
    maxAttempts: 1,
    payload: {
      kind: "factory.task.run",
      objectiveId: created.objectiveId,
      taskId: "task_01",
      candidateId: "task_01_candidate_01",
    },
  });
  const monitorJob = await queue.enqueue({
    jobId: "job_factory_monitor_objective_monitor_runtime_task_01_task_01_candidate_01",
    agentId: FACTORY_MONITOR_AGENT_ID,
    lane: "collect",
    maxAttempts: 1,
    payload: {
      kind: "factory.task.monitor",
      objectiveId: created.objectiveId,
      taskId: "task_01",
      candidateId: "task_01_candidate_01",
      codexJobId: codexJob.id,
      stdoutPath,
      stderrPath,
      taskPrompt: "Investigate runtime stall behavior.",
      splitDepth: 0,
      objectiveMode: "investigation",
      severity: 2,
      evidenceDir,
    },
  });
  await queue.leaseJob(monitorJob.id, "worker_monitor", 30_000);

  let abortChecks = 0;
  const result = await service.runMonitorJob(monitorJob.payload, {
    jobId: monitorJob.id,
    workerId: "worker_monitor",
    pollIntervalMs: 1,
    sleep: async () => undefined,
    shouldAbort: async () => {
      abortChecks += 1;
      return abortChecks > 1;
    },
  });

  const refreshed = await queue.getJob(monitorJob.id);
  expect(result.status).toBe("monitor_aborted");
  expect(refreshed?.status).toBe("running");
  expect(refreshed?.result?.phase).toBe("polling");
  expect(typeof refreshed?.result?.elapsedMs).toBe("number");
  expect(refreshed?.result?.checkpoints).toBe(0);
}, 120_000);

test("factory monitor runtime: stops once the monitored task is no longer running", async () => {
  const { dataDir, queue, service } = await createService();
  const created = await service.createObjective({
    title: "Monitor terminal task",
    prompt: "Investigate monitor shutdown after a reported result.",
    objectiveMode: "investigation",
    severity: 2,
  });
  const now = Date.now();
  const candidateId = "task_01_candidate_01";
  const emitObjectiveBatch = (service as unknown as {
    emitObjectiveBatch: (objectiveId: string, events: ReadonlyArray<Record<string, unknown>>) => Promise<void>;
  }).emitObjectiveBatch.bind(service);
  await emitObjectiveBatch(created.objectiveId, [
    {
      type: "candidate.created",
      objectiveId: created.objectiveId,
      createdAt: now,
      candidate: {
        candidateId,
        taskId: "task_01",
        status: "running",
        baseCommit: created.baseHash,
        checkResults: [],
        artifactRefs: {},
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      type: "investigation.reported",
      objectiveId: created.objectiveId,
      taskId: "task_01",
      candidateId,
      outcome: "approved",
      summary: "Investigation already finished.",
      handoff: "Report complete.",
      completion: {
        changed: [],
        proof: ["Captured report."],
        remaining: [],
      },
      report: {
        conclusion: "Evidence already answers the question.",
        evidence: [{ title: "Existing report", summary: "The report was already captured.", detail: null }],
        evidenceRecords: [],
        scriptsRun: [],
        disagreements: [],
        nextSteps: [],
      },
      artifactRefs: {},
      reportedAt: now + 1,
    },
  ]);

  const codexJob = await queue.enqueue({
    jobId: "job_factory_objective_monitor_terminal_target",
    agentId: "codex",
    lane: "collect",
    maxAttempts: 1,
    payload: {
      kind: "factory.task.run",
      objectiveId: created.objectiveId,
      taskId: "task_01",
      candidateId,
    },
  });

  const result = await service.runMonitorJob({
    kind: "factory.task.monitor",
    objectiveId: created.objectiveId,
    taskId: "task_01",
    candidateId,
    codexJobId: codexJob.id,
    stdoutPath: path.join(dataDir, "terminal.stdout.log"),
    stderrPath: path.join(dataDir, "terminal.stderr.log"),
    taskPrompt: "Investigate monitor shutdown after reporting.",
    splitDepth: 0,
    objectiveMode: "investigation",
    severity: 2,
    evidenceDir: path.join(dataDir, "terminal-evidence"),
  }, {
    pollIntervalMs: 1,
    sleep: async () => undefined,
    shouldAbort: async () => false,
  });

  expect(result.status).toBe("task_not_active");
  expect(result.checkpoints).toBe(0);
}, 120_000);

test("factory runtime: stale objective conflicts during react schedule reconcile instead of surfacing", async () => {
  const { service } = await createService();
  const created = await service.createObjective({
    title: "Concurrent react test",
    prompt: "Investigate a concurrent react race.",
    objectiveMode: "investigation",
    severity: 2,
  });

  const originalSyncFailedActiveTasks = (service as unknown as {
    syncFailedActiveTasks: (state: unknown) => Promise<void>;
  }).syncFailedActiveTasks;
  const originalEnqueueObjectiveControl = (service as unknown as {
    enqueueObjectiveControl: (objectiveId: string, reason: string) => Promise<void>;
  }).enqueueObjectiveControl;
  const reconcileCalls: Array<{ objectiveId: string; reason: string }> = [];

  (service as unknown as {
    syncFailedActiveTasks: (state: unknown) => Promise<void>;
  }).syncFailedActiveTasks = async () => {
    throw new Error("Expected prev hash stale_old_head but head is stale_new_head");
  };
  (service as unknown as {
    enqueueObjectiveControl: (objectiveId: string, reason: string) => Promise<void>;
  }).enqueueObjectiveControl = async (objectiveId, reason) => {
    reconcileCalls.push({ objectiveId, reason });
  };

  try {
    await expect(service.reactObjective(created.objectiveId)).resolves.toBeUndefined();
  } finally {
    (service as unknown as {
      syncFailedActiveTasks: (state: unknown) => Promise<void>;
    }).syncFailedActiveTasks = originalSyncFailedActiveTasks;
    (service as unknown as {
      enqueueObjectiveControl: (objectiveId: string, reason: string) => Promise<void>;
    }).enqueueObjectiveControl = originalEnqueueObjectiveControl;
  }

  expect(reconcileCalls).toEqual([{ objectiveId: created.objectiveId, reason: "reconcile" }]);
}, 120_000);

test("factory monitor runtime: suppresses redundant synth recommendation once synthesis is active", async () => {
  const { service } = await createService();
  const shouldEmit = (service as unknown as {
    shouldEmitMonitorRecommendation: (
      taskPhase: "collecting_evidence" | "evidence_ready" | "synthesizing",
      recommendation: { kind: string; reason?: string; guidance?: string },
      priorRecommendation?: { kind: string; reason?: string; guidance?: string },
    ) => boolean;
  }).shouldEmitMonitorRecommendation.bind(service);

  expect(shouldEmit("synthesizing", {
    kind: "recommend_enter_synthesizing",
    reason: "finish from mounted evidence",
  })).toBe(false);
}, 120_000);

test("factory monitor runtime: suppresses duplicate unresolved recommendation for the same task candidate", async () => {
  const { service } = await createService();
  const shouldEmit = (service as unknown as {
    shouldEmitMonitorRecommendation: (
      taskPhase: "collecting_evidence" | "evidence_ready" | "synthesizing",
      recommendation: { kind: string; reason?: string; guidance?: string },
      priorRecommendation?: { kind: string; reason?: string; guidance?: string },
    ) => boolean;
  }).shouldEmitMonitorRecommendation.bind(service);

  expect(shouldEmit(
    "evidence_ready",
    { kind: "recommend_enter_synthesizing", reason: "evidence already answers the task" },
    { kind: "recommend_enter_synthesizing", reason: "evidence already answers the task" },
  )).toBe(false);
  expect(shouldEmit(
    "collecting_evidence",
    { kind: "recommend_steer", guidance: "Use the checked-in helper first." },
    { kind: "recommend_steer", guidance: "Use the checked-in helper first." },
  )).toBe(false);
}, 120_000);
