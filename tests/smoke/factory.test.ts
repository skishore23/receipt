import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Hono } from "hono";

import { fold } from "@receipt/core/chain";
import { receipt } from "@receipt/core/chain";
import { sqliteBranchStore, sqliteReceiptStore } from "../../src/adapters/sqlite";
import type { MemoryEntry, MemoryTools } from "../../src/adapters/memory-tools";
import { sqliteQueue, type QueueJob } from "../../src/adapters/sqlite-queue";
import { createRuntime, type Runtime } from "@receipt/core/runtime";
import { SseHub } from "../../src/framework/sse-hub";
import type { AgentLoaderContext } from "../../src/framework/agent-types";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";
import { syncChatContextProjectionStream, syncObjectiveProjectionStream } from "../../src/db/projectors";
import { getReceiptDb } from "../../src/db/client";
import * as dbSchema from "../../src/db/schema";
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
import { FactoryService, FactoryServiceError, type FactoryTaskJobPayload } from "../../src/services/factory-service";
import { factoryChatSessionStream, factoryChatStream, repoKeyForRoot } from "../../src/services/factory-chat-profiles";
import { ensureFactoryWorkspaceCommandEnv, runFactoryChecks } from "../../src/services/factory/check-runner";
import { readPersistedObjectiveAuditMetadata } from "../../src/services/factory/objective-audit-artifacts";
import {
  checkpointFactoryExecutionEvidenceState,
  createFactoryExecutionEvidenceState,
  factoryExecutionEvidenceStatePath,
  refineFactoryExecutionEvidenceStateForHardness,
  writeFactoryExecutionEvidenceState,
} from "../../src/services/factory/runtime/evidence-state";
import {
  buildFactoryWorkbenchShellSnapshot,
  factoryWorkbenchBoardResponse,
  factoryWorkbenchHeaderIsland,
  factoryWorkbenchShell,
} from "../../src/views/factory/workbench/page";
import { buildFactoryWorkbench } from "../../src/views/factory-workbench";
import type { FactoryWorkbenchPageModel } from "../../src/views/factory-models";
import { renderFactoryTranscriptSection } from "../../src/views/factory/transcript";
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

const writeChatProjection = async (input: {
  readonly dataDir: string;
  readonly repoRoot: string;
  readonly profileId: string;
  readonly chatId: string;
  readonly events: ReadonlyArray<AgentEvent>;
}): Promise<void> => {
  const sessionStream = factoryChatSessionStream(input.repoRoot, input.profileId, input.chatId);
  let prev: string | undefined;
  const receipts = input.events.map((event, index) => {
    const next = receipt(sessionStream, prev, event, index + 1);
    prev = next.hash;
    return next;
  });
  const db = getReceiptDb(input.dataDir);
  db.write(() => {
    db.orm.insert(dbSchema.streams)
      .values({
        name: sessionStream,
        headHash: receipts.at(-1)?.hash ?? null,
        receiptCount: receipts.length,
        updatedAt: receipts.at(-1)?.ts ?? Date.now(),
        lastTs: receipts.at(-1)?.ts ?? Date.now(),
      })
      .onConflictDoUpdate({
        target: dbSchema.streams.name,
        set: {
          headHash: receipts.at(-1)?.hash ?? null,
          receiptCount: receipts.length,
          updatedAt: receipts.at(-1)?.ts ?? Date.now(),
          lastTs: receipts.at(-1)?.ts ?? Date.now(),
        },
      })
      .run();
    db.orm.insert(dbSchema.receipts)
      .values(receipts.map((entry, index) => ({
        stream: entry.stream,
        streamSeq: index + 1,
        receiptId: entry.id,
        ts: entry.ts,
        prevHash: entry.prevHash ?? null,
        hash: entry.hash,
        eventType: entry.body.type,
        bodyJson: JSON.stringify(entry.body),
        hintsJson: null,
      })))
      .run();
  });
  await syncChatContextProjectionStream(input.dataDir, sessionStream);
};

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
    sqliteReceiptStore<JobEvent>(dataDir),
    sqliteBranchStore(dataDir),
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
  phase: "collecting_evidence",
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
  readonly dataDir?: string;
  readonly liveOutput?: Record<string, unknown>;
  readonly jobs?: ReadonlyArray<QueueJob>;
  readonly memoryTools?: MemoryTools;
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
    | "queueJobSteer"
    | "queueJobFollowUp"
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
    dataDir: overrides?.dataDir,
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
    queueJobAbort: async (jobId: string) => ({
      job: await dummyQueue.getJob(jobId) ?? {
        id: jobId,
        agentId: "factory",
        payload: {},
        lane: "chat",
        status: "queued",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 1,
        updatedAt: 1,
        commands: [],
      } as QueueJob,
      command: {
        id: "cmd_abort",
        command: "abort",
        lane: "steer",
        payload: {},
        createdAt: 1,
        by: "factory.test",
      },
    }),
    queueJobSteer: async (jobId: string, message: string) => ({
      job: await dummyQueue.getJob(jobId) ?? {
        id: jobId,
        agentId: "factory",
        payload: {},
        lane: "chat",
        status: "queued",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 1,
        updatedAt: 1,
        commands: [],
      } as QueueJob,
      command: {
        id: "cmd_steer",
        command: "steer",
        lane: "steer",
        payload: { message },
        createdAt: 1,
        by: "factory.test",
      },
    }),
    queueJobFollowUp: async (jobId: string, message: string) => ({
      job: await dummyQueue.getJob(jobId) ?? {
        id: jobId,
        agentId: "factory",
        payload: {},
        lane: "chat",
        status: "queued",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 1,
        updatedAt: 1,
        commands: [],
      } as QueueJob,
      command: {
        id: "cmd_follow_up",
        command: "follow_up",
        lane: "follow_up",
        payload: { message },
        createdAt: 1,
        by: "factory.test",
      },
    }),
    promoteObjective: async (objectiveId: string) => makeStubObjectiveDetail(objectiveId),
    cancelObjective: async (objectiveId: string) => makeStubObjectiveDetail(objectiveId),
    cleanupObjectiveWorkspaces: async (objectiveId: string) => makeStubObjectiveDetail(objectiveId),
    archiveObjective: async (objectiveId: string) => makeStubObjectiveDetail(objectiveId),
    getObjectiveLiveOutput: async () => overrides?.liveOutput,
    ...(overrides?.service ?? {}),
  };
  const ctx: AgentLoaderContext = {
    dataDir: overrides?.dataDir ?? "data",
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
      ...(overrides?.memoryTools ? { memoryTools: overrides.memoryTools } : {}),
      profileRoot: process.cwd(),
    },
  };
  const app = new Hono();
  createFactoryRoute(ctx).register(app);
  return app;
};

const createRouteTestMemoryTools = (input: {
  readonly repoRoot?: string;
  readonly repoPreferenceText?: string;
  readonly globalPreferenceText?: string;
} = {}): MemoryTools => {
  const repoKey = repoKeyForRoot(input.repoRoot ?? process.cwd());
  const entries: ReadonlyArray<MemoryEntry> = [
    input.repoPreferenceText
      ? {
          id: "pref_repo_01",
          scope: `repos/${repoKey}/users/default/preferences`,
          text: input.repoPreferenceText,
          tags: ["user-preference"],
          meta: { kind: "preference", source: "explicit_user", status: "active" },
          ts: 2,
        }
      : undefined,
    input.globalPreferenceText
      ? {
          id: "pref_global_01",
          scope: "users/default/preferences",
          text: input.globalPreferenceText,
          tags: ["user-preference"],
          meta: { kind: "preference", source: "explicit_user", status: "active" },
          ts: 1,
        }
      : undefined,
  ].filter((entry): entry is MemoryEntry => Boolean(entry));
  return {
    read: async ({ scope, limit }) => entries.filter((entry) => entry.scope === scope).slice(0, limit ?? entries.length),
    search: async () => [],
    summarize: async () => ({ summary: "", entries: [] }),
    commit: async (payload) => ({
      id: "pref_new",
      scope: payload.scope,
      text: payload.text,
      tags: payload.tags,
      meta: payload.meta,
      ts: Date.now(),
    }),
    diff: async () => [],
    reindex: async () => 0,
  };
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

test("factory workspace command env keeps standard executable paths even when PATH is empty", async () => {
  const rootDir = await createTempDir("receipt-factory-command-env");
  const workspacePath = path.join(rootDir, "worktrees", "task-01");
  const dataDir = path.join(rootDir, "data");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });

  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "";
    const commandEnv = await ensureFactoryWorkspaceCommandEnv({
      workspacePath,
      dataDir,
      repoRoot: process.cwd(),
      worktreesDir: path.join(rootDir, "worktrees"),
    });
    const standardDirs = (
      await Promise.all(
        [
          "/opt/homebrew/bin",
          "/opt/homebrew/sbin",
          "/usr/local/bin",
          "/usr/local/sbin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
        ].map(async (dir) => fs.access(dir).then(() => dir).catch(() => undefined)),
      )
    ).filter((dir): dir is string => Boolean(dir));

    expect(standardDirs.length).toBeGreaterThan(0);
    expect(commandEnv.path.split(path.delimiter).some((entry) => standardDirs.includes(entry))).toBe(true);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("factory service: objective control jobs use a dedicated worker id so /factory chat jobs are not hijacked", async () => {
  const dataDir = await createTempDir("receipt-factory-control-worker");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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
  expect(jobs[0]?.singletonMode).toBe("allow");
});

test("factory service: objective lists refresh after an external projection write", async () => {
  const dataDir = await createTempDir("receipt-factory-external-projection");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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

test("factory service: getObjective surfaces persisted self-improvement audit metadata", async () => {
  const dataDir = await createTempDir("receipt-factory-audit-ui");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Audit UI visibility",
    prompt: "Surface self-improvement recommendations in the workbench.",
    checks: ["git status --short"],
  });

  const auditDir = path.join(dataDir, "factory", "artifacts", created.objectiveId);
  await fs.mkdir(auditDir, { recursive: true });
  await fs.writeFile(path.join(auditDir, "objective.audit.json"), JSON.stringify({
    objectiveId: created.objectiveId,
    audit: {
      generatedAt: 1234,
      recommendationStatus: "ready",
      recommendations: [{
        summary: "Show the latest audit recommendations in the objective UI.",
        anomalyPatterns: ["missing-ui-visibility"],
        scope: "ui",
        confidence: "high",
        suggestedFix: "Render persisted self-improvement recommendations in the workbench summary.",
      }],
      autoFixObjectiveId: "objective_auto_fix",
      recurringPatterns: [{
        pattern: "missing-ui-visibility",
        count: 2,
      }],
    },
  }, null, 2), "utf-8");

  const detail = await service.getObjective(created.objectiveId);

  expect(detail.selfImprovement).toEqual({
    auditedAt: 1234,
    auditStatus: "ready",
    auditStatusMessage: undefined,
    stale: false,
    recommendationStatus: "ready",
    recommendationError: undefined,
    recommendations: [{
      summary: "Show the latest audit recommendations in the objective UI.",
      anomalyPatterns: ["missing-ui-visibility"],
      scope: "ui",
      confidence: "high",
      suggestedFix: "Render persisted self-improvement recommendations in the workbench summary.",
    }],
    autoFixObjectiveId: "objective_auto_fix",
    recurringPatterns: [{
      pattern: "missing-ui-visibility",
      count: 2,
    }],
  });
});

test("factory service: getObjective marks stale self-improvement snapshots instead of treating them as current", async () => {
  const dataDir = await createTempDir("receipt-factory-audit-stale");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Audit staleness visibility",
    prompt: "Make stale self-improvement snapshots visible instead of presenting them as current.",
    checks: ["git status --short"],
  });

  const auditDir = path.join(dataDir, "factory", "artifacts", created.objectiveId);
  await fs.mkdir(auditDir, { recursive: true });
  await fs.writeFile(path.join(auditDir, "objective.audit.json"), JSON.stringify({
    objectiveId: created.objectiveId,
    audit: {
      generatedAt: 1234,
      objectiveUpdatedAt: Math.max(0, created.updatedAt - 1),
      recommendationStatus: "ready",
      recommendations: [],
      recurringPatterns: [],
    },
  }, null, 2), "utf-8");

  const detail = await service.getObjective(created.objectiveId);

  expect(detail.selfImprovement?.stale).toBe(true);
  expect(detail.selfImprovement?.auditStatus).toBe("missing");
  expect(detail.selfImprovement?.auditStatusMessage).toContain("predates");
});

test("factory service: ignores malformed persisted self-improvement audit artifacts", async () => {
  const dataDir = await createTempDir("receipt-factory-audit-invalid");
  const objectiveId = "objective_invalid_audit";
  const auditDir = path.join(dataDir, "factory", "artifacts", objectiveId);
  await fs.mkdir(auditDir, { recursive: true });
  await fs.writeFile(path.join(auditDir, "objective.audit.json"), JSON.stringify({
    objectiveId,
    audit: {
      recommendations: [{
        summary: "This artifact is incomplete and should be ignored.",
        suggestedFix: "Do not load partial audit snapshots.",
      }],
    },
  }, null, 2), "utf-8");

  const metadata = await readPersistedObjectiveAuditMetadata(dataDir, objectiveId);

  expect(metadata).toBeUndefined();
});

