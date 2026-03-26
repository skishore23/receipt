import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Hono } from "hono";

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
  initialFactoryState,
  normalizeFactoryState,
  reduceFactory,
  type FactoryEvent,
  type FactoryState,
} from "../../src/modules/factory";
import type { AgentEvent } from "../../src/modules/agent";
import createFactoryRoute, { buildActiveCodexCard, buildChatItemsForRun } from "../../src/agents/factory.agent";
import { agentRunStream } from "../../src/agents/agent.streams";
import { projectAgentRun } from "../../src/agents/factory/run-projection";
import { FactoryService, type FactoryTaskJobPayload } from "../../src/services/factory-service";
import { factoryChatSessionStream, factoryChatStream } from "../../src/services/factory-chat-profiles";
import { factoryChatIsland, factoryChatShell, factorySidebarIsland } from "../../src/views/factory-chat";
import { factoryInspectorIsland } from "../../src/views/factory-inspector";
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

const writeExecutable = async (targetPath: string, body: string): Promise<void> => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, body, "utf-8");
  await fs.chmod(targetPath, 0o755);
};

const seedSourceRepoRuntimeSurface = async (repoRoot: string): Promise<void> => {
  await fs.writeFile(path.join(repoRoot, ".gitignore"), "node_modules\nnode_modules/\n", "utf-8");
  await fs.writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
    name: "factory-worktree-runtime",
    private: true,
    scripts: {
      build: "workspace-tool && receipt --help >/dev/null && test -f node_modules/htmx.org/dist/htmx.min.js && echo build-ok",
    },
  }, null, 2), "utf-8");
  await git(repoRoot, ["add", ".gitignore", "package.json"]);
  await git(repoRoot, ["commit", "-m", "add runtime surface"]);

  await writeExecutable(
    path.join(repoRoot, "node_modules", ".bin", "workspace-tool"),
    "#!/bin/sh\necho workspace-tool-ok\n",
  );
  await fs.mkdir(path.join(repoRoot, "node_modules", "htmx.org", "dist"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "node_modules", "htmx.org", "dist", "htmx.min.js"), "/* htmx */\n", "utf-8");
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

const makeRunningWorkbenchObjectiveDetail = (
  objectiveId = "objective_live",
) => ({
  ...makeStubObjectiveDetail(objectiveId, "job_task_01"),
  title: "Live objective",
  nextAction: "Stay on the running task and keep the log stream visible.",
  latestSummary: "Task work is running in the shared thread shell.",
  activeTaskCount: 1,
  readyTaskCount: 1,
  taskCount: 2,
  tokensUsed: 321,
  latestDecision: {
    summary: "Focus task_01 until the shell patch is stable.",
    at: 10,
    source: "runtime",
  },
  recentReceipts: [{
    type: "rebracket.applied",
    hash: "hash_live_01",
    ts: 11,
    summary: "Factory kept task_01 at the frontier.",
    taskId: "task_01",
  }],
  activity: [{
    kind: "job",
    title: "Worker running",
    summary: "Codex is still applying the mission shell patch.",
    at: 12,
    taskId: "task_01",
    candidateId: "candidate_01",
  }],
  tasks: [{
    taskId: "task_01",
    title: "Implement mission shell",
    prompt: "Implement the running-task workbench in the browser shell.",
    workerType: "codex",
    taskKind: "planned",
    status: "running",
    dependsOn: [],
    workspaceExists: true,
    workspaceDirty: true,
    workspaceHead: "abc12345",
    jobId: "job_task_01",
    jobStatus: "running",
    candidateId: "candidate_01",
    candidate: {
      candidateId: "candidate_01",
      taskId: "task_01",
      status: "running",
      tokensUsed: 321,
      summary: "Applying the mission shell patch.",
    },
    manifestPath: "/tmp/task_01.manifest.json",
    contextPackPath: "/tmp/task_01.context-pack.json",
    promptPath: "/tmp/task_01.prompt.md",
    memoryScriptPath: "/tmp/task_01.memory.cjs",
    stdoutPath: "/tmp/task_01.stdout.log",
    stderrPath: "/tmp/task_01.stderr.log",
    lastMessagePath: "/tmp/task_01.last-message.md",
    lastMessage: "Wiring the running task workbench.",
    stdoutTail: "build ok",
    stderrTail: "",
  }, {
    taskId: "task_02",
    title: "Tighten inspector focus",
    prompt: "Keep the right rail pinned to the focused task.",
    workerType: "codex",
    taskKind: "planned",
    status: "ready",
    dependsOn: ["task_01"],
    workspaceExists: true,
    workspaceDirty: false,
    workspaceHead: "abc12345",
    jobStatus: "queued",
    latestSummary: "Waiting on task_01.",
  }],
}) as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;

