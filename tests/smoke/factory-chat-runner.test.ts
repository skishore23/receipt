import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { jsonlQueue } from "../../src/adapters/jsonl-queue";
import type { MemoryTools } from "../../src/adapters/memory-tools";
import { createRuntime } from "@receipt/core/runtime";
import type { JobCmd, JobEvent, JobState } from "../../src/modules/job";
import { decide as decideJob, initial as initialJob, reduce as reduceJob } from "../../src/modules/job";
import type { AgentCmd, AgentEvent, AgentState } from "../../src/modules/agent";
import { decide as decideAgent, initial as initialAgent, reduce as reduceAgent } from "../../src/modules/agent";
import { agentRunStream } from "../../src/agents/agent.streams";
import {
  FACTORY_CHAT_DEFAULT_CONFIG,
  analyzeFactoryChatTurn,
  renderFactoryResponseStyleGuidance,
  runFactoryChat,
  runFactoryCodexJob,
} from "../../src/agents/factory-chat";
import type { QueueJob } from "../../src/adapters/jsonl-queue";
import {
  historicalInfrastructureLoop,
  historicalInfrastructureObjectiveId,
  historicalInfrastructureObjectiveReceipts,
  historicalInfrastructureStartupObjectiveId,
} from "../fixtures/factory-infrastructure-replay";
import { factoryChatSessionStream, repoKeyForRoot } from "../../src/services/factory-chat-profiles";

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const createMemoryStub = (): MemoryTools => ({
  read: async () => [],
  search: async () => [],
  summarize: async () => ({ summary: "", entries: [] }),
  commit: async ({ scope, text, tags, meta }) => ({
    id: `memory_${Date.now()}`,
    scope,
    text,
    tags,
    meta,
    ts: Date.now(),
  }),
  diff: async () => [],
  reindex: async () => 0,
});

test("factory chat prompt guidance: renders conversational guidance explicitly", () => {
  expect(renderFactoryResponseStyleGuidance("conversational")).toContain("Do not use headings, scorecards, grades");
  expect(renderFactoryResponseStyleGuidance("conversational")).toContain("Do not turn the reply into operator-handoff analysis");
});

test("factory chat prompt guidance: analyzes turn shape with the model", async () => {
  const analysis = await analyzeFactoryChatTurn({
    apiReady: true,
    problem: "Who are you?",
    llmText: async () => JSON.stringify({
      responseStyle: "conversational",
      includeBoundObjectiveContext: false,
    }),
  });
  expect(analysis).toEqual({
    responseStyle: "conversational",
    includeBoundObjectiveContext: false,
  });
  expect(renderFactoryResponseStyleGuidance("work")).toContain("Choose the amount of structure");
});

const createNoopDelegationTools = () => ({
  "agent.delegate": async () => ({ output: "unused", summary: "unused" }),
  "agent.status": async () => ({ output: "unused", summary: "unused" }),
  "agent.inspect": async () => ({ output: "unused", summary: "unused" }),
});

const createFactoryServiceStub = (overrides: Partial<Record<string, unknown>> = {}) => ({
  getObjective: async (objectiveId: string) => ({
    objectiveId,
    title: "Objective demo",
    status: "active",
    phase: "executing",
    objectiveMode: "delivery",
    severity: 2,
    latestSummary: "Investigating the sidebar objective.",
    nextAction: "React the current objective.",
    integration: {
      status: "idle",
      queuedCandidateIds: [],
    },
    latestDecision: {
      summary: "Inspect the current candidate before reacting.",
      at: Date.now(),
      source: "runtime",
    },
    blockedExplanation: undefined,
    evidenceCards: [{
      kind: "decision",
      title: "Latest decision",
      summary: "Inspect the current candidate before reacting.",
      at: Date.now(),
      receiptType: "rebracket.applied",
    }],
    tasks: [],
  }),
  getObjectiveDebug: async () => ({
    activeJobs: [] as QueueJob[],
    taskWorktrees: [],
    integrationWorktree: undefined,
    latestContextPacks: [],
  }),
  listObjectiveReceipts: async () => ([
    {
      type: "rebracket.applied",
      hash: "hash_receipt_demo",
      ts: Date.now(),
      summary: "Inspect the current candidate before reacting.",
    },
  ]),
  getObjectiveLiveOutput: async (objectiveId: string, focusKind: string, focusId: string) => ({
    objectiveId,
    focusKind,
    focusId,
    title: "Live output",
    status: "running",
    active: true,
    summary: "Streaming live output.",
    stdoutTail: "tail",
  }),
  createObjective: async ({ prompt }: { readonly prompt: string }) => ({
    objectiveId: "objective_created",
    title: prompt,
    status: "queued",
    phase: "queued",
    latestSummary: prompt,
    integration: { status: "idle", queuedCandidateIds: [] },
  }),
  reactObjectiveWithNote: async (objectiveId: string, message?: string) => ({
    objectiveId,
    title: "Objective demo",
    status: "active",
    phase: "executing",
    latestSummary: message ?? "Reused current objective.",
    integration: { status: "idle", queuedCandidateIds: [] },
  }),
  reactObjective: async () => undefined,
  promoteObjective: async (objectiveId: string) => ({
    objectiveId,
    title: "Objective demo",
    status: "completed",
    phase: "completed",
    latestSummary: "Promoted.",
    integration: { status: "promoted", queuedCandidateIds: [] },
  }),
  cancelObjective: async (objectiveId: string) => ({
    objectiveId,
    title: "Objective demo",
    status: "canceled",
    phase: "blocked",
    latestSummary: "Canceled.",
    integration: { status: "idle", queuedCandidateIds: [] },
  }),
  cleanupObjectiveWorkspaces: async (objectiveId: string) => ({
    objectiveId,
    title: "Objective demo",
    status: "active",
    phase: "executing",
    latestSummary: "Cleaned up.",
    integration: { status: "idle", queuedCandidateIds: [] },
  }),
  archiveObjective: async (objectiveId: string) => ({
    objectiveId,
    title: "Objective demo",
    status: "completed",
    phase: "completed",
    latestSummary: "Archived.",
    integration: { status: "idle", queuedCandidateIds: [] },
  }),
  ...overrides,
});

const enqueueRunningFactoryTaskJob = async (queue: ReturnType<typeof jsonlQueue>, input: {
  readonly jobId: string;
  readonly objectiveId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly runId?: string;
}): Promise<QueueJob> => {
  const created = await queue.enqueue({
    jobId: input.jobId,
    agentId: "codex",
    lane: "collect",
    sessionKey: `factory-task:${input.objectiveId}:${input.taskId}:${input.candidateId}`,
    singletonMode: "allow",
    maxAttempts: 1,
    payload: {
      kind: "factory.task.run",
      objectiveId: input.objectiveId,
      taskId: input.taskId,
      candidateId: input.candidateId,
      parentRunId: input.runId,
      stream: "agents/factory/demo",
    },
  });
  const leased = await queue.leaseNext({ workerId: "tester", leaseMs: 30_000, agentId: "codex" });
  if (!leased || leased.id !== created.id) throw new Error("failed to lease queued codex task job");
  return leased;
};

const makeSupervisorObjectiveDetail = (input: {
  readonly objectiveId: string;
  readonly objectiveMode?: "delivery" | "investigation";
  readonly tasks: ReadonlyArray<Record<string, unknown>>;
  readonly latestSummary?: string;
}) => ({
  objectiveId: input.objectiveId,
  title: "Objective demo",
  status: "active",
  phase: "executing",
  objectiveMode: input.objectiveMode ?? "delivery",
  severity: 2,
  latestSummary: input.latestSummary ?? "Objective work is in progress.",
  nextAction: "Wait for the active task to finish.",
  integration: {
    status: "idle",
    queuedCandidateIds: [],
  },
  latestDecision: {
    summary: "Focus on the current frontier task.",
    at: Date.now(),
    source: "runtime",
  },
  blockedExplanation: undefined,
  evidenceCards: [],
  tasks: input.tasks,
});

const createAgentRuntime = (dataDir: string) =>
  createRuntime<AgentCmd, AgentEvent, AgentState>(
    jsonlStore<AgentEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideAgent,
    reduceAgent,
    initialAgent,
  );

const createJobRuntime = (dataDir: string) =>
  createRuntime<JobCmd, JobEvent, JobState>(
    jsonlStore<JobEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideJob,
    reduceJob,
    initialJob,
  );

const emitIndexedAgentEvent = async (
  runtime: ReturnType<typeof createAgentRuntime>,
  sessionStream: string,
  runId: string,
  event: AgentEvent,
): Promise<void> => {
  const runStream = agentRunStream(sessionStream, runId);
  await runtime.execute(runStream, {
    type: "emit",
    event,
    eventId: `${runStream}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
  });
  await runtime.execute(sessionStream, {
    type: "emit",
    event,
    eventId: `${sessionStream}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
  });
};

const runGit = (repoRoot: string, args: ReadonlyArray<string>): void => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
  }
};

const createGitRepo = async (label: string): Promise<string> => {
  const repoRoot = await createTempDir(label);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# demo\n", "utf-8");
  runGit(repoRoot, ["init"]);
  runGit(repoRoot, ["config", "user.email", "codex@example.com"]);
  runGit(repoRoot, ["config", "user.name", "Codex"]);
  runGit(repoRoot, ["add", "README.md"]);
  runGit(repoRoot, ["commit", "-m", "init"]);
  return repoRoot;
};

const writeProfile = async (root: string, input: {
  readonly id: string;
  readonly label: string;
  readonly default?: boolean;
  readonly capabilities?: ReadonlyArray<string>;
  readonly toolAllowlist?: ReadonlyArray<string>;
  readonly actionPolicy?: {
    readonly allowedDispatchActions?: ReadonlyArray<"create" | "react" | "promote" | "cancel" | "cleanup" | "archive">;
    readonly allowedCreateModes?: ReadonlyArray<"delivery" | "investigation">;
  };
  readonly handoffTargets?: ReadonlyArray<string>;
  readonly mode?: "interactive" | "supervisor";
  readonly discoveryBudget?: number;
  readonly suspendOnAsyncChild?: boolean;
  readonly allowPollingWhileChildRunning?: boolean;
  readonly finalWhileChildRunning?: "allow" | "waiting_message" | "reject";
  readonly childDedupe?: "none" | "by_run_and_prompt";
  readonly orchestration?: {
    readonly executionMode?: "interactive" | "supervisor";
    readonly discoveryBudget?: number;
    readonly suspendOnAsyncChild?: boolean;
    readonly allowPollingWhileChildRunning?: boolean;
    readonly finalWhileChildRunning?: "allow" | "waiting_message" | "reject";
    readonly childDedupe?: "none" | "by_run_and_prompt";
  };
}): Promise<void> => {
  const dir = path.join(root, "profiles", input.id);
  await fs.mkdir(dir, { recursive: true });
  const defaultActionPolicy = input.id === "software"
    ? {
      allowedDispatchActions: ["create", "react", "promote", "cancel", "cleanup", "archive"] as const,
      allowedCreateModes: ["delivery"] as const,
    }
    : input.id === "infrastructure"
      ? {
        allowedDispatchActions: ["create", "react", "cancel", "cleanup", "archive"] as const,
        allowedCreateModes: ["investigation"] as const,
      }
      : input.id === "qa"
        ? {
          allowedDispatchActions: ["create", "react", "cancel", "cleanup", "archive"] as const,
          allowedCreateModes: ["delivery"] as const,
        }
        : {
          allowedDispatchActions: ["create", "react", "cancel", "cleanup", "archive"] as const,
          allowedCreateModes: ["delivery", "investigation"] as const,
        };
  const manifest = {
    id: input.id,
    label: input.label,
    default: input.default ?? false,
    skills: [],
    handoffTargets: input.handoffTargets ?? [],
    actionPolicy: input.actionPolicy ?? defaultActionPolicy,
    defaultObjectiveMode: input.id === "infrastructure" ? "investigation" : "delivery",
    defaultValidationMode: input.id === "infrastructure" ? "none" : "repo_profile",
    allowObjectiveCreation: true,
    orchestration: {
      executionMode: input.orchestration?.executionMode ?? input.mode,
      discoveryBudget: input.orchestration?.discoveryBudget ?? input.discoveryBudget,
      suspendOnAsyncChild: input.orchestration?.suspendOnAsyncChild ?? input.suspendOnAsyncChild,
      allowPollingWhileChildRunning: input.orchestration?.allowPollingWhileChildRunning ?? input.allowPollingWhileChildRunning,
      finalWhileChildRunning: input.orchestration?.finalWhileChildRunning ?? input.finalWhileChildRunning,
      childDedupe: input.orchestration?.childDedupe ?? input.childDedupe,
    },
  };
  await fs.writeFile(
    path.join(dir, "PROFILE.md"),
    `---\n${JSON.stringify(manifest, null, 2)}\n---\n\n# ${input.label}\n\nUse the available Factory tools.\n`,
    "utf-8",
  );
};

test("factory chat runner: codex.run queues work asynchronously and returns immediately", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-codex");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["codex.run"],
  });

  const actions = [
    {
      thought: "queue codex",
      action: {
        type: "tool",
        name: "codex.run",
        input: JSON.stringify({ prompt: "Inspect the repo and report status." }),
        text: null,
      },
    },
    {
      thought: "respond to operator",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Queued Codex. Ask for status while it runs.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_async_codex",
    problem: "Inspect the repo and report status.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: {} as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  expect(result.finalResponse).toContain("Queued Codex");

  const jobs = await queue.listJobs({ limit: 10 });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.agentId).toBe("codex");
  expect(jobs[0]?.status).toBe("queued");
  expect(jobs[0]?.singletonMode).toBe("allow");

  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_async_codex"));
  const observed = chain.find((receipt) => receipt.body.type === "tool.observed")?.body;
  expect(observed && "output" in observed ? observed.output : "").toContain('"status": "queued"');
  expect(observed && "output" in observed ? observed.output : "").toContain('"jobId":');
  expect(observed && "output" in observed ? observed.output : "").toContain("codex read-only probe queued as");
});