test("factory service: task live output marks stale Codex work as stalled and surfaces raw stdout", async () => {
  const dataDir = await createTempDir("receipt-factory-live-output-stalled");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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

test("factory service: objective cards reclassify stale execution without waiting for a new receipt", async () => {
  const dataDir = await createTempDir("receipt-factory-card-stalled");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const originalNow = Date.now;
  Date.now = () => 10_000;
  try {
    const created = await service.createObjective({
      title: "Objective card stalled state",
      prompt: "Show stalled execution on the objective board even without a new receipt.",
      checks: ["git status --short"],
    });

    await runObjectiveStartup(service, created.objectiveId);

    const taskJob = (await queue.listJobs({ limit: 20 }))
      .find((job) => job.payload.kind === "factory.task.run" && job.payload.objectiveId === created.objectiveId);
    expect(taskJob).toBeDefined();
    if (!taskJob) throw new Error("expected dispatched task job");

    const workerId = "worker_test:codex";
    await queue.leaseJob(taskJob.id, workerId, 900_000);
    await queue.progress(taskJob.id, workerId, {
      worker: "codex",
      status: "running",
      summary: "Codex started working.",
      progressAt: 10_000,
    });

    const initialCard = (await service.listObjectives()).find((card) => card.objectiveId === created.objectiveId);
    expect(initialCard?.executionStalled).toBe(false);

    Date.now = () => 110_001;

    const stalledCard = (await service.listObjectives()).find((card) => card.objectiveId === created.objectiveId);
    expect(stalledCard?.executionStalled).toBe(true);
    expect(stalledCard?.nextAction).toContain("Execution appears stalled");

    const board = await service.buildBoardProjection(created.objectiveId);
    expect(board.sections.needs_attention.some((card) => card.objectiveId === created.objectiveId)).toBe(true);

    const detail = await service.getObjective(created.objectiveId);
    expect(detail.executionStalled).toBe(true);
  } finally {
    Date.now = originalNow;
  }
});

test("factory service: queued execution without a consumer eventually shows as stalled", async () => {
  const dataDir = await createTempDir("receipt-factory-queued-stalled");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const originalNow = Date.now;
  Date.now = () => 10_000;
  try {
    const created = await service.createObjective({
      title: "Queued execution stalled state",
      prompt: "Surface unleased queued execution as stalled once it ages out.",
      checks: ["git status --short"],
    });

    await runObjectiveStartup(service, created.objectiveId);

    const taskJob = (await queue.listJobs({ limit: 20 }))
      .find((job) => job.payload.kind === "factory.task.run" && job.payload.objectiveId === created.objectiveId);
    expect(taskJob?.status).toBe("queued");

    const initialCard = (await service.listObjectives()).find((card) => card.objectiveId === created.objectiveId);
    expect(initialCard?.executionStalled).toBe(false);

    Date.now = () => 110_001;

    const stalledCard = (await service.listObjectives()).find((card) => card.objectiveId === created.objectiveId);
    expect(stalledCard?.executionStalled).toBe(true);
    expect(stalledCard?.nextAction).toContain("Execution appears stalled");

    const detail = await service.getObjective(created.objectiveId);
    expect(detail.executionStalled).toBe(true);
  } finally {
    Date.now = originalNow;
  }
});

test("factory service: duplicate objective control enqueues stay single-flight on the existing session job", async () => {
  const dataDir = await createTempDir("receipt-factory-control-steer");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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
  expect(initialControl?.singletonMode).toBe("allow");

  const internals = service as unknown as {
    enqueueObjectiveControl(objectiveId: string, reason: "startup" | "admitted" | "reconcile"): Promise<void>;
  };
  await internals.enqueueObjectiveControl(created.objectiveId, "reconcile");

  const controlJobs = (await queue.listJobs({ limit: 10 }))
    .filter((job) => job.agentId === "factory-control");
  expect(controlJobs).toHaveLength(1);
  expect(controlJobs[0]?.id).toBe(initialControl?.id);
  expect(controlJobs[0]?.commands).toHaveLength(0);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.recentReceipts.some((receipt) =>
    receipt.type === "objective.control.wake.requested" && receipt.summary.includes("reconcile")
  )).toBe(true);
});

test("factory service: queued objective control jobs are redriven when the queued job already exists", async () => {
  const dataDir = await createTempDir("receipt-factory-control-redrive");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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

  redrivenJobIds.length = 0;
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
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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

  redrivenJobIds.length = 0;
  await service.resumeObjectives();

  expect((await queue.getJob(duplicateA.id))?.status).toBe("canceled");
  expect((await queue.getJob(duplicateB.id))?.status).toBe("canceled");
  expect(redrivenJobIds).toEqual([]);
});

test("factory service: terminal objective transitions enqueue a reconcile control handoff", async () => {
  const dataDir = await createTempDir("receipt-factory-terminal-cleanup-enqueue");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Completed objective cleanup enqueue",
    prompt: "Schedule reconcile cleanup when the objective reaches a terminal state.",
    checks: ["git status --short"],
  });

  const initialControl = (await queue.listJobs({ limit: 20 }))
    .find((job) => job.agentId === "factory-control" && job.payload.objectiveId === created.objectiveId);
  if (initialControl) {
    await queue.cancel(initialControl.id, "test cleanup bootstrap", "factory.test");
  }

  const internals = service as unknown as {
    emitObjective(objectiveId: string, event: {
      readonly type: "objective.completed";
      readonly objectiveId: string;
      readonly summary: string;
      readonly completedAt: number;
    }): Promise<void>;
  };
  const completedAt = Date.now();
  await internals.emitObjective(created.objectiveId, {
    type: "objective.completed",
    objectiveId: created.objectiveId,
    summary: "Objective completed successfully.",
    completedAt,
  });

  const cleanupControl = (await queue.listJobs({ limit: 20 }))
    .find((job) =>
      job.agentId === "factory-control"
      && job.payload.objectiveId === created.objectiveId
      && job.payload.kind === "factory.objective.control"
      && job.payload.reason === "reconcile"
      && job.status === "queued");

  expect(cleanupControl?.id).toBeTruthy();
});

test("factory service: terminal cleanup retires lingering non-audit jobs without reopening the objective", async () => {
  const dataDir = await createTempDir("receipt-factory-terminal-cleanup-retire");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Terminal cleanup retirement",
    prompt: "Retire leftover execution jobs after terminal completion.",
    checks: ["git status --short"],
  });

  const bootstrapControl = (await queue.listJobs({ limit: 20 }))
    .find((job) => job.agentId === "factory-control" && job.payload.objectiveId === created.objectiveId);
  if (bootstrapControl) {
    await queue.cancel(bootstrapControl.id, "test cleanup bootstrap", "factory.test");
  }

  const internals = service as unknown as {
    emitObjective(objectiveId: string, event: {
      readonly type: "objective.completed";
      readonly objectiveId: string;
      readonly summary: string;
      readonly completedAt: number;
    }): Promise<void>;
  };
  const completedAt = Date.now();
  await internals.emitObjective(created.objectiveId, {
    type: "objective.completed",
    objectiveId: created.objectiveId,
    summary: "Objective completed successfully.",
    completedAt,
  });

  const cleanupControl = (await queue.listJobs({ limit: 20 }))
    .find((job) =>
      job.agentId === "factory-control"
      && job.payload.objectiveId === created.objectiveId
      && job.payload.kind === "factory.objective.control"
      && job.payload.reason === "reconcile"
      && job.status === "queued");
  if (cleanupControl) {
    await queue.cancel(cleanupControl.id, "test invokes cleanup directly", "factory.test");
  }

  const taskJob = await queue.enqueue({
    agentId: "codex",
    lane: "collect",
    sessionKey: `factory:objective:${created.objectiveId}`,
    singletonMode: "allow",
    maxAttempts: 1,
    payload: {
      kind: "factory.task.run",
      objectiveId: created.objectiveId,
      taskId: "task_01",
      candidateId: "candidate_01",
    },
  });
  const publishJob = await queue.enqueue({
    agentId: "codex",
    lane: "collect",
    sessionKey: `factory:integration:${created.objectiveId}`,
    singletonMode: "allow",
    maxAttempts: 1,
    payload: {
      kind: "factory.integration.publish",
      objectiveId: created.objectiveId,
      candidateId: "candidate_01",
    },
  });
  const auditJob = await queue.enqueue({
    agentId: "factory-control",
    lane: "collect",
    sessionKey: `factory:objective:${created.objectiveId}`,
    singletonMode: "allow",
    maxAttempts: 1,
    payload: {
      kind: "factory.objective.audit",
      objectiveId: created.objectiveId,
    },
  });

  await service.runObjectiveControl({
    kind: "factory.objective.control",
    objectiveId: created.objectiveId,
    reason: "reconcile",
  });

  expect((await queue.getJob(taskJob.id))?.status).toBe("canceled");
  expect((await queue.getJob(publishJob.id))?.status).toBe("canceled");
  expect((await queue.getJob(auditJob.id))?.status).toBe("queued");

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.displayState).toBe("Completed");
  expect(detail.phaseDetail).toBe("completed");
});

test("factory service: reconcile retires lingering live jobs when it completes the objective inline", async () => {
  const dataDir = await createTempDir("receipt-factory-terminal-cleanup-inline");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Inline terminal cleanup retirement",
    prompt: "Complete during reconcile and retire live synth jobs before returning.",
    checks: ["git status --short"],
  });

  const bootstrapControl = (await queue.listJobs({ limit: 20 }))
    .find((job) => job.agentId === "factory-control" && job.payload.objectiveId === created.objectiveId);
  if (bootstrapControl) {
    await queue.cancel(bootstrapControl.id, "test cleanup bootstrap", "factory.test");
  }

  const taskJob = await queue.enqueue({
    agentId: "codex",
    lane: "collect",
    sessionKey: `factory:objective:${created.objectiveId}:task_01`,
    singletonMode: "allow",
    maxAttempts: 1,
    payload: {
      kind: "factory.task.run",
      objectiveId: created.objectiveId,
      taskId: "task_01",
      candidateId: "candidate_01",
    },
  });
  const monitorJob = await queue.enqueue({
    agentId: "factory-monitor",
    lane: "collect",
    sessionKey: `factory:monitor:${created.objectiveId}:task_01`,
    singletonMode: "allow",
    maxAttempts: 1,
    payload: {
      kind: "factory.task.monitor",
      objectiveId: created.objectiveId,
      taskId: "task_01",
      candidateId: "candidate_01",
      codexJobId: taskJob.id,
    },
  });

  const internals = service as unknown as {
    processObjectiveReconcile(objectiveId: string): Promise<void>;
    emitObjectiveBatch(
      objectiveId: string,
      events: ReadonlyArray<{
        readonly type: "objective.completed";
        readonly objectiveId: string;
        readonly summary: string;
        readonly completedAt: number;
      }>,
    ): Promise<void>;
  };
  const originalProcessObjectiveReconcile = internals.processObjectiveReconcile.bind(service);
  internals.processObjectiveReconcile = async (objectiveId: string) => {
    await internals.emitObjectiveBatch(objectiveId, [{
      type: "objective.completed",
      objectiveId,
      summary: "Objective completed during reconcile.",
      completedAt: Date.now(),
    }]);
  };

  try {
    await service.runObjectiveControl({
      kind: "factory.objective.control",
      objectiveId: created.objectiveId,
      reason: "reconcile",
    });
  } finally {
    internals.processObjectiveReconcile = originalProcessObjectiveReconcile;
  }

  expect((await queue.getJob(taskJob.id))?.status).toBe("canceled");
  expect((await queue.getJob(monitorJob.id))?.status).toBe("canceled");

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("completed");
  expect(detail.displayState).toBe("Completed");
});

test("factory service: dirty worktree objectives auto-pin the committed head and record a warning", async () => {
  const dataDir = await createTempDir("receipt-factory-dirty-source");
  const repoRoot = await createSourceRepo();
  await fs.writeFile(path.join(repoRoot, "DIRTY_NOTE.txt"), "local-only change\n", "utf-8");
  const expectedBaseHash = await git(repoRoot, ["rev-parse", "HEAD"]);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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

  redrivenJobIds.length = 0;
  await service.reactObjective(created.objectiveId);

  expect(redrivenJobIds).toContain(activeQueuedTask!.jobId!);
  expect(redrivenJobIds.length).toBeGreaterThanOrEqual(1);
});

test("factory service: resumeObjectives redrives active queued task jobs before queueing fallback control", async () => {
  const dataDir = await createTempDir("receipt-factory-resume-redrive");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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

  redrivenJobIds.length = 0;
  const controlJobsBefore = (await queue.listJobs({ limit: 20 }))
    .filter((job) => job.agentId === "factory-control")
    .length;

  await service.resumeObjectives();

  const controlJobsAfter = (await queue.listJobs({ limit: 20 }))
    .filter((job) => job.agentId === "factory-control")
    .length;

  expect(redrivenJobIds).toContain(activeQueuedTask!.jobId!);
  expect(redrivenJobIds.length).toBeGreaterThanOrEqual(1);
  expect(controlJobsAfter).toBe(controlJobsBefore);
});

test("factory service: resumeObjectives retries stale startup reconciliation instead of failing", async () => {
  const dataDir = await createTempDir("receipt-factory-resume-stale-retry");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const internals = service as unknown as {
    reconcileQueuedObjectiveControlJobs(): Promise<void>;
  };
  const original = internals.reconcileQueuedObjectiveControlJobs.bind(service);
  let attempts = 0;
  internals.reconcileQueuedObjectiveControlJobs = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("Expected prev hash stale-prev but head is fresh-prev");
    }
    await original();
  };

  await expect(service.resumeObjectives()).resolves.toBeUndefined();
  expect(attempts).toBe(2);
});

test("factory service: objective control retries stale receipt conflicts with a reconcile pass", async () => {
  const dataDir = await createTempDir("receipt-factory-control-stale-retry");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Control stale retry",
    prompt: "Recover from a stale objective receipt conflict during startup.",
    objectiveMode: "investigation",
  });

  const internals = service as unknown as {
    processObjectiveStartup(
      objectiveId: string,
      reason: "startup" | "admitted",
    ): Promise<void>;
    processObjectiveReconcile(objectiveId: string): Promise<void>;
  };
  const originalStartup = internals.processObjectiveStartup.bind(service);
  const originalReconcile = internals.processObjectiveReconcile.bind(service);
  let startupCalls = 0;
  let reconcileCalls = 0;
  internals.processObjectiveStartup = async (objectiveId, reason) => {
    startupCalls += 1;
    if (startupCalls === 1) {
      throw new Error("Expected prev hash stale-prev but head is fresh-prev");
    }
    await originalStartup(objectiveId, reason);
  };
  internals.processObjectiveReconcile = async (objectiveId) => {
    reconcileCalls += 1;
    await originalReconcile(objectiveId);
  };

  try {
    await expect(service.runObjectiveControl({
      kind: "factory.objective.control",
      objectiveId: created.objectiveId,
      reason: "startup",
    })).resolves.toEqual({
      objectiveId: created.objectiveId,
      status: "completed",
      reason: "reconcile",
    });
  } finally {
    internals.processObjectiveStartup = originalStartup;
    internals.processObjectiveReconcile = originalReconcile;
  }

  expect(startupCalls).toBe(1);
  expect(reconcileCalls).toBe(1);
  const detail = await service.getObjective(created.objectiveId);
  expect(detail.tasks.length).toBeGreaterThanOrEqual(1);
});

