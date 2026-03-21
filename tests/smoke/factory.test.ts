import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Hono } from "hono";
import type { ZodTypeAny, infer as ZodInfer } from "zod";

import { fold } from "@receipt/core/chain";
import { receipt } from "@receipt/core/chain";
import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { jsonlQueue, type QueueJob } from "../../src/adapters/jsonl-queue";
import { createRuntime } from "@receipt/core/runtime";
import { SseHub } from "../../src/framework/sse-hub";
import type { AgentLoaderContext } from "../../src/framework/agent-types";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";
import {
  buildFactoryProjection,
  DEFAULT_FACTORY_OBJECTIVE_PROFILE,
  DEFAULT_FACTORY_OBJECTIVE_POLICY,
  reduceFactory,
  initialFactoryState,
  type FactoryEvent,
} from "../../src/modules/factory";
import type { AgentEvent } from "../../src/modules/agent";
import createFactoryRoute, { buildActiveCodexCard, buildChatItemsForRun } from "../../src/agents/factory.agent";
import { FactoryService } from "../../src/services/factory-service";
import { factoryChatStream } from "../../src/services/factory-chat-profiles";
import { factoryChatIsland, factoryChatShell, factoryInspectorIsland, factorySidebarIsland } from "../../src/views/factory-chat";
import {
  factoryMissionControlShell,
  factoryMissionMainIsland,
  type FactoryMissionShellModel,
} from "../../src/views/factory-mission-control";
import type { BranchStore, Receipt, Store } from "@receipt/core/types";

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

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

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

const makeStubObjectiveDetail = (
  objectiveId = "objective_demo",
  jobId = "job_demo",
) => ({
  objectiveId,
  title: "Demo objective",
  status: "executing",
  phase: "executing",
  scheduler: { slotState: "active" },
  repoProfile: {
    status: "ready",
    inferredChecks: [],
    generatedSkillRefs: [],
    summary: "Repo profile ready",
  },
  updatedAt: 2,
  latestSummary: "Demo summary",
  nextAction: "Keep going.",
  activeTaskCount: 1,
  readyTaskCount: 0,
  taskCount: 1,
  integrationStatus: "idle",
  prompt: "Demo prompt",
  channel: "results",
  baseHash: "abc123",
  checks: [],
  profile: {},
  policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
  contextSources: {},
  budgetState: {},
  createdAt: 1,
  tasks: [{
    taskId: "task_01",
    title: "Demo task",
    workerType: "codex",
    status: "running",
    dependsOn: [],
    workspaceExists: true,
    workspaceDirty: false,
    jobId,
    jobStatus: "running",
  }],
  candidates: [],
  integration: { status: "idle" },
  recentReceipts: [],
  evidenceCards: [],
  activity: [],
}) as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;

const makeStubJobQueueResult = (jobId: string): { readonly job: QueueJob; readonly command: { readonly id: string } } => ({
  job: {
    id: jobId,
    agentId: "factory",
    lane: "steer",
    singletonMode: "allow",
    status: "queued",
    attempt: 1,
    maxAttempts: 1,
    createdAt: 1,
    updatedAt: 1,
    commands: [],
  } as QueueJob,
  command: { id: `cmd_${jobId}` },
});

