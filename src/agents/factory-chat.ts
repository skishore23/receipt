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
  isStuckProgress,
  type AgentRunConfig,
  type AgentRunInput,
  type AgentRunResult,
  type AgentToolExecutor,
} from "./agent";
import type { JsonlQueue, QueueJob } from "../adapters/jsonl-queue";
import type {
  FactoryService,
  FactoryObjectiveInput,
  FactoryObjectiveReceiptSummary,
} from "../services/factory-service";
import {
  factoryChatStream,
  factoryChatSessionStream,
  repoKeyForRoot,
  resolveFactoryChatProfile,
  type FactoryChatResolvedProfile,
} from "../services/factory-chat-profiles";
import type { CodexExecutor, CodexRunControl } from "../adapters/codex-executor";
import type { MemoryTools } from "../adapters/memory-tools";
import {
  factoryChatCodexArtifactPaths,
  readTextTail,
} from "../services/factory-codex-artifacts";
import { readRepoStatus } from "../lib/repo-status";

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

const FACTORY_CHAT_ITERATION_LADDER = [8, 12, 16, 24, 32, 40] as const;

export type FactoryChatRunInput = Omit<AgentRunInput, "config" | "prompts" | "llmStructured"> & {
  readonly config: FactoryChatRunConfig;
  readonly queue: JsonlQueue;
  readonly factoryService: FactoryService;
  readonly dataDir?: string;
  readonly repoRoot: string;
  readonly profileRoot?: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly llmStructured: <Schema extends ZodTypeAny>(opts: {
    readonly system?: string;
    readonly user: string;
    readonly schema: Schema;
    readonly schemaName: string;
  }) => Promise<{ readonly parsed: ZodInfer<Schema>; readonly raw: string }>;
  readonly profileId?: string;
  readonly continuationDepth?: number;
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
  "Current situation:",
  "{{situation}}",
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
  "Orchestration rules:",
  "- Profiles are orchestration-only. Do not claim this chat edited code directly.",
  "- Use `codex.run` only for lightweight read-only inspection or evidence-gathering in the current repo.",
  "- Use `factory.dispatch` for any code-changing delivery work, any substantive infrastructure investigation, or when the next step should run in an objective worktree.",
  "- If a completed objective already contains the answer in `factory.status`, `factory.receipts`, or `factory.output`, answer directly instead of dispatching new work just to restate saved results.",
  "- Before `react`, `promote`, `cancel`, or duplicate dispatch, ground the decision in the current situation, receipts, or live output.",
  "- When child work is already active, prefer `codex.status`, `factory.status`, or `factory.output` with `waitForChangeMs` so you wait for real progress instead of tight polling.",
  "- If investigation reports disagree or reconciliation is pending, do not finalize yet. Inspect status/receipts and wait for the objective to align or block.",
  "",
  "For final answers to the user:",
  "- write plain language, not raw JSON",
  "- keep it concise and operator-facing",
  "- prefer the words Skill, Chat, and Work",
  "- mention objective, run, and job only when needed for debugging or inspection",
  "- for investigation work, use a short conversational lead followed by sections named Conclusion, Evidence, Disagreements, Scripts Run, Artifacts, and Next Steps",
  "- if code changes are needed, route them through Factory objective work instead of claiming this chat changed code directly",
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

const chatIdFromFactoryStream = (stream: string | undefined): string | undefined => {
  const value = stream?.trim();
  if (!value) return undefined;
  const marker = "/sessions/";
  const index = value.lastIndexOf(marker);
  if (index < 0) return undefined;
  const encoded = value.slice(index + marker.length).trim();
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
};

const clip = (value: string, max = 160): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const clampWaitMs = (value: unknown, max = 20_000): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(Math.floor(value), max))
    : 0;

const waitForSnapshotChange = async <T>(
  initial: T,
  waitMs: number,
  snapshot: () => Promise<T>,
): Promise<{ readonly value: T; readonly waitedMs: number; readonly changed: boolean }> => {
  if (waitMs <= 0) return { value: initial, waitedMs: 0, changed: false };
  const startedAt = Date.now();
  const initialFingerprint = JSON.stringify(initial);
  let current = initial;
  while (Date.now() - startedAt < waitMs) {
    const remaining = waitMs - (Date.now() - startedAt);
    await delay(Math.min(1_000, Math.max(50, remaining)));
    current = await snapshot();
    if (JSON.stringify(current) !== initialFingerprint) {
      return {
        value: current,
        waitedMs: Date.now() - startedAt,
        changed: true,
      };
    }
  }
  return {
    value: current,
    waitedMs: Date.now() - startedAt,
    changed: false,
  };
};

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

const parseContinuationDepth = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(Math.floor(value), 16))
    : 0;

const nextIterationBudget = (current: number): number | undefined =>
  FACTORY_CHAT_ITERATION_LADDER.find((candidate) => candidate > current);

const stableCodexSessionKey = (runId: string, prompt: string): string =>
  `codex:${runId}:${createHash("sha1").update(prompt).digest("hex").slice(0, 12)}`;

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
    mode: asString(result?.mode) ?? asString(job.payload.mode),
    readOnly: result?.readOnly === true || job.payload.readOnly === true,
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

const jobMatchesProfileContext = (
  job: QueueJob,
  input: {
    readonly runId?: string;
    readonly stream: string;
    readonly profileId: string;
    readonly objectiveId?: string;
  },
): boolean => {
  const parentRunId = asString(job.payload.parentRunId);
  const parentStream = asString(job.payload.parentStream);
  const payloadStream = asString(job.payload.stream);
  const profileId = asString(job.payload.profileId);
  const objectiveId = asString(job.payload.objectiveId);
  return parentRunId === input.runId
    || parentStream === input.stream
    || payloadStream === input.stream
    || profileId === input.profileId
    || (Boolean(input.objectiveId) && objectiveId === input.objectiveId);
};

