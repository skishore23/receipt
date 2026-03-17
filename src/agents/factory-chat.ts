import fs from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import type { ZodTypeAny, infer as ZodInfer } from "zod";

import {
  AGENT_DEFAULT_CONFIG,
  normalizeAgentConfig,
  runAgent,
  type AgentRunConfig,
  type AgentRunInput,
  type AgentRunResult,
  type AgentToolExecutor,
  type AgentToolResult,
} from "./agent.js";
import type { AgentEvent } from "../modules/agent.js";
import type { JsonlQueue, QueueJob } from "../adapters/jsonl-queue.js";
import type { FactoryService, FactoryObjectiveInput } from "../services/factory-service.js";
import {
  factoryChatStream,
  repoKeyForRoot,
  resolveFactoryChatProfile,
  type FactoryChatResolvedProfile,
} from "../services/factory-chat-profiles.js";
import type { CodexExecutor, CodexRunControl } from "../adapters/codex-executor.js";
import type { MemoryTools } from "../adapters/memory-tools.js";

const execFileAsync = promisify(execFile);

export const FACTORY_CHAT_WORKFLOW_ID = "factory-chat-v1";
export const FACTORY_CHAT_WORKFLOW_VERSION = "1.0.0";

export type FactoryChatRunConfig = AgentRunConfig;

export const FACTORY_CHAT_DEFAULT_CONFIG: FactoryChatRunConfig = {
  ...AGENT_DEFAULT_CONFIG,
  maxIterations: 8,
  maxToolOutputChars: 6_000,
  memoryScope: "repos/factory/profiles/generalist",
};

export type FactoryChatRunInput = Omit<AgentRunInput, "config" | "prompts" | "llmStructured"> & {
  readonly config: FactoryChatRunConfig;
  readonly queue: JsonlQueue;
  readonly factoryService: FactoryService;
  readonly repoRoot: string;
  readonly profileRoot?: string;
  readonly objectiveId?: string;
  readonly llmStructured: <Schema extends ZodTypeAny>(opts: {
    readonly system?: string;
    readonly user: string;
    readonly schema: Schema;
    readonly schemaName: string;
  }) => Promise<{ readonly parsed: ZodInfer<Schema>; readonly raw: string }>;
  readonly profileId?: string;
};

const FACTORY_CHAT_LOOP_TEMPLATE = [
  "Goal:",
  "{{problem}}",
  "",
  "Iteration: {{iteration}} / {{maxIterations}}",
  "Workspace: {{workspace}}",
  "",
  "Recent transcript:",
  "{{transcript}}",
  "",
  "Memory summary:",
  "{{memory}}",
  "",
  "Available tools (one per step):",
  "{{available_tools}}",
  "",
  "Tool specs:",
  "{{tool_help}}",
  "",
  "Respond with JSON only, no markdown. Always include every field in the action object:",
  "{",
  "  \"thought\": \"short reasoning\",",
  "  \"action\": {",
  "    \"type\": \"tool\" | \"final\",",
  "    \"name\": \"tool name when type=tool, otherwise null\",",
  "    \"input\": \"JSON object string for tool args\",",
  "    \"text\": \"final answer when type=final, otherwise null\"",
  "  }",
  "}",
  "",
  "For final actions, set \"name\": null and \"input\": \"{}\".",
  "For tool actions, set \"text\": null.",
  "The input field must always be a JSON object encoded as a string.",
].join("\n");

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asStringList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];

const clip = (value: string, max = 160): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const tryParseJsonRecord = (value: string | undefined): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
};

const nextId = (prefix: string): string =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const stableCodexSessionKey = (runId: string, prompt: string): string =>
  `factory-codex:${runId}:${createHash("sha1").update(prompt).digest("hex").slice(0, 12)}`;

const summarizeObjective = (detail: Awaited<ReturnType<FactoryService["getObjective"]>>) => ({
  objectiveId: detail.objectiveId,
  title: detail.title,
  status: detail.status,
  phase: detail.phase,
  summary: detail.latestSummary ?? detail.nextAction ?? detail.title,
  integrationStatus: detail.integration.status,
  latestCommitHash: detail.latestCommitHash,
  link: `/factory?objective=${encodeURIComponent(detail.objectiveId)}`,
});

const deriveObjectiveTitle = (prompt: string): string => {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact) return "Factory objective";
  const sentence = compact.split(/[.!?]/)[0] ?? compact;
  return sentence.slice(0, 96).trim() || "Factory objective";
};

