import fs from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { ZodTypeAny, infer as ZodInfer } from "zod";

import {
  AGENT_DEFAULT_CONFIG,
  normalizeAgentConfig,
  runAgent,
  isStuckProgress,
  type AgentRunConfig,
  type AgentFinalizer,
  type AgentRunInput,
  type AgentRunResult,
} from "./agent";
import {
  agentDelegateCapability,
  agentStatusCapability,
  codexLogsCapability,
  codexRunCapability,
  codexStatusCapability,
  createCapabilitySpec,
  factoryDispatchCapability,
  factoryOutputCapability,
  factoryReceiptsCapability,
  factoryStatusCapability,
  jobControlCapability,
  jobsListCapability,
  repoStatusCapability,
  type AgentToolExecutor,
} from "./capabilities";
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
import { summarizeFactoryObjective } from "../views/factory/objective-presenters";
import { buildFactoryQueueJobSnapshot } from "../views/factory/job-presenters";
import {
  clampWaitMs,
  combineFinalizers,
  createLiveFactoryFinalizer,
  createRepoStatusTool,
  deriveObjectiveTitle,
  effectiveFactoryLiveWaitMs,
  isActiveJobStatus,
  waitForSnapshotChange,
  type FactoryLiveWaitState,
} from "./orchestration-utils";

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

const FACTORY_CHAT_META_REFLECTION_RE =
  /\b(?:do you think you did|did you do (?:good|well)|grade your performance|how did you do|self[- ]reflection|self[- ]reflect|reflect on (?:your|that)|what is off here|what feels off|why (?:is|was) (?:this|that|it) (?:off|robotic|unnatural|procedural)|missing soul|sound(?:ing)? (?:more )?(?:human|natural)|too (?:robotic|procedural)|answered? (?:like|as) (?:a )?(?:human|person)|why did that sound)\b/i;

const FACTORY_CHAT_WORKLIKE_SIGNAL_RE =
  /\b(?:fix|implement|change|update|edit|refactor|debug|investigate|inspect|analyze|review|check|build|test|file|code|repo|branch|commit|diff|task|objective|thread|deploy|aws|ec2|s3|lambda|bug|error|failure|ci|pr|inventory|bucket|buckets|running jobs|cost spike)\b/i;

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

export const classifyFactoryResponseStyle = (problem: string): "conversational" | "work" => {
  const compact = problem.replace(/\s+/g, " ").trim();
  if (!compact) return "work";
  if (FACTORY_CHAT_META_REFLECTION_RE.test(compact)) return "conversational";
  if (compact.length <= 140 && !FACTORY_CHAT_WORKLIKE_SIGNAL_RE.test(compact)) return "conversational";
  return "work";
};