test("factory service: objective control reconciles transient sqlite locks instead of blocking", async () => {
  const dataDir = await createTempDir("receipt-factory-control-transient-lock");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Control transient lock recovery",
    prompt: "Recover when startup and reconcile both hit transient sqlite contention.",
    objectiveMode: "investigation",
  });

  const internals = service as unknown as {
    processObjectiveStartup(
      objectiveId: string,
      reason: "startup" | "admitted",
    ): Promise<void>;
    processObjectiveReconcile(objectiveId: string): Promise<void>;
  };
  const originalStartup = internals.processObjectiveStartup.bind(service);
  const originalReconcile = internals.processObjectiveReconcile.bind(service);
  let startupCalls = 0;
  let reconcileCalls = 0;
  internals.processObjectiveStartup = async () => {
    startupCalls += 1;
    throw new Error("database is locked");
  };
  internals.processObjectiveReconcile = async () => {
    reconcileCalls += 1;
    throw new Error("database is locked");
  };

  try {
    await expect(service.runObjectiveControl({
      kind: "factory.objective.control",
      objectiveId: created.objectiveId,
      reason: "startup",
    })).resolves.toEqual({
      objectiveId: created.objectiveId,
      status: "completed",
      reason: "reconcile",
    });
  } finally {
    internals.processObjectiveStartup = originalStartup;
    internals.processObjectiveReconcile = originalReconcile;
  }

  expect(startupCalls).toBe(1);
  expect(reconcileCalls).toBe(1);
  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).not.toBe("blocked");
  expect(detail.recentReceipts.some((receipt) =>
    receipt.type === "objective.control.wake.requested" && receipt.summary.includes("reconcile")
  )).toBe(true);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "objective.blocked")).toBe(false);
});

test("factory service: startup reconciliation cancels stale queued execution and queues a reconcile control", async () => {
  const dataDir = await createTempDir("receipt-factory-stale-startup-reconcile");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Stale startup reconciliation",
    prompt: "Cancel stale active execution at startup and queue a reconcile control pass.",
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
  const taskJob = await queue.getJob(activeQueuedTask!.jobId!);
  expect(taskJob?.status).toBe("queued");

  const internals = service as unknown as {
    reconcileStaleObjectiveExecutionJobs(now: number): Promise<void>;
  };
  await internals.reconcileStaleObjectiveExecutionJobs((taskJob?.updatedAt ?? Date.now()) + 100_000);

  expect((await queue.getJob(activeQueuedTask!.jobId!))?.status).toBe("canceled");
  const reconcileControl = (await queue.listJobs({ limit: 40 }))
    .find((job) =>
      job.agentId === "factory-control"
      && job.payload.kind === "factory.objective.control"
      && job.payload.objectiveId === created.objectiveId
      && !["completed", "failed", "canceled"].includes(job.status));
  expect(reconcileControl?.id).toBeTruthy();
  const latestDetail = await service.getObjective(created.objectiveId);
  expect(latestDetail.recentReceipts.some((receipt) =>
    receipt.type === "objective.control.wake.requested" && receipt.summary.includes("reconcile")
  )).toBe(true);
});

test("factory service: workspace commands use an isolated DATA_DIR while receipt still targets the shared store", async () => {
  const dataDir = await createTempDir("receipt-factory-command-env");
  const repoRoot = await createSourceRepo();
  const worktreesDir = path.join(dataDir, "hub", "worktrees");
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const queued = await queue.enqueue({
    agentId: "demo",
    lane: "collect",
    payload: { kind: "demo.job", note: "shared queue entry" },
  });
  const workspaceEnv = await ensureFactoryWorkspaceCommandEnv({
    workspacePath: repoRoot,
    dataDir,
    repoRoot,
    worktreesDir,
  });

  const results = await runFactoryChecks({
    commands: [
      "node -e \"process.stdout.write(process.env.DATA_DIR || '')\"",
      "receipt jobs --json",
    ],
    workspacePath: repoRoot,
    dataDir,
    repoRoot,
    worktreesDir,
  });

  expect(results).toHaveLength(2);
  expect(results[0]?.ok).toBe(true);
  expect(results[0]?.stdout.trim()).toBe(workspaceEnv.commandDataDir);
  expect(results[1]?.ok).toBe(true);
  expect(results[1]?.stdout).toContain(queued.id);
});

test("factory service: startup reconciliation applies a persisted stale task result instead of canceling the task job", async () => {
  const dataDir = await createTempDir("receipt-factory-stale-task-recovery");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Recover stale persisted task result",
    prompt: "Recover the persisted task result instead of blocking the objective during startup reconciliation.",
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
  const queuedTaskJob = await queue.getJob(activeQueuedTask!.jobId!);
  expect(queuedTaskJob?.status).toBe("queued");

  const leasedTaskJob = await queue.leaseJob(queuedTaskJob!.id, "worker-stale", 600_000);
  expect(leasedTaskJob?.status).toBe("leased");
  const payload = leasedTaskJob?.payload as FactoryTaskJobPayload;
  await fs.mkdir(path.dirname(payload.resultPath), { recursive: true });
  await fs.writeFile(payload.resultPath, JSON.stringify({
    outcome: "approved",
    summary: "Recovered persisted task result.",
    handoff: "Apply the persisted task result and keep the objective moving.",
    scriptsRun: [{
      command: "git status --short",
      summary: "Validated the recovered task result.",
      status: "ok",
    }],
    completion: {
      changed: ["README.md"],
      proof: ["Recovered from the persisted task result."],
      remaining: [],
    },
    alignment: {
      verdict: "aligned",
      satisfied: ["Recovered the persisted task result without widening scope."],
      missing: [],
      outOfScope: [],
      rationale: "Startup recovery used the already-written task result.",
    },
  }, null, 2), "utf-8");

  const internals = service as unknown as {
    reconcileStaleObjectiveExecutionJobs(now: number): Promise<void>;
  };
  await internals.reconcileStaleObjectiveExecutionJobs((leasedTaskJob?.updatedAt ?? Date.now()) + 100_000);

  const recoveredJob = await queue.getJob(queuedTaskJob!.id);
  expect(recoveredJob?.status).toBe("completed");
  expect((recoveredJob?.result as { readonly recoveredFromPersistedResult?: boolean } | undefined)?.recoveredFromPersistedResult).toBe(true);
  expect((recoveredJob?.result as { readonly recovered?: boolean } | undefined)?.recovered).toBe(true);
  expect((recoveredJob?.result as { readonly recoverySource?: string } | undefined)?.recoverySource).toBe("persisted_result");
  await service.runObjectiveControl({
    kind: "factory.objective.control",
    objectiveId: created.objectiveId,
    reason: "reconcile",
  });
  const recoveredDetail = await service.getObjective(created.objectiveId);
  expect(recoveredDetail.status).not.toBe("blocked");
});

test("factory service: startup reconciliation finalizes investigation objectives after recovering a persisted task result", async () => {
  const dataDir = await createTempDir("receipt-factory-stale-investigation-recovery");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Recover stale persisted investigation result",
    prompt: "Investigate the current posture and conclude from evidence.",
    objectiveMode: "investigation",
    checks: [],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const detail = await service.getObjective(created.objectiveId);
  const activeQueuedTask = detail.tasks.find((task) =>
    task.status === "running"
    && task.jobStatus === "queued"
    && typeof task.jobId === "string",
  );
  expect(activeQueuedTask?.jobId).toBeDefined();
  const queuedTaskJob = await queue.getJob(activeQueuedTask!.jobId!);
  expect(queuedTaskJob?.status).toBe("queued");

  const leasedTaskJob = await queue.leaseJob(queuedTaskJob!.id, "worker-stale", 600_000);
  expect(leasedTaskJob?.status).toBe("leased");
  const payload = leasedTaskJob?.payload as FactoryTaskJobPayload;
  await fs.mkdir(path.dirname(payload.resultPath), { recursive: true });
  await fs.writeFile(payload.resultPath, JSON.stringify({
    outcome: "approved",
    summary: "Recovered persisted investigation result.",
    handoff: null,
    presentation: {
      kind: "investigation_report",
      inlineBody: null,
      primaryArtifactLabels: ["artifact.json"],
      renderHint: "report",
    },
    artifacts: [{
      label: "artifact.json",
      path: "/tmp/artifact.json",
      summary: "Recovered evidence artifact.",
    }],
    completion: {
      changed: [],
      proof: ["Recovered from the persisted investigation result."],
      remaining: [],
    },
    nextAction: null,
    report: {
      conclusion: "Recovered persisted investigation result.",
      evidence: [{
        title: "Recovered evidence",
        summary: "Recovered from persisted task result.",
        detail: "artifact.json",
      }],
      evidenceRecords: [],
      scriptsRun: [{
        command: "cat artifact.json",
        summary: "Recovered persisted evidence.",
        status: "ok",
      }],
      disagreements: [],
      nextSteps: [],
    },
  }, null, 2), "utf-8");

  const internals = service as unknown as {
    reconcileStaleObjectiveExecutionJobs(now: number): Promise<void>;
  };
  await internals.reconcileStaleObjectiveExecutionJobs((leasedTaskJob?.updatedAt ?? Date.now()) + 100_000);

  const recoveredJob = await queue.getJob(queuedTaskJob!.id);
  expect(recoveredJob?.status).toBe("completed");
  expect((recoveredJob?.result as { readonly recoveredFromPersistedResult?: boolean } | undefined)?.recoveredFromPersistedResult).toBe(true);
  expect((recoveredJob?.result as { readonly recovered?: boolean } | undefined)?.recovered).toBe(true);
  expect((recoveredJob?.result as { readonly recoverySource?: string } | undefined)?.recoverySource).toBe("persisted_result");

  await service.runObjectiveControl({
    kind: "factory.objective.control",
    objectiveId: created.objectiveId,
    reason: "reconcile",
  });

  let recoveredDetail = await service.getObjective(created.objectiveId);
  if (recoveredDetail.status !== "completed") {
    await service.runObjectiveControl({
      kind: "factory.objective.control",
      objectiveId: created.objectiveId,
      reason: "reconcile",
    });
    recoveredDetail = await service.getObjective(created.objectiveId);
  }
  expect(recoveredDetail.status).toBe("completed");
});

test("factory service: startup reconciliation finalizes investigation objectives from checkpointed evidence state when no result file exists", async () => {
  const dataDir = await createTempDir("receipt-factory-stale-investigation-checkpoint");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Recover checkpointed investigation evidence",
    prompt: "Investigate the current posture and recover from checkpointed evidence only.",
    objectiveMode: "investigation",
    checks: [],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const detail = await service.getObjective(created.objectiveId);
  const activeQueuedTask = detail.tasks.find((task) =>
    task.status === "running"
    && task.jobStatus === "queued"
    && typeof task.jobId === "string",
  );
  expect(activeQueuedTask?.jobId).toBeDefined();
  const queuedTaskJob = await queue.getJob(activeQueuedTask!.jobId!);
  expect(queuedTaskJob?.status).toBe("queued");

  const leasedTaskJob = await queue.leaseJob(queuedTaskJob!.id, "worker-stale", 600_000);
  expect(leasedTaskJob?.status).toBe("leased");
  const payload = leasedTaskJob?.payload as FactoryTaskJobPayload;
  const artifactPath = path.join(path.dirname(payload.resultPath), "artifact.json");
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, JSON.stringify({ exposure: "confirmed" }, null, 2), "utf-8");

  const checkpointedState = checkpointFactoryExecutionEvidenceState({
    current: refineFactoryExecutionEvidenceStateForHardness(
      createFactoryExecutionEvidenceState({
        objectiveId: created.objectiveId,
        taskId: payload.taskId,
        candidateId: payload.candidateId,
        goal: "Recover checkpointed investigation evidence.",
      }),
      "Runtime observed repeated command churn during evidence collection.",
    ),
    stepId: "collect_primary_evidence",
    evidenceRecords: [{
      objective_id: created.objectiveId,
      task_id: payload.taskId,
      timestamp: Date.now(),
      tool_name: "aws_cli_command",
      command_or_api: "aws elbv2 describe-load-balancers --region us-east-1",
      inputs: { region: "us-east-1" },
      outputs: { status: "ok", output_preview: "internet-facing ALB detected" },
      summary_metrics: { load_balancers: 1 },
    }],
    scriptsRun: [{
      command: "aws elbv2 describe-load-balancers --region us-east-1",
      summary: "Recovered checkpointed evidence.",
      status: "ok",
    }],
    artifacts: [{
      label: "artifact.json",
      path: artifactPath,
      summary: "Recovered checkpoint artifact.",
    }],
    observations: ["Checkpointed evidence survived the stale execution."],
    summary: "Recovered checkpointed investigation evidence.",
  });
  await writeFactoryExecutionEvidenceState(
    factoryExecutionEvidenceStatePath(payload.resultPath),
    checkpointedState,
  );

  const internals = service as unknown as {
    reconcileStaleObjectiveExecutionJobs(now: number): Promise<void>;
  };
  await internals.reconcileStaleObjectiveExecutionJobs((leasedTaskJob?.updatedAt ?? Date.now()) + 100_000);

  const recoveredJob = await queue.getJob(queuedTaskJob!.id);
  expect(recoveredJob?.status).toBe("completed");
  expect((recoveredJob?.result as { readonly recoveredFromPersistedResult?: boolean } | undefined)?.recoveredFromPersistedResult).toBe(true);
  expect((recoveredJob?.result as { readonly recovered?: boolean } | undefined)?.recovered).toBe(true);
  expect((recoveredJob?.result as { readonly recoverySource?: string } | undefined)?.recoverySource).toBe("checkpoint_evidence");

  await service.runObjectiveControl({
    kind: "factory.objective.control",
    objectiveId: created.objectiveId,
    reason: "reconcile",
  });

  let recoveredDetail = await service.getObjective(created.objectiveId);
  if (recoveredDetail.status !== "completed") {
    await service.runObjectiveControl({
      kind: "factory.objective.control",
      objectiveId: created.objectiveId,
      reason: "reconcile",
    });
    recoveredDetail = await service.getObjective(created.objectiveId);
  }
  expect(recoveredDetail.status).toBe("completed");
});

