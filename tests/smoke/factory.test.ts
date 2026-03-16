import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ZodTypeAny, infer as ZodInfer } from "zod";

import { fold } from "../../src/core/chain.ts";
import { receipt } from "../../src/core/chain.ts";
import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import { jsonlQueue } from "../../src/adapters/jsonl-queue.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import { SseHub } from "../../src/framework/sse-hub.ts";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job.ts";
import {
  buildFactoryProjection,
  DEFAULT_FACTORY_OBJECTIVE_POLICY,
  reduceFactory,
  initialFactoryState,
  type FactoryEvent,
} from "../../src/modules/factory.ts";
import { FactoryService } from "../../src/services/factory-service.ts";
import { factoryObjectiveIsland, factoryShell } from "../../src/views/factory.ts";
import type { BranchStore, Receipt, Store } from "../../src/core/types.ts";

const stream = "factory/objectives/demo";
const execFileAsync = promisify(execFile);

const asChain = (events: ReadonlyArray<FactoryEvent>) => {
  let prev: string | undefined;
  return events.map((event, index) => {
    const next = receipt(stream, prev, event, index + 1);
    prev = next.hash;
    return next;
  });
};

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
  const repoDir = await createTempDir("receipt-factory-source");
  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.name", "Factory Test"]);
  await git(repoDir, ["config", "user.email", "factory@example.com"]);
  await fs.writeFile(path.join(repoDir, "README.md"), "# factory test\n", "utf-8");
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

test("runtime cache: repeated state and chain reads reuse the in-process snapshot", async () => {
  let readCount = 0;
  const receipts: Receipt<number>[] = [];
  const store: Store<number> = {
    append: async (receipt) => {
      receipts.push(receipt);
    },
    read: async () => {
      readCount += 1;
      return receipts;
    },
    take: async (_stream, n) => {
      readCount += 1;
      return receipts.slice(0, n);
    },
    count: async () => receipts.length,
    head: async () => receipts.at(-1),
  };
  const branchStore: BranchStore = {
    save: async () => undefined,
    get: async () => undefined,
    list: async () => [],
    children: async () => [],
  };
  const runtime = createRuntime<{ readonly value: number }, number, number>(
    store,
    branchStore,
    (cmd) => [cmd.value],
    (state, event) => state + event,
    0,
  );

  expect(await runtime.state("demo")).toBe(0);
  expect(await runtime.state("demo")).toBe(0);
  expect(await runtime.chain("demo").then((chain) => chain.length)).toBe(0);
  expect(readCount).toBe(1);

  await runtime.execute("demo", { value: 2 });

  expect(await runtime.state("demo")).toBe(2);
  expect(await runtime.chain("demo").then((chain) => chain.length)).toBe(1);
  expect(readCount).toBe(1);
});