test("factory chat runner: codex.run reuses the active codex probe for the same chat context", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-codex-reuse");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["codex.run"],
  });

  const existing = await queue.enqueue({
    agentId: "codex",
    lane: "collect",
    sessionKey: "codex:existing",
    singletonMode: "allow",
    maxAttempts: 1,
    payload: {
      kind: "factory.codex.run",
      parentRunId: "run_async_codex_reuse",
      parentStream: "agents/factory/demo",
      stream: "agents/factory/demo",
      profileId: "generalist",
      mode: "read_only_probe",
      readOnly: true,
      prompt: "Inspect the earlier evidence only.",
      task: "Inspect the earlier evidence only.",
    },
  });

  const actions = [
    {
      thought: "reuse existing codex work",
      action: {
        type: "tool",
        name: "codex.run",
        input: JSON.stringify({ prompt: "Inspect the blocked objective and summarize it." }),
        text: null,
      },
    },
    {
      thought: "respond to operator",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Reused the active Codex probe.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_async_codex_reuse",
    problem: "Inspect the blocked objective and summarize it.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: {} as never,
    repoRoot,
    profileRoot,
    dataDir,
  });

  expect(result.status).toBe("completed");
  expect(result.finalResponse).toContain("Reused the active Codex probe.");

  const jobs = await queue.listJobs({ limit: 10 });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.id).toBe(existing.id);

  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_async_codex_reuse"));
  const observed = chain.find((receipt) => receipt.body.type === "tool.observed")?.body;
  expect(observed && "output" in observed ? observed.output : "").toContain(`reusing active codex probe ${existing.id}`);
});

test("factory chat runner: codex.status reports live codex work for the current run", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-codex-status");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    default: true,
    capabilities: ["async.dispatch", "status.read"],
    mode: "supervisor",
    suspendOnAsyncChild: true,
    allowPollingWhileChildRunning: true,
    finalWhileChildRunning: "waiting_message",
  });

  const actions = [
    {
      thought: "queue codex",
      action: {
        type: "tool",
        name: "codex.run",
        input: JSON.stringify({ prompt: "Inspect the failing sidebar flow." }),
        text: null,
      },
    },
    {
      thought: "check codex status",
      action: {
        type: "tool",
        name: "codex.status",
        input: "{}",
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Codex is still running; keep this thread open for updates.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_codex_status",
    problem: "Check Codex progress.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: createFactoryServiceStub() as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_codex_status"));
  const statusObservation = chain.find((receipt) => receipt.body.type === "tool.observed" && receipt.body.tool === "codex.status")?.body;
  expect(statusObservation && "output" in statusObservation ? statusObservation.output : "").toContain('"worker": "codex"');
  expect(statusObservation && "output" in statusObservation ? statusObservation.output : "").toContain('"activeCount": 1');
  expect(statusObservation && "output" in statusObservation ? statusObservation.output : "").toContain('"status": "queued"');
});

test("factory chat runner: status.read tools expose codex logs, objective status, receipts, and live output", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-status-tools");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    default: true,
    capabilities: ["status.read", "async.dispatch"],
    mode: "supervisor",
    allowPollingWhileChildRunning: true,
  });

  const actions = [
    {
      thought: "queue codex probe",
      action: {
        type: "tool",
        name: "codex.run",
        input: JSON.stringify({ prompt: "Inspect the current repo state only." }),
        text: null,
      },
    },
    {
      thought: "inspect codex artifacts",
      action: {
        type: "tool",
        name: "codex.logs",
        input: "{}",
        text: null,
      },
    },
    {
      thought: "inspect objective status",
      action: {
        type: "tool",
        name: "factory.status",
        input: "{}",
        text: null,
      },
    },
    {
      thought: "inspect receipt evidence",
      action: {
        type: "tool",
        name: "factory.receipts",
        input: JSON.stringify({ limit: 4 }),
        text: null,
      },
    },
    {
      thought: "inspect live output",
      action: {
        type: "tool",
        name: "factory.output",
        input: JSON.stringify({ focusKind: "job", focusId: "job_live_demo" }),
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Collected the current receipts, logs, and live output.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_status_tools",
    problem: "Inspect the current objective evidence.",
    profileId: "software",
    objectiveId: "objective_demo",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    dataDir,
    factoryService: createFactoryServiceStub({
      getObjective: async (objectiveId: string) => ({
        objectiveId,
        title: "Objective demo",
        status: "active",
        phase: "executing",
        objectiveMode: "delivery",
        severity: 2,
        latestSummary: "Investigating the sidebar objective.",
        nextAction: "React the current objective.",
        integration: {
          status: "idle",
          queuedCandidateIds: [],
        },
        latestDecision: {
          summary: "Inspect the current candidate before reacting.",
          at: Date.now(),
          source: "runtime",
        },
        blockedExplanation: undefined,
        evidenceCards: [{
          kind: "decision",
          title: "Latest decision",
          summary: "Inspect the current candidate before reacting.",
          at: Date.now(),
          receiptType: "rebracket.applied",
        }],
        tasks: [],
        contextSources: {
          sharedArtifactRefs: [
            { kind: "artifact", ref: "/tmp/helpers/aws_resource_inventory/manifest.json", label: "checked-in helper manifest" },
            { kind: "artifact", ref: "/tmp/helpers/aws_resource_inventory/run.py", label: "checked-in helper entrypoint" },
          ],
        },
      }),
    }) as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_status_tools"));
  const observations = chain.filter((receipt) => receipt.body.type === "tool.observed").map((receipt) => receipt.body);
  expect(observations.find((event) => event.tool === "codex.logs" && "output" in event)?.output ?? "").toContain('"artifacts"');
  expect(observations.find((event) => event.tool === "factory.status" && "output" in event)?.output ?? "").toContain('"latestDecision"');
  expect(observations.find((event) => event.tool === "factory.status" && "output" in event)?.output ?? "").toContain('"availableHelperEntrypoints"');
  expect(observations.find((event) => event.tool === "factory.status" && "output" in event)?.output ?? "").toContain('/tmp/helpers/aws_resource_inventory/run.py');
  expect(observations.find((event) => event.tool === "factory.receipts" && "output" in event)?.output ?? "").toContain('"receipts"');
  expect(observations.find((event) => event.tool === "factory.output" && "output" in event)?.output ?? "").toContain('Streaming live output.');
});

test("factory chat runner: default live objective policy preserves the operator response while a live objective is still running", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-objective-finalizer");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  const objectiveId = "objective_live_finalizer";
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["factory.output"],
  });

  const actions = [
    {
      thought: "inspect the live objective output",
      action: {
        type: "tool",
        name: "factory.output",
        input: JSON.stringify({ objectiveId, taskId: "task_01" }),
        text: null,
      },
    },
    {
      thought: "incorrectly claim success",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Everything is already complete and healthy.",
      },
    },
  ];

  const service = createFactoryServiceStub({
    getObjective: async () => makeSupervisorObjectiveDetail({
      objectiveId,
      objectiveMode: "investigation",
      latestSummary: "Live evidence collection is still running.",
      tasks: [{
        taskId: "task_01",
        title: "Collect live AWS evidence",
        prompt: "Collect live AWS evidence",
        status: "running",
        workerType: "infra",
        dependsOn: [],
        candidateId: "candidate_01",
      }],
    }),
    getObjectiveLiveOutput: async () => ({
      objectiveId,
      focusKind: "task",
      focusId: "task_01",
      title: "Collect live AWS evidence",
      status: "running",
      active: true,
      summary: "Streaming live output.",
      stdoutTail: "aws helper is still collecting evidence",
    }),
  });

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_objective_live_finalizer",
    problem: "Monitor the live investigation.",
    objectiveId,
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: service as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  expect(result.finalResponse).toContain("Everything is already complete and healthy.");
  expect(result.finalResponse).not.toContain("Work is still running in this chat.");
});

test("factory chat runner: live objective waiting-message policy rewrites premature completion text", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-objective-waiting-message");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  const objectiveId = "objective_live_waiting_message";
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["factory.output"],
    finalWhileChildRunning: "waiting_message",
  });

  const actions = [
    {
      thought: "inspect the live objective output",
      action: {
        type: "tool",
        name: "factory.output",
        input: JSON.stringify({ objectiveId, taskId: "task_01" }),
        text: null,
      },
    },
    {
      thought: "incorrectly claim success",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Everything is already complete and healthy.",
      },
    },
  ];

  const service = createFactoryServiceStub({
    getObjective: async () => makeSupervisorObjectiveDetail({
      objectiveId,
      objectiveMode: "investigation",
      latestSummary: "Live evidence collection is still running.",
      tasks: [{
        taskId: "task_01",
        title: "Collect live AWS evidence",
        prompt: "Collect live AWS evidence",
        status: "running",
        workerType: "infra",
        dependsOn: [],
        candidateId: "candidate_01",
      }],
    }),
    getObjectiveLiveOutput: async () => ({
      objectiveId,
      focusKind: "task",
      focusId: "task_01",
      title: "Collect live AWS evidence",
      status: "running",
      active: true,
      summary: "Streaming live output.",
      stdoutTail: "aws helper is still collecting evidence",
    }),
  });

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_objective_live_waiting_message",
    problem: "Monitor the live investigation.",
    objectiveId,
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: service as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  expect(result.finalResponse).toContain("Work is still running in this chat.");
  expect(result.finalResponse).toContain("Objective demo is active");
  expect(result.finalResponse).toContain("Live evidence collection is still running.");
  expect(result.finalResponse).not.toContain("already complete and healthy");
});

test("factory chat runner: active supervisor only monitors healthy objective-backed codex work", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-supervisor-healthy");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  const objectiveId = "objective_supervisor_healthy";
  const taskId = "task_01";
  const candidateId = "candidate_01";
  const job = await enqueueRunningFactoryTaskJob(queue, {
    jobId: "job_supervisor_healthy",
    objectiveId,
    taskId,
    candidateId,
  });
  let liveTick = 0;
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    default: true,
    capabilities: ["status.read"],
    mode: "supervisor",
    allowPollingWhileChildRunning: true,
    finalWhileChildRunning: "allow",
  });

  const actions = [
    {
      thought: "wait on the active objective",
      action: {
        type: "tool",
        name: "factory.status",
        input: JSON.stringify({ objectiveId, waitForChangeMs: 220 }),
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "The objective is still running.",
      },
    },
  ];

  const service = createFactoryServiceStub({
    getObjective: async () => makeSupervisorObjectiveDetail({
      objectiveId,
      tasks: [{
        taskId,
        title: "Validate inventory",
        prompt: "Validate inventory",
        status: "running",
        workerType: "codex",
        dependsOn: [],
        candidateId,
        jobId: job.id,
      }],
    }),
    getObjectiveDebug: async () => ({
      activeJobs: [job],
      taskWorktrees: [],
      integrationWorktree: undefined,
      latestContextPacks: [],
    }),
    getObjectiveLiveOutput: async () => ({
      objectiveId,
      focusKind: "task",
      focusId: taskId,
      title: "Validate inventory",
      status: "running",
      active: true,
      summary: "Streaming live output.",
      taskId,
      candidateId,
      jobId: job.id,
      lastMessage: `progress-${++liveTick}`,
      stdoutTail: `stdout-${liveTick}`,
      stderrTail: "",
    }),
  });

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_supervisor_healthy",
    problem: "Keep an eye on the running objective.",
    profileId: "software",
    objectiveId,
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: service as never,
    repoRoot,
    profileRoot,
    extraConfig: {
      supervisor: {
        pollMs: 20,
        steerAfterMs: 80,
        abortAfterMs: 180,
      },
    },
  });

  expect(result.status).toBe("completed");
  const refreshed = await queue.getJob(job.id);
  expect(refreshed?.commands).toHaveLength(0);
});

test("factory chat runner: active supervisor steers a stalled objective-backed codex task once without duplicates", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-supervisor-steer");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  const objectiveId = "objective_supervisor_steer";
  const taskId = "task_03";
  const candidateId = "candidate_03";
  const job = await enqueueRunningFactoryTaskJob(queue, {
    jobId: "job_supervisor_steer",
    objectiveId,
    taskId,
    candidateId,
  });
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    default: true,
    capabilities: ["status.read"],
    mode: "supervisor",
    allowPollingWhileChildRunning: true,
    finalWhileChildRunning: "allow",
  });

  const actions = [
    {
      thought: "wait on the active objective",
      action: {
        type: "tool",
        name: "factory.status",
        input: JSON.stringify({ objectiveId, waitForChangeMs: 240 }),
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "The objective is still running.",
      },
    },
  ];

  const service = createFactoryServiceStub({
    getObjective: async () => makeSupervisorObjectiveDetail({
      objectiveId,
      tasks: [{
        taskId,
        title: "Validate cost-driver inventory",
        prompt: "Validate cost-driver inventory",
        status: "running",
        workerType: "codex",
        dependsOn: [],
        candidateId,
        jobId: job.id,
      }, {
        taskId: "task_04",
        title: "Synthesize consumption insights and recommendations",
        prompt: "Synthesize consumption insights and recommendations",
        status: "pending",
        workerType: "codex",
        dependsOn: [taskId],
      }],
    }),
    getObjectiveDebug: async () => ({
      activeJobs: [job],
      taskWorktrees: [],
      integrationWorktree: undefined,
      latestContextPacks: [],
    }),
    getObjectiveLiveOutput: async () => ({
      objectiveId,
      focusKind: "task",
      focusId: taskId,
      title: "Validate cost-driver inventory",
      status: "running",
      active: true,
      summary: "Still waiting on the same task output.",
      taskId,
      candidateId,
      jobId: job.id,
      lastMessage: "no progress yet",
      stdoutTail: "no progress yet",
      stderrTail: "",
    }),
  });

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_supervisor_steer",
    problem: "Supervise the running infrastructure task.",
    profileId: "software",
    objectiveId,
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: service as never,
    repoRoot,
    profileRoot,
    extraConfig: {
      supervisor: {
        pollMs: 20,
        steerAfterMs: 60,
        abortAfterMs: 500,
      },
    },
  });

  expect(result.status).toBe("completed");
  const refreshed = await queue.getJob(job.id);
  const commands = refreshed?.commands.filter((command) => command.command === "steer") ?? [];
  expect(commands).toHaveLength(1);
  expect(commands[0]?.payload.problem).toContain("Focus only on task_03: Validate cost-driver inventory.");
  expect(commands[0]?.payload.problem).toContain("task_04 (Synthesize consumption insights and recommendations)");
});