const makeStubJobQueueResult = (jobId: string): { readonly job: QueueJob; readonly command: { readonly id: string } } => ({
  job: {
    id: jobId,
    agentId: "factory",
    lane: "chat",
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

const makeStubObjectiveState = (
  detail: Awaited<ReturnType<FactoryService["getObjective"]>>,
): FactoryState => normalizeFactoryState({
  ...initialFactoryState,
  objectiveId: detail.objectiveId,
  title: detail.title,
  prompt: detail.prompt,
  status: detail.status,
  latestSummary: detail.latestSummary,
  checks: detail.checks,
  createdAt: detail.createdAt,
  updatedAt: detail.updatedAt,
  scheduler: {
    ...initialFactoryState.scheduler,
    slotState: detail.scheduler.slotState,
    queuePosition: detail.scheduler.queuePosition,
  },
  profile: {
    ...initialFactoryState.profile,
    rootProfileId: "generalist",
  },
  integration: {
    ...initialFactoryState.integration,
    status: detail.integration.status,
    headCommit: detail.latestCommitHash,
    promotedCommit: detail.latestCommitHash,
  },
  workflow: {
    ...initialFactoryState.workflow,
    objectiveId: detail.objectiveId,
    taskIds: detail.tasks.map((task) => task.taskId),
    activeTaskIds: detail.tasks
      .filter((task) => task.jobStatus === "running" || task.status === "running")
      .map((task) => task.taskId),
    tasksById: Object.fromEntries(detail.tasks.map((task) => [task.taskId, {
      ...task,
      createdAt: task.createdAt ?? detail.createdAt,
      artifactRefs: task.artifactRefs ?? {},
      contextRefs: task.contextRefs ?? [],
      skillBundlePaths: task.skillBundlePaths ?? [],
      baseCommit: task.baseCommit ?? detail.latestCommitHash ?? "",
    }])),
  },
  candidates: Object.fromEntries(
    detail.candidates.map((candidate) => [candidate.candidateId, candidate]),
  ),
  candidateOrder: detail.candidates.map((candidate) => candidate.candidateId),
} as FactoryState);

const createRouteTestApp = (overrides?: {
  readonly liveOutput?: Record<string, unknown>;
  readonly jobs?: ReadonlyArray<QueueJob>;
  readonly agentEvents?: Readonly<Record<string, ReadonlyArray<AgentEvent>>>;
  readonly onSubscribeMany?: (subscriptions: ReadonlyArray<{ readonly topic: string; readonly stream?: string }>) => void;
  readonly onListJobs?: (limit?: number) => void;
  readonly onEnqueue?: (input: Record<string, unknown>) => QueueJob | Promise<QueueJob>;
  readonly service?: Partial<Pick<
    FactoryService,
    | "listObjectives"
    | "getObjective"
    | "getObjectiveState"
    | "listObjectiveReceipts"
    | "createObjective"
    | "reactObjectiveWithNote"
    | "queueJobAbort"
    | "promoteObjective"
    | "cancelObjective"
    | "cleanupObjectiveWorkspaces"
    | "archiveObjective"
  >>;
}): Hono => {
  const enqueuedJobs = new Map<string, QueueJob>();
  const receiptChain = (streamKey: string) => {
    const events = overrides?.agentEvents?.[streamKey] ?? [];
    let prev: string | undefined;
    return events.map((event, index) => {
      const next = receipt(streamKey, prev, event, index + 1);
      prev = next.hash;
      return next;
    });
  };
  const dummyRuntime = {
    execute: async () => [],
    state: async () => ({}),
    stateAt: async () => ({}),
    chain: async (streamKey: string) => receiptChain(streamKey),
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
            lane: (input.lane === "chat" || input.lane === "collect" || input.lane === "steer" || input.lane === "follow_up")
              ? input.lane
              : "collect",
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
    listJobs: async (options?: { readonly limit?: number }) => {
      overrides?.onListJobs?.(options?.limit);
      return [...(overrides?.jobs ?? []), ...enqueuedJobs.values()];
    },
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
    getObjectiveState: async (objectiveId: string) => makeStubObjectiveState(
      overrides?.service?.getObjective
        ? await overrides.service.getObjective(objectiveId)
        : defaultObjective,
    ),
    listObjectiveReceipts: async (objectiveId: string) => {
      const detail = overrides?.service?.getObjective
        ? await overrides.service.getObjective(objectiveId)
        : defaultObjective;
      return detail.recentReceipts;
    },
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

test("factory service: listObjectives uses the stream manifest instead of scanning the whole data dir", async () => {
  const dataDir = await createTempDir("receipt-factory-objective-manifest");
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

  const created = await service.createObjective({
    title: "Manifest-backed discovery",
    prompt: "Ensure Factory objective discovery does not scan every receipt file.",
    checks: ["git status --short"],
  });

  const originalReaddir = fs.readdir;
  (fs as unknown as { readdir: typeof fs.readdir }).readdir = (async (...args: Parameters<typeof fs.readdir>) => {
    const target = args[0];
    if (typeof target === "string" && path.resolve(target) === path.resolve(dataDir)) {
      throw new Error("factory discovery should not scan the data dir");
    }
    return originalReaddir(...args);
  }) as typeof fs.readdir;

  try {
    const objectives = await service.listObjectives();
    expect(objectives.some((objective) => objective.objectiveId === created.objectiveId)).toBe(true);
  } finally {
    (fs as unknown as { readdir: typeof fs.readdir }).readdir = originalReaddir;
  }
});

test("factory service: listObjectives skips receipt-chain reads for non-blocked cards", async () => {
  const dataDir = await createTempDir("receipt-factory-objective-card-fast-path");
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

  const created = await service.createObjective({
    title: "Fast objective card",
    prompt: "Keep objective cards on the fast path when nothing is blocked.",
    checks: ["git status --short"],
  });

  const runtime = (service as unknown as { runtime: { chain: typeof service["jobRuntime"]["chain"] } }).runtime;
  const originalChain = runtime.chain.bind(runtime);
  let objectiveChainReads = 0;
  runtime.chain = (async (streamName: string) => {
    if (streamName === `factory/objectives/${created.objectiveId}`) {
      objectiveChainReads += 1;
    }
    return originalChain(streamName);
  }) as typeof runtime.chain;

  try {
    const objectives = await service.listObjectives();
    const objective = objectives.find((item) => item.objectiveId === created.objectiveId);
    expect(objective).toBeTruthy();
    expect(objective?.blockedExplanation).toBeUndefined();
    expect(objectiveChainReads).toBe(0);
  } finally {
    runtime.chain = originalChain;
  }
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

test("factory service: git worktree checks bootstrap repo node_modules and receipt cli", async () => {
  const dataDir = await createTempDir("receipt-factory-worktree-checks");
  const repoRoot = await createSourceRepo();
  await seedSourceRepoRuntimeSurface(repoRoot);
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
  const workspace = await service.git.createWorkspace({
    workspaceId: "runtime-checks",
    agentId: "codex",
  });
  const bunBin = shellQuote(process.env.BUN_BIN?.trim() || "bun");

  const runChecks = (service as unknown as {
    runChecks: (commands: ReadonlyArray<string>, workspacePath: string) => Promise<ReadonlyArray<{ readonly ok: boolean; readonly stdout: string }>>;
  }).runChecks.bind(service);
  const results = await runChecks([`${bunBin} run build`], workspace.path);

  expect(results.map((result) => result.ok)).toEqual([true]);
  expect(results[0]?.stdout).toContain("workspace-tool-ok");
  expect(results[0]?.stdout).toContain("build-ok");
  await expect(fs.readlink(path.join(workspace.path, "node_modules"))).resolves.toBe(path.join(repoRoot, "node_modules"));
});

test("factory service: bootstrapped worktree node_modules link stays excluded from git status and commits", async () => {
  const dataDir = await createTempDir("receipt-factory-worktree-node-modules-exclude");
  const repoRoot = await createSourceRepo();
  await seedSourceRepoRuntimeSurface(repoRoot);
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

  const workspace = await service.git.createWorkspace({
    workspaceId: "runtime-exclude-checks",
    agentId: "codex",
  });

  const runChecks = (service as unknown as {
    runChecks: (commands: ReadonlyArray<string>, workspacePath: string) => Promise<ReadonlyArray<{ readonly ok: boolean }>>;
  }).runChecks.bind(service);
  await runChecks([`${shellQuote(process.env.BUN_BIN?.trim() || "bun")} run build`], workspace.path);

  const afterBootstrap = await service.git.worktreeStatus(workspace.path);
  expect(afterBootstrap.dirty).toBe(false);

  await fs.writeFile(path.join(workspace.path, "README.md"), "# factory test\nupdated\n", "utf-8");
  const committed = await service.git.commitWorkspace(workspace.path, "update readme");
  expect(committed.hash.length).toBeGreaterThan(0);

  const committedFiles = await git(workspace.path, ["show", "--name-only", "--format=", committed.hash]);
  expect(committedFiles.split(/\r?\n/).filter(Boolean)).toEqual(["README.md"]);
  await expect(fs.readlink(path.join(workspace.path, "node_modules"))).resolves.toBe(path.join(repoRoot, "node_modules"));
});

test("factory service: software task runs inherit worktree cli and local tool access", async () => {
  const dataDir = await createTempDir("receipt-factory-worktree-task-env");
  const repoRoot = await createSourceRepo();
  await seedSourceRepoRuntimeSurface(repoRoot);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  let capturedStdout = "";
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: {
      run: async (input) => {
        const { stdout } = await execFileAsync("/bin/sh", ["-lc", "workspace-tool && receipt --help >/dev/null && echo env-ok"], {
          cwd: input.workspacePath,
          env: {
            ...process.env,
            ...input.env,
          },
          encoding: "utf-8",
          maxBuffer: 16 * 1024 * 1024,
        });
        capturedStdout = stdout;
        await fs.writeFile(path.join(input.workspacePath, "CHANGE.txt"), "workspace env ready\n", "utf-8");
        const result = JSON.stringify({
          outcome: "approved",
          summary: "Validated worktree command access for the software task runtime.",
          artifacts: [],
          scriptsRun: [{
            command: "workspace-tool && receipt --help",
            summary: "Verified local tool and receipt CLI access from the task worktree.",
            status: "ok",
          }],
          nextAction: null,
        });
        await fs.writeFile(input.lastMessagePath, result, "utf-8");
        return { exitCode: 0, signal: null, stdout: "", stderr: "", lastMessage: result };
      },
    },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Software worktree env",
    prompt: "Confirm the software task runtime can use repo-local commands from its worktree.",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);
  const jobs = await queue.listJobs({ limit: 20 });
  const taskJob = jobs.find((job) => job.payload.kind === "factory.task.run" && job.payload.objectiveId === created.objectiveId);
  expect(taskJob).toBeTruthy();

  await service.runTask(taskJob!.payload as FactoryTaskJobPayload);

  expect(capturedStdout).toContain("workspace-tool-ok");
  expect(capturedStdout).toContain("env-ok");
  const detail = await service.getObjective(created.objectiveId);
  expect(detail.tasks[0]?.status).not.toBe("blocked");
  expect(detail.status).not.toBe("blocked");
});

test("factory reducer: replay reconstructs task, candidate, and integration state deterministically", () => {
  const events: FactoryEvent[] = [
    {
      type: "objective.created",
      objectiveId: "objective_demo",
      title: "Factory objective",
      prompt: "Implement the workflow controller.",
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
      completion: {
        changed: ["Produced the candidate commit."],
        proof: ["bun run build passed."],
        remaining: [],
      },
      checkResults: [{
        command: "bun run build",
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        startedAt: 6,
        finishedAt: 7,
      }],
      scriptsRun: [{
        command: "bun test tests/smoke/factory.test.ts",
        summary: "Ran the focused reducer smoke test.",
        status: "ok",
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
  expect(replayA.candidates.task_01_candidate_01?.scriptsRun?.[0]?.command).toBe("bun test tests/smoke/factory.test.ts");
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

test("factory state normalization: legacy graph snapshots are upgraded to workflow state", () => {
  const legacyState = {
    ...initialFactoryState,
    objectiveId: "objective_legacy_graph",
    title: "Legacy graph objective",
    workflow: undefined,
    taskOrder: ["task_01"],
    graph: {
      status: "active",
      activeNodeIds: ["task_01"],
      order: ["task_01"],
      nodes: {
        task_01: {
          nodeId: "task_01",
          taskId: "task_01",
          taskKind: "planned",
          title: "Legacy task",
          prompt: "Continue running the legacy task.",
          workerType: "codex",
          baseCommit: "abc1234",
          dependsOn: [],
          status: "running",
          skillBundlePaths: [],
          contextRefs: [],
          artifactRefs: {},
          createdAt: 1,
          startedAt: 2,
        },
      },
      updatedAt: 2,
    },
  } as unknown as FactoryState;

  const normalized = normalizeFactoryState(legacyState);

  expect(normalized.workflow.taskIds).toEqual(["task_01"]);
  expect(normalized.workflow.activeTaskIds).toEqual(["task_01"]);
  expect(normalized.workflow.tasksById.task_01?.status).toBe("running");
});

test("factory state normalization: sparse legacy candidate state backfills candidate order", () => {
  const next = reduceFactory({
    ...initialFactoryState,
    objectiveId: "objective_sparse_candidate_state",
    title: "Sparse candidate state",
    workflow: {
      ...initialFactoryState.workflow,
      objectiveId: "objective_sparse_candidate_state",
    },
    candidates: undefined,
    candidateOrder: undefined,
  } as unknown as FactoryState, {
    type: "candidate.created",
    objectiveId: "objective_sparse_candidate_state",
    createdAt: 2,
    candidate: {
      candidateId: "task_01_candidate_01",
      taskId: "task_01",
      status: "planned",
      baseCommit: "abc1234",
      checkResults: [],
      artifactRefs: {},
      createdAt: 2,
      updatedAt: 2,
    },
  });

  expect(next.candidateOrder).toEqual(["task_01_candidate_01"]);
  expect(next.candidates.task_01_candidate_01?.taskId).toBe("task_01");
});

test("factory projection: sparse workflow and candidate arrays fall back to mapped records", () => {
  const projection = buildFactoryProjection({
    ...initialFactoryState,
    objectiveId: "objective_sparse_projection",
    title: "Sparse projection",
    workflow: {
      ...initialFactoryState.workflow,
      objectiveId: "objective_sparse_projection",
      taskIds: undefined,
      activeTaskIds: undefined,
      tasksById: {
        task_01: {
          nodeId: "task_01",
          taskId: "task_01",
          taskKind: "planned",
          title: "Sparse task",
          prompt: "Keep sparse state safe.",
          workerType: "codex",
          baseCommit: "abc1234",
          dependsOn: [],
          status: "ready",
          skillBundlePaths: [],
          contextRefs: [],
          artifactRefs: {},
          createdAt: 1,
        },
      },
    },
    candidates: {
      task_01_candidate_01: {
        candidateId: "task_01_candidate_01",
        taskId: "task_01",
        status: "approved",
        baseCommit: "abc1234",
        checkResults: [],
        artifactRefs: {},
        createdAt: 2,
        updatedAt: 2,
      },
    },
    candidateOrder: undefined,
  } as unknown as FactoryState);

  expect(projection.tasks.map((task) => task.taskId)).toEqual(["task_01"]);
  expect(projection.readyTasks.map((task) => task.taskId)).toEqual(["task_01"]);
  expect(projection.candidates.map((candidate) => candidate.candidateId)).toEqual(["task_01_candidate_01"]);
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

test("factory chat island: folds live execution into compact thread sections", () => {
  const markup = factoryChatIsland({
    activeProfileId: "infrastructure",
    activeProfileLabel: "Infrastructure",
    selectedThread: {
      objectiveId: "objective_live",
      title: "Count buckets",
      status: "executing",
      phase: "executing",
      summary: "Running AWS inventory.",
      debugLink: "/debug",
      receiptsLink: "/receipts",
    },
    activeCodex: {
      jobId: "job_codex_live",
      status: "running",
      summary: "Listing S3 buckets from the mounted AWS account.",
      latestNote: "Running the deterministic bucket inventory script.",
      tokensUsed: 4321,
      stdoutTail: "{\"count\":5}",
      stderrTail: "",
      task: "Inventory S3 buckets and report the authoritative bucket count",
      updatedAt: 1_710_000_000_000,
      rawLink: "/jobs/job_codex_live",
      running: true,
    },
    items: [],
  });

  expect(markup).toContain("Current");
  expect(markup).toContain("Running the deterministic bucket inventory script.");
  expect(markup).toContain("Inventory S3 buckets and report the authoritative bucket count");
  expect(markup).toContain("Next");
  expect(markup).toContain("Status");
  expect(markup).not.toContain("Stdout");
});

test("factory chat island: live codex cards show recorded token usage", () => {
  const markup = factoryChatIsland({
    activeProfileId: "infrastructure",
    activeProfileLabel: "Infrastructure",
    activeCodex: {
      jobId: "job_codex_live",
      status: "running",
      summary: "Listing S3 buckets from the mounted AWS account.",
      latestNote: "Running the deterministic bucket inventory script.",
      tokensUsed: 4321,
      stdoutTail: "{\"count\":5}",
      stderrTail: "",
      task: "Inventory S3 buckets and report the authoritative bucket count",
      updatedAt: 1_710_000_000_000,
      rawLink: "/jobs/job_codex_live",
      running: true,
    },
    items: [],
  });

  expect(markup).toContain("Active Codex");
  expect(markup).toContain("4,321 tokens");
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
      content: "Stopped after hitting max iterations.",
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

test("factory chat items: factory.status cards keep active job and packet evidence", () => {
  const runStream = "agents/factory/demo/runs/run_factory_status";
  let prev: string | undefined;
  const push = (body: AgentEvent, index: number) => {
    const next = receipt(runStream, prev, body, index);
    prev = next.hash;
    return next;
  };
  const chain = [
    push({
      type: "problem.set",
      runId: "run_factory_status",
      problem: "Show the live Factory evidence.",
      agentId: "orchestrator",
    }, 1),
    push({
      type: "tool.called",
      runId: "run_factory_status",
      iteration: 1,
      agentId: "orchestrator",
      tool: "factory.status",
      input: { objectiveId: "objective_demo" },
      summary: "Thread is still executing.",
      durationMs: 1_200,
    }, 2),
    push({
      type: "tool.observed",
      runId: "run_factory_status",
      iteration: 1,
      agentId: "orchestrator",
      tool: "factory.status",
      truncated: false,
      output: JSON.stringify({
        worker: "factory",
        action: "status",
        objectiveId: "objective_demo",
        title: "Which EC2 instances are publicly reachable",
        status: "executing",
        phase: "executing",
        integrationStatus: "idle",
        summary: "Thread is still executing.",
        activeJobs: [{
          id: "job_factory_01",
          agentId: "codex",
          status: "running",
          payload: {
            kind: "factory.task.run",
            taskId: "task_01",
          },
          result: {
            summary: "Inspecting account scope.",
          },
        }],
        recentReceipts: [{
          type: "task.dispatched",
          summary: "task.dispatched",
        }],
        taskWorktrees: [{
          taskId: "task_01",
          exists: true,
          dirty: false,
          branch: "codex/task-01",
          head: "abc1234",
          workspacePath: "/tmp/objective_demo_task_01",
        }],
        latestContextPacks: [{
          taskId: "task_01",
          candidateId: "task_01_candidate_01",
          contextPackPath: "/tmp/task_01.context-pack.json",
          memoryScriptPath: "/tmp/task_01.memory.cjs",
        }],
      }),
    }, 3),
  ];

  const items = buildChatItemsForRun("run_factory_status", chain, new Map());
  const statusCard = items.find((item) => item.kind === "work" && item.card.title === "Thread status");
  const detail = statusCard && statusCard.kind === "work" ? statusCard.card.detail ?? "" : "";

  expect(statusCard && statusCard.kind === "work" ? statusCard.card.summary : "").toContain("Thread is still executing.");
  expect(detail).toContain("Active jobs:");
  expect(detail).toContain("job_factory_01: codex running — Inspecting account scope.");
  expect(detail).toContain("Recent receipts:");
  expect(detail).toContain("task.dispatched: task.dispatched");
  expect(detail).toContain("Task worktrees:");
  expect(detail).toContain("/tmp/objective_demo_task_01");
  expect(detail).toContain("Context packs:");
  expect(detail).toContain("/tmp/task_01.context-pack.json");
  expect(detail).toContain("/tmp/task_01.memory.cjs");
});

test("factory chat items: factory.output cards render live task output", () => {
  const runStream = "agents/factory/demo/runs/run_factory_output";
  let prev: string | undefined;
  const push = (body: AgentEvent, index: number) => {
    const next = receipt(runStream, prev, body, index);
    prev = next.hash;
    return next;
  };
  const chain = [
    push({
      type: "problem.set",
      runId: "run_factory_output",
      problem: "Show the live task output.",
      agentId: "orchestrator",
    }, 1),
    push({
      type: "tool.called",
      runId: "run_factory_output",
      iteration: 1,
      agentId: "orchestrator",
      tool: "factory.output",
      input: { objectiveId: "objective_demo", taskId: "task_01" },
      summary: "Captured live task output.",
      durationMs: 1_100,
    }, 2),
    push({
      type: "tool.observed",
      runId: "run_factory_output",
      iteration: 1,
      agentId: "orchestrator",
      tool: "factory.output",
      truncated: false,
      output: JSON.stringify({
        worker: "factory",
        action: "output",
        objectiveId: "objective_demo",
        focusKind: "task",
        focusId: "task_01",
        title: "Which EC2 instances are publicly reachable",
        status: "running",
        active: true,
        summary: "Streaming live task output.",
        taskId: "task_01",
        candidateId: "task_01_candidate_01",
        jobId: "job_factory_01",
        lastMessage: "Examining AWS account scope.",
        stdoutTail: "#!/usr/bin/env bash\nset -euo pipefail",
        artifactSummary: "Packet files written under .receipt/factory/.",
      }),
    }, 3),
  ];

  const items = buildChatItemsForRun("run_factory_output", chain, new Map());
  const outputCard = items.find((item) => item.kind === "work" && item.card.title === "Live task output");
  const detail = outputCard && outputCard.kind === "work" ? outputCard.card.detail ?? "" : "";

  expect(outputCard && outputCard.kind === "work" ? outputCard.card.summary : "").toContain("Streaming live task output.");
  expect(outputCard && outputCard.kind === "work" ? outputCard.card.jobId : "").toBe("job_factory_01");
  expect(detail).toContain("Title: Which EC2 instances are publicly reachable");
  expect(detail).toContain("Task: task_01");
  expect(detail).toContain("Candidate: task_01_candidate_01");
  expect(detail).toContain("Artifacts: Packet files written under .receipt/factory/.");
  expect(detail).toContain("Latest note: Examining AWS account scope.");
  expect(detail).toContain("stdout:");
  expect(detail).toContain("#!/usr/bin/env bash");
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
  const selectedObjective = {
    objectiveId: "objective_1",
    title: "Project 1",
    status: "queued",
    phase: "queued",
    summary: "Summary 1",
    debugLink: "/debug",
    receiptsLink: "/receipts",
  };
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
  }, selectedObjective);

  expect(markup).toMatch(/Project 1/);
  expect(markup).toMatch(/Project 5/);
  expect(markup).not.toMatch(/Project 6/);
  expect(markup).toMatch(/View all/);
  expect(markup).toMatch(/See other threads/);
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

test("factory sidebar island: objective cards and selected metrics show token totals when available", () => {
  const selectedObjective = {
    objectiveId: "objective_tokens",
    title: "Token-visible objective",
    status: "executing",
    phase: "executing",
    summary: "Surface the Codex token total.",
    debugLink: "/debug",
    receiptsLink: "/receipts",
    activeTaskCount: 1,
    readyTaskCount: 0,
    taskCount: 3,
    tokensUsed: 12345,
  };
  const markup = factorySidebarIsland({
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    activeProfileTools: [],
    profiles: [{ id: "generalist", label: "Generalist", selected: true }],
    objectives: [{
      objectiveId: "objective_tokens",
      title: "Token-visible objective",
      status: "executing",
      phase: "executing",
      summary: "Surface the Codex token total.",
      updatedAt: 100,
      selected: true,
      slotState: "active",
      activeTaskCount: 1,
      readyTaskCount: 0,
      taskCount: 3,
      integrationStatus: "idle",
      tokensUsed: 12345,
    }],
    jobs: [],
  }, selectedObjective);

  expect(markup).not.toContain("12,345 tok");
  expect(markup).toContain("Token Usage");
  expect(markup).toContain("12,345");
  expect(markup).toContain("Codex tokens recorded for this thread");
  expect(markup).toContain("Thread Snapshot");
  expect(markup).toContain("Summary");
  expect(markup).toContain("Surface the Codex token total.");
  expect(markup).toContain("1 active / 0 ready / 3 total");
  expect(markup).toContain("See other threads");
  expect(markup).toContain("?profile=generalist&all=1");
});

test("factory chat shell: sidebar and inspector avoid agent-refresh churn", () => {
  const plan = [
    {
      taskId: "task_03",
      title: "Validate cost-driver inventory",
      status: "blocked",
      workerType: "codex",
      dependsOn: [],
      blockedReason: "ELB inventory is incomplete because DescribeLoadBalancers is denied.",
      isActive: false,
      isReady: false,
    },
    {
      taskId: "task_04",
      title: "Synthesize consumption insights and recommendations",
      status: "pending",
      workerType: "codex",
      dependsOn: ["task_03"],
      latestSummary: "Waiting for validated inventory evidence before synthesis can start.",
      isActive: false,
      isReady: false,
    },
  ] as const;
  const taskCards = plan.map((task) => ({
    ...task,
    taskKind: "planned",
    prompt: task.title,
    baseCommit: "abc1234",
    skillBundlePaths: [],
    contextRefs: [],
    artifactRefs: {},
    createdAt: 1,
    workspaceExists: false,
    workspaceDirty: false,
  }));
  const workbench = {
    summary: {
      objectiveId: "objective_demo",
      title: "Demo objective",
      status: "blocked",
      phase: "blocked",
      integrationStatus: "idle",
      slotState: "blocked",
      activeTaskCount: 0,
      readyTaskCount: 0,
      taskCount: taskCards.length,
      activeJobCount: 0,
      elapsedMinutes: 0,
      checks: [],
      checksCount: 0,
    },
    tasks: taskCards,
    jobs: [],
    activity: [],
    hasActiveExecution: false,
  } as const;
  const markup = factoryChatShell({
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    objectiveId: "objective_demo",
    chat: {
      activeProfileId: "generalist",
      activeProfileLabel: "Generalist",
      workbench,
      selectedThread: {
        objectiveId: "objective_demo",
        title: "Demo objective",
        status: "blocked",
        phase: "blocked",
        summary: "Demo summary",
        debugLink: "/debug",
        receiptsLink: "/receipts",
      },
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
      workbench,
      selectedObjective: {
        objectiveId: "objective_demo",
        title: "Demo objective",
        status: "blocked",
        phase: "blocked",
        summary: "Demo summary",
        debugLink: "/debug",
        receiptsLink: "/receipts",
        tokensUsed: 321,
      },
      activeRun: {
        runId: "run_demo",
        profileLabel: "Generalist",
        status: "completed",
        summary: "Run completed after auto-continuing.",
        updatedAt: 15,
      },
      tasks: taskCards,
    },
  });
  const inspectorMarkup = factoryInspectorIsland({
    panel: "execution",
    jobs: [],
    selectedObjective: {
      objectiveId: "objective_demo",
      title: "Demo objective",
      status: "blocked",
      phase: "blocked",
      summary: "Demo summary",
      debugLink: "/debug",
      receiptsLink: "/receipts",
    },
    tasks: taskCards,
  });

  expect(markup).toMatch(/id="factory-chat"[^>]+sse:agent-refresh throttle:180ms/);
  expect(markup).toMatch(/id="factory-sidebar"[^>]+sse:factory-refresh throttle:450ms[^"]+sse:job-refresh throttle:450ms/);
  expect(markup).toMatch(/id="factory-inspector-tabs"[^>]+sse:factory-refresh throttle:900ms[^"]+sse:job-refresh throttle:900ms/);
  expect(markup).toMatch(/id="factory-inspector-panel"[^>]+sse:factory-refresh throttle:450ms[^"]+sse:job-refresh throttle:450ms/);
  expect(markup).not.toMatch(/id="factory-sidebar"[^>]+sse:agent-refresh/);
  expect(markup).not.toMatch(/id="factory-inspector-tabs"[^>]+sse:agent-refresh/);
  expect(markup).not.toMatch(/id="factory-inspector-panel"[^>]+sse:agent-refresh/);
  expect(markup).not.toMatch(/data-prompt-fill/);
  expect(markup).not.toMatch(/\/ Commands/);
  expect(markup).toContain("data-composer-commands='");
  expect(markup).toContain("&quot;name&quot;:&quot;help&quot;");
  expect(markup).toMatch(/id="factory-composer-completions"[^>]+role="listbox"/);
  expect(markup).toMatch(/id="factory-composer-submit"[^>]+min-h-\[88px\]/);
  expect(markup).toContain('href="/factory/new-chat?profile=generalist"');
  expect(markup).toContain('aria-label="Start a new chat"');
  expect(markup).toContain("Objective blocked");
  expect(markup).toContain("Codex Token Usage");
  expect(markup).toContain("Rolled up from recorded candidate executions");
  expect(markup).toContain("Run completed");
  expect(markup).toContain("Tasks");
  expect(markup).toContain("Validate cost-driver inventory");
  expect(markup).toContain("Waiting on Validate cost-driver inventory");
  expect(inspectorMarkup).toContain("Validate cost-driver inventory");
  expect(inspectorMarkup).toContain("Synthesize consumption insights and recommendations");
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

test("factory sidebar state: stalled Codex jobs are labeled from progress timestamps, not heartbeats", () => {
  const originalNow = Date.now;
  Date.now = () => 200_000;
  try {
    const stalledCodexJob: QueueJob = {
      id: "job_codex_stalled",
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
      updatedAt: 199_000,
      result: {
        summary: "Running command: rg --files",
        progressAt: 50_000,
      },
      commands: [],
    };

    const card = buildActiveCodexCard([stalledCodexJob]);
    expect(card?.status).toBe("stalled");
    expect(card?.running).toBe(false);
    expect(card?.updatedAt).toBe(50_000);
  } finally {
    Date.now = originalNow;
  }
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

test("factory chat items: arrays of records in generic JSON finals render as markdown tables", () => {
  const runStream = "agents/factory/demo/runs/run_json_table";
  let prev: string | undefined;
  const push = (body: AgentEvent, index: number) => {
    const next = receipt(runStream, prev, body, index);
    prev = next.hash;
    return next;
  };
  const chain = [
    push({
      type: "problem.set",
      runId: "run_json_table",
      problem: "List the S3 buckets.",
      agentId: "orchestrator",
    }, 1),
    push({
      type: "response.finalized",
      runId: "run_json_table",
      agentId: "orchestrator",
      content: JSON.stringify({
        s3_buckets: [
          { name: "cloudscore1", region: "us-east-1" },
          { name: "cloudscoreradiusreport", region: "us-east-1" },
        ],
        next_best_action: "Check public access block if you need exposure risk next.",
      }),
    }, 2),
  ];

  const items = buildChatItemsForRun("run_json_table", chain, new Map());
  const finalItem = items.find((item) => item.kind === "assistant");
  const body = finalItem && finalItem.kind === "assistant" ? finalItem.body : "";
  expect(body).toContain("## S3 Buckets");
  expect(body).toContain("| Name | Region |");
  expect(body).toContain("| cloudscore1 | us-east-1 |");
  expect(body).toContain("## Next Best Action");
});

test("factory chat island: normalizes plain report scaffolding into markdown headings and lists", () => {
  const markup = factoryChatIsland({
    activeProfileId: "infrastructure",
    activeProfileLabel: "Infrastructure",
    items: [{
      key: "a1",
      kind: "assistant",
      body: [
        "Conclusion",
        "",
        "5 S3 buckets: 1) cloudscore1 2) cloudscoreradiusreport 3) lambdasam-3d3986c07d-us-east-1",
        "",
        "Evidence",
        "",
        "Listed 5 S3 buckets visible in the current AWS account.",
      ].join("\n"),
      meta: "completed",
    }],
  });

  expect(markup).toMatch(/<h[1-6]>Conclusion<\/h[1-6]>/);
  expect(markup).toMatch(/<h[23]>Evidence<\/h[23]>/);
  expect(markup).not.toContain("1. cloudscore1");
  expect(markup).toContain("<li>cloudscore1</li>");
});

test("factory chat island: promotes parenthetical headings, bolds list lead-ins, and uses the assistant response card", () => {
  const markup = factoryChatIsland({
    activeProfileId: "infrastructure",
    activeProfileLabel: "Infrastructure",
    items: [{
      key: "a2",
      kind: "assistant",
      body: [
        "Conclusion",
        "",
        "CloudTrail event history is blocked by access controls.",
        "",
        "Next (smallest unblock)",
        "",
        "Provide one of:",
        "",
        "- Permission: cloudtrail:LookupEvents",
        "- CloudTrail S3 log bucket + prefix",
      ].join("\n"),
      meta: "completed",
    }],
  });

  expect(markup).toContain("max-w-3xl");
  expect(markup).toContain("bg-card/90");
  expect(markup).toMatch(/<h[1-4]>Next \(smallest unblock\)<\/h[1-4]>/);
  expect(markup).toContain("<strong>Provide one of:</strong>");
});

test("factory sidebar island: humanizes objective slot labels and avoids repeating status in the compact meta row", () => {
  const selectedObjective = {
    objectiveId: "objective_waiting",
    title: "Fix iteration-3 issue",
    status: "planning",
    phase: "queued",
    summary: "Waiting for the repo execution slot (1 in queue).",
    debugLink: "/factory/api/objectives/objective_waiting/debug",
    receiptsLink: "/factory/api/objectives/objective_waiting/receipts?limit=50",
    slotState: "waiting_for_slot",
    queuePosition: 1,
  };
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
      status: "planning",
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
  }, selectedObjective);

  expect(markup).toMatch(/Fix iteration-3 issue/);
  expect(markup).toMatch(/Waiting For Slot \(q1\)/);
  expect(markup).toMatch(/See other threads/);
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

test("factory route: empty scoped chat skips global objective and job scans", async () => {
  let listJobsCalls = 0;
  let listObjectivesCalls = 0;
  const app = createRouteTestApp({
    onListJobs: () => {
      listJobsCalls += 1;
    },
    service: {
      listObjectives: async () => {
        listObjectivesCalls += 1;
        return [];
      },
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=test");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(listJobsCalls).toBe(0);
  expect(listObjectivesCalls).toBe(0);
  expect(body).toContain("No objective selected.");
});

test("factory run projection: reuses the folded run state for the same chain snapshot", () => {
  const runStream = "agents/factory/demo/runs/run_projection";
  let prev: string | undefined;
  const push = (body: AgentEvent, index: number) => {
    const next = receipt(runStream, prev, body, index);
    prev = next.hash;
    return next;
  };
  const chain = [
    push({
      type: "problem.set",
      runId: "run_projection",
      problem: "Check the cached run projection.",
      agentId: "factory",
    }, 1),
    push({
      type: "run.status",
      runId: "run_projection",
      status: "running",
      note: "Collecting context.",
      agentId: "factory",
    }, 2),
    push({
      type: "response.finalized",
      runId: "run_projection",
      content: "Projection cached.",
      agentId: "factory",
    }, 3),
    push({
      type: "run.status",
      runId: "run_projection",
      status: "completed",
      note: "Done.",
      agentId: "factory",
    }, 4),
  ];

  const first = projectAgentRun(chain);
  const second = projectAgentRun(chain);

  expect(second).toBe(first);
  expect(first.problem?.problem).toBe("Check the cached run projection.");
  expect(first.final?.content).toBe("Projection cached.");
  expect(first.state.status).toBe("completed");
});

test("factory route: explicit thread view hydrates transcript items from the objective stream", async () => {
  const objectiveStream = factoryChatStream(process.cwd(), "generalist", "objective_demo");
  const app = createRouteTestApp({
    agentEvents: {
      [objectiveStream]: [{
        type: "problem.set",
        runId: "run_objective",
        problem: "Check the objective stream transcript.",
      }],
      [agentRunStream(objectiveStream, "run_objective")]: [
        {
          type: "problem.set",
          runId: "run_objective",
          problem: "Check the objective stream transcript.",
        },
        {
          type: "tool.called",
          runId: "run_objective",
          iteration: 1,
          tool: "factory.status",
          input: { objectiveId: "objective_demo" },
          summary: "Objective still executing.",
          durationMs: 1_000,
        },
        {
          type: "tool.observed",
          runId: "run_objective",
          iteration: 1,
          tool: "factory.status",
          truncated: false,
          output: JSON.stringify({
            worker: "factory",
            action: "status",
            objectiveId: "objective_demo",
            status: "executing",
            summary: "Objective still executing.",
          }),
        },
      ],
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&thread=objective_demo");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Transcript");
  expect(body).toContain("Thread status");
  expect(body).toContain("Objective still executing.");
});

test("factory route: completed thread without chat receipts still surfaces the terminal summary in transcript", async () => {
  const completedObjective = {
    ...makeStubObjectiveDetail("objective_done"),
    status: "completed",
    phase: "completed",
    latestSummary: "No active CloudWatch alarms were present across the 17 queryable regions.",
    nextAction: "Investigation is complete.",
    activeTaskCount: 0,
    readyTaskCount: 0,
    tasks: [{
      taskId: "task_01",
      title: "Inspect CloudWatch alarms",
      workerType: "codex",
      status: "approved",
      dependsOn: [],
      workspaceExists: true,
      workspaceDirty: false,
      jobId: "job_done",
      jobStatus: "completed",
      latestSummary: "No active CloudWatch alarms were present across the 17 queryable regions.",
    }],
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;

  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        completedObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => completedObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&thread=objective_done");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("No active CloudWatch alarms were present across the 17 queryable regions.");
  expect(body).not.toContain("This thread is quiet.");
  expect(body).toContain(">1<");
});

test("factory route: blocked thread workbench does not present canceled tasks as running", async () => {
  const canceledObjective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_canceled"),
    status: "canceled",
    phase: "blocked",
    latestSummary: "canceled from UI",
    blockedReason: "canceled from UI",
    activeTaskCount: 0,
    readyTaskCount: 0,
    tasks: [{
      ...makeRunningWorkbenchObjectiveDetail("objective_canceled").tasks[0],
      status: "running",
      jobStatus: "canceled",
      latestSummary: "Running now.",
    }],
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;

  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        canceledObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => canceledObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&thread=objective_canceled");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("canceled from UI");
  expect(body).not.toContain("Running now.");
});

test("factory route: running task workbench renders above the transcript and auto-focuses the active task", async () => {
  const liveObjective = makeRunningWorkbenchObjectiveDetail("objective_live");
  const app = createRouteTestApp({
    jobs: [{
      id: "job_task_01",
      agentId: "codex",
      lane: "collect",
      singletonMode: "allow",
      payload: {
        kind: "factory.task.run",
        objectiveId: "objective_live",
        taskId: "task_01",
        candidateId: "candidate_01",
      },
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      createdAt: 1,
      updatedAt: 2,
      commands: [],
    } as QueueJob],
    liveOutput: {
      objectiveId: "objective_live",
      focusKind: "task",
      focusId: "task_01",
      title: "Implement mission shell",
      status: "running",
      active: true,
      summary: "Applying the mission shell patch.",
      taskId: "task_01",
      candidateId: "candidate_01",
      jobId: "job_task_01",
      lastMessage: "Wiring the running task workbench.",
      stdoutTail: "build ok",
      stderrTail: "",
    },
    service: {
      listObjectives: async () => [
        liveObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => liveObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&thread=objective_live");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Current");
  expect(body).toContain("Next");
  expect(body).toContain("Status");
  expect(body).toContain("Implement mission shell");
  expect(body).toContain("panel=live");
  expect(body).toContain("data-focus-kind=\"task\"");
  expect(body).toContain("data-focus-id=\"task_01\"");
});

test("factory route: recent agent thinking steps surface in the live thread shell", async () => {
  const objectiveId = "objective_live";
  const liveObjective = makeRunningWorkbenchObjectiveDetail(objectiveId);
  const profileId = "generalist";
  const runId = "run_live_reasoning";
  const stream = factoryChatStream(process.cwd(), profileId, objectiveId);
  const app = createRouteTestApp({
    agentEvents: {
      [stream]: [{
        type: "problem.set",
        runId,
        problem: "Summarize cost drivers for the active thread.",
        agentId: "orchestrator",
      }],
      [agentRunStream(stream, runId)]: [
        {
          type: "problem.set",
          runId,
          problem: "Summarize cost drivers for the active thread.",
          agentId: "orchestrator",
        },
        {
          type: "iteration.started",
          runId,
          iteration: 1,
          agentId: "orchestrator",
        },
        {
          type: "thought.logged",
          runId,
          iteration: 1,
          agentId: "orchestrator",
          content: "Wait for the objective's worker to finish and then summarize cost drivers.",
        },
        {
          type: "action.planned",
          runId,
          iteration: 1,
          agentId: "orchestrator",
          actionType: "tool",
          name: "factory.status",
          input: { objectiveId },
        },
        {
          type: "tool.called",
          runId,
          iteration: 1,
          agentId: "orchestrator",
          tool: "factory.status",
          input: { objectiveId },
          summary: "Checking thread status.",
        },
        {
          type: "tool.observed",
          runId,
          iteration: 1,
          agentId: "orchestrator",
          tool: "factory.status",
          truncated: false,
          output: JSON.stringify({
            objectiveId,
            status: "executing",
            summary: "Task worker is still running.",
          }),
        },
        {
          type: "memory.slice",
          runId,
          iteration: 1,
          agentId: "orchestrator",
          scope: "factory/objectives/objective_live",
          query: "recent cost driver receipts",
          chars: 380,
          itemCount: 2,
          truncated: false,
        },
        {
          type: "validation.report",
          runId,
          iteration: 1,
          agentId: "orchestrator",
          gate: "thread_active",
          ok: true,
          summary: "Thread still has active work.",
          target: objectiveId,
        },
      ],
    },
    service: {
      listObjectives: async () => [
        liveObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => liveObjective,
    },
  });

  const response = await app.request(`http://receipt.test/factory?profile=${profileId}&thread=${objectiveId}`);
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toMatch(/What(?:&#39;|')s Happening/);
  expect(body).toContain("Thinking");
  expect(body).toMatch(/Wait for the objective(?:&#39;|')s worker to finish and then summarize cost drivers\./);
  expect(body).toContain("Task worker is still running.");
  expect(body).toContain("Thread still has active work.");
});

test("factory route: explicit task focus survives in the running task workbench query state", async () => {
  const liveObjective = makeRunningWorkbenchObjectiveDetail("objective_live");
  const app = createRouteTestApp({
    liveOutput: {
      objectiveId: "objective_live",
      focusKind: "task",
      focusId: "task_02",
      title: "Tighten inspector focus",
      status: "queued",
      active: true,
      summary: "Waiting on task_01 before updating the inspector.",
      taskId: "task_02",
      lastMessage: "Focus stays pinned to task_02.",
      stdoutTail: "",
      stderrTail: "",
    },
    service: {
      listObjectives: async () => [
        liveObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => liveObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&thread=objective_live&focusKind=task&focusId=task_02");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("data-focus-kind=\"task\"");
  expect(body).toContain("data-focus-id=\"task_02\"");
  expect(body).toContain("Tighten inspector focus");
});

test("factory route: browser shell falls back to the compact thread view when no task is active", async () => {
  const objective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_idle"),
    activeTaskCount: 0,
    readyTaskCount: 0,
    tasks: [{
      taskId: "task_01",
      title: "Completed shell",
      prompt: "Done.",
      workerType: "codex",
      taskKind: "planned",
      status: "approved",
      dependsOn: [],
      workspaceExists: true,
      workspaceDirty: false,
      jobStatus: "completed",
    }],
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        objective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => objective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&thread=objective_idle");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).not.toContain("Running Task Workbench");
  expect(body).toContain("Tasks");
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

test("factory route: inspector execution panel shows focused completed task output", async () => {
  const objective = {
    ...makeStubObjectiveDetail("objective_done", "job_task_02"),
    status: "completed",
    phase: "completed",
    activeTaskCount: 0,
    readyTaskCount: 0,
    latestSummary: "Inventory capture finished successfully.",
    tasks: [{
      taskId: "task_02",
      title: "Summarize inventory results",
      prompt: "Summarize the final infrastructure inventory findings.",
      workerType: "codex",
      taskKind: "planned",
      status: "approved",
      dependsOn: [],
      workspaceExists: true,
      workspaceDirty: false,
      jobId: "job_task_02",
      jobStatus: "completed",
      candidateId: "candidate_01",
      latestSummary: "Recorded the final inventory counts.",
      lastMessage: "Found 12 buckets across 3 regions.",
      stdoutTail: "bucket-a\nbucket-b",
      stderrTail: "",
    }],
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;

  const app = createRouteTestApp({
    liveOutput: {
      objectiveId: "objective_done",
      focusKind: "task",
      focusId: "task_02",
      title: "Summarize inventory results",
      status: "completed",
      active: false,
      summary: "Recorded the final inventory counts.",
      taskId: "task_02",
      candidateId: "candidate_01",
      jobId: "job_task_02",
      lastMessage: "Found 12 buckets across 3 regions.",
      stdoutTail: "bucket-a\nbucket-b",
      stderrTail: "",
    },
    service: {
      listObjectives: async () => [
        objective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => objective,
    },
  });

  const response = await app.request("http://receipt.test/factory/island/inspector?profile=generalist&thread=objective_done&panel=execution&focusKind=task&focusId=task_02");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Focused Output");
  expect(body).toContain("Summarize inventory results");
  expect(body).toContain("Found 12 buckets across 3 regions.");
  expect(body).toContain("bucket-a");
});

test("factory route: inspector receipts panel preserves preloaded receipts", async () => {
  const objective = makeRunningWorkbenchObjectiveDetail("objective_receipts");
  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        objective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => objective,
      listObjectiveReceipts: async () => objective.recentReceipts,
    },
  });

  const response = await app.request("http://receipt.test/factory/island/inspector/select?profile=generalist&thread=objective_receipts&panel=receipts");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).not.toContain("No receipts found.");
  expect(body).toContain("rebracket.applied");
  expect(body).toContain("Factory kept task_01 at the frontier.");
});

test("factory route: new chat creates an isolated chat session", async () => {
  const app = createRouteTestApp();

  const response = await app.request("http://receipt.test/factory/new-chat?profile=generalist");

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toMatch(/^\/factory\?profile=generalist&chat=chat_[a-z0-9]+_[a-z0-9]+$/);
});

test("factory route: blank composer submissions create a session-bound objective and queued run", async () => {
  let queuedInput: Record<string, unknown> | undefined;
  let createdInput: Record<string, unknown> | undefined;
  const app = createRouteTestApp({
    onEnqueue: async (input) => {
      queuedInput = input;
      return {
        id: "job_chat_blank",
        agentId: "factory",
        payload: (input.payload as Record<string, unknown> | undefined) ?? {},
        lane: "chat",
        status: "queued",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 10,
        updatedAt: 11,
        commands: [],
      } as QueueJob;
    },
    service: {
      createObjective: async (input: Record<string, unknown>) => {
        createdInput = input;
        return makeStubObjectiveDetail("objective_created", "job_created");
      },
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
  expect(response.headers.get("location")).toMatch(/^\/factory\?profile=generalist&chat=chat_[a-z0-9]+_[a-z0-9]+&thread=objective_created&run=run_[a-z0-9]+_[a-z0-9]+&job=job_chat_blank$/);
  expect(createdInput).toMatchObject({
    title: "Start fresh",
    prompt: "Start fresh.",
    profileId: "generalist",
    startImmediately: true,
  });
  expect(queuedInput).toMatchObject({
    agentId: "factory",
    lane: "chat",
    singletonMode: "allow",
  });
  expect((queuedInput?.payload as Record<string, unknown> | undefined)?.chatId).toMatch(/^chat_[a-z0-9]+_[a-z0-9]+$/);
  expect((queuedInput?.payload as Record<string, unknown> | undefined)?.objectiveId).toBe("objective_created");
});
test("factory route: composer accepts UI chat submissions and redirects into queued run context", async () => {
  let queuedInput: Record<string, unknown> | undefined;
  let createdInput: Record<string, unknown> | undefined;
  const app = createRouteTestApp({
    onEnqueue: async (input) => {
      queuedInput = input;
      return {
        id: "job_chat_01",
        agentId: "factory",
        payload: (input.payload as Record<string, unknown> | undefined) ?? {},
        lane: "chat",
        status: "queued",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 10,
        updatedAt: 11,
        commands: [],
      } as QueueJob;
    },
    service: {
      createObjective: async (input: Record<string, unknown>) => {
        createdInput = input;
        return makeStubObjectiveDetail("objective_created", "job_created");
      },
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
  expect(response.headers.get("location")).toMatch(/^\/factory\?profile=generalist&chat=chat_demo&thread=objective_created&run=run_[a-z0-9]+_[a-z0-9]+&job=job_chat_01$/);
  expect(createdInput).toMatchObject({
    title: "Check the repo and tell me what happens next",
    prompt: "Check the repo and tell me what happens next.",
    profileId: "generalist",
    startImmediately: true,
  });
  expect(queuedInput).toMatchObject({
    agentId: "factory",
    lane: "chat",
    singletonMode: "allow",
  });
  expect((queuedInput?.payload as Record<string, unknown> | undefined)).toMatchObject({
    kind: "factory.run",
    profileId: "generalist",
    chatId: "chat_demo",
    objectiveId: "objective_created",
    problem: "Check the repo and tell me what happens next.",
  });
});

test("factory route: software diagnostic prompts create investigation objectives", async () => {
  let createdInput: Record<string, unknown> | undefined;
  const app = createRouteTestApp({
    service: {
      createObjective: async (input: Record<string, unknown>) => {
        createdInput = input;
        return makeStubObjectiveDetail("objective_diag", "job_diag");
      },
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=software&chat=chat_software", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "why is build failing",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(createdInput).toMatchObject({
    title: "Investigate: why is build failing",
    objectiveMode: "investigation",
    profileId: "software",
    startImmediately: true,
  });
  expect(createdInput?.prompt).toBe([
    "why is build failing",
    "",
    "Treat this as an investigation request. Determine the concrete root cause from evidence before proposing or applying fixes.",
  ].join("\n"));
});

test("factory route: follow-up composer submissions stop pinning the URL to a completed thread", async () => {
  let queuedInput: Record<string, unknown> | undefined;
  const completed = {
    ...makeStubObjectiveDetail("objective_done", "job_done"),
    status: "completed",
    phase: "completed",
    latestSummary: "Completed objective summary",
    nextAction: "Start a follow-up objective for more work.",
  };
  const app = createRouteTestApp({
    onEnqueue: async (input) => {
      queuedInput = input;
      return {
        id: "job_chat_followup",
        agentId: "factory",
        payload: (input.payload as Record<string, unknown> | undefined) ?? {},
        lane: "chat",
        status: "queued",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 10,
        updatedAt: 11,
        commands: [],
      } as QueueJob;
    },
    service: {
      listObjectives: async () => [
        completed as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => completed,
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&chat=chat_demo&thread=objective_done", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "Continue with the next piece of work.",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toMatch(/^\/factory\?profile=generalist&chat=chat_demo&run=run_[a-z0-9]+_[a-z0-9]+&job=job_chat_followup$/);
  expect(response.headers.get("location")).not.toContain("thread=objective_done");
  expect((queuedInput?.payload as Record<string, unknown> | undefined)).toMatchObject({
    kind: "factory.run",
    profileId: "generalist",
    chatId: "chat_demo",
    objectiveId: "objective_done",
    problem: "Continue with the next piece of work.",
  });
});

test("factory route: composer recovers the bound objective from chat session receipts when thread is missing", async () => {
  let queuedInput: Record<string, unknown> | undefined;
  const sessionStream = factoryChatSessionStream(process.cwd(), "generalist", "chat_demo");
  const app = createRouteTestApp({
    agentEvents: {
      [sessionStream]: [{
        type: "problem.set",
        runId: "run_bound",
        problem: "Start this thread.",
      }],
      [agentRunStream(sessionStream, "run_bound")]: [
        {
          type: "problem.set",
          runId: "run_bound",
          problem: "Start this thread.",
        },
        {
          type: "thread.bound",
          runId: "run_bound",
          objectiveId: "objective_bound",
          chatId: "chat_demo",
          reason: "startup",
        },
      ],
    },
    onEnqueue: async (input) => {
      queuedInput = input;
      return {
        id: "job_chat_bound",
        agentId: "factory",
        payload: (input.payload as Record<string, unknown> | undefined) ?? {},
        lane: "chat",
        status: "queued",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 10,
        updatedAt: 11,
        commands: [],
      } as QueueJob;
    },
    service: {
      listObjectives: async () => [
        makeStubObjectiveDetail("objective_bound", "job_bound") as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => makeStubObjectiveDetail("objective_bound", "job_bound"),
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&chat=chat_demo", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "Keep this thread moving.",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toMatch(/^\/factory\?profile=generalist&chat=chat_demo&thread=objective_bound&run=run_[a-z0-9]+_[a-z0-9]+&job=job_chat_bound$/);
  expect(queuedInput).toMatchObject({
    agentId: "factory",
    lane: "chat",
    singletonMode: "allow",
  });
  expect((queuedInput?.payload as Record<string, unknown> | undefined)).toMatchObject({
    chatId: "chat_demo",
    objectiveId: "objective_bound",
    problem: "Keep this thread moving.",
  });
});

test("factory route: /new starts a fresh chat thread instead of reusing the current one", async () => {
  let createdInput: Record<string, unknown> | undefined;
  const app = createRouteTestApp({
    service: {
      createObjective: async (input: Record<string, unknown>) => {
        createdInput = input;
        return makeStubObjectiveDetail("objective_created", "job_created");
      },
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&chat=chat_current&thread=objective_old", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "/new Build the replacement thread.",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toMatch(/^\/factory\?profile=generalist&chat=chat_[a-z0-9]+_[a-z0-9]+&thread=objective_created$/);
  expect(response.headers.get("location")).not.toContain("chat_current");
  expect(response.headers.get("location")).not.toContain("objective_old");
  expect(createdInput).toMatchObject({
    title: "Build the replacement thread",
    prompt: "Build the replacement thread.",
    profileId: "generalist",
    startImmediately: true,
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

test("factory route: slash command aborts the active job via the composer submit flow", async () => {
  let abortInput: { readonly jobId: string; readonly reason?: string; readonly by?: string } | undefined;
  const activeJob = {
    id: "job_01",
    agentId: "factory",
    lane: "chat",
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
      queueJobAbort: async (jobId: string, reason?: string, by?: string) => {
        abortInput = { jobId, reason, by };
        return makeStubJobQueueResult(jobId);
      },
    },
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