test("factory reducer: replay reconstructs task, candidate, and integration state deterministically", () => {
  const events: FactoryEvent[] = [
    {
      type: "objective.created",
      objectiveId: "objective_demo",
      title: "Factory objective",
      prompt: "Implement the task graph.",
      channel: "results",
      baseHash: "abc1234",
      checks: ["npm run build"],
      checksSource: "explicit",
      policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
      createdAt: 1,
    },
    {
      type: "task.added",
      objectiveId: "objective_demo",
      createdAt: 2,
      task: {
        nodeId: "task_01",
        taskId: "task_01",
        taskKind: "planned",
        title: "Implement core",
        prompt: "Add the factory reducer.",
        workerType: "codex",
        baseCommit: "abc1234",
        dependsOn: [],
        status: "pending",
        skillBundlePaths: [],
        contextRefs: [],
        artifactRefs: {},
        createdAt: 2,
      },
    },
    {
      type: "task.ready",
      objectiveId: "objective_demo",
      taskId: "task_01",
      readyAt: 3,
    },
    {
      type: "candidate.created",
      objectiveId: "objective_demo",
      createdAt: 4,
      candidate: {
        candidateId: "task_01_candidate_01",
        taskId: "task_01",
        status: "planned",
        baseCommit: "abc1234",
        checkResults: [],
        artifactRefs: {},
        createdAt: 4,
        updatedAt: 4,
      },
    },
    {
      type: "task.dispatched",
      objectiveId: "objective_demo",
      taskId: "task_01",
      candidateId: "task_01_candidate_01",
      jobId: "job_01",
      workspaceId: "ws_01",
      workspacePath: "/tmp/ws_01",
      skillBundlePaths: ["/tmp/ws_01/.receipt/factory/task_01.skill-bundle.json"],
      contextRefs: [],
      startedAt: 5,
    },
    {
      type: "candidate.produced",
      objectiveId: "objective_demo",
      candidateId: "task_01_candidate_01",
      taskId: "task_01",
      headCommit: "def5678",
      summary: "Produced candidate.",
      handoff: "Ready for review.",
      checkResults: [{
        command: "npm run build",
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        startedAt: 6,
        finishedAt: 7,
      }],
      artifactRefs: {},
      producedAt: 7,
    },
    {
      type: "task.review.requested",
      objectiveId: "objective_demo",
      taskId: "task_01",
      reviewRequestedAt: 7,
    },
    {
      type: "candidate.reviewed",
      objectiveId: "objective_demo",
      candidateId: "task_01_candidate_01",
      taskId: "task_01",
      status: "approved",
      summary: "Approved candidate.",
      handoff: "Queue for integration.",
      reviewedAt: 8,
    },
    {
      type: "integration.queued",
      objectiveId: "objective_demo",
      candidateId: "task_01_candidate_01",
      branchName: "hub/integration/objective_demo",
      queuedAt: 9,
    },
    {
      type: "integration.ready_to_promote",
      objectiveId: "objective_demo",
      candidateId: "task_01_candidate_01",
      headCommit: "fedcba9",
      validationResults: [],
      summary: "Integration checks passed.",
      readyAt: 10,
    },
    {
      type: "integration.promoted",
      objectiveId: "objective_demo",
      candidateId: "task_01_candidate_01",
      promotedCommit: "fedcba9",
      summary: "Promoted integration.",
      promotedAt: 11,
    },
  ];

  const chain = asChain(events);
  const replayA = fold(chain, reduceFactory, initialFactoryState);
  const replayB = fold(chain, reduceFactory, initialFactoryState);

  expect(replayA).toEqual(replayB);
  const projection = buildFactoryProjection(replayA);
  expect(projection.status).toBe("completed");
  expect(projection.tasks[0]?.status).toBe("approved");
  expect(projection.integration.status).toBe("promoted");
  expect(replayA.candidates.task_01_candidate_01?.status).toBe("approved");
  expect(replayA.integration.promotedCommit).toBe("fedcba9");
});

test("factory decomposition: invalid dependency references are dropped and canonicalized", async () => {
  const dataDir = await createTempDir("receipt-factory-decomposition");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const llmStructured = async <Schema extends ZodTypeAny>(opts: {
    readonly schemaName: string;
    readonly schema: Schema;
  }): Promise<{ readonly parsed: ZodInfer<Schema>; readonly raw: string }> => {
    const payload = {
      tasks: [
        {
          title: "Prepare implementation",
          prompt: "Set up the work.",
          workerType: "codex",
          dependsOn: ["task_01", "task_99", "nonsense"],
        },
        {
          title: "Implement feature",
          prompt: "Build the feature.",
          workerType: "codex",
          dependsOn: ["task_01", "task_02", "task_99"],
        },
        {
          title: "Verify feature",
          prompt: "Validate the feature.",
          workerType: "codex",
          dependsOn: ["task_02", "task_03", "task_01", "task_02"],
        },
      ],
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
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    llmStructured,
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Dependency validation objective",
    prompt: "Validate decomposition dependencies.",
    checks: ["git status --short"],
  });
  expect(created.phase).toBe("preparing_repo");
  expect(created.tasks.length).toBe(0);

  await runObjectiveStartup(service, created.objectiveId);
  const planned = await service.getObjective(created.objectiveId);
  const tasks = planned.tasks.map((task) => ({ taskId: task.taskId, dependsOn: task.dependsOn }));
  expect(tasks).toEqual([
    { taskId: "task_01", dependsOn: [] },
    { taskId: "task_02", dependsOn: ["task_01"] },
    { taskId: "task_03", dependsOn: ["task_02", "task_01"] },
  ]);
  expect(planned.policy.concurrency.maxActiveTasks).toBe(4);
  expect(planned.repoProfile.status).toBe("ready");
});