test("factory service: startup reconciliation recovers delivery tasks from checkpointed evidence state", async () => {
  const dataDir = await createTempDir("receipt-factory-stale-delivery-checkpoint");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Recover checkpointed delivery evidence",
    prompt: "Capture the required change and recover from checkpointed delivery evidence only.",
    checks: ["true"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const detail = await service.getObjective(created.objectiveId);
  const activeQueuedTask = detail.tasks.find((task) =>
    task.status === "running"
    && task.jobStatus === "queued"
    && typeof task.jobId === "string",
  );
  expect(activeQueuedTask?.jobId).toBeDefined();
  const queuedTaskJob = await queue.getJob(activeQueuedTask!.jobId!);
  expect(queuedTaskJob?.status).toBe("queued");

  const leasedTaskJob = await queue.leaseJob(queuedTaskJob!.id, "worker-stale", 600_000);
  expect(leasedTaskJob?.status).toBe("leased");
  const payload = leasedTaskJob?.payload as FactoryTaskJobPayload;

  await fs.mkdir(path.dirname(payload.resultPath), { recursive: true });
  await fs.writeFile(
    path.join(payload.workspacePath, "RECOVERED_DELIVERY.md"),
    "Recovered delivery checkpoint\n",
    "utf-8",
  );

  const checkpointedState = checkpointFactoryExecutionEvidenceState({
    current: refineFactoryExecutionEvidenceStateForHardness(
      createFactoryExecutionEvidenceState({
        objectiveId: created.objectiveId,
        taskId: payload.taskId,
        candidateId: payload.candidateId,
        goal: "Recover checkpointed delivery evidence.",
      }),
      "Runtime observed repeated command churn during delivery execution.",
    ),
    stepId: "collect_primary_evidence",
    evidenceRecords: [{
      objective_id: created.objectiveId,
      task_id: payload.taskId,
      timestamp: Date.now(),
      tool_name: "workspace_probe",
      command_or_api: "git status --short",
      inputs: {},
      outputs: { output_preview: "RECOVERED_DELIVERY.md" },
      summary_metrics: { changed_files: 1 },
    }],
    scriptsRun: [{
      command: "git status --short",
      summary: "Recovered checkpointed delivery evidence.",
      status: "ok",
    }],
    artifacts: [{
      label: "RECOVERED_DELIVERY.md",
      path: path.join(payload.workspacePath, "RECOVERED_DELIVERY.md"),
      summary: "Recovered delivery artifact.",
    }],
    observations: ["Checkpointed delivery evidence survived the stale execution."],
    summary: "Recovered checkpointed delivery evidence.",
  });
  await writeFactoryExecutionEvidenceState(
    factoryExecutionEvidenceStatePath(payload.resultPath),
    checkpointedState,
  );

  const internals = service as unknown as {
    reconcileStaleObjectiveExecutionJobs(now: number): Promise<void>;
  };
  await internals.reconcileStaleObjectiveExecutionJobs((leasedTaskJob?.updatedAt ?? Date.now()) + 100_000);

  const recoveredJob = await queue.getJob(queuedTaskJob!.id);
  expect(recoveredJob?.status).toBe("completed");
  expect((recoveredJob?.result as { readonly recovered?: boolean } | undefined)?.recovered).toBe(true);
  expect((recoveredJob?.result as { readonly recoverySource?: string } | undefined)?.recoverySource).toBe("checkpoint_evidence");

  await service.runObjectiveControl({
    kind: "factory.objective.control",
    objectiveId: created.objectiveId,
    reason: "reconcile",
  });

  let recoveredDetail = await service.getObjective(created.objectiveId);
  if (recoveredDetail.status !== "completed") {
    await service.runObjectiveControl({
      kind: "factory.objective.control",
      objectiveId: created.objectiveId,
      reason: "reconcile",
    });
    recoveredDetail = await service.getObjective(created.objectiveId);
  }
  expect(recoveredDetail.status).toBe("completed");
});

test("factory service: cancel plus cleanup drains active objective-scoped jobs idempotently", async () => {
  const dataDir = await createTempDir("receipt-factory-cancel-cleanup-idempotent");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });

  const created = await service.createObjective({
    title: "Cancel cleanup objective drain",
    prompt: "Cancel and cleanup should leave no active objective-scoped jobs behind.",
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

  const monitorJob = await queue.enqueue({
    agentId: "codex",
    lane: "collect",
    sessionKey: `factory:monitor:${created.objectiveId}:task_01`,
    singletonMode: "allow",
    maxAttempts: 1,
    payload: {
      kind: "factory.task.monitor",
      objectiveId: created.objectiveId,
      taskId: "task_01",
      candidateId: "task_01_candidate_01",
      codexJobId: activeQueuedTask!.jobId!,
    },
  });
  const auditJob = await queue.enqueue({
    agentId: "factory-control",
    lane: "collect",
    sessionKey: `factory:audit:${created.objectiveId}`,
    singletonMode: "allow",
    maxAttempts: 1,
    payload: {
      kind: "factory.objective.audit",
      objectiveId: created.objectiveId,
      objectiveStatus: "canceled",
      objectiveUpdatedAt: Date.now(),
    },
  });

  await service.cancelObjective(created.objectiveId, "test objective cancel");
  await service.cleanupObjectiveWorkspaces(created.objectiveId);
  await service.cleanupObjectiveWorkspaces(created.objectiveId);

  const objectiveJobs = (await queue.listJobs({ limit: 80 })).filter((job) =>
    typeof job.payload.objectiveId === "string" && job.payload.objectiveId === created.objectiveId,
  );
  expect(objectiveJobs.filter((job) => ["queued", "leased", "running"].includes(job.status))).toEqual([]);
  expect((await queue.getJob(activeQueuedTask!.jobId!))?.status).toBe("canceled");
  expect((await queue.getJob(monitorJob.id))?.status).toBe("canceled");
  expect((await queue.getJob(auditJob.id))?.status).toBe("canceled");
});

test("factory service: getObjective reads task jobs without scanning the full queue index", async () => {
  const dataDir = await createTempDir("receipt-factory-objective-task-job");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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
          completion: {
            changed: ["Confirmed worktree-local CLI access for the software task runtime."],
            proof: ["workspace-tool and receipt CLI executed successfully from the task worktree."],
            remaining: [],
          },
          alignment: {
            verdict: "aligned",
            satisfied: ["Confirmed the software task runtime can use repo-local commands from its worktree."],
            missing: [],
            outOfScope: [],
            rationale: "The task only verified local worktree command access and stayed within the requested scope.",
          },
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
        phase: "collecting_evidence",
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
  expect(handoff && handoff.kind === "assistant" ? handoff.body : "").toContain("We proved it was a one-day NAT data-processing surge.");
  expect(handoff && handoff.kind === "assistant" ? handoff.body : "").toContain("Blocked on: Historical NAT and flow-log records are missing, so attribution is still unresolved.");
  expect(handoff && handoff.kind === "assistant" ? handoff.body : "").toContain("Next: Use /react with retained evidence or close with an inconclusive conclusion.");
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
      goal: "Implement and verify the sidebar fix.",
      currentState: "Triage isolated the issue to the current sidebar work.",
      doneWhen: "The fix is landed with validation evidence.",
      evidence: ["objective_demo", "latest receipt reviewed"],
      blockers: ["No code change exists yet"],
      nextRunId: "run_software_01",
      nextJobId: "job_factory_handoff_01",
      targetStream: "agents/factory/demo/software/objectives/objective_demo",
      objectiveId: "objective_demo",
    }, 3),
  ];

  const items = buildChatItemsForRun("run_profile_handoff", chain, new Map());
  const handoff = items.find((item) => item.kind === "work" && item.card.title === "Profile handoff to Software");

  expect(handoff && handoff.kind === "work" ? handoff.card.summary : "").toBe("Implement and verify the sidebar fix.");
  expect(handoff && handoff.kind === "work" ? handoff.card.jobId : undefined).toBe("job_factory_handoff_01");
  expect(handoff && handoff.kind === "work" ? handoff.card.detail ?? "" : "").toContain("Reason: Ship the repo fix.");
  expect(handoff && handoff.kind === "work" ? handoff.card.detail ?? "" : "").toContain("Current state: Triage isolated the issue to the current sidebar work.");
  expect(handoff && handoff.kind === "work" ? handoff.card.detail ?? "" : "").toContain("Done when: The fix is landed with validation evidence.");
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

test("factory transcript: running work cards render a shimmer activity rail", () => {
  const html = renderFactoryTranscriptSection({
    activeProfileId: "generalist",
    activeProfileLabel: "Generalist",
    activeProfilePrimaryRole: "Engineer",
    items: [
      {
        key: "work-running",
        kind: "work",
        card: {
          key: "work-running",
          title: "Live task output",
          worker: "factory",
          status: "running",
          summary: "Streaming live task output.",
          variant: "live-output",
          running: true,
          focusKind: "task",
        },
      },
      {
        key: "work-completed",
        kind: "work",
        card: {
          key: "work-completed",
          title: "Completed task output",
          worker: "factory",
          status: "completed",
          summary: "Finished writing the report.",
          running: false,
        },
      },
    ],
  });

  expect(html).toContain("factory-running-card");
  expect(html).toContain("factory-running-activity-rail");
  expect(html).toContain("factory-running-activity-orb");
  expect(html.match(/factory-running-activity-rail/g)?.length ?? 0).toBe(1);
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
          latestNote: "Inspecting src/views/factory/workbench/page.ts.",
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
      summary: "Inspecting src/views/factory/workbench/page.ts.",
    },
    commands: [],
  };

  const items = buildChatItemsForRun("run_structured", chain, new Map([[childJob.id, childJob]]));
  const waiting = items.find((item) => item.kind === "system" && item.title === "Supervisor waiting on child");
  expect(waiting && waiting.kind === "system" ? waiting.body : "").toContain("job_codex_live is running");
  expect(waiting && waiting.kind === "system" ? waiting.body : "").toContain("layoutFixJob: job_layout_done is completed");

  const childCard = items.find((item) => item.kind === "work" && item.card.jobId === "job_codex_live");
  expect(childCard && childCard.kind === "work" ? childCard.card.summary : "").toContain("Inspecting src/views/factory/workbench/page.ts.");
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
      lastMessage: "Inspecting src/views/factory/workbench/page.ts.",
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
    latestDecision: {
      summary: "No active CloudWatch alarms were present across the 17 queryable regions.",
      at: 12,
      source: "runtime",
    },
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
  expect(body).not.toContain("Latest Decision");
  expect(body).toContain("Start follow-up");
  expect(body).toContain("xl:grid-cols-[minmax(0,1fr)_220px]");
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

test("factory workbench: stale task jobs downgrade focused execution to stalled", () => {
  const staleJob: QueueJob = {
    id: "job_task_01",
    agentId: "codex",
    lane: "collect",
    sessionKey: "factory:objective_stalled:task_01",
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
    result: {
      progressAt: 1,
      summary: "No recent progress was observed.",
    },
    commands: [],
  };
  const staleObjective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_stalled"),
    activeTaskCount: 1,
    readyTaskCount: 0,
    taskCount: 1,
    tasks: [{
      ...makeRunningWorkbenchObjectiveDetail("objective_stalled").tasks[0],
      job: staleJob,
    }],
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;

  const workbench = buildFactoryWorkbench({
    detail: staleObjective,
    recentJobs: [staleJob],
    requestedFocusKind: "task",
    requestedFocusId: "task_01",
    now: 100_000,
  });

  expect(workbench?.focus?.status).toBe("stalled");
  expect(workbench?.focus?.active).toBe(false);
  expect(workbench?.summary.activeJobCount).toBe(0);
  expect(workbench?.hasActiveExecution).toBe(false);
});

test("factory workbench: terminal objective focus prefers completed task status over stale live output cancellation", () => {
  const completedObjective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_completed"),
    status: "completed",
    phase: "completed",
    latestSummary: "Listed 16 EC2 instances in us-east-1.",
    latestHandoff: {
      status: "completed",
      summary: "Listed 16 EC2 instances in us-east-1.",
      output: "| InstanceId | Name |\n|---|---|\n| i-123 | demo |",
      handoffKey: "handoff_demo",
      sourceUpdatedAt: 42,
    },
    activeTaskCount: 0,
    readyTaskCount: 0,
    tasks: [{
      ...makeRunningWorkbenchObjectiveDetail("objective_completed").tasks[0],
      status: "completed",
      latestSummary: "Listed 16 EC2 instances in us-east-1.",
      candidate: {
        ...makeRunningWorkbenchObjectiveDetail("objective_completed").tasks[0].candidate!,
        status: "approved",
        summary: "Listed 16 EC2 instances in us-east-1.",
      },
    }],
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;

  const workbench = buildFactoryWorkbench({
    detail: completedObjective,
    requestedFocusKind: "task",
    requestedFocusId: "task_01",
    liveOutput: {
      objectiveId: "objective_completed",
      focusKind: "task",
      focusId: "task_01",
      title: "List EC2 instances in us-east-1",
      status: "canceled",
      active: false,
      summary: "Cleanup retired the stale worker job.",
      taskId: "task_01",
    },
  });

  expect(workbench?.focus?.status).toBe("completed");
  expect(workbench?.focus?.summary).toContain("Listed 16 EC2 instances");
});

test("factory route: selected objective surfaces terminal handoff output", async () => {
  const completedObjective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_completed"),
    status: "completed",
    phase: "completed",
    displayState: "Completed",
    phaseDetail: "completed",
    latestSummary: "Listed 16 EC2 instances in us-east-1.",
    latestHandoff: {
      status: "completed",
      summary: "Listed 16 EC2 instances in us-east-1.",
      output: "| InstanceId | Name |\n|---|---|\n| i-123 | demo |",
      handoffKey: "handoff_demo",
      sourceUpdatedAt: 42,
    },
    activeTaskCount: 0,
    readyTaskCount: 0,
    taskCount: 1,
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;

  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        completedObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => completedObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&objective=objective_completed");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Returned Output");
  expect(body).toContain("InstanceId");
  expect(body).toContain("i-123");
});

test("factory service: active objective cards drop leaked queue positions", async () => {
  const dataDir = await createTempDir("receipt-factory-active-queue-position");
  const repoRoot = await createSourceRepo();
  const jobRuntime = createJobRuntime(dataDir);
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    codexExecutor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
    repoRoot,
  });
  const state = makeStubObjectiveState({
    ...makeRunningWorkbenchObjectiveDetail("objective_active_queue"),
    scheduler: {
      slotState: "active",
      queuePosition: 144,
    },
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>);
  const internals = service as unknown as {
    buildObjectiveCard: (
      state: FactoryState,
      queuePosition?: number,
    ) => Promise<Awaited<ReturnType<FactoryService["listObjectives"]>>[number]>;
  };

  const card = await internals.buildObjectiveCard(state, 144);

  expect(card.scheduler.slotState).toBe("active");
  expect(card.scheduler.queuePosition).toBeUndefined();
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
        phase: "collecting_evidence",
        displayState: "Running",
        phaseDetail: "collecting_evidence",
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
  expect(markup).toContain("Collecting Evidence");
  expect(markup).not.toContain('<div class="text-[15px] font-semibold leading-none text-foreground">Software</div>');
});