const codexJobPriority = (
  job: QueueJob,
  input: {
    readonly runId: string;
    readonly objectiveId?: string;
  },
): number => {
  if (asString(job.payload.parentRunId) === input.runId) return 3;
  if (input.objectiveId && asString(job.payload.objectiveId) === input.objectiveId) return 2;
  return isActiveJobStatus(job.status) ? 1 : 0;
};

const buildActiveChildWaitingMessage = (jobs: ReadonlyArray<QueueJob>): string => {
  const snapshots = jobs.map((job) => normalizeJobSnapshot(job));
  const primary = snapshots[0];
  if (!primary) return "A child job is still running. Live updates will continue in this project chat.";
  const summary = asString(primary.summary) ?? "Child work is still running.";
  const lines = [
    `Child work is still running as ${asString(primary.jobId) ?? "unknown job"} (${asString(primary.status) ?? "running"}).`,
    "Live updates will continue in this project chat automatically.",
    "",
    `Latest child summary: ${summary}`,
  ];
  if (snapshots.length > 1) {
    lines.push("", `Active child jobs: ${snapshots.map((snapshot) => asString(snapshot.jobId) ?? "unknown").join(", ")}`);
  }
  return lines.join("\n");
};

const summarizeObjectiveReceipts = (receipts: ReadonlyArray<FactoryObjectiveReceiptSummary>, limit = 5): ReadonlyArray<string> =>
  receipts.slice(-Math.max(1, limit)).map((receipt) => `- ${receipt.type}: ${receipt.summary}`);

const buildFactorySituation = async (input: {
  readonly queue: JsonlQueue;
  readonly runId: string;
  readonly stream: string;
  readonly profile: FactoryChatResolvedProfile;
  readonly getCurrentObjectiveId: () => string | undefined;
  readonly factoryService: FactoryService;
  readonly dataDir?: string;
}): Promise<string> => {
  const lines = [`Profile: ${input.profile.root.label} (${input.profile.root.id})`];
  const childJobs = await listChildJobsForRun(input.queue, input.runId);
  const activeChildren = childJobs.filter((job) => isActiveJobStatus(job.status));
  const canInspectObjective = typeof input.factoryService.getObjective === "function"
    && typeof input.factoryService.getObjectiveDebug === "function"
    && typeof input.factoryService.listObjectiveReceipts === "function";
  const objectiveId = input.getCurrentObjectiveId();
  if (objectiveId && canInspectObjective) {
    try {
      const [detail, debug, receipts] = await Promise.all([
        input.factoryService.getObjective(objectiveId),
        input.factoryService.getObjectiveDebug(objectiveId),
        input.factoryService.listObjectiveReceipts(objectiveId, { limit: 8 }),
      ]);
      lines.push(`Objective: ${detail.title} (${detail.objectiveId})`);
      lines.push(`Status: ${detail.status} · phase ${detail.phase} · integration ${detail.integration.status}`);
      lines.push(`Mode: ${detail.objectiveMode} · severity ${detail.severity} · reconciliation ${detail.reconciliationStatus}`);
      if (detail.latestDecision?.summary) lines.push(`Latest decision: ${detail.latestDecision.summary}`);
      if (detail.blockedExplanation?.summary) lines.push(`Blocked: ${detail.blockedExplanation.summary}`);
      const activeJobs = debug.activeJobs.slice(0, 3);
      if (activeJobs.length > 0) {
        lines.push("Active jobs:");
        lines.push(...activeJobs.map((job) => `- ${job.id}: ${job.agentId} ${job.status}`));
      }
      const receiptLines = summarizeObjectiveReceipts(receipts, 5);
      if (receiptLines.length > 0) {
        lines.push("Recent receipts:");
        lines.push(...receiptLines);
      }
    } catch (err: unknown) {
      const status = typeof err === "object" && err !== null && "status" in err
        ? (err as { readonly status?: unknown }).status
        : undefined;
      const message = err instanceof Error ? err.message : undefined;
      if (status === 404 || message?.includes("not found")) {
        lines.push(`Objective: ${objectiveId}`);
        lines.push("Objective has not been created yet.");
      } else {
        throw err;
      }
    }
  } else if (objectiveId) {
    lines.push(`Objective: ${objectiveId}`);
    lines.push("Objective detail is not available in this runtime.");
  } else if (activeChildren.length > 0) {
    lines.push("Active child jobs:");
    const snapshots = await Promise.all(activeChildren.slice(0, 3).map((job) => codexJobSnapshot(job, input.dataDir)));
    lines.push(...snapshots.map((snapshot) =>
      `- ${String(snapshot.jobId)}: ${String(snapshot.worker)} ${String(snapshot.status)}${asString(snapshot.summary) ? ` · ${String(snapshot.summary)}` : ""}`
    ));
  } else {
    lines.push("No active objective or child work.");
  }
  return lines.join("\n");
};

const codexJobSnapshot = async (job: QueueJob, dataDir?: string): Promise<Record<string, unknown>> => {
  const base = normalizeJobSnapshot(job);
  if (job.agentId !== "codex" || !dataDir) return base;
  const artifacts = factoryChatCodexArtifactPaths(dataDir, job.id);
  const [lastMessage, stdoutTail, stderrTail] = await Promise.all([
    readTextTail(artifacts.lastMessagePath, 400),
    readTextTail(artifacts.stdoutPath, 900),
    readTextTail(artifacts.stderrPath, 600),
  ]);
  return {
    ...base,
    artifacts,
    lastMessage: lastMessage ?? base.lastMessage,
    stdoutTail: stdoutTail ?? base.stdoutTail,
    stderrTail: stderrTail ?? base.stderrTail,
  };
};

