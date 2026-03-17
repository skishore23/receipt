import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import { jsonlQueue } from "../../src/adapters/jsonl-queue.ts";
import type { MemoryTools } from "../../src/adapters/memory-tools.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import type { JobCmd, JobEvent, JobState } from "../../src/modules/job.ts";
import { decide as decideJob, initial as initialJob, reduce as reduceJob } from "../../src/modules/job.ts";
import type { AgentCmd, AgentEvent, AgentState } from "../../src/modules/agent.ts";
import { decide as decideAgent, initial as initialAgent, reduce as reduceAgent } from "../../src/modules/agent.ts";
import { agentRunStream } from "../../src/agents/agent.streams.ts";
import {
  FACTORY_CHAT_DEFAULT_CONFIG,
  runFactoryChat,
  runFactoryCodexJob,
} from "../../src/agents/factory-chat.ts";

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

const createNoopDelegationTools = () => ({
  "agent.delegate": async () => ({ output: "unused", summary: "unused" }),
  "agent.status": async () => ({ output: "unused", summary: "unused" }),
  "agent.inspect": async () => ({ output: "unused", summary: "unused" }),
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

const writeProfile = async (root: string, input: {
  readonly id: string;
  readonly label: string;
  readonly default?: boolean;
  readonly toolAllowlist: ReadonlyArray<string>;
  readonly handoffTargets?: ReadonlyArray<string>;
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
  await fs.writeFile(path.join(dir, "PROFILE.md"), `# ${input.label}\n\nUse the async tools.\n`, "utf-8");
  await fs.writeFile(path.join(dir, "profile.json"), JSON.stringify({
    id: input.id,
    label: input.label,
    enabled: true,
    default: input.default ?? false,
    imports: [],
    routeHints: [],
    toolAllowlist: input.toolAllowlist,
    orchestration: input.orchestration ?? {},
    handoffTargets: input.handoffTargets ?? [],
  }, null, 2), "utf-8");
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
  expect(jobs[0]?.agentId).toBe("factory-codex");
  expect(jobs[0]?.status).toBe("queued");
  expect(jobs[0]?.singletonMode).toBe("allow");

  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_async_codex"));
  const observed = chain.find((receipt) => receipt.body.type === "tool.observed")?.body;
  expect(observed && "output" in observed ? observed.output : "").toContain('"status": "queued"');
  expect(observed && "output" in observed ? observed.output : "").toContain('"jobId":');
  expect(observed && "output" in observed ? observed.output : "").toContain("codex child queued as");
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
        input: JSON.stringify({ profileId: "software", reason: "Ship the repo fix." }),
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

  const chain = await agentRuntime.chain(agentRunStream("agents/factory/demo", "run_async_handoff"));
  const observed = chain.find((receipt) => receipt.body.type === "tool.observed")?.body;
  expect(observed && "output" in observed ? observed.output : "").toContain('"toProfileId": "software"');
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