export const renderFactoryResponseStyleGuidance = (problem: string): string => {
  if (classifyFactoryResponseStyle(problem) === "conversational") {
    return [
      "- This turn is conversational or meta. Answer like a human engineer talking to another person.",
      "- Prefer short natural prose. Use first person for self-reflection.",
      "- Do not use headings, scorecards, grades, verdict labels, or rubric language unless the user explicitly asked for that format.",
      "- Do not turn the reply into operator-handoff analysis, workflow briefing, or report scaffolding.",
    ].join("\n");
  }
  return [
    "- This turn is work-focused. Use structure only when it genuinely helps the operator.",
    "- Keep the answer direct and specific; do not default to a report template if a short paragraph would do.",
    "- Mention workflow mechanics only when they materially affect the next step or the freshness of the answer.",
  ].join("\n");
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
  "Response style:",
  "{{response_style}}",
  "",
  "Available tools (one per step):",
  "{{available_tools}}",
  "",
  "Tool specs:",
  "{{tool_help}}",
  "",
  "Orchestration rules:",
  "- Profiles are orchestration-only. Do not claim this chat edited code directly.",
  "- Treat chat sessions as transport only. A new chatId does not reset repo, profile, objective, or worker memory.",
  "- When the selected objective is blocked, first explain the handoff in plain language: what the objective established, what is still missing, and whether the next step belongs in Chat or in tracked objective work.",
  "- Use `codex.run` only for lightweight read-only inspection or evidence-gathering in the current repo.",
  "- If a Codex probe is already queued or running for this chat context, reuse it instead of spawning another one.",
  "- Use `factory.dispatch` for any code-changing delivery work, any substantive infrastructure investigation, or when the next step should run in an objective worktree.",
  "- If a completed objective already contains the answer in `factory.status`, `factory.receipts`, or `factory.output`, answer directly only when the answer is historical, meta, or clearly not freshness-sensitive.",
  "- If the answer depends on current cloud/account/runtime state and checked-in helpers are available in the current situation or `factory.status`, rerun the best matching helper first via `codex.run` or `factory.dispatch` instead of finalizing from saved results alone.",
  "- If the answer depends on current cloud/account/runtime state and you only have saved evidence, prefer a fresh probe over presenting old results as current.",
  "- Before `react`, `promote`, `cancel`, or duplicate dispatch, ground the decision in the current situation, receipts, or live output.",
  "- Use delegation only for bounded sidecar work with a clear owner and stop condition. Keep the main chat responsible for the final answer.",
  "- When child work is already active, prefer `codex.status`, `factory.status`, or `factory.output` with `waitForChangeMs` so you wait for real progress instead of tight polling.",
  "- When `factory.output` reports `active: true`, treat log-tail command failures as provisional telemetry. Do not conclude the work failed until the task, job, or objective itself reaches a terminal failed/blocked state or receipts record that outcome.",
  "- If `factory.output` already resolved one active child, keep that same focus and add `waitForChangeMs` before switching tools. Use `factory.receipts` for reconciled history or terminal explanations, not as a substitute for live waiting.",
  "- Once a child has produced a concrete artifact, result JSON, or terminal summary that answers the question, inspect that evidence and finalize instead of issuing more wait loops.",
  "- Do not try to steer an in-flight child. If the current attempt is wrong, inspect it, abort it, and react the objective with a clearer note.",
  "- If investigation reports disagree or reconciliation is pending, do not finalize yet. Inspect status/receipts and wait for the objective to align or block.",
  "- Match tool input keys exactly to the documented schema. For example, `codex.run` accepts `{\"prompt\": string, \"timeoutMs\"?: number}`.",
  "",
  "For final answers to the user:",
  "- write plain language, not raw JSON",
  "- keep it concise and operator-facing",
  "- mention objective, run, and job only when needed for debugging or inspection",
  "- follow the active profile's voice, but do not let older transcript or memory phrasing override it",
  "- for conversational or meta turns, prefer short natural prose instead of sections",
  "- use structure only when the task benefits from it; choose headings that fit the situation instead of reusing canned labels",
  "- do not emit headings like Conclusion, Evidence, Disagreements, Scripts Run, Artifacts, What you did well, or Next Steps unless they add real signal for this specific answer or the user explicitly asked for that structure",
  "- never compress lists into a single paragraph such as `1) a 2) b 3) c`",
  "- prefer bold lead-ins such as `**Smallest unblock:**` before a short list instead of plain label lines ending with `:`",
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

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

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

const repoMemoryScope = (repoKey: string): string => `repos/${repoKey}`;
const profileMemoryScope = (repoKey: string, profileId: string): string => `repos/${repoKey}/profiles/${profileId}`;
const objectiveMemoryScope = (repoKey: string, profileId: string, objectiveId: string): string =>
  `${profileMemoryScope(repoKey, profileId)}/objectives/${objectiveId}`;
const workerMemoryScope = (repoKey: string, worker: string): string => `repos/${repoKey}/subagents/${worker}`;

type FactoryChatMemorySection = {
  readonly label: string;
  readonly scope: string;
  readonly maxChars: number;
  readonly summary?: string;
};

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

const summarizeMemoryScope = async (
  memoryTools: MemoryTools,
  input: {
    readonly scope: string;
    readonly query: string;
    readonly maxChars: number;
    readonly audit: Readonly<Record<string, unknown>>;
  },
): Promise<string | undefined> => {
  try {
    const { summary } = await memoryTools.summarize({
      scope: input.scope,
      query: input.query,
      limit: 6,
      maxChars: input.maxChars,
      audit: input.audit,
    });
    const trimmed = summary.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
};

const renderLayeredMemorySummary = async (input: {
  readonly memoryTools: MemoryTools;
  readonly repoKey: string;
  readonly profileId: string;
  readonly objectiveId?: string;
  readonly primaryScope: string;
  readonly primarySummary: string;
  readonly query: string;
  readonly runId: string;
  readonly iteration: number;
}): Promise<string> => {
  const repoScope = repoMemoryScope(input.repoKey);
  const profileScope = profileMemoryScope(input.repoKey, input.profileId);
  const currentObjectiveScope = input.objectiveId
    ? objectiveMemoryScope(input.repoKey, input.profileId, input.objectiveId)
    : undefined;
  const factoryObjectiveScope = input.objectiveId
    ? `factory/objectives/${input.objectiveId}`
    : undefined;
  const integrationScope = input.objectiveId
    ? `factory/objectives/${input.objectiveId}/integration`
    : undefined;
  const sections: FactoryChatMemorySection[] = [
    {
      label: "Repo memory",
      scope: repoScope,
      maxChars: 220,
      summary: input.primaryScope === repoScope ? input.primarySummary : undefined,
    },
    {
      label: "Profile memory",
      scope: profileScope,
      maxChars: 240,
      summary: input.primaryScope === profileScope ? input.primarySummary : undefined,
    },
    ...(currentObjectiveScope ? [{
      label: "Objective memory",
      scope: currentObjectiveScope,
      maxChars: 280,
      summary: input.primaryScope === currentObjectiveScope ? input.primarySummary : undefined,
    }] : []),
    {
      label: "Factory shared memory",
      scope: "factory/repo/shared",
      maxChars: 220,
    },
    ...(factoryObjectiveScope ? [{
      label: "Factory objective memory",
      scope: factoryObjectiveScope,
      maxChars: 260,
    }] : []),
    ...(integrationScope ? [{
      label: "Integration memory",
      scope: integrationScope,
      maxChars: 220,
    }] : []),
    {
      label: "Factory worker memory",
      scope: workerMemoryScope(input.repoKey, "factory"),
      maxChars: 180,
    },
    {
      label: "Codex worker memory",
      scope: workerMemoryScope(input.repoKey, "codex"),
      maxChars: 180,
    },
  ];

  const seenScopes = new Set<string>();
  const rendered: string[] = [];
  const seenSummaries = new Set<string>();
  for (const section of sections) {
    if (seenScopes.has(section.scope)) continue;
    seenScopes.add(section.scope);
    const summary = (section.summary ?? await summarizeMemoryScope(input.memoryTools, {
      scope: section.scope,
      query: input.query,
      maxChars: section.maxChars,
      audit: {
        actor: "factory-chat",
        operation: "layered-memory",
        runId: input.runId,
        iteration: input.iteration,
        label: section.label,
      },
    }))?.trim();
    if (!summary) continue;
    const dedupeKey = summary.toLowerCase();
    if (seenSummaries.has(dedupeKey)) continue;
    seenSummaries.add(dedupeKey);
    rendered.push(`${section.label}:\n${summary}`);
  }
  return rendered.join("\n\n") || "(empty)";
};

type GitChangedFileEntry = {
  readonly path: string;
  readonly status: string;
  readonly previousPath?: string;
};

type GitChangedFileSnapshotEntry = {
  readonly status: string;
  readonly fingerprint?: string;
};

const gitStatusEntries = async (repoRoot: string): Promise<ReadonlyArray<GitChangedFileEntry>> => {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=1", "-z", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    });
    const tokens = stdout.split("\u0000");
    const entries: GitChangedFileEntry[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token) continue;
      const status = token.slice(0, 2);
      const filePath = token.slice(3);
      if (!status || !filePath) continue;
      const previousPath = status.includes("R") || status.includes("C")
        ? tokens[index + 1] || undefined
        : undefined;
      entries.push(previousPath ? { path: filePath, status, previousPath } : { path: filePath, status });
      if (previousPath) index += 1;
    }
    return entries;
  } catch {
    return [];
  }
};

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
};