const createCodexRunTool = (input: {
  readonly repoRoot: string;
  readonly repoKey: string;
  readonly queue: JsonlQueue;
  readonly runId: string;
  readonly stream: string;
  readonly getCurrentObjectiveId: () => string | undefined;
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
      : `codex:${input.stream}:${Date.now().toString(36)}`;
    const singletonMode = input.profile.orchestration.childDedupe === "by_run_and_prompt"
      ? "steer"
      : "allow";
    const created = await input.queue.enqueue({
      agentId: "codex",
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
        ...(input.getCurrentObjectiveId() ? { objectiveId: input.getCurrentObjectiveId() } : {}),
        mode: "read_only_probe",
        readOnly: true,
        task: prompt,
        prompt,
        timeoutMs,
      },
    });
    const result: Record<string, unknown> = {
      ...normalizeJobSnapshot(created),
      worker: "codex",
      mode: "read_only_probe",
      readOnly: true,
      summary: `codex read-only probe queued as ${created.id}`,
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
  readonly getCurrentObjectiveId: () => string | undefined;
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
        ...(input.getCurrentObjectiveId() ? { objectiveId: input.getCurrentObjectiveId() } : {}),
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
  readonly runId: string;
  readonly getCurrentObjectiveId: () => string | undefined;
}): AgentToolExecutor =>
  async (toolInput) => {
    const limit = typeof toolInput.limit === "number" && Number.isFinite(toolInput.limit)
      ? Math.max(1, Math.min(Math.floor(toolInput.limit), 30))
      : 10;
    const includeCompleted = toolInput.includeCompleted === true;
    const statusFilter = asString(toolInput.status);
    const objectiveId = input.getCurrentObjectiveId();
    const jobs = await input.queue.listJobs({ limit: 120 });
    const filtered = jobs
      .filter((job) => jobMatchesProfileContext(job, {
        runId: input.runId,
        stream: input.stream,
        profileId: input.profile.root.id,
        objectiveId,
      }))
      .filter((job) => includeCompleted || (job.status !== "completed" && job.status !== "failed" && job.status !== "canceled"))
      .filter((job) => !statusFilter || job.status === statusFilter)
      .slice(0, limit)
      .map((job) => normalizeJobSnapshot(job));
    return {
      output: JSON.stringify(filtered, null, 2),
      summary: `${filtered.length} jobs`,
    };
  };

const createCodexStatusTool = (input: {
  readonly queue: JsonlQueue;
  readonly runId: string;
  readonly stream: string;
  readonly profile: FactoryChatResolvedProfile;
  readonly getCurrentObjectiveId: () => string | undefined;
  readonly dataDir?: string;
}): AgentToolExecutor =>
  async (toolInput) => {
    const waitForChangeMs = clampWaitMs(toolInput.waitForChangeMs);
    const buildStatus = async (): Promise<Record<string, unknown>> => {
      const objectiveId = input.getCurrentObjectiveId();
      const jobId = asString(toolInput.jobId);
      if (jobId) {
        const job = await input.queue.getJob(jobId);
        if (!job) throw new Error(`job ${jobId} not found`);
        if (job.agentId !== "codex") throw new Error(`job ${jobId} is not a codex job`);
        const snapshot = await codexJobSnapshot(job, input.dataDir);
        return {
          worker: "codex",
          activeCount: isActiveJobStatus(job.status) ? 1 : 0,
          latest: snapshot,
          jobs: [snapshot],
        };
      }
      const limit = typeof toolInput.limit === "number" && Number.isFinite(toolInput.limit)
        ? Math.max(1, Math.min(Math.floor(toolInput.limit), 10))
        : 5;
      const includeCompleted = toolInput.includeCompleted === true;
      const jobs = (await input.queue.listJobs({ limit: 200 }))
        .filter((job) => job.agentId === "codex")
        .filter((job) => jobMatchesProfileContext(job, {
          runId: input.runId,
          stream: input.stream,
          profileId: input.profile.root.id,
          objectiveId,
        }))
        .filter((job) => includeCompleted || isActiveJobStatus(job.status))
        .sort((left, right) =>
          codexJobPriority(right, { runId: input.runId, objectiveId })
          - codexJobPriority(left, { runId: input.runId, objectiveId })
          || right.updatedAt - left.updatedAt);
      const snapshots = await Promise.all(jobs.slice(0, limit).map((job) => codexJobSnapshot(job, input.dataDir)));
      return {
        worker: "codex",
        activeCount: jobs.filter((job) => isActiveJobStatus(job.status)).length,
        latest: snapshots[0] ?? null,
        jobs: snapshots,
      };
    };
    const initial = await buildStatus();
    const waited = waitForChangeMs > 0 && Number(initial.activeCount ?? 0) > 0
      ? await waitForSnapshotChange(initial, waitForChangeMs, buildStatus)
      : { value: initial, waitedMs: 0, changed: false };
    const payload = waited.waitedMs > 0
      ? { ...waited.value, waitedMs: waited.waitedMs, changed: waited.changed }
      : waited.value;
    const snapshots = Array.isArray(payload.jobs)
      ? payload.jobs as ReadonlyArray<Record<string, unknown>>
      : [];
    const latest = snapshots[0];
    const activeCount = Number(payload.activeCount ?? 0);
    const summary = latest
      ? activeCount > 0
        ? `codex active: ${String(latest.jobId)} (${String(latest.status)})`
        : `latest codex job ${String(latest.jobId)} is ${String(latest.status)}`
      : "no codex jobs found for this context";
    return {
      output: JSON.stringify(payload, null, 2),
      summary: `${summary}${waited.waitedMs > 0 ? ` after waiting ${waited.waitedMs}ms` : ""}`,
      pauseBudget: waited.waitedMs > 0 && waited.changed === false,
    };
  };