test("factory workbench shell publishes the active profile on body", () => {
  const model = {
    activeProfileId: "software",
    activeProfileLabel: "Software",
    chatId: "chat_demo",
    detailTab: "queue",
    filter: "objective.running",
    inspectorTab: "chat",
    page: 1,
    profiles: [{
      id: "software",
      label: "Software",
      href: "/factory?profile=software&chat=chat_demo&inspectorTab=chat&detailTab=queue",
      selected: true,
    }],
    workspace: {
      activeProfileId: "software",
      activeProfileLabel: "Software",
      chatId: "chat_demo",
      detailTab: "queue",
      filter: "objective.running",
      inspectorTab: "chat",
      page: 1,
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
      activeProfileId: "software",
      activeProfileLabel: "Software",
      chatId: "chat_demo",
      inspectorTab: "chat",
      items: [],
      jobs: [],
      knownRunIds: [],
      terminalRunIds: [],
    },
  } as FactoryWorkbenchPageModel;

  const shell = factoryWorkbenchShell(model, "/factory");
  const board = factoryWorkbenchBoardResponse({
    header: {
      activeProfileId: model.activeProfileId,
      activeProfileLabel: model.activeProfileLabel,
      profiles: model.profiles,
      workspace: model.workspace,
    },
    workspace: model.workspace,
    routeContext: {
      shellBase: "/factory",
      profileId: model.activeProfileId,
      chatId: model.chatId,
      inspectorTab: model.inspectorTab,
      detailTab: model.detailTab,
      page: model.page,
      filter: model.filter,
    },
  });

  expect(shell).toContain('data-profile-id="software"');
  expect(board).toContain('id="factory-workbench-rail-shell"');
  expect(board).toContain('id="factory-workbench-header"');
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
  expect(body).toContain("Need retained historical NAT or flow-log evidence to attribute the spike.");
  expect(body).toContain("Next: Use /react with more evidence, or ask Chat to summarize the current findings.");
  expect(body).toContain('data-refresh-on="sse:agent-refresh@180,sse:job-refresh@180,sse:objective-runtime-refresh@180"');
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
  expect(replayBody).toContain("We proved it was a NAT data-processing surge");
  expect(replayBody).toContain("Next: Use /react with more evidence, or ask Chat to summarize the current findings.");
});

test("factory route: workbench selection writes blocked handoffs into the profile chat session", async () => {
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

  const selectResponse = await app.request(
    "http://receipt.test/factory/island/workbench/select?profile=generalist&chat=chat_demo&objective=objective_blocked&inspectorTab=chat",
    { headers: { "HX-Request": "true" } },
  );
  const selectBody = await selectResponse.text();

  expect(selectResponse.status).toBe(200);
  expect(selectBody).toContain("Blocked handoff");

  const sessionStream = factoryChatSessionStream(process.cwd(), "generalist", "chat_demo");
  const sessionEvents = agentEventStore?.get(sessionStream) ?? [];
  const finalEvent = sessionEvents.find((event): event is Extract<AgentEvent, { type: "response.finalized" }> =>
    event.type === "response.finalized"
  );
  expect(finalEvent?.content).toContain("We proved it was a NAT data-processing surge");

  const replayResponse = await app.request("http://receipt.test/factory/island/chat?profile=generalist&chat=chat_demo&inspectorTab=chat", {
    headers: { "HX-Request": "true" },
  });
  const replayBody = await replayResponse.text();

  expect(replayResponse.status).toBe(200);
  expect(replayBody).toContain("We proved it was a NAT data-processing surge");
  expect(replayBody).toContain("Next: Use /react with more evidence, or ask Chat to summarize the current findings.");
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
  expect(body).toContain("We proved it was a NAT data-processing surge");

  const sessionStream = factoryChatSessionStream(process.cwd(), "generalist", "chat_demo");
  const sessionEvents = agentEventStore?.get(sessionStream) ?? [];
  const finalEvent = sessionEvents.find((event): event is Extract<AgentEvent, { type: "response.finalized" }> =>
    event.type === "response.finalized"
  );
  expect(finalEvent?.content).not.toContain("handed back to Chat");
  expect(finalEvent?.content).toContain("We proved it was a NAT data-processing surge");
});