test("factory decomposition: search-only discovery steps collapse into implementation tasks", async () => {
  const dataDir = await createTempDir("receipt-factory-collapse-discovery");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const llmStructured = async <Schema extends ZodTypeAny>(opts: {
    readonly schemaName: string;
    readonly schema: Schema;
  }): Promise<{ readonly parsed: ZodInfer<Schema>; readonly raw: string }> => {
    const payload = {
      tasks: [
        {
          title: "Locate the /factory header link source",
          prompt: "Search the codebase to identify where the /factory page renders the legacy header link and record the exact file path.",
          workerType: "codex",
          dependsOn: [],
        },
        {
          title: "Remove the legacy header link from /factory",
          prompt: "Edit the Factory page so the legacy header link is no longer rendered.",
          workerType: "codex",
          dependsOn: ["task_01"],
        },
        {
          title: "Verify the /factory page still renders cleanly",
          prompt: "Run the relevant checks and add or update coverage for the removed header link if appropriate.",
          workerType: "codex",
          dependsOn: ["task_02"],
        },
      ],
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
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    llmStructured,
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Collapse search-only decomposition",
    prompt: "Remove the legacy header link from the /factory page.",
    checks: ["git status --short"],
  });
  expect(created.phase).toBe("preparing_repo");

  await runObjectiveStartup(service, created.objectiveId);
  const planned = await service.getObjective(created.objectiveId);
  const tasks = planned.tasks.map((task) => ({ title: task.title, dependsOn: task.dependsOn }));
  expect(tasks).toEqual([
    { title: "Remove the legacy header link from /factory", dependsOn: [] },
    { title: "Verify the /factory page still renders cleanly", dependsOn: ["task_01"] },
  ]);
});

test("factory shell: hub shortcut link is not rendered", () => {
  const markup = factoryShell({
    composeIsland: '<section id="factory-compose"></section>',
    boardIsland: '<section id="factory-board"></section>',
    objectiveIsland: '<section id="factory-objective"></section>',
    liveIsland: '<section id="factory-live"></section>',
    debugIsland: '<section id="factory-debug"></section>',
  });

  expect(markup).not.toMatch(/Open Hub/);
  expect(markup).not.toMatch(/href="\/hub"/);
});

