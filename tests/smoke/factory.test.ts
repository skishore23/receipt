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
import { createRuntime, type Runtime } from "@receipt/core/runtime";
import { SseHub } from "../../src/framework/sse-hub";
import type { AgentLoaderContext } from "../../src/framework/agent-types";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";
import { syncObjectiveProjectionStream } from "../../src/db/projectors";
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
import { factoryChatShell } from "../../src/views/factory/shell";
import { factorySidebarIsland } from "../../src/views/factory/sidebar";
import { factoryChatIsland } from "../../src/views/factory/workbench";
import { factoryInspectorIsland } from "../../src/views/factory-inspector";
import { buildFactoryWorkbenchShellSnapshot, factoryWorkbenchHeaderIsland } from "../../src/views/factory/workbench/page";
import { buildFactoryWorkbench } from "../../src/views/factory-workbench";
import type { FactoryWorkbenchPageModel } from "../../src/views/factory-models";
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
      build: "workspace-tool && receipt --help >/dev/null && test -f node_modules/htmx.org/dist/htmx.min.js && test -f node_modules/htmx-ext-sse/sse.js && echo build-ok",
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
  await fs.mkdir(path.join(repoRoot, "node_modules", "htmx-ext-sse"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "node_modules", "htmx-ext-sse", "sse.js"), "/* htmx ext sse */\n", "utf-8");
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
  contract: {
    acceptanceCriteria: [
      "Implement the requested delivery objective: Demo objective.",
      "Keep the shipped change aligned with the objective prompt and avoid unrelated scope.",
    ],
    allowedScope: ["Implement only the requested objective."],
    disallowedScope: ["Avoid unrelated refactors."],
    requiredChecks: [],
    proofExpectation: "Return concrete changed files and validation evidence.",
  },
  alignment: {
    verdict: "aligned",
    satisfied: ["Implement the requested delivery objective: Demo objective."],
    missing: [],
    outOfScope: [],
    rationale: "The latest candidate stayed within the objective contract.",
    gateStatus: "passed",
    correctionAttempted: false,
    correctedAfterReview: false,
    sourceTaskId: "task_01",
    sourceCandidateId: "candidate_01",
  },
  profile: {
    rootProfileId: "generalist",
    rootProfileLabel: "Generalist",
  },
  policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
  contextSources: {},
  budgetState: { elapsedMinutes: 0 },
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
  budgetState: { elapsedMinutes: 8 },
  tokensUsed: 321,
  latestDecision: {
    summary: "Focus task_01 until the shell patch is stable.",
    at: 10,
    source: "runtime",
  },
  contract: {
    acceptanceCriteria: [
      "Keep the workbench summary visible while the run is active.",
      "Keep runtime progress and task evidence easy to scan.",
    ],
    allowedScope: ["Limit changes to the workbench shell and objective presentation."],
    disallowedScope: ["Do not broaden into unrelated orchestration work."],
    requiredChecks: ["bun test tests/smoke/factory-client.test.ts"],
    proofExpectation: "Show the active task, live logs, and status without losing the objective frame.",
  },
  alignment: {
    verdict: "aligned",
    satisfied: [
      "Keep the workbench summary visible while the run is active.",
      "Keep runtime progress and task evidence easy to scan.",
    ],
    missing: [],
    outOfScope: [],
    rationale: "The current live objective output matches the shell objective contract.",
    gateStatus: "passed",
    correctionAttempted: false,
    correctedAfterReview: false,
    sourceTaskId: "task_01",
    sourceCandidateId: "candidate_01",
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
    rootProfileId: detail.profile.rootProfileId || "generalist",
    rootProfileLabel: detail.profile.rootProfileLabel || "Generalist",
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
  readonly captureAgentEventStore?: (store: Map<string, AgentEvent[]>) => void;
  readonly onSubscribeMany?: (subscriptions: ReadonlyArray<{ readonly topic: string; readonly stream?: string }>) => void;
  readonly onListJobs?: (limit?: number) => void;
  readonly onEnqueue?: (input: Record<string, unknown>) => QueueJob | Promise<QueueJob>;
  readonly service?: Partial<Pick<
    FactoryService,
    | "buildBoardProjection"
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
    | "projectionVersionFresh"
  >>;
}): Hono => {
  const enqueuedJobs = new Map<string, QueueJob>();
  const agentEventStore = new Map<string, AgentEvent[]>(
    Object.entries(overrides?.agentEvents ?? {}).map(([streamKey, events]) => [streamKey, [...events]]),
  );
  overrides?.captureAgentEventStore?.(agentEventStore);
  const receiptChain = (streamKey: string) => {
    const events = agentEventStore.get(streamKey) ?? [];
    let prev: string | undefined;
    return events.map((event, index) => {
      const next = receipt(streamKey, prev, event, index + 1);
      prev = next.hash;
      return next;
    });
  };
  const dummyRuntime = {
    execute: async (streamKey: string, cmd: { readonly event?: AgentEvent }) => {
      const event = cmd.event;
      if (event) {
        const chain = agentEventStore.get(streamKey) ?? [];
        chain.push(event);
        agentEventStore.set(streamKey, chain);
      }
      return event ? [event] : [];
    },
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
    buildBoardProjection: async (input?: string | { readonly selectedObjectiveId?: string; readonly profileId?: string }) => ({
      objectives: [],
      sections: {
        needs_attention: [],
        active: [],
        queued: [],
        completed: [],
      },
      selectedObjectiveId: typeof input === "string" ? input : input?.selectedObjectiveId,
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
  expect(jobs[0]?.singletonMode).toBe("steer");
});

test("factory service: objective lists refresh after an external projection write", async () => {
  const dataDir = await createTempDir("receipt-factory-external-projection");
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
    title: "Projection freshness",
    prompt: "Keep cached objective lists in sync with external projection updates.",
    checks: ["git status --short"],
  });

  const initialCards = await service.listObjectives();
  expect(initialCards.find((card) => card.objectiveId === created.objectiveId)?.status).not.toBe("blocked");

  const stream = `factory/objectives/${created.objectiveId}`;
  const blockedAt = Date.now();
  const internals = service as unknown as {
    readonly dataDir: string;
    readonly runtime: Runtime<FactoryCmd, FactoryEvent, FactoryState>;
  };
  await internals.runtime.execute(stream, {
    event: {
      type: "objective.blocked",
      objectiveId: created.objectiveId,
      reason: "external projection write",
      summary: "external projection write",
      blockedAt,
    },
  });
  await syncObjectiveProjectionStream(internals.dataDir, internals.runtime, stream);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("blocked");

  const refreshedCards = await service.listObjectives();
  const refreshedCard = refreshedCards.find((card) => card.objectiveId === created.objectiveId);
  expect(refreshedCard?.status).toBe("blocked");
  expect(refreshedCard?.blockedReason).toBe("external projection write");

  const board = await service.buildBoardProjection(created.objectiveId);
  expect(board.sections.needs_attention.some((card) => card.objectiveId === created.objectiveId)).toBe(true);
});

test("factory service: task live output marks stale Codex work as stalled and surfaces raw stdout", async () => {
  const dataDir = await createTempDir("receipt-factory-live-output-stalled");
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
    title: "Live output stalled state",
    prompt: "Show whether the current Codex task is still making progress.",
    checks: ["git status --short"],
  });

  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = (await queue.listJobs({ limit: 20 }))
    .find((job) => job.payload.kind === "factory.task.run" && job.payload.objectiveId === created.objectiveId);
  expect(taskJob).toBeDefined();
  if (!taskJob) throw new Error("expected dispatched task job");

  const workerId = "worker_test:codex";
  const payload = taskJob.payload as FactoryTaskJobPayload;
  await queue.leaseJob(taskJob.id, workerId, 900_000);
  await fs.mkdir(path.dirname(payload.stdoutPath), { recursive: true });
  await fs.writeFile(
    payload.stdoutPath,
    "{\"type\":\"thread.started\"}\n{\"type\":\"turn.started\"}\n",
    "utf-8",
  );
  await fs.writeFile(payload.stderrPath, "", "utf-8");
  await fs.writeFile(payload.lastMessagePath, "", "utf-8");
  await queue.progress(taskJob.id, workerId, {
    worker: "codex",
    status: "running",
    summary: "Codex started working.",
    progressAt: 1,
    stdoutTail: "{\"type\":\"thread.started\"}\n{\"type\":\"turn.started\"}",
  });

  const liveOutput = await service.getObjectiveLiveOutput(created.objectiveId, "task", "task_01");

  expect(liveOutput.status).toBe("stalled");
  expect(liveOutput.active).toBe(false);
  expect(liveOutput.stdoutTail).toContain("\"type\":\"thread.started\"");
  expect(liveOutput.summary).toContain("\"type\":\"turn.started\"");
});

test("factory service: duplicate objective control enqueues steer onto the existing session job", async () => {
  const dataDir = await createTempDir("receipt-factory-control-steer");
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
    title: "Control steer",
    prompt: "Collapse repeated control enqueues into one queued job.",
    checks: ["git status --short"],
  });

  const initialControl = (await queue.listJobs({ limit: 10 }))
    .find((job) => job.agentId === "factory-control");
  expect(initialControl?.singletonMode).toBe("steer");

  const internals = service as unknown as {
    enqueueObjectiveControl(objectiveId: string, reason: "startup" | "admitted" | "reconcile"): Promise<void>;
  };
  await internals.enqueueObjectiveControl(created.objectiveId, "reconcile");

  const controlJobs = (await queue.listJobs({ limit: 10 }))
    .filter((job) => job.agentId === "factory-control");
  expect(controlJobs).toHaveLength(1);
  expect(controlJobs[0]?.id).toBe(initialControl?.id);

  const commands = await queue.consumeCommands(initialControl!.id, ["steer"]);
  expect(commands).toHaveLength(1);
  expect(commands[0]?.payload).toMatchObject({
    fromSessionKey: `factory:objective:${created.objectiveId}`,
    fromEnqueue: true,
    payload: {
      kind: "factory.objective.control",
      objectiveId: created.objectiveId,
      reason: "reconcile",
    },
  });
});

test("factory service: concurrent objective control requests collapse to one job id", async () => {
  const dataDir = await createTempDir("receipt-factory-control-idempotent");
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
    title: "Concurrent control idempotency",
    prompt: "Ensure repeated control dispatches reuse the same job.",
    checks: ["git status --short"],
  });

  const internals = service as unknown as {
    enqueueObjectiveControl(objectiveId: string, reason: "startup" | "admitted" | "reconcile"): Promise<void>;
  };

  await Promise.all([
    internals.enqueueObjectiveControl(created.objectiveId, "reconcile"),
    internals.enqueueObjectiveControl(created.objectiveId, "reconcile"),
  ]);

  const controlJobs = (await queue.listJobs({ limit: 10 }))
    .filter((job) => job.agentId === "factory-control");
  expect(controlJobs).toHaveLength(1);
  expect(controlJobs[0]?.sessionKey).toBe(`factory:objective:${created.objectiveId}`);
  expect(controlJobs[0]?.id).toBe(`factory:objective:${created.objectiveId}:control`);
});

test("factory service: steered objective control jobs are redriven when the queued job already exists", async () => {
  const dataDir = await createTempDir("receipt-factory-control-redrive");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const redrivenJobIds: string[] = [];
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
    redriveQueuedJob: async (job) => {
      redrivenJobIds.push(job.id);
    },
  });

  const created = await service.createObjective({
    title: "Control redrive",
    prompt: "Redrive the queued control job when later reconciles steer onto it.",
    checks: ["git status --short"],
  });

  const initialControl = (await queue.listJobs({ limit: 10 }))
    .find((job) => job.agentId === "factory-control");
  expect(initialControl?.id).toBeTruthy();

  const internals = service as unknown as {
    enqueueObjectiveControl(objectiveId: string, reason: "startup" | "admitted" | "reconcile"): Promise<void>;
  };
  await internals.enqueueObjectiveControl(created.objectiveId, "reconcile");

  expect(redrivenJobIds).toEqual([initialControl!.id]);
});

test("factory service: resumeObjectives cancels queued control jobs for blocked objectives", async () => {
  const dataDir = await createTempDir("receipt-factory-control-cleanup");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const redrivenJobIds: string[] = [];
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
    redriveQueuedJob: async (job) => {
      redrivenJobIds.push(job.id);
    },
  });

  const created = await service.createObjective({
    title: "Blocked control cleanup",
    prompt: "Cancel stale control jobs once the objective is already blocked.",
    checks: ["git status --short"],
  });

  const internals = service as unknown as {
    emitObjective(objectiveId: string, event: {
      readonly type: "objective.blocked";
      readonly objectiveId: string;
      readonly reason: string;
      readonly summary: string;
      readonly blockedAt: number;
    } | {
      readonly type: "objective.slot.released";
      readonly objectiveId: string;
      readonly releasedAt: number;
      readonly reason: string;
    }): Promise<void>;
  };
  const blockedAt = Date.now();
  await internals.emitObjective(created.objectiveId, {
    type: "objective.blocked",
    objectiveId: created.objectiveId,
    reason: "blocked for cleanup test",
    summary: "blocked for cleanup test",
    blockedAt,
  });
  await internals.emitObjective(created.objectiveId, {
    type: "objective.slot.released",
    objectiveId: created.objectiveId,
    releasedAt: blockedAt + 1,
    reason: "slot released after objective entered blocked",
  });

  const duplicateA = await queue.enqueue({
    agentId: "factory-control",
    lane: "collect",
    sessionKey: `factory:objective:${created.objectiveId}`,
    singletonMode: "allow",
    maxAttempts: 2,
    payload: {
      kind: "factory.objective.control",
      objectiveId: created.objectiveId,
      reason: "admitted",
    },
  });
  const duplicateB = await queue.enqueue({
    agentId: "factory-control",
    lane: "collect",
    sessionKey: `factory:objective:${created.objectiveId}`,
    singletonMode: "allow",
    maxAttempts: 2,
    payload: {
      kind: "factory.objective.control",
      objectiveId: created.objectiveId,
      reason: "reconcile",
    },
  });

  await service.resumeObjectives();

  expect((await queue.getJob(duplicateA.id))?.status).toBe("canceled");
  expect((await queue.getJob(duplicateB.id))?.status).toBe("canceled");
  expect(redrivenJobIds).toEqual([]);
});