test("factory route: completed durable handoff does not synthesize a cleanup follow-up in chat", async () => {
  let currentObjective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_completed"),
    title: "List EC2 instances (us-east-1)",
    status: "completed",
    phase: "completed",
    latestSummary: "EC2 inventory for us-east-1 completed successfully: 16 instances total.",
    nextAction: "Investigation is complete.",
    activeTaskCount: 0,
    readyTaskCount: 0,
    latestHandoff: {
      status: "completed",
      summary: "EC2 inventory for us-east-1 completed successfully: 16 instances total.",
      renderedBody: [
        "EC2 inventory for us-east-1 completed successfully: 16 instances total (4 running, 12 stopped).",
        "",
        "| InstanceId | Name | State |",
        "| --- | --- | --- |",
        "| i-0f08ffa180c067fd2 | cloudscore-dev-db | running |",
      ].join("\n"),
      output: [
        "EC2 inventory for us-east-1 completed successfully: 16 instances total (4 running, 12 stopped).",
        "",
        "| InstanceId | Name | State |",
        "| --- | --- | --- |",
        "| i-0f08ffa180c067fd2 | cloudscore-dev-db | running |",
      ].join("\n"),
      handoffKey: "handoff_ec2_inventory",
      sourceUpdatedAt: 1_710_000_000_000,
    },
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;

  let agentEventStore: Map<string, AgentEvent[]> | undefined;
  const app = createRouteTestApp({
    captureAgentEventStore: (store) => {
      agentEventStore = store;
    },
    service: {
      listObjectives: async () => [
        currentObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => currentObjective,
    },
  });

  const firstResponse = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_completed&inspectorTab=chat");
  expect(firstResponse.status).toBe(200);

  const sessionStream = factoryChatSessionStream(process.cwd(), "generalist", "chat_demo");
  const firstSessionEvents = agentEventStore?.get(sessionStream) ?? [];
  const firstFinalized = firstSessionEvents.filter((event): event is Extract<AgentEvent, { type: "response.finalized" }> =>
    event.type === "response.finalized"
  );
  expect(firstFinalized).toHaveLength(1);
  expect(firstFinalized[0]?.content).toContain("EC2 inventory for us-east-1 completed successfully");
  expect(firstFinalized[0]?.content).not.toContain("Controller is retiring lingering jobs");

  currentObjective = {
    ...currentObjective,
    nextAction: "Controller is retiring lingering jobs after the objective finished.",
  };

  const secondResponse = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_completed&inspectorTab=chat");
  expect(secondResponse.status).toBe(200);

  const secondSessionEvents = agentEventStore?.get(sessionStream) ?? [];
  const secondFinalized = secondSessionEvents.filter((event): event is Extract<AgentEvent, { type: "response.finalized" }> =>
    event.type === "response.finalized"
  );
  expect(secondFinalized).toHaveLength(1);
  expect(secondFinalized[0]?.content).toContain("EC2 inventory for us-east-1 completed successfully");
  expect(secondFinalized[0]?.content).not.toContain("Controller is retiring lingering jobs");
});

test("factory route: session stream changes invalidate the cached chat island transcript", async () => {
  const chatId = "chat_handoff_cache";
  let agentEventStore: Map<string, AgentEvent[]> | undefined;
  const app = createRouteTestApp({
    captureAgentEventStore: (store) => {
      agentEventStore = store;
    },
    agentEvents: {
      [factoryChatSessionStream(process.cwd(), "generalist", chatId)]: [
        {
          type: "problem.set",
          runId: "run_chat_handoff",
          problem: "Summarize the current investigation.",
          agentId: "factory",
        },
        {
          type: "response.finalized",
          runId: "run_chat_handoff",
          content: "Blocked handoff: NAT spike attribution still needs retained evidence.",
          agentId: "factory",
        },
      ],
    },
  });

  const blockedResponse = await app.request(
    `http://receipt.test/factory/island/chat?profile=generalist&chat=${chatId}&inspectorTab=chat`,
    { headers: { "HX-Request": "true" } },
  );
  const blockedBody = await blockedResponse.text();
  expect(blockedResponse.status).toBe(200);
  expect(blockedBody).toContain("Blocked handoff: NAT spike attribution still needs retained evidence.");

  const sessionStream = factoryChatSessionStream(process.cwd(), "generalist", chatId);
  const sessionEvents = agentEventStore?.get(sessionStream) ?? [];
  sessionEvents.push({
    type: "response.finalized",
    runId: "run_chat_handoff_followup",
    content: "Investigation complete: the spike was a one-day NAT data-processing surge.",
    agentId: "factory",
  });
  agentEventStore?.set(sessionStream, sessionEvents);
  await new Promise((resolve) => setTimeout(resolve, 950));

  const completedResponse = await app.request(
    `http://receipt.test/factory/island/chat?profile=generalist&chat=${chatId}&inspectorTab=chat`,
    { headers: { "HX-Request": "true" } },
  );
  const completedBody = await completedResponse.text();

  expect(completedResponse.status).toBe(200);
  expect(completedBody).toContain("Investigation complete: the spike was a one-day NAT data-processing surge.");
});

test("factory route: fresh objective projection versions invalidate cached workbench islands", async () => {
  const objectiveId = "objective_projection_live";
  const chatId = "chat_projection_live";
  let projectionVersion = 1;
  let currentObjective = {
    ...makeRunningWorkbenchObjectiveDetail(objectiveId),
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

  const firstResponse = await app.request(
    `http://receipt.test/factory/island/workbench/board?profile=generalist&chat=${chatId}&objective=${objectiveId}`,
    { headers: { "HX-Request": "true" } },
  );
  const firstBody = await firstResponse.text();
  expect(firstResponse.status).toBe(200);
  expect(firstBody).toContain("Live objective");

  projectionVersion += 1;
  currentObjective = {
    ...currentObjective,
    title: "Updated live objective",
    latestSummary: "The refreshed projection should replace the cached workbench shell.",
  };
  await new Promise((resolve) => setTimeout(resolve, 950));

  const secondResponse = await app.request(
    `http://receipt.test/factory/island/workbench/board?profile=generalist&chat=${chatId}&objective=${objectiveId}`,
    { headers: { "HX-Request": "true" } },
  );
  const secondBody = await secondResponse.text();
  expect(secondResponse.status).toBe(200);
  expect(secondBody).toContain("Updated live objective");
  expect(secondBody).toContain("The refreshed projection should replace the cached workbench shell.");
});

test("factory route: workbench fragments expose server timing for render hotspots", async () => {
  const app = createRouteTestApp();

  const response = await app.request(
    "http://receipt.test/factory/island/workbench/rail?profile=generalist&chat=chat_demo",
    { headers: { "HX-Request": "true" } },
  );

  expect(response.status).toBe(200);
  const timing = response.headers.get("server-timing") ?? "";
  expect(timing).toContain("request_normalization;dur=");
  expect(timing).toContain("session_version;dur=");
  expect(timing).toContain("objective_version;dur=");
  expect(timing).toContain("workspace_model;dur=");
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
  const focusResponse = await app.request(
    "http://receipt.test/factory/island/workbench/focus?profile=generalist&objective=objective_live&detailTab=review",
    { headers: { "HX-Request": "true" } },
  );
  const focusBody = await focusResponse.text();

  expect(response.status).toBe(200);
  expect(focusResponse.status).toBe(200);
  expect(body).toContain("Execution Log");
  expect(focusBody).toContain("Execution Log");
  expect(body).toContain("Codex Log");
  expect(body).toContain("build ok");
  expect(body).toContain("Worker running");
  expect(focusBody).not.toContain("Latest Outcome");
  expect(focusBody).not.toContain("Next Operator Action");
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
  expect(body).toContain("Responsibilities");
  expect(body).toContain("Operating Style");
  expect(body).toContain("Decision Rules");
  expect(body).toContain('id="factory-workbench-rail-scroll"');
  expect(body).toContain('id="factory-workbench-focus-scroll"');
  expect(body).toContain('data-preserve-scroll-key="rail"');
  expect(body).toContain('data-preserve-scroll-key="focus"');
  expect(body).not.toContain("max-w-[1680px]");
  expect(body.match(/data-factory-profile-select="true"/g)?.length ?? 0).toBe(1);
  expect(body).toContain('data-inspector-tab="overview"');
  expect(body).toContain('data-refresh-on="sse:profile-board-refresh@320,sse:objective-runtime-refresh@320"');
  expect(body).not.toContain('hx-trigger="sse:profile-board-refresh throttle:320ms, sse:objective-runtime-refresh throttle:320ms"');
  expect(body).not.toContain('sse-connect="/factory/background/events?profile=generalist&amp;chat=chat_demo&amp;objective=objective_live&amp;detailTab=action&amp;focusKind=task&amp;focusId=task_01"');
  expect(body).toMatch(/id="factory-workbench-background-root"[^>]*data-refresh-path="\/factory\/island\/workbench\/background-root\?profile=generalist&amp;chat=chat_demo&amp;objective=objective_live&amp;detailTab=action&amp;focusKind=task&amp;focusId=task_01"/);
  expect(body).toMatch(/id="factory-workbench-chat-body"[^>]*data-refresh-on="sse:profile-board-refresh@300,sse:objective-runtime-refresh@300"/);
  expect(body).not.toMatch(/id="factory-workbench-rail-shell"[^>]*data-refresh-on=/);
  expect(body).not.toMatch(/id="factory-workbench-focus-shell"[^>]*data-refresh-on=/);
  expect(body).toMatch(/id="factory-workbench-panel"[^>]*data-refresh-path="\/factory\/island\/workbench\?profile=generalist&amp;chat=chat_demo&amp;objective=objective_live&amp;detailTab=action&amp;focusKind=task&amp;focusId=task_01"/);
  expect(body).not.toMatch(/id="factory-workbench-panel"[^>]*data-refresh-on=/);
  expect(body).not.toContain('data-refresh-path="/factory/island/workbench/header?profile=generalist&amp;chat=chat_demo&amp;objective=objective_live&amp;detailTab=action&amp;focusKind=task&amp;focusId=task_01"');
  expect(body).toContain('data-events-path="/factory/chat/events?profile=generalist&amp;chat=chat_demo&amp;objective=objective_live"');
  expect(body).toContain('hx-get="/factory/island/workbench/focus?profile=generalist&amp;chat=chat_demo&amp;objective=objective_live&amp;detailTab=action&amp;focusKind=task&amp;focusId=task_01"');
  expect(body).toContain('hx-get="/factory/island/workbench/rail?profile=generalist&amp;chat=chat_demo&amp;objective=objective_live');
  expect(body).toContain('filter=objective.running');
  expect(body).toContain('hx-get="/factory/island/workbench/chat-shell?profile=generalist&amp;chat=chat_demo&amp;objective=objective_live');
  expect(body).toContain('hx-target="#factory-workbench-chat-region"');
  expect(body).toContain('data-route-key="/factory?profile=generalist&amp;chat=chat_demo&amp;objective=objective_live&amp;detailTab=action&amp;focusKind=task&amp;focusId=task_01"');
  expect(body).toContain('href="/factory/new-chat?profile=generalist&amp;inspectorTab=chat&amp;detailTab=action&amp;filter=objective.running"');
  expect(body).toContain('hx-target="#factory-workbench-chat-region"');
  expect(body).not.toContain("objective=objective_done");
});

test("factory workbench route: overview renders self-improvement recommendations and auto-fix objectives", async () => {
  const liveObjective = {
    ...makeRunningWorkbenchObjectiveDetail(),
    selfImprovement: {
      auditedAt: 17,
      auditStatus: "ready",
      stale: false,
      recommendationStatus: "ready" as const,
      recommendations: [{
        summary: "Expose self-improvement recommendations in the selected objective card.",
        anomalyPatterns: ["missing-ui-visibility", "operator-blind-spot"],
        scope: "ui",
        confidence: "high" as const,
        suggestedFix: "Add a dedicated Self Improvement section to the workbench summary.",
      }],
      autoFixObjectiveId: "objective_auto_fix",
      recurringPatterns: [{
        pattern: "missing-ui-visibility",
        count: 4,
      }],
    },
  } as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        {
          ...liveObjective,
          section: "active" as const,
        } as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => liveObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_live");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Self Improvement");
  expect(body).toContain("Expose self-improvement recommendations in the selected objective card.");
  expect(body).toContain("Add a dedicated Self Improvement section to the workbench summary.");
  expect(body).toContain("objective_auto_fix");
  expect(body).toContain("missing-ui-visibility ×4");
  expect(body).toContain('data-factory-href="/factory?profile=generalist&amp;chat=chat_demo&amp;objective=objective_auto_fix&amp;inspectorTab=chat&amp;detailTab=action"');
});

test("factory workbench route: overview renders repo-wide system improvement summary and mirrored objective snapshot", async () => {
  const liveObjective = {
    ...makeRunningWorkbenchObjectiveDetail(),
    systemImprovement: {
      generatedAt: 42,
      healthStatus: "action_needed" as const,
      auditSummary: {
        objectivesAudited: 12,
        weakObjectives: 8,
        strongObjectives: 4,
        topAnomalies: [{
          category: "alignment_not_reported",
          count: 6,
        }],
      },
      dstSummary: {
        streamCount: 123,
        integrityFailures: 0,
        replayFailures: 0,
        deterministicFailures: 0,
      },
      contextSummary: {
        runCount: 15,
        hardFailureCount: 3,
        compatibilityWarningCount: 7,
        replayFailures: 0,
        deterministicFailures: 0,
      },
      recommendations: [{
        summary: "Stabilize alignment reporting across the worker finalization path.",
        anomalyPatterns: ["alignment_not_reported"],
        scope: "src/services/factory/runtime/service.ts",
        confidence: "high" as const,
        suggestedFix: "Persist a deterministic alignment artifact before job completion.",
        successMetrics: [{
          label: "context_dst",
          baseline: "3 hard failures",
          target: "0 hard failures",
          verification: ["bun src/cli.ts dst --context --json"],
          severity: "hard_defect" as const,
        }],
        acceptanceChecks: ["bun src/cli.ts dst --context --json"],
      }],
      selectedRecommendation: {
        summary: "Stabilize alignment reporting across the worker finalization path.",
        anomalyPatterns: ["alignment_not_reported"],
        scope: "src/services/factory/runtime/service.ts",
        confidence: "high" as const,
        suggestedFix: "Persist a deterministic alignment artifact before job completion.",
        successMetrics: [{
          label: "context_dst",
          baseline: "3 hard failures",
          target: "0 hard failures",
          verification: ["bun src/cli.ts dst --context --json"],
          severity: "hard_defect" as const,
        }],
        acceptanceChecks: ["bun src/cli.ts dst --context --json"],
      },
      autoFixObjectiveId: "objective_system_auto_fix",
    },
  } as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        {
          ...liveObjective,
          section: "active" as const,
        } as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => liveObjective,
      buildBoardProjection: async () => ({
        objectives: [{
          ...liveObjective,
          section: "active" as const,
        }],
        sections: {
          needs_attention: [],
          active: [{
            ...liveObjective,
            section: "active" as const,
          }],
          queued: [],
          completed: [],
        },
        selectedObjectiveId: liveObjective.objectiveId,
        systemImprovement: liveObjective.systemImprovement,
      }),
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_live");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("System Improvement");
  expect(body).toContain("Stabilize alignment reporting across the worker finalization path.");
  expect(body).toContain("Repo-wide auto-fix objective");
  expect(body).toContain("objective_system_auto_fix");
  expect(body).toContain("alignment_not_reported ×6");
  expect(body).toContain("Baseline: 3 hard failures");
  expect(body).toContain("Target: 0 hard failures");
});

test("factory workbench route: overview renders apply button for actionable repo-wide system recommendations", async () => {
  const liveObjective = {
    ...makeRunningWorkbenchObjectiveDetail(),
    systemImprovement: {
      generatedAt: 42,
      healthStatus: "action_needed" as const,
      auditSummary: {
        objectivesAudited: 12,
        weakObjectives: 8,
        strongObjectives: 4,
        topAnomalies: [{
          category: "lease expired",
          count: 6,
        }],
      },
      dstSummary: {
        streamCount: 123,
        integrityFailures: 0,
        replayFailures: 0,
        deterministicFailures: 0,
      },
      contextSummary: {
        runCount: 15,
        hardFailureCount: 3,
        compatibilityWarningCount: 7,
        replayFailures: 0,
        deterministicFailures: 0,
      },
      recommendations: [{
        summary: "Stabilize lease renewal in the runtime.",
        anomalyPatterns: ["lease_expired"],
        scope: "src/services/factory/runtime/service.ts",
        confidence: "high" as const,
        suggestedFix: "Add a shared LeaseManager and wire it into long-running workers.",
        successMetrics: [{
          label: "factory_audit",
          baseline: "6 lease expiries",
          target: "0 lease expiries",
          verification: ["bun src/cli.ts factory audit --limit 12 --json"],
          severity: "hard_defect" as const,
        }],
        acceptanceChecks: ["bun src/cli.ts factory audit --limit 12 --json"],
      }],
      selectedRecommendation: {
        summary: "Stabilize lease renewal in the runtime.",
        anomalyPatterns: ["lease_expired"],
        scope: "src/services/factory/runtime/service.ts",
        confidence: "high" as const,
        suggestedFix: "Add a shared LeaseManager and wire it into long-running workers.",
        successMetrics: [{
          label: "factory_audit",
          baseline: "6 lease expiries",
          target: "0 lease expiries",
          verification: ["bun src/cli.ts factory audit --limit 12 --json"],
          severity: "hard_defect" as const,
        }],
        acceptanceChecks: ["bun src/cli.ts factory audit --limit 12 --json"],
      },
    },
  } as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        {
          ...liveObjective,
          section: "active" as const,
        } as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => liveObjective,
      buildBoardProjection: async () => ({
        objectives: [{
          ...liveObjective,
          section: "active" as const,
        }],
        sections: {
          needs_attention: [],
          active: [{
            ...liveObjective,
            section: "active" as const,
          }],
          queued: [],
          completed: [],
        },
        selectedObjectiveId: liveObjective.objectiveId,
        systemImprovement: liveObjective.systemImprovement,
      }),
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_live");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain('action="/factory/api/system-improvement/apply?profile=generalist&amp;chat=chat_demo&amp;objective=objective_live');
  expect(body).toContain('data-factory-inline-pending-status="Applying repo-wide system recommendation..."');
  expect(body).toContain(">Apply</button>");
});

test("factory workbench route: overview renders apply button for actionable self-improvement recommendations", async () => {
  const liveObjective = {
    ...makeRunningWorkbenchObjectiveDetail(),
    selfImprovement: {
      auditedAt: 17,
      auditStatus: "ready",
      stale: false,
      recommendationStatus: "ready" as const,
      recommendations: [{
        summary: "Add a one-click apply path for self-improvement recommendations.",
        anomalyPatterns: ["missing_manual_apply"],
        scope: "src/views/factory/workbench/page.ts",
        confidence: "high" as const,
        suggestedFix: "Render an Apply button and post it to a manual auto-fix objective endpoint.",
      }],
      recurringPatterns: [],
    },
  } as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [
        {
          ...liveObjective,
          section: "active" as const,
        } as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => liveObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_live");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain('action="/factory/api/objectives/objective_live/self-improvement/apply?profile=generalist&amp;chat=chat_demo&amp;objective=objective_live');
  expect(body).toContain('data-factory-inline-submit="true"');
  expect(body).toContain('data-factory-inline-pending-label="Applying..."');
  expect(body).toContain('data-factory-inline-pending-status="Applying self-improvement recommendation..."');
  expect(body).toContain('data-factory-inline-status="true"');
  expect(body).toContain('id="factory-chat-streaming-content"');
  expect(body).toContain('name="recommendationIndex" value="0"');
  expect(body).toContain(">Apply</button>");
});

test("factory route: applying a self-improvement recommendation creates an auto-fix objective and redirects to it", async () => {
  const dataDir = await createTempDir("factory-route-apply-self-improvement");
  const auditDir = path.join(dataDir, "factory", "artifacts", "objective_live");
  await fs.mkdir(auditDir, { recursive: true });
  await fs.writeFile(path.join(auditDir, "objective.audit.json"), JSON.stringify({
    audit: {
      generatedAt: 17,
      objectiveUpdatedAt: 17,
      objectiveChannel: "trial",
      recommendationStatus: "ready",
      recommendations: [{
        summary: "Add a first-class manual apply flow for audit recommendations.",
        anomalyPatterns: ["missing_manual_apply"],
        scope: "src/agents/factory/route/register-factory-api-routes.ts",
        confidence: "high",
        suggestedFix: "Create an endpoint that turns a recommendation into an auto-fix objective.",
      }],
      recurringPatterns: [{
        pattern: "missing_manual_apply",
        count: 2,
      }],
    },
  }, null, 2), "utf-8");

  const liveObjective = {
    ...makeRunningWorkbenchObjectiveDetail(),
    objectiveId: "objective_live",
    selfImprovement: {
      auditedAt: 17,
      auditStatus: "ready",
      stale: false,
      recommendationStatus: "ready" as const,
      recommendations: [{
        summary: "Add a first-class manual apply flow for audit recommendations.",
        anomalyPatterns: ["missing_manual_apply"],
        scope: "src/agents/factory/route/register-factory-api-routes.ts",
        confidence: "high" as const,
        suggestedFix: "Create an endpoint that turns a recommendation into an auto-fix objective.",
      }],
      recurringPatterns: [{
        pattern: "missing_manual_apply",
        count: 2,
      }],
    },
  } as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const createdInputs: Array<Parameters<FactoryService["createObjective"]>[0]> = [];
  const app = createRouteTestApp({
    dataDir,
    service: {
      listObjectives: async () => [],
      getObjective: async (objectiveId: string) => {
        if (objectiveId === "objective_live") return liveObjective;
        return {
          ...makeRunningWorkbenchObjectiveDetail(),
          objectiveId,
          title: "Manual auto-fix objective",
          channel: "auto-fix",
          prompt: "operator-applied self-improvement",
        } as Awaited<ReturnType<FactoryService["getObjective"]>>;
      },
      createObjective: async (input) => {
        createdInputs.push(input);
        return {
          ...makeRunningWorkbenchObjectiveDetail(),
          objectiveId: "objective_auto_fix_manual",
          title: input.title,
          prompt: input.prompt,
          channel: input.channel,
          profile: {
            ...makeRunningWorkbenchObjectiveDetail().profile,
            rootProfileId: input.profileId ?? makeRunningWorkbenchObjectiveDetail().profile.rootProfileId,
          },
        } as Awaited<ReturnType<FactoryService["createObjective"]>>;
      },
    },
  });

  const body = new URLSearchParams({ recommendationIndex: "0" });
  const response = await app.request(
    "http://receipt.test/factory/api/objectives/objective_live/self-improvement/apply?profile=generalist&chat=chat_demo&objective=objective_live",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
  );
  const payload = await response.json() as {
    readonly location?: string;
  };

  expect(response.status).toBe(200);
  expect(payload.location).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_auto_fix_manual&inspectorTab=chat&detailTab=action");
  expect(createdInputs).toHaveLength(1);
  expect(createdInputs[0]?.channel).toBe("auto-fix");
  expect(createdInputs[0]?.profileId).toBeUndefined();
  expect(createdInputs[0]?.prompt).toContain("Operator-applied self-improvement recommendation.");
  expect(createdInputs[0]?.prompt).toContain("## Source Objective\nobjective_live");
  expect(createdInputs[0]?.prompt).toContain("factory_auto_fix_key:");
});

test("factory route: applying a repo-wide system recommendation creates a software auto-fix objective and redirects to it", async () => {
  const dataDir = await createTempDir("factory-route-apply-system-improvement");
  const systemDir = path.join(dataDir, "factory", "artifacts", "repo");
  await fs.mkdir(systemDir, { recursive: true });
  await fs.writeFile(path.join(systemDir, "system-improvement.json"), JSON.stringify({
    generatedAt: 42,
    healthStatus: "action_needed",
    auditSummary: {
      objectivesAudited: 12,
      weakObjectives: 8,
      strongObjectives: 4,
      topAnomalies: [{
        category: "lease expired",
        count: 6,
      }],
    },
    dstSummary: {
      streamCount: 123,
      integrityFailures: 0,
      replayFailures: 0,
      deterministicFailures: 0,
    },
    contextSummary: {
      runCount: 15,
      hardFailureCount: 3,
      compatibilityWarningCount: 7,
      replayFailures: 0,
      deterministicFailures: 0,
    },
    recommendations: [{
      summary: "Stabilize lease renewal in the runtime.",
      anomalyPatterns: ["lease_expired"],
      scope: "src/services/factory/runtime/service.ts",
      confidence: "high",
      suggestedFix: "Add a shared LeaseManager and wire it into long-running workers.",
      successMetrics: [{
        label: "factory_audit",
        baseline: "6 lease expiries",
        target: "0 lease expiries",
        verification: ["bun src/cli.ts factory audit --limit 12 --json"],
        severity: "hard_defect",
      }],
      acceptanceChecks: ["bun src/cli.ts factory audit --limit 12 --json"],
    }],
    selectedRecommendation: {
      summary: "Stabilize lease renewal in the runtime.",
      anomalyPatterns: ["lease_expired"],
      scope: "src/services/factory/runtime/service.ts",
      confidence: "high",
      suggestedFix: "Add a shared LeaseManager and wire it into long-running workers.",
      successMetrics: [{
        label: "factory_audit",
        baseline: "6 lease expiries",
        target: "0 lease expiries",
        verification: ["bun src/cli.ts factory audit --limit 12 --json"],
        severity: "hard_defect",
      }],
      acceptanceChecks: ["bun src/cli.ts factory audit --limit 12 --json"],
    },
  }, null, 2), "utf-8");

  const createdInputs: Array<Parameters<FactoryService["createObjective"]>[0]> = [];
  const app = createRouteTestApp({
    dataDir,
    service: {
      listObjectives: async () => [],
      getObjective: async (objectiveId: string) => ({
        ...makeRunningWorkbenchObjectiveDetail(),
        objectiveId,
        title: "Repo-wide auto-fix objective",
        channel: "auto-fix",
        prompt: "operator-applied repo-wide system improvement",
        profile: {
          ...makeRunningWorkbenchObjectiveDetail().profile,
          rootProfileId: "software",
        },
      } as Awaited<ReturnType<FactoryService["getObjective"]>>),
      createObjective: async (input) => {
        createdInputs.push(input);
        return {
          ...makeRunningWorkbenchObjectiveDetail(),
          objectiveId: "objective_system_auto_fix_manual",
          title: input.title,
          prompt: input.prompt,
          channel: input.channel,
          profile: {
            ...makeRunningWorkbenchObjectiveDetail().profile,
            rootProfileId: input.profileId ?? "software",
          },
        } as Awaited<ReturnType<FactoryService["createObjective"]>>;
      },
    },
  });

  const response = await app.request(
    "http://receipt.test/factory/api/system-improvement/apply?profile=generalist&chat=chat_demo&objective=objective_live",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "",
    },
  );
  const payload = await response.json() as {
    readonly location?: string;
  };

  expect(response.status).toBe(200);
  expect(payload.location).toBe("/factory?profile=software&chat=chat_demo&objective=objective_system_auto_fix_manual&inspectorTab=chat&detailTab=action");
  expect(createdInputs).toHaveLength(1);
  expect(createdInputs[0]?.channel).toBe("auto-fix");
  expect(createdInputs[0]?.profileId).toBe("software");
  expect(createdInputs[0]?.prompt).toContain("Operator-applied repo-wide system improvement recommendation.");
  expect(createdInputs[0]?.prompt).toContain("factory_system_auto_fix_key:");
});

test("factory route: applying a self-improvement recommendation from infrastructure does not reuse the investigation-only profile", async () => {
  const dataDir = await createTempDir("factory-route-apply-self-improvement-infra");
  const auditDir = path.join(dataDir, "factory", "artifacts", "objective_infra");
  await fs.mkdir(auditDir, { recursive: true });
  await fs.writeFile(path.join(auditDir, "objective.audit.json"), JSON.stringify({
    audit: {
      generatedAt: 17,
      objectiveUpdatedAt: 17,
      objectiveChannel: "trial",
      recommendationStatus: "ready",
      recommendations: [{
        summary: "Promote infrastructure audit follow-ups through the delivery lane.",
        anomalyPatterns: ["missing_manual_apply"],
        scope: "factory/objectives/aws_audit/*",
        confidence: "high",
        suggestedFix: "Create the delivery follow-up without binding it to the infrastructure investigation profile.",
      }],
      recurringPatterns: [],
    },
  }, null, 2), "utf-8");

  const liveObjective = {
    ...makeRunningWorkbenchObjectiveDetail("objective_infra"),
    profile: {
      ...makeRunningWorkbenchObjectiveDetail("objective_infra").profile,
      rootProfileId: "infrastructure",
      rootProfileLabel: "Infrastructure",
    },
    selfImprovement: {
      auditedAt: 17,
      auditStatus: "ready",
      stale: false,
      recommendationStatus: "ready" as const,
      recommendations: [{
        summary: "Promote infrastructure audit follow-ups through the delivery lane.",
        anomalyPatterns: ["missing_manual_apply"],
        scope: "factory/objectives/aws_audit/*",
        confidence: "high" as const,
        suggestedFix: "Create the delivery follow-up without binding it to the infrastructure investigation profile.",
      }],
      recurringPatterns: [],
    },
  } as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const createdInputs: Array<Parameters<FactoryService["createObjective"]>[0]> = [];
  const app = createRouteTestApp({
    dataDir,
    service: {
      listObjectives: async () => [],
      getObjective: async (objectiveId: string) => {
        if (objectiveId === "objective_infra") return liveObjective;
        return {
          ...makeRunningWorkbenchObjectiveDetail(),
          objectiveId,
          title: "Auto-fix objective",
          channel: "auto-fix",
        } as Awaited<ReturnType<FactoryService["getObjective"]>>;
      },
      createObjective: async (input) => {
        createdInputs.push(input);
        return {
          ...makeRunningWorkbenchObjectiveDetail(),
          objectiveId: "objective_auto_fix_infra",
          title: input.title,
          prompt: input.prompt,
          channel: input.channel,
        } as Awaited<ReturnType<FactoryService["createObjective"]>>;
      },
    },
  });

  const response = await app.request(
    "http://receipt.test/factory/api/objectives/objective_infra/self-improvement/apply?profile=infrastructure&chat=chat_demo&objective=objective_infra",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ recommendationIndex: "0" }).toString(),
    },
  );
  const payload = await response.json() as {
    readonly location?: string;
  };

  expect(response.status).toBe(200);
  expect(payload.location).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_auto_fix_infra&inspectorTab=chat&detailTab=action");
  expect(createdInputs).toHaveLength(1);
  expect(createdInputs[0]?.profileId).toBeUndefined();
  expect(createdInputs[0]?.channel).toBe("auto-fix");
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