const createCodexLogsTool = (input: {
  readonly queue: JsonlQueue;
  readonly runId: string;
  readonly stream: string;
  readonly profile: FactoryChatResolvedProfile;
  readonly getCurrentObjectiveId: () => string | undefined;
  readonly dataDir: string;
}): AgentToolExecutor =>
  async (toolInput) => {
    const objectiveId = input.getCurrentObjectiveId();
    const requestedJobId = asString(toolInput.jobId);
    const targetJob = requestedJobId
      ? await input.queue.getJob(requestedJobId)
      : (await input.queue.listJobs({ limit: 200 }))
        .filter((job) => job.agentId === "codex")
        .filter((job) => jobMatchesProfileContext(job, {
          runId: input.runId,
          stream: input.stream,
          profileId: input.profile.root.id,
          objectiveId,
        }))
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (!targetJob) throw new Error(requestedJobId ? `job ${requestedJobId} not found` : "no codex jobs found for this context");
    if (targetJob.agentId !== "codex") throw new Error(`job ${targetJob.id} is not a codex job`);
    const snapshot = await codexJobSnapshot(targetJob, input.dataDir);
    return {
      output: JSON.stringify({
        worker: "codex",
        action: "logs",
        ...snapshot,
      }, null, 2),
      summary: `codex logs ${targetJob.id}: ${String(snapshot.status ?? targetJob.status)}`,
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

const createRepoStatusTool = (input: {
  readonly repoRoot: string;
}): AgentToolExecutor =>
  async () => {
    const status = await readRepoStatus(path.resolve(input.repoRoot));
    return {
      output: JSON.stringify({
        worker: "repo",
        action: "status",
        ...status,
      }, null, 2),
      summary: `${status.branch}@${status.baseHash.slice(0, 8)} ${status.dirty ? `dirty (${status.changedCount})` : "clean"}`,
    };
  };

const latestObjectiveByStream = new Map<string, string>();

const createFactoryDispatchTool = (input: {
  readonly factoryService: FactoryService;
  readonly repoKey: string;
  readonly runId: string;
  readonly stream: string;
  readonly memoryTools: MemoryTools;
  readonly profileId: string;
  readonly getCurrentObjectiveId: () => string | undefined;
  readonly setCurrentObjectiveId: (objectiveId: string | undefined) => void;
}): AgentToolExecutor =>
  async (toolInput) => {
    const requestedObjectiveId = asString(toolInput.objectiveId);
    const objectiveId = requestedObjectiveId ?? input.getCurrentObjectiveId();
    const action = asString(toolInput.action) ?? (objectiveId ? "react" : "create");
    let detail: Awaited<ReturnType<FactoryService["getObjective"]>>;
    let reused = false;
    let bindingReason: "dispatch_create" | "dispatch_reuse" | "dispatch_update" = "dispatch_update";
    if (action === "create") {
      const prompt = asString(toolInput.prompt);
      if (!prompt) throw new Error("factory.dispatch create requires prompt");
      const existingObjectiveId = latestObjectiveByStream.get(input.stream);
      const existing = existingObjectiveId
        ? await input.factoryService.getObjective(existingObjectiveId).catch(() => undefined)
        : undefined;
      if (existing && !existing.archivedAt && !isTerminalObjectiveStatus(existing.status)) {
        detail = await input.factoryService.reactObjectiveWithNote(existing.objectiveId, prompt);
        reused = true;
        bindingReason = "dispatch_reuse";
      } else {
        const payload: FactoryObjectiveInput = {
          objectiveId: requestedObjectiveId,
          title: asString(toolInput.title) ?? deriveObjectiveTitle(prompt),
          prompt,
          baseHash: asString(toolInput.baseHash),
          objectiveMode: toolInput.objectiveMode === "investigation" || toolInput.objectiveMode === "delivery"
            ? toolInput.objectiveMode
            : undefined,
          severity: typeof toolInput.severity === "number" && Number.isInteger(toolInput.severity)
            && toolInput.severity >= 1 && toolInput.severity <= 5
            ? toolInput.severity as FactoryObjectiveInput["severity"]
            : undefined,
          checks: asStringList(toolInput.checks),
          channel: asString(toolInput.channel),
          profileId: input.profileId,
          startImmediately: true,
        };
        detail = await input.factoryService.createObjective(payload);
        bindingReason = "dispatch_create";
      }
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
    if (detail.archivedAt || isTerminalObjectiveStatus(detail.status)) {
      latestObjectiveByStream.delete(input.stream);
    } else {
      latestObjectiveByStream.set(input.stream, detail.objectiveId);
    }
    await commitWorkerSummary(
      input.memoryTools,
      workerMemoryScope(input.repoKey, "factory"),
      toolSummary("factory", summary.status, summary.summary),
      { runId: input.runId, objectiveId: summary.objectiveId, action },
    );
    input.setCurrentObjectiveId(detail.objectiveId);
    const chatId = chatIdFromFactoryStream(input.stream);
    return {
      output: JSON.stringify({ worker: "factory", action, reused, ...summary }, null, 2),
      summary: summary.summary,
      events: [{
        type: "thread.bound",
        runId: input.runId,
        agentId: "orchestrator",
        objectiveId: detail.objectiveId,
        ...(chatId ? { chatId } : {}),
        reason: bindingReason,
        created: action === "create" && reused === false,
      }],
    };
  };

const createFactoryStatusTool = (input: {
  readonly factoryService: FactoryService;
  readonly getCurrentObjectiveId: () => string | undefined;
}): AgentToolExecutor =>
  async (toolInput) => {
    const objectiveId = asString(toolInput.objectiveId) ?? input.getCurrentObjectiveId();
    if (!objectiveId) throw new Error("factory.status requires objectiveId");
    const waitForChangeMs = clampWaitMs(toolInput.waitForChangeMs);
    const buildStatus = async (): Promise<Record<string, unknown>> => {
      const [detail, debug, receipts] = await Promise.all([
        input.factoryService.getObjective(objectiveId),
        input.factoryService.getObjectiveDebug(objectiveId),
        input.factoryService.listObjectiveReceipts(objectiveId, { limit: 20 }),
      ]);
      const summary = summarizeObjective(detail);
      return {
        worker: "factory",
        action: "status",
        ...summary,
        latestDecision: detail.latestDecision,
        blockedExplanation: detail.blockedExplanation,
        evidenceCards: Array.isArray(detail.evidenceCards) ? detail.evidenceCards.slice(-8) : [],
        recentReceipts: receipts,
        activeJobs: debug.activeJobs,
        taskWorktrees: debug.taskWorktrees,
        integrationWorktree: debug.integrationWorktree,
        latestContextPacks: debug.latestContextPacks,
      };
    };
    const initial = await buildStatus();
    const waited = waitForChangeMs > 0 && (
      asString(initial.status) === "queued"
      || asString(initial.status) === "active"
      || asString(initial.status) === "executing"
      || (Array.isArray(initial.activeJobs) && initial.activeJobs.length > 0)
    )
      ? await waitForSnapshotChange(initial, waitForChangeMs, buildStatus)
      : { value: initial, waitedMs: 0, changed: false };
    const payload = waited.waitedMs > 0
      ? { ...waited.value, waitedMs: waited.waitedMs, changed: waited.changed }
      : waited.value;
    return {
      output: JSON.stringify(payload, null, 2),
      summary: `${String(payload.summary ?? payload.title ?? objectiveId)}${waited.waitedMs > 0 ? ` after waiting ${waited.waitedMs}ms` : ""}`,
      pauseBudget: waited.waitedMs > 0 && waited.changed === false,
    };
  };

const createFactoryOutputTool = (input: {
  readonly factoryService: FactoryService;
  readonly getCurrentObjectiveId: () => string | undefined;
}): AgentToolExecutor =>
  async (toolInput) => {
    const objectiveId = asString(toolInput.objectiveId) ?? input.getCurrentObjectiveId();
    const focusKind = asString(toolInput.focusKind);
    const focusId = asString(toolInput.focusId);
    if (!objectiveId) throw new Error("factory.output requires objectiveId");
    if (focusKind !== "task" && focusKind !== "job") {
      throw new Error("factory.output requires focusKind of 'task' or 'job'");
    }
    if (!focusId) throw new Error("factory.output requires focusId");
    const waitForChangeMs = clampWaitMs(toolInput.waitForChangeMs);
    const buildOutput = async (): Promise<Record<string, unknown>> => ({
      worker: "factory",
      action: "output",
      ...await input.factoryService.getObjectiveLiveOutput(objectiveId, focusKind, focusId),
    });
    const initial = await buildOutput();
    const waited = waitForChangeMs > 0 && initial.active === true
      ? await waitForSnapshotChange(initial, waitForChangeMs, buildOutput)
      : { value: initial, waitedMs: 0, changed: false };
    const payload = waited.waitedMs > 0
      ? { ...waited.value, waitedMs: waited.waitedMs, changed: waited.changed }
      : waited.value;
    return {
      output: JSON.stringify(payload, null, 2),
      summary: `${String(payload.summary ?? `${focusKind} ${focusId}: ${String(payload.status ?? "unknown")}`)}${waited.waitedMs > 0 ? ` after waiting ${waited.waitedMs}ms` : ""}`,
      pauseBudget: waited.waitedMs > 0 && waited.changed === false,
    };
  };

const createFactoryReceiptsTool = (input: {
  readonly factoryService: FactoryService;
  readonly getCurrentObjectiveId: () => string | undefined;
}): AgentToolExecutor =>
  async (toolInput) => {
    const objectiveId = asString(toolInput.objectiveId) ?? input.getCurrentObjectiveId();
    if (!objectiveId) throw new Error("factory.receipts requires objectiveId");
    const limit = typeof toolInput.limit === "number" && Number.isFinite(toolInput.limit)
      ? Math.max(1, Math.min(Math.floor(toolInput.limit), 40))
      : 12;
    const types = Array.isArray(toolInput.types)
      ? toolInput.types.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
      : [];
    const receipts = await input.factoryService.listObjectiveReceipts(objectiveId, {
      limit,
      taskId: asString(toolInput.taskId),
      candidateId: asString(toolInput.candidateId),
      types,
    });
    return {
      output: JSON.stringify({
        worker: "factory",
        action: "receipts",
        objectiveId,
        count: receipts.length,
        receipts,
      }, null, 2),
      summary: `${receipts.length} receipts`,
    };
  };

const discoveryTools = new Set([
  "memory.read",
  "memory.search",
  "memory.summarize",
  "codex.run",
  "agent.status",
  "repo.status",
  "codex.status",
  "codex.logs",
  "jobs.list",
  "factory.status",
  "factory.output",
  "factory.receipts",
  "skill.read",
]);

const deliveryTools = new Set([
  "factory.dispatch",
  "agent.delegate",
]);

const monitorWhileChildRunningTools = new Set([
  "agent.status",
  "repo.status",
  "codex.status",
  "codex.logs",
  "jobs.list",
  "factory.status",
  "factory.output",
  "factory.receipts",
  "job.control",
]);

const hasPositiveWaitForChangeMs = (toolInput: Record<string, unknown>): boolean =>
  typeof toolInput.waitForChangeMs === "number"
  && Number.isFinite(toolInput.waitForChangeMs)
  && toolInput.waitForChangeMs > 0;

const terminalObjectiveReadTools = new Set([
  "factory.status",
  "factory.output",
  "factory.receipts",
]);

const isTerminalObjectiveStatus = (status: unknown): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const withProfileOrchestrationPolicy = (
  input: {
    readonly profile: FactoryChatResolvedProfile;
    readonly queue: JsonlQueue;
    readonly runId: string;
    readonly factoryService: FactoryService;
    readonly getCurrentObjectiveId: () => string | undefined;
  },
  tools: Readonly<Record<string, AgentToolExecutor>>,
): Readonly<Record<string, AgentToolExecutor>> => {
  const policy = input.profile.orchestration;
  let discoverySteps = 0;
  let deliveryStarted = false;
  const activeAsyncChildJobs = new Set<string>();
  const terminalObjectiveCache = new Set<string>();
  return Object.fromEntries(Object.entries(tools).map(([name, executor]) => [name, async (toolInput) => {
    const blockingMonitorPoll = policy.allowPollingWhileChildRunning
      && monitorWhileChildRunningTools.has(name)
      && hasPositiveWaitForChangeMs(toolInput);
    const terminalObjectiveRead = !blockingMonitorPoll
      && terminalObjectiveReadTools.has(name)
      && await (async (): Promise<boolean> => {
        const objectiveId = asString(toolInput.objectiveId) ?? input.getCurrentObjectiveId();
        if (!objectiveId) return false;
        if (terminalObjectiveCache.has(objectiveId)) return true;
        const objective = await input.factoryService.getObjective(objectiveId).catch(() => undefined);
        const terminal = Boolean(objective?.archivedAt) || isTerminalObjectiveStatus(objective?.status);
        if (terminal) terminalObjectiveCache.add(objectiveId);
        return terminal;
      })();
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
      && !blockingMonitorPoll
      && !terminalObjectiveRead
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
  readonly stream: string;
  readonly runId: string;
  readonly repoKey: string;
  readonly queue: JsonlQueue;
  readonly problem: string;
  readonly config: FactoryChatRunConfig;
  readonly memoryTools: MemoryTools;
  readonly chatId?: string;
  readonly getCurrentObjectiveId: () => string | undefined;
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
    const chatId = input.chatId ?? chatIdFromFactoryStream(input.stream);
    const objectiveId = input.getCurrentObjectiveId();
    const stream = chatId
      ? factoryChatSessionStream(input.repoRoot, target.root.id, chatId)
      : factoryChatStream(input.repoRoot, target.root.id, objectiveId);
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
        ...(chatId ? { chatId } : {}),
        ...(objectiveId ? { objectiveId } : {}),
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
        link: `/factory?profile=${encodeURIComponent(target.root.id)}${chatId ? `&chat=${encodeURIComponent(chatId)}` : ""}${objectiveId ? `&thread=${encodeURIComponent(objectiveId)}` : ""}&job=${encodeURIComponent(created.id)}&run=${encodeURIComponent(handoffRunId)}`,
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
  const continuationDepth = parseContinuationDepth(input.continuationDepth);
  const resolvedChatId = input.chatId ?? chatIdFromFactoryStream(input.stream);
  const resolvedProfile = await resolveFactoryChatProfile({
    repoRoot,
    profileRoot,
    requestedId: input.profileId,
    problem: input.problem,
  });
  const repoKey = repoKeyForRoot(repoRoot);
  const resolvedStream = resolvedChatId
    ? factoryChatSessionStream(repoRoot, resolvedProfile.root.id, resolvedChatId)
    : asString(input.stream) ?? factoryChatStream(repoRoot, resolvedProfile.root.id, input.objectiveId);
  let currentObjectiveId = input.objectiveId;
  const getCurrentObjectiveId = (): string | undefined => currentObjectiveId;
  const setCurrentObjectiveId = (objectiveId: string | undefined): void => {
    currentObjectiveId = objectiveId;
  };
  const resolvedMemoryScope = input.config.memoryScope === FACTORY_CHAT_DEFAULT_CONFIG.memoryScope
    ? (input.objectiveId
      ? objectiveMemoryScope(repoKey, resolvedProfile.root.id, input.objectiveId)
      : profileMemoryScope(repoKey, resolvedProfile.root.id))
    : input.config.memoryScope;
  const extraTools = withProfileOrchestrationPolicy({
    profile: resolvedProfile,
    queue: input.queue,
    runId: input.runId,
    factoryService: input.factoryService,
    getCurrentObjectiveId,
  }, {
    "agent.delegate": createAsyncDelegateTool({
      queue: input.queue,
      runId: input.runId,
      stream: input.stream,
      repoKey,
      getCurrentObjectiveId,
      memoryTools: input.memoryTools,
      profile: resolvedProfile,
    }),
    "agent.status": createJobStatusTool({
      queue: input.queue,
      currentJobId: input.control?.jobId,
    }),
    "jobs.list": createJobsListTool({
      queue: input.queue,
      runId: input.runId,
      stream: input.stream,
      profile: resolvedProfile,
      getCurrentObjectiveId,
    }),
    "repo.status": createRepoStatusTool({
      repoRoot,
    }),
    "codex.status": createCodexStatusTool({
      queue: input.queue,
      runId: input.runId,
      stream: input.stream,
      profile: resolvedProfile,
      getCurrentObjectiveId,
      dataDir: input.dataDir,
    }),
    ...(input.dataDir ? {
      "codex.logs": createCodexLogsTool({
        queue: input.queue,
        runId: input.runId,
        stream: input.stream,
        profile: resolvedProfile,
        getCurrentObjectiveId,
        dataDir: input.dataDir,
      }),
    } : {}),
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
      getCurrentObjectiveId,
      memoryTools: input.memoryTools,
      profile: resolvedProfile,
    }),
    "factory.dispatch": createFactoryDispatchTool({
      factoryService: input.factoryService,
      repoKey,
      runId: input.runId,
      stream: input.stream,
      memoryTools: input.memoryTools,
      profileId: resolvedProfile.root.id,
      getCurrentObjectiveId,
      setCurrentObjectiveId,
    }),
    "factory.status": createFactoryStatusTool({
      factoryService: input.factoryService,
      getCurrentObjectiveId,
    }),
    "factory.output": createFactoryOutputTool({
      factoryService: input.factoryService,
      getCurrentObjectiveId,
    }),
    "factory.receipts": createFactoryReceiptsTool({
      factoryService: input.factoryService,
      getCurrentObjectiveId,
    }),
    "profile.handoff": createProfileHandoffTool({
      currentProfile: resolvedProfile,
      repoRoot,
      profileRoot,
      stream: resolvedStream,
      runId: input.runId,
      repoKey,
      queue: input.queue,
      problem: input.problem,
      config: input.config,
      memoryTools: input.memoryTools,
      chatId: resolvedChatId,
      getCurrentObjectiveId,
    }),
    ...(input.extraTools ?? {}),
  });
  const onIterationBudgetExhausted: NonNullable<AgentRunInput["onIterationBudgetExhausted"]> = async ({ runId, problem, config, progress }) => {
    if (isStuckProgress(progress)) return undefined;
    const nextMaxIterations = nextIterationBudget(config.maxIterations);
    if (nextMaxIterations === undefined) return undefined;
    const nextRunId = nextId("run");
    const objectiveId = getCurrentObjectiveId();
    const nextConfig = normalizeFactoryChatConfig({
      ...input.config,
      maxIterations: nextMaxIterations,
      memoryScope: input.config.memoryScope,
    });
    const created = await input.queue.enqueue({
      agentId: "factory",
      lane: "collect",
      sessionKey: `factory-chat:${resolvedStream}`,
      singletonMode: "allow",
      maxAttempts: 1,
      payload: {
        kind: "factory.run",
        stream: resolvedStream,
        runId: nextRunId,
        problem,
        profileId: resolvedProfile.root.id,
        ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
        ...(objectiveId ? { objectiveId } : {}),
        config: nextConfig,
        continuationDepth: continuationDepth + 1,
      },
    });
    const summary = `Reached the current ${config.maxIterations}-step slice. Continuing automatically in this project chat as ${nextRunId} with a ${nextMaxIterations}-step budget.`;
    return {
      finalText: `${summary}\n\nLive updates will keep appearing here.`,
      note: `continued automatically as ${nextRunId}`,
      events: [{
        type: "run.continued",
        runId,
        agentId: "orchestrator",
        nextRunId,
        nextJobId: created.id,
        profileId: resolvedProfile.root.id,
        objectiveId,
        previousMaxIterations: config.maxIterations,
        nextMaxIterations,
        continuationDepth: continuationDepth + 1,
        summary,
      }],
    };
  };
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
      ...(input.objectiveId
        ? [{
            type: "thread.bound" as const,
            runId: input.runId,
            agentId: "orchestrator",
            objectiveId: input.objectiveId,
            ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
            reason: "startup" as const,
          }]
        : []),
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
    promptContextBuilder: async () => ({
      situation: await buildFactorySituation({
        queue: input.queue,
        runId: input.runId,
        stream: input.stream,
        profile: resolvedProfile,
        getCurrentObjectiveId,
        factoryService: input.factoryService,
        dataDir: input.dataDir,
      }),
    }),
    extraToolSpecs: {
      "agent.delegate": "{\"agentId\": string, \"task\": string, \"config\"?: object} — Queue a Receipt-native subagent and return its live job handle immediately.",
      "agent.status": "{\"jobId\": string} — Inspect a queued or running child job and return its latest normalized state. Do not pass the current factory job id.",
      "jobs.list": "{\"limit\"?: number, \"status\"?: string, \"includeCompleted\"?: boolean} — List recent jobs related to the current Factory skill chat.",
      "repo.status": "{} — Read control-plane git state for the current repo: HEAD baseHash, branch, dirty/clean state, and a bounded git status --porcelain summary. Use this when Factory needs baseHash for a dirty source tree.",
      "codex.status": "{\"jobId\"?: string, \"limit\"?: number, \"includeCompleted\"?: boolean, \"waitForChangeMs\"?: number} — Inspect live Codex activity for the current run, project, or skill chat. With waitForChangeMs, block briefly until the child changes.",
      ...(input.dataDir ? {
        "codex.logs": "{\"jobId\"?: string} — Inspect Codex child logs, packet files, and artifact paths for this Factory chat context. Without jobId, use the latest Codex child.",
      } : {}),
      "job.control": "{\"jobId\": string, \"command\": \"steer\"|\"follow_up\"|\"abort\", \"problem\"?: string, \"config\"?: object, \"note\"?: string, \"reason\"?: string} — Queue a steer, follow-up, or abort command for a running child job. Do not pass the current factory job id.",
      "codex.run": "{\"prompt\": string, \"timeoutMs\"?: number} — Queue a read-only Codex probe against the repo and return its live child job handle immediately. Use it for lightweight inspection and evidence-gathering only; use factory.dispatch for substantive infra work or code changes.",
      "factory.dispatch": "{\"action\"?: \"create\"|\"react\"|\"promote\"|\"cancel\"|\"cleanup\"|\"archive\", \"objectiveId\"?: string, \"prompt\"?: string, \"title\"?: string, \"baseHash\"?: string, \"objectiveMode\"?: \"delivery\"|\"investigation\", \"severity\"?: 1|2|3|4|5, \"checks\"?: string[], \"channel\"?: string, \"reason\"?: string} — Create or operate on a tracked Factory project. 'react' means re-evaluate the project and dispatch the next eligible step.",
      "factory.status": "{\"objectiveId\"?: string, \"waitForChangeMs\"?: number} — Inspect a tracked Factory project and return objective state, decisions, evidence cards, recent receipts, jobs, worktrees, and latest context packs. With waitForChangeMs, block briefly until the objective changes.",
      "factory.output": "{\"objectiveId\"?: string, \"focusKind\": \"task\"|\"job\", \"focusId\": string, \"waitForChangeMs\"?: number} — Inspect live output and log tails for an objective task or job. With waitForChangeMs, block briefly until the output changes.",
      "factory.receipts": "{\"objectiveId\"?: string, \"taskId\"?: string, \"candidateId\"?: string, \"types\"?: string[], \"limit\"?: number} — Inspect a bounded objective-scoped receipt slice for the current project.",
      "profile.handoff": "{\"profileId\": string, \"reason\"?: string} — Hand off the conversation to another Factory skill chat.",
      ...(input.extraToolSpecs ?? {}),
    },
    extraTools,
    finalizer: createFactoryChatFinalizer({
      queue: input.queue,
      profile: resolvedProfile,
    }),
    onIterationBudgetExhausted,
  });
};

const DIRECT_CODEX_MUTATION_MESSAGE = "Direct Codex probes are read-only. This work needs code changes; create or react a Factory objective instead.";

const looksLikeReadOnlyMutationFailure = (message: string): boolean =>
  /\bread[- ]only\b|\bpermission denied\b|\bcannot write\b|\bwrite access\b|\bsandbox\b/i.test(message);

export const runFactoryCodexJob = async (input: {
  readonly dataDir: string;
  readonly repoRoot: string;
  readonly jobId: string;
  readonly prompt: string;
  readonly executor: CodexExecutor;
  readonly timeoutMs?: number;
  readonly onProgress?: (update: Record<string, unknown>) => Promise<void>;
  readonly factoryService?: FactoryService;
  readonly payload?: Record<string, unknown>;
}, control?: CodexRunControl): Promise<Record<string, unknown>> => {
  const artifacts = factoryChatCodexArtifactPaths(input.dataDir, input.jobId);
  await fs.mkdir(artifacts.root, { recursive: true });

  let renderedPrompt = input.prompt;
  let readOnly = input.payload?.readOnly === true || asString(input.payload?.mode) === "read_only_probe";
  let env: NodeJS.ProcessEnv | undefined;
  if (input.factoryService && input.payload) {
    const prepared = await input.factoryService.prepareDirectCodexProbePacket({
      jobId: input.jobId,
      prompt: input.prompt,
      profileId: asString(input.payload.profileId),
      objectiveId: asString(input.payload.objectiveId),
      parentRunId: asString(input.payload.parentRunId),
      parentStream: asString(input.payload.parentStream),
      stream: asString(input.payload.stream),
      supervisorSessionId: asString(input.payload.supervisorSessionId),
      readOnly,
    });
    renderedPrompt = prepared.renderedPrompt;
    readOnly = prepared.readOnly;
    env = prepared.env;
  } else {
    await fs.rm(artifacts.resultPath, { force: true });
  }

  let progressStopped = false;
  let lastFingerprint = "";
  const emitProgress = async (): Promise<void> => {
    const [lastMessage, stdoutTail, stderrTail] = await Promise.all([
      readTextTail(artifacts.lastMessagePath, 400),
      readTextTail(artifacts.stdoutPath, 900),
      readTextTail(artifacts.stderrPath, 600),
    ]);
    const update = {
      worker: "codex",
      mode: readOnly ? "read_only_probe" : "workspace_write",
      readOnly,
      status: "running",
      lastMessage,
      stdoutTail,
      stderrTail,
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

  const writeResult = async (result: Record<string, unknown>): Promise<void> => {
    await fs.writeFile(artifacts.resultPath, JSON.stringify(result, null, 2), "utf-8");
  };

  try {
    const result = await input.executor.run({
      prompt: renderedPrompt,
      workspacePath: input.repoRoot,
      promptPath: artifacts.promptPath,
      lastMessagePath: artifacts.lastMessagePath,
      stdoutPath: artifacts.stdoutPath,
      stderrPath: artifacts.stderrPath,
      timeoutMs: input.timeoutMs,
      env,
      sandboxMode: readOnly ? "read-only" : "workspace-write",
      mutationPolicy: readOnly ? "read_only_probe" : "workspace_edit",
    }, control);
    progressStopped = true;
    await progressLoop;
    await emitProgress();

    const changedFiles = await gitChangedFiles(input.repoRoot);
    if (readOnly && changedFiles.length > 0) {
      const failed = {
        status: "failed",
        worker: "codex",
        mode: "read_only_probe",
        readOnly: true,
        summary: DIRECT_CODEX_MUTATION_MESSAGE,
        lastMessage: asString(result.lastMessage),
        stdoutTail: tail(result.stdout),
        stderrTail: tail(result.stderr),
        changedFiles,
        artifacts,
      };
      await writeResult(failed);
      throw new Error(DIRECT_CODEX_MUTATION_MESSAGE);
    }

    const completed = {
      status: "completed",
      worker: "codex",
      mode: readOnly ? "read_only_probe" : "workspace_write",
      readOnly,
      summary: asString(result.lastMessage) ?? "Codex completed.",
      lastMessage: asString(result.lastMessage),
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
      changedFiles,
      artifacts,
    };
    await writeResult(completed);
    return completed;
  } catch (err) {
    progressStopped = true;
    await progressLoop;
    await emitProgress();

    const [lastMessage, stdoutTail, stderrTail, changedFiles] = await Promise.all([
      readTextTail(artifacts.lastMessagePath, 400),
      readTextTail(artifacts.stdoutPath, 900),
      readTextTail(artifacts.stderrPath, 600),
      gitChangedFiles(input.repoRoot),
    ]);
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = readOnly && (changedFiles.length > 0 || looksLikeReadOnlyMutationFailure(rawMessage))
      ? DIRECT_CODEX_MUTATION_MESSAGE
      : rawMessage;
    await writeResult({
      status: "failed",
      worker: "codex",
      mode: readOnly ? "read_only_probe" : "workspace_write",
      readOnly,
      summary: message,
      lastMessage,
      stdoutTail,
      stderrTail,
      changedFiles,
      artifacts,
    });
    throw new Error(message);
  }
};