test("factory service: dirty worktree objectives auto-pin the committed head and record a warning", async () => {
  const dataDir = await createTempDir("receipt-factory-dirty-source");
  const repoRoot = await createSourceRepo();
  await fs.writeFile(path.join(repoRoot, "DIRTY_NOTE.txt"), "local-only change\n", "utf-8");
  const expectedBaseHash = await git(repoRoot, ["rev-parse", "HEAD"]);
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
    title: "Dirty worktree objective",
    prompt: "Run against the committed repo while local changes stay unstaged.",
    checks: ["git status --short"],
  });

  expect(created.baseHash).toBe(expectedBaseHash);
  expect(created.sourceWarnings).toEqual([
    expect.stringContaining(`Pinned Factory worktrees to committed HEAD ${expectedBaseHash.slice(0, 8)}`),
  ]);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.baseHash).toBe(expectedBaseHash);
  expect(detail.sourceWarnings).toEqual(created.sourceWarnings);
});

test("factory service: reactObjective redrives active queued task jobs", async () => {
  const dataDir = await createTempDir("receipt-factory-redrive");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const redrivenJobIds: string[] = [];
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
    redriveQueuedJob: async (job) => {
      redrivenJobIds.push(job.id);
    },
  });

  const created = await service.createObjective({
    title: "Queued task recovery",
    prompt: "Re-drive active queued task jobs after startup recovery.",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const detail = await service.getObjective(created.objectiveId);
  const activeQueuedTask = detail.tasks.find((task) =>
    task.status === "running"
    && task.jobStatus === "queued"
    && typeof task.jobId === "string",
  );
  expect(activeQueuedTask?.jobId).toBeDefined();

  await service.reactObjective(created.objectiveId);

  expect(redrivenJobIds).toEqual([activeQueuedTask!.jobId!]);
});

test("factory service: resumeObjectives redrives active queued task jobs before queueing fallback control", async () => {
  const dataDir = await createTempDir("receipt-factory-resume-redrive");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const redrivenJobIds: string[] = [];
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
    redriveQueuedJob: async (job) => {
      redrivenJobIds.push(job.id);
    },
  });

  const created = await service.createObjective({
    title: "Resume queued task recovery",
    prompt: "Resume active queued task jobs locally before queueing a fallback control job.",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const detail = await service.getObjective(created.objectiveId);
  const activeQueuedTask = detail.tasks.find((task) =>
    task.status === "running"
    && task.jobStatus === "queued"
    && typeof task.jobId === "string",
  );
  expect(activeQueuedTask?.jobId).toBeDefined();

  const controlJobsBefore = (await queue.listJobs({ limit: 20 }))
    .filter((job) => job.agentId === "factory-control")
    .length;

  await service.resumeObjectives();

  const controlJobsAfter = (await queue.listJobs({ limit: 20 }))
    .filter((job) => job.agentId === "factory-control")
    .length;

  expect(redrivenJobIds).toEqual([activeQueuedTask!.jobId!]);
  expect(controlJobsAfter).toBe(controlJobsBefore);
});