const repoMemoryScope = (repoKey: string): string => `repos/${repoKey}`;
const profileMemoryScope = (repoKey: string, profileId: string): string => `repos/${repoKey}/profiles/${profileId}`;
const objectiveMemoryScope = (repoKey: string, profileId: string, objectiveId: string): string =>
  `${profileMemoryScope(repoKey, profileId)}/objectives/${objectiveId}`;
const workerMemoryScope = (repoKey: string, worker: string): string => `repos/${repoKey}/subagents/${worker}`;

const toolSummary = (worker: string, status: string, summary: string): string =>
  `${worker} ${status}: ${summary}`;

const commitWorkerSummary = async (
  memoryTools: MemoryTools,
  scope: string,
  text: string,
  meta: Readonly<Record<string, unknown>>,
): Promise<void> => {
  await memoryTools.commit({
    scope,
    text,
    tags: ["factory-chat", "worker"],
    meta,
  });
};

const gitChangedFiles = async (repoRoot: string): Promise<ReadonlyArray<string>> => {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short"], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const tail = (value: string | undefined, max = 400): string | undefined => {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
};

const summarizeChildProgress = (input: {
  readonly lastMessage?: string;
  readonly stderrTail?: string;
  readonly stdoutTail?: string;
}): string => (
  asString(input.lastMessage)
  ?? asString(input.stderrTail)
  ?? asString(input.stdoutTail)
  ?? "Child work is running."
);

const normalizeJobSnapshot = (job: QueueJob): Record<string, unknown> => {
  const result = asRecord(job.result);
  const failure = asRecord(result?.failure);
  const task = asString(job.payload.task)
    ?? asString(job.payload.prompt)
    ?? asString(job.payload.problem)
    ?? asString(job.payload.kind)
    ?? `${job.agentId} job`;
  const terminalSummary = job.status === "failed"
    ? job.lastError ?? asString(failure?.message)
    : job.status === "canceled"
      ? job.canceledReason ?? asString(result?.note)
      : undefined;
  const summary = terminalSummary
    ?? asString(result?.summary)
    ?? asString(result?.finalResponse)
    ?? asString(result?.note)
    ?? asString(result?.message)
    ?? asString(failure?.message)
    ?? job.lastError
    ?? clip(task);
  return {
    jobId: job.id,
    status: job.status,
    worker: asString(result?.worker) ?? job.agentId,
    agentId: job.agentId,
    summary,
    task: clip(task, 220),
    runId: asString(result?.runId) ?? asString(job.payload.runId),
    stream: asString(result?.stream) ?? asString(job.payload.stream),
    parentRunId: asString(job.payload.parentRunId),
    parentStream: asString(job.payload.parentStream),
    profileId: asString(job.payload.profileId),
    delegatedTo: asString(result?.delegatedTo) ?? asString(job.payload.delegatedTo),
    objectiveId: asString(result?.objectiveId) ?? asString(job.payload.objectiveId),
    lastMessage: asString(result?.lastMessage),
    stdoutTail: asString(result?.stdoutTail),
    stderrTail: asString(result?.stderrTail),
    changedFiles: asStringList(result?.changedFiles),
    note: asString(result?.note),
  };
};

const isActiveJobStatus = (status: string | undefined): boolean =>
  status === "queued" || status === "leased" || status === "running";

const listChildJobsForRun = async (queue: JsonlQueue, runId: string): Promise<ReadonlyArray<QueueJob>> => {
  const jobs = await queue.listJobs({ limit: 200 });
  return jobs.filter((job) => asString(job.payload.parentRunId) === runId);
};

const buildActiveChildWaitingMessage = (jobs: ReadonlyArray<QueueJob>): string => {
  const snapshots = jobs.map((job) => normalizeJobSnapshot(job));
  const primary = snapshots[0];
  if (!primary) return "A child job is still running. Live updates will continue in this thread.";
  const summary = asString(primary.summary) ?? "Child work is still running.";
  const lines = [
    `Child work is still running as ${asString(primary.jobId) ?? "unknown job"} (${asString(primary.status) ?? "running"}).`,
    "Live updates will continue in this thread automatically.",
    "",
    `Latest child summary: ${summary}`,
  ];
  if (snapshots.length > 1) {
    lines.push("", `Active child jobs: ${snapshots.map((snapshot) => asString(snapshot.jobId) ?? "unknown").join(", ")}`);
  }
  return lines.join("\n");
};