const copyPathPreservingType = async (sourcePath: string, targetPath: string): Promise<void> => {
  const stat = await fs.lstat(sourcePath);
  await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (stat.isSymbolicLink()) {
    const linkTarget = await fs.readlink(sourcePath);
    await fs.symlink(linkTarget, targetPath);
    return;
  }
  if (stat.isDirectory()) {
    await fs.cp(sourcePath, targetPath, { recursive: true, dereference: false });
    return;
  }
  await fs.copyFile(sourcePath, targetPath);
};

const ensureProbeWorkspaceNodeModulesLink = async (sourceRoot: string, workspacePath: string): Promise<void> => {
  const sourceNodeModulesPath = path.join(sourceRoot, "node_modules");
  const workspaceNodeModulesPath = path.join(workspacePath, "node_modules");
  if (!(await pathExists(sourceNodeModulesPath)) || await pathExists(workspaceNodeModulesPath)) return;
  await fs.symlink(
    sourceNodeModulesPath,
    workspaceNodeModulesPath,
    process.platform === "win32" ? "junction" : "dir",
  ).catch(() => undefined);
};

const mirrorDirtyGitStateToWorkspace = async (sourceRoot: string, workspacePath: string): Promise<void> => {
  const entries = await gitStatusEntries(sourceRoot);
  for (const entry of entries) {
    if (entry.previousPath && entry.previousPath !== entry.path) {
      await fs.rm(path.join(workspacePath, entry.previousPath), { recursive: true, force: true }).catch(() => undefined);
    }
    const sourcePath = path.join(sourceRoot, entry.path);
    const targetPath = path.join(workspacePath, entry.path);
    const sourceExists = await pathExists(sourcePath);
    if (!sourceExists || entry.status.includes("D")) {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    await copyPathPreservingType(sourcePath, targetPath);
  }
};

type DisposableProbeWorkspace = {
  readonly workspacePath: string;
  readonly cleanup: () => Promise<void>;
};

const createDisposableProbeWorkspace = async (
  repoRoot: string,
  jobId: string,
): Promise<DisposableProbeWorkspace> => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `receipt-direct-probe-${jobId}-`));
  const workspacePath = path.join(tempRoot, "workspace");
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    await execFileAsync("git", ["worktree", "add", "--detach", workspacePath, "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    });
    await ensureProbeWorkspaceNodeModulesLink(repoRoot, workspacePath);
    await mirrorDirtyGitStateToWorkspace(repoRoot, workspacePath);
    return {
      workspacePath,
      cleanup: async () => {
        await execFileAsync("git", ["worktree", "remove", "--force", workspacePath], {
          cwd: repoRoot,
          encoding: "utf-8",
          maxBuffer: 4 * 1024 * 1024,
        }).catch(() => undefined);
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch {
    await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    await fs.cp(repoRoot, workspacePath, { recursive: true, dereference: false });
    return {
      workspacePath,
      cleanup: async () => {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  }
};

const gitWorkingTreeFingerprint = async (repoRoot: string, filePath: string): Promise<string | undefined> => {
  try {
    const absolutePath = path.join(repoRoot, filePath);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) return `symlink:${await fs.readlink(absolutePath)}`;
    if (stat.isDirectory()) return `dir:${stat.mtimeMs}:${stat.size}`;
    const content = await fs.readFile(absolutePath);
    return createHash("sha1").update(content).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
};

const gitChangedFileSnapshot = async (
  repoRoot: string,
): Promise<ReadonlyMap<string, GitChangedFileSnapshotEntry>> => {
  const entries = await gitStatusEntries(repoRoot);
  const snapshots = await Promise.all(entries.map(async ({ path: filePath, status }) => (
    [filePath, { status, fingerprint: await gitWorkingTreeFingerprint(repoRoot, filePath) }] as const
  )));
  return new Map(snapshots);
};

const diffGitChangedFileSnapshots = (
  before: ReadonlyMap<string, GitChangedFileSnapshotEntry>,
  after: ReadonlyMap<string, GitChangedFileSnapshotEntry>,
): ReadonlyArray<string> => {
  const changed = new Set<string>();
  for (const filePath of before.keys()) {
    const previous = before.get(filePath);
    const current = after.get(filePath);
    if (!current || previous?.status !== current.status || previous?.fingerprint !== current.fingerprint) {
      changed.add(filePath);
    }
  }
  for (const filePath of after.keys()) {
    const previous = before.get(filePath);
    const current = after.get(filePath);
    if (!previous || previous.status !== current?.status || previous.fingerprint !== current?.fingerprint) {
      changed.add(filePath);
    }
  }
  return [...changed].sort((left, right) => left.localeCompare(right));
};

const gitChangedFiles = async (repoRoot: string): Promise<ReadonlyArray<string>> => {
  const entries = await gitStatusEntries(repoRoot);
  return entries.map((entry) => entry.path).sort((left, right) => left.localeCompare(right));
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
  const base = buildFactoryQueueJobSnapshot(job);
  const result = asRecord(job.result);
  return {
    ...base,
    profileId: asString(job.payload.profileId),
    delegatedTo: asString(result?.delegatedTo) ?? asString(job.payload.delegatedTo),
    objectiveId: asString(result?.objectiveId) ?? asString(job.payload.objectiveId),
    mode: asString(result?.mode) ?? asString(job.payload.mode),
    readOnly: result?.readOnly === true || job.payload.readOnly === true,
  };
};

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

const latestActiveCodexJob = async (queue: JsonlQueue, input: {
  readonly runId: string;
  readonly stream: string;
  readonly profileId: string;
  readonly objectiveId?: string;
}): Promise<QueueJob | undefined> =>
  (await queue.listJobs({ limit: 200 }))
    .filter((job) => job.agentId === "codex" && isActiveJobStatus(job.status))
    .filter((job) => jobMatchesProfileContext(job, input))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];

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

const summarizeObjectiveReceipts = (receipts: ReadonlyArray<FactoryObjectiveReceiptSummary>, limit = 5): ReadonlyArray<string> =>
  receipts.slice(-Math.max(1, limit)).map((receipt) => `- ${receipt.type}: ${receipt.summary}`);

const reusableInfrastructureRefs = (
  sharedArtifactRefs: ReadonlyArray<{ readonly ref: string; readonly label?: string }> | undefined,
): {
  readonly scripts: ReadonlyArray<string>;
  readonly knowledge: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<string>;
} => {
  const refs = Array.isArray(sharedArtifactRefs) ? sharedArtifactRefs : [];
  const collect = (labelFragment: string): ReadonlyArray<string> => {
    const seen = new Set<string>();
    const values: string[] = [];
    for (const ref of refs) {
      const label = ref.label?.trim().toLowerCase() ?? "";
      const target = ref.ref?.trim();
      if (!target || !label.includes(labelFragment) || seen.has(target)) continue;
      seen.add(target);
      values.push(target);
    }
    return values;
  };
  return {
    scripts: collect("checked-in helper entrypoint"),
    knowledge: collect("checked-in helper manifest"),
    evidence: collect("helper runner"),
  };
};

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
      lines.push(`Mode: ${detail.objectiveMode} · severity ${detail.severity}`);
      if (detail.latestDecision?.summary) lines.push(`Latest decision: ${detail.latestDecision.summary}`);
      if (detail.blockedExplanation?.summary) lines.push(`Blocked: ${detail.blockedExplanation.summary}`);
      const planPreview = detail.tasks.slice(0, 6).map((task) =>
        `- ${task.taskId} [${task.status}] ${task.title}${(task.dependsOn ?? []).length > 0 ? ` · depends on ${(task.dependsOn ?? []).join(", ")}` : ""}`
      );
      if (planPreview.length > 0) {
        lines.push("Plan:");
        lines.push(...planPreview);
      }
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
      const reusableRefs = reusableInfrastructureRefs(detail.contextSources?.sharedArtifactRefs);
      if (reusableRefs.knowledge.length > 0) {
        lines.push("Checked-in helper manifests:");
        lines.push(...reusableRefs.knowledge.slice(0, 3).map((ref) => `- ${ref}`));
      }
      if (reusableRefs.scripts.length > 0) {
        lines.push("Checked-in helper entrypoints:");
        lines.push(...reusableRefs.scripts.slice(0, 4).map((ref) => `- ${ref}`));
        lines.push("Freshness rule: for live cloud/account/runtime questions, rerun the best matching checked-in helper before finalizing; do not answer from saved output alone.");
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
  readonly dataDir?: string;
}): AgentToolExecutor =>
  async (toolInput) => {
    const prompt = asString(toolInput.prompt) ?? asString(toolInput.task);
    if (!prompt) throw new Error("codex.run requires prompt");
    const objectiveId = input.getCurrentObjectiveId();
    const existing = await latestActiveCodexJob(input.queue, {
      runId: input.runId,
      stream: input.stream,
      profileId: input.profile.root.id,
      objectiveId,
    });
    if (existing) {
      const result: Record<string, unknown> = {
        ...(await codexJobSnapshot(existing, input.dataDir)),
        worker: "codex",
        mode: "read_only_probe",
        readOnly: true,
        summary: `reusing active codex probe ${existing.id}`,
      };
      return {
        output: JSON.stringify(result, null, 2),
        summary: String(result.summary),
      };
    }
    const timeoutMs = typeof toolInput.timeoutMs === "number" && Number.isFinite(toolInput.timeoutMs)
      ? Math.max(30_000, Math.min(Math.floor(toolInput.timeoutMs), 900_000))
      : 180_000;
    const sessionKey = stableCodexSessionKey(input.runId, prompt);
    const singletonMode = "allow";
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
        ...(objectiveId ? { objectiveId } : {}),
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
    if (command !== "abort") {
      throw new Error("job.control only supports abort");
    }
    const payload = { reason: asString(toolInput.reason) ?? "abort requested" };
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
    const currentObjective = objectiveId
      ? await input.factoryService.getObjective(objectiveId).catch(() => undefined)
      : undefined;
    let action = asString(toolInput.action)
      ?? (
        objectiveId
        && currentObjective
        && !currentObjective.archivedAt
        && !isTerminalObjectiveStatus(currentObjective.status)
          ? "react"
          : "create"
      );
    let detail: Awaited<ReturnType<FactoryService["getObjective"]>>;
    let reused = false;
    let bindingReason: "dispatch_create" | "dispatch_reuse" | "dispatch_update" = "dispatch_update";
    if (action === "create") {
      const prompt = asString(toolInput.prompt);
      if (!prompt) throw new Error("factory.dispatch create requires prompt");
      const payload: FactoryObjectiveInput = {
        objectiveId: requestedObjectiveId,
        title: asString(toolInput.title) ?? deriveObjectiveTitle(prompt),
        prompt,
        baseHash: asString(toolInput.baseHash),
        objectiveMode: toolInput.objectiveMode === "investigation" || toolInput.objectiveMode === "delivery"
          ? toolInput.objectiveMode
          : currentObjective?.objectiveMode,
        severity: typeof toolInput.severity === "number" && Number.isInteger(toolInput.severity)
          && toolInput.severity >= 1 && toolInput.severity <= 5
          ? toolInput.severity as FactoryObjectiveInput["severity"]
          : currentObjective?.severity,
        checks: asStringList(toolInput.checks),
        channel: asString(toolInput.channel),
        profileId: input.profileId,
        startImmediately: true,
      };
      detail = await input.factoryService.createObjective(payload);
      bindingReason = "dispatch_create";
    } else if (action === "react") {
      if (!objectiveId) throw new Error("factory.dispatch react requires objectiveId");
      const followUpPrompt = asString(toolInput.note) ?? asString(toolInput.prompt);
      if (currentObjective && (currentObjective.archivedAt || isTerminalObjectiveStatus(currentObjective.status))) {
        if (!followUpPrompt) {
          throw new Error("factory.dispatch react on a completed objective requires note or prompt to create a follow-up objective");
        }
        detail = await input.factoryService.createObjective({
          title: asString(toolInput.title) ?? deriveObjectiveTitle(followUpPrompt),
          prompt: followUpPrompt,
          baseHash: asString(toolInput.baseHash),
          objectiveMode: toolInput.objectiveMode === "investigation" || toolInput.objectiveMode === "delivery"
            ? toolInput.objectiveMode
            : currentObjective.objectiveMode,
          severity: typeof toolInput.severity === "number" && Number.isInteger(toolInput.severity)
            && toolInput.severity >= 1 && toolInput.severity <= 5
            ? toolInput.severity as FactoryObjectiveInput["severity"]
            : currentObjective.severity,
          checks: asStringList(toolInput.checks),
          channel: asString(toolInput.channel),
          profileId: input.profileId,
          startImmediately: true,
        });
        action = "create";
        bindingReason = "dispatch_create";
      } else {
        detail = await input.factoryService.reactObjectiveWithNote(
          objectiveId,
          followUpPrompt,
        );
      }
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
    const summary = summarizeFactoryObjective(detail);
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
  readonly liveWaitState: FactoryLiveWaitState;
}): AgentToolExecutor =>
  async (toolInput) => {
    const objectiveId = asString(toolInput.objectiveId) ?? input.getCurrentObjectiveId();
    if (!objectiveId) throw new Error("factory.status requires objectiveId");
    const requestedWaitMs = clampWaitMs(toolInput.waitForChangeMs);
    const buildStatus = async (): Promise<Record<string, unknown>> => {
      const [detail, debug, receipts] = await Promise.all([
        input.factoryService.getObjective(objectiveId),
        input.factoryService.getObjectiveDebug(objectiveId),
        input.factoryService.listObjectiveReceipts(objectiveId, { limit: 20 }),
      ]);
      const summary = summarizeFactoryObjective(detail);
      const reusableRefs = reusableInfrastructureRefs(detail.contextSources?.sharedArtifactRefs);
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
        availableHelperEntrypoints: reusableRefs.scripts,
        availableHelperManifests: reusableRefs.knowledge,
        availableHelperSupport: reusableRefs.evidence,
        freshnessGuidance: reusableRefs.scripts.length > 0
          ? "For live cloud/account/runtime questions, rerun the best matching checked-in helper before finalizing."
          : undefined,
      };
    };
    const initial = await buildStatus();
    const live = (
      asString(initial.status) === "queued"
      || asString(initial.status) === "active"
      || asString(initial.status) === "executing"
      || (Array.isArray(initial.activeJobs) && initial.activeJobs.length > 0)
    );
    const waitForChangeMs = effectiveFactoryLiveWaitMs(requestedWaitMs, live, input.liveWaitState);
    const waited = waitForChangeMs > 0 && live
      ? await waitForSnapshotChange(initial, waitForChangeMs, buildStatus)
      : { value: initial, waitedMs: 0, changed: false };
    const payload = waited.waitedMs > 0
      ? { ...waited.value, waitedMs: waited.waitedMs, changed: waited.changed }
      : waited.value;
    if (live) input.liveWaitState.surfaced = true;
    return {
      output: JSON.stringify(payload, null, 2),
      summary: `${String(payload.summary ?? payload.title ?? objectiveId)}${waited.waitedMs > 0 ? ` after waiting ${waited.waitedMs}ms` : ""}`,
      pauseBudget: waited.waitedMs > 0 && waited.changed === false,
    };
  };

const createFactoryOutputTool = (input: {
  readonly factoryService: FactoryService;
  readonly getCurrentObjectiveId: () => string | undefined;
  readonly liveWaitState: FactoryLiveWaitState;
}): AgentToolExecutor =>
  async (toolInput) => {
    const objectiveId = asString(toolInput.objectiveId) ?? input.getCurrentObjectiveId();
    if (!objectiveId) throw new Error("factory.output requires objectiveId");
    const taskId = asString(toolInput.taskId);
    const jobId = asString(toolInput.jobId);
    const requestedFocusKind = asString(toolInput.focusKind);
    const requestedFocusId = asString(toolInput.focusId);
    let focusKind: "task" | "job";
    let focusId: string;
    if (taskId) {
      focusKind = "task";
      focusId = taskId;
    } else if (jobId) {
      focusKind = "job";
      focusId = jobId;
    } else if (requestedFocusKind === "task" || requestedFocusKind === "job") {
      if (!requestedFocusId) throw new Error("factory.output requires focusId");
      focusKind = requestedFocusKind;
      focusId = requestedFocusId;
    } else if (requestedFocusKind) {
      throw new Error("factory.output requires focusKind of 'task' or 'job'");
    } else if (requestedFocusId) {
      throw new Error("factory.output requires focusKind when focusId is provided");
    } else {
      const inferredFocus = await input.factoryService.inferObjectiveLiveOutputFocus(objectiveId);
      if (!inferredFocus) {
        throw new Error("factory.output requires focusKind/focusId, taskId/jobId, or an objective with exactly one active/nonterminal task (or exactly one task total)");
      }
      focusKind = inferredFocus.focusKind;
      focusId = inferredFocus.focusId;
    }
    const requestedWaitMs = clampWaitMs(toolInput.waitForChangeMs);
    const buildOutput = async (): Promise<Record<string, unknown>> => ({
      worker: "factory",
      action: "output",
      ...await input.factoryService.getObjectiveLiveOutput(objectiveId, focusKind, focusId),
    });
    const initial = await buildOutput();
    const live = initial.active === true;
    const waitForChangeMs = effectiveFactoryLiveWaitMs(requestedWaitMs, live, input.liveWaitState);
    const waited = waitForChangeMs > 0 && live
      ? await waitForSnapshotChange(initial, waitForChangeMs, buildOutput)
      : { value: initial, waitedMs: 0, changed: false };
    const payload = waited.waitedMs > 0
      ? { ...waited.value, waitedMs: waited.waitedMs, changed: waited.changed }
      : waited.value;
    if (live) input.liveWaitState.surfaced = true;
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

const isTerminalObjectiveStatus = (status: unknown): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

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
  const factoryLiveWaitState: FactoryLiveWaitState = { surfaced: false };
  const dataDir = input.dataDir;
  const factoryService = input.factoryService;
  const agentDelegateTool = createAsyncDelegateTool({
    queue: input.queue,
    runId: input.runId,
    stream: input.stream,
    repoKey,
    getCurrentObjectiveId,
    memoryTools: input.memoryTools,
    profile: resolvedProfile,
  });
  const agentStatusTool = createJobStatusTool({
    queue: input.queue,
    currentJobId: input.control?.jobId,
  });
  const jobsListTool = createJobsListTool({
    queue: input.queue,
    runId: input.runId,
    stream: input.stream,
    profile: resolvedProfile,
    getCurrentObjectiveId,
  });
  const repoStatusTool = createRepoStatusTool(repoRoot);
  const codexStatusTool = createCodexStatusTool({
    queue: input.queue,
    runId: input.runId,
    stream: input.stream,
    profile: resolvedProfile,
    getCurrentObjectiveId,
    dataDir,
  });
  const codexLogsTool = dataDir
    ? createCodexLogsTool({
      queue: input.queue,
      runId: input.runId,
      stream: input.stream,
      profile: resolvedProfile,
      getCurrentObjectiveId,
      dataDir,
    })
    : undefined;
  const jobControlTool = createJobControlTool({
    queue: input.queue,
    currentJobId: input.control?.jobId,
  });
  const codexRunTool = createCodexRunTool({
    repoRoot,
    repoKey,
    queue: input.queue,
    runId: input.runId,
    stream: input.stream,
    getCurrentObjectiveId,
    memoryTools: input.memoryTools,
    profile: resolvedProfile,
    dataDir,
  });
  const factoryDispatchTool = createFactoryDispatchTool({
    factoryService,
    repoKey,
    runId: input.runId,
    stream: input.stream,
    memoryTools: input.memoryTools,
    profileId: resolvedProfile.root.id,
    getCurrentObjectiveId,
    setCurrentObjectiveId,
  });
  const factoryStatusTool = createFactoryStatusTool({
    factoryService,
    getCurrentObjectiveId,
    liveWaitState: factoryLiveWaitState,
  });
  const factoryOutputTool = createFactoryOutputTool({
    factoryService,
    getCurrentObjectiveId,
    liveWaitState: factoryLiveWaitState,
  });
  const factoryReceiptsTool = createFactoryReceiptsTool({
    factoryService,
    getCurrentObjectiveId,
  });
  const capabilities = [
    createCapabilitySpec(agentDelegateCapability, agentDelegateTool),
    createCapabilitySpec(agentStatusCapability, agentStatusTool),
    createCapabilitySpec(jobsListCapability, jobsListTool),
    createCapabilitySpec(repoStatusCapability, repoStatusTool),
    createCapabilitySpec(codexStatusCapability, codexStatusTool),
    ...(codexLogsTool ? [
      createCapabilitySpec(codexLogsCapability, codexLogsTool),
    ] : []),
    createCapabilitySpec(jobControlCapability, jobControlTool),
    createCapabilitySpec(codexRunCapability, codexRunTool),
    createCapabilitySpec(factoryDispatchCapability, factoryDispatchTool),
    createCapabilitySpec(factoryStatusCapability, factoryStatusTool),
    createCapabilitySpec(factoryOutputCapability, factoryOutputTool),
    createCapabilitySpec(factoryReceiptsCapability, factoryReceiptsTool),
    ...(input.capabilities ?? []),
  ];
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
      lane: "chat",
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
  return await runAgent({
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
        resolvedProfileHash: resolvedProfile.resolvedHash,
        stream: resolvedStream,
      },
      promptContextBuilder: async (promptInput) => ({
        memory: await renderLayeredMemorySummary({
          memoryTools: input.memoryTools,
          repoKey,
          profileId: resolvedProfile.root.id,
          objectiveId: getCurrentObjectiveId(),
          primaryScope: resolvedMemoryScope,
          primarySummary: promptInput.memorySummary,
          query: promptInput.problem,
          runId: input.runId,
          iteration: promptInput.iteration,
        }),
        response_style: renderFactoryResponseStyleGuidance(promptInput.problem),
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
      capabilities,
      onIterationBudgetExhausted,
      finalizer: combineFinalizers(
        createLiveFactoryFinalizer({
          factoryService: input.factoryService,
          getCurrentObjectiveId,
          liveWaitState: factoryLiveWaitState,
          describeActiveChild: async () => {
            const activeChildren = (await listChildJobsForRun(input.queue, input.runId))
              .filter((job) => isActiveJobStatus(job.status))
              .sort((left, right) => right.updatedAt - left.updatedAt);
            const activeChild = activeChildren[0];
            if (!activeChild) return undefined;
            const snapshot = await codexJobSnapshot(activeChild, input.dataDir);
            return {
              jobId: activeChild.id,
              detail: summarizeChildProgress({
                lastMessage: asString(snapshot.lastMessage),
                stderrTail: asString(snapshot.stderrTail),
                stdoutTail: asString(snapshot.stdoutTail),
              }),
            };
          },
        }),
        input.finalizer,
      ),
    });
};

const DIRECT_CODEX_MUTATION_MESSAGE = "Direct Codex probes are read-only. This work needs code changes; create or react a Factory objective instead.";
const SANDBOX_BOOTSTRAP_COMPATIBILITY_RE = /\bbwrap:\s*Unknown option --argv0\b/i;

const looksLikeReadOnlyMutationFailure = (message: string): boolean =>
  /\bread[- ]only\b|\bpermission denied\b|\bcannot write\b|\bwrite access\b|\bsandbox\b/i.test(message);

const isSandboxBootstrapCompatibilityError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  if (SANDBOX_BOOTSTRAP_COMPATIBILITY_RE.test(message)) return true;
  if (!error || typeof error !== "object" || !("result" in error)) return false;
  const result = (error as { readonly result?: { readonly stderr?: string; readonly stdout?: string } }).result;
  return SANDBOX_BOOTSTRAP_COMPATIBILITY_RE.test(result?.stderr ?? "")
    || SANDBOX_BOOTSTRAP_COMPATIBILITY_RE.test(result?.stdout ?? "");
};

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
      progressAt: Date.now(),
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

  let workspacePath = input.repoRoot;
  let workspaceCleanup: (() => Promise<void>) | undefined;
  let sandboxMode = readOnly ? "read-only" : "workspace-write";
  let mutationPolicy = readOnly ? "read_only_probe" : "workspace_edit";
  let disableSandboxModeInference = false;
  let sandboxCompatibilityFallbackUsed = false;
  let initialChangedFileSnapshot = readOnly
    ? await gitChangedFileSnapshot(workspacePath)
    : undefined;

  const runExecutor = () => input.executor.run({
    prompt: renderedPrompt,
    workspacePath,
    promptPath: artifacts.promptPath,
    lastMessagePath: artifacts.lastMessagePath,
    stdoutPath: artifacts.stdoutPath,
    stderrPath: artifacts.stderrPath,
    timeoutMs: input.timeoutMs,
    env,
    sandboxMode,
    mutationPolicy,
    disableSandboxModeInference,
  }, control);

  try {
    let result;
    try {
      result = await runExecutor();
    } catch (err) {
      if (!readOnly || !isSandboxBootstrapCompatibilityError(err)) throw err;
      const fallbackWorkspace = await createDisposableProbeWorkspace(input.repoRoot, input.jobId);
      workspacePath = fallbackWorkspace.workspacePath;
      workspaceCleanup = fallbackWorkspace.cleanup;
      sandboxMode = undefined;
      disableSandboxModeInference = true;
      sandboxCompatibilityFallbackUsed = true;
      initialChangedFileSnapshot = await gitChangedFileSnapshot(workspacePath);
      await fs.appendFile(
        artifacts.stderrPath,
        "[factory] sandbox compatibility fallback: host sandbox startup failed; retrying read-only probe in a disposable workspace without Codex sandboxing.\n",
        "utf-8",
      ).catch(() => undefined);
      result = await runExecutor();
    }
    progressStopped = true;
    await progressLoop;
    await emitProgress();

    const [repoChangedFiles, finalChangedFileSnapshot] = await Promise.all([
      gitChangedFiles(input.repoRoot),
      readOnly ? gitChangedFileSnapshot(workspacePath) : Promise.resolve(undefined),
    ]);
    const changedFiles = readOnly && initialChangedFileSnapshot && finalChangedFileSnapshot
      ? diffGitChangedFileSnapshots(initialChangedFileSnapshot, finalChangedFileSnapshot)
      : repoChangedFiles;
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
        ...(typeof result.tokensUsed === "number" ? { tokensUsed: result.tokensUsed } : {}),
        changedFiles,
        ...(readOnly ? { repoChangedFiles } : {}),
        ...(sandboxCompatibilityFallbackUsed ? { sandboxCompatibilityFallbackUsed: true } : {}),
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
      ...(typeof result.tokensUsed === "number" ? { tokensUsed: result.tokensUsed } : {}),
      changedFiles,
      ...(readOnly ? { repoChangedFiles } : {}),
      ...(sandboxCompatibilityFallbackUsed ? { sandboxCompatibilityFallbackUsed: true } : {}),
      artifacts,
    };
    await writeResult(completed);
    return completed;
  } catch (err) {
    progressStopped = true;
    await progressLoop;
    await emitProgress();

    const [lastMessage, stdoutTail, stderrTail, repoChangedFiles, finalChangedFileSnapshot] = await Promise.all([
      readTextTail(artifacts.lastMessagePath, 400),
      readTextTail(artifacts.stdoutPath, 900),
      readTextTail(artifacts.stderrPath, 600),
      gitChangedFiles(input.repoRoot),
      readOnly ? gitChangedFileSnapshot(workspacePath) : Promise.resolve(undefined),
    ]);
    const changedFiles = readOnly && initialChangedFileSnapshot && finalChangedFileSnapshot
      ? diffGitChangedFileSnapshots(initialChangedFileSnapshot, finalChangedFileSnapshot)
      : repoChangedFiles;
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
      ...(readOnly ? { repoChangedFiles } : {}),
      ...(sandboxCompatibilityFallbackUsed ? { sandboxCompatibilityFallbackUsed: true } : {}),
      artifacts,
    });
    throw new Error(message);
  } finally {
    if (workspaceCleanup) {
      await workspaceCleanup().catch(() => undefined);
    }
  }
};