test("factory workbench route: chat-thread follow-up objectives suppress predecessor duplicates in queue lists", async () => {
  const blockedObjective = {
    ...makeStubObjectiveDetail("objective_blocked"),
    title: "Original blocked objective",
    status: "blocked",
    phase: "blocked",
    scheduler: { slotState: "released" },
    latestSummary: "Original attempt stalled during startup recovery.",
    blockedReason: "Original attempt stalled during startup recovery.",
    nextAction: "Use /react to continue the selected objective.",
    activeTaskCount: 0,
    readyTaskCount: 0,
    taskCount: 1,
    updatedAt: 10,
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const followUpObjective = {
    ...makeStubObjectiveDetail("objective_followup"),
    title: "Continued follow-up objective",
    status: "completed",
    phase: "completed",
    scheduler: { slotState: "idle" },
    latestSummary: "Published the continuation cleanly.",
    nextAction: "Objective is complete.",
    activeTaskCount: 0,
    readyTaskCount: 0,
    taskCount: 1,
    updatedAt: 20,
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const blockedCard = { ...blockedObjective, section: "needs_attention" as const };
  const followUpCard = { ...followUpObjective, section: "completed" as const };
  const sessionStream = factoryChatSessionStream(process.cwd(), "generalist", "chat_demo");
  const app = createRouteTestApp({
    agentEvents: {
      [sessionStream]: [
        {
          type: "problem.set",
          runId: "run_dispatch_followup",
          problem: "Continue with the pagination work.",
          agentId: "orchestrator",
        },
        {
          type: "thread.bound",
          runId: "run_dispatch_followup",
          agentId: "orchestrator",
          objectiveId: "objective_blocked",
          chatId: "chat_demo",
          reason: "startup",
        },
        {
          type: "thread.bound",
          runId: "run_dispatch_followup",
          agentId: "orchestrator",
          objectiveId: "objective_followup",
          chatId: "chat_demo",
          reason: "dispatch_create",
          created: true,
        },
      ],
    },
    service: {
      buildBoardProjection: async () => ({
        objectives: [followUpCard, blockedCard],
        sections: {
          needs_attention: [blockedCard],
          active: [],
          queued: [],
          completed: [followUpCard],
        },
        selectedObjectiveId: "objective_followup",
      }),
      listObjectives: async () => [
        followUpObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
        blockedObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async (objectiveId: string) => objectiveId === "objective_blocked"
        ? blockedObjective
        : followUpObjective,
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_demo&objective=objective_followup&detailTab=queue&filter=objective.needs_attention");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Current selection");
  expect(body).toContain("Continued follow-up objective");
  expect(body).toContain("No blocked objectives match the current filter.");
  expect(body).not.toContain("Original blocked objective");
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

  const response = await app.request("http://receipt.test/factory/api/workbench-shell?profile=generalist&chat=chat_demo&objective=objective_live&page=2");
  const snapshot = await response.json() as { readonly routeKey?: string };

  expect(response.status).toBe(200);
  expect(snapshot.routeKey).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_live&detailTab=action&page=2&focusKind=task&focusId=task_01");
});

test("factory route: workbench redirect preserves pagination state in the canonical url", async () => {
  const app = createRouteTestApp({
    service: {
      buildBoardProjection: async () => ({
        objectives: [],
        sections: {
          needs_attention: [],
          active: [],
          queued: [],
          completed: [],
        },
        selectedObjectiveId: undefined,
      }),
      listObjectives: async () => [],
    },
  });

  const response = await app.request("http://receipt.test/factory/workbench?profile=generalist&chat=chat_demo&page=2");

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/factory?profile=generalist&chat=chat_demo&detailTab=queue&page=2");
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

test("factory route: selecting an objective reuses the objective's bound chat session", async () => {
  const dataDir = await createTempDir("receipt-factory-objective-chat-route");
  await writeChatProjection({
    dataDir,
    repoRoot: process.cwd(),
    profileId: "generalist",
    chatId: "chat_objective_b",
    events: [
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
        chatId: "chat_objective_b",
        reason: "startup",
      },
      {
        type: "response.finalized",
        runId: "run_objective_b",
        content: "Objective B reply",
        agentId: "factory",
      },
    ],
  });
  const objectiveB = {
    ...makeStubObjectiveDetail("objective_b", "job_b"),
    title: "Objective B",
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const objectiveCardB = { ...objectiveB, section: "active" as const };
  const app = createRouteTestApp({
    dataDir,
    service: {
      buildBoardProjection: async () => ({
        objectives: [objectiveCardB],
        sections: {
          needs_attention: [],
          active: [objectiveCardB],
          queued: [],
          completed: [],
        },
        selectedObjectiveId: "objective_b",
      }),
      listObjectives: async () => [
        objectiveB as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async () => objectiveB,
    },
  });

  const shellResponse = await app.request("http://receipt.test/factory/api/workbench-shell?profile=generalist&chat=chat_empty&objective=objective_b&inspectorTab=chat");
  const shell = await shellResponse.json() as { readonly location?: string; readonly chatHtml?: string };

  expect(shellResponse.status).toBe(200);
  const shellLocation = new URL(shell.location ?? "", "http://receipt.test");
  expect(shellLocation.pathname).toBe("/factory");
  expect(shellLocation.searchParams.get("profile")).toBe("generalist");
  expect(shellLocation.searchParams.get("chat")).toBe("chat_objective_b");
  expect(shellLocation.searchParams.get("objective")).toBe("objective_b");
  expect(shellLocation.searchParams.get("inspectorTab")).toBe("chat");
  expect(shell.chatHtml).toContain("Objective B reply");

  const queueResponse = await app.request("http://receipt.test/factory?profile=generalist&chat=chat_empty&detailTab=queue");
  const queueBody = await queueResponse.text();

  expect(queueResponse.status).toBe(200);
  expect(queueBody).toContain('href="/factory?profile=generalist&amp;chat=chat_objective_b&amp;objective=objective_b&amp;inspectorTab=chat&amp;detailTab=queue"');
  expect(queueBody).toContain('hx-get="/factory/island/workbench/select?profile=generalist&amp;chat=chat_objective_b&amp;objective=objective_b&amp;inspectorTab=chat&amp;detailTab=queue"');
});

test("factory route: chat-scoped action view prefers the chat-bound objective over the board default", async () => {
  const chatId = "chat_bound_preferred";
  const dataDir = await createTempDir("receipt-factory-chat-bound-action-view");
  await writeChatProjection({
    dataDir,
    repoRoot: process.cwd(),
    profileId: "generalist",
    chatId,
    events: [
      {
        type: "problem.set",
        runId: "run_bound",
        problem: "Continue the bound objective.",
        agentId: "factory",
      },
      {
        type: "thread.bound",
        runId: "run_bound",
        objectiveId: "objective_bound",
        chatId,
        reason: "startup",
      },
      {
        type: "response.finalized",
        runId: "run_bound",
        content: "Bound objective reply",
        agentId: "factory",
      },
    ],
  });
  const boardObjective = {
    ...makeStubObjectiveDetail("objective_board", "job_board"),
    title: "Board Default Objective",
    latestSummary: "Board default summary",
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const boundObjective = {
    ...makeStubObjectiveDetail("objective_bound", "job_bound"),
    title: "Chat Bound Objective",
    latestSummary: "Chat bound summary",
  } as unknown as Awaited<ReturnType<FactoryService["getObjective"]>>;
  const boardObjectiveCard = { ...boardObjective, section: "active" as const };
  const boundObjectiveCard = { ...boundObjective, section: "active" as const };
  const app = createRouteTestApp({
    dataDir,
    service: {
      buildBoardProjection: async () => ({
        objectives: [boardObjectiveCard, boundObjectiveCard],
        sections: {
          needs_attention: [],
          active: [boardObjectiveCard, boundObjectiveCard],
          queued: [],
          completed: [],
        },
        selectedObjectiveId: "objective_board",
      }),
      listObjectives: async () => [
        boardObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
        boundObjective as unknown as Awaited<ReturnType<FactoryService["listObjectives"]>>[number],
      ],
      getObjective: async (objectiveId: string) => objectiveId === "objective_bound" ? boundObjective : boardObjective,
    },
  });

  const response = await app.request(`http://receipt.test/factory/api/workbench-shell?profile=generalist&chat=${chatId}&inspectorTab=chat&detailTab=action`);
  const snapshot = await response.json() as {
    readonly routeKey?: string;
    readonly route?: { readonly objectiveId?: string };
    readonly workbenchHtml?: string;
    readonly chatHtml?: string;
  };

  expect(response.status).toBe(200);
  expect(snapshot.routeKey).toContain("objective=objective_bound");
  expect(snapshot.route?.objectiveId).toBe("objective_bound");
  expect(snapshot.workbenchHtml).toContain("Chat Bound Objective");
  expect(snapshot.workbenchHtml).toContain("Chat bound summary");
  expect(snapshot.workbenchHtml).toContain('data-objective-id="objective_bound"');
  expect(snapshot.chatHtml).toContain("Bound objective reply");
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

  const response = await app.request(
    "http://receipt.test/factory/island/chat?profile=generalist&chat=chat_demo&objective=objective_b&inspectorTab=chat",
    { headers: { "HX-Request": "true" } },
  );
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Objective B reply");
  expect(body).not.toContain("Objective A reply");
  expect(body).toContain('data-objective-id="objective_b"');
});

test("factory route: workbench chat and API read remembered defaults from shared user memory", async () => {
  const rememberedPreference = "Keep answers concise and operator-facing.";
  const app = createRouteTestApp({
    memoryTools: createRouteTestMemoryTools({
      repoPreferenceText: rememberedPreference,
    }),
  });

  const shellResponse = await app.request("http://receipt.test/factory/api/workbench-shell?profile=generalist&chat=chat_demo&inspectorTab=chat");
  const shellSnapshot = await shellResponse.json() as { readonly chatHtml?: string };
  expect(shellResponse.status).toBe(200);
  expect(shellSnapshot.chatHtml).not.toContain("Remembered Defaults");
  expect(shellSnapshot.chatHtml).not.toContain(rememberedPreference);

  const prefsResponse = await app.request("http://receipt.test/factory/api/user-preferences?scope=repo");
  const prefsBody = await prefsResponse.json() as { readonly entries?: ReadonlyArray<{ readonly text?: string }> };
  expect(prefsResponse.status).toBe(200);
  expect(prefsBody.entries?.some((entry) => entry.text === rememberedPreference)).toBe(true);
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
  expect(body).toContain('hx-get="/factory/island/workbench/select?profile=generalist&amp;chat=chat_demo&amp;objective=objective_done&amp;inspectorTab=chat&amp;detailTab=queue&amp;filter=objective.completed"');
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
  expect(body).not.toContain("No objective is selected. Start in New Chat to discuss the work, or select an objective from the queue to reopen its chat.");
  expect(body).toContain("Profile Brief");
  expect(body).toContain("Responsibilities");
  expect(body).toContain('data-detail-tab="queue"');
});

test("factory workbench route: stale objective urls render an explicit missing-objective state", async () => {
  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [],
      getObjective: async () => {
        throw new FactoryServiceError(404, "factory objective not found");
      },
      getObjectiveState: async () => {
        throw new FactoryServiceError(404, "factory objective not found");
      },
    },
  });

  const response = await app.request("http://receipt.test/factory?profile=software&chat=chat_demo&objective=objective_missing&detailTab=action");
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("Objective not found.");
  expect(body).toContain("objective_missing");
  expect(body).toContain("Selected objective could not be loaded from the current Factory store.");
  expect(body).not.toContain("No objective selected.");
  expect(body).not.toContain('data-factory-command="/react "');
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
    singletonMode: "cancel",
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
    singletonMode: "cancel",
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
  expect(response.headers.get("location")).toBe("/factory?profile=software&chat=chat_current&objective=objective_created&detailTab=action");
  expect(createdInput).toMatchObject({
    title: "Build the replacement thread",
    prompt: "Build the replacement thread.",
    profileId: "software",
    startImmediately: true,
  });
});

test("factory route: /new routes QA review work from Tech Lead into the QA engineer lane", async () => {
  let createdInput: Record<string, unknown> | undefined;
  const app = createRouteTestApp({
    service: {
      createObjective: async (input: Record<string, unknown>) => {
        createdInput = input;
        return makeStubObjectiveDetail("objective_created", "job_created");
      },
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&chat=chat_current", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "/new Review the current patch for regression risk.",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/factory?profile=qa&chat=chat_current&objective=objective_created&detailTab=action");
  expect(createdInput).toMatchObject({
    title: "Review the current patch for regression risk",
    prompt: "Review the current patch for regression risk.",
    profileId: "qa",
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
  expect(body.location).toBe("/factory?profile=software&chat=chat_demo&objective=objective_created&detailTab=action");
  expect(body.chat).toEqual({ chatId: "chat_demo" });
  expect(body.selection).toEqual({ objectiveId: "objective_created" });
  expect(createdInput).toMatchObject({
    title: "Build the replacement objective",
    prompt: "Build the replacement objective.",
    profileId: "software",
    startImmediately: true,
  });
});

test("factory route: infrastructure profile cannot create delivery objectives from /new", async () => {
  let createCalled = false;
  const app = createRouteTestApp({
    service: {
      createObjective: async () => {
        createCalled = true;
        return makeStubObjectiveDetail("objective_created", "job_created");
      },
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=infrastructure&chat=chat_demo", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body: new URLSearchParams({
      prompt: "/new Fix the broken dashboard route.",
    }).toString(),
  });

  expect(response.status).toBe(409);
  expect(createCalled).toBe(false);
  await expect(response.json()).resolves.toEqual({
    error: "Infrastructure cannot create delivery objectives.",
  });
});

test("factory route: QA Engineer cannot create investigation objectives from /new", async () => {
  let createCalled = false;
  const app = createRouteTestApp({
    service: {
      createObjective: async () => {
        createCalled = true;
        return makeStubObjectiveDetail("objective_created", "job_created");
      },
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=qa&chat=chat_demo", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body: new URLSearchParams({
      prompt: "/new Investigate why the queue is backing up.",
    }).toString(),
  });

  expect(response.status).toBe(409);
  expect(createCalled).toBe(false);
  await expect(response.json()).resolves.toEqual({
    error: "QA Engineer cannot create investigation objectives.",
  });
});

test("factory route: Tech Lead cannot promote objectives from the composer", async () => {
  let promoteCalled = false;
  const app = createRouteTestApp({
    service: {
      promoteObjective: async (objectiveId: string) => {
        promoteCalled = true;
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
      prompt: "/promote",
    }).toString(),
  });

  expect(response.status).toBe(409);
  expect(promoteCalled).toBe(false);
  await expect(response.json()).resolves.toEqual({
    error: "Tech Lead cannot promote objectives.",
  });
});

test("factory route: software profile can promote objectives from the composer", async () => {
  let promotedObjectiveId: string | undefined;
  const app = createRouteTestApp({
    service: {
      promoteObjective: async (objectiveId: string) => {
        promotedObjectiveId = objectiveId;
        return makeStubObjectiveDetail(objectiveId);
      },
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=software&chat=chat_demo&objective=objective_demo", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: "/promote",
    }).toString(),
  });

  expect(response.status).toBe(303);
  expect(promotedObjectiveId).toBe("objective_demo");
  expect(response.headers.get("location")).toBe("/factory?profile=software&chat=chat_demo&objective=objective_demo&detailTab=action");
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

test("factory workbench route: /steer queues a steer command for the active objective job", async () => {
  let steered: { readonly jobId: string; readonly message: string; readonly by?: string } | undefined;
  const activeJob = {
    id: "job_active",
    agentId: "factory",
    lane: "chat",
    payload: {
      kind: "factory.run",
      chatId: "chat_demo",
      objectiveId: "objective_demo",
    },
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    createdAt: 1,
    updatedAt: 2,
    commands: [],
  } as QueueJob;
  const app = createRouteTestApp({
    jobs: [activeJob],
    service: {
      queueJobSteer: async (jobId: string, message: string, by?: string) => {
        steered = { jobId, message, by };
        return {
          job: activeJob,
          command: {
            id: "cmd_steer",
            command: "steer",
            lane: "steer",
            payload: { message },
            createdAt: 3,
            by,
          },
        };
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
      prompt: "/steer Keep the answer short and inspect the latest failure first.",
      currentJobId: "job_active",
    }).toString(),
  });

  expect(response.status).toBe(200);
  const body = await response.json() as {
    readonly location?: string;
    readonly chat?: { readonly chatId?: string };
    readonly selection?: {
      readonly objectiveId?: string;
      readonly focusKind?: string;
      readonly focusId?: string;
    };
  };
  expect(body.location).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&focusKind=job&focusId=job_active");
  expect(body.chat).toEqual({ chatId: "chat_demo" });
  expect(body.selection).toEqual({
    objectiveId: "objective_demo",
    focusKind: "job",
    focusId: "job_active",
  });
  expect(steered).toEqual({
    jobId: "job_active",
    message: "Keep the answer short and inspect the latest failure first.",
    by: "factory.workbench",
  });
});

test("factory workbench route: /follow-up queues a follow-up command for the active objective job", async () => {
  let followedUp: { readonly jobId: string; readonly message: string; readonly by?: string } | undefined;
  const activeJob = {
    id: "job_active",
    agentId: "factory",
    lane: "chat",
    payload: {
      kind: "factory.run",
      chatId: "chat_demo",
      objectiveId: "objective_demo",
    },
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    createdAt: 1,
    updatedAt: 2,
    commands: [],
  } as QueueJob;
  const app = createRouteTestApp({
    jobs: [activeJob],
    service: {
      queueJobFollowUp: async (jobId: string, message: string, by?: string) => {
        followedUp = { jobId, message, by };
        return {
          job: activeJob,
          command: {
            id: "cmd_follow_up",
            command: "follow_up",
            lane: "follow_up",
            payload: { message },
            createdAt: 3,
            by,
          },
        };
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
      prompt: "/follow-up Include the exact run id in the summary.",
      currentJobId: "job_active",
    }).toString(),
  });

  expect(response.status).toBe(200);
  const body = await response.json() as {
    readonly location?: string;
    readonly chat?: { readonly chatId?: string };
    readonly selection?: {
      readonly objectiveId?: string;
      readonly focusKind?: string;
      readonly focusId?: string;
    };
  };
  expect(body.location).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=action&focusKind=job&focusId=job_active");
  expect(body.chat).toEqual({ chatId: "chat_demo" });
  expect(body.selection).toEqual({
    objectiveId: "objective_demo",
    focusKind: "job",
    focusId: "job_active",
  });
  expect(followedUp).toEqual({
    jobId: "job_active",
    message: "Include the exact run id in the summary.",
    by: "factory.workbench",
  });
});

test("factory workbench route: /follow-up resumes a blocked objective when no active job exists", async () => {
  let reacted: { readonly objectiveId: string; readonly message?: string } | undefined;
  const blockedObjective = {
    ...makeStubObjectiveDetail("objective_blocked", undefined),
    status: "blocked",
    phase: "blocked",
    latestSummary: "Waiting for operator guidance.",
    blockedReason: "Need the missing CLI contract before retrying.",
  };
  const app = createRouteTestApp({
    service: {
      getObjective: async () => blockedObjective,
      reactObjectiveWithNote: async (objectiveId: string, message?: string) => {
        reacted = { objectiveId, message };
        return {
          ...blockedObjective,
          objectiveId,
          status: "executing",
          phase: "collecting_evidence",
          latestSummary: message ?? "Resumed in place.",
        };
      },
    },
  });

  const response = await app.request("http://receipt.test/factory/compose?profile=generalist&chat=chat_demo&objective=objective_blocked", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body: new URLSearchParams({
      prompt: "/follow-up Use the CLI contract for the next pass.",
    }).toString(),
  });

  expect(response.status).toBe(200);
  const body = await response.json() as {
    readonly location?: string;
    readonly chat?: { readonly chatId?: string };
    readonly selection?: {
      readonly objectiveId?: string;
      readonly focusKind?: string;
      readonly focusId?: string;
    };
  };
  expect(body.location).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_blocked&detailTab=action");
  expect(body.chat).toEqual({ chatId: "chat_demo" });
  expect(body.selection).toEqual({ objectiveId: "objective_blocked" });
  expect(reacted).toEqual({
    objectiveId: "objective_blocked",
    message: "Use the CLI contract for the next pass.",
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
  const queue = sqliteQueue({ runtime: jobRuntime, stream: "jobs" });
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

test("factory route: /runtime returns the legacy runtime architecture layout with live data", async () => {
  const objectiveId = "objective_runtime";
  const profileId = "generalist";
  const chatId = "chat_runtime";
  const runId = "run_runtime";
  const sessionStream = factoryChatSessionStream(process.cwd(), profileId, chatId);
  const runStream = agentRunStream(sessionStream, runId);
  const app = createRouteTestApp({
    service: {
      listObjectives: async () => [makeRunningWorkbenchObjectiveDetail(objectiveId)],
    },
    jobs: [{
      id: "job_runtime",
      agentId: "factory",
      lane: "chat",
      status: "running",
      attempt: 1,
      maxAttempts: 2,
      createdAt: 10,
      updatedAt: 15,
      leaseUntil: 20,
      payload: {
        kind: "factory.run",
        objectiveId,
        stream: sessionStream,
        runId,
        problem: "Investigate runtime visibility",
      },
      commands: [],
    }],
    agentEvents: {
      [runStream]: [
        { type: "problem.set", runId, problem: "Investigate runtime visibility" },
        { type: "thread.bound", runId, objectiveId, reason: "startup" },
        { type: "iteration.started", runId, iteration: 1 },
        { type: "tool.called", runId, iteration: 1, tool: "receipt.inspect", input: {}, summary: "Checked recent receipts" },
        { type: "run.status", runId, status: "running", note: "Agent is reconciling queue state" },
      ],
    },
  });
  const response = await app.request("http://receipt.test/runtime");
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("RECEIPT RUNTIME");
  expect(body).toContain("<!doctype html>");
  expect(body).toContain("Control Plane");
  expect(body).toContain("Execution Plane");
  expect(body).toContain("Side Effects");
  expect(body).toContain("Multi-Objective Concurrency");
  expect(body).toContain("Child-Run Delegation Loop");
  expect(body).toContain("Data Stores");
  expect(body).toContain("Recent Activity");
  expect(body).toContain("Live objective");
  expect(body).toContain(objectiveId);
  expect(body).toContain("job_runtime");
  expect(body).toContain(runId);
  expect(body).toContain("Investigate runtime visibility");
  expect(body).toContain("Agent is reconciling queue state");
  expect(body).toContain('id="runtime-dashboard-live"');
  expect(body).toContain("/runtime/island");
  expect(body).toContain("/receipt/stream");
});

test("factory route: /runtime/island returns only the live runtime region", async () => {
  const app = createRouteTestApp();
  const response = await app.request("http://receipt.test/runtime/island");
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('id="runtime-dashboard-live"');
  expect(body).toContain("Data Stores");
  expect(body).toContain("Multi-Objective Concurrency");
  expect(body).not.toContain("LEGEND");
  expect(body).not.toContain("HTTP Commands");
  expect(body).not.toContain("Execution Plane");
});