test("factory chat runner: active supervisor follows up on historical infrastructure-style access gaps instead of spinning", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-supervisor-follow-up");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  const objectiveId = historicalInfrastructureObjectiveId;
  const taskId = "task_03";
  const candidateId = "task_03_candidate_02";
  const job = await enqueueRunningFactoryTaskJob(queue, {
    jobId: "job_supervisor_follow_up",
    objectiveId,
    taskId,
    candidateId,
  });
  await writeProfile(profileRoot, {
    id: "infrastructure",
    label: "Infrastructure",
    default: true,
    capabilities: ["status.read"],
    mode: "supervisor",
    allowPollingWhileChildRunning: true,
    finalWhileChildRunning: "allow",
  });

  const actions = [
    {
      thought: "wait on the active objective",
      action: {
        type: "tool",
        name: "factory.status",
        input: JSON.stringify({ objectiveId, waitForChangeMs: 220 }),
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "The objective is still running.",
      },
    },
  ];

  const service = createFactoryServiceStub({
    listObjectiveReceipts: async () =>
      historicalInfrastructureObjectiveReceipts.map((receipt, index) => ({
        type: receipt.type,
        hash: `historical_${index}`,
        ts: "createdAt" in receipt
          ? receipt.createdAt
          : "startedAt" in receipt
            ? receipt.startedAt
            : "completedAt" in receipt
              ? receipt.completedAt
              : Date.now(),
        summary: receipt.type,
      })),
    getObjective: async () => makeSupervisorObjectiveDetail({
      objectiveId,
      objectiveMode: "investigation",
      tasks: [{
        taskId,
        title: "Resource-side validation inventory for key spend services",
        prompt: "Inspect key spend services and note access gaps.",
        status: "running",
        workerType: "codex",
        dependsOn: [],
        candidateId,
        jobId: job.id,
      }, {
        taskId: "task_04",
        title: "Synthesize consumption insights and actionable recommendations",
        prompt: "Summarize the findings.",
        status: "pending",
        workerType: "codex",
        dependsOn: [taskId],
      }],
    }),
    getObjectiveDebug: async () => ({
      activeJobs: [job],
      taskWorktrees: [],
      integrationWorktree: undefined,
      latestContextPacks: [],
    }),
    getObjectiveLiveOutput: async () => ({
      objectiveId,
      focusKind: "task",
      focusId: taskId,
      title: "Resource-side validation inventory for key spend services",
      status: "running",
      active: true,
      summary: "Inventory is incomplete because ELB access is denied.",
      taskId,
      candidateId,
      jobId: job.id,
      lastMessage: "DescribeLoadBalancers failed with AccessDenied.",
      stdoutTail: "",
      stderrTail: "User is not authorized to perform: elasticloadbalancing:DescribeLoadBalancers",
    }),
  });

  const result = await runFactoryChat({
    stream: "agents/factory/historical-infra-loop",
    runId: "run_supervisor_follow_up",
    problem: "Supervise the historical infrastructure follow-up.",
    profileId: "infrastructure",
    objectiveId,
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: service as never,
    repoRoot,
    profileRoot,
    extraConfig: {
      supervisor: {
        pollMs: 20,
        steerAfterMs: 500,
        abortAfterMs: 800,
      },
    },
  });

  expect(result.status).toBe("completed");
  const refreshed = await queue.getJob(job.id);
  const followUps = refreshed?.commands.filter((command) => command.command === "follow_up") ?? [];
  expect(followUps).toHaveLength(1);
  expect(followUps[0]?.payload.note).toContain("partial investigation report");
  expect(followUps[0]?.payload.note).toContain("exact denied services/actions");
  expect(followUps[0]?.payload.note).toContain("task_04 (Synthesize consumption insights and actionable recommendations)");
});

test("factory chat runner: active supervisor aborts a repeatedly stalled child and re-enters objective control", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-supervisor-abort");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  const objectiveId = "objective_supervisor_abort";
  const taskId = "task_03";
  const candidateId = "candidate_03";
  const job = await enqueueRunningFactoryTaskJob(queue, {
    jobId: "job_supervisor_abort",
    objectiveId,
    taskId,
    candidateId,
  });
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    default: true,
    capabilities: ["status.read"],
    mode: "supervisor",
    allowPollingWhileChildRunning: true,
    finalWhileChildRunning: "allow",
  });

  let reactCalls = 0;
  setTimeout(() => {
    void queue.cancel(job.id, "simulate supervisor-handled worker stop", "test");
  }, 320);

  const actions = [
    {
      thought: "wait on the active objective",
      action: {
        type: "tool",
        name: "factory.status",
        input: JSON.stringify({ objectiveId, waitForChangeMs: 520 }),
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "The objective is still running.",
      },
    },
  ];

  const service = createFactoryServiceStub({
    getObjective: async () => makeSupervisorObjectiveDetail({
      objectiveId,
      tasks: [{
        taskId,
        title: "Validate cost-driver inventory",
        prompt: "Validate cost-driver inventory",
        status: "running",
        workerType: "codex",
        dependsOn: [],
        candidateId,
        jobId: job.id,
      }, {
        taskId: "task_04",
        title: "Synthesize consumption insights and recommendations",
        prompt: "Synthesize consumption insights and recommendations",
        status: "pending",
        workerType: "codex",
        dependsOn: [taskId],
      }],
    }),
    getObjectiveDebug: async () => ({
      activeJobs: [job],
      taskWorktrees: [],
      integrationWorktree: undefined,
      latestContextPacks: [],
    }),
    getObjectiveLiveOutput: async () => ({
      objectiveId,
      focusKind: "task",
      focusId: taskId,
      title: "Validate cost-driver inventory",
      status: "running",
      active: true,
      summary: "Still waiting on the same task output.",
      taskId,
      candidateId,
      jobId: job.id,
      lastMessage: "no progress yet",
      stdoutTail: "no progress yet",
      stderrTail: "",
    }),
    reactObjective: async () => {
      reactCalls += 1;
      return undefined;
    },
  });

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_supervisor_abort",
    problem: "Supervise the stalled child until it is aborted.",
    profileId: "software",
    objectiveId,
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: service as never,
    repoRoot,
    profileRoot,
    extraConfig: {
      supervisor: {
        pollMs: 20,
        steerAfterMs: 120,
        abortAfterMs: 220,
      },
    },
  });

  expect(result.status).toBe("completed");
  const refreshed = await queue.getJob(job.id);
  expect(refreshed?.commands.filter((command) => command.command === "steer")).toHaveLength(1);
  expect(refreshed?.commands.filter((command) => command.command === "abort")).toHaveLength(1);
  expect(reactCalls).toBeGreaterThan(0);
});

test("factory chat runner: agent.delegate queues work and agent.status sees the queued job", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-delegate");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["agent.delegate", "agent.status"],
  });

  let delegatedJobId = "";
  const actions = [
    async () => ({
      thought: "queue delegate",
      action: {
        type: "tool",
        name: "agent.delegate",
        input: JSON.stringify({ agentId: "writer", task: "Summarize the current objective." }),
        text: null,
      },
    }),
    async () => {
      const jobs = await queue.listJobs({ limit: 10 });
      delegatedJobId = jobs[0]?.id ?? delegatedJobId;
      return {
        thought: "inspect queued child",
        action: {
          type: "tool",
          name: "agent.status",
          input: JSON.stringify({ jobId: delegatedJobId }),
          text: null,
        },
      };
    },
    async () => ({
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "The writer subagent is queued and ready to run.",
      },
    }),
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_async_delegate",
    problem: "Use a writer subagent.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const nextFactory = actions.shift();
      if (!nextFactory) throw new Error("no scripted action left");
      const next = await nextFactory();
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: {} as never,
    repoRoot,
    profileRoot,
    broadcast: async () => {
      const jobs = await queue.listJobs({ limit: 10 });
      delegatedJobId = jobs[0]?.id ?? delegatedJobId;
    },
  });

  expect(result.status).toBe("completed");
  expect(result.finalResponse).toContain("queued");

  const jobs = await queue.listJobs({ limit: 10 });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.agentId).toBe("writer");
  expect(jobs[0]?.status).toBe("queued");

  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_async_delegate"));
  const observations = chain.filter((receipt) => receipt.body.type === "tool.observed").map((receipt) => receipt.body);
  expect(observations.some((event) => "output" in event && event.output.includes('"status": "queued"'))).toBe(true);
});

test("factory chat runner: profile.handoff queues continuation work on the target profile", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-handoff");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["profile.handoff"],
    handoffTargets: ["software"],
  });
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    toolAllowlist: ["codex.run"],
  });

  const actions = [
    {
      thought: "handoff to software",
      action: {
        type: "tool",
        name: "profile.handoff",
        input: JSON.stringify({
          profileId: "software",
          reason: "Ship the repo fix.",
          goal: "Implement and verify the sidebar fix.",
          currentState: "Triage isolated the issue to the current sidebar work.",
          doneWhen: "The fix is landed with validation evidence.",
          evidence: ["objective_demo", "latest receipt reviewed"],
          blockers: ["No code change exists yet"],
        }),
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Queued the software profile.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_async_handoff",
    problem: "Fix the UI bug in the sidebar.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: {} as never,
    repoRoot,
    profileRoot,
    objectiveId: "objective_demo",
  });

  expect(result.status).toBe("completed");
  const jobs = await queue.listJobs({ limit: 10 });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.agentId).toBe("factory");
  expect(jobs[0]?.payload.profileId).toBe("software");
  expect(jobs[0]?.payload.objectiveId).toBe("objective_demo");
  expect(jobs[0]?.payload.stream).toBeTruthy();
  expect(String(jobs[0]?.payload.stream)).toContain("/objectives/objective_demo");
  expect(String(jobs[0]?.payload.problem)).toContain("Engineer handoff from generalist to software.");
  expect(String(jobs[0]?.payload.problem)).toContain("Reason: Ship the repo fix.");
  expect(String(jobs[0]?.payload.problem)).toContain("Goal: Implement and verify the sidebar fix.");
  expect(String(jobs[0]?.payload.problem)).toContain("Current state: Triage isolated the issue to the current sidebar work.");
  expect(String(jobs[0]?.payload.problem)).toContain("Done when: The fix is landed with validation evidence.");
  expect(String(jobs[0]?.payload.problem)).toContain("Evidence:");
  expect(String(jobs[0]?.payload.problem)).toContain("Blockers:");

  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_async_handoff"));
  const handoffEvent = chain.find((receipt) => receipt.body.type === "profile.handoff")?.body;
  expect(handoffEvent?.type).toBe("profile.handoff");
  expect(handoffEvent?.toProfileId).toBe("software");
  expect(handoffEvent?.goal).toBe("Implement and verify the sidebar fix.");
  expect(handoffEvent?.currentState).toBe("Triage isolated the issue to the current sidebar work.");
  expect(handoffEvent?.doneWhen).toBe("The fix is landed with validation evidence.");
  expect(handoffEvent?.evidence).toEqual(["objective_demo", "latest receipt reviewed"]);
  expect(handoffEvent?.blockers).toEqual(["No code change exists yet"]);
  expect(handoffEvent && "nextJobId" in handoffEvent ? handoffEvent.nextJobId : undefined).toBe(jobs[0]?.id);
  const observed = chain.find((receipt) => receipt.body.type === "tool.observed")?.body;
  expect(observed && "output" in observed ? observed.output : "").toContain('"toProfileId": "software"');
  expect(observed && "output" in observed ? observed.output : "").toContain('"goal": "Implement and verify the sidebar fix."');
});

test("factory chat runner: profile.handoff requires a structured engineer handoff", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-handoff-required");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Tech Lead",
    default: true,
    toolAllowlist: ["profile.handoff"],
    handoffTargets: ["software"],
  });
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software Engineer",
  });

  const actions = [
    {
      thought: "attempt an incomplete handoff",
      action: {
        type: "tool",
        name: "profile.handoff",
        input: JSON.stringify({
          profileId: "software",
          reason: "Ship the repo fix.",
        }),
        text: null,
      },
    },
    {
      thought: "reply",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Handoff validation failed.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_handoff_requires_structure",
    problem: "Fix the UI bug in the sidebar.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: {} as never,
    repoRoot,
    profileRoot,
    objectiveId: "objective_demo",
  });

  expect(result.status).toBe("completed");
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_handoff_requires_structure"));
  const errorCall = chain.find((receipt) =>
    receipt.body.type === "tool.called"
    && receipt.body.tool === "profile.handoff"
    && typeof receipt.body.error === "string"
  )?.body;
  expect(errorCall && "error" in errorCall ? errorCall.error : "").toContain("profile.handoff requires goal");
});

test("factory chat runner: agent.status rejects the current factory job id", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-self-status");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["agent.status"],
  });

  const actions = [
    {
      thought: "incorrectly poll self",
      action: {
        type: "tool",
        name: "agent.status",
        input: JSON.stringify({ jobId: "job_parent_demo" }),
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Handled the invalid self-status call.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_self_status_guard",
    problem: "Check the child job.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: {} as never,
    repoRoot,
    profileRoot,
    control: {
      jobId: "job_parent_demo",
      checkAbort: async () => false,
      pullCommands: async () => [],
    },
  });

  expect(result.status).toBe("completed");
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_self_status_guard"));
  const errorCall = chain.find((receipt) =>
    receipt.body.type === "tool.called"
    && receipt.body.tool === "agent.status"
    && typeof receipt.body.error === "string"
  )?.body;
  expect(errorCall && "error" in errorCall ? errorCall.error : "").toContain("cannot target the current factory job");
});