const createRouteTestApp = (overrides?: {
  readonly liveOutput?: Record<string, unknown>;
  readonly jobs?: ReadonlyArray<QueueJob>;
  readonly onSubscribeMany?: (subscriptions: ReadonlyArray<{ readonly topic: string; readonly stream?: string }>) => void;
  readonly onEnqueue?: (input: Record<string, unknown>) => QueueJob | Promise<QueueJob>;
  readonly service?: Partial<Pick<
    FactoryService,
    | "listObjectives"
    | "getObjective"
    | "createObjective"
    | "reactObjectiveWithNote"
    | "promoteObjective"
    | "cancelObjective"
    | "cleanupObjectiveWorkspaces"
    | "archiveObjective"
  >>;
}): Hono => {
  const enqueuedJobs = new Map<string, QueueJob>();
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
  const defaultObjective = makeStubObjectiveDetail();
  const dummyQueue = {
    enqueue: async (input: Record<string, unknown>) => {
      const created = overrides?.onEnqueue
        ? await overrides.onEnqueue(input)
        : {
            id: "job_enqueued",
            agentId: String(input.agentId ?? "factory"),
            payload: (input.payload as Record<string, unknown> | undefined) ?? {},
            lane: "collect",
            status: "queued",
            attempt: 1,
            maxAttempts: 1,
            createdAt: 1,
            updatedAt: 1,
            commands: [],
          } as QueueJob;
      enqueuedJobs.set(created.id, created);
      return created;
    },
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => ({ id: "cmd" }),
    consumeCommands: async () => [],
    getJob: async (jobId: string) =>
      enqueuedJobs.get(jobId)
      ?? overrides?.jobs?.find((job) => job.id === jobId),
    listJobs: async () => [...(overrides?.jobs ?? []), ...enqueuedJobs.values()],
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
    getObjective: async () => defaultObjective,
    createObjective: async () => makeStubObjectiveDetail("objective_created", "job_created"),
    reactObjectiveWithNote: async (objectiveId: string) => makeStubObjectiveDetail(objectiveId),
    promoteObjective: async (objectiveId: string) => makeStubObjectiveDetail(objectiveId),
    cancelObjective: async (objectiveId: string) => makeStubObjectiveDetail(objectiveId),
    cleanupObjectiveWorkspaces: async (objectiveId: string) => makeStubObjectiveDetail(objectiveId),
    archiveObjective: async (objectiveId: string) => makeStubObjectiveDetail(objectiveId),
    getObjectiveLiveOutput: async () => overrides?.liveOutput,
    ...(overrides?.service ?? {}),
  };
  const ctx: AgentLoaderContext = {
    dataDir: "data",
    sse: {
      publish: () => {},
      publishData: () => {},
      subscribe: () => new Response(""),
      subscribeMany: (subscriptions) => {
        overrides?.onSubscribeMany?.(subscriptions as ReadonlyArray<{ readonly topic: string; readonly stream?: string }>);
        return new Response("");
      },
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

test("factory service: check runner resolves source-backed workspace packages without dist outputs", async () => {
  const dataDir = await createTempDir("receipt-factory-source-backed-core");
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
  const workspaceDir = await createTempDir("receipt-factory-source-backed-core-workspace");
  const bunBin = shellQuote(process.env.BUN_BIN?.trim() || "bun");

  await fs.mkdir(path.join(workspaceDir, "packages", "core", "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, "node_modules", "@receipt"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "package.json"), JSON.stringify({
    name: "source-backed-workspace",
    private: true,
    type: "module",
  }, null, 2), "utf-8");
  await fs.writeFile(path.join(workspaceDir, "packages", "core", "package.json"), JSON.stringify({
    name: "@receipt/core",
    version: "0.1.0",
    type: "module",
    exports: {
      "./runtime": "./src/runtime.ts",
    },
  }, null, 2), "utf-8");
  await fs.writeFile(
    path.join(workspaceDir, "packages", "core", "src", "runtime.ts"),
    "export const runtimeValue = 1;\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(workspaceDir, "smoke.ts"),
    [
      'import { runtimeValue } from "@receipt/core/runtime";',
      'if (runtimeValue !== 1) throw new Error(`unexpected runtime value: ${runtimeValue}`);',
      'console.log("source-backed workspace import ok");',
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.symlink(
    path.join(workspaceDir, "packages", "core"),
    path.join(workspaceDir, "node_modules", "@receipt", "core"),
    "dir",
  );

  const runChecks = (service as unknown as {
    runChecks: (commands: ReadonlyArray<string>, workspacePath: string) => Promise<ReadonlyArray<{ readonly ok: boolean }>>;
  }).runChecks.bind(service);
  const results = await runChecks([`${bunBin} smoke.ts`], workspaceDir);

  expect(results.map((result) => result.ok)).toEqual([true]);
  expect(results[0]?.stdout).toContain("source-backed workspace import ok");
  await expect(fs.access(path.join(workspaceDir, "packages", "core", "dist"))).rejects.toThrow();
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
      checks: ["bun run build"],
      checksSource: "explicit",
      profile: DEFAULT_FACTORY_OBJECTIVE_PROFILE,
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
        command: "bun run build",
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

test("factory reducer: legacy objective profile snapshots are normalized during replay", () => {
  const state = reduceFactory(initialFactoryState, {
    type: "objective.created",
    objectiveId: "objective_legacy",
    title: "Legacy objective",
    prompt: "Open an older Factory thread.",
    channel: "results",
    baseHash: "abc1234",
    checks: [],
    checksSource: "default",
    profile: {
      rootProfileId: "software",
      rootProfileLabel: "Software",
      promptPath: "profiles/software/PROFILE.md",
    } as unknown as FactoryEvent["profile"],
    policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
    createdAt: 1,
  });

  expect(state.profile.rootProfileId).toBe("software");
  expect(state.profile.rootProfileLabel).toBe("Software");
  expect(state.profile.promptPath).toBe("profiles/software/PROFILE.md");
  expect(state.profile.selectedSkills).toEqual([]);
  expect(state.profile.objectivePolicy.defaultWorkerType).toBe("codex");
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
test("factory chat island: renders chat rows and work cards", () => {
  const markup = factoryChatIsland({
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    activeProfileSummary: "Be the calm operator-facing guide for this repo.",
    activeProfileSections: [{
      title: "Operating Style",
      items: ["Sound like a clear, grounded operator.", "Prefer receipts over guessing."],
    }],
    activeProfileTools: ["factory.status", "codex.status"],
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
  expect(markup).toMatch(/Generalist/);
  expect(markup).not.toMatch(/Selected profile/);
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
    agentId: "codex",
    lane: "collect",
    sessionKey: "codex:demo",
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
      summary: "Reached the current 8-step slice. Continuing automatically in this project chat as run_next with a 12-step budget.",
    }, 2),
    push({
      type: "response.finalized",
      runId: "run_slice_continue",
      agentId: "orchestrator",
      content: "Reached the current 8-step slice. Continuing automatically in this project chat as run_next with a 12-step budget.\n\nLive updates will keep appearing here.",
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
test("factory sidebar island: limits projects to the top five and shows view all when truncated", () => {
  const markup = factorySidebarIsland({
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    activeProfileTools: [],
    profiles: [{ id: "generalist", label: "Generalist", selected: true }],
    objectives: Array.from({ length: 6 }, (_, index) => ({
      objectiveId: `objective_${index + 1}`,
      title: `Project ${index + 1}`,
      status: "queued",
      phase: "queued",
      summary: `Summary ${index + 1}`,
      updatedAt: 100 + index,
      selected: index === 0,
      slotState: "queued",
      activeTaskCount: 0,
      readyTaskCount: 0,
      taskCount: 1,
    })),
    jobs: [],
    selectedObjective: {
      objectiveId: "objective_1",
      title: "Project 1",
      status: "queued",
      phase: "queued",
      summary: "Summary 1",
      debugLink: "/debug",
      receiptsLink: "/receipts",
    },
  });

  expect(markup).toMatch(/Project 1/);
  expect(markup).toMatch(/Project 5/);
  expect(markup).not.toMatch(/Project 6/);
  expect(markup).toMatch(/View all/);
  expect(markup).not.toMatch(/Jobs/);
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

  expect(markup).toMatch(/Recent/);
  expect(markup).toMatch(/Profile-driven Factory UI/);
});

test("factory chat shell: sidebar and inspector avoid agent-refresh churn", () => {
  const markup = factoryChatShell({
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    objectiveId: "objective_demo",
    chat: {
      activeProfileId: "generalist",
      activeProfileLabel: "Generalist",
      items: [],
    },
    nav: {
      activeProfileId: "generalist",
      activeProfileLabel: "Generalist",
      profiles: [{ id: "generalist", label: "Generalist", selected: true }],
      objectives: [],
    },
    inspector: {
      panel: "overview",
      jobs: [],
      selectedObjective: {
        objectiveId: "objective_demo",
        title: "Demo objective",
        status: "executing",
        phase: "executing",
        summary: "Demo summary",
        debugLink: "/debug",
        receiptsLink: "/receipts",
      },
    },
  });

  expect(markup).toMatch(/id="factory-chat"[^>]+sse:agent-refresh throttle:180ms/);
  expect(markup).toMatch(/id="factory-sidebar"[^>]+sse:factory-refresh throttle:450ms[^"]+sse:job-refresh throttle:450ms/);
  expect(markup).toMatch(/id="factory-inspector"[^>]+sse:factory-refresh throttle:450ms[^"]+sse:job-refresh throttle:450ms/);
  expect(markup).not.toMatch(/id="factory-sidebar"[^>]+sse:agent-refresh/);
  expect(markup).not.toMatch(/id="factory-inspector"[^>]+sse:agent-refresh/);
  expect(markup).not.toMatch(/data-prompt-fill/);
  expect(markup).not.toMatch(/\/ Commands/);
  expect(markup).toContain("data-composer-commands='");
  expect(markup).toContain("&quot;name&quot;:&quot;help&quot;");
  expect(markup).toMatch(/id="factory-composer-completions"[^>]+role="listbox"/);
  expect(markup).toMatch(/id="factory-composer-submit"[^>]+min-h-\[88px\]/);
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
    agentId: "codex",
    lane: "collect",
    sessionKey: "codex:demo",
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

test("factory sidebar state: active Codex ignores stale terminal failures", () => {
  const runningCodexJob: QueueJob = {
    id: "job_codex_running",
    agentId: "codex",
    lane: "collect",
    payload: {
      kind: "factory.codex.run",
      task: "Inspect the active worktree.",
      prompt: "Inspect the active worktree.",
      parentRunId: "run_live",
    },
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    createdAt: 1_000,
    updatedAt: 2_000,
    result: {
      summary: "Inspecting the active worktree.",
      lastMessage: "Inspecting src/views/factory-chat.ts.",
    },
    commands: [],
  };
  const failedCodexJob: QueueJob = {
    id: "job_codex_failed",
    agentId: "codex",
    lane: "collect",
    payload: {
      kind: "factory.codex.run",
      task: "Old failed attempt.",
      prompt: "Old failed attempt.",
      parentRunId: "run_old",
    },
    status: "failed",
    attempt: 1,
    maxAttempts: 1,
    createdAt: 3_000,
    updatedAt: 4_000,
    lastError: "old failure",
    result: {
      message: "old failure",
    },
    commands: [],
  };

  expect(buildActiveCodexCard([failedCodexJob, runningCodexJob])?.jobId).toBe("job_codex_running");
  expect(buildActiveCodexCard([failedCodexJob])).toBeUndefined();
});

test("factory chat items: generic JSON finals are reformatted into readable markdown", () => {
  const runStream = "agents/factory/demo/runs/run_json_final";
  let prev: string | undefined;
  const push = (body: AgentEvent, index: number) => {
    const next = receipt(runStream, prev, body, index);
    prev = next.hash;
    return next;
  };
  const chain = [
    push({
      type: "problem.set",
      runId: "run_json_final",
      problem: "What can you do here?",
      agentId: "orchestrator",
    }, 1),
    push({
      type: "response.finalized",
      runId: "run_json_final",
      agentId: "orchestrator",
      content: JSON.stringify({
        what_i_can_do_here: [
          "Inspect receipts",
          "Queue Codex work",
        ],
        next_best_action: "Describe the repo change in chat and I will open a project if execution is needed.",
      }),
    }, 2),
  ];

  const items = buildChatItemsForRun("run_json_final", chain, new Map());
  const finalItem = items.find((item) => item.kind === "assistant");
  expect(finalItem && finalItem.kind === "assistant" ? finalItem.body : "").toContain("## What I Can Do Here");
  expect(finalItem && finalItem.kind === "assistant" ? finalItem.body : "").toContain("- Inspect receipts");
  expect(finalItem && finalItem.kind === "assistant" ? finalItem.body : "").toContain("## Next Best Action");
  expect(finalItem && finalItem.kind === "assistant" ? finalItem.body : "").not.toContain("{");
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

  expect(markup).toMatch(/Fix iteration-3 issue/);
  expect(markup).toMatch(/queued/i);
});
test("factory route: job-only events subscribe to the selected job without falling back to the profile stream", async () => {
  const subscriptions: Array<{ readonly topic: string; readonly stream?: string }> = [];
  const app = createRouteTestApp({
    onSubscribeMany: (items) => subscriptions.push(...items),
  });

  const response = await app.request("http://receipt.test/factory/events?profile=generalist&job=job_queue_01");
  expect(response.status).toBe(200);
  expect(subscriptions.some((item) => item.topic === "jobs" && item.stream === "job_queue_01")).toBe(true);
  expect(subscriptions.some((item) => item.topic === "agent")).toBe(false);
});

test("factory route: run-scoped chat events subscribe to related child jobs only", async () => {
  const subscriptions: Array<{ readonly topic: string; readonly stream?: string }> = [];
  const stream = factoryChatStream(process.cwd(), "generalist", "objective_demo");
  const app = createRouteTestApp({
    onSubscribeMany: (items) => subscriptions.push(...items),
    jobs: [{
      id: "job_related_parent",
      agentId: "codex",
      lane: "collect",
      sessionKey: "factory-chat:generalist",
      singletonMode: "allow",
      payload: {
        kind: "factory.codex.run",
        objectiveId: "objective_demo",
        stream,
        parentRunId: "run_parent",
        task: "Patch the shell.",
      },
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      createdAt: 1,
      updatedAt: 2,
      commands: [],
    }, {
      id: "job_related_child",
      agentId: "writer",
      lane: "collect",
      sessionKey: "factory-delegate",
      singletonMode: "allow",
      payload: {
        kind: "writer.run",
        objectiveId: "objective_demo",
        runId: "run_child",
        parentRunId: "run_parent",
        stream: "agents/writer",
        parentStream: stream,
        task: "Write the summary.",
      },
      status: "queued",
      attempt: 1,
      maxAttempts: 1,
      createdAt: 3,
      updatedAt: 4,
      commands: [],
    }, {
      id: "job_unrelated",
      agentId: "codex",
      lane: "collect",
      sessionKey: "factory-chat:generalist",
      singletonMode: "allow",
      payload: {
        kind: "factory.codex.run",
        objectiveId: "objective_demo",
        stream,
        parentRunId: "run_other",
        task: "Unrelated work.",
      },
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      createdAt: 5,
      updatedAt: 6,
      commands: [],
    }],
  });

  const response = await app.request("http://receipt.test/factory/events?profile=generalist&objective=objective_demo&run=run_parent");
  expect(response.status).toBe(200);
  expect(subscriptions).toContainEqual({ topic: "jobs", stream: "job_related_parent" });
  expect(subscriptions).toContainEqual({ topic: "jobs", stream: "job_related_child" });
  expect(subscriptions).not.toContainEqual({ topic: "jobs", stream: "job_unrelated" });
});

test("factory route: chat shell stays empty-state when thread is missing", async () => {
  const liveObjective = makeStubObjectiveDetail("objective_live");
  liveObjective.title = "Live objective";

  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        liveObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => liveObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).not.toContain("/factory/control?thread=objective_live");
  expect(body).toContain("No objective selected.");
});

test("factory route: inspector execution panel stays empty when thread is missing", async () => {
  const liveObjective = makeStubObjectiveDetail("objective_live");

  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        liveObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => liveObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory/island/inspector?profile=generalist&panel=execution");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("No tasks defined yet.");
  expect(body).not.toContain("Demo task");
});

test("factory route: new chat creates an isolated chat session", async () => {
  const app = createRouteTestApp();

  const response = await app.request("http://receipt.test/factory/new-chat?profile=generalist");

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toMatch(/^\/factory\?profile=generalist&chat=chat_[a-z0-9]+_[a-z0-9]+$/);
});

test("factory route: blank composer submissions create an isolated chat session", async () => {
  let queuedInput: Record<string, unknown> | undefined;
  const app = createRouteTestApp({
    onEnqueue: async (input) => {
      queuedInput = input;
      return {
        id: "job_chat_blank",
        agentId: "factory",
        payload: (input.payload as Record<string, unknown> | undefined) ?? {},
        lane: "collect",
        status: "queued",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 10,
        updatedAt: 11,
        commands: [],
      } as QueueJob;
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "Start fresh.",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toMatch(/^\/factory\?profile=generalist&chat=chat_[a-z0-9]+_[a-z0-9]+&run=run_[a-z0-9]+_[a-z0-9]+&job=job_chat_blank$/);
  expect((queuedInput?.payload as Record<string, unknown> | undefined)?.chatId).toMatch(/^chat_[a-z0-9]+_[a-z0-9]+$/);
});
test("factory route: composer accepts UI chat submissions and redirects into queued run context", async () => {
  let queuedInput: Record<string, unknown> | undefined;
  const app = createRouteTestApp({
    onEnqueue: async (input) => {
      queuedInput = input;
      return {
        id: "job_chat_01",
        agentId: "factory",
        payload: (input.payload as Record<string, unknown> | undefined) ?? {},
        lane: "collect",
        status: "queued",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 10,
        updatedAt: 11,
        commands: [],
      } as QueueJob;
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&chat=chat_demo", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "Check the repo and tell me what happens next.",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toMatch(/^\/factory\?profile=generalist&chat=chat_demo&run=run_[a-z0-9]+_[a-z0-9]+&job=job_chat_01$/);
  expect(queuedInput).toMatchObject({
    agentId: "factory",
    lane: "collect",
    singletonMode: "allow",
  });
  expect((queuedInput?.payload as Record<string, unknown> | undefined)).toMatchObject({
    kind: "factory.run",
    profileId: "generalist",
    chatId: "chat_demo",
    problem: "Check the repo and tell me what happens next.",
  });
});

test("factory route: composer slash commands mutate the selected objective", async () => {
  let reacted: { readonly objectiveId: string; readonly message?: string } | undefined;
  const app = createRouteTestApp({
    service: {
      reactObjectiveWithNote: async (objectiveId: string, message?: string) => {
        reacted = { objectiveId, message };
        return makeStubObjectiveDetail(objectiveId);
      },
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&thread=objective_demo&run=run_01&job=job_01", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "/react Keep receipts concise.",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/factory?profile=generalist&thread=objective_demo&run=run_01&job=job_01");
  expect(reacted).toEqual({
    objectiveId: "objective_demo",
    message: "Keep receipts concise.",
  });
});

test("factory route: slash commands queue the active job via the composer submit flow", async () => {
  let steerInput: { readonly jobId: string; readonly problem?: string; readonly by?: string } | undefined;
  let followUpInput: { readonly jobId: string; readonly note: string; readonly by?: string } | undefined;
  let abortInput: { readonly jobId: string; readonly reason?: string; readonly by?: string } | undefined;
  const activeJob = {
    id: "job_01",
    agentId: "factory",
    lane: "steer",
    singletonMode: "allow",
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    createdAt: 1,
    updatedAt: 1,
    commands: [],
  } as QueueJob;
  const app = createRouteTestApp({
    jobs: [activeJob],
    service: {
      queueJobSteer: async (jobId: string, input: { readonly problem?: string; readonly by?: string }) => {
        steerInput = { jobId, ...input };
        return makeStubJobQueueResult(jobId);
      },
      queueJobFollowUp: async (jobId: string, note: string, by?: string) => {
        followUpInput = { jobId, note, by };
        return makeStubJobQueueResult(jobId);
      },
      queueJobAbort: async (jobId: string, reason?: string, by?: string) => {
        abortInput = { jobId, reason, by };
        return makeStubJobQueueResult(jobId);
      },
    },
  });

  const steerResponse = await app.request("http://receipt.test/factory/compose?profile=generalist&thread=objective_demo&job=job_01", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ prompt: "/steer tighten the current plan" }).toString(),
  });
  expect(steerResponse.status).toBe(303);
  expect(steerResponse.headers.get("location")).toContain("/factory?profile=generalist&thread=objective_demo");
  expect(steerInput).toEqual({
    jobId: "job_01",
    problem: "tighten the current plan",
    by: "factory.web",
  });

  const followUpResponse = await app.request("http://receipt.test/factory/compose?profile=generalist&thread=objective_demo&job=job_01", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ prompt: "/follow-up keep the logs attached" }).toString(),
  });
  expect(followUpResponse.status).toBe(303);
  expect(followUpInput).toEqual({
    jobId: "job_01",
    note: "keep the logs attached",
    by: "factory.web",
  });

  const abortResponse = await app.request("http://receipt.test/factory/compose?profile=generalist&thread=objective_demo&job=job_01", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ prompt: "/abort-job stop the current worker" }).toString(),
  });
  expect(abortResponse.status).toBe(303);
  expect(abortInput).toEqual({
    jobId: "job_01",
    reason: "stop the current worker",
    by: "factory.web",
  });
});

test("factory route: legacy factory POST endpoints remain removed outside the composer route", async () => {
  const app = createRouteTestApp();
  const endpoints = [
    "/factory/control/compose",
    "/factory/run",
    "/factory/api/objectives",
    "/factory/api/objectives/objective_demo/react",
    "/factory/api/objectives/objective_demo/promote",
    "/factory/api/objectives/objective_demo/cancel",
    "/factory/api/objectives/objective_demo/archive",
    "/factory/api/objectives/objective_demo/cleanup",
    "/factory/job/job_demo/steer",
    "/factory/job/job_demo/follow-up",
    "/factory/job/job_demo/abort",
  ];

  for (const endpoint of endpoints) {
    const response = await app.request(`http://receipt.test${endpoint}`, { method: "POST" });
    expect(response.status).toBe(404);
  }
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