test("factory service: getObjective reads task jobs without scanning the full queue index", async () => {
  const dataDir = await createTempDir("receipt-factory-objective-task-job");
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
    title: "Task-job objective detail",
    prompt: "Ensure objective detail reads task jobs directly instead of scanning the whole queue.",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  if (!jobRuntime.listStreams) {
    throw new Error("expected job runtime listStreams to exist for this regression");
  }
  const originalListStreams = jobRuntime.listStreams.bind(jobRuntime);
  jobRuntime.listStreams = (async (prefix?: string) => {
    if (prefix === "jobs/") {
      throw new Error("getObjective should not scan jobs/");
    }
    return originalListStreams(prefix);
  }) as typeof jobRuntime.listStreams;

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.tasks.some((task) => Boolean(task.jobId))).toBe(true);
  expect(detail.tasks.some((task) => Boolean(task.job))).toBe(true);
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
}, 15_000);

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
test("factory reducer: task.noop_completed marks the approved candidate as noop-terminal", () => {
  const base = [
    {
      type: "objective.created",
      objectiveId: "objective_noop_replay",
      title: "Replay noop completion",
      prompt: "Confirm the objective is already satisfied.",
      channel: "results",
      baseHash: "abc1234",
      objectiveMode: "delivery",
      severity: 1,
      checks: [],
      checksSource: "default",
      profile: DEFAULT_FACTORY_OBJECTIVE_PROFILE,
      policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
      createdAt: 1,
    },
    {
      type: "task.added",
      objectiveId: "objective_noop_replay",
      createdAt: 2,
      task: {
        nodeId: "task_01",
        taskId: "task_01",
        taskKind: "planned",
        title: "Confirm existing state",
        prompt: "Confirm the objective is already satisfied.",
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
      type: "candidate.created",
      objectiveId: "objective_noop_replay",
      createdAt: 3,
      candidate: {
        candidateId: "task_01_candidate_01",
        taskId: "task_01",
        status: "planned",
        baseCommit: "abc1234",
        checkResults: [],
        artifactRefs: {},
        createdAt: 3,
        updatedAt: 3,
      },
    },
    {
      type: "candidate.reviewed",
      objectiveId: "objective_noop_replay",
      candidateId: "task_01_candidate_01",
      taskId: "task_01",
      status: "approved",
      summary: "Approved with no repository diff.",
      handoff: "The existing state already satisfies the objective.",
      reviewedAt: 4,
    },
    {
      type: "task.noop_completed",
      objectiveId: "objective_noop_replay",
      taskId: "task_01",
      candidateId: "task_01_candidate_01",
      summary: "Approved with no repository diff.",
      completedAt: 5,
    },
  ] as const satisfies ReadonlyArray<FactoryEvent>;

  const replay = base.reduce(reduceFactory, initialFactoryState);

  expect(replay.workflow.tasksById.task_01?.status).toBe("approved");
  expect(replay.workflow.tasksById.task_01?.completedAt).toBe(5);
  expect(replay.workflow.tasksById.task_01?.latestSummary).toBe("Approved with no repository diff.");
  expect(replay.candidates.task_01_candidate_01?.status).toBe("approved");
  expect(replay.candidates.task_01_candidate_01?.integrationDisposition).toBe("noop");
  expect(replay.candidates.task_01_candidate_01?.updatedAt).toBe(5);
  expect(replay.latestSummary).toBe("Approved with no repository diff.");
});

test("factory projection: sparse workflow and candidate arrays no longer backfill mapped records", () => {
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

  expect(projection.tasks).toEqual([]);
  expect(projection.readyTasks).toEqual([]);
  expect(projection.candidates).toEqual([]);
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
  expect(markup).toContain("Need to stop this job?");
  expect(markup).toMatch(/Generalist/);
  expect(markup).not.toMatch(/Selected profile/);
  expect(markup).toMatch(/replaced the old <code>\/factory<\/code> dashboard/);
});

test("factory chat island: live output cards lead with progress and keep raw controls secondary", () => {
  const markup = factoryChatIsland({
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    items: [{
      key: "w-live",
      kind: "work",
      card: {
        key: "factory-output-1",
        title: "Live task output",
        worker: "factory",
        status: "running",
        summary: "Command completed: /bin/zsh -lc \"set -euo pipefail\"",
        detail: "Title: Which EC2 instances are publicly reachable\nTask: task_01",
        meta: "3s",
        jobId: "job_factory_01",
        taskId: "task_01",
        candidateId: "task_01_candidate_01",
        subject: "Which EC2 instances are publicly reachable",
        latestNote: "Examining AWS account scope.",
        stdoutTail: "#!/usr/bin/env bash\nset -euo pipefail",
        variant: "live-output",
        focusKind: "task",
        running: true,
      },
    }],
  });

  expect(markup).toContain("Task Update");
  expect(markup).toContain("Working on Which EC2 instances are publicly reachable");
  expect(markup).toContain("Examining AWS account scope.");
  expect(markup).toContain("Recent output");
  expect(markup).toContain("More details");
  expect(markup).toContain("Need to stop this job?");
  expect(markup).not.toContain('Command completed: /bin/zsh -lc "set -euo pipefail"');
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

test("factory chat items: objective handoff runs render the durable handoff without a synthetic user echo", () => {
  const runStream = "agents/factory/demo/runs/run_objective_handoff";
  let prev: string | undefined;
  const push = (body: AgentEvent, index: number) => {
    const next = receipt(runStream, prev, body, index);
    prev = next.hash;
    return next;
  };
  const chain = [
    push({
      type: "problem.set",
      runId: "run_objective_handoff",
      problem: "Objective handoff for Investigate NAT gateway cost spike",
      agentId: "orchestrator",
    }, 1),
    push({
      type: "thread.bound",
      runId: "run_objective_handoff",
      objectiveId: "objective_demo",
      chatId: "chat_demo",
      reason: "dispatch_update",
    }, 2),
    push({
      type: "objective.handoff",
      runId: "run_objective_handoff",
      objectiveId: "objective_demo",
      title: "Investigate NAT gateway cost spike",
      status: "blocked",
      summary: "We proved it was a one-day NAT data-processing surge.",
      blocker: "Historical NAT and flow-log records are missing, so attribution is still unresolved.",
      nextAction: "Use /react with retained evidence or close with an inconclusive conclusion.",
      handoffKey: "handoff_demo",
      sourceUpdatedAt: 1_710_000_000_000,
    }, 3),
    push({
      type: "run.status",
      runId: "run_objective_handoff",
      agentId: "orchestrator",
      status: "completed",
      note: "objective blocked handoff",
    }, 4),
  ];

  const items = buildChatItemsForRun("run_objective_handoff", chain, new Map());

  expect(items.some((item) => item.kind === "user")).toBe(false);
  const handoff = items.find((item) => item.kind === "assistant");
  expect(handoff && handoff.kind === "assistant" ? handoff.meta : "").toBe("Blocked handoff");
  expect(handoff && handoff.kind === "assistant" ? handoff.body : "").toContain("is blocked and handed back to Chat.");
  expect(handoff && handoff.kind === "assistant" ? handoff.body : "").toContain("Use `/react <guidance>` to continue the tracked objective.");
});

test("factory chat items: objective handoff runs prefer the finalized assistant interpretation when present", () => {
  const runStream = "agents/factory/demo/runs/run_objective_handoff_interpreted";
  let prev: string | undefined;
  const push = (body: AgentEvent, index: number) => {
    const next = receipt(runStream, prev, body, index);
    prev = next.hash;
    return next;
  };
  const chain = [
    push({
      type: "problem.set",
      runId: "run_objective_handoff_interpreted",
      problem: "Objective handoff for Investigate NAT gateway cost spike",
      agentId: "orchestrator",
    }, 1),
    push({
      type: "thread.bound",
      runId: "run_objective_handoff_interpreted",
      objectiveId: "objective_demo",
      chatId: "chat_demo",
      reason: "dispatch_update",
    }, 2),
    push({
      type: "objective.handoff",
      runId: "run_objective_handoff_interpreted",
      objectiveId: "objective_demo",
      title: "Investigate NAT gateway cost spike",
      status: "blocked",
      summary: "We proved it was a one-day NAT data-processing surge.",
      blocker: "Historical NAT and flow-log records are missing, so attribution is still unresolved.",
      nextAction: "Use /react with retained evidence or close with an inconclusive conclusion.",
      handoffKey: "handoff_demo_interpreted",
      sourceUpdatedAt: 1_710_000_000_000,
    }, 3),
    push({
      type: "response.finalized",
      runId: "run_objective_handoff_interpreted",
      agentId: "orchestrator",
      content: "The investigation established a one-day NAT data-processing surge, but attribution is still blocked because the historical flow-log evidence is gone.",
    }, 4),
    push({
      type: "run.status",
      runId: "run_objective_handoff_interpreted",
      agentId: "orchestrator",
      status: "completed",
      note: "objective blocked handoff",
    }, 5),
  ];

  const items = buildChatItemsForRun("run_objective_handoff_interpreted", chain, new Map(), {
    conversation: [{
      role: "assistant",
      text: "The investigation established a one-day NAT data-processing surge, but attribution is still blocked because the historical flow-log evidence is gone.",
      runId: "run_objective_handoff_interpreted",
      ts: 4,
      refs: [],
    }],
  });

  const assistantItems = items.filter((item): item is Extract<typeof items[number], { kind: "assistant" }> => item.kind === "assistant");
  expect(assistantItems).toHaveLength(1);
  expect(assistantItems[0]?.body).toContain("attribution is still blocked");
  expect(assistantItems[0]?.body).not.toContain("handed back to Chat.");
});

test("factory chat items: completed objective handoffs prioritize the investigation result over orchestration status", () => {
  const runStream = "agents/factory/demo/runs/run_objective_handoff_completed";
  let prev: string | undefined;
  const push = (body: AgentEvent, index: number) => {
    const next = receipt(runStream, prev, body, index);
    prev = next.hash;
    return next;
  };
  const chain = [
    push({
      type: "problem.set",
      runId: "run_objective_handoff_completed",
      problem: "Objective handoff for Break down AWS cost for EC2 and S3",
      agentId: "orchestrator",
    }, 1),
    push({
      type: "thread.bound",
      runId: "run_objective_handoff_completed",
      objectiveId: "objective_demo",
      chatId: "chat_demo",
      reason: "dispatch_update",
    }, 2),
    push({
      type: "objective.handoff",
      runId: "run_objective_handoff_completed",
      objectiveId: "objective_demo",
      title: "Break down AWS cost for EC2 and S3",
      status: "completed",
      summary: "Cost Explorer for the last completed calendar month shows EC2 at $651.49 and S3 at $0.98.",
      nextAction: "Investigation is complete.",
      handoffKey: "handoff_demo_completed",
      sourceUpdatedAt: 1_710_000_000_000,
    }, 3),
    push({
      type: "run.status",
      runId: "run_objective_handoff_completed",
      agentId: "orchestrator",
      status: "completed",
      note: "objective completed handoff",
    }, 4),
  ];

  const items = buildChatItemsForRun("run_objective_handoff_completed", chain, new Map());
  const handoff = items.find((item) => item.kind === "assistant");
  expect(handoff && handoff.kind === "assistant" ? handoff.meta : "").toBe("Completed handoff");
  expect(handoff && handoff.kind === "assistant" ? handoff.body : "").toContain("Cost Explorer for the last completed calendar month shows EC2 at $651.49 and S3 at $0.98.");
  expect(handoff && handoff.kind === "assistant" ? handoff.body : "").not.toContain("completed and handed back to Chat.");
  expect(handoff && handoff.kind === "assistant" ? handoff.body : "").not.toContain("Next: Investigation is complete.");
});

test("factory chat items: profile handoffs render a visible continuation card", () => {
  const runStream = "agents/factory/demo/runs/run_profile_handoff";
  let prev: string | undefined;
  const push = (body: AgentEvent, index: number) => {
    const next = receipt(runStream, prev, body, index);
    prev = next.hash;
    return next;
  };
  const chain = [
    push({
      type: "problem.set",
      runId: "run_profile_handoff",
      problem: "Fix the sidebar bug.",
      agentId: "orchestrator",
    }, 1),
    push({
      type: "profile.selected",
      runId: "run_profile_handoff",
      profileId: "generalist",
      agentId: "orchestrator",
      reason: "default",
    }, 2),
    push({
      type: "profile.handoff",
      runId: "run_profile_handoff",
      agentId: "orchestrator",
      fromProfileId: "generalist",
      toProfileId: "software",
      reason: "Ship the repo fix.",
      nextRunId: "run_software_01",
      nextJobId: "job_factory_handoff_01",
      targetStream: "agents/factory/demo/software/objectives/objective_demo",
      objectiveId: "objective_demo",
    }, 3),
  ];

  const items = buildChatItemsForRun("run_profile_handoff", chain, new Map());
  const handoff = items.find((item) => item.kind === "work" && item.card.title === "Profile handoff to Software");

  expect(handoff && handoff.kind === "work" ? handoff.card.summary : "").toBe("Ship the repo fix.");
  expect(handoff && handoff.kind === "work" ? handoff.card.jobId : undefined).toBe("job_factory_handoff_01");
  expect(handoff && handoff.kind === "work" ? handoff.card.detail ?? "" : "").toContain("Next run: run_software_01");
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
test("factory sidebar island: limits previous sessions to the top five and shows view all when truncated", () => {
  const selectedObjective = {
    objectiveId: "objective_1",
    title: "Session 1",
    status: "completed",
    phase: "completed",
    summary: "Summary 1",
    debugLink: "/debug",
    receiptsLink: "/receipts",
  };
  const markup = factorySidebarIsland({
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    activeProfileTools: [],
    profiles: [{ id: "generalist", label: "Generalist", href: "/factory?profile=generalist", selected: true }],
    objectives: Array.from({ length: 6 }, (_, index) => ({
      objectiveId: `objective_${index + 1}`,
      title: `Session ${index + 1}`,
      status: "completed",
      phase: "completed",
      summary: `Summary ${index + 1}`,
      updatedAt: 100 + index,
      selected: index === 0,
      slotState: "idle",
      activeTaskCount: 0,
      readyTaskCount: 0,
      taskCount: 1,
    })),
    jobs: [],
  }, selectedObjective);

  expect(markup).toMatch(/Session 1/);
  expect(markup).toMatch(/Session 5/);
  expect(markup).not.toMatch(/Session 6/);
  expect(markup).toMatch(/Previous Sessions/);
  expect(markup).toMatch(/View all/);
  expect(markup).toContain('href="/factory?profile=generalist&objective=objective_1&all=1"');
  expect(markup).not.toContain('hx-get="/factory/island/sidebar');
  expect(markup).toMatch(/See other threads/);
  expect(markup).not.toMatch(/Jobs/);
});
test("factory sidebar island: blank chat keeps running objectives visible globally", () => {
  const markup = factorySidebarIsland({
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    activeProfileSummary: "Answer directly, inspect receipts, and keep delivery moving.",
    activeProfileTools: [],
    profiles: [
      { id: "generalist", label: "Generalist", href: "/factory?profile=generalist", summary: "Answer directly, inspect receipts, and keep delivery moving.", selected: true },
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

  expect(markup).toMatch(/Running/);
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
    profiles: [{ id: "generalist", label: "Generalist", href: "/factory?profile=generalist", selected: true }],
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
  expect(markup).not.toContain(">Debug<");
});

test("factory inspector island: token summary stays visible when total is zero", () => {
  const markup = factoryInspectorIsland({
    activeProfileId: "generalist",
    objectiveId: "objective_zero_tokens",
    panel: "overview",
    jobs: [],
    selectedObjective: {
      objectiveId: "objective_zero_tokens",
      title: "Zero-token objective",
      status: "completed",
      phase: "completed",
      summary: "No candidate tokens were recorded.",
      debugLink: "/debug",
      receiptsLink: "/receipts",
      tokensUsed: 0,
    },
  });

  expect(markup).toContain("Codex Token Usage");
  expect(markup).toMatch(/Codex Token Usage[\s\S]*>0</);
  expect(markup).toContain('href="/factory?profile=generalist&objective=objective_zero_tokens&panel=receipts"');
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
      profiles: [{ id: "generalist", label: "Generalist", href: "/factory?profile=generalist", selected: true }],
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
    activeProfileId: "generalist",
    objectiveId: "objective_demo",
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
      tokensUsed: 321,
    },
    tasks: taskCards,
  });

  expect(markup).toContain("sse:agent-refresh throttle:180ms");
  expect(markup).toContain("sse:objective-runtime-refresh throttle:180ms");
  expect(markup).toContain("sse:factory-refresh throttle:180ms");
  expect(markup).toContain("sse:job-refresh throttle:180ms");
  expect(markup).toContain('data-refresh-on="sse:agent-refresh@180,sse:job-refresh@180,sse:objective-runtime-refresh@180,sse:factory-refresh@180,body:factory:chat-refresh"');
  expect(markup).toContain('data-refresh-on="sse:profile-board-refresh@450,sse:objective-runtime-refresh@450,sse:factory-refresh@450,body:factory:scope-changed"');
  expect(markup).not.toContain('hx-ext="sse"');
  expect(markup).not.toContain("sse-connect=");
  expect(markup).not.toContain("/assets/htmx-ext-sse.js");
  expect(markup).toContain('id="factory-chat-streaming"');
  expect(markup).toContain('id="factory-chat-streaming-content"');
  expect(markup).toContain('id="factory-chat-optimistic"');
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
  expect(inspectorMarkup).toContain('href="/factory?profile=generalist&objective=objective_demo"');
  expect(inspectorMarkup).toContain('href="/factory?profile=generalist&objective=objective_demo&inspectorTab=notes"');
  expect(inspectorMarkup).toContain('href="/factory?profile=generalist&objective=objective_demo&panel=analysis"');
  expect(inspectorMarkup).toContain('href="/factory?profile=generalist&objective=objective_demo&panel=execution"');
  expect(inspectorMarkup).toContain('href="/factory?profile=generalist&objective=objective_demo&panel=receipts"');
  expect(inspectorMarkup).not.toContain('hx-get="/factory/island/inspector');
  expect(inspectorMarkup).toContain("Codex Token Usage");
  expect(inspectorMarkup).not.toContain(">Debug<");
  expect(inspectorMarkup).toContain(">Notes<");
  expect(inspectorMarkup).toContain("Engineer Perspective");
  expect(inspectorMarkup).toContain("My Assignment");
  expect(inspectorMarkup).toContain("Message engineer");
  expect(inspectorMarkup).toContain('data-factory-href="/factory?profile=generalist&amp;objective=objective_demo&amp;inspectorTab=chat"');
});

test("factory chat shell: mission control renders an empty operator shell", () => {
  const markup = factoryChatShell({
    mode: "mission-control",
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    chat: {
      mode: "mission-control",
      activeProfileId: "generalist",
      activeProfileLabel: "Generalist",
      items: [],
    },
    nav: {
      mode: "mission-control",
      activeProfileId: "generalist",
      activeProfileLabel: "Generalist",
      profiles: [{ id: "generalist", label: "Generalist", href: "/factory?profile=generalist", selected: true }],
      objectives: [],
    },
    inspector: {
      mode: "mission-control",
      panel: "overview",
      jobs: [],
    },
  });

  expect(markup).toContain('data-factory-mode="mission-control"');
  expect(markup).toContain("Factory Mission Control");
  expect(markup).toContain("Hotkeys");
  expect(markup).toContain('href="/factory/new-chat?mode=mission-control&profile=generalist"');
});

test("factory chat shell: mission control renders idle thread state without live focus", () => {
  const markup = factoryChatShell({
    mode: "mission-control",
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    objectiveId: "objective_idle",
    chat: {
      mode: "mission-control",
      activeProfileId: "generalist",
      activeProfileLabel: "Generalist",
      selectedThread: {
        objectiveId: "objective_idle",
        title: "Idle objective",
        status: "planning",
        phase: "planning",
        summary: "Waiting for the next operator action.",
        debugLink: "/debug",
        receiptsLink: "/receipts",
      },
      workbench: {
        summary: {
          objectiveId: "objective_idle",
          title: "Idle objective",
          status: "planning",
          phase: "planning",
          integrationStatus: "idle",
          slotState: "ready",
          activeTaskCount: 0,
          readyTaskCount: 0,
          taskCount: 1,
          activeJobCount: 0,
          elapsedMinutes: 3,
          checks: [],
          checksCount: 0,
        },
        tasks: [{
          taskId: "task_01",
          title: "Completed shell",
          status: "approved",
          workerType: "codex",
          taskKind: "planned",
          prompt: "Done.",
          dependsOn: [],
          workspaceExists: true,
          workspaceDirty: false,
          isActive: false,
          isReady: false,
        }],
        jobs: [],
        activity: [],
        hasActiveExecution: false,
      },
      items: [],
    },
    nav: {
      mode: "mission-control",
      activeProfileId: "generalist",
      activeProfileLabel: "Generalist",
      profiles: [{ id: "generalist", label: "Generalist", href: "/factory?profile=generalist", selected: true }],
      objectives: [],
    },
    inspector: {
      mode: "mission-control",
      panel: "overview",
      jobs: [],
    },
  });

  expect(markup).toContain("Objective Progress");
  expect(markup).toContain("1/1");
  expect(markup).toContain("Task Board");
  expect(markup).toContain("Completed shell");
});

test("factory chat shell: mission control renders active execution focus and progress log", () => {
  const markup = factoryChatShell({
    mode: "mission-control",
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    objectiveId: "objective_live",
    panel: "live",
    chat: {
      mode: "mission-control",
      activeProfileId: "generalist",
      activeProfileLabel: "Generalist",
      objectiveId: "objective_live",
      panel: "live",
      selectedThread: {
        objectiveId: "objective_live",
        title: "Live objective",
        status: "executing",
        phase: "executing",
        summary: "Running the primary capture task.",
        debugLink: "/debug",
        receiptsLink: "/receipts",
      },
      activeRun: {
        runId: "run_live",
        profileLabel: "Generalist",
        status: "running",
        summary: "Capturing the latest infrastructure snapshot.",
        steps: [{
          key: "step_01",
          kind: "tool",
          label: "Capture",
          summary: "Collecting current state.",
          tone: "info",
          active: true,
        }],
      },
      workbench: {
        summary: {
          objectiveId: "objective_live",
          title: "Live objective",
          status: "executing",
          phase: "executing",
          integrationStatus: "idle",
          slotState: "running",
          activeTaskCount: 1,
          readyTaskCount: 1,
          taskCount: 2,
          activeJobCount: 1,
          elapsedMinutes: 12,
          checks: ["bun run build"],
          checksCount: 1,
          nextAction: "Validate the refreshed inventory output.",
        },
        tasks: [{
          taskId: "task_01",
          title: "Capture infrastructure state",
          status: "running",
          workerType: "codex",
          taskKind: "planned",
          prompt: "Collect state.",
          dependsOn: [],
          workspaceExists: true,
          workspaceDirty: false,
          isActive: true,
          isReady: false,
        }, {
          taskId: "task_02",
          title: "Validate inventory output",
          status: "ready",
          workerType: "codex",
          taskKind: "planned",
          prompt: "Validate output.",
          dependsOn: ["task_01"],
          workspaceExists: true,
          workspaceDirty: false,
          isActive: false,
          isReady: true,
        }],
        jobs: [],
        activity: [{
          id: "activity_01",
          kind: "activity",
          title: "Supervisor step",
          summary: "Queued the validation follow-up.",
          meta: "now",
          emphasis: "accent",
        }],
        focus: {
          focusKind: "task",
          focusId: "task_01",
          title: "Capture infrastructure state",
          status: "running",
          active: true,
          summary: "Collecting current state.",
        },
        hasActiveExecution: true,
      },
      items: [],
    },
    nav: {
      mode: "mission-control",
      activeProfileId: "generalist",
      activeProfileLabel: "Generalist",
      panel: "live",
      profiles: [{ id: "generalist", label: "Generalist", href: "/factory?profile=generalist", selected: true }],
      objectives: [],
    },
    inspector: {
      mode: "mission-control",
      panel: "live",
      jobs: [],
    },
  });

  expect(markup).toContain("Current Signal");
  expect(markup).toContain("Capture infrastructure state");
  expect(markup).toContain("Progress Log");
  expect(markup).toContain("Collecting current state.");
});

test("factory chat shell: mission control renders blocked thread state", () => {
  const markup = factoryChatShell({
    mode: "mission-control",
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    objectiveId: "objective_blocked",
    panel: "execution",
    chat: {
      mode: "mission-control",
      activeProfileId: "generalist",
      activeProfileLabel: "Generalist",
      objectiveId: "objective_blocked",
      panel: "execution",
      selectedThread: {
        objectiveId: "objective_blocked",
        title: "Blocked objective",
        status: "blocked",
        phase: "blocked",
        summary: "Waiting on external validation.",
        blockedReason: "Waiting on external validation.",
        debugLink: "/debug",
        receiptsLink: "/receipts",
      },
      workbench: {
        summary: {
          objectiveId: "objective_blocked",
          title: "Blocked objective",
          status: "blocked",
          phase: "blocked",
          integrationStatus: "idle",
          slotState: "blocked",
          activeTaskCount: 0,
          readyTaskCount: 0,
          taskCount: 1,
          activeJobCount: 0,
          elapsedMinutes: 8,
          checks: [],
          checksCount: 0,
        },
        tasks: [{
          taskId: "task_01",
          title: "Await external approval",
          status: "blocked",
          workerType: "codex",
          taskKind: "planned",
          prompt: "Wait.",
          dependsOn: [],
          workspaceExists: true,
          workspaceDirty: false,
          isActive: false,
          isReady: false,
          blockedReason: "Waiting on external validation.",
        }],
        jobs: [],
        activity: [],
        hasActiveExecution: false,
      },
      items: [],
    },
    nav: {
      mode: "mission-control",
      activeProfileId: "generalist",
      activeProfileLabel: "Generalist",
      panel: "execution",
      profiles: [{ id: "generalist", label: "Generalist", href: "/factory?profile=generalist", selected: true }],
      objectives: [],
    },
    inspector: {
      mode: "mission-control",
      panel: "execution",
      jobs: [],
    },
  });

  expect(markup).toContain("Blocked objective");
  expect(markup).toContain("Await external approval");
  expect(markup).toContain("Phase blocked");
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
          latestNote: "Inspecting src/views/factory/workbench/index.ts.",
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
      summary: "Inspecting src/views/factory/workbench/index.ts.",
    },
    commands: [],
  };

  const items = buildChatItemsForRun("run_structured", chain, new Map([[childJob.id, childJob]]));
  const waiting = items.find((item) => item.kind === "system" && item.title === "Supervisor waiting on child");
  expect(waiting && waiting.kind === "system" ? waiting.body : "").toContain("job_codex_live is running");
  expect(waiting && waiting.kind === "system" ? waiting.body : "").toContain("layoutFixJob: job_layout_done is completed");

  const childCard = items.find((item) => item.kind === "work" && item.card.jobId === "job_codex_live");
  expect(childCard && childCard.kind === "work" ? childCard.card.summary : "").toContain("Inspecting src/views/factory/workbench/index.ts.");
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
      lastMessage: "Inspecting src/views/factory/workbench/index.ts.",
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

test("factory chat island: keeps only the latest durable handoff per objective in the transcript", () => {
  const markup = factoryChatIsland({
    activeProfileId: "infrastructure",
    activeProfileLabel: "Infrastructure",
    items: [
      {
        key: "run_objective_handoff_objective_ec2_1111111111111111-objective-handoff-hash-old",
        kind: "assistant",
        body: "Old completed handoff for EC2.",
        meta: "Completed handoff",
      },
      {
        key: "run_objective_handoff_objective_s3_2222222222222222-objective-handoff-hash-s3",
        kind: "assistant",
        body: "Completed handoff for S3.",
        meta: "Completed handoff",
      },
      {
        key: "run_objective_handoff_objective_ec2_3333333333333333-objective-handoff-hash-new",
        kind: "assistant",
        body: "New blocked handoff for EC2.",
        meta: "Blocked handoff",
      },
    ],
  });

  expect(markup).not.toContain("Old completed handoff for EC2.");
  expect(markup).toContain("Completed handoff for S3.");
  expect(markup).toContain("New blocked handoff for EC2.");
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

test("factory chat island: formats compact key-value blocks into readable markdown and shows the engineer role", () => {
  const markup = factoryChatIsland({
    activeProfileId: "software",
    activeProfileLabel: "Software",
    activeProfilePrimaryRole: "Software engineer",
    items: [{
      key: "a3",
      kind: "assistant",
      body: [
        "Status: running",
        "Owner: worker-12",
        "Next step: validate the failing test and post the diff.",
      ].join("\n"),
      meta: "running",
    }],
  });

  expect(markup).toContain("Software engineer");
  expect(markup).not.toContain(">Software<");
  expect(markup).toContain("<li><strong>Status:</strong> running</li>");
  expect(markup).toContain("<li><strong>Owner:</strong> worker-12</li>");
  expect(markup).toContain("<li><strong>Next step:</strong> validate the failing test and post the diff.</li>");
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
      { id: "generalist", label: "Generalist", href: "/factory?profile=generalist", selected: false },
      { id: "software", label: "Software", href: "/factory?profile=software", selected: true },
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
  expect(subscriptions).toContainEqual({ topic: "profile-board", stream: "generalist" });
  expect(subscriptions).not.toContainEqual({ topic: "factory", stream: undefined });
});

test("factory route: objective-scoped events subscribe to the current objective topic", async () => {
  const subscriptions: Array<{ readonly topic: string; readonly stream?: string }> = [];
  const app = createRouteTestApp({
    onSubscribeMany: (items) => subscriptions.push(...items),
  });

  const response = await app.request("http://receipt.test/factory/events?profile=generalist&objective=objective_demo");
  expect(response.status).toBe(200);
  expect(subscriptions).toContainEqual({ topic: "factory", stream: "objective_demo" });
  expect(subscriptions).not.toContainEqual({ topic: "factory", stream: undefined });
});
test("factory route: stale chat on an explicit objective preserves chat while canonicalizing to objective state", async () => {
  const objectiveId = "objective_demo";
  const objective = {
    ...makeStubObjectiveDetail(objectiveId),
    title: "Inventory buckets",
    profile: {
      rootProfileId: "infrastructure",
      rootProfileLabel: "Infrastructure",
    },
  } as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const objectiveState = {
    ...makeStubObjectiveState(objective),
    profile: {
      ...makeStubObjectiveState(objective).profile,
      rootProfileId: "infrastructure",
      rootProfileLabel: "Infrastructure",
    },
  } as FactoryState;
  const objectiveStream = factoryChatStream(process.cwd(), "infrastructure", objectiveId);
  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [objective as never],
      getObjective: async () => objective,
      getObjectiveState: async () => objectiveState,
    },
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
          input: { objectiveId },
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
            objectiveId,
            status: "executing",
            summary: "Objective still executing.",
          }),
        },
      ],
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_stale&objective=objective_demo");

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toContain("/factory?profile=infrastructure&chat=chat_stale&objective=objective_demo");
  expect(response.headers.get("location")).toContain("focusKind=task");
  expect(response.headers.get("location")).toContain("focusId=task_01");

  const canonicalResponse = await app.request(`http://receipt.test${response.headers.get("location")}`);
  const body = await canonicalResponse.text();

  expect(canonicalResponse.status).toBe(200);
  expect(body).toContain("Inventory buckets");
  expect(body).toContain('data-chat-id="chat_stale"');
  expect(body).toContain('data-objective-id="objective_demo"');
  expect(body).toContain('data-detail-tab="action"');
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
  expect(subscriptions).toContainEqual({ topic: "factory", stream: "objective_demo" });
  expect(subscriptions).toContainEqual({ topic: "jobs", stream: "job_related_parent" });
  expect(subscriptions).toContainEqual({ topic: "jobs", stream: "job_related_child" });
  expect(subscriptions).not.toContainEqual({ topic: "jobs", stream: "job_unrelated" });
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

test("factory route: explicit objective view renders the selected objective in the workbench", async () => {
  const app = createRouteTestApp({
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&objective=objective_demo");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Demo objective");
  expect(body).not.toContain(">Action Required<");
  expect(body).toContain('data-detail-tab="action"');
  expect(body).toContain("Receipts");
  expect(body).toContain("Demo summary");
});

test("factory route: completed objective still surfaces the terminal summary in the workbench", async () => {
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

  const response = await app.request("http://receipt.test/factory?profile=generalist&objective=objective_done");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("No active CloudWatch alarms were present across the 17 queryable regions.");
  expect(body).toContain("Demo objective");
  expect(body).toContain("Completed");
  expect(body).toContain("Current Run");
  expect(body).toContain("Selected Objective");
  expect(body).toContain("Latest Outcome");
  expect(body).toContain("Next Operator Action");
  expect(body).toContain("Start follow-up");
  expect(body).toContain("px-2.5 py-1.5 text-[12px]");
  expect(body).not.toContain("Metrics");
  expect(body).not.toContain("Bottom Line");
  expect(body).not.toContain("Recommended Action");
});

test("factory route: selected objective stays visible in the workbench when the active filter hides it", async () => {
  const completedObjective = {
    ...makeStubObjectiveDetail("objective_done"),
    title: "Selected completed objective",
    status: "completed",
    phase: "completed",
    scheduler: { slotState: "idle" },
    latestSummary: "Completed while the operator was still watching the running filter.",
    nextAction: "Objective is complete.",
    activeTaskCount: 0,
    readyTaskCount: 0,
    taskCount: 1,
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const completedCard = {
    ...completedObjective,
    section: "completed" as const,
  };
  const app = createRouteTestApp({
    service: {
      buildBoardProjection: async () => ({
        objectives: [completedCard],
        sections: {
          needs_attention: [],
          active: [],
          queued: [],
          completed: [completedCard],
        },
        selectedObjectiveId: "objective_done",
      }),
      listObjectives: async () => [
        completedObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => completedObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_done&detailTab=queue&filter=objective.running");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("No in-progress objectives match the current filter.");
  expect(body).toContain("Selected Objective");
  expect(body).toContain("Selected completed objective");
});

test("factory workbench route: detail tabs resolve to the same consolidated block set", async () => {
  const liveObjective = makeRunningWorkbenchObjectiveDetail("objective_live");
  const activeCard = { ...liveObjective, section: "active" as const };
  const app = createRouteTestApp({
    service: {
      buildBoardProjection: async () => ({
        objectives: [activeCard],
        sections: {
          needs_attention: [],
          active: [activeCard],
          queued: [],
          completed: [],
        },
        selectedObjectiveId: "objective_live",
      }),
      listObjectives: async () => [
        liveObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => liveObjective,
    },
  });

  const actionResponse = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_live&detailTab=action");
  const actionBody = await actionResponse.text();
  expect(actionResponse.status).toBe(200);
  expect(actionBody).toContain('id="factory-workbench-block-summary"');
  expect(actionBody).toContain('id="factory-workbench-block-objectives"');
  expect(actionBody).not.toContain(">Action Required<");

  const queueResponse = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_live&detailTab=queue");
  const queueBody = await queueResponse.text();
  expect(queueResponse.status).toBe(200);
  expect(queueBody).toContain('id="factory-workbench-block-summary"');
  expect(queueBody).toContain('id="factory-workbench-block-objectives"');
  expect(queueBody).not.toContain('id="factory-workbench-block-activity"');
});

test("factory route: blocked objective workbench does not present canceled tasks as running", async () => {
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

  const response = await app.request("http://receipt.test/factory?profile=generalist&objective=objective_canceled");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("canceled from UI");
  expect(body).not.toContain("Running now.");
});

test("factory workbench: focused task prefers blocked task status over completed job status", () => {
  const blockedObjective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_blocked"),
    status: "blocked",
    phase: "blocked",
    latestSummary: "Need operator guidance.",
    blockedReason: "Need operator guidance.",
    activeTaskCount: 0,
    readyTaskCount: 0,
    tasks: [{
      ...makeRunningWorkbenchObjectiveDetail("objective_blocked").tasks[0],
      status: "running",
      jobStatus: "completed",
      latestSummary: "Need operator guidance.",
    }],
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;

  const workbench = buildFactoryWorkbench({
    detail: blockedObjective,
    requestedFocusKind: "task",
    requestedFocusId: "task_01",
  });

  expect(workbench?.focus?.status).toBe("blocked");
});

test("factory workbench header renders the engineer profile as a borderless inline dropdown", () => {
  const markup = factoryWorkbenchHeaderIsland({
    activeProfileId: "software",
    activeProfileLabel: "Software",
    chatId: "chat_demo",
    detailTab: "action",
    filter: "objective.running",
    profiles: [{
      id: "software",
      label: "Software",
      href: "/factory?profile=software&chat=chat_demo",
      selected: true,
    }, {
      id: "generalist",
      label: "Generalist",
      href: "/factory?profile=generalist&chat=chat_demo",
      selected: false,
    }],
    workspace: {
      activeProfileId: "software",
      activeProfileLabel: "Software",
      detailTab: "action",
      filter: "objective.running",
      filters: [],
      selectedObjective: {
        objectiveId: "objective_demo",
        title: "Rebalance workbench header",
        status: "executing",
        phase: "executing",
        displayState: "Running",
        debugLink: "/factory/debug/objective_demo",
        receiptsLink: "/receipt?stream=factory/objectives/objective_demo",
        activeTaskCount: 2,
        taskCount: 5,
      },
      board: {
        objectives: [],
        sections: {
          needs_attention: [],
          active: [],
          queued: [],
          completed: [],
        },
      },
      activeObjectives: [],
      pastObjectives: [],
      blocks: [],
    },
    chat: {
      activeProfileId: "software",
      activeProfileLabel: "Software",
      activeProfilePrimaryRole: "Software engineer",
      items: [],
    },
  } as FactoryWorkbenchPageModel);

  expect(markup).toContain('data-factory-profile-select="true"');
  expect(markup).toContain("appearance-none");
  expect(markup).toContain("border border-border bg-transparent");
  expect(markup).toContain("Selected objective");
  expect(markup).toContain("Rebalance workbench header");
  expect(markup).toContain("2/5 tasks");
  expect(markup).toContain("Running");
  expect(markup).not.toContain('<div class="text-[15px] font-semibold leading-none text-foreground">Software</div>');
});

test("factory workbench chat header hides the duplicate profile label when a role is available", () => {
  const snapshot = buildFactoryWorkbenchShellSnapshot({
    activeProfileId: "infrastructure",
    activeProfileLabel: "Infrastructure",
    chatId: "chat_demo",
    detailTab: "action",
    filter: "objective.running",
    profiles: [],
    workspace: {
      activeProfileId: "infrastructure",
      activeProfileLabel: "Infrastructure",
      detailTab: "action",
      filter: "objective.running",
      filters: [],
      board: {
        objectives: [],
        sections: {
          needs_attention: [],
          active: [],
          queued: [],
          completed: [],
        },
      },
      activeObjectives: [],
      pastObjectives: [],
      blocks: [],
    },
    chat: {
      activeProfileId: "infrastructure",
      activeProfileLabel: "Infrastructure",
      activeProfilePrimaryRole: "Infrastructure engineer",
      items: [],
    },
  } as FactoryWorkbenchPageModel);

  expect(snapshot.chatHeaderHtml).toContain("Infrastructure engineer");
  expect(snapshot.chatHeaderHtml).not.toContain(">Infrastructure<");
});

test("factory route: blocked objective workbench surfaces react guidance near recent activity and the composer", async () => {
  const blockedObjective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_blocked"),
    status: "blocked",
    phase: "blocked",
    latestSummary: "Need operator guidance.",
    blockedReason: "Need operator guidance.",
    nextAction: "Review the blocking receipt, adjust the investigation, or cancel the objective.",
    activeTaskCount: 0,
    readyTaskCount: 0,
    tasks: [{
      ...makeRunningWorkbenchObjectiveDetail("objective_blocked").tasks[0],
      status: "running",
      jobStatus: "completed",
      latestSummary: "Need operator guidance.",
    }],
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;

  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        blockedObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => blockedObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_blocked&detailTab=review&inspectorTab=chat&focusKind=task&focusId=task_01");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Execution Log");
  expect(body).toContain("Selected objective is blocked.");
  expect(body).toContain("Use /react &lt;guidance&gt;");
  expect(body).toContain(">React</button>");
  expect(body).toContain('data-factory-command="/react "');
});

test("factory route: stalled execution automatically refers the operator back to chat", async () => {
  const liveObjective = makeRunningWorkbenchObjectiveDetail("objective_stalled");
  const app = createRouteTestApp({
    jobs: [{
      id: "job_task_stalled",
      agentId: "codex",
      lane: "collect",
      singletonMode: "allow",
      payload: {
        kind: "factory.task.run",
        objectiveId: "objective_stalled",
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
      objectiveId: "objective_stalled",
      focusKind: "task",
      focusId: "task_01",
      title: "Implement mission shell",
      status: "stalled",
      active: false,
      summary: "No new worker progress was observed for this task pass.",
      taskId: "task_01",
      candidateId: "candidate_01",
      jobId: "job_task_stalled",
      lastMessage: "Waiting on the next worker update.",
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

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_stalled&inspectorTab=chat&focusKind=task&focusId=task_01");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("No new worker progress was observed for this task pass.");
  expect(body).toContain("Stalled");
  expect(body).toContain('data-inspector-tab="chat"');
  expect(body).toContain("Plain text stays chat-first. Use /react &lt;guidance&gt; to update the selected objective.");
});

test("factory route: blocked objectives render a concrete handoff in the chat transcript", async () => {
  const blockedObjective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_blocked"),
    status: "blocked",
    phase: "blocked",
    latestSummary: "We proved it was a NAT data-processing surge, but not which workload caused it.",
    blockedReason: "Need retained historical NAT or flow-log evidence to attribute the spike.",
    blockedExplanation: "Need retained historical NAT or flow-log evidence to attribute the spike.",
    nextAction: "Use /react with more evidence, or ask Chat to summarize the current findings.",
    activeTaskCount: 0,
    readyTaskCount: 0,
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;

  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        blockedObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => blockedObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_blocked&inspectorTab=chat");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Blocked handoff");
  expect(body).toContain("is blocked and handed back to Chat.");
  expect(body).toContain("Chat can explain the current evidence or inspect the repo with a read-only Codex probe.");
});

test("factory route: objective handoff is durable in the bound chat session", async () => {
  const blockedObjective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_blocked"),
    title: "Investigate NAT gateway cost spike",
    status: "blocked",
    phase: "blocked",
    latestSummary: "We proved it was a NAT data-processing surge, but not which workload caused it.",
    blockedReason: "Need retained historical NAT or flow-log evidence to attribute the spike.",
    blockedExplanation: "Need retained historical NAT or flow-log evidence to attribute the spike.",
    nextAction: "Use /react with more evidence, or ask Chat to summarize the current findings.",
    activeTaskCount: 0,
    readyTaskCount: 0,
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;

  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        blockedObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => blockedObjective,
    },
  });

  const firstResponse = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_blocked&inspectorTab=chat");
  const firstBody = await firstResponse.text();
  expect(firstResponse.status).toBe(200);
  expect(firstBody).toContain("Blocked handoff");

  const replayResponse = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&inspectorTab=chat");
  const replayBody = await replayResponse.text();

  expect(replayResponse.status).toBe(200);
  expect(replayBody).toContain("Investigate NAT gateway cost spike");
  expect(replayBody).toContain("is blocked and handed back to Chat.");
  expect(replayBody).toContain("What we know");
});

test("factory route: objective handoff writes an interpreted final response into the bound chat session", async () => {
  const blockedObjective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_blocked"),
    title: "Investigate NAT gateway cost spike",
    status: "blocked",
    phase: "blocked",
    latestSummary: "We proved it was a NAT data-processing surge, but not which workload caused it.",
    blockedReason: "Need retained historical NAT or flow-log evidence to attribute the spike.",
    blockedExplanation: "Need retained historical NAT or flow-log evidence to attribute the spike.",
    nextAction: "Use /react with more evidence, or ask Chat to summarize the current findings.",
    activeTaskCount: 0,
    readyTaskCount: 0,
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;

  let agentEventStore: Map<string, AgentEvent[]> | undefined;
  const app = createRouteTestApp({
    captureAgentEventStore: (store) => {
      agentEventStore = store;
    },
    service: {
      listObjectives: async () => [
        blockedObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => blockedObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_blocked&inspectorTab=chat");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("is blocked and handed back to Chat.");

  const sessionStream = factoryChatSessionStream(process.cwd(), "generalist", "chat_demo");
  const sessionEvents = agentEventStore?.get(sessionStream) ?? [];
  const finalEvent = sessionEvents.find((event): event is Extract<AgentEvent, { type: "response.finalized" }> =>
    event.type === "response.finalized"
  );
  expect(finalEvent?.content).toContain("Investigate NAT gateway cost spike is blocked and handed back to Chat.");
  expect(finalEvent?.content).toContain("What we know: We proved it was a NAT data-processing surge");
});

test("factory route: session stream changes invalidate the cached workbench handoff", async () => {
  let currentObjective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_blocked"),
    title: "Investigate NAT gateway cost spike",
    status: "blocked",
    phase: "blocked",
    latestSummary: "We proved it was a NAT data-processing surge, but not which workload caused it.",
    blockedReason: "Need retained historical NAT or flow-log evidence to attribute the spike.",
    blockedExplanation: "Need retained historical NAT or flow-log evidence to attribute the spike.",
    nextAction: "Use /react with more evidence, or ask Chat to summarize the current findings.",
    activeTaskCount: 0,
    readyTaskCount: 0,
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;

  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        currentObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => currentObjective,
    },
  });

  const blockedResponse = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_blocked&inspectorTab=chat");
  const blockedBody = await blockedResponse.text();
  expect(blockedResponse.status).toBe(200);
  expect(blockedBody).toContain("Blocked handoff");

  currentObjective = {
    ...currentObjective,
    status: "completed",
    phase: "completed",
    latestSummary: "Investigation complete: the spike was a one-day NAT data-processing surge.",
    blockedReason: undefined,
    blockedExplanation: undefined,
    nextAction: "Review the conclusion in Chat and decide whether to archive the objective.",
  };

  const completedResponse = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_blocked&inspectorTab=chat");
  const completedBody = await completedResponse.text();

  expect(completedResponse.status).toBe(200);
  expect(completedBody).not.toContain("completed and handed back to Chat.");
  expect(completedBody).toContain("Investigation complete: the spike was a one-day NAT data-processing surge.");
  expect(completedBody).not.toContain("Dispatch ready task task_01.");
});

test("factory route: fresh objective projection versions invalidate cached workbench islands", async () => {
  let projectionVersion = 1;
  let currentObjective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_live"),
    title: "Live objective",
    latestSummary: "Task work is running in the shared thread shell.",
  } as Awaited<ReturnType<FactoryService["getObjective"]>>;

  const buildBoardProjection = async () => {
    const section = currentObjective.status === "blocked" || currentObjective.status === "failed"
      ? "needs_attention"
      : currentObjective.status === "completed" || currentObjective.status === "canceled"
        ? "completed"
        : currentObjective.scheduler.slotState === "queued"
          ? "queued"
          : "active";
    const card = {
      ...currentObjective,
      section,
    } as Awaited<ReturnType<FactoryService["buildBoardProjection"]>>["objectives"][number];
    return {
      objectives: [card],
      sections: {
        needs_attention: section === "needs_attention" ? [card] : [],
        active: section === "active" ? [card] : [],
        queued: section === "queued" ? [card] : [],
        completed: section === "completed" ? [card] : [],
      },
      selectedObjectiveId: currentObjective.objectiveId,
    } as Awaited<ReturnType<FactoryService["buildBoardProjection"]>>;
  };

  const app = createRouteTestApp({
    service: {
      projectionVersionFresh: async () => projectionVersion,
      buildBoardProjection,
      getObjective: async () => currentObjective,
    },
  });

  const firstResponse = await app.request("http://receipt.test/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_live");
  const firstBody = await firstResponse.text();
  expect(firstResponse.status).toBe(200);
  expect(firstBody).toContain("Live objective");

  projectionVersion += 1;
  currentObjective = {
    ...currentObjective,
    title: "Updated live objective",
    latestSummary: "The refreshed projection should replace the cached workbench shell.",
  };

  const secondResponse = await app.request("http://receipt.test/factory/island/workbench?profile=generalist&chat=chat_demo&objective=objective_live");
  const secondBody = await secondResponse.text();
  expect(secondResponse.status).toBe(200);
  expect(secondBody).toContain("Updated live objective");
  expect(secondBody).toContain("The refreshed projection should replace the cached workbench shell.");
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

  const response = await app.request("http://receipt.test/factory?profile=generalist&objective=objective_live&detailTab=review");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Execution Log");
  expect(body).toContain("Codex Log");
  expect(body).toContain("build ok");
  expect(body).toContain("Worker running");
  expect(body).toContain('id="factory-workbench-rail-scroll"');
  expect(body).toContain('id="factory-workbench-focus-scroll"');
  expect(body).toContain('data-preserve-scroll-key="rail"');
  expect(body).toContain('data-preserve-scroll-key="focus"');
  expect(body).toContain("Continue");
  expect(body).toContain("Abort Job");
  expect(body).toContain("Open Chat");
  expect(body).toContain("data-focus-kind=\"task\"");
  expect(body).toContain("data-focus-id=\"task_01\"");
});

test("factory route: explicit objective view avoids global job scans when detail already has task jobs", async () => {
  let listJobsCalls = 0;
  const baseObjective = makeRunningWorkbenchObjectiveDetail("objective_live");
  const liveObjective = {
    ...baseObjective,
    tasks: baseObjective.tasks.map((task, index) => (
      index === 0
        ? {
            ...task,
            job: {
              id: "job_task_01",
              agentId: "codex",
              lane: "collect",
              sessionKey: undefined,
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
            },
          }
        : task
    )),
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const app = createRouteTestApp({
    onListJobs: () => {
      listJobsCalls += 1;
    },
    service: {
      listObjectives: async () => [
        liveObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => liveObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&objective=objective_live");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Live objective");
  expect(body).toContain("data-focus-id=\"task_01\"");
  expect(listJobsCalls).toBe(0);
});

test("factory route: projected activity and receipts surface in the live workbench activity", async () => {
  const objectiveId = "objective_live";
  const liveObjective = makeRunningWorkbenchObjectiveDetail(objectiveId);
  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        liveObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => liveObjective,
    },
  });

  const response = await app.request(`http://receipt.test/factory?profile=generalist&objective=${objectiveId}&detailTab=review`);
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Worker running");
  expect(body).toContain("Task work is running in the shared thread shell.");
  expect(body).toContain("Factory kept task_01 at the frontier.");
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

  const response = await app.request("http://receipt.test/factory?profile=generalist&objective=objective_live&detailTab=review&focusKind=task&focusId=task_02");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("data-focus-kind=\"task\"");
  expect(body).toContain("data-focus-id=\"task_02\"");
  expect(body).toContain("Execution Log");
  expect(body).toContain("Waiting on task_01 before updating the inspector.");
});

test("factory route: workbench drops unsupported mode query params and redirects to the canonical route", async () => {
  const liveObjective = makeRunningWorkbenchObjectiveDetail("objective_live");
  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        liveObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => liveObjective,
    },
  });

  const shellResponse = await app.request("http://receipt.test/factory?profile=generalist&objective=objective_live&mode=mission-control");
  const body = await shellResponse.text();

  expect(shellResponse.status).toBe(200);
  expect(body).toContain('data-objective-id="objective_live"');
  expect(body).not.toContain("mode=mission-control");
});

test("factory route: /factory/control redirects to the canonical /factory shell", async () => {
  const app = createRouteTestApp();

  const response = await app.request("http://receipt.test/factory/control?profile=generalist&chat=chat_demo&objective=objective_demo");

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_demo");
});

test("factory route: explicit objective URLs canonicalize to the owning profile", async () => {
  const softwareObjective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_software"),
    profile: {
      rootProfileId: "software",
      rootProfileLabel: "Software",
    },
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const app = createRouteTestApp({
    service: {
      getObjective: async () => softwareObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_software");

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toContain("/factory?profile=software&chat=chat_demo&objective=objective_software");
});

test("factory route: workbench lists stay scoped to the active profile", async () => {
  const generalistObjective = makeRunningWorkbenchObjectiveDetail("objective_generalist");
  const softwareObjective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_software"),
    title: "Software-only objective",
    profile: {
      rootProfileId: "software",
      rootProfileLabel: "Software",
    },
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const objectiveCards = [
    { ...generalistObjective, section: "active" as const },
    { ...softwareObjective, section: "active" as const },
  ];
  const app = createRouteTestApp({
    service: {
      buildBoardProjection: async (input?: string | { readonly selectedObjectiveId?: string; readonly profileId?: string }) => {
        const profileId = typeof input === "string" ? undefined : input?.profileId;
        const objectives = profileId
          ? objectiveCards.filter((objective) => objective.profile.rootProfileId === profileId)
          : objectiveCards;
        return {
          objectives,
          sections: {
            needs_attention: [],
            active: objectives,
            queued: [],
            completed: [],
          },
          selectedObjectiveId: typeof input === "string" ? input : input?.selectedObjectiveId,
        };
      },
      listObjectives: async (input?: { readonly profileId?: string }) => {
        const objectives = [
          generalistObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
          softwareObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
        ];
        return input?.profileId
          ? objectives.filter((objective) => objective.profile.rootProfileId === input.profileId)
          : objectives;
      },
      getObjective: async (objectiveId: string) =>
        objectiveId === "objective_software" ? softwareObjective : generalistObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Live objective");
  expect(body).not.toContain("Software-only objective");
});

test("factory workbench route: renders the split workbench shell with objective progress, live updates, history, and chat", async () => {
  const activeObjective = makeRunningWorkbenchObjectiveDetail("objective_live");
  const pastObjective = {
    ...makeStubObjectiveDetail("objective_done", "job_done"),
    title: "Completed objective",
    status: "completed",
    phase: "completed",
    scheduler: { slotState: "idle" },
    latestSummary: "Wrapped the previous run cleanly.",
    nextAction: "Review the prior receipts if needed.",
    activeTaskCount: 0,
    readyTaskCount: 0,
    taskCount: 1,
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const activeCard = { ...activeObjective, section: "active" as const };
  const completedCard = { ...pastObjective, section: "completed" as const };
  const sessionStream = factoryChatSessionStream(process.cwd(), "generalist", "chat_demo");
  const app = createRouteTestApp({
    jobs: [{
      id: "job_factory_run",
      agentId: "factory",
      lane: "chat",
      singletonMode: "allow",
      payload: {
        kind: "factory.run",
        stream: sessionStream,
        profileId: "generalist",
        chatId: "chat_demo",
        objectiveId: "objective_live",
        runId: "run_live",
      },
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      createdAt: 1,
      updatedAt: 12,
      commands: [],
    } as QueueJob, {
      id: "job_task_01",
      agentId: "codex",
      lane: "collect",
      singletonMode: "allow",
      payload: {
        kind: "factory.task.run",
        stream: `${sessionStream}/sub/job_task_01`,
        parentStream: sessionStream,
        profileId: "generalist",
        chatId: "chat_demo",
        objectiveId: "objective_live",
        runId: "job_task_01",
        parentRunId: "run_live",
        taskId: "task_01",
        task: "Implement mission shell",
      },
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      createdAt: 2,
      updatedAt: 13,
      result: {
        worker: "codex",
        summary: "Codex is patching the objective-driven shell.",
        lastMessage: "Restoring the employee and objective handoff layout.",
        tokensUsed: 321,
      },
      commands: [],
    } as QueueJob],
    agentEvents: {
      [sessionStream]: [{
        type: "problem.set",
        runId: "run_live",
        problem: "Run the live objective.",
        agentId: "orchestrator",
      }, {
        type: "thread.bound",
        runId: "run_live",
        objectiveId: "objective_live",
        chatId: "chat_demo",
        reason: "dispatch_update",
      }],
      [agentRunStream(sessionStream, "run_live")]: [{
        type: "problem.set",
        runId: "run_live",
        problem: "Run the live objective.",
        agentId: "orchestrator",
      }, {
        type: "tool.called",
        runId: "run_live",
        iteration: 1,
        tool: "codex.run",
        input: { task: "Implement mission shell" },
        summary: "Queued Codex work for the objective shell.",
        durationMs: 1_000,
      }, {
        type: "tool.observed",
        runId: "run_live",
        iteration: 1,
        tool: "codex.run",
        truncated: false,
        output: JSON.stringify({
          status: "running",
          summary: "Codex is patching the objective-driven shell.",
          title: "Implement mission shell",
        }),
      }, {
        type: "run.status",
        runId: "run_live",
        agentId: "orchestrator",
        status: "running",
        note: "Waiting on codex.",
      }],
    },
    service: {
      buildBoardProjection: async () => ({
        objectives: [activeCard, completedCard],
        sections: {
          needs_attention: [],
          active: [activeCard],
          queued: [],
          completed: [completedCard],
        },
        selectedObjectiveId: "objective_live",
      }),
      listObjectives: async () => [
        activeObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
        pastObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async (objectiveId: string) =>
        objectiveId === "objective_done" ? pastObjective : activeObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_live");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Receipt Factory Workbench");
  expect(body).toContain(">Receipt<");
  expect(body).toContain(">factory<");
  expect(body).toContain("321 tokens used");
  expect(body).toContain("Spent");
  expect(body).toContain("8m");
  expect(body).not.toContain(">Session<");
  expect(body).not.toContain(">Action Required<");
  expect(body).toContain("Current Run");
  expect(body).toContain("Latest Outcome");
  expect(body).toContain("Primary Focus");
  expect(body).toContain("Execution");
  expect(body).toContain("Receipts");
  expect(body).toContain("Overview");
  expect(body).toContain("New Chat");
  expect(body).not.toContain("Objective Chat");
  expect(body).toContain("Live objective");
  expect(body).toContain("Objective Brief");
  expect(body).toContain("Next Operator Action");
  expect(body).toContain("Chat handed this work to the background.");
  expect(body).toContain("Current run updates stay pinned on the left.");
  expect(body).not.toContain("Objective Contract");
  expect(body).not.toContain("Aligned");
  expect(body).not.toContain("Metrics");
  expect(body).not.toContain("Employee Profile");
  expect(body).not.toContain("PROFILE.md");
  expect(body).not.toContain("SOUL.md");
  expect(body).not.toContain("Responsibilities");
  expect(body).not.toContain("Operating Style");
  expect(body).not.toContain("Decision Rules");
  expect(body).toContain('id="factory-workbench-rail-scroll"');
  expect(body).toContain('id="factory-workbench-focus-scroll"');
  expect(body).toContain('data-preserve-scroll-key="rail"');
  expect(body).toContain('data-preserve-scroll-key="focus"');
  expect(body).not.toContain("max-w-[1680px]");
  expect(body.match(/data-factory-profile-select="true"/g)?.length ?? 0).toBe(1);
  expect(body).toContain('data-inspector-tab="overview"');
  expect(body).toContain('data-refresh-on="sse:profile-board-refresh@300,sse:objective-runtime-refresh@300"');
  expect(body).toContain('data-refresh-on="sse:profile-board-refresh@320,sse:objective-runtime-refresh@320,sse:agent-refresh@180,sse:job-refresh@180"');
  expect(body).toContain('data-refresh-on="sse:agent-refresh@180,sse:job-refresh@180"');
  expect(body).toContain('data-route-key="/factory?profile=generalist&amp;chat=chat_demo&amp;objective=objective_live&amp;detailTab=action&amp;focusKind=task&amp;focusId=task_01"');
  expect(body).toContain('data-factory-href="/factory/new-chat?profile=generalist&amp;inspectorTab=chat&amp;detailTab=action&amp;filter=objective.running"');
  expect(body).not.toContain("objective=objective_done");
});

test("factory workbench route: selected objective stays visible when section caps would otherwise omit it", async () => {
  const selectedObjective = {
    ...makeStubObjectiveDetail("objective_selected"),
    title: "Selected overflow objective",
    status: "completed",
    phase: "completed",
    scheduler: { slotState: "idle" },
    latestSummary: "Older completed objective still selected in chat.",
    nextAction: "Objective is complete.",
    activeTaskCount: 0,
    readyTaskCount: 0,
    taskCount: 1,
    updatedAt: 1,
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const moreRecentCompleted = Array.from({ length: 10 }, (_, index) => ({
    ...makeStubObjectiveDetail(`objective_recent_${index + 1}`, `job_recent_${index + 1}`),
    title: `Recent completed ${index + 1}`,
    status: "completed",
    phase: "completed",
    scheduler: { slotState: "idle" },
    latestSummary: `Completed objective ${index + 1}.`,
    nextAction: "Objective is complete.",
    activeTaskCount: 0,
    readyTaskCount: 0,
    taskCount: 1,
    updatedAt: 20 - index,
  })) as ReadonlyArray<Awaited<ReturnType<FactoryService["getObjective"]>>>;
  const completedCards = [
    ...moreRecentCompleted.map((objective) => ({
      ...objective,
      section: "completed" as const,
    })),
    {
      ...selectedObjective,
      section: "completed" as const,
    },
  ];
  const listedObjectives = [
    ...moreRecentCompleted,
    selectedObjective,
  ] as ReadonlyArray<Awaited<ReturnType<FactoryService["listObjectives"]>>[number]>;
  const app = createRouteTestApp({
    service: {
      buildBoardProjection: async () => ({
        objectives: completedCards,
        sections: {
          needs_attention: [],
          active: [],
          queued: [],
          completed: completedCards,
        },
        selectedObjectiveId: "objective_selected",
      }),
      listObjectives: async () => listedObjectives,
      getObjective: async () => selectedObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_selected&detailTab=queue&filter=objective.running");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Selected Objective");
  expect(body).toContain("Selected overflow objective");
});

test("factory workbench shell snapshot: returns a canonical route key for client-side stale-response rejection", async () => {
  const activeObjective = makeRunningWorkbenchObjectiveDetail("objective_live");
  const activeCard = { ...activeObjective, section: "active" as const };
  const app = createRouteTestApp({
    service: {
      buildBoardProjection: async () => ({
        objectives: [activeCard],
        sections: {
          needs_attention: [],
          active: [activeCard],
          queued: [],
          completed: [],
        },
        selectedObjectiveId: "objective_live",
      }),
      listObjectives: async () => [
        activeObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => activeObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory/api/workbench-shell?profile=generalist&chat=chat_demo&objective=objective_live");
  const snapshot = await response.json() as { readonly routeKey?: string };

  expect(response.status).toBe(200);
  expect(snapshot.routeKey).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_live&detailTab=action&focusKind=task&focusId=task_01");
});

test("factory workbench shell snapshot: selected objective chat excludes runs from other objectives in the same session", async () => {
  const objectiveA = {
    ...makeStubObjectiveDetail("objective_a", "job_a"),
    title: "Objective A",
    latestSummary: "Objective A summary",
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const objectiveB = {
    ...makeStubObjectiveDetail("objective_b", "job_b"),
    title: "Objective B",
    latestSummary: "Objective B summary",
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const objectiveCardA = { ...objectiveA, section: "active" as const };
  const objectiveCardB = { ...objectiveB, section: "active" as const };
  const sessionStream = factoryChatSessionStream(process.cwd(), "generalist", "chat_demo");
  const runAStream = agentRunStream(sessionStream, "run_objective_a");
  const runBStream = agentRunStream(sessionStream, "run_objective_b");
  const app = createRouteTestApp({
    agentEvents: {
      [sessionStream]: [
        {
          type: "problem.set",
          runId: "run_objective_a",
          problem: "Summarize objective A.",
          agentId: "factory",
        },
        {
          type: "response.finalized",
          runId: "run_objective_a",
          content: "Objective A reply",
          agentId: "factory",
        },
        {
          type: "problem.set",
          runId: "run_objective_b",
          problem: "Summarize objective B.",
          agentId: "factory",
        },
        {
          type: "response.finalized",
          runId: "run_objective_b",
          content: "Objective B reply",
          agentId: "factory",
        },
      ],
      [runAStream]: [
        {
          type: "problem.set",
          runId: "run_objective_a",
          problem: "Summarize objective A.",
          agentId: "factory",
        },
        {
          type: "thread.bound",
          runId: "run_objective_a",
          objectiveId: "objective_a",
          chatId: "chat_demo",
          reason: "startup",
        },
        {
          type: "run.status",
          runId: "run_objective_a",
          status: "completed",
          agentId: "factory",
        },
        {
          type: "response.finalized",
          runId: "run_objective_a",
          content: "Objective A reply",
          agentId: "factory",
        },
      ],
      [runBStream]: [
        {
          type: "problem.set",
          runId: "run_objective_b",
          problem: "Summarize objective B.",
          agentId: "factory",
        },
        {
          type: "thread.bound",
          runId: "run_objective_b",
          objectiveId: "objective_b",
          chatId: "chat_demo",
          reason: "startup",
        },
        {
          type: "run.status",
          runId: "run_objective_b",
          status: "completed",
          agentId: "factory",
        },
        {
          type: "response.finalized",
          runId: "run_objective_b",
          content: "Objective B reply",
          agentId: "factory",
        },
      ],
    },
    service: {
      buildBoardProjection: async () => ({
        objectives: [objectiveCardA, objectiveCardB],
        sections: {
          needs_attention: [],
          active: [objectiveCardA, objectiveCardB],
          queued: [],
          completed: [],
        },
        selectedObjectiveId: "objective_b",
      }),
      listObjectives: async () => [
        objectiveA as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
        objectiveB as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async (objectiveId: string) => objectiveId === "objective_b" ? objectiveB : objectiveA,
    },
  });

  const response = await app.request("http://receipt.test/factory/api/workbench-shell?profile=generalist&chat=chat_demo&objective=objective_b&inspectorTab=chat");
  const snapshot = await response.json() as { readonly chatHtml?: string };

  expect(response.status).toBe(200);
  expect(snapshot.chatHtml).toContain("Objective B reply");
  expect(snapshot.chatHtml).not.toContain("Objective A reply");
  expect(snapshot.chatHtml).toContain('data-objective-id="objective_b"');
});

test("factory route: selected objective chat island excludes runs from other objectives in the same session", async () => {
  const objectiveA = {
    ...makeStubObjectiveDetail("objective_a", "job_a"),
    title: "Objective A",
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const objectiveB = {
    ...makeStubObjectiveDetail("objective_b", "job_b"),
    title: "Objective B",
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const sessionStream = factoryChatSessionStream(process.cwd(), "generalist", "chat_demo");
  const runAStream = agentRunStream(sessionStream, "run_objective_a");
  const runBStream = agentRunStream(sessionStream, "run_objective_b");
  const app = createRouteTestApp({
    agentEvents: {
      [sessionStream]: [
        {
          type: "problem.set",
          runId: "run_objective_a",
          problem: "Summarize objective A.",
          agentId: "factory",
        },
        {
          type: "response.finalized",
          runId: "run_objective_a",
          content: "Objective A reply",
          agentId: "factory",
        },
        {
          type: "problem.set",
          runId: "run_objective_b",
          problem: "Summarize objective B.",
          agentId: "factory",
        },
        {
          type: "response.finalized",
          runId: "run_objective_b",
          content: "Objective B reply",
          agentId: "factory",
        },
      ],
      [runAStream]: [
        {
          type: "problem.set",
          runId: "run_objective_a",
          problem: "Summarize objective A.",
          agentId: "factory",
        },
        {
          type: "thread.bound",
          runId: "run_objective_a",
          objectiveId: "objective_a",
          chatId: "chat_demo",
          reason: "startup",
        },
        {
          type: "run.status",
          runId: "run_objective_a",
          status: "completed",
          agentId: "factory",
        },
        {
          type: "response.finalized",
          runId: "run_objective_a",
          content: "Objective A reply",
          agentId: "factory",
        },
      ],
      [runBStream]: [
        {
          type: "problem.set",
          runId: "run_objective_b",
          problem: "Summarize objective B.",
          agentId: "factory",
        },
        {
          type: "thread.bound",
          runId: "run_objective_b",
          objectiveId: "objective_b",
          chatId: "chat_demo",
          reason: "startup",
        },
        {
          type: "run.status",
          runId: "run_objective_b",
          status: "completed",
          agentId: "factory",
        },
        {
          type: "response.finalized",
          runId: "run_objective_b",
          content: "Objective B reply",
          agentId: "factory",
        },
      ],
    },
    service: {
      listObjectives: async () => [
        objectiveA as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
        objectiveB as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async (objectiveId: string) => objectiveId === "objective_b" ? objectiveB : objectiveA,
    },
  });

  const response = await app.request("http://receipt.test/factory/island/chat?profile=generalist&chat=chat_demo&objective=objective_b&inspectorTab=chat");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Objective B reply");
  expect(body).not.toContain("Objective A reply");
  expect(body).toContain('data-objective-id="objective_b"');
});

test("factory workbench: completed filter without an explicit objective keeps New Chat selected until an objective is opened", async () => {
  const activeObjective = makeRunningWorkbenchObjectiveDetail("objective_live");
  const completedObjective = {
    ...makeStubObjectiveDetail("objective_done"),
    title: "Completed objective",
    status: "completed",
    phase: "completed",
    scheduler: { slotState: "idle" },
    latestSummary: "Completed objective summary.",
    nextAction: "Objective is complete.",
    activeTaskCount: 0,
    readyTaskCount: 0,
    taskCount: 1,
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const additionalCompletedObjective = {
    ...makeStubObjectiveDetail("objective_done_2"),
    title: "Badge-free completed card",
    status: "completed",
    phase: "completed",
    scheduler: { slotState: "idle" },
    latestSummary: "Wrapped cleanly without additional operator work.",
    nextAction: "Archive when ready.",
    activeTaskCount: 0,
    readyTaskCount: 0,
    taskCount: 1,
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const activeCard = { ...activeObjective, section: "active" as const };
  const completedCard = { ...completedObjective, section: "completed" as const };
  const additionalCompletedCard = { ...additionalCompletedObjective, section: "completed" as const };
  const app = createRouteTestApp({
    service: {
      buildBoardProjection: async () => ({
        objectives: [activeCard, completedCard, additionalCompletedCard],
        sections: {
          needs_attention: [],
          active: [activeCard],
          queued: [],
          completed: [completedCard, additionalCompletedCard],
        },
        selectedObjectiveId: "objective_live",
      }),
      listObjectives: async () => [
        activeObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
        completedObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
        additionalCompletedObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async (objectiveId: string) => objectiveId === "objective_done"
        ? completedObjective
        : objectiveId === "objective_done_2"
          ? additionalCompletedObjective
          : activeObjective,
    },
  });

  const shellResponse = await app.request("http://receipt.test/factory/api/workbench-shell?profile=generalist&chat=chat_demo&detailTab=queue&filter=objective.completed");
  const shell = await shellResponse.json() as { readonly routeKey?: string };
  expect(shellResponse.status).toBe(200);
  expect(shell.routeKey).toBe("/factory?profile=generalist&chat=chat_demo&detailTab=queue&filter=objective.completed");

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&detailTab=queue&filter=objective.completed");
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(body).toContain("Current Run");
  expect(body).toContain("Selected Objective");
  expect(body).toContain("No objective selected.");
  expect(body).toContain("Completed objective");
  expect(body).toContain("Badge-free completed card");
  expect(body).toContain('data-factory-href="/factory?profile=generalist&amp;chat=chat_demo&amp;objective=objective_done&amp;inspectorTab=chat&amp;detailTab=queue&amp;filter=objective.completed"');
  expect(body).not.toContain('data-objective-id="objective_done" data-selected="true" aria-current="page"');
  expect(body).not.toContain(">Selected<");
  const badgeFreeCardIndex = body.indexOf("Badge-free completed card");
  expect(badgeFreeCardIndex).toBeGreaterThan(-1);
  expect(body.slice(badgeFreeCardIndex, badgeFreeCardIndex + 240)).not.toContain(">Completed<");
});

test("factory workbench route: empty state points operators to New Chat and /obj when no objective is selected", async () => {
  const app = createRouteTestApp();

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("New Chat");
  expect(body).toContain("/obj");
  expect(body).toContain("Ask a new question, or use /obj to create an objective directly.");
  expect(body).toContain("Current Run");
  expect(body).toContain("Selected Objective");
  expect(body).toContain("No objective selected.");
  expect(body).toContain("Use chat to create a new objective or select one from the queue below.");
  expect(body).toContain("No objective is selected. Start in New Chat to discuss the work, or select an objective from the queue to reopen its chat.");
  expect(body).toContain('data-detail-tab="queue"');
});

test("factory workbench route: chat events stay scoped to the chat session when no objective is selected", async () => {
  let subscriptions: ReadonlyArray<{ readonly topic: string; readonly stream?: string }> = [];
  const sessionStream = factoryChatSessionStream(process.cwd(), "generalist", "chat_demo");
  const app = createRouteTestApp({
    jobs: [{
      id: "job_chat_demo",
      agentId: "factory",
      lane: "chat",
      payload: {
        kind: "factory.run",
        chatId: "chat_demo",
      },
      status: "queued",
      attempt: 1,
      maxAttempts: 1,
      createdAt: 1,
      updatedAt: 1,
      commands: [],
    }],
    onSubscribeMany: (value) => {
      subscriptions = value;
    },
  });

  const response = await app.request("http://receipt.test/factory/chat/events?profile=generalist&chat=chat_demo");

  expect(response.status).toBe(200);
  expect(subscriptions).toEqual([
    { topic: "agent", stream: sessionStream },
    { topic: "profile-board", stream: "generalist" },
  ]);
  expect(subscriptions.some((subscription) => subscription.topic === "factory")).toBe(false);
  expect(subscriptions.some((subscription) => subscription.topic === "objective-runtime")).toBe(false);
  expect(subscriptions.some((subscription) => subscription.topic === "jobs")).toBe(false);
});

test("factory workbench route: background events subscribe to profile-board and selected objective runtime projections", async () => {
  let subscriptions: ReadonlyArray<{ readonly topic: string; readonly stream?: string }> = [];
  const activeObjective = makeRunningWorkbenchObjectiveDetail("objective_live");
  const pastObjective = {
    ...makeStubObjectiveDetail("objective_done", "job_done"),
    status: "completed",
    phase: "completed",
    scheduler: { slotState: "idle" },
    activeTaskCount: 0,
    readyTaskCount: 0,
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const activeCard = { ...activeObjective, section: "active" as const };
  const completedCard = { ...pastObjective, section: "completed" as const };
  const app = createRouteTestApp({
    onSubscribeMany: (value) => {
      subscriptions = value;
    },
    service: {
      buildBoardProjection: async () => ({
        objectives: [activeCard, completedCard],
        sections: {
          needs_attention: [],
          active: [activeCard],
          queued: [],
          completed: [completedCard],
        },
        selectedObjectiveId: "objective_live",
      }),
      listObjectives: async () => [
        activeObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
        pastObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async (objectiveId: string) =>
        objectiveId === "objective_done" ? pastObjective : activeObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory/background/events?profile=generalist&chat=chat_demo&objective=objective_live");

  expect(response.status).toBe(200);
  expect(subscriptions).toEqual([
    { topic: "profile-board", stream: "generalist" },
    { topic: "objective-runtime", stream: "objective_live" },
  ]);
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

  const response = await app.request("http://receipt.test/factory?profile=generalist&objective=objective_idle");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).not.toContain("Running Task Workbench");
  expect(body).toContain("Tasks");
});
test("factory route: new chat creates an isolated chat session", async () => {
  const app = createRouteTestApp();

  const response = await app.request("http://receipt.test/factory/new-chat?profile=generalist");

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toMatch(/^\/factory\?profile=generalist&chat=chat_[a-z0-9]+_[a-z0-9]+&inspectorTab=chat&detailTab=queue$/);
});

test("factory route: plain prompts queue a saved chat run without creating an objective", async () => {
  let queuedInput: Record<string, unknown> | undefined;
  let createObjectiveCalled = false;
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
      createObjective: async () => {
        createObjectiveCalled = true;
        throw new Error("unexpected objective creation");
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
  expect(response.headers.get("location")).toMatch(/^\/factory\?profile=generalist&chat=chat_[a-z0-9]+_[a-z0-9]+&detailTab=queue$/);
  expect(response.headers.get("location")).not.toContain("objective=");
  expect(createObjectiveCalled).toBe(false);
  expect(queuedInput).toMatchObject({
    agentId: "factory",
    lane: "chat",
    singletonMode: "steer",
  });
  expect((queuedInput?.payload as Record<string, unknown> | undefined)).toMatchObject({
    kind: "factory.run",
    profileId: "generalist",
    problem: "Start fresh.",
  });
  expect((queuedInput?.payload as Record<string, unknown> | undefined)?.chatId).toMatch(/^chat_[a-z0-9]+_[a-z0-9]+$/);
  expect((queuedInput?.payload as Record<string, unknown> | undefined)?.objectiveId).toBeUndefined();
});

test("factory workbench route: plain prompts stay chat-first while preserving the selected objective in page state", async () => {
  let queuedInput: Record<string, unknown> | undefined;
  let createObjectiveCalled = false;
  const app = createRouteTestApp({
    onEnqueue: async (input) => {
      queuedInput = input;
      return {
        id: "job_workbench_chat",
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
      createObjective: async () => {
        createObjectiveCalled = true;
        throw new Error("unexpected objective creation");
      },
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&chat=chat_demo&objective=objective_demo", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body: new URLSearchParams({
      prompt: "Keep the chat focused on queue health.",
    }).toString(),
  });

  expect(response.status).toBe(200);
  const body = await response.json() as {
    readonly location?: string;
    readonly chat?: { readonly chatId?: string };
    readonly selection?: { readonly objectiveId?: string };
  };
  expect(body.location).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action");
  expect(body.chat).toEqual({ chatId: "chat_demo" });
  expect(body.selection).toEqual({ objectiveId: "objective_demo" });
  expect(createObjectiveCalled).toBe(false);
  expect((queuedInput?.payload as Record<string, unknown> | undefined)).toMatchObject({
    kind: "factory.run",
    profileId: "generalist",
    chatId: "chat_demo",
    objectiveId: "objective_demo",
    problem: "Keep the chat focused on queue health.",
  });
});

test("factory route: composer accepts UI chat submissions and returns a chat-centric shell location", async () => {
  let queuedInput: Record<string, unknown> | undefined;
  let createObjectiveCalled = false;
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
      createObjective: async () => {
        createObjectiveCalled = true;
        throw new Error("unexpected objective creation");
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
  expect(response.headers.get("location")).toBe("/factory?profile=generalist&chat=chat_demo&detailTab=queue");
  expect(createObjectiveCalled).toBe(false);
  expect(queuedInput).toMatchObject({
    agentId: "factory",
    lane: "chat",
    singletonMode: "steer",
  });
  expect((queuedInput?.payload as Record<string, unknown> | undefined)).toMatchObject({
    kind: "factory.run",
    profileId: "generalist",
    chatId: "chat_demo",
    problem: "Check the repo and tell me what happens next.",
  });
  expect((queuedInput?.payload as Record<string, unknown> | undefined)?.objectiveId).toBeUndefined();
});

test("factory route: json compose responses use the workbench chat and selection contract", async () => {
  let queuedInput: Record<string, unknown> | undefined;
  const app = createRouteTestApp({
    onEnqueue: async (input) => {
      queuedInput = input;
      return {
        id: "job_chat_json",
        agentId: "factory",
        payload: (input.payload as Record<string, unknown> | undefined) ?? {},
        lane: "chat",
        status: "queued",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 1,
        updatedAt: 1,
        commands: [],
      } as QueueJob;
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body: new URLSearchParams({
      prompt: "List the current jobs.",
    }).toString(),
  });

  expect(response.status).toBe(200);
  const body = await response.json() as {
    readonly location?: string;
    readonly live?: {
      readonly profileId?: string;
      readonly chatId?: string;
      readonly runId?: string;
      readonly jobId?: string;
    };
    readonly chat?: {
      readonly chatId?: string;
    };
    readonly selection?: {
      readonly objectiveId?: string;
    };
  };
  expect(body.location).toMatch(/^\/factory\?profile=generalist&chat=chat_[a-z0-9]+_[a-z0-9]+&detailTab=queue$/);
  expect(body.chat?.chatId).toMatch(/^chat_[a-z0-9]+_[a-z0-9]+$/);
  expect(body.chat?.chatId).toBe((queuedInput?.payload as Record<string, unknown> | undefined)?.chatId);
  expect(body.live?.profileId).toBe("generalist");
  expect(body.live?.chatId).toBe(body.chat?.chatId);
  expect(body.live?.runId).toBe((queuedInput?.payload as Record<string, unknown> | undefined)?.runId);
  expect(body.live?.jobId).toBe("job_chat_json");
  expect(body.selection).toBeUndefined();
});

test("factory route: software diagnostic prompts stay in chat until explicitly dispatched", async () => {
  let queuedInput: Record<string, unknown> | undefined;
  let createObjectiveCalled = false;
  const app = createRouteTestApp({
    onEnqueue: async (input) => {
      queuedInput = input;
      return {
        id: "job_chat_diag",
        agentId: "factory",
        payload: (input.payload as Record<string, unknown> | undefined) ?? {},
        lane: "chat",
        status: "queued",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 1,
        updatedAt: 1,
        commands: [],
      } as QueueJob;
    },
    service: {
      createObjective: async () => {
        createObjectiveCalled = true;
        throw new Error("unexpected objective creation");
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
  expect(response.headers.get("location")).toBe("/factory?profile=software&chat=chat_software&detailTab=queue");
  expect(createObjectiveCalled).toBe(false);
  expect((queuedInput?.payload as Record<string, unknown> | undefined)).toMatchObject({
    kind: "factory.run",
    profileId: "software",
    chatId: "chat_software",
    problem: "why is build failing",
  });
  expect((queuedInput?.payload as Record<string, unknown> | undefined)?.objectiveId).toBeUndefined();
});

test("factory route: aws inventory prompts stay on the selected profile without auto-creating objectives", async () => {
  let queuedInput: Record<string, unknown> | undefined;
  let createObjectiveCalled = false;
  const app = createRouteTestApp({
    service: {
      createObjective: async () => {
        createObjectiveCalled = true;
        throw new Error("unexpected objective creation");
      },
    },
    onEnqueue: async (input) => {
      queuedInput = input;
      return {
        id: "job_chat_ec2",
        agentId: "factory",
        payload: (input.payload as Record<string, unknown> | undefined) ?? {},
        lane: "chat",
        status: "queued",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 1,
        updatedAt: 1,
        commands: [],
      };
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&chat=chat_demo", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "show me ec2 list",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/factory?profile=generalist&chat=chat_demo&detailTab=queue");
  expect(createObjectiveCalled).toBe(false);
  expect((queuedInput?.payload as Record<string, unknown> | undefined)).toMatchObject({
    kind: "factory.run",
    profileId: "generalist",
    chatId: "chat_demo",
    problem: "show me ec2 list",
  });
  expect((queuedInput?.payload as Record<string, unknown> | undefined)?.objectiveId).toBeUndefined();
});

test("factory route: follow-up composer submissions keep the selected completed objective in page state", async () => {
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

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&chat=chat_demo&objective=objective_done", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "Continue with the next piece of work.",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_done&detailTab=action");
  expect((queuedInput?.payload as Record<string, unknown> | undefined)).toMatchObject({
    kind: "factory.run",
    profileId: "generalist",
    chatId: "chat_demo",
    objectiveId: "objective_done",
    problem: "Continue with the next piece of work.",
  });
});

test("factory route: composer stays chat-first even when prior session runs referenced an objective", async () => {
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
  expect(response.headers.get("location")).toBe("/factory?profile=generalist&chat=chat_demo&detailTab=queue");
});

test("factory route: conversational prompts queue an unbound chat run instead of creating a tracked objective", async () => {
  let enqueueInput: Record<string, unknown> | undefined;
  let createObjectiveCalled = false;
  const app = createRouteTestApp({
    onEnqueue: async (input) => {
      enqueueInput = input;
      return {
        id: "job_chat_smalltalk",
        agentId: "factory",
        payload: (input.payload as Record<string, unknown> | undefined) ?? {},
        lane: "chat",
        status: "queued",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 1,
        updatedAt: 1,
        commands: [],
      } as QueueJob;
    },
    service: {
      createObjective: async () => {
        createObjectiveCalled = true;
        throw new Error("unexpected objective creation");
      },
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "How are you?",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toMatch(/^\/factory\?profile=generalist&chat=chat_[a-z0-9]+_[a-z0-9]+&detailTab=queue$/);
  expect(response.headers.get("location")).not.toContain("objective=");
  expect(createObjectiveCalled).toBe(false);
  expect((enqueueInput?.payload as Record<string, unknown> | undefined)).toMatchObject({
    kind: "factory.run",
    profileId: "generalist",
    problem: "How are you?",
  });
  expect((enqueueInput?.payload as Record<string, unknown> | undefined)?.objectiveId).toBeUndefined();
});

test("factory route: plain follow-ups from a selected objective still queue chat work", async () => {
  let enqueueInput: Record<string, unknown> | undefined;
  const app = createRouteTestApp({
    onEnqueue: async (input) => {
      enqueueInput = (input.payload as Record<string, unknown> | undefined) ?? {};
      return {
        id: "job_chat_followup",
        agentId: "factory",
        payload: enqueueInput,
        lane: "chat",
        status: "queued",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 1,
        updatedAt: 1,
        commands: [],
      } as QueueJob;
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=infrastructure&chat=chat_demo&objective=objective_demo", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "Investigate why the current requests are queueing.",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/factory?profile=infrastructure&chat=chat_demo&objective=objective_demo&detailTab=action");
  expect(enqueueInput).toMatchObject({
    kind: "factory.run",
    profileId: "infrastructure",
    chatId: "chat_demo",
    objectiveId: "objective_demo",
    problem: "Investigate why the current requests are queueing.",
  });
});

test("factory route: /new creates a new objective while keeping the current chat selected", async () => {
  let createdInput: Record<string, unknown> | undefined;
  const app = createRouteTestApp({
    service: {
      createObjective: async (input: Record<string, unknown>) => {
        createdInput = input;
        return makeStubObjectiveDetail("objective_created", "job_created");
      },
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&chat=chat_current&objective=objective_old", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "/new Build the replacement thread.",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/factory?profile=generalist&chat=chat_current&objective=objective_created&detailTab=action");
  expect(createdInput).toMatchObject({
    title: "Build the replacement thread",
    prompt: "Build the replacement thread.",
    profileId: "generalist",
    startImmediately: true,
  });
});

test("factory workbench route: /obj creates an objective and returns explicit selection metadata", async () => {
  let createdInput: Record<string, unknown> | undefined;
  const app = createRouteTestApp({
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
      "accept": "application/json",
    },
    body: new URLSearchParams({
      prompt: "/obj Build the replacement objective.",
    }).toString(),
  });

  expect(response.status).toBe(200);
  const body = await response.json() as {
    readonly location?: string;
    readonly chat?: { readonly chatId?: string };
    readonly selection?: { readonly objectiveId?: string };
  };
  expect(body.location).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_created&detailTab=action");
  expect(body.chat).toEqual({ chatId: "chat_demo" });
  expect(body.selection).toEqual({ objectiveId: "objective_created" });
  expect(createdInput).toMatchObject({
    title: "Build the replacement objective",
    prompt: "Build the replacement objective.",
    profileId: "generalist",
    startImmediately: true,
  });
});

test("factory route: composer slash commands mutate the selected objective on the canonical workbench route", async () => {
  let reacted: { readonly objectiveId: string; readonly message?: string } | undefined;
  const app = createRouteTestApp({
    service: {
      reactObjectiveWithNote: async (objectiveId: string, message?: string) => {
        reacted = { objectiveId, message };
        return makeStubObjectiveDetail(objectiveId);
      },
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&chat=chat_demo&objective=objective_demo&job=job_01", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "/react Keep receipts concise.",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action");
  expect(reacted).toEqual({
    objectiveId: "objective_demo",
    message: "Keep receipts concise.",
  });
});

test("factory workbench route: /react mutates the selected objective from the page route", async () => {
  let reacted: { readonly objectiveId: string; readonly message?: string } | undefined;
  const app = createRouteTestApp({
    service: {
      reactObjectiveWithNote: async (objectiveId: string, message?: string) => {
        reacted = { objectiveId, message };
        return makeStubObjectiveDetail(objectiveId);
      },
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&chat=chat_demo&objective=objective_demo", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body: new URLSearchParams({
      prompt: "/react Keep queue status visible in the workbench.",
    }).toString(),
  });

  expect(response.status).toBe(200);
  const body = await response.json() as {
    readonly location?: string;
    readonly chat?: { readonly chatId?: string };
    readonly selection?: { readonly objectiveId?: string };
  };
  expect(body.location).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action");
  expect(body.chat).toEqual({ chatId: "chat_demo" });
  expect(body.selection).toEqual({ objectiveId: "objective_demo" });
  expect(reacted).toEqual({
    objectiveId: "objective_demo",
    message: "Keep queue status visible in the workbench.",
  });
});

test("factory route: conversational follow-ups preserve the selected objective context in the workbench", async () => {
  let enqueueInput: Record<string, unknown> | undefined;
  const app = createRouteTestApp({
    onEnqueue: async (input) => {
      enqueueInput = input;
      return {
        id: "job_chat_detached",
        agentId: "factory",
        payload: (input.payload as Record<string, unknown> | undefined) ?? {},
        lane: "chat",
        status: "queued",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 1,
        updatedAt: 1,
        commands: [],
      } as QueueJob;
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&chat=chat_current&objective=objective_old&panel=overview&focusKind=task&focusId=task_01", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "Who are you?",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/factory?profile=generalist&chat=chat_current&objective=objective_old&detailTab=action&focusKind=task&focusId=task_01");
  expect((enqueueInput?.payload as Record<string, unknown> | undefined)).toMatchObject({
    kind: "factory.run",
    profileId: "generalist",
    problem: "Who are you?",
    chatId: "chat_current",
    objectiveId: "objective_old",
  });
});

test("factory route: /analyze queues a chat run instead of returning a static UI link", async () => {
  let reacted: { readonly objectiveId: string; readonly message?: string } | undefined;
  const app = createRouteTestApp({
    service: {
      reactObjectiveWithNote: async (objectiveId: string, message?: string) => {
        reacted = { objectiveId, message };
        return makeStubObjectiveDetail(objectiveId);
      },
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&chat=chat_demo&objective=objective_demo", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body: new URLSearchParams({
      prompt: "/analyze",
    }).toString(),
  });

  expect(response.status).toBe(200);
  const body = await response.json() as {
    readonly location?: string;
  };
  expect(body.location).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action");
  expect(reacted).toEqual({
    objectiveId: "objective_demo",
    message: "Please analyze the current objective state, review the plan, and provide recommendations.",
  });
});

test("factory route: compose redirects drop unsupported mode query params", async () => {
  const app = createRouteTestApp();

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&chat=chat_demo&objective=objective_demo&mode=mission-control", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "/analyze",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action");
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

  const abortResponse = await app.request("http://receipt.test/factory/compose?profile=generalist&objective=objective_demo&job=job_01", {
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
    by: "factory.workbench",
  });
});

test("factory route: removed factory POST endpoints stay unavailable outside the composer route", async () => {
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

// ── /runtime page ─────────────────────────────────────────────────────────────

test("factory route: /runtime returns full runtime architecture page", async () => {
  const app = createRouteTestApp();
  const response = await app.request("http://receipt.test/runtime");
  expect(response.status).toBe(200);
  const body = await response.text();
  // Page shell
  expect(body).toContain("RECEIPT RUNTIME");
  expect(body).toContain("<!doctype html>");
  // All three planes
  expect(body).toContain("Control Plane");
  expect(body).toContain("Execution Plane");
  expect(body).toContain("Side Effects");
  // All 6 actors with impl references
  expect(body).toContain("HTTP Commands");
  expect(body).toContain("handlers.ts");
  expect(body).toContain("Readiness Engine");
  expect(body).toContain("factoryReadyTasks()");
  expect(body).toContain("Lease Controller");
  expect(body).toContain("JobWorker");
  expect(body).toContain("Run Driver");
  expect(body).toContain("runDriver()");
  expect(body).toContain("Tool Executor");
  expect(body).toContain("LocalCodexExecutor");
  expect(body).toContain("Outbox Worker");
  // Data stores
  expect(body).toContain("work_items");
  expect(body).toContain("DEPENDENCY GRAPH");
  expect(body).toContain("run_leases");
  expect(body).toContain("LEASE TABLE");
  expect(body).toContain("event_outbox");
  expect(body).toContain("SIDE-EFFECT QUEUE");
  // Concurrency callout
  expect(body).toContain("Multi-Objective Concurrency");
  expect(body).toContain("per objective, N in parallel");
  // Delegation loop
  expect(body).toContain("Child-Run Delegation Loop");
  expect(body).toContain("delegate_to_agent");
});