test("factory chat runner: software profile rejects a third discovery step before delivery starts", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-discovery-budget");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    default: true,
    toolAllowlist: ["jobs.list", "codex.run"],
    orchestration: {
      executionMode: "supervisor",
      discoveryBudget: 2,
      suspendOnAsyncChild: true,
      allowPollingWhileChildRunning: false,
      finalWhileChildRunning: "waiting_message",
      childDedupe: "by_run_and_prompt",
    },
  });

  const actions = [
    {
      thought: "inspect jobs once",
      action: {
        type: "tool",
        name: "jobs.list",
        input: JSON.stringify({ limit: 5 }),
        text: null,
      },
    },
    {
      thought: "inspect jobs twice",
      action: {
        type: "tool",
        name: "jobs.list",
        input: JSON.stringify({ limit: 5 }),
        text: null,
      },
    },
    {
      thought: "incorrectly inspect jobs a third time",
      action: {
        type: "tool",
        name: "jobs.list",
        input: JSON.stringify({ limit: 5 }),
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Stopping after the discovery-budget guard fired.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_software_discovery_budget",
    problem: "Fix the sidebar overflow.",
    profileId: "software",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: {} as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_software_discovery_budget"));
  const errorCall = chain.find((receipt) =>
    receipt.body.type === "tool.called"
    && receipt.body.tool === "jobs.list"
    && typeof receipt.body.error === "string"
  )?.body;
  expect(errorCall && "error" in errorCall ? errorCall.error : "").toContain("Profile discovery budget exhausted");
});

test("factory chat runner: blocking monitor polls do not consume discovery budget while a child is running", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-monitor-budget");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    default: true,
    toolAllowlist: ["codex.run", "factory.status", "factory.output"],
    orchestration: {
      executionMode: "supervisor",
      discoveryBudget: 1,
      suspendOnAsyncChild: false,
      allowPollingWhileChildRunning: true,
      finalWhileChildRunning: "allow",
      childDedupe: "by_run_and_prompt",
    },
  });

  const actions = [
    {
      thought: "queue codex work",
      action: {
        type: "tool",
        name: "codex.run",
        input: JSON.stringify({ prompt: "Inspect the current repo state only." }),
        text: null,
      },
    },
    {
      thought: "wait on objective status without spending more discovery budget",
      action: {
        type: "tool",
        name: "factory.status",
        input: JSON.stringify({ waitForChangeMs: 60 }),
        text: null,
      },
    },
    {
      thought: "wait on live output without spending more discovery budget",
      action: {
        type: "tool",
        name: "factory.output",
        input: JSON.stringify({ focusKind: "job", focusId: "job_live_demo", waitForChangeMs: 60 }),
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "I kept watching the live child output without tripping the discovery guard.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_software_monitor_budget",
    problem: "Inspect the current objective evidence.",
    profileId: "software",
    objectiveId: "objective_demo",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    dataDir,
    factoryService: createFactoryServiceStub() as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  expect(result.finalResponse).toContain("without tripping the discovery guard");

  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_software_monitor_budget"));
  const budgetError = chain.find((receipt) =>
    receipt.body.type === "tool.called"
    && typeof receipt.body.error === "string"
    && receipt.body.error.includes("Profile discovery budget exhausted")
  )?.body;
  expect(budgetError).toBeUndefined();

  const observations = chain.filter((receipt) => receipt.body.type === "tool.observed").map((receipt) => receipt.body);
  expect(observations.find((event) => event.tool === "factory.status" && "output" in event)?.output ?? "").toContain('"waitedMs"');
  expect(observations.find((event) => event.tool === "factory.output" && "output" in event)?.output ?? "").toContain('"waitedMs"');
});

test("factory chat runner: first factory.output wait is short before later waits use the full budget", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-live-wait");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  const objectiveId = "objective_live_wait";
  const taskId = "task_live_wait";
  let firstOutputSnapshotAt: number | undefined;
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    default: true,
  });

  const actions = [
    {
      thought: "surface the first live snapshot quickly",
      action: {
        type: "tool",
        name: "factory.output",
        input: JSON.stringify({ objectiveId, taskId, waitForChangeMs: 500 }),
        text: null,
      },
    },
    {
      thought: "now wait for the task to finish",
      action: {
        type: "tool",
        name: "factory.output",
        input: JSON.stringify({ objectiveId, taskId, waitForChangeMs: 500 }),
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Surfaced a quick live snapshot before waiting for completion.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_live_wait_budget",
    problem: "Watch the running task.",
    profileId: "software",
    objectiveId,
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    dataDir,
    factoryService: createFactoryServiceStub({
      getObjectiveLiveOutput: async () => {
        firstOutputSnapshotAt = firstOutputSnapshotAt ?? Date.now();
        const done = Date.now() - firstOutputSnapshotAt >= 350;
        return {
          objectiveId,
          focusKind: "task",
          focusId: taskId,
          title: "Live wait demo",
          status: done ? "completed" : "running",
          active: !done,
          summary: done ? "Captured the completed task output." : "Still waiting on the running task.",
          taskId,
          candidateId: "candidate_live_wait",
          jobId: "job_live_wait",
          lastMessage: done ? "Completed task output is ready." : "Waiting for the task to finish.",
          stdoutTail: done ? "done" : "waiting",
        };
      },
    }) as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");

  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_live_wait_budget"));
  const observations = chain
    .filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "tool.observed" }> } =>
      receipt.body.type === "tool.observed" && receipt.body.tool === "factory.output"
    )
    .map((receipt) => JSON.parse(receipt.body.output) as { waitedMs?: number; changed?: boolean; status?: string });

  expect(observations).toHaveLength(2);
  expect(observations[0]?.waitedMs ?? 0).toBeGreaterThan(0);
  expect(observations[0]?.waitedMs ?? 0).toBeLessThan(250);
  expect(observations[0]?.changed).toBe(false);
  expect(observations[1]?.waitedMs ?? 0).toBeGreaterThan(observations[0]?.waitedMs ?? 0);
  expect(observations[1]?.changed).toBe(true);
  expect(observations[1]?.status).toBe("completed");
});

test("factory chat runner: unchanged live waits only pause the budget once per run", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-live-wait-once");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  const llmCalls: string[] = [];
  const stableTs = 1_700_000_000_000;
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    default: true,
    toolAllowlist: ["factory.status"],
  });

  const actions = [
    {
      thought: "wait once without spending the whole budget",
      action: {
        type: "tool",
        name: "factory.status",
        input: JSON.stringify({ objectiveId: "objective_demo", waitForChangeMs: 60 }),
        text: null,
      },
    },
    {
      thought: "wait a second time if the objective is still live",
      action: {
        type: "tool",
        name: "factory.status",
        input: JSON.stringify({ objectiveId: "objective_demo", waitForChangeMs: 60 }),
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Should not reach this final step once the wait budget is consumed.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_live_wait_once",
    problem: "Keep watching the running objective.",
    profileId: "software",
    objectiveId: "objective_demo",
    config: {
      ...FACTORY_CHAT_DEFAULT_CONFIG,
      maxIterations: 1,
    },
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      llmCalls.push(next.action.type === "tool" ? next.action.name ?? "tool" : "final");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    dataDir,
    factoryService: createFactoryServiceStub({
      getObjective: async (objectiveId: string) => ({
        objectiveId,
        title: "Objective demo",
        status: "active",
        phase: "executing",
        objectiveMode: "delivery",
        severity: 2,
        latestSummary: "Still investigating the running objective.",
        nextAction: "Wait for the current task pass to finish.",
        integration: {
          status: "idle",
          queuedCandidateIds: [],
        },
        latestDecision: {
          summary: "Keep watching the live objective.",
          at: stableTs,
          source: "runtime",
        },
        blockedExplanation: undefined,
        evidenceCards: [{
          kind: "decision",
          title: "Latest decision",
          summary: "Keep watching the live objective.",
          at: stableTs,
          receiptType: "rebracket.applied",
        }],
        tasks: [],
      }),
      listObjectiveReceipts: async () => ([
        {
          type: "rebracket.applied",
          hash: "hash_receipt_stable",
          ts: stableTs,
          summary: "Keep watching the live objective.",
        },
      ]),
    }) as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("failed");
  expect(result.finalResponse).toContain("Stopped after hitting max iterations.");
  expect(llmCalls).toEqual(["factory.status", "factory.status"]);

  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_live_wait_once"));
  const observations = chain.filter((receipt) =>
    receipt.body.type === "tool.observed" && receipt.body.tool === "factory.status"
  );
  expect(observations).toHaveLength(2);
});

test("factory chat runner: terminal-objective reads do not consume discovery budget", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-terminal-read-budget");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    default: true,
    toolAllowlist: ["factory.status", "factory.receipts", "factory.output"],
    orchestration: {
      executionMode: "supervisor",
      discoveryBudget: 0,
      suspendOnAsyncChild: true,
      allowPollingWhileChildRunning: false,
      finalWhileChildRunning: "allow",
      childDedupe: "by_run_and_prompt",
    },
  });

  const actions = [
    {
      thought: "inspect the completed objective summary",
      action: {
        type: "tool",
        name: "factory.status",
        input: "{}",
        text: null,
      },
    },
    {
      thought: "inspect the saved receipts",
      action: {
        type: "tool",
        name: "factory.receipts",
        input: JSON.stringify({ limit: 4 }),
        text: null,
      },
    },
    {
      thought: "inspect the saved task output",
      action: {
        type: "tool",
        name: "factory.output",
        input: JSON.stringify({ focusKind: "task", focusId: "task_01" }),
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Read the completed objective directly from saved state.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_terminal_read_budget",
    problem: "Show the saved results from the completed objective.",
    profileId: "software",
    objectiveId: "objective_done",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    dataDir,
    factoryService: createFactoryServiceStub({
      inferObjectiveLiveOutputFocus: async () => ({
        focusKind: "task",
        focusId: "task_01",
        inferredBy: "single_task",
      }),
      getObjective: async (objectiveId: string) => ({
        objectiveId,
        title: "Completed objective",
        status: "completed",
        phase: "completed",
        latestSummary: "Inventory capture is complete.",
        integration: {
          status: "promoted",
          queuedCandidateIds: [],
        },
        latestDecision: {
          summary: "Use the saved receipts and task output.",
          at: Date.now(),
          source: "runtime",
        },
        blockedExplanation: undefined,
        evidenceCards: [],
        tasks: [],
      }),
      getObjectiveLiveOutput: async (objectiveId: string, focusKind: string, focusId: string) => ({
        objectiveId,
        focusKind,
        focusId,
        title: "Saved output",
        status: "completed",
        active: false,
        summary: "Captured the completed task output.",
        stdoutTail: "bucket-a\nbucket-b",
      }),
    }) as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  expect(result.finalResponse).toContain("completed objective");

  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_terminal_read_budget"));
  const budgetError = chain.find((receipt) =>
    receipt.body.type === "tool.called"
    && typeof receipt.body.error === "string"
    && receipt.body.error.includes("Profile discovery budget exhausted")
  )?.body;
  expect(budgetError).toBeUndefined();

  const observations = chain.filter((receipt) => receipt.body.type === "tool.observed").map((receipt) => receipt.body);
  expect(observations.find((event) => event.tool === "factory.status" && "output" in event)?.output ?? "").toContain('"status": "completed"');
  expect(observations.find((event) => event.tool === "factory.receipts" && "output" in event)?.output ?? "").toContain('"receipts"');
  expect(observations.find((event) => event.tool === "factory.output" && "output" in event)?.output ?? "").toContain("Captured the completed task output.");
});

test("factory chat runner: factory.output infers the single task from objectiveId alone", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-output-single-task");
  const repoRoot = await createTempDir("receipt-factory-chat-output-single-task-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-output-single-task-profile");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();

  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    default: true,
  });

  const actions = [
    {
      thought: "inspect the saved task output without naming the task",
      action: {
        type: "tool",
        name: "factory.output",
        input: JSON.stringify({ objectiveId: "objective_done" }),
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Used the only task output.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_output_single_task",
    problem: "Read the saved output from the completed objective.",
    profileId: "software",
    objectiveId: "objective_done",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    dataDir,
    factoryService: createFactoryServiceStub({
      inferObjectiveLiveOutputFocus: async () => ({
        focusKind: "task",
        focusId: "task_01",
        inferredBy: "single_task",
      }),
      getObjective: async (objectiveId: string) => ({
        objectiveId,
        title: "Completed objective",
        status: "completed",
        phase: "completed",
        latestSummary: "Inventory capture is complete.",
        integration: {
          status: "promoted",
          queuedCandidateIds: [],
        },
        latestDecision: {
          summary: "Read the saved task output.",
          at: Date.now(),
          source: "runtime",
        },
        blockedExplanation: undefined,
        evidenceCards: [],
        tasks: [{
          taskId: "task_01",
          title: "Only task",
          status: "approved",
        }],
      }),
      getObjectiveLiveOutput: async (objectiveId: string, focusKind: string, focusId: string) => ({
        objectiveId,
        focusKind,
        focusId,
        title: "Saved output",
        status: "completed",
        active: false,
        summary: "Captured the only task output.",
        stdoutTail: "bucket-a\nbucket-b",
      }),
    }) as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");

  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_output_single_task"));
  const outputObservation = chain.find((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "tool.observed" }> } =>
    receipt.body.type === "tool.observed" && receipt.body.tool === "factory.output"
  );
  expect(outputObservation?.body.output ?? "").toContain('"focusKind": "task"');
  expect(outputObservation?.body.output ?? "").toContain('"focusId": "task_01"');
  expect(outputObservation?.body.output ?? "").toContain("Captured the only task output.");
});

test("factory chat runner: software profile rejects follow-up polling while a codex child is still active", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-child-poll-guard");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    default: true,
    toolAllowlist: ["codex.run", "agent.status"],
    orchestration: {
      executionMode: "supervisor",
      suspendOnAsyncChild: true,
      allowPollingWhileChildRunning: false,
      finalWhileChildRunning: "waiting_message",
      childDedupe: "by_run_and_prompt",
    },
  });

  let childJobId = "";
  const actions = [
    async () => ({
      thought: "queue codex work",
      action: {
        type: "tool",
        name: "codex.run",
        input: JSON.stringify({ prompt: "Create a temporary probe file and report back." }),
        text: null,
      },
    }),
    async () => {
      const jobs = await queue.listJobs({ limit: 10 });
      childJobId = jobs[0]?.id ?? childJobId;
      return {
        thought: "incorrectly poll the active child",
        action: {
          type: "tool",
          name: "agent.status",
          input: JSON.stringify({ jobId: childJobId }),
          text: null,
        },
      };
    },
    async () => ({
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Waiting on child work.",
      },
    }),
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_software_child_poll_guard",
    problem: "Ship the bug fix.",
    profileId: "software",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const nextFactory = actions.shift();
      if (!nextFactory) throw new Error("no scripted action left");
      const next = await nextFactory();
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: {} as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_software_child_poll_guard"));
  const errorCall = chain.find((receipt) =>
    receipt.body.type === "tool.called"
    && receipt.body.tool === "agent.status"
    && typeof receipt.body.error === "string"
  )?.body;
  expect(errorCall && "error" in errorCall ? errorCall.error : "").toContain("Profile child work is already running");
});

test("factory chat runner: finalizer rewrites premature software success text while a codex child is still active", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-child-finalizer");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    default: true,
    toolAllowlist: ["codex.run"],
    orchestration: {
      executionMode: "supervisor",
      suspendOnAsyncChild: true,
      finalWhileChildRunning: "waiting_message",
      childDedupe: "by_run_and_prompt",
    },
  });

  const actions = [
    {
      thought: "queue codex work",
      action: {
        type: "tool",
        name: "codex.run",
        input: JSON.stringify({ prompt: "Create a temporary probe file and report back." }),
        text: null,
      },
    },
    {
      thought: "incorrectly claim completion early",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Everything is already complete and validated.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_software_child_finalizer",
    problem: "Ship the bug fix.",
    profileId: "software",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: {} as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  expect(result.finalResponse).toContain("Child work is still running as");
  expect(result.finalResponse).not.toContain("already complete and validated");
});