test("factory shell: objective detail lists use responsive grid layout", () => {
  const markup = factoryShell({
    composeIsland: '<section id="factory-compose"></section>',
    boardIsland: '<section id="factory-board"></section>',
    objectiveIsland: '<section id="factory-objective"></section>',
    liveIsland: '<section id="factory-live"></section>',
    debugIsland: '<section id="factory-debug"></section>',
  });

  expect(markup).toMatch(/\.factory-app \{\s*min-height: 100vh;\s*display: grid;\s*grid-template-columns: minmax\(280px, 340px\) minmax\(0, 1fr\) minmax\(320px, 380px\);/);
  expect(markup).toMatch(/\.factory-task-grid/);
  expect(markup).toMatch(/@media \(max-width: 1480px\) \{\s*\.factory-app \{\s*grid-template-columns: 300px minmax\(0, 1fr\);/);
  expect(markup).toMatch(/@media \(max-width: 1080px\) \{\s*\.factory-app \{\s*grid-template-columns: 1fr;/);
});

test("factory objective island: blocked reasons are surfaced prominently", () => {
  const markup = factoryObjectiveIsland({
    objectiveId: "objective_demo",
    title: "Blocked objective",
    status: "blocked",
    archivedAt: undefined,
    updatedAt: 10,
    latestSummary: "Blocked while waiting on a diff-producing task.",
    blockedReason: "factory task produced no tracked diff: located the file but changed nothing",
    phase: "blocked",
    scheduler: { slotState: "active" },
    repoProfile: {
      status: "ready",
      inferredChecks: ["npm run build"],
      generatedSkillRefs: [],
      summary: "Repo profile ready.",
    },
    blockedExplanation: {
      summary: "factory task produced no tracked diff: located the file but changed nothing",
      taskId: "task_01",
      receiptType: "task.blocked",
      receiptHash: "hash_01",
    },
    latestDecision: undefined,
    nextAction: "Review the blocking receipt and react or cancel the objective.",
    activeTaskCount: 0,
    readyTaskCount: 0,
    taskCount: 1,
    integrationStatus: "idle",
    latestCommitHash: undefined,
    prompt: "Remove the legacy header link from /factory.",
    channel: "results",
    baseHash: "abc1234",
    checks: ["npm run build"],
    policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
    budgetState: {
      taskRunsUsed: 1,
      candidatePassesByTask: {},
      reconciliationTasksUsed: 0,
      elapsedMinutes: 1,
      lastMutationAt: undefined,
      lastDispatchAt: 10,
      policyBlockedReason: undefined,
    },
    createdAt: 1,
    tasks: [{
      nodeId: "task_01",
      taskId: "task_01",
      taskKind: "planned",
      title: "Locate the header link source",
      prompt: "Search the repo and record the file path.",
      workerType: "codex",
      baseCommit: "abc1234",
      dependsOn: [],
      status: "blocked",
      skillBundlePaths: [],
      contextRefs: [],
      artifactRefs: {},
      createdAt: 1,
      completedAt: 10,
      blockedReason: "factory task produced no tracked diff: located the file but changed nothing",
      workspaceExists: false,
      workspaceDirty: false,
    }],
    candidates: [],
    integration: {
      status: "idle",
      queuedCandidateIds: [],
      validationResults: [],
      updatedAt: 10,
    },
    recentReceipts: [{
      type: "task.blocked",
      hash: "hash_01",
      ts: 10,
      summary: "factory task produced no tracked diff: located the file but changed nothing",
      taskId: "task_01",
    }],
    evidenceCards: [{
      kind: "blocked",
      title: "Blocked or conflicted",
      summary: "factory task produced no tracked diff: located the file but changed nothing",
      at: 10,
      taskId: "task_01",
      receiptHash: "hash_01",
      receiptType: "task.blocked",
    }],
    activity: [],
    latestRebracket: undefined,
  });

  expect(markup).toMatch(/Why blocked/);
  expect(markup).toMatch(/factory task produced no tracked diff/);
  expect(markup).toMatch(/href="#receipt-hash_01"/);
});

test("factory objective island: tasks and candidates render inside isolated list containers", () => {
  const markup = factoryObjectiveIsland({
    objectiveId: "objective_demo",
    title: "Responsive task cards",
    status: "active",
    archivedAt: undefined,
    updatedAt: 10,
    latestSummary: "Task cards wrap correctly.",
    blockedReason: undefined,
    phase: "executing",
    scheduler: { slotState: "active" },
    repoProfile: {
      status: "ready",
      inferredChecks: ["npm run build"],
      generatedSkillRefs: [],
      summary: "Repo profile ready.",
    },
    blockedExplanation: undefined,
    latestDecision: undefined,
    nextAction: "One task is ready to dispatch.",
    activeTaskCount: 1,
    readyTaskCount: 1,
    taskCount: 1,
    integrationStatus: "idle",
    latestCommitHash: "abc12345",
    prompt: "Verify task card spacing.",
    channel: "results",
    baseHash: "abc1234",
    checks: ["npm run build"],
    policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
    budgetState: {
      taskRunsUsed: 1,
      candidatePassesByTask: {},
      reconciliationTasksUsed: 0,
      elapsedMinutes: 1,
      lastMutationAt: undefined,
      lastDispatchAt: 10,
      policyBlockedReason: undefined,
    },
    createdAt: 1,
    tasks: [{
      nodeId: "task_01",
      taskId: "task_01",
      taskKind: "planned",
      title: "Task title with enough length to wrap across lines without colliding with the next card.",
      prompt: "Adjust layout classes.",
      workerType: "codex",
      baseCommit: "abc1234",
      dependsOn: [],
      status: "ready",
      skillBundlePaths: [],
      contextRefs: [],
      artifactRefs: {},
      createdAt: 1,
      completedAt: undefined,
      blockedReason: undefined,
      workspaceExists: true,
      workspaceDirty: false,
      latestSummary: "Longer task summary content lives inside the task card list container.",
      candidateId: "candidate_01",
      jobStatus: "queued",
      elapsedMs: 1_500,
      sourceTaskId: undefined,
    }],
    candidates: [],
    integration: {
      status: "idle",
      queuedCandidateIds: [],
      validationResults: [],
      updatedAt: 10,
    },
    recentReceipts: [],
    evidenceCards: [],
    activity: [],
    latestRebracket: undefined,
  });

  expect(markup).toMatch(/class="factory-task-grid"/);
  expect(markup).toMatch(/Task title with enough length to wrap across lines/);
  expect(markup).toMatch(/class="factory-candidate-grid">\s*<div class="factory-empty">No candidates yet\.<\/div>/);
});
