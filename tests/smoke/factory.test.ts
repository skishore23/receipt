import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Hono } from "hono";
import type { ZodTypeAny, infer as ZodInfer } from "zod";

import { fold } from "../../src/core/chain.ts";
import { receipt } from "../../src/core/chain.ts";
import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import { jsonlQueue, type QueueJob } from "../../src/adapters/jsonl-queue.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import { SseHub } from "../../src/framework/sse-hub.ts";
import type { AgentLoaderContext } from "../../src/framework/agent-types.ts";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job.ts";
import {
  buildFactoryProjection,
  DEFAULT_FACTORY_OBJECTIVE_POLICY,
  reduceFactory,
  initialFactoryState,
  type FactoryEvent,
} from "../../src/modules/factory.ts";
import type { AgentEvent } from "../../src/modules/agent.ts";
import createFactoryRoute, { buildChatItemsForRun } from "../../src/agents/factory.agent.ts";
import { FactoryService } from "../../src/services/factory-service.ts";
import { factoryChatIsland, factoryChatShell, factoryInspectorIsland, factorySidebarIsland } from "../../src/views/factory-chat.ts";
import {
  factoryMissionControlShell,
  factoryMissionMainIsland,
  type FactoryMissionShellModel,
} from "../../src/views/factory-mission-control.ts";
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

const createRouteTestApp = (overrides?: {
  readonly liveOutput?: Record<string, unknown>;
}): Hono => {
  const dummyRuntime = {
    execute: async () => [],
    state: async () => ({}),
    stateAt: async () => ({}),
    chain: async () => [],
    chainAt: async () => [],
    verify: async () => ({ ok: true, count: 0 }),
    fork: async (streamKey: string) => ({ name: streamKey, createdAt: Date.now() }),
    branch: async () => undefined,
    branches: async () => [],
    children: async () => [],
  };
  const dummyQueue = {
    enqueue: async () => ({ id: "job", status: "queued", commands: [] }),
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => ({ id: "cmd" }),
    consumeCommands: async () => [],
    getJob: async () => undefined,
    listJobs: async () => [],
    waitForJob: async () => undefined,
  };
  const stubService = {
    git: { repoRoot: process.cwd() },
    ensureBootstrap: async () => undefined,
    buildBoardProjection: async (selectedObjectiveId?: string) => ({
      objectives: [],
      sections: {
        needs_attention: [],
        active: [],
        queued: [],
        completed: [],
      },
      selectedObjectiveId,
    }),
    listObjectives: async () => [],
    getObjectiveLiveOutput: async () => overrides?.liveOutput,
  };
  const ctx: AgentLoaderContext = {
    dataDir: "data",
    sse: {
      publish: () => {},
      publishData: () => {},
      subscribe: () => new Response(""),
      subscribeMany: () => new Response(""),
    } as AgentLoaderContext["sse"],
    llmText: async () => "",
    enqueueJob: async () => {},
    queue: dummyQueue as AgentLoaderContext["queue"],
    jobRuntime: dummyRuntime as AgentLoaderContext["jobRuntime"],
    runtimes: {
      todo: dummyRuntime,
      theorem: dummyRuntime,
      "axiom-simple": dummyRuntime,
      writer: dummyRuntime,
      agent: dummyRuntime,
      axiom: dummyRuntime,
      inspector: dummyRuntime,
      selfImprovement: dummyRuntime,
      memory: dummyRuntime,
    },
    prompts: {
      theorem: {},
      writer: {},
      inspector: {},
      agent: {},
      axiom: {},
    },
    promptHashes: {
      theorem: "",
      writer: "",
      inspector: "",
      agent: "",
      axiom: "",
    },
    promptPaths: {
      theorem: "",
      writer: "",
      inspector: "",
      agent: "",
      axiom: "",
    },
    models: {
      theorem: "",
      writer: "",
      inspector: "",
      agent: "",
      axiom: "",
    },
    helpers: {
      factoryService: stubService as unknown as FactoryService,
      profileRoot: process.cwd(),
    },
  };
  const app = new Hono();
  createFactoryRoute(ctx).register(app);
  return app;
};

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