test("factory chat runner: active-monitor software policy keeps polling and preserves the operator response while child work runs", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-active-monitor");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    default: true,
    toolAllowlist: ["codex.run", "codex.status"],
    orchestration: {
      executionMode: "supervisor",
      suspendOnAsyncChild: false,
      allowPollingWhileChildRunning: true,
      finalWhileChildRunning: "allow",
      childDedupe: "by_run_and_prompt",
    },
  });

  const actions = [
    {
      thought: "queue codex work",
      action: {
        type: "tool",
        name: "codex.run",
        input: JSON.stringify({ prompt: "Inspect the current thread shell and report progress." }),
        text: null,
      },
    },
    {
      thought: "keep monitoring the child",
      action: {
        type: "tool",
        name: "codex.status",
        input: "{}",
        text: null,
      },
    },
    {
      thought: "respond as an active supervisor",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Codex is still running and I am watching the live worker state from this thread.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_software_active_monitor",
    problem: "Ship the bug fix.",
    profileId: "software",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: {} as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  expect(result.finalResponse).toContain("watching the live worker state");
  expect(result.finalResponse).not.toContain("Child work is still running as");

  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_software_active_monitor"));
  const statusCall = chain.find((receipt) =>
    receipt.body.type === "tool.observed"
    && receipt.body.tool === "codex.status"
  )?.body;
  expect(statusCall && "error" in statusCall ? statusCall.error : undefined).toBeUndefined();
  expect(statusCall && "output" in statusCall ? statusCall.output : "").toContain('"worker": "codex"');
});

test("factory chat runner: accepts valid JSON-object strings for tool input", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-object-input");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["jobs.list"],
  });

  const actions = [
    {
      thought: "list jobs",
      action: {
        type: "tool",
        name: "jobs.list",
        input: JSON.stringify({ limit: 3 }),
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Listed the recent jobs.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_object_input",
    problem: "List recent jobs.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: {} as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  expect(result.finalResponse).toContain("Listed the recent jobs.");
});

test("factory chat runner: retries once when the model emits malformed tool-input JSON", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-json-repair");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["jobs.list"],
  });

  const actions = [
    {
      thought: "first try is malformed",
      action: {
        type: "tool",
        name: "jobs.list",
        input: "{\"limit\":",
        text: null,
      },
    },
    {
      thought: "repair and list jobs",
      action: {
        type: "tool",
        name: "jobs.list",
        input: JSON.stringify({ limit: 2 }),
        text: null,
      },
    },
    {
      thought: "respond",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Recovered from the malformed tool input.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_json_repair",
    problem: "List recent jobs.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: {} as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  expect(result.finalResponse).toContain("Recovered from the malformed tool input.");
});

test("factory chat runner: startup binds the current objective to the chat session", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-thread-bind");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: [],
  });

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_thread_bind",
    problem: "Keep this thread bound to the current objective.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => ({
      parsed: schema.parse({
        thought: "reply",
        action: {
          type: "final",
          name: null,
          input: "{}",
          text: "Thread stays bound.",
        },
      }),
      raw: "{\"thought\":\"reply\",\"action\":{\"type\":\"final\",\"name\":null,\"input\":\"{}\",\"text\":\"Thread stays bound.\"}}",
    }),
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: createFactoryServiceStub() as never,
    repoRoot,
    profileRoot,
    chatId: "chat_demo",
    objectiveId: "objective_demo",
  });

  expect(result.status).toBe("completed");
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_thread_bind"));
  const bound = chain.find((receipt) => receipt.body.type === "thread.bound")?.body;
  expect(bound && "objectiveId" in bound ? bound.objectiveId : "").toBe("objective_demo");
  expect(bound && "chatId" in bound ? bound.chatId : "").toBe("chat_demo");
  expect(bound && "reason" in bound ? bound.reason : "").toBe("startup");
});

test("factory chat runner: prompt keeps profile memory separate from explicit objective/runtime imports", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-layered-memory");
  const repoRoot = await createGitRepo("receipt-factory-chat-layered-memory-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-layered-memory-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const repoKey = repoKeyForRoot(repoRoot);
  const objectiveId = "objective_demo";
  const profileId = "generalist";
  const summarizeCalls: string[] = [];
  let capturedUserPrompt = "";
  const summaries = new Map<string, string>([
    [`repos/${repoKey}`, "repo note"],
    [`repos/${repoKey}/profiles/${profileId}`, "profile note"],
    [`repos/${repoKey}/profiles/${profileId}/objectives/${objectiveId}`, "objective note"],
    ["factory/repo/shared", "factory shared note"],
    [`factory/objectives/${objectiveId}`, "factory objective note"],
    [`factory/objectives/${objectiveId}/integration`, "integration note"],
    [`repos/${repoKey}/subagents/factory`, "factory worker note"],
    [`repos/${repoKey}/subagents/codex`, "codex worker note"],
  ]);
  const memoryTools: MemoryTools = {
    read: async () => [],
    search: async () => [],
    summarize: async ({ scope }) => {
      summarizeCalls.push(scope);
      return {
        summary: summaries.get(scope) ?? "",
        entries: [],
      };
    },
    commit: async ({ scope, text, tags, meta }) => ({
      id: `memory_${Date.now()}`,
      scope,
      text,
      tags,
      meta,
      ts: Date.now(),
    }),
    diff: async () => [],
    reindex: async () => 0,
  };
  await writeProfile(profileRoot, {
    id: profileId,
    label: "Generalist",
    default: true,
    toolAllowlist: [],
  });

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_layered_memory",
    problem: "What do we already know about this objective?",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema, user }) => {
      capturedUserPrompt = user;
      const reply = {
        thought: "answer from layered memory",
        action: {
          type: "final",
          name: null,
          input: "{}",
          text: "Layered memory loaded.",
        },
      };
      return { parsed: schema.parse(reply), raw: JSON.stringify(reply) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: createFactoryServiceStub() as never,
    repoRoot,
    profileRoot,
    chatId: "chat_layered_memory",
    objectiveId,
  });

  expect(result.status).toBe("completed");
  expect(capturedUserPrompt).toContain("Imported context:");
  expect(capturedUserPrompt).toContain("Profile memory:\nprofile note");
  expect(capturedUserPrompt).toContain("Objective (bound):");
  expect(capturedUserPrompt).toContain("Objective demo (objective_demo)");
  expect(capturedUserPrompt).toContain("Runtime (bound):");
  expect(capturedUserPrompt).toContain("Investigating the sidebar objective.");
  expect(capturedUserPrompt).not.toContain("Repo memory:\nrepo note");
  expect(capturedUserPrompt).not.toContain("Objective memory:\nobjective note");
  expect(capturedUserPrompt).not.toContain("Factory shared memory:\nfactory shared note");
  expect(capturedUserPrompt).not.toContain("Factory objective memory:\nfactory objective note");
  expect(capturedUserPrompt).not.toContain("Integration memory:\nintegration note");
  expect(capturedUserPrompt).not.toContain("Factory worker memory:\nfactory worker note");
  expect(capturedUserPrompt).not.toContain("Codex worker memory:\ncodex worker note");
  expect(summarizeCalls).toContain(`repos/${repoKey}/profiles/${profileId}`);
  expect(summarizeCalls).not.toContain(`factory/objectives/${objectiveId}`);
  expect(summarizeCalls).not.toContain("factory/repo/shared");
  expect(summarizeCalls).not.toContain(`repos/${repoKey}/subagents/factory`);
});

test("factory chat runner: remembers durable chat presentation preferences and reuses them on later turns", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-preferences");
  const repoRoot = await createGitRepo("receipt-factory-chat-preferences-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-preferences-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const repoKey = repoKeyForRoot(repoRoot);
  const profileId = "generalist";
  const preferenceScope = `repos/${repoKey}/users/default/preferences`;
  let seq = 0;
  const entries = new Map<string, Array<{
    readonly id: string;
    readonly scope: string;
    readonly text: string;
    readonly tags?: ReadonlyArray<string>;
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly ts: number;
  }>>();
  const memoryTools: MemoryTools = {
    read: async ({ scope, limit }) => (entries.get(scope) ?? []).slice(0, limit ?? 20),
    search: async () => [],
    summarize: async () => ({ summary: "", entries: [] }),
    commit: async ({ scope, text, tags, meta }) => {
      const entry = {
        id: `memory_${++seq}`,
        scope,
        text,
        tags,
        meta,
        ts: Date.now() + seq,
      };
      const current = entries.get(scope) ?? [];
      entries.set(scope, [entry, ...current]);
      return entry;
    },
    diff: async () => [],
    reindex: async () => 0,
  };
  await writeProfile(profileRoot, {
    id: profileId,
    label: "Generalist",
    default: true,
    toolAllowlist: [],
  });

  let firstPrompt = "";
  const rememberedNote = "When answers rely on computed numbers, include the assumptions and caveats after the main result.";
  const firstResult = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_chat_pref_01",
    problem: "When answers rely on computed numbers, include the assumptions and caveats after the main result. Remember that preference for this chat.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema, user }) => {
      firstPrompt = user;
      const reply = {
        thought: "apply table preference",
        action: {
          type: "final",
          name: null,
          input: "{}",
          text: "Preference stored.",
        },
        memory: {
          preferenceNotes: [rememberedNote],
        },
      };
      return { parsed: schema.parse(reply), raw: JSON.stringify(reply) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: createFactoryServiceStub() as never,
    repoRoot,
    profileRoot,
    chatId: "chat_preferences",
  });

  expect(firstResult.status).toBe("completed");
  expect(firstPrompt).toContain("User preferences:");
  expect(firstPrompt).toContain("(none)");
  expect(entries.get(preferenceScope)?.map((entry) => entry.text)).toContain(
    rememberedNote,
  );
  expect(entries.get(preferenceScope)?.[0]?.meta).toEqual(expect.objectContaining({
    kind: "preference",
    source: "model_inference",
    status: "active",
  }));

  let secondPrompt = "";
  const secondResult = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_chat_pref_02",
    problem: "How many active jobs are there right now?",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema, user }) => {
      secondPrompt = user;
      const reply = {
        thought: "reuse remembered preference",
        action: {
          type: "final",
          name: null,
          input: "{}",
          text: "Still using the remembered preference.",
        },
      };
      return { parsed: schema.parse(reply), raw: JSON.stringify(reply) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: createFactoryServiceStub() as never,
    repoRoot,
    profileRoot,
    chatId: "chat_preferences",
  });

  expect(secondResult.status).toBe("completed");
  expect(secondPrompt).toContain("User preferences:");
  expect(secondPrompt).toContain(rememberedNote);
});

test("factory chat runner: injects session recall from older transcript messages", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-session-recall");
  const repoRoot = await createGitRepo("receipt-factory-chat-session-recall-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-session-recall-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: [],
  });

  const priorSessionStream = factoryChatSessionStream(repoRoot, "generalist", "prior_chat");
  await emitIndexedAgentEvent(agentRuntime, priorSessionStream, "run_01", {
    type: "problem.set",
    runId: "run_01",
    problem: "Set up PostgreSQL on port 5433 for staging.",
    agentId: "orchestrator",
  });
  await emitIndexedAgentEvent(agentRuntime, priorSessionStream, "run_01", {
    type: "response.finalized",
    runId: "run_01",
    agentId: "orchestrator",
    content: "Staging should use PostgreSQL on port 5433.",
  });

  let capturedUserPrompt = "";
  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_session_recall_01",
    problem: "What was the PostgreSQL staging port again?",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema, user }) => {
      capturedUserPrompt = user;
      const reply = {
        thought: "reuse the recalled transcript fact",
        action: {
          type: "final",
          name: null,
          input: "{}",
          text: "It was port 5433.",
        },
      };
      return { parsed: schema.parse(reply), raw: JSON.stringify(reply) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: createFactoryServiceStub() as never,
    dataDir,
    repoRoot,
    profileRoot,
    chatId: "current_chat",
  });

  expect(result.status).toBe("completed");
  expect(capturedUserPrompt).toContain("Session recall:");
  expect(capturedUserPrompt).toContain("5433");
});

test("factory chat runner: lightweight conversational turns skip bound objective inspection", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-lightweight");
  const repoRoot = await createGitRepo("receipt-factory-chat-lightweight-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-lightweight-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: [],
  });

  let getObjectiveCalls = 0;
  let getObjectiveDebugCalls = 0;
  let listObjectiveReceiptsCalls = 0;
  let capturedUserPrompt = "";
  const factoryService = createFactoryServiceStub({
    getObjective: async () => {
      getObjectiveCalls += 1;
      throw new Error("bound objective should not be loaded for lightweight chat turns");
    },
    getObjectiveDebug: async () => {
      getObjectiveDebugCalls += 1;
      throw new Error("objective debug should not be loaded for lightweight chat turns");
    },
    listObjectiveReceipts: async () => {
      listObjectiveReceiptsCalls += 1;
      throw new Error("objective receipts should not be loaded for lightweight chat turns");
    },
  });

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_lightweight_chat",
    problem: "Who are you?",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => JSON.stringify({
      responseStyle: "conversational",
      includeBoundObjectiveContext: false,
    }),
    llmStructured: async ({ schema, user }) => {
      capturedUserPrompt = user;
      const reply = {
        thought: "introduce the chat controller briefly",
        action: {
          type: "final",
          name: null,
          input: "{}",
          text: "I handle the chat thread and hand tracked work off when needed.",
        },
      };
      return { parsed: schema.parse(reply), raw: JSON.stringify(reply) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: factoryService as never,
    repoRoot,
    profileRoot,
    chatId: "chat_demo",
    objectiveId: "objective_demo",
  });

  expect(result.status).toBe("completed");
  expect(getObjectiveCalls).toBe(0);
  expect(getObjectiveDebugCalls).toBe(0);
  expect(listObjectiveReceiptsCalls).toBe(0);
  expect(capturedUserPrompt).toContain("Bound objective: objective_demo");
  expect(capturedUserPrompt).not.toContain("Objective (bound):");
  expect(capturedUserPrompt).not.toContain("Recent receipts:");
});

test("factory chat runner: factory.dispatch create starts a new objective instead of reusing the bound thread objective", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-dispatch-thread");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["factory.dispatch"],
  });

  let createCalled = false;
  let reacted: { readonly objectiveId: string; readonly message?: string } | undefined;
  const factoryService = createFactoryServiceStub({
    createObjective: async ({ prompt }: { readonly prompt: string }) => {
      createCalled = true;
      return {
        objectiveId: "objective_created",
        title: prompt,
        status: "queued",
        phase: "queued",
        latestSummary: prompt,
        integration: { status: "idle", queuedCandidateIds: [] },
      };
    },
    reactObjectiveWithNote: async (objectiveId: string, message?: string) => {
      reacted = { objectiveId, message };
      return {
        objectiveId,
        title: "Objective demo",
        status: "active",
        phase: "executing",
        latestSummary: message ?? "Reused current objective.",
        integration: { status: "idle", queuedCandidateIds: [] },
      };
    },
  });
  const actions = [
    {
      thought: "start a new objective for the follow-up work",
      action: {
        type: "tool",
        name: "factory.dispatch",
        input: JSON.stringify({ action: "create", prompt: "Tighten the current thread scope." }),
        text: null,
      },
    },
    {
      thought: "reply",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Started a new objective for the follow-up work.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_dispatch_thread",
    problem: "Keep work inside the current thread objective.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: factoryService as never,
    repoRoot,
    profileRoot,
    chatId: "chat_demo",
    objectiveId: "objective_demo",
  });

  expect(result.status).toBe("completed");
  expect(createCalled).toBe(true);
  expect(reacted).toBeUndefined();
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_dispatch_thread"));
  const observed = chain.find((receipt) => receipt.body.type === "tool.observed")?.body;
  expect(observed && "output" in observed ? observed.output : "").toContain('"reused": false');
  const boundEvents = chain.filter((receipt) => receipt.body.type === "thread.bound").map((receipt) => receipt.body);
  const latestBound = boundEvents.at(-1);
  expect(latestBound && "objectiveId" in latestBound ? latestBound.objectiveId : "").toBe("objective_created");
  expect(latestBound && "reason" in latestBound ? latestBound.reason : "").toBe("dispatch_create");
});