const createCodexRunTool = (input: {
  readonly repoRoot: string;
  readonly repoKey: string;
  readonly queue: JsonlQueue;
  readonly runId: string;
  readonly stream: string;
  readonly objectiveId?: string;
  readonly memoryTools: MemoryTools;
  readonly profile: FactoryChatResolvedProfile;
}): AgentToolExecutor =>
  async (toolInput) => {
    const prompt = asString(toolInput.prompt) ?? asString(toolInput.task);
    if (!prompt) throw new Error("codex.run requires prompt");
    const timeoutMs = typeof toolInput.timeoutMs === "number" && Number.isFinite(toolInput.timeoutMs)
      ? Math.max(30_000, Math.min(Math.floor(toolInput.timeoutMs), 900_000))
      : 180_000;
    const sessionKey = input.profile.orchestration.childDedupe === "by_run_and_prompt"
      ? stableCodexSessionKey(input.runId, prompt)
      : `factory-codex:${input.stream}:${Date.now().toString(36)}`;
    const singletonMode = input.profile.orchestration.childDedupe === "by_run_and_prompt"
      ? "steer"
      : "allow";
    const created = await input.queue.enqueue({
      agentId: "factory-codex",
      lane: "collect",
      sessionKey,
      singletonMode,
      maxAttempts: 1,
      payload: {
        kind: "factory.codex.run",
        parentRunId: input.runId,
        parentStream: input.stream,
        stream: input.stream,
        profileId: input.profile.root.id,
        ...(input.objectiveId ? { objectiveId: input.objectiveId } : {}),
        task: prompt,
        prompt,
        timeoutMs,
      },
    });
    const result: Record<string, unknown> = {
      ...normalizeJobSnapshot(created),
      worker: "codex",
      summary: `codex child queued as ${created.id}`,
    };
    await commitWorkerSummary(
      input.memoryTools,
      workerMemoryScope(input.repoKey, "codex"),
      toolSummary("codex", String(result.status), String(result.summary)),
      { runId: input.runId, jobId: created.id, task: prompt },
    );
    return {
      output: JSON.stringify(result, null, 2),
      summary: String(result.summary),
    };
  };

const createAsyncDelegateTool = (input: {
  readonly queue: JsonlQueue;
  readonly runId: string;
  readonly stream: string;
  readonly repoKey: string;
  readonly objectiveId?: string;
  readonly memoryTools: MemoryTools;
  readonly profile: FactoryChatResolvedProfile;
}): AgentToolExecutor =>
  async (toolInput) => {
    const agentId = asString(toolInput.agentId);
    const task = asString(toolInput.task);
    if (!agentId) throw new Error("agent.delegate requires agentId");
    if (!task) throw new Error("agent.delegate requires task");
    const config = asRecord(toolInput.config) ?? {};
    const childRunId = nextId("run");
    const childStream = `agents/${agentId}`;
    const created = await input.queue.enqueue({
      agentId,
      lane: "collect",
      sessionKey: `factory-delegate:${input.stream}:${agentId}:${Date.now().toString(36)}`,
      singletonMode: "allow",
      maxAttempts: 2,
      payload: {
        kind: `${agentId}.run`,
        task,
        problem: task,
        config,
        isSubAgent: true,
        delegatedTo: agentId,
        runId: childRunId,
        stream: childStream,
        parentRunId: input.runId,
        parentStream: input.stream,
        profileId: input.profile.root.id,
        ...(input.objectiveId ? { objectiveId: input.objectiveId } : {}),
      },
    });
    const snapshot = normalizeJobSnapshot(created);
    await commitWorkerSummary(
      input.memoryTools,
      workerMemoryScope(input.repoKey, agentId),
      toolSummary(agentId, String(snapshot.status), String(snapshot.summary)),
      { runId: input.runId, jobId: created.id, task },
    );
    return {
      output: JSON.stringify(snapshot, null, 2),
      summary: `queued ${agentId} subagent`,
    };
  };