test("factory service: objective control jobs use a dedicated worker id so /factory chat jobs are not hijacked", async () => {
  const dataDir = await createTempDir("receipt-factory-control-worker");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  await service.createObjective({
    title: "Control worker isolation",
    prompt: "Make sure objective control does not reuse the factory chat worker id.",
    checks: ["git status --short"],
  });

  const jobs = await queue.listJobs({ limit: 10 });
  expect(jobs[0]?.agentId).toBe("factory-control");
  expect(jobs[0]?.payload.kind).toBe("factory.objective.control");
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

test("factory shell: renders chat surface on /factory with thread-aware links", () => {
  const markup = factoryChatShell({
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    objectiveId: "objective_demo",
    runId: "run_01",
    jobId: "job_01",
    chat: {
      activeProfileId: "generalist",
      activeProfileLabel: "Generalist",
      items: [],
    },
    sidebar: {
      activeProfileId: "generalist",
      activeProfileLabel: "Generalist",
      activeProfileTools: ["codex.run", "bash", "grep", "read", "write", "agent.status", "agent.inspect", "factory.dispatch"],
      profiles: [{ id: "generalist", label: "Generalist", selected: true }],
      objectives: [],
      jobs: [],
    },
  });

  expect(markup).toMatch(/Chat with/);
  expect(markup).toMatch(/Generalist/);
  expect(markup).toMatch(/href="\/assets\/factory\.css"/);
  expect(markup).toMatch(/id="factory-chat"/);
  expect(markup).toMatch(/id="factory-sidebar"/);
  expect(markup).toMatch(/id="factory-inspector"/);
  expect(markup).toMatch(/new EventSource\("\/factory\/events\?profile=/);
  expect(markup).toMatch(/>Chat</);
  expect(markup).toMatch(/>Thread</);
  expect(markup).toMatch(/Work Details/);
  expect(markup).toMatch(/Blank Chat/);
  expect(markup).toMatch(/factory-run-started/);
  expect(markup).toMatch(/Message Factory/);
  expect(markup).toMatch(/Messages, runs, and recent jobs in this view stay scoped to the current thread\./);
  expect(markup).toMatch(/action="\/factory\/run"/);
  expect(markup).toMatch(/href="\/factory\/control\?objective=objective_demo"/);
  expect(markup).toMatch(/data-run="run_01"/);
  expect(markup).toMatch(/data-job="job_01"/);
  expect(markup).toMatch(/\/factory\/island\/chat\?profile=generalist&objective=objective_demo&run=run_01&job=job_01/);
  expect(markup).not.toMatch(/id="factory-board"/);
  expect(markup).not.toMatch(/id="factory-stream"/);
  expect(markup).not.toMatch(/id="factory-context"/);
  expect(markup).not.toMatch(/href="\/hub"/);
});

test("factory work details shell: renders the advanced /factory/control surface", () => {
  const model: FactoryMissionShellModel = {
    objectiveId: undefined,
    panel: "overview",
    focusKind: "mission",
    focusId: undefined,
    objectives: [],
    sections: {
      needs_attention: [],
      active: [],
      queued: [],
      completed: [],
    },
  };
  const markup = factoryMissionControlShell(model);

  expect(markup).toMatch(/Work Details/);
  expect(markup).toMatch(/id="factory-mission-main"/);
  expect(markup).toMatch(/id="factory-mission-rail"/);
  expect(markup).toMatch(/id="factory-mission-inspector"/);
  expect(markup).toMatch(/new EventSource\("\/factory\/control\/events/);
  expect(markup).toMatch(/>Chat</);
  expect(markup).toMatch(/No thread selected/);
  expect(markup).not.toMatch(/id="factory-chat"/);
  expect(markup).not.toMatch(/Chat with/);
});

test("factory work details shell: selected thread exposes the thread return path", () => {
  const markup = factoryMissionControlShell({
    objectiveId: "objective_demo",
    panel: "overview",
    focusKind: "mission",
    focusId: undefined,
    objectives: [],
    sections: {
      needs_attention: [],
      active: [],
      queued: [],
      completed: [],
    },
    selected: {
      objectiveId: "objective_demo",
      title: "Unify Factory UI",
      status: "executing",
      phase: "executing",
      prompt: "Split mission control from chat.",
      slotState: "active",
      activeTaskCount: 1,
      readyTaskCount: 1,
      taskCount: 2,
      checks: ["bun test"],
      budgetElapsedMinutes: 3,
      budgetMaxMinutes: 60,
      taskRunsUsed: 1,
      taskRunsMax: 8,
      tasks: [],
      runs: [],
      jobs: [],
      recentReceipts: [],
      debugLink: "/factory/api/objectives/objective_demo/debug",
      receiptsLink: "/factory/api/objectives/objective_demo/receipts?limit=50",
      chatLink: "/factory?objective=objective_demo",
      activeJobCount: 1,
      recentJobCount: 1,
      contextPackCount: 1,
      worktreeCount: 1,
      focus: {
        kind: "mission",
        objectiveId: "objective_demo",
        title: "Unify Factory UI",
        status: "executing",
        phase: "executing",
        debugLink: "/factory/api/objectives/objective_demo/debug",
        receiptsLink: "/factory/api/objectives/objective_demo/receipts?limit=50",
        checks: ["bun test"],
        budgetElapsedMinutes: 3,
        budgetMaxMinutes: 60,
        taskRunsUsed: 1,
        taskRunsMax: 8,
      },
    },
  });

  expect(markup).toMatch(/Back to Thread/);
  expect(markup).toMatch(/>Thread</);
  expect(markup).toMatch(/>Work Details</);
  expect(markup).not.toMatch(/New Objective/);
});

test("factory mission main island: execution links keep objective selection in place", () => {
  const markup = factoryMissionMainIsland({
    objectiveId: "objective_demo",
    panel: "execution",
    focusKind: "mission",
    focusId: undefined,
    objectives: [],
    sections: {
      needs_attention: [],
      active: [],
      queued: [],
      completed: [],
    },
    selected: {
      objectiveId: "objective_demo",
      title: "Unify Factory UI",
      status: "executing",
      phase: "executing",
      prompt: "Split mission control from chat.",
      slotState: "active",
      activeTaskCount: 1,
      readyTaskCount: 1,
      taskCount: 2,
      checks: ["bun test"],
      budgetElapsedMinutes: 3,
      budgetMaxMinutes: 60,
      taskRunsUsed: 1,
      taskRunsMax: 8,
      tasks: [{
        taskId: "task_01",
        title: "Implement mission shell",
        workerType: "codex",
        status: "running",
        workspaceExists: true,
        workspaceDirty: true,
        selected: false,
        controlLink: "/factory/control?objective=objective_demo&panel=execution&focusKind=task&focusId=task_01",
      }],
      runs: [{
        focusId: "generalist:run_01",
        runId: "run_01",
        profileId: "generalist",
        profileLabel: "Generalist",
        status: "running",
        summary: "Inspecting the mission shell.",
        selected: false,
        chatLink: "/factory?profile=generalist&objective=objective_demo&run=run_01",
        controlLink: "/factory/control?objective=objective_demo&panel=execution&focusKind=run&focusId=generalist%3Arun_01",
        previewLines: ["Inspecting the mission shell."],
      }],
      jobs: [{
        jobId: "job_01",
        agentId: "factory-codex",
        status: "running",
        summary: "Applying the shell patch.",
        selected: false,
        controlLink: "/factory/control?objective=objective_demo&panel=execution&focusKind=job&focusId=job_01",
        rawLink: "/jobs/job_01",
      }],
      recentReceipts: [],
      debugLink: "/factory/api/objectives/objective_demo/debug",
      receiptsLink: "/factory/api/objectives/objective_demo/receipts?limit=50",
      chatLink: "/factory?objective=objective_demo",
      activeJobCount: 1,
      recentJobCount: 1,
      contextPackCount: 1,
      worktreeCount: 1,
      focus: {
        kind: "mission",
        objectiveId: "objective_demo",
        title: "Unify Factory UI",
        status: "executing",
        phase: "executing",
        debugLink: "/factory/api/objectives/objective_demo/debug",
        receiptsLink: "/factory/api/objectives/objective_demo/receipts?limit=50",
        checks: ["bun test"],
        budgetElapsedMinutes: 3,
        budgetMaxMinutes: 60,
        taskRunsUsed: 1,
        taskRunsMax: 8,
      },
    },
  });

  expect(markup).toMatch(/focusKind=task&amp;focusId=task_01/);
  expect(markup).toMatch(/focusKind=run&amp;focusId=generalist%3Arun_01/);
  expect(markup).toMatch(/focusKind=job&amp;focusId=job_01/);
  expect(markup).toMatch(/Open run thread/);
});

test("factory chat island: renders chat rows and work cards", () => {
  const markup = factoryChatIsland({
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    items: [
      {
        key: "u1",
        kind: "user",
        body: "Ship the profile-driven Factory UI.",
        meta: "Run run_01 · completed",
      },
      {
        key: "w1",
        kind: "work",
        card: {
          key: "codex-1",
          title: "Codex run",
          worker: "codex",
          status: "running",
          summary: "Investigating the route swap.",
          detail: "stdout tail",
          jobId: "job_01",
          running: true,
        },
      },
      {
        key: "a1",
        kind: "assistant",
        body: "I replaced the old `/factory` dashboard with a chat shell and kept the objective APIs intact.",
        meta: "completed",
      },
    ],
  });

  expect(markup).toMatch(/Ship the profile-driven Factory UI/);
  expect(markup).toMatch(/Codex run/);
  expect(markup).toMatch(/job_01/);
  expect(markup).toMatch(/Abort/);
  expect(markup).toMatch(/Selected profile/);
  expect(markup).toMatch(/replaced the old <code>\/factory<\/code> dashboard/);
});

test("factory chat items: budget stops show the codex child state instead of a stale generic stop message", () => {
  const runStream = "agents/factory/demo/runs/run_live";
  let prev: string | undefined;
  const push = (body: AgentEvent, index: number) => {
    const next = receipt(runStream, prev, body, index);
    prev = next.hash;
    return next;
  };
  const chain = [
    push({
      type: "problem.set",
      runId: "run_live",
      problem: "Fix the sidebar overflow.",
      agentId: "orchestrator",
    }, 1),
    push({
      type: "subagent.merged",
      runId: "run_live",
      agentId: "orchestrator",
      subJobId: "job_codex_01",
      subRunId: "job_codex_01",
      task: "Fix sidebar overflow.",
      summary: "codex is still applying the class-string changes",
    }, 2),
    push({
      type: "failure.report",
      runId: "run_live",
      agentId: "orchestrator",
      failure: {
        stage: "budget",
        failureClass: "iteration_budget_exhausted",
        message: "iteration budget exhausted (8)",
        retryable: true,
      },
    }, 3),
    push({
      type: "run.status",
      runId: "run_live",
      agentId: "orchestrator",
      status: "failed",
      note: "iteration budget exhausted (8)",
    }, 4),
    push({
      type: "response.finalized",
      runId: "run_live",
      agentId: "orchestrator",
      content: "Stopped after hitting max iterations. Use steer/follow-up to continue.",
    }, 5),
  ];

  const childJob: QueueJob = {
    id: "job_codex_01",
    agentId: "factory-codex",
    lane: "collect",
    sessionKey: "factory-codex:demo",
    singletonMode: "allow",
    payload: {
      kind: "factory.codex.run",
      stream: "agents/factory/demo",
      task: "Fix sidebar overflow.",
    },
    status: "failed",
    attempt: 1,
    maxAttempts: 1,
    createdAt: 1,
    updatedAt: 2,
    lastError: "lease expired",
    result: {
      worker: "codex",
      status: "running",
      summary: "codex is still applying the class-string changes",
    },
    commands: [],
  };

  const items = buildChatItemsForRun("run_live", chain, new Map([[childJob.id, childJob]]));
  const paused = items.find((item) => item.kind === "system" && item.title === "Orchestrator paused");
  expect(paused && paused.kind === "system" ? paused.body : "").toContain("lease expired");

  const childCard = items.find((item) => item.kind === "work" && item.card.jobId === "job_codex_01");
  expect(childCard && childCard.kind === "work" ? childCard.card.summary : "").toContain("lease expired");
});

test("factory chat items: objective creation still surfaces when the parent hits its budget right after dispatch", () => {
  const runStream = "agents/factory/demo/runs/run_objective_create";
  let prev: string | undefined;
  const push = (body: AgentEvent, index: number) => {
    const next = receipt(runStream, prev, body, index);
    prev = next.hash;
    return next;
  };
  const chain = [
    push({
      type: "problem.set",
      runId: "run_objective_create",
      problem: "Redesign the center timeline.",
      agentId: "orchestrator",
    }, 1),
    push({
      type: "tool.called",
      runId: "run_objective_create",
      iteration: 8,
      agentId: "orchestrator",
      tool: "factory.dispatch",
      input: {
        action: "create",
        title: "Redesign center timeline",
        prompt: "Create an objective for the center timeline redesign.",
      },
      summary: "Preparing the repo profile and generated skill bundle.",
      durationMs: 400,
    }, 2),
    push({
      type: "tool.observed",
      runId: "run_objective_create",
      iteration: 8,
      agentId: "orchestrator",
      tool: "factory.dispatch",
      output: JSON.stringify({
        worker: "factory",
        action: "create",
        objectiveId: "objective_demo",
        title: "Redesign center timeline",
        status: "decomposing",
        phase: "preparing_repo",
        summary: "Preparing the repo profile and generated skill bundle.",
        link: "/factory?objective=objective_demo",
      }),
      truncated: false,
    }, 3),
    push({
      type: "failure.report",
      runId: "run_objective_create",
      agentId: "orchestrator",
      failure: {
        stage: "budget",
        failureClass: "iteration_budget_exhausted",
        message: "iteration budget exhausted (8)",
        retryable: true,
      },
    }, 4),
    push({
      type: "run.status",
      runId: "run_objective_create",
      agentId: "orchestrator",
      status: "failed",
      note: "iteration budget exhausted (8)",
    }, 5),
    push({
      type: "response.finalized",
      runId: "run_objective_create",
      agentId: "orchestrator",
      content: "Stopped after hitting max iterations. Use steer/follow-up to continue.",
    }, 6),
  ];

  const items = buildChatItemsForRun("run_objective_create", chain, new Map());
  const objectiveCard = items.find((item) => item.kind === "work" && item.card.objectiveId === "objective_demo");
  expect(objectiveCard && objectiveCard.kind === "work" ? objectiveCard.card.title : "").toBe("Thread started");

  const objectiveStatus = items.find((item) => item.kind === "system" && item.title === "Thread continues");
  expect(objectiveStatus && objectiveStatus.kind === "system" ? objectiveStatus.body : "").toContain("The work is still decomposing.");
  expect(objectiveStatus && objectiveStatus.kind === "system" ? objectiveStatus.body : "").toContain("Preparing the repo profile and generated skill bundle.");
  expect(items.some((item) => item.kind === "assistant")).toBe(false);
});

test("factory chat items: automatic slice continuations render as live thread progress instead of a stop message", () => {
  const runStream = "agents/factory/demo/runs/run_slice_continue";
  let prev: string | undefined;
  const push = (body: AgentEvent, index: number) => {
    const next = receipt(runStream, prev, body, index);
    prev = next.hash;
    return next;
  };
  const chain = [
    push({
      type: "problem.set",
      runId: "run_slice_continue",
      problem: "Keep this thread active.",
      agentId: "orchestrator",
    }, 1),
    push({
      type: "run.continued",
      runId: "run_slice_continue",
      agentId: "orchestrator",
      nextRunId: "run_next",
      nextJobId: "job_next",
      profileId: "generalist",
      previousMaxIterations: 8,
      nextMaxIterations: 12,
      continuationDepth: 1,
      summary: "Reached the current 8-step slice. Continuing automatically in this thread as run_next with a 12-step budget.",
    }, 2),
    push({
      type: "response.finalized",
      runId: "run_slice_continue",
      agentId: "orchestrator",
      content: "Reached the current 8-step slice. Continuing automatically in this thread as run_next with a 12-step budget.\n\nLive updates will keep appearing here.",
    }, 3),
    push({
      type: "run.status",
      runId: "run_slice_continue",
      agentId: "orchestrator",
      status: "completed",
      note: "continued automatically as run_next",
    }, 4),
  ];

  const items = buildChatItemsForRun("run_slice_continue", chain, new Map());
  const continued = items.find((item) => item.kind === "system" && item.title === "Thread continues automatically");
  expect(continued && continued.kind === "system" ? continued.body : "").toContain("run_next");
  expect(continued && continued.kind === "system" ? continued.body : "").toContain("job_next");
  expect(items.some((item) => item.kind === "assistant")).toBe(false);
});

test("factory sidebar island: renders left rail navigation", () => {
  const markup = factorySidebarIsland({
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    activeProfileSummary: "Answer directly, inspect receipts, and keep delivery moving.",
    activeProfileTools: [],
    profiles: [
      {
        id: "generalist",
        label: "Generalist",
        summary: "Answer directly, inspect receipts, and keep delivery moving.",
        selected: true,
      },
      {
        id: "reviewer",
        label: "Reviewer",
        summary: "Review changes and call out concrete risks before promotion.",
        selected: false,
      },
    ],
    objectives: [{
      objectiveId: "objective_demo",
      title: "Profile-driven Factory UI",
      status: "executing",
      phase: "executing",
      summary: "Chat shell is wired to the worker path.",
      updatedAt: 10,
      selected: true,
      slotState: "active",
      activeTaskCount: 1,
      readyTaskCount: 2,
      taskCount: 5,
      integrationStatus: "executing",
    }],
    jobs: [{
      jobId: "job_01",
      agentId: "factory",
      status: "running",
      summary: "Ship the profile-driven Factory UI.",
      runId: "run_01",
      objectiveId: "objective_demo",
      updatedAt: 1000,
      link: "/factory?profile=generalist&objective=objective_demo",
    }],
    selectedObjective: {
      objectiveId: "objective_demo",
      title: "Profile-driven Factory UI",
      status: "executing",
      phase: "executing",
      summary: "Chat shell is wired to the worker path.",
      debugLink: "/factory/api/objectives/objective_demo/debug",
      receiptsLink: "/factory/api/objectives/objective_demo/receipts?limit=50",
    },
  });

  expect(markup).toMatch(/>Chat</);
  expect(markup).toMatch(/Reviewer/);
  expect(markup).toMatch(/inspect receipts, and keep delivery moving/);
  expect(markup).toMatch(/href="\/factory\?profile=reviewer&objective=objective_demo"/);
  expect(markup).toMatch(/Profile-driven Factory UI/);
  expect(markup).toMatch(/Threads/);
  expect(markup).toMatch(/integration executing/);
  expect(markup).toMatch(/1 active/);
  expect(markup).not.toMatch(/Recent Thread/);
  expect(markup).not.toMatch(/run_01/);
});

test("factory sidebar island: blank chat treats old objectives as recent threads instead of active context", () => {
  const markup = factorySidebarIsland({
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    activeProfileSummary: "Answer directly, inspect receipts, and keep delivery moving.",
    activeProfileTools: [],
    profiles: [
      { id: "generalist", label: "Generalist", summary: "Answer directly, inspect receipts, and keep delivery moving.", selected: true },
    ],
    objectives: [{
      objectiveId: "objective_demo",
      title: "Profile-driven Factory UI",
      status: "executing",
      phase: "executing",
      summary: "Chat shell is wired to the worker path.",
      updatedAt: 10,
      selected: false,
      slotState: "active",
      activeTaskCount: 1,
      readyTaskCount: 2,
      taskCount: 5,
      integrationStatus: "executing",
    }],
    jobs: [],
    selectedObjective: undefined,
  });

  expect(markup).toMatch(/Recent Threads/);
  expect(markup).toMatch(/Blank chat is active/);
  expect(markup).toMatch(/Show recent threads/);
});

test("factory chat items: structured supervisor snapshots render as live child state instead of raw JSON", () => {
  const runStream = "agents/factory/demo/runs/run_structured";
  let prev: string | undefined;
  const push = (body: AgentEvent, index: number) => {
    const next = receipt(runStream, prev, body, index);
    prev = next.hash;
    return next;
  };
  const chain = [
    push({
      type: "problem.set",
      runId: "run_structured",
      problem: "Update the chat center panel UI.",
      agentId: "orchestrator",
    }, 1),
    push({
      type: "response.finalized",
      runId: "run_structured",
      agentId: "orchestrator",
      content: JSON.stringify({
        codex: {
          jobId: "job_codex_live",
          status: "running",
          task: "Update the chat center panel UI.",
          latestNote: "Inspecting src/views/factory-chat.ts.",
        },
        otherRelevant: {
          layoutFixJob: {
            jobId: "job_layout_done",
            status: "completed",
            result: "Stopped after hitting max iterations (8); no files changed.",
          },
        },
      }),
    }, 2),
  ];

  const childJob: QueueJob = {
    id: "job_codex_live",
    agentId: "factory-codex",
    lane: "collect",
    sessionKey: "factory-codex:demo",
    singletonMode: "allow",
    payload: {
      kind: "factory.codex.run",
      stream: "agents/factory/demo",
      task: "Update the chat center panel UI.",
    },
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    createdAt: 1,
    updatedAt: 2,
    result: {
      worker: "codex",
      status: "running",
      summary: "Inspecting src/views/factory-chat.ts.",
    },
    commands: [],
  };

  const items = buildChatItemsForRun("run_structured", chain, new Map([[childJob.id, childJob]]));
  const waiting = items.find((item) => item.kind === "system" && item.title === "Supervisor waiting on child");
  expect(waiting && waiting.kind === "system" ? waiting.body : "").toContain("job_codex_live is running");
  expect(waiting && waiting.kind === "system" ? waiting.body : "").toContain("layoutFixJob: job_layout_done is completed");

  const childCard = items.find((item) => item.kind === "work" && item.card.jobId === "job_codex_live");
  expect(childCard && childCard.kind === "work" ? childCard.card.summary : "").toContain("Inspecting src/views/factory-chat.ts.");
  expect(items.some((item) => item.kind === "assistant")).toBe(false);
});

test("factory sidebar island: humanizes objective slot labels and avoids repeating status in the compact meta row", () => {
  const markup = factorySidebarIsland({
    activeProfileId: "software",
    activeProfileLabel: "Software",
    activeProfileTools: [],
    profiles: [
      { id: "generalist", label: "Generalist", selected: false },
      { id: "software", label: "Software", selected: true },
    ],
    objectives: [{
      objectiveId: "objective_waiting",
      title: "Fix iteration-3 issue",
      status: "decomposing",
      phase: "queued",
      summary: "Waiting for the repo execution slot (1 in queue).",
      updatedAt: 10,
      selected: true,
      slotState: "waiting_for_slot",
      activeTaskCount: 0,
      readyTaskCount: 0,
      taskCount: 2,
      integrationStatus: "queued",
    }],
    jobs: [],
    selectedObjective: {
      objectiveId: "objective_waiting",
      title: "Fix iteration-3 issue",
      status: "decomposing",
      phase: "queued",
      summary: "Waiting for the repo execution slot (1 in queue).",
      debugLink: "/factory/api/objectives/objective_waiting/debug",
      receiptsLink: "/factory/api/objectives/objective_waiting/receipts?limit=50",
    },
  });

  expect(markup).toMatch(/slot waiting for slot/);
  expect(markup).toMatch(/phase queued/);
  expect(markup).not.toMatch(/decomposing · queued · waiting_for_slot/);
});

test("factory inspector island: renders selected objective controls and recent jobs", () => {
  const longJobId = "job_with_a_name_that_used_to_force_the_recent_jobs_card_past_the_inspector_width_when_it_rendered";
  const codexJobId = "job_codex_live_panel";
  const markup = factoryInspectorIsland({
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    activeProfileTools: ["codex.run", "bash", "agent.status", "factory.dispatch"],
    profiles: [
      { id: "generalist", label: "Generalist", selected: true },
      { id: "reviewer", label: "Reviewer", selected: false },
    ],
    objectives: [{
      objectiveId: "objective_demo",
      title: "Profile-driven Factory UI",
      status: "executing",
      phase: "executing",
      summary: "Chat shell is wired to the worker path.",
      updatedAt: 10,
      selected: true,
      slotState: "active",
    }],
    jobs: [{
      jobId: codexJobId,
      agentId: "factory-codex",
      status: "running",
      summary: "Applying the latest profile summary UI patch.",
      runId: "run_codex_01",
      objectiveId: "objective_demo",
      updatedAt: 999,
    }, {
      jobId: longJobId,
      agentId: "factory-agent-with-an-overly-verbose-name-for-overflow-repro",
      status: "running",
      summary: "Ship the profile-driven Factory UI while keeping recent-job cards inside the inspector rail even when a summary contains_a_single_unbroken_token_that_is_much_longer_than_the_available_width.",
      runId: "run_01",
      objectiveId: "objective_demo",
      updatedAt: 1000,
      link: "/factory?profile=generalist&objective=objective_demo",
    }],
    selectedObjective: {
      objectiveId: "objective_demo",
      title: "Profile-driven Factory UI",
      status: "executing",
      phase: "executing",
      summary: "Chat shell is wired to the worker path.",
      debugLink: "/factory/api/objectives/objective_demo/debug",
      receiptsLink: "/factory/api/objectives/objective_demo/receipts?limit=50",
      nextAction: "Run the next codex candidate.",
      slotState: "active",
      integrationStatus: "executing",
      activeTaskCount: 1,
      readyTaskCount: 2,
      taskCount: 5,
      repoProfileStatus: "ready",
      latestCommitHash: "1234567890abcdef",
      checks: ["bun test"],
      latestDecisionSummary: "Keep working the current branch.",
      latestDecisionAt: 2000,
    },
    activeCodex: {
      jobId: codexJobId,
      status: "running",
      summary: "Applying the latest profile summary UI patch.",
      latestNote: "Inspecting src/views/factory-chat.ts and refreshing the right rail.",
      stderrTail: "updated inspector panel",
      stdoutTail: "build ok",
      runId: "run_parent_01",
      task: "Patch the right rail to show live Codex progress.",
      updatedAt: 3000,
      rawLink: `/jobs/${codexJobId}`,
      running: true,
    },
  });

  expect(markup).toMatch(/Codex worker/);
  expect(markup).toMatch(/Thread details/);
  expect(markup).toMatch(/Selected profile/);
  expect(markup).toMatch(/Tools in scope/);
  expect(markup).toMatch(/Codex/);
  expect(markup).toMatch(/Shell/);
  expect(markup).toMatch(/Status/);
  expect(markup).toMatch(/Dispatch/);
  expect(markup).toMatch(/Work Details/);
  expect(markup).toMatch(/Debug JSON/);
  expect(markup).toMatch(/Receipts/);
  expect(markup).toMatch(/Keep working/);
  expect(markup).toMatch(/Promote to source/);
  expect(markup).toMatch(/Remove worktrees/);
  expect(markup).toMatch(/Stop thread/);
  expect(markup).toMatch(/Archive thread/);
  expect(markup).toMatch(/Latest decision/);
  expect(markup).toMatch(/Latest child/);
  expect(markup).toMatch(/Patch the right rail to show live Codex progress/);
  expect(markup).toMatch(/Inspecting src\/views\/factory-chat.ts and refreshing the right rail/);
  expect(markup).toMatch(/stderr tail/);
  expect(markup).toMatch(/Job JSON/);
  expect(markup).toMatch(/Run run_01/);
  expect(markup).toContain(longJobId);
  expect(markup).toMatch(/Recent jobs[\s\S]*?>1<\/div>/);
  expect(markup).toMatch(/Open thread/);
  expect(markup).toMatch(/Ship the profile-driven Factory UI/);
  expect(markup).toMatch(/factory-inspector-panel|factory-job-panel/);
  expect(markup).toMatch(/factory-job-list/);
  expect(markup).toMatch(/factory-job-card__title/);
  expect(markup).toMatch(/factory-job-card__summary/);
});

test("factory route: /factory renders chat, /factory/chat redirects, and /factory/control renders work details", async () => {
  const app = createRouteTestApp();

  const chat = await app.request("http://receipt.test/factory?profile=generalist&run=run_01&job=job_01");
  const chatMarkup = await chat.text();
  expect(chat.status).toBe(200);
  expect(chatMarkup).toMatch(/Chat with/);
  expect(chatMarkup).toMatch(/data-run="run_01"/);
  expect(chatMarkup).toMatch(/data-job="job_01"/);
  expect(chatMarkup).toMatch(/\/factory\/island\/chat\?profile=generalist&run=run_01&job=job_01/);
  expect(chatMarkup).not.toMatch(/id="factory-mission-main"/);

  const redirect = await app.request("http://receipt.test/factory/chat?profile=generalist&run=run_01&job=job_01");
  expect(redirect.status).toBe(303);
  expect(redirect.headers.get("location")).toBe("/factory?profile=generalist&run=run_01&job=job_01");

  const control = await app.request("http://receipt.test/factory/control");
  const controlMarkup = await control.text();
  expect(control.status).toBe(200);
  expect(controlMarkup).toMatch(/Work Details/);
  expect(controlMarkup).toMatch(/id="factory-mission-main"/);
  expect(controlMarkup).not.toMatch(/id="factory-chat"/);
});

test("factory route: live output API returns the focused snapshot", async () => {
  const app = createRouteTestApp({
    liveOutput: {
      objectiveId: "objective_demo",
      focusKind: "task",
      focusId: "task_01",
      title: "Implement mission shell",
      status: "running",
      active: true,
      summary: "Applying the mission shell patch.",
      lastMessage: "Wiring the new live output endpoint.",
      stdoutTail: "build ok",
      stderrTail: "",
    },
  });

  const response = await app.request("http://receipt.test/factory/api/live-output?objective=objective_demo&focusKind=task&focusId=task_01");
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    liveOutput: {
      objectiveId: "objective_demo",
      focusKind: "task",
      focusId: "task_01",
      title: "Implement mission shell",
      status: "running",
      active: true,
      summary: "Applying the mission shell patch.",
      lastMessage: "Wiring the new live output endpoint.",
      stdoutTail: "build ok",
      stderrTail: "",
    },
  });
});

test("factory service: objective-scoped factory SSE topic publishes on receipt append", async () => {
  const dataDir = await createTempDir("receipt-factory-sse");
  const repoRoot = await createSourceRepo();
  const hub = new SseHub();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: hub,
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Mission SSE",
    prompt: "Confirm mission refresh events publish on objective changes.",
    checks: ["git status --short"],
  });
  const abort = new AbortController();
  const response = hub.subscribe("factory", created.objectiveId, abort.signal);
  const reader = response.body?.getReader();
  expect(reader).toBeTruthy();
  const streamReader = reader!;

  await streamReader.read(); // init
  await service.addObjectiveNote(created.objectiveId, "operator note");
  const published = await streamReader.read();
  const chunk = published.done || !published.value ? "" : new TextDecoder().decode(published.value);
  expect(chunk).toMatch(/event: factory-refresh/);

  abort.abort();
  await streamReader.cancel();
});