test("factory chat runner: default factory.dispatch follows the latest bound objective after a create", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-dispatch-default");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["factory.dispatch"],
  });

  let reactedObjectiveId: string | undefined;
  const factoryService = createFactoryServiceStub({
    createObjective: async ({ prompt }: { readonly prompt: string }) => ({
      objectiveId: "objective_created",
      title: prompt,
      status: "active",
      phase: "executing",
      latestSummary: "Created the follow-up objective.",
      integration: { status: "idle", queuedCandidateIds: [] },
    }),
    reactObjectiveWithNote: async (objectiveId: string) => {
      reactedObjectiveId = objectiveId;
      return {
        objectiveId,
        title: objectiveId === "objective_created" ? "Created objective" : "Starting objective",
        status: "active",
        phase: "executing",
        latestSummary: `Reacted ${objectiveId}.`,
        nextAction: "Keep working.",
        integration: { status: "idle", queuedCandidateIds: [] },
        latestDecision: undefined,
        blockedExplanation: undefined,
        evidenceCards: [],
        tasks: [],
      };
    },
    getObjective: async (objectiveId: string) => ({
      objectiveId,
      title: objectiveId === "objective_created" ? "Created objective" : "Starting objective",
      status: "active",
      phase: "executing",
      latestSummary: `Reacted ${objectiveId}.`,
      nextAction: "Keep working.",
      integration: { status: "idle", queuedCandidateIds: [] },
      latestDecision: undefined,
      blockedExplanation: undefined,
      evidenceCards: [],
      tasks: [],
    }),
  });
  const actions = [
    {
      thought: "start a new objective first",
      action: {
        type: "tool",
        name: "factory.dispatch",
        input: JSON.stringify({ action: "create", prompt: "Create a fresh investigation objective." }),
        text: null,
      },
    },
    {
      thought: "react the current thread objective without repeating the objective id",
      action: {
        type: "tool",
        name: "factory.dispatch",
        input: "{}",
        text: null,
      },
    },
    {
      thought: "reply",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Reacted the current objective.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_dispatch_default",
    problem: "Keep reacting the current thread objective.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: factoryService as never,
    repoRoot,
    profileRoot,
    chatId: "chat_demo",
    objectiveId: "objective_start",
  });

  expect(result.status).toBe("completed");
  expect(reactedObjectiveId).toBe("objective_created");
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_dispatch_default"));
  const boundEvents = chain.filter((receipt) => receipt.body.type === "thread.bound").map((receipt) => receipt.body);
  const latestBound = boundEvents.at(-1);
  expect(latestBound && "objectiveId" in latestBound ? latestBound.objectiveId : "").toBe("objective_created");
  expect(latestBound && "reason" in latestBound ? latestBound.reason : "").toBe("dispatch_update");
});

test("factory chat runner: Tech Lead cannot promote objectives through factory.dispatch", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-dispatch-promote-blocked");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Tech Lead",
    default: true,
    toolAllowlist: ["factory.dispatch"],
  });

  let promoted = false;
  const factoryService = createFactoryServiceStub({
    promoteObjective: async () => {
      promoted = true;
      return {
        objectiveId: "objective_demo",
        title: "Objective demo",
        status: "completed",
        phase: "completed",
        latestSummary: "Promoted.",
        integration: { status: "promoted", queuedCandidateIds: [] },
      };
    },
  });
  const actions = [
    {
      thought: "try to promote anyway",
      action: {
        type: "tool",
        name: "factory.dispatch",
        input: JSON.stringify({ action: "promote" }),
        text: null,
      },
    },
    {
      thought: "reply",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Promotion is blocked for this profile.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_dispatch_promote_blocked",
    problem: "Promote the current objective.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: factoryService as never,
    repoRoot,
    profileRoot,
    chatId: "chat_demo",
    objectiveId: "objective_demo",
  });

  expect(result.status).toBe("completed");
  expect(promoted).toBe(false);
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_dispatch_promote_blocked"));
  const errorCall = chain.find((receipt) =>
    receipt.body.type === "tool.called"
    && receipt.body.tool === "factory.dispatch"
    && typeof receipt.body.error === "string"
  )?.body;
  expect(errorCall && "error" in errorCall ? errorCall.error : "").toContain("Tech Lead cannot promote objectives.");
});

test("factory chat runner: Software Engineer can promote objectives through factory.dispatch", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-dispatch-promote-allowed");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software Engineer",
    default: true,
    toolAllowlist: ["factory.dispatch"],
  });

  let promotedObjectiveId: string | undefined;
  const factoryService = createFactoryServiceStub({
    promoteObjective: async (objectiveId: string) => {
      promotedObjectiveId = objectiveId;
      return {
        objectiveId,
        title: "Objective demo",
        status: "completed",
        phase: "completed",
        latestSummary: "Promoted.",
        integration: { status: "promoted", queuedCandidateIds: [] },
      };
    },
  });
  const actions = [
    {
      thought: "promote the objective",
      action: {
        type: "tool",
        name: "factory.dispatch",
        input: JSON.stringify({ action: "promote" }),
        text: null,
      },
    },
    {
      thought: "reply",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Promoted the objective.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/software",
    runId: "run_dispatch_promote_allowed",
    problem: "Promote the current objective.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: factoryService as never,
    repoRoot,
    profileRoot,
    chatId: "chat_demo",
    objectiveId: "objective_demo",
  });

  expect(result.status).toBe("completed");
  expect(promotedObjectiveId).toBe("objective_demo");
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/software", "run_dispatch_promote_allowed"));
  const observed = chain.find((receipt) => receipt.body.type === "tool.observed")?.body;
  expect(observed && "output" in observed ? observed.output : "").toContain('"action": "promote"');
});

test("factory chat runner: Infrastructure Engineer cannot create delivery objectives", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-dispatch-infra-mode");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "infrastructure",
    label: "Infrastructure Engineer",
    default: true,
    toolAllowlist: ["factory.dispatch"],
  });

  const actions = [
    {
      thought: "try to create delivery work",
      action: {
        type: "tool",
        name: "factory.dispatch",
        input: JSON.stringify({ action: "create", prompt: "Build the dashboard fix.", objectiveMode: "delivery" }),
        text: null,
      },
    },
    {
      thought: "reply",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Delivery creation is blocked.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/infrastructure",
    runId: "run_dispatch_infra_mode_blocked",
    problem: "Build the dashboard fix.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: createFactoryServiceStub() as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/infrastructure", "run_dispatch_infra_mode_blocked"));
  const errorCall = chain.find((receipt) =>
    receipt.body.type === "tool.called"
    && receipt.body.tool === "factory.dispatch"
    && typeof receipt.body.error === "string"
  )?.body;
  expect(errorCall && "error" in errorCall ? errorCall.error : "").toContain("Infrastructure Engineer cannot create delivery objectives.");
});

test("factory chat runner: QA Engineer cannot create investigation objectives", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-dispatch-qa-mode");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "qa",
    label: "QA Engineer",
    default: true,
    toolAllowlist: ["factory.dispatch"],
  });

  const actions = [
    {
      thought: "try to create investigation work",
      action: {
        type: "tool",
        name: "factory.dispatch",
        input: JSON.stringify({ action: "create", prompt: "Investigate why the queue is backing up.", objectiveMode: "investigation" }),
        text: null,
      },
    },
    {
      thought: "reply",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Investigation creation is blocked.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/qa",
    runId: "run_dispatch_qa_mode_blocked",
    problem: "Investigate why the queue is backing up.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: createFactoryServiceStub() as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/qa", "run_dispatch_qa_mode_blocked"));
  const errorCall = chain.find((receipt) =>
    receipt.body.type === "tool.called"
    && receipt.body.tool === "factory.dispatch"
    && typeof receipt.body.error === "string"
  )?.body;
  expect(errorCall && "error" in errorCall ? errorCall.error : "").toContain("QA Engineer cannot create investigation objectives.");
});

test("factory chat runner: factory.dispatch rejects profileId reassignment", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-dispatch-profileid");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Tech Lead",
    default: true,
    toolAllowlist: ["factory.dispatch"],
  });

  const actions = [
    {
      thought: "attempt hidden reassignment",
      action: {
        type: "tool",
        name: "factory.dispatch",
        input: JSON.stringify({ action: "create", prompt: "Build the dashboard fix.", profileId: "software" }),
        text: null,
      },
    },
    {
      thought: "reply",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Cross-profile reassignment is blocked.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/generalist",
    runId: "run_dispatch_profileid_rejected",
    problem: "Build the dashboard fix.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: createFactoryServiceStub() as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/generalist", "run_dispatch_profileid_rejected"));
  const errorCall = chain.find((receipt) =>
    receipt.body.type === "tool.called"
    && receipt.body.tool === "factory.dispatch"
    && typeof receipt.body.error === "string"
  )?.body;
  expect(errorCall && "error" in errorCall ? errorCall.error : "").toContain("factory.dispatch does not accept profileId");
});

test("factory chat runner: terminal bound objectives create a follow-up objective instead of reacting in place", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-dispatch-terminal-followup");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["factory.dispatch"],
  });

  let createdInput: Record<string, unknown> | undefined;
  let reacted: { readonly objectiveId: string; readonly message?: string } | undefined;
  const factoryService = createFactoryServiceStub({
    getObjective: async (objectiveId: string) => ({
      objectiveId,
      title: "Completed objective",
      status: "completed",
      phase: "completed",
      objectiveMode: "delivery",
      severity: 3,
      latestSummary: "The original objective is already done.",
      nextAction: "Start a new follow-up objective for more work.",
      integration: { status: "promoted", queuedCandidateIds: [] },
      latestDecision: undefined,
      blockedExplanation: undefined,
      evidenceCards: [],
      tasks: [],
    }),
    createObjective: async (input: Record<string, unknown>) => {
      createdInput = input;
      return {
        objectiveId: "objective_followup",
        title: String(input.prompt ?? "follow-up"),
        status: "queued",
        phase: "queued",
        latestSummary: "Created the follow-up objective.",
        integration: { status: "idle", queuedCandidateIds: [] },
      };
    },
    reactObjectiveWithNote: async (objectiveId: string, message?: string) => {
      reacted = { objectiveId, message };
      return {
        objectiveId,
        title: "Completed objective",
        status: "completed",
        phase: "completed",
        latestSummary: message ?? "Reacted in place.",
        integration: { status: "promoted", queuedCandidateIds: [] },
      };
    },
  });
  const actions = [
    {
      thought: "continue with a new follow-up objective",
      action: {
        type: "tool",
        name: "factory.dispatch",
        input: JSON.stringify({ prompt: "Continue with the follow-up work." }),
        text: null,
      },
    },
    {
      thought: "reply",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Started a follow-up objective.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/terminal-followup",
    runId: "run_dispatch_terminal_followup",
    problem: "Continue after the completed objective.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: factoryService as never,
    repoRoot,
    profileRoot,
    chatId: "chat_demo",
    objectiveId: "objective_done",
  });

  expect(result.status).toBe("completed");
  expect(createdInput).toMatchObject({
    title: "Continue with the follow-up work",
    prompt: "Continue with the follow-up work.",
    objectiveMode: "delivery",
    severity: 3,
    profileId: "generalist",
    startImmediately: true,
  });
  expect(reacted).toBeUndefined();
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/terminal-followup", "run_dispatch_terminal_followup"));
  const observed = chain.find((receipt) => receipt.body.type === "tool.observed")?.body;
  expect(observed && "output" in observed ? observed.output : "").toContain('"action": "create"');
  const boundEvents = chain.filter((receipt) => receipt.body.type === "thread.bound").map((receipt) => receipt.body);
  const latestBound = boundEvents.at(-1);
  expect(latestBound && "objectiveId" in latestBound ? latestBound.objectiveId : "").toBe("objective_followup");
  expect(latestBound && "reason" in latestBound ? latestBound.reason : "").toBe("dispatch_create");
});

test("factory chat runner: canonical follow-up note reacts the active bound objective in place", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-dispatch-react-note");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["factory.dispatch"],
  });

  let reacted: { readonly objectiveId: string; readonly message?: string } | undefined;
  const factoryService = createFactoryServiceStub({
    reactObjectiveWithNote: async (objectiveId: string, message?: string) => {
      reacted = { objectiveId, message };
      return {
        objectiveId,
        title: "Objective demo",
        status: "active",
        phase: "executing",
        latestSummary: message ?? "Reacted in place.",
        integration: { status: "idle", queuedCandidateIds: [] },
      };
    },
  });
  const actions = [
    {
      thought: "continue the currently bound objective",
      action: {
        type: "tool",
        name: "factory.dispatch",
        input: JSON.stringify({ note: "Check current service costs before finalizing." }),
        text: null,
      },
    },
    {
      thought: "reply",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Continuing the current objective.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_dispatch_react_note",
    problem: "Continue the current objective with a cost check.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: factoryService as never,
    repoRoot,
    profileRoot,
    chatId: "chat_demo",
    objectiveId: "objective_demo",
  });

  expect(result.status).toBe("completed");
  expect(reacted).toEqual({
    objectiveId: "objective_demo",
    message: "Check current service costs before finalizing.",
  });
});