const createJobStatusTool = (input: {
  readonly queue: JsonlQueue;
  readonly currentJobId?: string;
}): AgentToolExecutor =>
  async (toolInput) => {
    const jobId = asString(toolInput.jobId);
    if (!jobId) throw new Error("agent.status requires jobId");
    if (jobId === input.currentJobId) {
      throw new Error("agent.status cannot target the current factory job; use the child jobId returned by codex.run or agent.delegate");
    }
    const job = await input.queue.getJob(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    const snapshot = normalizeJobSnapshot(job);
    return {
      output: JSON.stringify(snapshot, null, 2),
      summary: `job ${jobId}: ${String(snapshot.status)}`,
    };
  };

const createJobsListTool = (input: {
  readonly queue: JsonlQueue;
  readonly stream: string;
  readonly profile: FactoryChatResolvedProfile;
}): AgentToolExecutor =>
  async (toolInput) => {
    const limit = typeof toolInput.limit === "number" && Number.isFinite(toolInput.limit)
      ? Math.max(1, Math.min(Math.floor(toolInput.limit), 30))
      : 10;
    const includeCompleted = toolInput.includeCompleted === true;
    const statusFilter = asString(toolInput.status);
    const jobs = await input.queue.listJobs({ limit: 120 });
    const filtered = jobs
      .filter((job) => {
        const parentStream = asString(job.payload.parentStream);
        const payloadStream = asString(job.payload.stream);
        const profileId = asString(job.payload.profileId);
        return parentStream === input.stream
          || payloadStream === input.stream
          || profileId === input.profile.root.id;
      })
      .filter((job) => includeCompleted || (job.status !== "completed" && job.status !== "failed" && job.status !== "canceled"))
      .filter((job) => !statusFilter || job.status === statusFilter)
      .slice(0, limit)
      .map((job) => normalizeJobSnapshot(job));
    return {
      output: JSON.stringify(filtered, null, 2),
      summary: `${filtered.length} jobs`,
    };
  };

const createJobControlTool = (input: {
  readonly queue: JsonlQueue;
  readonly currentJobId?: string;
}): AgentToolExecutor =>
  async (toolInput) => {
    const jobId = asString(toolInput.jobId);
    const command = asString(toolInput.command);
    if (!jobId) throw new Error("job.control requires jobId");
    if (jobId === input.currentJobId) {
      throw new Error("job.control cannot target the current factory job; use the child jobId returned by codex.run or agent.delegate");
    }
    if (command !== "steer" && command !== "follow_up" && command !== "abort") {
      throw new Error("job.control command must be steer, follow_up, or abort");
    }
    let payload: Record<string, unknown>;
    if (command === "steer") {
      payload = {};
      const problem = asString(toolInput.problem);
      const config = asRecord(toolInput.config);
      if (problem) payload.problem = problem;
      if (config) payload.config = config;
      if (Object.keys(payload).length === 0) throw new Error("job.control steer requires problem and/or config");
    } else if (command === "follow_up") {
      const note = asString(toolInput.note) ?? asString(toolInput.problem);
      if (!note) throw new Error("job.control follow_up requires note");
      payload = { note };
    } else {
      payload = { reason: asString(toolInput.reason) ?? "abort requested" };
    }
    const queued = await input.queue.queueCommand({
      jobId,
      command,
      payload,
      by: "factory.chat",
    });
    if (!queued) throw new Error(`job ${jobId} not found`);
    return {
      output: JSON.stringify({
        jobId,
        command,
        status: "queued",
        payload,
      }, null, 2),
      summary: `${command} queued for ${jobId}`,
    };
  };

const createFactoryDispatchTool = (input: {
  readonly factoryService: FactoryService;
  readonly repoKey: string;
  readonly runId: string;
  readonly memoryTools: MemoryTools;
}): AgentToolExecutor =>
  async (toolInput) => {
    const objectiveId = asString(toolInput.objectiveId);
    const action = asString(toolInput.action) ?? (objectiveId ? "react" : "create");
    let detail: Awaited<ReturnType<FactoryService["getObjective"]>>;
    if (action === "create") {
      const prompt = asString(toolInput.prompt);
      if (!prompt) throw new Error("factory.dispatch create requires prompt");
      const payload: FactoryObjectiveInput = {
        title: asString(toolInput.title) ?? deriveObjectiveTitle(prompt),
        prompt,
        baseHash: asString(toolInput.baseHash),
        checks: asStringList(toolInput.checks),
        channel: asString(toolInput.channel),
      };
      detail = await input.factoryService.createObjective(payload);
    } else if (action === "react") {
      if (!objectiveId) throw new Error("factory.dispatch react requires objectiveId");
      await input.factoryService.reactObjective(objectiveId);
      detail = await input.factoryService.getObjective(objectiveId);
    } else if (action === "promote") {
      if (!objectiveId) throw new Error("factory.dispatch promote requires objectiveId");
      detail = await input.factoryService.promoteObjective(objectiveId);
    } else if (action === "cancel") {
      if (!objectiveId) throw new Error("factory.dispatch cancel requires objectiveId");
      detail = await input.factoryService.cancelObjective(objectiveId, asString(toolInput.reason));
    } else if (action === "cleanup") {
      if (!objectiveId) throw new Error("factory.dispatch cleanup requires objectiveId");
      detail = await input.factoryService.cleanupObjectiveWorkspaces(objectiveId);
    } else if (action === "archive") {
      if (!objectiveId) throw new Error("factory.dispatch archive requires objectiveId");
      detail = await input.factoryService.archiveObjective(objectiveId);
    } else {
      throw new Error(`unsupported factory.dispatch action '${action}'`);
    }
    const summary = summarizeObjective(detail);
    await commitWorkerSummary(
      input.memoryTools,
      workerMemoryScope(input.repoKey, "factory"),
      toolSummary("factory", summary.status, summary.summary),
      { runId: input.runId, objectiveId: summary.objectiveId, action },
    );
    return {
      output: JSON.stringify({ worker: "factory", action, ...summary }, null, 2),
      summary: summary.summary,
    };
  };

const createFactoryStatusTool = (input: {
  readonly factoryService: FactoryService;
}): AgentToolExecutor =>
  async (toolInput) => {
    const objectiveId = asString(toolInput.objectiveId);
    if (!objectiveId) throw new Error("factory.status requires objectiveId");
    const detail = await input.factoryService.getObjective(objectiveId);
    const summary = summarizeObjective(detail);
    return {
      output: JSON.stringify({ worker: "factory", action: "status", ...summary }, null, 2),
      summary: summary.summary,
    };
  };

const discoveryTools = new Set([
  "ls",
  "read",
  "grep",
  "agent.status",
  "jobs.list",
  "agent.inspect",
  "skill.read",
]);

const deliveryTools = new Set([
  "codex.run",
  "write",
  "bash",
  "factory.dispatch",
]);

const monitorWhileChildRunningTools = new Set([
  "agent.status",
  "jobs.list",
  "agent.inspect",
  "job.control",
]);

const withProfileOrchestrationPolicy = (
  input: {
    readonly profile: FactoryChatResolvedProfile;
    readonly queue: JsonlQueue;
    readonly runId: string;
  },
  tools: Readonly<Record<string, AgentToolExecutor>>,
): Readonly<Record<string, AgentToolExecutor>> => {
  const policy = input.profile.orchestration;
  let discoverySteps = 0;
  let deliveryStarted = false;
  const activeAsyncChildJobs = new Set<string>();
  return Object.fromEntries(Object.entries(tools).map(([name, executor]) => [name, async (toolInput) => {
    if (activeAsyncChildJobs.size > 0 && policy.suspendOnAsyncChild) {
      const activeJobs = (await Promise.all(
        [...activeAsyncChildJobs].map(async (jobId) => ({ jobId, job: await input.queue.getJob(jobId) })),
      ))
        .flatMap(({ jobId, job }) => {
          if (!job || !isActiveJobStatus(job.status)) {
            activeAsyncChildJobs.delete(jobId);
            return [];
          }
          return [job];
        });
      if (activeJobs.length > 0) {
        const pollAllowed = policy.allowPollingWhileChildRunning && monitorWhileChildRunningTools.has(name);
        const controlAllowed = name === "job.control";
        if (!pollAllowed && !controlAllowed) {
          throw new Error(`Profile child work is already running. ${buildActiveChildWaitingMessage(activeJobs)}`);
        }
      }
    }
    if (
      !deliveryStarted
      && typeof policy.discoveryBudget === "number"
      && discoveryTools.has(name)
    ) {
      discoverySteps += 1;
      if (discoverySteps > policy.discoveryBudget) {
        throw new Error(`Profile discovery budget exhausted; take a delivery action with ${[...deliveryTools].join(", ")}, or final.`);
      }
    }
    const result = await executor(toolInput);
    if (name === "codex.run" || name === "agent.delegate") {
      const parsed = tryParseJsonRecord(result.output);
      const jobId = asString(parsed?.jobId);
      const status = asString(parsed?.status);
      if (jobId && isActiveJobStatus(status)) activeAsyncChildJobs.add(jobId);
    }
    if (deliveryTools.has(name)) deliveryStarted = true;
    return result;
  }])) as Readonly<Record<string, AgentToolExecutor>>;
};

const createFactoryChatFinalizer = (input: {
  readonly queue: JsonlQueue;
  readonly profile: FactoryChatResolvedProfile;
}): NonNullable<AgentRunInput["finalizer"]> =>
  async ({ runId, text }) => {
    const activeChildJobs = (await listChildJobsForRun(input.queue, runId))
      .filter((job) => isActiveJobStatus(job.status));
    if (activeChildJobs.length === 0) {
      return { accept: true, text };
    }
    if (input.profile.orchestration.finalWhileChildRunning === "allow") {
      return { accept: true, text };
    }
    if (input.profile.orchestration.finalWhileChildRunning === "reject") {
      return {
        accept: false,
        note: "final response rejected because child work is still running",
      };
    }
    return {
      accept: true,
      text: buildActiveChildWaitingMessage(activeChildJobs),
      note: "final response rewritten because child work is still running",
    };
  };

const createProfileHandoffTool = (input: {
  readonly currentProfile: FactoryChatResolvedProfile;
  readonly repoRoot: string;
  readonly profileRoot: string;
  readonly runId: string;
  readonly repoKey: string;
  readonly queue: JsonlQueue;
  readonly problem: string;
  readonly config: FactoryChatRunConfig;
  readonly memoryTools: MemoryTools;
  readonly objectiveId?: string;
}): AgentToolExecutor =>
  async (toolInput) => {
    const targetProfileId = asString(toolInput.profileId) ?? asString(toolInput.targetProfileId);
    if (!targetProfileId) throw new Error("profile.handoff requires profileId");
    if (input.currentProfile.handoffTargets.length > 0 && !input.currentProfile.handoffTargets.includes(targetProfileId)) {
      throw new Error(`profile '${input.currentProfile.root.id}' cannot hand off to '${targetProfileId}'`);
    }
    const target = await resolveFactoryChatProfile({
      repoRoot: input.repoRoot,
      profileRoot: input.profileRoot,
      requestedId: targetProfileId,
    });
    const reason = asString(toolInput.reason) ?? `handoff from ${input.currentProfile.root.id}`;
    const handoffRunId = nextId("run");
    const stream = factoryChatStream(input.repoRoot, target.root.id, input.objectiveId);
    const config = normalizeFactoryChatConfig({
      maxIterations: input.config.maxIterations,
      maxToolOutputChars: input.config.maxToolOutputChars,
      workspace: input.config.workspace,
      memoryScope: FACTORY_CHAT_DEFAULT_CONFIG.memoryScope,
    });
    const created = await input.queue.enqueue({
      agentId: "factory",
      lane: "collect",
      sessionKey: `factory-chat:${stream}`,
      singletonMode: "allow",
      maxAttempts: 1,
      payload: {
        kind: "factory.run",
        stream,
        runId: handoffRunId,
        problem: input.problem,
        profileId: target.root.id,
        ...(input.objectiveId ? { objectiveId: input.objectiveId } : {}),
        config,
      },
    });
    await commitWorkerSummary(
      input.memoryTools,
      profileMemoryScope(input.repoKey, input.currentProfile.root.id),
      `handoff to ${target.root.id}: ${reason}`,
      {
        runId: input.runId,
        fromProfileId: input.currentProfile.root.id,
        toProfileId: target.root.id,
        handoffJobId: created.id,
        handoffRunId,
      },
    );
    return {
      output: JSON.stringify({
        worker: "profile",
        status: created.status,
        fromProfileId: input.currentProfile.root.id,
        toProfileId: target.root.id,
        summary: reason,
        jobId: created.id,
        runId: handoffRunId,
        stream,
        link: `/factory?profile=${encodeURIComponent(target.root.id)}${input.objectiveId ? `&objective=${encodeURIComponent(input.objectiveId)}` : ""}&job=${encodeURIComponent(created.id)}&run=${encodeURIComponent(handoffRunId)}`,
      }, null, 2),
      summary: `queued handoff to ${target.root.label}`,
      events: [{
        type: "profile.handoff",
        runId: input.runId,
        agentId: "orchestrator",
        fromProfileId: input.currentProfile.root.id,
        toProfileId: target.root.id,
        reason,
      }],
    };
  };

export const normalizeFactoryChatConfig = (input: Partial<FactoryChatRunConfig>): FactoryChatRunConfig =>
  normalizeAgentConfig({
    ...FACTORY_CHAT_DEFAULT_CONFIG,
    ...input,
  });

export const runFactoryChat = async (input: FactoryChatRunInput): Promise<AgentRunResult> => {
  const repoRoot = path.resolve(input.repoRoot);
  const profileRoot = path.resolve(input.profileRoot ?? repoRoot);
  const resolvedProfile = await resolveFactoryChatProfile({
    repoRoot,
    profileRoot,
    requestedId: input.profileId,
    problem: input.problem,
  });
  const repoKey = repoKeyForRoot(repoRoot);
  const resolvedStream = factoryChatStream(repoRoot, resolvedProfile.root.id, input.objectiveId);
  const resolvedMemoryScope = input.config.memoryScope === FACTORY_CHAT_DEFAULT_CONFIG.memoryScope
    ? (input.objectiveId
      ? objectiveMemoryScope(repoKey, resolvedProfile.root.id, input.objectiveId)
      : profileMemoryScope(repoKey, resolvedProfile.root.id))
    : input.config.memoryScope;
  const extraTools = withProfileOrchestrationPolicy({
    profile: resolvedProfile,
    queue: input.queue,
    runId: input.runId,
  }, {
    "agent.delegate": createAsyncDelegateTool({
      queue: input.queue,
      runId: input.runId,
      stream: input.stream,
      repoKey,
      objectiveId: input.objectiveId,
      memoryTools: input.memoryTools,
      profile: resolvedProfile,
    }),
    "agent.status": createJobStatusTool({
      queue: input.queue,
      currentJobId: input.control?.jobId,
    }),
    "jobs.list": createJobsListTool({
      queue: input.queue,
      stream: input.stream,
      profile: resolvedProfile,
    }),
    "job.control": createJobControlTool({
      queue: input.queue,
      currentJobId: input.control?.jobId,
    }),
    "codex.run": createCodexRunTool({
      repoRoot,
      repoKey,
      queue: input.queue,
      runId: input.runId,
      stream: input.stream,
      objectiveId: input.objectiveId,
      memoryTools: input.memoryTools,
      profile: resolvedProfile,
    }),
    "factory.dispatch": createFactoryDispatchTool({
      factoryService: input.factoryService,
      repoKey,
      runId: input.runId,
      memoryTools: input.memoryTools,
    }),
    "factory.status": createFactoryStatusTool({
      factoryService: input.factoryService,
    }),
    "profile.handoff": createProfileHandoffTool({
      currentProfile: resolvedProfile,
      repoRoot,
      profileRoot,
      runId: input.runId,
      repoKey,
      queue: input.queue,
      problem: input.problem,
      config: input.config,
      memoryTools: input.memoryTools,
      objectiveId: input.objectiveId,
    }),
    ...(input.extraTools ?? {}),
  });
  return runAgent({
    ...input,
    config: {
      ...input.config,
      memoryScope: resolvedMemoryScope,
    },
    prompts: {
      system: resolvedProfile.systemPrompt,
      user: { loop: FACTORY_CHAT_LOOP_TEMPLATE },
    },
    promptHash: resolvedProfile.promptHash,
    promptPath: resolvedProfile.promptPath,
    workflowId: FACTORY_CHAT_WORKFLOW_ID,
    workflowVersion: FACTORY_CHAT_WORKFLOW_VERSION,
    toolAllowlist: resolvedProfile.toolAllowlist,
    startupEvents: [
      {
        type: "profile.selected",
        runId: input.runId,
        agentId: "orchestrator",
        profileId: resolvedProfile.root.id,
        reason: resolvedProfile.selectionReason,
      },
      {
        type: "profile.resolved",
        runId: input.runId,
        agentId: "orchestrator",
        rootProfileId: resolvedProfile.root.id,
        importedProfileIds: resolvedProfile.imports.map((profile) => profile.id),
        profilePaths: resolvedProfile.profilePaths,
        fileHashes: resolvedProfile.fileHashes,
        resolvedHash: resolvedProfile.resolvedHash,
      },
    ],
    extraConfig: {
      ...(input.extraConfig ?? {}),
      repoRoot,
      profileRoot,
      repoKey,
      repoMemoryScope: repoMemoryScope(repoKey),
      profileMemoryScope: resolvedMemoryScope,
      profileId: resolvedProfile.root.id,
      objectiveId: input.objectiveId,
      importedProfiles: resolvedProfile.imports.map((profile) => profile.id),
      resolvedProfileHash: resolvedProfile.resolvedHash,
      orchestrationPolicy: resolvedProfile.orchestration,
      stream: resolvedStream,
    },
    extraToolSpecs: {
      "agent.delegate": "{\"agentId\": string, \"task\": string, \"config\"?: object} — Queue a Receipt-native subagent and return its live job handle immediately.",
      "agent.status": "{\"jobId\": string} — Inspect a queued or running child job and return its latest normalized state. Do not pass the current factory job id.",
      "jobs.list": "{\"limit\"?: number, \"status\"?: string, \"includeCompleted\"?: boolean} — List recent jobs related to the current Factory profile thread.",
      "job.control": "{\"jobId\": string, \"command\": \"steer\"|\"follow_up\"|\"abort\", \"problem\"?: string, \"config\"?: object, \"note\"?: string, \"reason\"?: string} — Queue a steer, follow-up, or abort command for a running child job. Do not pass the current factory job id.",
      "codex.run": "{\"prompt\": string, \"timeoutMs\"?: number} — Queue a focused Codex run against the repo and return its live child job handle immediately. Reuse that returned jobId for agent.status/job.control.",
      "factory.dispatch": "{\"action\"?: \"create\"|\"react\"|\"promote\"|\"cancel\"|\"cleanup\"|\"archive\", \"objectiveId\"?: string, \"prompt\"?: string, \"title\"?: string, \"baseHash\"?: string, \"checks\"?: string[], \"channel\"?: string, \"reason\"?: string} — Create or operate on a Factory objective. 'react' means re-evaluate the objective and dispatch the next eligible work.",
      "factory.status": "{\"objectiveId\": string} — Inspect an existing Factory objective and return a concise status summary.",
      "profile.handoff": "{\"profileId\": string, \"reason\"?: string} — Hand off the conversation to another Factory profile thread.",
      ...(input.extraToolSpecs ?? {}),
    },
    extraTools,
    finalizer: createFactoryChatFinalizer({
      queue: input.queue,
      profile: resolvedProfile,
    }),
  });
};

export const runFactoryCodexJob = async (input: {
  readonly dataDir: string;
  readonly repoRoot: string;
  readonly jobId: string;
  readonly prompt: string;
  readonly executor: CodexExecutor;
  readonly timeoutMs?: number;
  readonly onProgress?: (update: Record<string, unknown>) => Promise<void>;
}, control?: CodexRunControl): Promise<Record<string, unknown>> => {
  const root = path.join(input.dataDir, "factory-chat", "codex", input.jobId);
  await fs.mkdir(root, { recursive: true });
  const lastMessagePath = path.join(root, "last-message.txt");
  const stdoutPath = path.join(root, "stdout.log");
  const stderrPath = path.join(root, "stderr.log");
  let progressStopped = false;
  let lastFingerprint = "";
  const emitProgress = async (): Promise<void> => {
    const [lastMessageRaw, stdoutRaw, stderrRaw] = await Promise.all([
      fs.readFile(lastMessagePath, "utf-8").catch(() => ""),
      fs.readFile(stdoutPath, "utf-8").catch(() => ""),
      fs.readFile(stderrPath, "utf-8").catch(() => ""),
    ]);
    const update = {
      worker: "codex",
      status: "running",
      lastMessage: asString(lastMessageRaw),
      stdoutTail: tail(stdoutRaw),
      stderrTail: tail(stderrRaw),
    };
    const next = {
      ...update,
      summary: summarizeChildProgress(update),
    };
    const fingerprint = JSON.stringify(next);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    await input.onProgress?.(next);
  };
  const progressLoop = (async () => {
    while (!progressStopped) {
      await emitProgress();
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  })();
  let result: Awaited<ReturnType<CodexExecutor["run"]>>;
  try {
    result = await input.executor.run({
      prompt: input.prompt,
      workspacePath: input.repoRoot,
      promptPath: path.join(root, "prompt.md"),
      lastMessagePath,
      stdoutPath,
      stderrPath,
      timeoutMs: input.timeoutMs,
    }, control);
  } finally {
    progressStopped = true;
    await progressLoop;
  }
  await emitProgress();
  const changedFiles = await gitChangedFiles(input.repoRoot);
  return {
    status: "completed",
    summary: asString(result.lastMessage) ?? "Codex completed.",
    lastMessage: asString(result.lastMessage),
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
    changedFiles,
  };
};