test("factory chat runner: canonical completed-objective follow-up fields create and bind a new objective", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-dispatch-followup");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["factory.dispatch"],
  });

  let createdInput: Record<string, unknown> | undefined;
  const factoryService = createFactoryServiceStub({
    getObjective: async (objectiveId: string) => ({
      objectiveId,
      title: "Completed objective",
      status: "completed",
      phase: "completed",
      objectiveMode: "investigation",
      severity: 2,
      latestSummary: "The original objective is already done.",
      nextAction: "Create a follow-up objective for fresh investigation.",
      integration: { status: "idle", queuedCandidateIds: [] },
      latestDecision: undefined,
      blockedExplanation: undefined,
      evidenceCards: [],
      tasks: [],
    }),
    createObjective: async (input: Record<string, unknown>) => {
      createdInput = input;
      return {
        objectiveId: "objective_followup",
        title: String(input.title ?? "follow-up"),
        status: "queued",
        phase: "queued",
        latestSummary: String(input.prompt ?? "follow-up"),
        integration: { status: "idle", queuedCandidateIds: [] },
      };
    },
  });
  const actions = [
    {
      thought: "start the follow-up investigation on the same thread",
      action: {
        type: "tool",
        name: "factory.dispatch",
        input: JSON.stringify({
          objectiveId: "objective_done",
          title: "AWS cost by service: highest vs lowest",
          prompt: "Use Cost Explorer to identify the highest-cost service and the lowest non-zero service cost for the last 30 days.",
          objectiveMode: "investigation",
        }),
        text: null,
      },
    },
    {
      thought: "reply",
      action: {
        type: "final",
        name: null,
        input: "{}",
        text: "Started the follow-up objective.",
      },
    },
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_dispatch_followup",
    problem: "Which AWS service costs the most and which costs the least?",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: factoryService as never,
    repoRoot,
    profileRoot,
    chatId: "chat_demo",
    objectiveId: "objective_done",
  });

  expect(result.status).toBe("completed");
  expect(createdInput).toMatchObject({
    title: "AWS cost by service: highest vs lowest",
    prompt: "Use Cost Explorer to identify the highest-cost service and the lowest non-zero service cost for the last 30 days.",
    objectiveMode: "investigation",
    severity: 2,
    profileId: "generalist",
    startImmediately: true,
  });
  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_dispatch_followup"));
  const boundEvents = chain.filter((receipt) => receipt.body.type === "thread.bound").map((receipt) => receipt.body);
  const latestBound = boundEvents.at(-1);
  expect(latestBound && "objectiveId" in latestBound ? latestBound.objectiveId : "").toBe("objective_followup");
  expect(latestBound && "reason" in latestBound ? latestBound.reason : "").toBe("dispatch_create");
});

test("factory chat runner: exhausted slices queue an automatic continuation on the same thread with a higher budget", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-slice-continue");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["jobs.list"],
  });

  const actions = Array.from({ length: 8 }, (_, index) => ({
    thought: `poll jobs ${index + 1}`,
    action: {
      type: "tool",
      name: "jobs.list",
      input: JSON.stringify({ limit: 5 }),
      text: null,
    },
  }));

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_slice_continue",
    problem: "Keep this thread active and keep watching the queue.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: {} as never,
    repoRoot,
    profileRoot,
  });

  expect(result.status).toBe("completed");
  expect(result.finalResponse).toContain("Continuing automatically in this project chat");

  const jobs = await queue.listJobs({ limit: 10 });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.agentId).toBe("factory");
  expect(jobs[0]?.payload.stream).toBe("agents/factory/demo");
  expect((jobs[0]?.payload.config as Record<string, unknown> | undefined)?.maxIterations).toBe(12);
  expect(jobs[0]?.payload.continuationDepth).toBe(1);

  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_slice_continue"));
  const continuation = chain.find((receipt) => receipt.body.type === "run.continued")?.body;
  expect(continuation && "nextJobId" in continuation ? continuation.nextJobId : "").toBe(jobs[0]?.id);
  expect(continuation && "nextMaxIterations" in continuation ? continuation.nextMaxIterations : 0).toBe(12);
});

test("factory chat runner: exhausted slices continue with the latest bound objective, not the startup objective", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-slice-continue-bound-objective");
  const repoRoot = await createTempDir("receipt-factory-chat-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    toolAllowlist: ["factory.dispatch", "jobs.list"],
  });

  const factoryService = createFactoryServiceStub({
    createObjective: async ({ prompt }: { readonly prompt: string }) => ({
      objectiveId: "objective_created",
      title: prompt,
      status: "active",
      phase: "executing",
      latestSummary: "Created the follow-up objective.",
      integration: { status: "idle", queuedCandidateIds: [] },
    }),
    getObjective: async (objectiveId: string) => ({
      objectiveId,
      title: "Objective demo",
      status: "blocked",
      phase: "executing",
      objectiveMode: "delivery" as const,
      severity: 2,
      latestSummary: "Blocked on human input.",
      nextAction: "React the current objective.",
      integration: { status: "idle" as const, queuedCandidateIds: [] as string[] },
      latestDecision: undefined,
      blockedExplanation: "Blocked on human input.",
      evidenceCards: [],
      tasks: [],
    }),
  });
  const actions = [
    {
      thought: "start the new objective for this thread",
      action: {
        type: "tool",
        name: "factory.dispatch",
        input: JSON.stringify({ action: "create", prompt: "Create a fresh investigation objective." }),
        text: null,
      },
    },
    ...Array.from({ length: 7 }, (_, index) => ({
      thought: `poll jobs ${index + 1}`,
      action: {
        type: "tool",
        name: "jobs.list",
        input: JSON.stringify({ limit: 5 }),
        text: null,
      },
    })),
  ];

  const result = await runFactoryChat({
    stream: "agents/factory/demo",
    runId: "run_slice_continue_bound_objective",
    problem: "Keep this thread active and keep watching the queue.",
    config: FACTORY_CHAT_DEFAULT_CONFIG,
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = actions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: factoryService as never,
    repoRoot,
    profileRoot,
    chatId: "chat_demo",
    objectiveId: "objective_start",
  });

  expect(result.status).toBe("completed");
  const jobs = await queue.listJobs({ limit: 10 });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.agentId).toBe("factory");
  expect(jobs[0]?.payload.objectiveId).toBe("objective_created");

  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_slice_continue_bound_objective"));
  const continuation = chain.find((receipt) => receipt.body.type === "run.continued")?.body;
  expect(continuation && "objectiveId" in continuation ? continuation.objectiveId : "").toBe("objective_created");
});

test("factory chat runner: historical infrastructure loop continues on the latest bound objective", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-historical-infra-loop");
  const repoRoot = await createTempDir("receipt-factory-chat-historical-infra-repo");
  const profileRoot = await createTempDir("receipt-factory-chat-historical-infra-profile-root");
  const agentRuntime = createAgentRuntime(dataDir);
  const jobRuntime = createJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const memoryTools = createMemoryStub();
  await writeProfile(profileRoot, {
    id: "infrastructure",
    label: "Infrastructure",
    default: true,
    toolAllowlist: ["factory.dispatch", "factory.status", "factory.receipts", "jobs.list"],
  });

  let activePoll = 0;
  const activeDetail = (summary?: string) => ({
    objectiveId: historicalInfrastructureObjectiveId,
    title: "Inventory running EC2 instances and infer schedules",
    status: "active",
    phase: "executing",
    latestSummary: summary ?? `Historical EC2 poll ${++activePoll}`,
    nextAction: "Wait for the EC2 investigation to finish.",
    integration: {
      status: "idle",
      queuedCandidateIds: [],
    },
    latestDecision: {
      summary: "Keep watching the running EC2 inventory objective.",
      at: Date.now(),
      source: "runtime",
    },
    blockedExplanation: undefined,
    evidenceCards: [],
    tasks: [],
  });

  const completedStartup = {
    objectiveId: historicalInfrastructureStartupObjectiveId,
    title: "show list of s3 buckets",
    status: "completed",
    phase: "completed",
    latestSummary: "AWS CLI inventory succeeded for account 445567089271 and returned 5 S3 buckets.",
    nextAction: "Answer directly from saved results.",
    integration: {
      status: "idle",
      queuedCandidateIds: [],
    },
    latestDecision: {
      summary: "Use the completed S3 inventory objective for context.",
      at: Date.now(),
      source: "runtime",
    },
    blockedExplanation: undefined,
    evidenceCards: [],
    tasks: [],
  };

  const factoryService = createFactoryServiceStub({
    createObjective: async () => activeDetail(),
    getObjective: async (objectiveId: string) =>
      objectiveId === historicalInfrastructureStartupObjectiveId
        ? completedStartup
        : { ...activeDetail(), status: "blocked", blockedExplanation: "Waiting for human input." },
    reactObjectiveWithNote: async (objectiveId: string, message?: string) =>
      objectiveId === historicalInfrastructureStartupObjectiveId
        ? completedStartup
        : activeDetail(message),
    reactObjective: async () => undefined,
    listObjectiveReceipts: async (objectiveId: string) =>
      objectiveId !== historicalInfrastructureObjectiveId
        ? []
        : historicalInfrastructureObjectiveReceipts.map((receipt, index) => ({
          type: receipt.type,
          hash: `hash_${index + 1}`,
          ts: "createdAt" in receipt
            ? receipt.createdAt
            : "proposedAt" in receipt
              ? receipt.proposedAt
              : "adoptedAt" in receipt
                ? receipt.adoptedAt
                : "readyAt" in receipt
                  ? receipt.readyAt
                  : "startedAt" in receipt
                    ? receipt.startedAt
                    : "notedAt" in receipt
                      ? receipt.notedAt
                      : "canceledAt" in receipt
                        ? receipt.canceledAt
                        : "releasedAt" in receipt
                          ? receipt.releasedAt
                          : "blockedAt" in receipt
                            ? receipt.blockedAt
                            : Date.now(),
          summary: receipt.type,
        })),
  });

  const scriptedActions = historicalInfrastructureLoop.actions
    .filter((action) => action.name !== "factory.output")
    .map((action) => ({
      thought: `historical infrastructure action ${action.iteration}`,
      action: {
        type: "tool" as const,
        name: action.name,
        input: JSON.stringify(
          typeof action.input.waitForChangeMs === "number"
            ? { ...action.input, waitForChangeMs: 50 }
            : action.input,
        ),
        text: null,
      },
    }));

  const result = await runFactoryChat({
    stream: "agents/factory/historical-infra-loop",
    runId: historicalInfrastructureLoop.runId,
    problem: historicalInfrastructureLoop.problem,
    config: {
      ...FACTORY_CHAT_DEFAULT_CONFIG,
      maxIterations: scriptedActions.length,
    },
    runtime: agentRuntime,
    llmText: async () => "",
    llmStructured: async ({ schema }) => {
      const next = scriptedActions.shift();
      if (!next) throw new Error("no scripted action left");
      return { parsed: schema.parse(next), raw: JSON.stringify(next) };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools: createNoopDelegationTools(),
    workspaceRoot: repoRoot,
    queue,
    factoryService: factoryService as never,
    repoRoot,
    profileRoot,
    chatId: historicalInfrastructureLoop.chatId,
    objectiveId: historicalInfrastructureStartupObjectiveId,
  });

  expect(result.status).toBe("completed");
  const jobs = await queue.listJobs({ limit: 10 });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.agentId).toBe("factory");
  expect(jobs[0]?.payload.objectiveId).toBe(historicalInfrastructureObjectiveId);

  const chain = await agentRuntime.chain(agentRunStream("agents/factory/historical-infra-loop", historicalInfrastructureLoop.runId));
  const continuation = chain.find((receipt) => receipt.body.type === "run.continued")?.body;
  expect(continuation && "objectiveId" in continuation ? continuation.objectiveId : "").toBe(historicalInfrastructureObjectiveId);

  const boundEvents = chain.filter((receipt) => receipt.body.type === "thread.bound").map((receipt) => receipt.body);
  const latestBound = boundEvents.at(-1);
  expect(latestBound && "objectiveId" in latestBound ? latestBound.objectiveId : "").toBe(historicalInfrastructureObjectiveId);
});

test("factory chat runner: codex progress snapshots surface while the child is still running", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-progress");
  const repoRoot = await createTempDir("receipt-factory-chat-progress-repo");
  const updates: Array<Record<string, unknown>> = [];

  const result = await runFactoryCodexJob({
    dataDir,
    repoRoot,
    jobId: "job_progress",
    prompt: "Inspect the repo and keep reporting progress.",
    executor: {
      run: async (input) => {
        await fs.writeFile(input.stdoutPath, "Booting Codex\n", "utf-8");
        await fs.writeFile(input.lastMessagePath, "Inspecting the repository.", "utf-8");
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        await fs.appendFile(input.stdoutPath, "Collected file list\n", "utf-8");
        await fs.writeFile(input.lastMessagePath, "Prepared final answer.", "utf-8");
        return {
          exitCode: 0,
          signal: null,
          stdout: "Booting Codex\nCollected file list\n",
          stderr: "",
          lastMessage: "Prepared final answer.",
        };
      },
    },
    onProgress: async (update) => {
      updates.push(update);
    },
  });

  expect(result.status).toBe("completed");
  expect(result.summary).toBe("Prepared final answer.");
  expect(updates.length).toBeGreaterThan(0);
  expect(updates.some((update) => update.status === "running")).toBe(true);
  expect(updates.some((update) => String(update.summary ?? "").includes("Inspecting the repository."))).toBe(true);
});

test("factory chat runner: direct codex probes run read-only and materialize a packet", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-direct-packet");
  const repoRoot = await createTempDir("receipt-factory-chat-direct-packet-repo");
  const captured: Array<Record<string, unknown>> = [];

  const result = await runFactoryCodexJob({
    dataDir,
    repoRoot,
    jobId: "job_direct_packet",
    prompt: "Inspect the repo without changing it.",
    payload: {
      readOnly: true,
      mode: "read_only_probe",
      profileId: "software",
      stream: "agents/factory/demo",
    },
    factoryService: {
      prepareDirectCodexProbePacket: async ({ jobId, prompt, readOnly }) => {
        const root = path.join(dataDir, "factory-chat", "codex", jobId);
        const packet = {
          artifactPaths: {
            root,
            promptPath: path.join(root, "prompt.md"),
            lastMessagePath: path.join(root, "last-message.txt"),
            stdoutPath: path.join(root, "stdout.log"),
            stderrPath: path.join(root, "stderr.log"),
            manifestPath: path.join(root, "manifest.json"),
            contextPackPath: path.join(root, "context-pack.json"),
            resultPath: path.join(root, "result.json"),
            memoryScriptPath: path.join(root, "memory.cjs"),
            memoryConfigPath: path.join(root, "memory-scopes.json"),
          },
          renderedPrompt: `READ ONLY\n${prompt}`,
          readOnly: readOnly !== false,
          env: {},
        };
        await fs.mkdir(packet.artifactPaths.root, { recursive: true });
        await fs.writeFile(packet.artifactPaths.manifestPath, JSON.stringify({ kind: "factory.codex.probe" }, null, 2), "utf-8");
        await fs.writeFile(packet.artifactPaths.contextPackPath, JSON.stringify({ title: "Direct Codex Probe", task: { taskId: "direct", title: "Direct probe", status: "running" } }, null, 2), "utf-8");
        await fs.writeFile(packet.artifactPaths.memoryConfigPath, JSON.stringify({ scopes: [] }, null, 2), "utf-8");
        await fs.writeFile(packet.artifactPaths.memoryScriptPath, "#!/usr/bin/env bun\n", "utf-8");
        return packet;
      },
    } as never,
    executor: {
      run: async (execInput) => {
        captured.push({
          sandboxMode: execInput.sandboxMode,
          mutationPolicy: execInput.mutationPolicy,
          prompt: execInput.prompt,
        });
        await fs.writeFile(execInput.lastMessagePath, "Read-only inspection complete.", "utf-8");
        await fs.writeFile(execInput.stdoutPath, "Scanned files\n", "utf-8");
        await fs.writeFile(execInput.stderrPath, "", "utf-8");
        return {
          exitCode: 0,
          signal: null,
          stdout: "Scanned files\n",
          stderr: "",
          lastMessage: "Read-only inspection complete.",
          tokensUsed: 4321,
        };
      },
    },
  });

  expect(result.status).toBe("completed");
  expect(result.readOnly).toBe(true);
  expect(result.tokensUsed).toBe(4321);
  expect(captured[0]?.sandboxMode).toBe("read-only");
  expect(captured[0]?.mutationPolicy).toBe("read_only_probe");
  expect(String(captured[0]?.prompt ?? "")).toContain("READ ONLY");
  await expect(fs.readFile(path.join(dataDir, "factory-chat", "codex", "job_direct_packet", "manifest.json"), "utf-8")).resolves.toContain("factory.codex.probe");
  await expect(fs.readFile(path.join(dataDir, "factory-chat", "codex", "job_direct_packet", "result.json"), "utf-8")).resolves.toContain("\"readOnly\": true");
  await expect(fs.readFile(path.join(dataDir, "factory-chat", "codex", "job_direct_packet", "result.json"), "utf-8")).resolves.toContain("\"tokensUsed\": 4321");
});

test("factory chat runner: direct codex probes ignore pre-existing repo dirtiness when the probe stays read-only", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-direct-dirty");
  const repoRoot = await createGitRepo("receipt-factory-chat-direct-dirty-repo");

  await fs.writeFile(path.join(repoRoot, "README.md"), "# locally dirty\n", "utf-8");

  const result = await runFactoryCodexJob({
    dataDir,
    repoRoot,
    jobId: "job_direct_dirty",
    prompt: "Inspect the repo without changing it.",
    payload: {
      readOnly: true,
      mode: "read_only_probe",
      profileId: "software",
      stream: "agents/factory/demo",
    },
    factoryService: {
      prepareDirectCodexProbePacket: async ({ jobId, prompt, readOnly }) => {
        const root = path.join(dataDir, "factory-chat", "codex", jobId);
        const packet = {
          artifactPaths: {
            root,
            promptPath: path.join(root, "prompt.md"),
            lastMessagePath: path.join(root, "last-message.txt"),
            stdoutPath: path.join(root, "stdout.log"),
            stderrPath: path.join(root, "stderr.log"),
            manifestPath: path.join(root, "manifest.json"),
            contextPackPath: path.join(root, "context-pack.json"),
            resultPath: path.join(root, "result.json"),
            memoryScriptPath: path.join(root, "memory.cjs"),
            memoryConfigPath: path.join(root, "memory-scopes.json"),
          },
          renderedPrompt: `READ ONLY\n${prompt}`,
          readOnly: readOnly !== false,
          env: {},
        };
        await fs.mkdir(packet.artifactPaths.root, { recursive: true });
        await fs.writeFile(packet.artifactPaths.manifestPath, JSON.stringify({ kind: "factory.codex.probe" }, null, 2), "utf-8");
        await fs.writeFile(packet.artifactPaths.contextPackPath, JSON.stringify({ title: "Direct Codex Probe", task: { taskId: "direct", title: "Direct probe", status: "running" } }, null, 2), "utf-8");
        await fs.writeFile(packet.artifactPaths.memoryConfigPath, JSON.stringify({ scopes: [] }, null, 2), "utf-8");
        await fs.writeFile(packet.artifactPaths.memoryScriptPath, "#!/usr/bin/env bun\n", "utf-8");
        return packet;
      },
    } as never,
    executor: {
      run: async (execInput) => {
        await fs.writeFile(execInput.lastMessagePath, "Read-only inspection complete.", "utf-8");
        await fs.writeFile(execInput.stdoutPath, "Scanned files\n", "utf-8");
        await fs.writeFile(execInput.stderrPath, "", "utf-8");
        return {
          exitCode: 0,
          signal: null,
          stdout: "Scanned files\n",
          stderr: "",
          lastMessage: "Read-only inspection complete.",
        };
      },
    },
  });

  expect(result.status).toBe("completed");
  expect(result.readOnly).toBe(true);
  expect(result.changedFiles).toEqual([]);
  expect(result.repoChangedFiles).toEqual(["README.md"]);
  await expect(fs.readFile(path.join(dataDir, "factory-chat", "codex", "job_direct_dirty", "result.json"), "utf-8")).resolves.toContain("\"repoChangedFiles\": [");
});

test("factory chat runner: direct codex probes fail explicitly if they mutate tracked files", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-direct-mutation");
  const repoRoot = await createGitRepo("receipt-factory-chat-direct-mutation-repo");

  await expect(runFactoryCodexJob({
    dataDir,
    repoRoot,
    jobId: "job_direct_mutation",
    prompt: "Do not change files.",
    payload: {
      readOnly: true,
      mode: "read_only_probe",
      profileId: "software",
      stream: "agents/factory/demo",
    },
    factoryService: {
      prepareDirectCodexProbePacket: async ({ jobId, prompt, readOnly }) => {
        const root = path.join(dataDir, "factory-chat", "codex", jobId);
        const packet = {
          artifactPaths: {
            root,
            promptPath: path.join(root, "prompt.md"),
            lastMessagePath: path.join(root, "last-message.txt"),
            stdoutPath: path.join(root, "stdout.log"),
            stderrPath: path.join(root, "stderr.log"),
            manifestPath: path.join(root, "manifest.json"),
            contextPackPath: path.join(root, "context-pack.json"),
            resultPath: path.join(root, "result.json"),
            memoryScriptPath: path.join(root, "memory.cjs"),
            memoryConfigPath: path.join(root, "memory-scopes.json"),
          },
          renderedPrompt: `READ ONLY\n${prompt}`,
          readOnly: readOnly !== false,
          env: {},
        };
        await fs.mkdir(packet.artifactPaths.root, { recursive: true });
        await fs.writeFile(packet.artifactPaths.manifestPath, JSON.stringify({ kind: "factory.codex.probe" }, null, 2), "utf-8");
        await fs.writeFile(packet.artifactPaths.contextPackPath, JSON.stringify({ title: "Direct Codex Probe", task: { taskId: "direct", title: "Direct probe", status: "running" } }, null, 2), "utf-8");
        await fs.writeFile(packet.artifactPaths.memoryConfigPath, JSON.stringify({ scopes: [] }, null, 2), "utf-8");
        await fs.writeFile(packet.artifactPaths.memoryScriptPath, "#!/usr/bin/env bun\n", "utf-8");
        return packet;
      },
    } as never,
    executor: {
      run: async (execInput) => {
        await fs.writeFile(path.join(repoRoot, "README.md"), "# changed\n", "utf-8");
        await fs.writeFile(execInput.lastMessagePath, "Attempted to change files.", "utf-8");
        return {
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          lastMessage: "Attempted to change files.",
        };
      },
    },
  })).rejects.toThrow("Direct Codex probes are read-only");

  await expect(fs.readFile(path.join(dataDir, "factory-chat", "codex", "job_direct_mutation", "result.json"), "utf-8")).resolves.toContain("\"status\": \"failed\"");
});

test("factory chat runner: direct codex probes retry in a disposable workspace when sandbox startup is incompatible", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-direct-fallback");
  const repoRoot = await createGitRepo("receipt-factory-chat-direct-fallback-repo");
  const captured: Array<Record<string, unknown>> = [];
  let fallbackWorkspacePath = "";

  const result = await runFactoryCodexJob({
    dataDir,
    repoRoot,
    jobId: "job_direct_fallback",
    prompt: "Inspect the repo without changing it.",
    payload: {
      readOnly: true,
      mode: "read_only_probe",
      profileId: "software",
      stream: "agents/factory/demo",
    },
    factoryService: {
      prepareDirectCodexProbePacket: async ({ jobId, prompt, readOnly }) => {
        const root = path.join(dataDir, "factory-chat", "codex", jobId);
        const packet = {
          artifactPaths: {
            root,
            promptPath: path.join(root, "prompt.md"),
            lastMessagePath: path.join(root, "last-message.txt"),
            stdoutPath: path.join(root, "stdout.log"),
            stderrPath: path.join(root, "stderr.log"),
            manifestPath: path.join(root, "manifest.json"),
            contextPackPath: path.join(root, "context-pack.json"),
            resultPath: path.join(root, "result.json"),
            memoryScriptPath: path.join(root, "memory.cjs"),
            memoryConfigPath: path.join(root, "memory-scopes.json"),
          },
          renderedPrompt: `READ ONLY\n${prompt}`,
          readOnly: readOnly !== false,
          env: {},
        };
        await fs.mkdir(packet.artifactPaths.root, { recursive: true });
        await fs.writeFile(packet.artifactPaths.manifestPath, JSON.stringify({ kind: "factory.codex.probe" }, null, 2), "utf-8");
        await fs.writeFile(packet.artifactPaths.contextPackPath, JSON.stringify({ title: "Direct Codex Probe" }, null, 2), "utf-8");
        await fs.writeFile(packet.artifactPaths.memoryConfigPath, JSON.stringify({ scopes: [] }, null, 2), "utf-8");
        await fs.writeFile(packet.artifactPaths.memoryScriptPath, "#!/usr/bin/env bun\n", "utf-8");
        return packet;
      },
    } as never,
    executor: {
      run: async (execInput) => {
        captured.push({
          workspacePath: execInput.workspacePath,
          sandboxMode: execInput.sandboxMode,
          mutationPolicy: execInput.mutationPolicy,
          disableSandboxModeInference: execInput.disableSandboxModeInference,
        });
        if (captured.length === 1) {
          await fs.writeFile(execInput.stderrPath, "bwrap: Unknown option --argv0\n", "utf-8");
          throw new Error("bwrap: Unknown option --argv0");
        }
        fallbackWorkspacePath = execInput.workspacePath;
        await fs.writeFile(execInput.lastMessagePath, "Read-only inspection complete.", "utf-8");
        await fs.writeFile(execInput.stdoutPath, "Scanned files\n", "utf-8");
        return {
          exitCode: 0,
          signal: null,
          stdout: "Scanned files\n",
          stderr: "",
          lastMessage: "Read-only inspection complete.",
        };
      },
    },
  });

  expect(result.status).toBe("completed");
  expect(result.readOnly).toBe(true);
  expect(result.sandboxCompatibilityFallbackUsed).toBe(true);
  expect(captured).toHaveLength(2);
  expect(captured[0]?.workspacePath).toBe(repoRoot);
  expect(captured[0]?.sandboxMode).toBe("read-only");
  expect(captured[1]?.workspacePath).not.toBe(repoRoot);
  expect(captured[1]?.sandboxMode).toBeUndefined();
  expect(captured[1]?.mutationPolicy).toBe("read_only_probe");
  expect(captured[1]?.disableSandboxModeInference).toBe(true);
  await expect(fs.readFile(path.join(dataDir, "factory-chat", "codex", "job_direct_fallback", "stderr.log"), "utf-8")).resolves.toContain("sandbox compatibility fallback");
  await expect(fs.stat(fallbackWorkspacePath)).rejects.toThrow();
  await expect(fs.readFile(path.join(repoRoot, "README.md"), "utf-8")).resolves.toBe("# demo\n");
});

test("factory chat runner: disposable fallback still rejects read-only probe mutations", async () => {
  const dataDir = await createTempDir("receipt-factory-chat-direct-fallback-mutation");
  const repoRoot = await createGitRepo("receipt-factory-chat-direct-fallback-mutation-repo");

  await expect(runFactoryCodexJob({
    dataDir,
    repoRoot,
    jobId: "job_direct_fallback_mutation",
    prompt: "Inspect the repo without changing it.",
    payload: {
      readOnly: true,
      mode: "read_only_probe",
      profileId: "software",
      stream: "agents/factory/demo",
    },
    factoryService: {
      prepareDirectCodexProbePacket: async ({ jobId, prompt, readOnly }) => {
        const root = path.join(dataDir, "factory-chat", "codex", jobId);
        const packet = {
          artifactPaths: {
            root,
            promptPath: path.join(root, "prompt.md"),
            lastMessagePath: path.join(root, "last-message.txt"),
            stdoutPath: path.join(root, "stdout.log"),
            stderrPath: path.join(root, "stderr.log"),
            manifestPath: path.join(root, "manifest.json"),
            contextPackPath: path.join(root, "context-pack.json"),
            resultPath: path.join(root, "result.json"),
            memoryScriptPath: path.join(root, "memory.cjs"),
            memoryConfigPath: path.join(root, "memory-scopes.json"),
          },
          renderedPrompt: `READ ONLY\n${prompt}`,
          readOnly: readOnly !== false,
          env: {},
        };
        await fs.mkdir(packet.artifactPaths.root, { recursive: true });
        await fs.writeFile(packet.artifactPaths.manifestPath, JSON.stringify({ kind: "factory.codex.probe" }, null, 2), "utf-8");
        await fs.writeFile(packet.artifactPaths.contextPackPath, JSON.stringify({ title: "Direct Codex Probe" }, null, 2), "utf-8");
        await fs.writeFile(packet.artifactPaths.memoryConfigPath, JSON.stringify({ scopes: [] }, null, 2), "utf-8");
        await fs.writeFile(packet.artifactPaths.memoryScriptPath, "#!/usr/bin/env bun\n", "utf-8");
        return packet;
      },
    } as never,
    executor: {
      run: async (execInput) => {
        if (execInput.sandboxMode === "read-only") {
          await fs.writeFile(execInput.stderrPath, "bwrap: Unknown option --argv0\n", "utf-8");
          throw new Error("bwrap: Unknown option --argv0");
        }
        await fs.writeFile(path.join(execInput.workspacePath, "README.md"), "# changed in fallback\n", "utf-8");
        await fs.writeFile(execInput.lastMessagePath, "Attempted to change files.", "utf-8");
        return {
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          lastMessage: "Attempted to change files.",
        };
      },
    },
  })).rejects.toThrow("Direct Codex probes are read-only");

  await expect(fs.readFile(path.join(repoRoot, "README.md"), "utf-8")).resolves.toBe("# demo\n");
  await expect(fs.readFile(path.join(dataDir, "factory-chat", "codex", "job_direct_fallback_mutation", "result.json"), "utf-8")).resolves.toContain("\"sandboxCompatibilityFallbackUsed\": true");
});
