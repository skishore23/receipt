import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { jsonBranchStore, jsonlStore } from "../adapters/jsonl";
import type { JsonlQueue, QueueJob } from "../adapters/jsonl-queue";
import type { CodexExecutor, CodexRunControl, CodexRunInput } from "../adapters/codex-executor";
import { HubGit } from "../adapters/hub-git";
import type { MemoryTools } from "../adapters/memory-tools";
import {
  DEFAULT_FACTORY_OBJECTIVE_POLICY,
  DEFAULT_FACTORY_OBJECTIVE_PROFILE,
  buildFactoryProjection,
  decideFactory,
  factoryActivatableTasks,
  factoryReadyTasks,
  initialFactoryState,
  normalizeFactoryState,
  normalizeFactoryObjectiveProfileSnapshot,
  normalizeFactoryObjectivePolicy,
  reduceFactory,
  type FactoryBudgetState,
  type FactoryCandidateRecord,
  type FactoryInvestigationReport,
  type FactoryInvestigationSynthesisRecord,
  type FactoryInvestigationTaskReport,
  type FactoryPlanningReceiptRecord,
  type FactoryExecutionScriptRun,
  type FactoryObjectivePhase,
  type FactoryObjectiveMode,
  type FactoryCheckResult,
  type FactoryCmd,
  type FactoryEvent,
  type FactoryObjectiveProfileSnapshot,
  type FactoryObjectiveSeverity,
  type FactoryObjectiveStatus,
  type FactoryState,
  type FactoryTaskExecutionMode,
  type FactoryTaskResultOutcome,
  type FactoryTaskRecord,
  type FactoryTaskStatus,
  type FactoryWorkerType,
  type FactoryCandidateStatus,
} from "../modules/factory";
import { repoKeyForRoot, resolveFactoryChatProfile } from "./factory-chat-profiles";
import {
  buildFactoryMemoryScriptSource,
  factoryChatCodexArtifactPaths,
  type FactoryChatCodexArtifactPaths,
} from "./factory-codex-artifacts";
import {
  helperCatalogArtifactRefs,
  loadFactoryHelperContext,
  renderFactoryHelperPromptSection,
  type FactoryHelperContext,
} from "./factory-helper-catalog";
import {
  scanFactoryCloudExecutionContext,
  type FactoryCloudExecutionContext,
  type FactoryCloudProvider,
} from "./factory-cloud-context";
import { resolveFactoryCloudExecutionContext } from "./factory-cloud-targeting";
import {
  cloudProviderDefaultsToAws,
  rewriteInfrastructureTaskPromptForExecution,
  renderInfrastructureTaskExecutionGuidance,
} from "./factory-infrastructure-guidance";
import {
  buildFactoryFailureSignature,
  buildInheritedFactoryFailureNote,
  priorFactoryFailureSignatureMap,
} from "./factory/failure-policy";
import {
  buildFactoryPlanningReceipt,
  planningReceiptFingerprint,
  renderPlanningReceiptLines,
} from "./factory/planning";
import {
  factoryPromotionGateBlockedReason,
  factoryTaskCompletionForTask,
} from "./factory/promotion-gate";
import {
  buildDefaultTaskCompletion,
  FACTORY_INVESTIGATION_TASK_RESULT_SCHEMA,
  FACTORY_PUBLISH_RESULT_SCHEMA,
  FACTORY_TASK_RESULT_SCHEMA,
  normalizeExecutionScriptsRun,
  normalizeInvestigationReport,
  normalizeTaskCompletionRecord,
  renderDeliveryResultText,
  renderInvestigationReportText,
} from "./factory/result-contracts";
import {
  resolveFactoryPublishWorkerResult,
  resolveFactoryTaskWorkerResult,
  type FactoryPublishResult,
} from "./factory/worker-results";
import {
  detectArtifactIssues,
  pathExists,
  readTextIfPresent,
  readdirIfPresent,
  type FactoryArtifactIssue,
} from "./factory/artifact-inspection";
import { inferObjectiveLiveOutputFocusFromDetail } from "./factory/live-output";
import {
  processObjectiveReconcileControl,
  processObjectiveStartupControl,
} from "./factory/objective-control";
import { createRuntime, type Runtime } from "@receipt/core/runtime";
import { type GraphRef } from "@receipt/core/graph";
import { CONTROL_RECEIPT_TYPES } from "../engine/runtime/control-receipts";
import { makeEventId, optionalTrimmedString, requireTrimmedString, trimmedString } from "../framework/http";
import type { SseHub } from "../framework/sse-hub";
import { resolveCliInvocation } from "../lib/runtime-paths";
import type { JobCmd, JobEvent, JobRecord, JobState, JobStatus } from "../modules/job";

const execFileAsync = promisify(execFile);

const FACTORY_STREAM_PREFIX = "factory/objectives";
const DEFAULT_CHECKS = ["bun run build"] as const;
const FACTORY_DATA_DIR = ".receipt/factory";
const DEFAULT_FACTORY_PROFILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FACTORY_CONTROL_AGENT_ID = "factory-control";
const OBJECTIVE_CONTROL_REDRIVE_AGE_MS = 30_000;
const SUPPORTED_WORKER_TYPES = new Set<FactoryWorkerType>(["codex", "agent", "infra"]);

const resolveRepoRoot = (repoRoot?: string): string =>
  repoRoot?.trim()
  || process.env.RECEIPT_REPO_ROOT?.trim()
  || process.env.HUB_REPO_ROOT?.trim()
  || process.cwd();
const FACTORY_TASK_CODEX_MODEL =
  process.env.RECEIPT_FACTORY_TASK_MODEL?.trim()
  || process.env.HUB_FACTORY_TASK_MODEL?.trim()
  || "gpt-5.4-mini";
const MAX_CONSECUTIVE_TASK_FAILURES = 5;
const RETRYABLE_BLOCK_REASON_RE = /\b(factory task failed|lease expired|timed out|timeout|missing structured factory task result|transient|temporary|connection reset|econnreset|spawn|signal|unexpectedly canceled|interrupted)\b/i;
const NON_RETRYABLE_BLOCK_REASON_RE = /\b(no tracked diff|isolated runtime|cannot run in isolated mode|policy blocked|circuit[- ]broken|integration validation failed)\b/i;
const HUMAN_INPUT_BLOCK_REASON_RE = /\b(missing (?:dependency |implementation |product |design )?details?|need .*detail|need .*guidance|need .*clarification|choose|which (?:approach|option|api|path)|operator|human|approval|permission denied|access denied|unauthorized|credentials|auth(?:entication|orization)?|forbidden)\b/i;
const AUTONOMOUS_RETRY_MAX_CANDIDATE_PASSES = 1;
const PUBLISH_TRANSIENT_FAILURE_RE =
  /\b(could not resolve host|temporary failure in name resolution|name resolution|enotfound|eai_again|error connecting to api\.github\.com|githubstatus\.com|timed out|timeout|connection reset|econnreset|connection refused|econnrefused|network is unreachable|tls handshake timeout|502 bad gateway|503 service unavailable|504 gateway timeout)\b/i;
const PUBLISH_MAX_ATTEMPTS = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const requireNonEmpty = (value: unknown, message: string): string => {
  try {
    return requireTrimmedString(value, message);
  } catch {
    throw new FactoryServiceError(400, message);
  }
};

const clipText = (value: string | undefined, max = 280): string | undefined => {
  if (!value) return undefined;
  const trimmed = trimmedString(value);
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};
const safeWorkspacePart = (value: string): string =>
  value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
const tailText = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value.trimEnd() : `…${value.slice(value.length - maxChars).trimEnd()}`;
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const FACTORY_CLI_PREFIX = (() => {
  const { command, args } = resolveCliInvocation(import.meta.url);
  return [command, ...args].map((item) => shellQuote(item)).join(" ");
})();
const prependPath = (dir: string, currentPath: string | undefined): string =>
  currentPath ? `${dir}${path.delimiter}${currentPath}` : dir;
const prependPaths = (entries: ReadonlyArray<string | undefined>, currentPath: string | undefined): string =>
  entries
    .map((entry) => entry?.trim())
    .filter((entry): entry is string => Boolean(entry))
    .reduceRight<string>((acc, entry) => prependPath(entry, acc), currentPath ?? "");
const runtimeBunPathEntries = (): ReadonlyArray<string> => {
  const candidates = [
    process.env.RECEIPT_BUN_BIN?.trim() ? path.dirname(process.env.RECEIPT_BUN_BIN.trim()) : undefined,
    path.basename(process.execPath || "").toLowerCase().includes("bun") ? path.dirname(process.execPath) : undefined,
    process.env.BUN_INSTALL?.trim() ? path.join(process.env.BUN_INSTALL.trim(), "bin") : undefined,
    process.env.HOME?.trim() ? path.join(process.env.HOME.trim(), ".bun", "bin") : undefined,
  ];
  return [...new Set(candidates.filter((entry): entry is string => Boolean(entry)))];
};
const isPathWithinRoot = (targetPath: string, rootPath: string): boolean => {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const uniqueChecks = (checks?: ReadonlyArray<string>): ReadonlyArray<string> => {
  const source = (checks ?? DEFAULT_CHECKS)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(source)];
};
const stateRef = (ref: string, label?: string): GraphRef => ({ kind: "state", ref, label });
const fileRef = (ref: string, label?: string): GraphRef => ({ kind: "file", ref, label });
const commitRef = (ref: string, label?: string): GraphRef => ({ kind: "commit", ref, label });
const workspaceRef = (ref: string, label?: string): GraphRef => ({ kind: "workspace", ref, label });
const artifactRef = (ref: string, label?: string): GraphRef => ({ kind: "artifact", ref, label });
const isTerminalJobStatus = (status?: JobStatus | "missing"): boolean =>
  status === "completed" || status === "failed" || status === "canceled";
const isActiveJobStatus = (status?: JobStatus | "missing"): boolean =>
  status === "queued" || status === "leased" || status === "running";
const INFRASTRUCTURE_KNOWLEDGE_GENERIC_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "count",
  "current",
  "describe",
  "engineer",
  "for",
  "from",
  "have",
  "how",
  "infra",
  "infrastructure",
  "inventory",
  "investigate",
  "list",
  "me",
  "my",
  "of",
  "show",
  "the",
  "what",
  "which",
  "without",
  "you",
]);
const INFRASTRUCTURE_KNOWLEDGE_MAX_SELECTIONS = 3;
const INFRASTRUCTURE_KNOWLEDGE_MAX_SCRIPTS_PER_ENTRY = 3;
const INFRASTRUCTURE_KNOWLEDGE_MAX_ARTIFACTS_PER_ENTRY = 3;
const INFRASTRUCTURE_KNOWLEDGE_MAX_STORED_FILE_BYTES = 1024 * 1024;
const INFRASTRUCTURE_KNOWLEDGE_SCRIPT_RE = /\.(?:sh|bash|py|js|mjs|cjs|ts)$/i;
const INFRASTRUCTURE_KNOWLEDGE_COPYABLE_RE = /\.(?:sh|bash|py|js|mjs|cjs|ts|json|md|txt|csv|ya?ml)$/i;

const normalizeInfrastructureKnowledgeText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const infrastructureKnowledgeKeywords = (
  value: string,
  ignoredTokens: ReadonlyArray<string> = [],
): ReadonlyArray<string> => {
  const ignored = new Set(
    ignoredTokens
      .flatMap((token) => normalizeInfrastructureKnowledgeText(token).split(/\s+/))
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
  return [...new Set(
    normalizeInfrastructureKnowledgeText(value)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) =>
        token.length >= 3
        && !INFRASTRUCTURE_KNOWLEDGE_GENERIC_STOP_WORDS.has(token)
        && !ignored.has(token)
      ),
  )];
};

const infrastructureKnowledgeFingerprint = (value: string): string =>
  createHash("sha1").update(normalizeInfrastructureKnowledgeText(value)).digest("hex").slice(0, 16);

const unquoteShellToken = (token: string): string =>
  token.replace(/^['"]|['"]$/g, "").trim();

const commandPathCandidates = (command: string): ReadonlyArray<string> =>
  [...new Set(
    (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [])
      .map((token) => unquoteShellToken(token))
      .filter((token) => {
        if (!token) return false;
        const lower = token.toLowerCase();
        if (["aws", "bash", "bun", "env", "jq", "node", "python", "python3", "sh"].includes(lower)) return false;
        if (token.includes("=") && !token.includes("/") && !token.startsWith(".")) return false;
        return token.startsWith("/")
          || token.startsWith("./")
          || token.startsWith("../")
          || token.startsWith(".receipt/")
          || INFRASTRUCTURE_KNOWLEDGE_COPYABLE_RE.test(token);
      }),
  )];

const preferredInfrastructureKnowledgePath = (value: { readonly storedPath?: string; readonly originalPath?: string }): string | undefined =>
  value.storedPath ?? value.originalPath;

const boardSectionForObjective = (
  objective: Pick<FactoryObjectiveCard, "status" | "scheduler">,
): FactoryBoardSection => {
  if (objective.status === "completed" || objective.status === "canceled") return "completed";
  if (objective.status === "blocked" || objective.status === "failed") return "needs_attention";
  if (objective.scheduler.slotState === "queued") return "queued";
  return "active";
};

const objectiveTaskStatusPriority = (status: FactoryTaskStatus): number => {
  switch (status) {
    case "running":
      return 0;
    case "reviewing":
      return 1;
    case "ready":
      return 2;
    case "blocked":
      return 3;
    case "pending":
      return 4;
    case "approved":
      return 5;
    case "integrated":
      return 6;
    case "superseded":
      return 7;
    default:
      return 8;
  }
};

const normalizeObjectiveModeInput = (
  value: unknown,
  fallback: FactoryObjectiveMode,
): FactoryObjectiveMode =>
  value === "investigation" || value === "delivery" ? value : fallback;

const normalizeObjectiveSeverityInput = (
  value: unknown,
  fallback: FactoryObjectiveSeverity,
): FactoryObjectiveSeverity => {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.max(1, Math.min(5, Math.round(numeric)));
  return rounded as FactoryObjectiveSeverity;
};

const severityMaxParallelChildren = (severity: FactoryObjectiveSeverity): number => {
  switch (severity) {
    case 1:
      return 20;
    case 2:
      return 12;
    case 3:
      return 8;
    case 4:
      return 4;
    case 5:
      return 2;
    default:
      return 2;
  }
};

const severityWorkerReasoningEffort = (
  _profileId: string | undefined,
  objectiveMode: FactoryObjectiveMode,
  severity: FactoryObjectiveSeverity,
  _taskKind: FactoryTaskRecord["taskKind"],
): "low" | "medium" | "high" | "xhigh" => {
  if (objectiveMode === "investigation") {
    return severity === 1 ? "medium" : "high";
  }
  return "low";
};

import {
  FactoryServiceError,
  type FactoryServiceOptions,
  type FactoryObjectiveInput,
  type FactoryObjectiveComposeInput,
  type FactoryQueuedJobCommand,
  type FactoryContextSources,
  type FactoryArtifactActivity,
  type FactoryTaskView,
  type FactoryObjectiveCard,
  type FactoryObjectiveDetail,
  type FactoryComposeModel,
  type FactoryBoardSection,
  type FactoryBoardProjection,
  type FactoryLiveProjection,
  type FactoryLiveOutputTargetKind,
  type FactoryLiveOutputSnapshot,
  type FactoryDebugProjection,
  type FactoryTaskJobPayload,
  type FactoryIntegrationJobPayload,
  type FactoryIntegrationPublishJobPayload,
  type FactoryObjectiveControlJobPayload,
  type FactoryObjectiveReceiptSummary,
  type FactoryObjectiveReceiptQuery,
  FACTORY_PROFILE_SUMMARY,
} from "./factory-types";

export {
  FactoryServiceError,
  FACTORY_PROFILE_SUMMARY,
};

export type {
  FactoryServiceOptions,
  FactoryObjectiveInput,
  FactoryObjectiveComposeInput,
  FactoryQueuedJobCommand,
  FactoryContextSources,
  FactoryArtifactActivity,
  FactoryTaskView,
  FactoryObjectiveCard,
  FactoryObjectiveDetail,
  FactoryComposeModel,
  FactoryBoardSection,
  FactoryBoardProjection,
  FactoryLiveProjection,
  FactoryLiveOutputTargetKind,
  FactoryLiveOutputSnapshot,
  FactoryDebugProjection,
  FactoryTaskJobPayload,
  FactoryIntegrationJobPayload,
  FactoryIntegrationPublishJobPayload,
  FactoryObjectiveControlJobPayload,
  FactoryObjectiveReceiptSummary,
  FactoryObjectiveReceiptQuery,
} from "./factory-types";

class FactoryStaleObjectiveError extends Error {
  readonly objectiveId: string;
  readonly expectedPrev: string;

  constructor(objectiveId: string, expectedPrev: string, actualPrev?: string) {
    super(`factory objective ${objectiveId} advanced before applying a mutation (${expectedPrev} -> ${actualPrev ?? "undefined"})`);
    this.objectiveId = objectiveId;
    this.expectedPrev = expectedPrev;
  }
}


type FactoryMemoryScopeSpec = {
  readonly key: string;
  readonly scope: string;
  readonly label: string;
  readonly defaultQuery: string;
};

type FactoryContextTaskNode = {
  readonly taskId: string;
  readonly taskKind: FactoryTaskRecord["taskKind"];
  readonly title: string;
  readonly status: FactoryTaskStatus;
  readonly workerType: FactoryWorkerType;
  readonly sourceTaskId?: string;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly candidateId?: string;
  readonly candidateStatus?: FactoryCandidateStatus;
  readonly memorySummary?: string;
  readonly children: ReadonlyArray<FactoryContextTaskNode>;
};

type FactoryContextRelatedTask = {
  readonly taskId: string;
  readonly taskKind: FactoryTaskRecord["taskKind"];
  readonly title: string;
  readonly status: FactoryTaskStatus;
  readonly workerType: FactoryWorkerType;
  readonly sourceTaskId?: string;
  readonly relations: ReadonlyArray<"focus" | "dependency" | "dependent">;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly candidateId?: string;
  readonly candidateStatus?: FactoryCandidateStatus;
  readonly memorySummary?: string;
};

type FactoryContextReceipt = {
  readonly type: string;
  readonly at: number;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly summary: string;
};

type FactoryContextObjectiveSlice = {
  readonly frontierTasks: ReadonlyArray<FactoryContextRelatedTask>;
  readonly recentCompletedTasks: ReadonlyArray<FactoryContextRelatedTask>;
  readonly integrationTasks: ReadonlyArray<FactoryContextRelatedTask>;
  readonly recentObjectiveReceipts: ReadonlyArray<FactoryContextReceipt>;
  readonly objectiveMemorySummary?: string;
  readonly integrationMemorySummary?: string;
};

type FactoryContextPack = {
  readonly objectiveId: string;
  readonly title: string;
  readonly prompt: string;
  readonly objectiveMode: FactoryObjectiveMode;
  readonly severity: FactoryObjectiveSeverity;
  readonly planning?: FactoryPlanningReceiptRecord;
  readonly cloudExecutionContext?: FactoryCloudExecutionContext;
  readonly profile: FactoryObjectiveProfileSnapshot;
  readonly task: {
    readonly taskId: string;
    readonly title: string;
    readonly prompt: string;
    readonly workerType: FactoryWorkerType;
    readonly executionMode: FactoryTaskExecutionMode;
    readonly status: FactoryTaskStatus;
    readonly candidateId: string;
  };
  readonly integration: {
    readonly status: FactoryState["integration"]["status"];
    readonly headCommit?: string;
    readonly activeCandidateId?: string;
    readonly conflictReason?: string;
    readonly lastSummary?: string;
  };
  readonly dependencyTree: ReadonlyArray<FactoryContextTaskNode>;
  readonly relatedTasks: ReadonlyArray<FactoryContextRelatedTask>;
  readonly candidateLineage: ReadonlyArray<{
    readonly candidateId: string;
    readonly parentCandidateId?: string;
    readonly status: FactoryCandidateStatus;
    readonly summary?: string;
    readonly headCommit?: string;
    readonly latestReason?: string;
    readonly scriptsRun?: ReadonlyArray<FactoryExecutionScriptRun>;
  }>;
  readonly recentReceipts: ReadonlyArray<FactoryContextReceipt>;
  readonly objectiveSlice: FactoryContextObjectiveSlice;
  readonly memory: {
    readonly overview?: string;
    readonly objective?: string;
    readonly integration?: string;
  };
  readonly investigation: {
    readonly reports: ReadonlyArray<FactoryInvestigationTaskReport>;
    readonly synthesized?: FactoryInvestigationSynthesisRecord;
  };
  readonly helperCatalog?: FactoryHelperContext;
  readonly contextSources: FactoryContextSources;
};

type FactoryInfrastructureKnowledgeScript = {
  readonly command: string;
  readonly summary?: string;
  readonly status?: FactoryInvestigationReport["scriptsRun"][number]["status"];
  readonly originalPath?: string;
  readonly storedPath?: string;
};

type FactoryInfrastructureKnowledgeArtifact = {
  readonly label: string;
  readonly summary?: string;
  readonly originalPath?: string;
  readonly storedPath?: string;
};

type FactoryInfrastructureKnowledgeEntry = {
  readonly entryId: string;
  readonly repoKey: string;
  readonly profileId: string;
  readonly provider: FactoryCloudProvider;
  readonly accountId?: string;
  readonly promptFingerprint: string;
  readonly keywords: ReadonlyArray<string>;
  readonly objectiveId: string;
  readonly objectiveTitle: string;
  readonly objectivePrompt: string;
  readonly objectiveMode: FactoryObjectiveMode;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskPrompt: string;
  readonly candidateId: string;
  readonly summary: string;
  readonly conclusion?: string;
  readonly scripts: ReadonlyArray<FactoryInfrastructureKnowledgeScript>;
  readonly artifacts: ReadonlyArray<FactoryInfrastructureKnowledgeArtifact>;
  readonly createdAt: number;
  readonly updatedAt: number;
};

type FactoryInfrastructureKnowledgeIndexEntry = {
  readonly entryId: string;
  readonly knowledgePath: string;
  readonly provider: FactoryCloudProvider;
  readonly profileId: string;
  readonly accountId?: string;
  readonly promptFingerprint: string;
  readonly keywords: ReadonlyArray<string>;
  readonly objectiveId: string;
  readonly taskId: string;
  readonly summary: string;
  readonly updatedAt: number;
  readonly scriptPaths: ReadonlyArray<string>;
  readonly artifactPaths: ReadonlyArray<string>;
};

type FactoryInfrastructureKnowledgeSelection = {
  readonly entryId: string;
  readonly knowledgePath: string;
  readonly provider: FactoryCloudProvider;
  readonly accountId?: string;
  readonly objectiveId: string;
  readonly taskId: string;
  readonly summary: string;
  readonly updatedAt: number;
  readonly score: number;
  readonly scriptPaths: ReadonlyArray<string>;
  readonly artifactPaths: ReadonlyArray<string>;
};

type FactoryInfrastructureKnowledgeContext = {
  readonly roleLabel: string;
  readonly guidance: ReadonlyArray<string>;
  readonly selectedEntries: ReadonlyArray<FactoryInfrastructureKnowledgeSelection>;
};

const normalizeWorkerType = (value: string | undefined): FactoryWorkerType => {
  const normalized = (value ?? "codex").trim().toLowerCase() || "codex";
  return SUPPORTED_WORKER_TYPES.has(normalized) ? normalized : "codex";
};

const sandboxModeForTask = (): CodexRunInput["sandboxMode"] | undefined => undefined;

const taskOrdinalId = (index: number): string => `task_${String(index + 1).padStart(2, "0")}`;

const objectiveStream = (objectiveId: string): string => `${FACTORY_STREAM_PREFIX}/${objectiveId}`;


export class FactoryService {
  readonly dataDir: string;
  readonly queue: JsonlQueue;
  readonly jobRuntime: Runtime<JobCmd, JobEvent, JobState>;
  readonly sse: SseHub;
  readonly codexExecutor: CodexExecutor;
  readonly memoryTools?: MemoryTools;
  readonly git: HubGit;
  readonly profileRoot: string;
  private readonly cloudExecutionContextProvider?: FactoryServiceOptions["cloudExecutionContextProvider"];
  private readonly redriveQueuedJob?: FactoryServiceOptions["redriveQueuedJob"];
  private readonly baselineCheckCache = new Map<string, Promise<{
    readonly digest: string;
    readonly excerpt: string;
  } | undefined>>();
  private cloudExecutionContextPromise?: Promise<FactoryCloudExecutionContext>;

  private readonly runtime: Runtime<FactoryCmd, FactoryEvent, FactoryState>;
  private objectiveProjectionVersion = 0;
  private objectiveStateListCache?: {
    readonly version: number;
    readonly states: ReadonlyArray<FactoryState>;
  };
  private objectiveListCache?: {
    readonly version: number;
    readonly cards: ReadonlyArray<FactoryObjectiveCard>;
  };
  private readonly objectiveCardCache = new Map<string, {
    readonly key: string;
    readonly card: FactoryObjectiveCard;
  }>();

  constructor(opts: FactoryServiceOptions) {
    this.dataDir = opts.dataDir;
    this.queue = opts.queue;
    this.jobRuntime = opts.jobRuntime;
    this.sse = opts.sse;
    this.codexExecutor = opts.codexExecutor;
    this.memoryTools = opts.memoryTools;
    this.cloudExecutionContextProvider = opts.cloudExecutionContextProvider;
    this.redriveQueuedJob = opts.redriveQueuedJob;
    this.git = new HubGit({
      dataDir: opts.dataDir,
      repoRoot: resolveRepoRoot(opts.repoRoot),
    });
    this.profileRoot = path.resolve(opts.profileRoot ?? DEFAULT_FACTORY_PROFILE_ROOT);
    this.runtime = createRuntime<FactoryCmd, FactoryEvent, FactoryState>(
      jsonlStore<FactoryEvent>(opts.dataDir),
      jsonBranchStore(opts.dataDir),
      decideFactory,
      reduceFactory,
      initialFactoryState,
    );
  }

  async ensureBootstrap(): Promise<void> {
    await this.git.ensureReady();
  }

  private async loadCloudExecutionContext(): Promise<FactoryCloudExecutionContext> {
    if (!this.cloudExecutionContextPromise) {
      this.cloudExecutionContextPromise = (this.cloudExecutionContextProvider
        ? this.cloudExecutionContextProvider()
        : scanFactoryCloudExecutionContext()
      ).catch(() => ({
        summary: "No live cloud execution context could be detected from this machine.",
        availableProviders: [],
        activeProviders: [],
        guidance: ["If provider context is unclear, probe the local CLI before asking the user to restate it."],
      }));
    }
    return this.cloudExecutionContextPromise;
  }

  private async loadObjectiveCloudExecutionContext(
    profile: Pick<FactoryObjectiveProfileSnapshot, "cloudProvider">,
  ): Promise<FactoryCloudExecutionContext> {
    return resolveFactoryCloudExecutionContext(profile.cloudProvider, await this.loadCloudExecutionContext());
  }

  projectionVersion(): number {
    return this.objectiveProjectionVersion;
  }

  private invalidateObjectiveProjection(objectiveId?: string): void {
    this.objectiveProjectionVersion += 1;
    this.objectiveStateListCache = undefined;
    this.objectiveListCache = undefined;
    if (objectiveId) {
      this.objectiveCardCache.delete(objectiveId);
    } else {
      this.objectiveCardCache.clear();
    }
  }

  private objectiveArtifactsDir(objectiveId: string): string {
    return path.join(this.dataDir, "factory", "artifacts", objectiveId);
  }

  private objectiveProfileArtifactPath(objectiveId: string): string {
    return path.join(this.objectiveArtifactsDir(objectiveId), "profile.snapshot.json");
  }

  private objectiveSkillSelectionArtifactPath(objectiveId: string): string {
    return path.join(this.objectiveArtifactsDir(objectiveId), "profile.skills.json");
  }

  private taskRuntimeDir(workspaceId: string): string {
    return path.join(this.dataDir, "factory", "runtimes", workspaceId);
  }

  private taskRuntimesRoot(): string {
    return path.join(this.dataDir, "factory", "runtimes");
  }

  private normalizeProfileWorkerType(
    profile: FactoryObjectiveProfileSnapshot,
    requestedWorkerType: string | undefined,
  ): FactoryWorkerType {
    const requested = normalizeWorkerType(requestedWorkerType);
    if (profile.objectivePolicy.allowedWorkerTypes.includes(requested)) {
      return requested;
    }
    const fallback = normalizeWorkerType(String(profile.objectivePolicy.defaultWorkerType));
    if (profile.objectivePolicy.allowedWorkerTypes.includes(fallback)) {
      return fallback;
    }
    const codex = normalizeWorkerType("codex");
    if (profile.objectivePolicy.allowedWorkerTypes.includes(codex)) return codex;
    return normalizeWorkerType(String(DEFAULT_FACTORY_OBJECTIVE_PROFILE.objectivePolicy.defaultWorkerType));
  }

  private objectiveProfileForState(state: FactoryState): FactoryObjectiveProfileSnapshot {
    return normalizeFactoryObjectiveProfileSnapshot(state.profile);
  }

  private objectiveAllowsWorker(state: FactoryState, workerType: string | undefined): boolean {
    const normalized = normalizeWorkerType(workerType);
    return this.objectiveProfileForState(state).objectivePolicy.allowedWorkerTypes.includes(normalized);
  }

  private taskExecutionMode(
    state: FactoryState,
    task?: Pick<FactoryTaskRecord, "executionMode">,
  ): FactoryTaskExecutionMode {
    return task?.executionMode ?? this.objectiveProfileForState(state).objectivePolicy.defaultTaskExecutionMode;
  }

  private effectiveMaxParallelChildren(state: FactoryState): number {
    return Math.max(
      1,
      Math.min(
        state.policy.concurrency.maxActiveTasks,
        severityMaxParallelChildren(state.severity),
        this.objectiveProfileForState(state).objectivePolicy.maxParallelChildren,
      ),
    );
  }

  private buildContextSources(
    state: FactoryState,
    repoSkillPaths: ReadonlyArray<string>,
    sharedArtifactRefs: ReadonlyArray<GraphRef>,
  ): FactoryContextSources {
    return {
      repoSharedMemoryScope: "factory/repo/shared",
      objectiveMemoryScope: `factory/objectives/${state.objectiveId}`,
      integrationMemoryScope: `factory/objectives/${state.objectiveId}/integration`,
      profileSkillRefs: this.objectiveProfileForState(state).selectedSkills,
      repoSkillPaths,
      sharedArtifactRefs,
    };
  }

  private workerTaskSkillRefs(selectedSkills: ReadonlyArray<string>): ReadonlyArray<string> {
    return selectedSkills.filter((skillPath) =>
      !skillPath.includes("skills/factory-run-orchestrator/")
      && !skillPath.includes("skills\\factory-run-orchestrator\\")
    );
  }

  private workerTaskProfile(profile: FactoryObjectiveProfileSnapshot): FactoryObjectiveProfileSnapshot {
    const selectedSkills = this.workerTaskSkillRefs(profile.selectedSkills);
    if (selectedSkills.length === profile.selectedSkills.length) return profile;
    return {
      ...profile,
      selectedSkills,
    };
  }

  private async writeObjectiveProfileArtifacts(
    objectiveId: string,
    profile: FactoryObjectiveProfileSnapshot,
  ): Promise<ReadonlyArray<GraphRef>> {
    const artifactDir = this.objectiveArtifactsDir(objectiveId);
    const profilePath = this.objectiveProfileArtifactPath(objectiveId);
    const skillsPath = this.objectiveSkillSelectionArtifactPath(objectiveId);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(profilePath, JSON.stringify(profile, null, 2), "utf-8");
    await fs.writeFile(skillsPath, JSON.stringify({
      objectiveId,
      selectedSkills: profile.selectedSkills,
      promptPath: profile.promptPath,
      promptHash: profile.promptHash,
      writtenAt: Date.now(),
    }, null, 2), "utf-8");
    return [
      artifactRef(profilePath, "objective profile snapshot"),
      artifactRef(skillsPath, "objective profile skills"),
    ];
  }

  private repoInfrastructureKnowledgeRoot(): string {
    return path.join(this.dataDir, "factory", "knowledge", repoKeyForRoot(this.git.repoRoot), "infrastructure");
  }

  private repoInfrastructureKnowledgeEntriesDir(): string {
    return path.join(this.repoInfrastructureKnowledgeRoot(), "entries");
  }

  private repoInfrastructureKnowledgeIndexPath(): string {
    return path.join(this.repoInfrastructureKnowledgeRoot(), "index.json");
  }

  private repoInfrastructureKnowledgeEntryDir(entryId: string): string {
    return path.join(this.repoInfrastructureKnowledgeEntriesDir(), entryId);
  }

  private repoInfrastructureKnowledgeEntryPath(entryId: string): string {
    return path.join(this.repoInfrastructureKnowledgeEntryDir(entryId), "entry.json");
  }

  private buildInfrastructureKnowledgeQueryText(input: {
    readonly objectiveTitle?: string;
    readonly objectivePrompt: string;
    readonly taskTitle?: string;
    readonly taskPrompt?: string;
  }): string {
    return [
      input.objectiveTitle,
      input.objectivePrompt,
      input.taskTitle,
      input.taskPrompt,
    ].filter(Boolean).join("\n");
  }

  private resolveInfrastructureKnowledgePath(candidatePath: string | undefined, workspacePath: string): string | undefined {
    const trimmed = optionalTrimmedString(candidatePath);
    if (!trimmed) return undefined;
    return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(workspacePath, trimmed);
  }

  private async copyInfrastructureKnowledgeFile(
    sourcePath: string | undefined,
    targetDir: string,
    targetName: string,
  ): Promise<string | undefined> {
    const resolved = optionalTrimmedString(sourcePath);
    if (!resolved) return undefined;
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile() || stat.size > INFRASTRUCTURE_KNOWLEDGE_MAX_STORED_FILE_BYTES) return undefined;
      await fs.mkdir(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, targetName);
      await fs.copyFile(resolved, targetPath);
      return targetPath;
    } catch {
      return undefined;
    }
  }

  private async materializeInfrastructureKnowledgeScripts(input: {
    readonly report: FactoryInvestigationReport;
    readonly workspacePath: string;
    readonly entryDir: string;
  }): Promise<ReadonlyArray<FactoryInfrastructureKnowledgeScript>> {
    const scriptsDir = path.join(input.entryDir, "scripts");
    const materialized: FactoryInfrastructureKnowledgeScript[] = [];
    for (const [index, item] of input.report.scriptsRun.entries()) {
      if (materialized.length >= INFRASTRUCTURE_KNOWLEDGE_MAX_SCRIPTS_PER_ENTRY) break;
      const originalPath = commandPathCandidates(item.command)
        .map((candidate) => this.resolveInfrastructureKnowledgePath(candidate, input.workspacePath))
        .find((candidate): candidate is string => typeof candidate === "string" && INFRASTRUCTURE_KNOWLEDGE_SCRIPT_RE.test(candidate));
      const baseName = safeWorkspacePart(path.basename(originalPath ?? `script_${index + 1}.sh`));
      const storedPath = originalPath
        ? await this.copyInfrastructureKnowledgeFile(originalPath, scriptsDir, `${String(index + 1).padStart(2, "0")}_${baseName}`)
        : undefined;
      materialized.push({
        command: item.command,
        summary: item.summary ?? undefined,
        status: item.status ?? undefined,
        originalPath,
        storedPath,
      });
    }
    return materialized;
  }

  private async materializeInfrastructureKnowledgeArtifacts(input: {
    readonly artifacts: ReadonlyArray<{
      readonly label: string;
      readonly path?: string;
      readonly summary?: string;
    }>;
    readonly workspacePath: string;
    readonly entryDir: string;
  }): Promise<ReadonlyArray<FactoryInfrastructureKnowledgeArtifact>> {
    const artifactsDir = path.join(input.entryDir, "artifacts");
    const materialized: FactoryInfrastructureKnowledgeArtifact[] = [];
    for (const [index, item] of input.artifacts.entries()) {
      if (materialized.length >= INFRASTRUCTURE_KNOWLEDGE_MAX_ARTIFACTS_PER_ENTRY) break;
      const originalPath = this.resolveInfrastructureKnowledgePath(item.path, input.workspacePath);
      const baseName = safeWorkspacePart(path.basename(originalPath ?? item.label ?? `artifact_${index + 1}`));
      const storedPath = originalPath && INFRASTRUCTURE_KNOWLEDGE_COPYABLE_RE.test(originalPath)
        ? await this.copyInfrastructureKnowledgeFile(originalPath, artifactsDir, `${String(index + 1).padStart(2, "0")}_${baseName}`)
        : undefined;
      materialized.push({
        label: item.label,
        summary: item.summary,
        originalPath,
        storedPath,
      });
    }
    return materialized;
  }

  private async readInfrastructureKnowledgeIndex(): Promise<ReadonlyArray<FactoryInfrastructureKnowledgeIndexEntry>> {
    try {
      const raw = await fs.readFile(this.repoInfrastructureKnowledgeIndexPath(), "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          entryId: requireNonEmpty(item.entryId, "entryId required"),
          knowledgePath: requireNonEmpty(item.knowledgePath, "knowledgePath required"),
          provider: requireNonEmpty(item.provider, "provider required") as FactoryCloudProvider,
          profileId: requireNonEmpty(item.profileId, "profileId required"),
          accountId: optionalTrimmedString(item.accountId),
          promptFingerprint: requireNonEmpty(item.promptFingerprint, "promptFingerprint required"),
          keywords: Array.isArray(item.keywords) ? item.keywords.filter((keyword): keyword is string => typeof keyword === "string" && keyword.trim().length > 0) : [],
          objectiveId: requireNonEmpty(item.objectiveId, "objectiveId required"),
          taskId: requireNonEmpty(item.taskId, "taskId required"),
          summary: requireNonEmpty(item.summary, "summary required"),
          updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
          scriptPaths: Array.isArray(item.scriptPaths) ? item.scriptPaths.filter((target): target is string => typeof target === "string" && target.trim().length > 0) : [],
          artifactPaths: Array.isArray(item.artifactPaths) ? item.artifactPaths.filter((target): target is string => typeof target === "string" && target.trim().length > 0) : [],
        }));
    } catch {
      return [];
    }
  }

  private scoreInfrastructureKnowledgeMatch(
    entry: FactoryInfrastructureKnowledgeIndexEntry,
    query: {
      readonly provider: FactoryCloudProvider;
      readonly profileId: string;
      readonly accountId?: string;
      readonly promptFingerprint: string;
      readonly keywords: ReadonlyArray<string>;
    },
  ): number {
    if (entry.provider !== query.provider) return 0;
    if (entry.profileId !== query.profileId) return 0;
    if (query.accountId && entry.accountId && entry.accountId !== query.accountId) return 0;
    const keywordOverlap = query.keywords.filter((keyword) => entry.keywords.includes(keyword)).length;
    const exactPromptMatch = entry.promptFingerprint === query.promptFingerprint;
    if (!exactPromptMatch && keywordOverlap === 0) return 0;
    return (exactPromptMatch ? 100 : 0)
      + (query.accountId && entry.accountId === query.accountId ? 20 : 0)
      + keywordOverlap * 10;
  }

  private async loadInfrastructureKnowledgeContext(input: {
    readonly profileId: string | undefined;
    readonly profileCloudProvider?: FactoryCloudProvider;
    readonly objectiveTitle?: string;
    readonly objectivePrompt: string;
    readonly taskTitle?: string;
    readonly taskPrompt?: string;
    readonly cloudExecutionContext: FactoryCloudExecutionContext;
  }): Promise<FactoryInfrastructureKnowledgeContext | undefined> {
    if (!cloudProviderDefaultsToAws(input.profileCloudProvider)) return undefined;
    const provider = input.profileCloudProvider ?? input.cloudExecutionContext.preferredProvider ?? "aws";
    const queryText = this.buildInfrastructureKnowledgeQueryText(input);
    const query = {
      provider,
      profileId: input.profileId ?? "infrastructure",
      accountId: provider === "aws" ? input.cloudExecutionContext.aws?.callerIdentity?.accountId : undefined,
      promptFingerprint: infrastructureKnowledgeFingerprint(queryText),
      keywords: infrastructureKnowledgeKeywords(queryText, [provider]),
    };
    const index = await this.readInfrastructureKnowledgeIndex();
    const ranked = (await Promise.all(index.map(async (entry): Promise<FactoryInfrastructureKnowledgeSelection | undefined> => {
      const score = this.scoreInfrastructureKnowledgeMatch(entry, query);
      if (score <= 0) return undefined;
      if (!(await pathExists(entry.knowledgePath))) return undefined;
      const scriptPaths = (await Promise.all(entry.scriptPaths.map(async (target) => (await pathExists(target)) ? target : undefined)))
        .filter((target): target is string => typeof target === "string")
        .slice(0, INFRASTRUCTURE_KNOWLEDGE_MAX_SCRIPTS_PER_ENTRY);
      const artifactPaths = (await Promise.all(entry.artifactPaths.map(async (target) => (await pathExists(target)) ? target : undefined)))
        .filter((target): target is string => typeof target === "string")
        .slice(0, INFRASTRUCTURE_KNOWLEDGE_MAX_ARTIFACTS_PER_ENTRY);
      return {
        entryId: entry.entryId,
        knowledgePath: entry.knowledgePath,
        provider: entry.provider,
        ...(entry.accountId ? { accountId: entry.accountId } : {}),
        objectiveId: entry.objectiveId,
        taskId: entry.taskId,
        summary: entry.summary,
        updatedAt: entry.updatedAt,
        score,
        scriptPaths,
        artifactPaths,
      } satisfies FactoryInfrastructureKnowledgeSelection;
    }))).filter((entry): entry is FactoryInfrastructureKnowledgeSelection => Boolean(entry));
    return {
      roleLabel: "Infrastructure engineer",
      guidance: [
        "These files are curated repo-scoped infrastructure memory, not the full receipt history.",
        "Stored scripts are durable and reusable, but for live cloud/account/runtime questions rerun the best matching script before you finalize.",
      ],
      selectedEntries: ranked
        .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.entryId.localeCompare(b.entryId))
        .slice(0, INFRASTRUCTURE_KNOWLEDGE_MAX_SELECTIONS),
    };
  }

  private infrastructureKnowledgeSharedArtifactRefs(
    context: FactoryInfrastructureKnowledgeContext | undefined,
  ): ReadonlyArray<GraphRef> {
    if (!context?.selectedEntries.length) return [];
    const seen = new Set<string>();
    const refs: GraphRef[] = [];
    const pushRef = (ref: string, label: string): void => {
      if (!ref || seen.has(ref)) return;
      seen.add(ref);
      refs.push(artifactRef(ref, label));
    };
    for (const entry of context.selectedEntries) {
      pushRef(entry.knowledgePath, "reusable infrastructure knowledge");
      for (const scriptPath of entry.scriptPaths) pushRef(scriptPath, "reusable infrastructure script");
      for (const artifactPath of entry.artifactPaths) pushRef(artifactPath, "reusable infrastructure evidence");
    }
    return refs;
  }

  private renderInfrastructureKnowledgePromptSection(
    context: FactoryInfrastructureKnowledgeContext | undefined,
  ): ReadonlyArray<string> {
    if (!context) return [];
    const lines = [
      `## Infrastructure Role`,
      `Act as the ${context.roleLabel.toLowerCase()} for this task.`,
      `Reuse the mounted infrastructure knowledge and stored scripts before inventing a new workflow.`,
      ...context.guidance.map((item) => `- ${item}`),
      `Selected reusable knowledge for this scope:`,
    ];
    if (context.selectedEntries.length === 0) {
      lines.push(`- none yet. If this run produces a useful script or structured output, return it in artifacts so Factory can promote it into reusable infrastructure knowledge.`);
    } else {
      for (const entry of context.selectedEntries) {
        lines.push(
          `- knowledge: ${entry.knowledgePath} | ${entry.summary}${entry.accountId ? ` | account ${entry.accountId}` : ""} | recorded ${new Date(entry.updatedAt).toISOString()}`,
        );
        for (const scriptPath of entry.scriptPaths) lines.push(`- reusable script: ${scriptPath}`);
        for (const artifactPath of entry.artifactPaths) lines.push(`- reusable evidence: ${artifactPath}`);
      }
      lines.push(`For live cloud/account/runtime questions, rerun or adapt the best matching stored script before finalizing. Use cached output as a hint, not as the answer.`);
    }
    lines.push(``);
    return lines;
  }

  private async promoteInfrastructureKnowledge(input: {
    readonly state: FactoryState;
    readonly task: FactoryTaskRecord;
    readonly payload: FactoryTaskJobPayload;
    readonly outcome: string;
    readonly summary: string;
    readonly report: FactoryInvestigationReport;
    readonly workerArtifacts: ReadonlyArray<{
      readonly label: string;
      readonly path?: string;
      readonly summary?: string;
    }>;
  }): Promise<Readonly<Record<string, GraphRef>>> {
    const profile = this.objectiveProfileForState(input.state);
    const profileId = profile.rootProfileId;
    if (!cloudProviderDefaultsToAws(profile.cloudProvider) || input.state.objectiveMode !== "investigation") return {};
    if (input.outcome === "blocked" && input.report.evidence.length === 0 && input.workerArtifacts.length === 0) return {};
    const cloudExecutionContext = await this.loadObjectiveCloudExecutionContext(profile);
    const provider = profile.cloudProvider ?? cloudExecutionContext.preferredProvider ?? "aws";
    const accountId = provider === "aws" ? cloudExecutionContext.aws?.callerIdentity?.accountId : undefined;
    const queryText = this.buildInfrastructureKnowledgeQueryText({
      objectiveTitle: input.state.title,
      objectivePrompt: input.state.prompt,
      taskTitle: input.task.title,
      taskPrompt: this.effectiveTaskPrompt(input.state, input.task),
    });
    const createdAt = Date.now();
    const entryId = createHash("sha1")
      .update([input.payload.objectiveId, input.payload.taskId, input.payload.candidateId, provider, accountId ?? "", String(createdAt)].join(":"))
      .digest("hex")
      .slice(0, 16);
    const entryDir = this.repoInfrastructureKnowledgeEntryDir(entryId);
    await fs.mkdir(entryDir, { recursive: true });
    const scripts = await this.materializeInfrastructureKnowledgeScripts({
      report: input.report,
      workspacePath: input.payload.workspacePath,
      entryDir,
    });
    const artifacts = await this.materializeInfrastructureKnowledgeArtifacts({
      artifacts: input.workerArtifacts,
      workspacePath: input.payload.workspacePath,
      entryDir,
    });
    const entry: FactoryInfrastructureKnowledgeEntry = {
      entryId,
      repoKey: repoKeyForRoot(this.git.repoRoot),
      profileId,
      provider,
      accountId,
      promptFingerprint: infrastructureKnowledgeFingerprint(queryText),
      keywords: infrastructureKnowledgeKeywords(queryText, [provider]),
      objectiveId: input.payload.objectiveId,
      objectiveTitle: input.state.title,
      objectivePrompt: input.state.prompt,
      objectiveMode: input.state.objectiveMode,
      taskId: input.payload.taskId,
      taskTitle: input.task.title,
      taskPrompt: this.effectiveTaskPrompt(input.state, input.task),
      candidateId: input.payload.candidateId,
      summary: input.summary,
      conclusion: clipText(input.report.conclusion, 600),
      scripts,
      artifacts,
      createdAt,
      updatedAt: createdAt,
    };
    const entryPath = this.repoInfrastructureKnowledgeEntryPath(entryId);
    await fs.writeFile(entryPath, JSON.stringify(entry, null, 2), "utf-8");

    const indexPath = this.repoInfrastructureKnowledgeIndexPath();
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    const scriptPaths = [
      ...scripts.map((item) => preferredInfrastructureKnowledgePath(item)).filter((target): target is string => typeof target === "string"),
      ...artifacts
        .filter((item) => {
          const target = preferredInfrastructureKnowledgePath(item);
          return typeof target === "string" && INFRASTRUCTURE_KNOWLEDGE_SCRIPT_RE.test(target);
        })
        .map((item) => preferredInfrastructureKnowledgePath(item))
        .filter((target): target is string => typeof target === "string"),
    ].slice(0, INFRASTRUCTURE_KNOWLEDGE_MAX_SCRIPTS_PER_ENTRY);
    const artifactPaths = artifacts
      .map((item) => preferredInfrastructureKnowledgePath(item))
      .filter((target): target is string => typeof target === "string" && !INFRASTRUCTURE_KNOWLEDGE_SCRIPT_RE.test(target))
      .slice(0, INFRASTRUCTURE_KNOWLEDGE_MAX_ARTIFACTS_PER_ENTRY);
    const indexEntry: FactoryInfrastructureKnowledgeIndexEntry = {
      entryId,
      knowledgePath: entryPath,
      provider,
      profileId,
      accountId,
      promptFingerprint: entry.promptFingerprint,
      keywords: entry.keywords,
      objectiveId: input.payload.objectiveId,
      taskId: input.payload.taskId,
      summary: input.summary,
      updatedAt: createdAt,
      scriptPaths,
      artifactPaths,
    };
    const existingIndex = await this.readInfrastructureKnowledgeIndex();
    const nextIndex = [
      indexEntry,
      ...existingIndex.filter((item) => item.entryId !== entryId),
    ].slice(0, 200);
    await fs.writeFile(indexPath, JSON.stringify(nextIndex, null, 2), "utf-8");
    return {
      infrastructureKnowledge: fileRef(entryPath, "reusable infrastructure knowledge"),
    };
  }

  private async resolveObjectiveProfileSnapshot(profileId?: string): Promise<FactoryObjectiveProfileSnapshot> {
    const resolved = await resolveFactoryChatProfile({
      repoRoot: this.git.repoRoot,
      profileRoot: this.profileRoot,
      requestedId: profileId,
    });
    const objectivePolicy = resolved.objectivePolicy;
    const allowedWorkerTypes = objectivePolicy.allowedWorkerTypes.map((workerType) => normalizeWorkerType(workerType));
    const defaultWorkerType = allowedWorkerTypes.includes(normalizeWorkerType(objectivePolicy.defaultWorkerType))
      ? normalizeWorkerType(objectivePolicy.defaultWorkerType)
      : allowedWorkerTypes[0] ?? normalizeWorkerType(String(DEFAULT_FACTORY_OBJECTIVE_PROFILE.objectivePolicy.defaultWorkerType));
    return {
      rootProfileId: resolved.root.id,
      rootProfileLabel: resolved.root.label,
      resolvedProfileHash: resolved.resolvedHash,
      promptHash: resolved.promptHash,
      promptPath: resolved.promptPath,
      selectedSkills: resolved.skills,
      cloudProvider: resolved.cloudProvider,
      objectivePolicy: {
        allowedWorkerTypes,
        defaultWorkerType,
        defaultTaskExecutionMode: objectivePolicy.defaultTaskExecutionMode,
        defaultValidationMode: objectivePolicy.defaultValidationMode,
        defaultObjectiveMode: objectivePolicy.defaultObjectiveMode,
        defaultSeverity: objectivePolicy.defaultSeverity,
        maxParallelChildren: objectivePolicy.maxParallelChildren,
        allowObjectiveCreation: objectivePolicy.allowObjectiveCreation,
      },
    };
  }

  private buildObjectiveTaskPrompt(prompt: string, note?: string): string {
    const normalized = optionalTrimmedString(note);
    if (!normalized) return prompt;
    return [
      prompt,
      "",
      "Operator follow-up for this attempt:",
      normalized,
    ].join("\n");
  }

  private createObjectiveTaskRecord(input: {
    readonly objectiveId: string;
    readonly title: string;
    readonly prompt: string;
    readonly workerType: FactoryWorkerType;
    readonly executionMode: FactoryTaskExecutionMode;
    readonly baseCommit: string;
    readonly createdAt: number;
    readonly taskId?: string;
    readonly sourceTaskId?: string;
    readonly basedOn?: string;
  }): FactoryTaskRecord {
    const taskId = input.taskId ?? taskOrdinalId(0);
    return {
      nodeId: taskId,
      taskId,
      taskKind: "planned",
      title: clipText(input.title, 120) ?? input.title,
      prompt: input.prompt,
      workerType: input.workerType,
      executionMode: input.executionMode,
      ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
      baseCommit: input.baseCommit,
      dependsOn: [],
      status: "pending",
      skillBundlePaths: [],
      contextRefs: [
        stateRef(`${objectiveStream(input.objectiveId)}:objective`, "objective"),
        commitRef(input.baseCommit, "base commit"),
      ],
      artifactRefs: {},
      createdAt: input.createdAt,
      ...(input.basedOn ? { basedOn: input.basedOn } : {}),
    };
  }

  private buildPlanningReceipt(
    state: FactoryState,
    plannedAt = Date.now(),
  ): FactoryPlanningReceiptRecord {
    return buildFactoryPlanningReceipt({
      state,
      profile: this.objectiveProfileForState(state),
      resolveTaskExecutionMode: (task) => this.taskExecutionMode(state, task),
      plannedAt,
    });
  }

  private async recordPlanningReceipt(objectiveId: string): Promise<void> {
    const state = await this.getObjectiveState(objectiveId);
    const plannedAt = Date.now();
    const plan = this.buildPlanningReceipt(state, plannedAt);
    if (state.planning && planningReceiptFingerprint(state.planning) === planningReceiptFingerprint(plan)) return;
    await this.emitObjective(objectiveId, {
      type: "planning.receipt",
      objectiveId,
      plan,
      plannedAt,
    });
  }

  async createObjective(input: FactoryObjectiveInput): Promise<FactoryObjectiveDetail> {
    await this.ensureBootstrap();
    const title = requireNonEmpty(input.title, "title required");
    const prompt = requireNonEmpty(input.prompt, "prompt required");
    const channel = input.channel?.trim() || "results";
    const profile = await this.resolveObjectiveProfileSnapshot(input.profileId);
    const objectiveMode = normalizeObjectiveModeInput(
      input.objectiveMode,
      profile.objectivePolicy.defaultObjectiveMode,
    );
    const severity = normalizeObjectiveSeverityInput(
      input.severity,
      profile.objectivePolicy.defaultSeverity,
    );
    if (!profile.objectivePolicy.allowObjectiveCreation) {
      throw new FactoryServiceError(
        403,
        `profile '${profile.rootProfileId}' is not allowed to create Factory objectives`,
      );
    }
    const checks = input.checks?.length
      ? uniqueChecks(input.checks)
      : profile.objectivePolicy.defaultValidationMode === "none"
        ? []
        : uniqueChecks(undefined);
    const checksSource = input.checks?.length
      ? "explicit"
      : profile.objectivePolicy.defaultValidationMode === "none"
        ? "profile"
        : "default";
    const normalizedPolicy = normalizeFactoryObjectivePolicy(input.policy);
    const policy = objectiveMode === "investigation"
      ? {
          ...normalizedPolicy,
          promotion: {
            ...normalizedPolicy.promotion,
            autoPromote: false,
          },
        }
      : normalizedPolicy;
    const sourceStatus = await this.git.sourceStatus();
    const autoPinnedDirtySource =
      !input.baseHash
      && sourceStatus.dirty
      && profile.objectivePolicy.defaultTaskExecutionMode === "worktree";
    if (autoPinnedDirtySource && !sourceStatus.head) {
      throw new FactoryServiceError(
        409,
        "source repository has uncommitted changes but no committed HEAD to pin. Commit once or provide baseHash explicitly.",
      );
    }
    const sourceWarnings = autoPinnedDirtySource
      ? [
          `Pinned Factory worktrees to committed HEAD ${sourceStatus.head!.slice(0, 8)}. ${sourceStatus.changedFiles.length} uncommitted ${sourceStatus.changedFiles.length === 1 ? "change remains" : "changes remain"} local to the source checkout and ${sourceStatus.changedFiles.length === 1 ? "is" : "are"} not visible to objective worktrees.`,
        ]
      : undefined;
    const objectiveId = input.objectiveId?.trim() || this.makeId("objective");
    const requestedBaseHash = input.baseHash ?? (autoPinnedDirtySource ? sourceStatus.head : undefined);
    const baseHash = await this.git.resolveBaseHash(requestedBaseHash);
    const createdAt = Date.now();
    await this.writeObjectiveProfileArtifacts(objectiveId, profile);
    const initialTask = this.createObjectiveTaskRecord({
      objectiveId,
      title,
      prompt,
      workerType: this.normalizeProfileWorkerType(profile, profile.objectivePolicy.defaultWorkerType),
      executionMode: profile.objectivePolicy.defaultTaskExecutionMode,
      baseCommit: baseHash,
      createdAt: createdAt + 2,
    });
    const hasActiveSlot = await this.hasActiveObjectiveSlot();
    await this.emitObjectiveBatch(objectiveId, [
      {
        type: "objective.created",
        objectiveId,
        title,
        prompt,
        channel,
        baseHash,
        sourceWarnings,
        objectiveMode,
        severity,
        checks,
        checksSource,
        profile,
        policy,
        createdAt,
      },
      hasActiveSlot
        ? {
            type: "objective.slot.queued",
            objectiveId,
            queuedAt: createdAt + 1,
          }
        : {
            type: "objective.slot.admitted",
            objectiveId,
            admittedAt: createdAt + 1,
          },
      {
        type: "task.added",
        objectiveId,
        task: initialTask,
        createdAt: initialTask.createdAt,
      },
    ]);
    await this.recordPlanningReceipt(objectiveId);
    if (input.startImmediately && !hasActiveSlot) {
      await this.processObjectiveStartup(objectiveId, "startup");
    } else {
      await this.enqueueObjectiveControl(objectiveId, "startup");
    }
    return this.getObjective(objectiveId);
  }

  async listObjectives(query?: {
    readonly objectiveIds?: ReadonlyArray<string>;
  }): Promise<ReadonlyArray<FactoryObjectiveCard>> {
    const objectiveIds = (query?.objectiveIds ?? [])
      .map((objectiveId) => objectiveId.trim())
      .filter(Boolean);
    if (objectiveIds.length > 0) {
      const states = await this.listObjectiveStates();
      const queuePositions = this.queuePositionsForStates(states);
      const objectiveIdSet = new Set(objectiveIds);
      const details = await Promise.all(
        states
          .filter((state) => objectiveIdSet.has(state.objectiveId))
          .map((state) => this.buildObjectiveCard(state, queuePositions.get(state.objectiveId))),
      );
      return details.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    const cached = this.objectiveListCache;
    if (cached && cached.version === this.objectiveProjectionVersion) {
      return cached.cards;
    }
    const states = await this.listObjectiveStates();
    const queuePositions = this.queuePositionsForStates(states);
    const details = await Promise.all(
      states.map((state) => this.buildObjectiveCard(state, queuePositions.get(state.objectiveId))),
    );
    const cards = details.sort((a, b) => b.updatedAt - a.updatedAt);
    this.objectiveListCache = {
      version: this.objectiveProjectionVersion,
      cards,
    };
    return cards;
  }

  async getObjectiveState(objectiveId: string): Promise<FactoryState> {
    await this.ensureBootstrap();
    const state = normalizeFactoryState(await this.runtime.state(objectiveStream(objectiveId)));
    if (!state.objectiveId) throw new FactoryServiceError(404, "factory objective not found");
    return state;
  }

  private async getObjectiveStateAtHead(objectiveId: string, headHash?: string): Promise<FactoryState> {
    if (!headHash) return this.getObjectiveState(objectiveId);
    await this.ensureBootstrap();
    const chain = await this.runtime.chain(objectiveStream(objectiveId));
    let state = initialFactoryState;
    for (const receipt of chain) {
      state = reduceFactory(state, receipt.body, receipt.ts);
      if (receipt.hash === headHash) {
        if (!state.objectiveId) throw new FactoryServiceError(404, "factory objective not found");
        return normalizeFactoryState(state);
      }
    }
    return this.getObjectiveState(objectiveId);
  }

  async getObjective(objectiveId: string): Promise<FactoryObjectiveDetail> {
    const state = await this.getObjectiveState(objectiveId);
    const states = await this.listObjectiveStates();
    const queuePositions = this.queuePositionsForStates(states);
    return this.buildObjectiveDetail(state, queuePositions.get(objectiveId));
  }

  async inferObjectiveLiveOutputFocus(objectiveId: string): Promise<{
    readonly focusKind: FactoryLiveOutputTargetKind;
    readonly focusId: string;
    readonly inferredBy: "single_active_task" | "single_nonterminal_task" | "single_task";
  } | undefined> {
    const detail = await this.getObjective(objectiveId);
    return inferObjectiveLiveOutputFocusFromDetail(detail);
  }

  async getObjectiveDebug(objectiveId: string): Promise<FactoryDebugProjection> {
    const state = await this.getObjectiveState(objectiveId);
    const states = await this.listObjectiveStates();
    const queuePositions = this.queuePositionsForStates(states);
    return this.buildObjectiveDebug(state, queuePositions.get(objectiveId));
  }

  async listObjectiveReceipts(
    objectiveId: string,
    limitOrQuery: number | FactoryObjectiveReceiptQuery = 40,
  ): Promise<ReadonlyArray<FactoryObjectiveReceiptSummary>> {
    await this.getObjectiveState(objectiveId);
    const chain = await this.runtime.chain(objectiveStream(objectiveId));
    const query = typeof limitOrQuery === "number" ? { limit: limitOrQuery } : limitOrQuery;
    const limit = Math.max(1, Math.min(query.limit ?? 40, 200));
    const typeFilter = new Set((query.types ?? []).map((type) => type.trim()).filter(Boolean));
    return this.summarizedReceipts(chain, 200)
      .filter((receipt) => !query.taskId || receipt.taskId === query.taskId)
      .filter((receipt) => !query.candidateId || receipt.candidateId === query.candidateId)
      .filter((receipt) => typeFilter.size === 0 || typeFilter.has(receipt.type))
      .slice(-limit);
  }

  async buildBoardProjection(selectedObjectiveId?: string): Promise<FactoryBoardProjection> {
    const objectives = (await this.listObjectives())
      .filter((objective) => !objective.archivedAt)
      .map((objective) => ({
        ...objective,
        section: boardSectionForObjective(objective),
      }));
    const resolvedSelectedObjectiveId = this.resolveSelectedObjectiveId(objectives, selectedObjectiveId);
    return {
      objectives,
      sections: {
        needs_attention: objectives.filter((objective) => objective.section === "needs_attention"),
        active: objectives.filter((objective) => objective.section === "active"),
        queued: objectives.filter((objective) => objective.section === "queued"),
        completed: objectives.filter((objective) => objective.section === "completed"),
      },
      selectedObjectiveId: resolvedSelectedObjectiveId,
    };
  }

  async buildComposeModel(): Promise<FactoryComposeModel> {
    const [sourceStatus, defaultBranch, objectives] = await Promise.all([
      this.git.sourceStatus(),
      this.git.defaultBranch(),
      this.listObjectives(),
    ]);
    return {
      defaultBranch,
      sourceDirty: sourceStatus.dirty,
      sourceBranch: sourceStatus.branch,
      objectiveCount: objectives.filter((objective) => !objective.archivedAt).length,
      defaultPolicy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
      profileSummary: FACTORY_PROFILE_SUMMARY,
      defaultValidationCommands: [...DEFAULT_CHECKS],
    };
  }

  async buildLiveProjection(selectedObjectiveId?: string): Promise<FactoryLiveProjection> {
    const board = await this.buildBoardProjection(selectedObjectiveId);
    const objectiveId = board.selectedObjectiveId;
    if (!objectiveId) {
      return {
        activeTasks: [],
        recentJobs: [],
      };
    }
    const detail = await this.getObjective(objectiveId);
    const activeTasks = detail.tasks.filter((task) => isActiveJobStatus(task.jobStatus));
    const recentJobs = this.objectiveJobsForTasks(detail.tasks).slice(0, 8);
    return {
      selectedObjectiveId: objectiveId,
      objectiveTitle: detail.title,
      objectiveStatus: detail.status,
      phase: detail.phase,
      activeTasks,
      recentJobs,
    };
  }

  async getObjectiveLiveOutput(
    objectiveId: string,
    focusKind: FactoryLiveOutputTargetKind,
    focusId: string,
  ): Promise<FactoryLiveOutputSnapshot> {
    await this.getObjectiveState(objectiveId);
    if (focusKind === "task") {
      const detail = await this.getObjective(objectiveId);
      const task = detail.tasks.find((item) => item.taskId === focusId);
      if (!task) throw new FactoryServiceError(404, "factory task not found");
      return {
        objectiveId,
        focusKind,
        focusId,
        title: task.title,
        status: task.jobStatus ?? task.status,
        active: isActiveJobStatus(task.jobStatus),
        summary: task.latestSummary ?? task.candidate?.summary ?? task.artifactSummary,
        taskId: task.taskId,
        candidateId: task.candidateId,
        jobId: task.jobId,
        lastMessage: task.lastMessage,
        stdoutTail: task.stdoutTail,
        stderrTail: task.stderrTail,
        artifactSummary: task.artifactSummary,
        artifactActivity: task.artifactActivity && task.artifactActivity.length > 0 ? task.artifactActivity : undefined,
      };
    }

    const job = await this.queue.getJob(focusId);
    if (!job) throw new FactoryServiceError(404, "job not found");
    const payload = job.payload as Record<string, unknown>;
    if (optionalTrimmedString(payload.objectiveId) !== objectiveId) {
      throw new FactoryServiceError(404, "job does not belong to objective");
    }

    const result = isRecord(job.result) ? job.result : undefined;
    const payloadKind = optionalTrimmedString(payload.kind);
    const summary = optionalTrimmedString(result?.summary)
      ?? optionalTrimmedString(result?.message)
      ?? job.lastError
      ?? optionalTrimmedString(payload.problem)
      ?? optionalTrimmedString(payload.task)
      ?? payloadKind
      ?? `${job.agentId} job`;
    let title = `${job.agentId} job`;
    let taskId = optionalTrimmedString(payload.taskId);
    let candidateId = optionalTrimmedString(payload.candidateId);
    let lastMessage: string | undefined;
    let stdoutTail: string | undefined;
    let stderrTail: string | undefined;
    let artifactSummary: string | undefined;
    let artifactActivity: ReadonlyArray<FactoryArtifactActivity> | undefined;

    if (payloadKind === "factory.task.run") {
      title = taskId ? `Task ${taskId}` : "Task run";
      lastMessage = await this.readTextTail(optionalTrimmedString(payload.lastMessagePath), 400);
      stdoutTail = await this.readTextTail(optionalTrimmedString(payload.stdoutPath), 900);
      stderrTail = await this.readTextTail(optionalTrimmedString(payload.stderrPath), 600);
      const workspacePath = optionalTrimmedString(payload.workspacePath);
      if (workspacePath && taskId) {
        artifactActivity = await this.taskArtifactActivity(workspacePath, taskId);
        artifactSummary = this.summarizeTaskArtifactActivity(artifactActivity);
      }
    } else if (payloadKind === "factory.integration.validate") {
      title = candidateId ? `Integration ${candidateId}` : "Integration validation";
      stdoutTail = await this.readTextTail(optionalTrimmedString(payload.stdoutPath), 900);
      stderrTail = await this.readTextTail(optionalTrimmedString(payload.stderrPath), 600);
    }

    return {
      objectiveId,
      focusKind,
      focusId,
      title,
      status: job.status,
      active: isActiveJobStatus(job.status),
      summary: artifactSummary ?? summary,
      taskId,
      candidateId,
      jobId: job.id,
      lastMessage,
      stdoutTail,
      stderrTail,
      artifactSummary,
      artifactActivity: artifactActivity && artifactActivity.length > 0 ? artifactActivity : undefined,
    };
  }

  async composeObjective(input: FactoryObjectiveComposeInput): Promise<FactoryObjectiveDetail> {
    const prompt = requireNonEmpty(input.prompt, "prompt required");
    const objectiveId = optionalTrimmedString(input.objectiveId);
    if (objectiveId) {
      return this.reactObjectiveWithNote(objectiveId, prompt);
    }
    return this.createObjective({
      title: optionalTrimmedString(input.title) ?? clipText(prompt, 96) ?? "Factory objective",
      prompt,
      baseHash: input.baseHash,
      objectiveMode: input.objectiveMode,
      severity: input.severity,
      checks: input.checks,
      channel: input.channel,
      policy: input.policy,
      profileId: input.profileId,
      startImmediately: input.startImmediately,
    });
  }

  async addObjectiveNote(objectiveId: string, message: string): Promise<void> {
    await this.getObjectiveState(objectiveId);
    const normalized = message.trim();
    if (!normalized) return;
    await this.emitObjective(objectiveId, {
      type: "objective.operator.noted",
      objectiveId,
      message: normalized,
      notedAt: Date.now(),
    });
  }

  async reactObjectiveWithNote(objectiveId: string, message?: string): Promise<FactoryObjectiveDetail> {
    const normalized = optionalTrimmedString(message);
    if (normalized) await this.addObjectiveNote(objectiveId, normalized);
    await this.reactObjective(objectiveId);
    return this.getObjective(objectiveId);
  }

  async promoteObjective(objectiveId: string): Promise<FactoryObjectiveDetail> {
    const state = await this.getObjectiveState(objectiveId);
    const gateBlockedReason = factoryPromotionGateBlockedReason(state);
    if (gateBlockedReason) {
      throw new FactoryServiceError(409, gateBlockedReason);
    }
    if (state.integration.status !== "ready_to_promote" || !state.integration.activeCandidateId) {
      throw new FactoryServiceError(409, "objective is not ready to promote");
    }
    await this.promoteIntegration(state, state.integration.activeCandidateId);
    return this.getObjective(objectiveId);
  }

  async cancelObjective(objectiveId: string, reason?: string): Promise<FactoryObjectiveDetail> {
    const state = await this.getObjectiveState(objectiveId);
    await this.cancelObjectiveTaskJobs(state, reason ?? "factory objective canceled");
    await this.emitObjective(objectiveId, {
      type: "objective.canceled",
      objectiveId,
      canceledAt: Date.now(),
      reason,
    });
    await this.rebalanceObjectiveSlots();
    return this.getObjective(objectiveId);
  }

  async archiveObjective(objectiveId: string): Promise<FactoryObjectiveDetail> {
    const state = await this.getObjectiveState(objectiveId);
    await this.cancelObjectiveTaskJobs(state, "factory objective archived");
    if (!state.archivedAt) {
      await this.emitObjective(objectiveId, {
        type: "objective.archived",
        objectiveId,
        archivedAt: Date.now(),
      });
    }
    await this.rebalanceObjectiveSlots();
    return this.getObjective(objectiveId);
  }

  async cleanupObjectiveWorkspaces(objectiveId: string): Promise<FactoryObjectiveDetail> {
    const state = await this.getObjectiveState(objectiveId);
    const workspacePaths = new Set<string>();
    for (const taskId of state.workflow.taskIds) {
      const task = state.workflow.tasksById[taskId];
      if (task?.workspacePath) workspacePaths.add(task.workspacePath);
    }
    const diskEntries = await readdirIfPresent(this.git.worktreesDir, { withFileTypes: true });
    for (const entry of diskEntries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(`${objectiveId}_`) && !entry.name.startsWith(`factory_integration_${objectiveId}`)) continue;
      workspacePaths.add(path.join(this.git.worktreesDir, entry.name));
    }
    const runtimeEntries = await readdirIfPresent(this.taskRuntimesRoot(), { withFileTypes: true });
    for (const entry of runtimeEntries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(`${objectiveId}_`)) continue;
      workspacePaths.add(path.join(this.taskRuntimesRoot(), entry.name));
    }
    if (state.integration.branchRef?.kind === "workspace") {
      workspacePaths.add(state.integration.branchRef.ref);
    }
    await Promise.all(
      [...workspacePaths].map(async (workspacePath) => {
        await this.removeTaskRuntimeWorkspace(workspacePath);
      }),
    );
    return this.getObjective(objectiveId);
  }

  async queueJobAbort(
    jobId: string,
    reason?: string,
    by = "factory.cli",
  ): Promise<FactoryQueuedJobCommand> {
    return this.queueJobCommand(jobId, {
      command: "abort",
      payload: { reason: optionalTrimmedString(reason) ?? "abort requested" },
      by,
    });
  }

  async resumeObjectives(): Promise<void> {
    await this.queue.refresh();
    await this.reconcileQueuedObjectiveControlJobs();
    await this.rebalanceObjectiveSlots();
    const objectives = await this.listObjectives();
    for (const objective of objectives.filter((item) =>
      !item.archivedAt
      && !["completed", "failed", "canceled"].includes(item.status)
      && item.scheduler.slotState === "active"
    )) {
      try {
        await this.reactObjective(objective.objectiveId);
      } catch {
        await this.enqueueObjectiveControl(objective.objectiveId, "admitted");
      }
    }
  }

  private isObjectiveControlJob(job: QueueJob): job is QueueJob & {
    readonly payload: FactoryObjectiveControlJobPayload;
  } {
    return job.agentId === FACTORY_CONTROL_AGENT_ID
      && job.payload.kind === "factory.objective.control"
      && typeof job.payload.objectiveId === "string"
      && job.payload.objectiveId.trim().length > 0;
  }

  private compareRecentQueueJobs(left: QueueJob, right: QueueJob): number {
    return right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
      || right.id.localeCompare(left.id);
  }

  private controlJobCancelReason(state: FactoryState | undefined): string | undefined {
    if (!state) return "objective control job canceled because the objective no longer exists";
    if (state.archivedAt) return "objective control job canceled because the objective is archived";
    if (state.status === "blocked") return "objective control job canceled because the objective is blocked";
    if (this.isTerminalObjectiveStatus(state.status)) {
      return `objective control job canceled because the objective is ${state.status}`;
    }
    return undefined;
  }

  private shouldRedriveQueuedControlJob(job: QueueJob, now: number): boolean {
    if (job.commands.length > 0) return true;
    const ageMs = Math.max(now - job.updatedAt, now - job.createdAt);
    return ageMs >= OBJECTIVE_CONTROL_REDRIVE_AGE_MS;
  }

  private async reconcileQueuedObjectiveControlJobs(): Promise<void> {
    const queued = (await this.queue.listJobs({ status: "queued", limit: 500 }))
      .filter((job) => this.isObjectiveControlJob(job));
    if (queued.length === 0) return;

    const states = await this.listObjectiveStates();
    const statesById = new Map(states.map((state) => [state.objectiveId, state] as const));
    const grouped = new Map<string, QueueJob[]>();
    for (const job of queued) {
      const key = job.sessionKey?.trim() || `factory:objective:${job.payload.objectiveId}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(job);
      grouped.set(key, bucket);
    }

    const now = Date.now();
    for (const jobs of grouped.values()) {
      const ranked = [...jobs].sort((left, right) => this.compareRecentQueueJobs(left, right));
      const current = ranked[0];
      if (!current) continue;

      for (const duplicate of ranked.slice(1)) {
        await this.queue.cancel(duplicate.id, "superseded duplicate objective control job", "factory.resume");
      }

      const state = statesById.get(current.payload.objectiveId);
      const cancelReason = this.controlJobCancelReason(state);
      if (cancelReason) {
        await this.queue.cancel(current.id, cancelReason, "factory.resume");
        continue;
      }

      if (this.redriveQueuedJob && this.shouldRedriveQueuedControlJob(current, now)) {
        await this.redriveQueuedJob(current);
      }
    }
  }

  private async queueJobCommand(
    jobId: string,
    input: {
      readonly command: "abort";
      readonly payload?: Record<string, unknown>;
      readonly by?: string;
    },
  ): Promise<FactoryQueuedJobCommand> {
    const existing = await this.queue.getJob(jobId);
    if (!existing) throw new FactoryServiceError(404, "job not found");
    const command = await this.queue.queueCommand({
      jobId,
      command: input.command,
      payload: input.payload,
      by: input.by,
    });
    if (!command) throw new FactoryServiceError(404, "job not found");
    this.sse.publish("jobs", jobId);
    return {
      job: await this.queue.getJob(jobId) ?? existing,
      command,
    };
  }

  private objectiveElapsedMinutes(state: FactoryState, now = Date.now()): number {
    if (!state.createdAt) return 0;
    return Math.max(0, Math.floor((now - state.createdAt) / 60_000));
  }

  private isTerminalObjectiveStatus(status: FactoryObjectiveStatus): boolean {
    return status === "completed" || status === "failed" || status === "canceled";
  }

  private releasesObjectiveSlot(state: Pick<FactoryState, "status" | "integration">): boolean {
    const { status } = state;
    if (this.isTerminalObjectiveStatus(status) || status === "blocked" || status === "promoting") return true;
    const is = state.integration?.status;
    return is === "ready_to_promote" || is === "promoting" || is === "promoted";
  }

  private async cancelObjectiveTaskJobs(
    state: FactoryState,
    reason: string,
  ): Promise<void> {
    for (const taskId of state.workflow.taskIds) {
      const task = state.workflow.tasksById[taskId];
      if (!task?.jobId) continue;
      await this.queue.cancel(task.jobId, reason, "factory");
    }
  }

  private async listObjectiveStates(): Promise<ReadonlyArray<FactoryState>> {
    const cached = this.objectiveStateListCache;
    if (cached && cached.version === this.objectiveProjectionVersion) {
      return cached.states;
    }
    await this.ensureBootstrap();
    const streams = await this.discoverObjectiveStreams();
    const states = await Promise.all(
      streams.map(async (stream) => normalizeFactoryState(await this.runtime.state(stream))),
    );
    const resolvedStates = states
      .filter((state) => Boolean(state.objectiveId))
      .sort((a, b) => a.createdAt - b.createdAt || a.objectiveId.localeCompare(b.objectiveId));
    this.objectiveStateListCache = {
      version: this.objectiveProjectionVersion,
      states: resolvedStates,
    };
    return resolvedStates;
  }

  private queuePositionsForStates(states: ReadonlyArray<FactoryState>): ReadonlyMap<string, number> {
    const queued = states
      .filter((state) =>
        Boolean(state.objectiveId)
        && !state.archivedAt
        && !this.isTerminalObjectiveStatus(state.status)
        && state.scheduler.slotState === "queued",
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.objectiveId.localeCompare(b.objectiveId));
    return new Map(queued.map((state, index) => [state.objectiveId, index + 1] as const));
  }

  private deriveObjectivePhase(
    state: FactoryState,
    projection?: { readonly activeTasks: number; readonly readyTasks: number },
  ): FactoryObjectivePhase {
    if (state.status === "completed") return "completed";
    if (state.status === "blocked" || state.status === "failed" || state.status === "canceled") return "blocked";
    if (state.scheduler.slotState === "queued") return "waiting_for_slot";
    if (state.status === "planning") return "planning";
    if (state.status === "integrating") return "integrating";
    if (state.status === "promoting" || state.integration.status === "ready_to_promote" || state.integration.status === "promoting" || state.integration.status === "promoted") {
      return "promoting";
    }
    if (state.status === "executing" && projection && projection.activeTasks === 0 && projection.readyTasks === 0) {
      return "blocked";
    }
    return "executing";
  }

  private deriveLatestDecision(state: FactoryState): FactoryObjectiveCard["latestDecision"] | undefined {
    if (state.latestRebracket) {
      return {
        summary: state.latestRebracket.reason,
        at: state.latestRebracket.appliedAt,
        source: state.latestRebracket.source,
        selectedActionId: state.latestRebracket.selectedActionId,
      };
    }
    if (state.integration.status === "ready_to_promote" && state.integration.lastSummary) {
      return {
        summary: state.integration.lastSummary,
        at: state.integration.updatedAt,
        source: "system",
      };
    }
    return undefined;
  }

  private deriveNextAction(state: FactoryState, queuePosition?: number): string | undefined {
    if (state.status === "completed") return state.objectiveMode === "investigation" ? "Investigation is complete." : "Objective is complete.";
    if (state.status === "canceled") return "Objective was canceled.";
    if (state.status === "failed") return "Objective failed.";
    if (state.status === "blocked") {
      return state.objectiveMode === "investigation"
        ? "Review the blocking receipt, adjust the investigation, or cancel the objective."
        : "Review the blocking receipt and react or cancel the objective.";
    }
    if (state.scheduler.slotState === "queued") {
      return queuePosition
        ? `Waiting for the repo execution slot (${queuePosition} in queue).`
        : "Waiting for the repo execution slot.";
    }
    if (state.status === "planning") {
      return state.workflow.taskIds.length === 0
        ? "Preparing the objective."
        : "Preparing the next task attempt.";
    }
    if (state.integration.status === "ready_to_promote" && !state.policy.promotion.autoPromote) {
      return "Promote the integration branch into source when ready.";
    }
    if (state.integration.status === "conflicted") return "Review the integration conflict and react with the next task attempt.";
    const readyCount = factoryReadyTasks(state).length;
    if (readyCount > 0) {
      return readyCount === 1
        ? "One task is ready to dispatch."
        : `${readyCount} tasks are ready to dispatch.`;
    }
    if (state.workflow.activeTaskIds.length > 0) return "Wait for the active task pass to finish.";
    if (state.integration.status === "queued" || state.integration.status === "merging" || state.integration.status === "validating") {
      return "Wait for integration validation to finish.";
    }
    return undefined;
  }

  private buildBudgetState(
    state: FactoryState,
    now = Date.now(),
    policyBlockedReason?: string,
  ): FactoryBudgetState {
    const failureEntries = Object.entries(state.consecutiveFailuresByTask).filter(([, v]) => v > 0);
    return {
      taskRunsUsed: state.taskRunsUsed,
      candidatePassesByTask: state.candidatePassesByTask,
      consecutiveFailuresByTask: failureEntries.length > 0
        ? Object.fromEntries(failureEntries)
        : {},
      elapsedMinutes: this.objectiveElapsedMinutes(state, now),
      lastDispatchAt: state.lastDispatchAt,
      policyBlockedReason: policyBlockedReason ?? this.derivePolicyBlockedReason(state, now),
    };
  }

  private derivePolicyBlockedReason(state: FactoryState, now = Date.now()): string | undefined {
    const elapsedMinutes = this.objectiveElapsedMinutes(state, now);
    if (elapsedMinutes > state.policy.budgets.maxObjectiveMinutes) {
      return `Policy blocked: objective exceeded maxObjectiveMinutes (${elapsedMinutes}/${state.policy.budgets.maxObjectiveMinutes}).`;
    }
    if (state.taskRunsUsed >= state.policy.budgets.maxTaskRuns) {
      return `Policy blocked: objective exhausted maxTaskRuns (${state.taskRunsUsed}/${state.policy.budgets.maxTaskRuns}).`;
    }
    if (state.blockedReason?.startsWith("Policy blocked:")) return state.blockedReason;
    return undefined;
  }

  private taskReworkPolicyBlockedReason(state: FactoryState, task: FactoryTaskRecord): string | undefined {
    const latest = this.latestTaskCandidate(state, task.taskId);
    if (!latest || !["changes_requested", "rejected", "conflicted"].includes(latest.status)) return undefined;
    const passes = state.candidatePassesByTask[task.taskId] ?? 0;
    if (passes < state.policy.budgets.maxCandidatePassesPerTask) return undefined;
    return `Policy blocked: ${task.taskId} exhausted maxCandidatePassesPerTask (${passes}/${state.policy.budgets.maxCandidatePassesPerTask}).`;
  }

  private taskCircuitBreakerReason(state: FactoryState, taskId: string): string | undefined {
    const failures = state.consecutiveFailuresByTask[taskId] ?? 0;
    if (failures < MAX_CONSECUTIVE_TASK_FAILURES) return undefined;
    return `Policy blocked: ${taskId} circuit-broken after ${failures} consecutive dispatch failures.`;
  }

  private blockedTasksByRecency(state: FactoryState): ReadonlyArray<FactoryTaskRecord> {
    const timestamp = (task: FactoryTaskRecord): number =>
      task.completedAt ?? task.reviewingAt ?? task.startedAt ?? task.readyAt ?? task.createdAt;
    return state.workflow.taskIds
      .map((taskId) => state.workflow.tasksById[taskId])
      .filter((task): task is FactoryTaskRecord => Boolean(task) && task.status === "blocked")
      .sort((left, right) => timestamp(right) - timestamp(left) || right.taskId.localeCompare(left.taskId));
  }

  private blockedTaskReason(state: FactoryState, task: FactoryTaskRecord): string {
    return trimmedString(
      task.blockedReason
      ?? this.latestTaskCandidate(state, task.taskId)?.latestReason
      ?? task.latestSummary
      ?? "Task is blocked."
    ) ?? "Task is blocked.";
  }

  private canAutonomouslyRetryBlockedTask(state: FactoryState, task: FactoryTaskRecord): boolean {
    const reason = this.blockedTaskReason(state, task);
    if (!reason || NON_RETRYABLE_BLOCK_REASON_RE.test(reason) || HUMAN_INPUT_BLOCK_REASON_RE.test(reason)) return false;
    if (!RETRYABLE_BLOCK_REASON_RE.test(reason)) return false;
    if ((state.candidatePassesByTask[task.taskId] ?? 0) > AUTONOMOUS_RETRY_MAX_CANDIDATE_PASSES) return false;
    if (this.taskReworkPolicyBlockedReason(state, task)) return false;
    if (this.taskCircuitBreakerReason(state, task.taskId)) return false;
    return true;
  }

  private humanDecisionReasonForBlockedTask(state: FactoryState, task: FactoryTaskRecord): string {
    const reason = this.blockedTaskReason(state, task);
    if (HUMAN_INPUT_BLOCK_REASON_RE.test(reason)) {
      return `Human input requested for ${task.taskId}: ${reason}`;
    }
    return `Human input requested for ${task.taskId} after autonomous recovery stopped: ${reason}`;
  }

  private async maybeAutonomousNextStepForBlockedObjective(
    objectiveId: string,
    state: FactoryState,
  ): Promise<"retried" | "asked_human" | "none"> {
    const blockedTasks = this.blockedTasksByRecency(state)
      .filter((task) => !this.blockedTaskReason(state, task).startsWith("Policy blocked:"));
    if (blockedTasks.length === 0) return "none";

    const retryTask = blockedTasks.find((task) => this.canAutonomouslyRetryBlockedTask(state, task));
    if (retryTask) {
      const retryReason = this.blockedTaskReason(state, retryTask);
      const basedOn = await this.currentHeadHash(objectiveId);
      try {
        await this.emitObjectiveBatch(objectiveId, [
          this.runtimeDecisionEvent(
            state,
            `retry_${retryTask.taskId}`,
            `Retry blocked task ${retryTask.taskId} once because the failure looks transient: ${retryReason}`,
            { basedOn, frontierTaskIds: [retryTask.taskId] },
          ),
          {
            type: "task.unblocked",
            objectiveId,
            taskId: retryTask.taskId,
            readyAt: Date.now(),
          },
        ], basedOn);
        return "retried";
      } catch (err) {
        if (err instanceof FactoryStaleObjectiveError) return "none";
        throw err;
      }
    }

    const askTask = blockedTasks[0];
    if (!askTask) return "none";
    const askReason = this.humanDecisionReasonForBlockedTask(state, askTask);
    const basedOn = await this.currentHeadHash(objectiveId);
    try {
      await this.emitObjectiveBatch(objectiveId, [
        this.runtimeDecisionEvent(
          state,
          `ask_human_${askTask.taskId}`,
          askReason,
          { basedOn, frontierTaskIds: [askTask.taskId] },
        ),
        {
          type: "objective.blocked",
          objectiveId,
          reason: askReason,
          summary: askReason,
          blockedAt: Date.now(),
        },
      ], basedOn);
      return "asked_human";
    } catch (err) {
      if (err instanceof FactoryStaleObjectiveError) return "none";
      throw err;
    }
  }

  private async stampCircuitBrokenTasks(state: FactoryState): Promise<void> {
    for (const taskId of state.workflow.taskIds) {
      const task = state.workflow.tasksById[taskId];
      if (!task || task.status !== "blocked") continue;
      if (task.blockedReason?.startsWith("Policy blocked:")) continue;
      const reason = this.taskCircuitBreakerReason(state, taskId);
      if (!reason) continue;
      await this.emitObjective(state.objectiveId, {
        type: "task.blocked",
        objectiveId: state.objectiveId,
        taskId,
        reason,
        blockedAt: Date.now(),
      });
    }
  }

  private runtimeFrontierTaskIds(state: FactoryState): ReadonlyArray<string> {
    const frontier = state.workflow.taskIds.filter((taskId) => {
      const task = state.workflow.tasksById[taskId];
      return Boolean(task) && ["ready", "running", "reviewing", "blocked"].includes(task.status);
    });
    return frontier.length > 0 ? frontier : state.workflow.taskIds;
  }

  private runtimeDecisionEvent(
    state: FactoryState,
    selectedActionId: string,
    reason: string,
    opts: {
      readonly basedOn?: string;
      readonly frontierTaskIds?: ReadonlyArray<string>;
    } = {},
  ): Extract<FactoryEvent, { readonly type: "rebracket.applied" }> {
    return {
      type: "rebracket.applied",
      objectiveId: state.objectiveId,
      frontierTaskIds: opts.frontierTaskIds ?? this.runtimeFrontierTaskIds(state),
      selectedActionId,
      reason,
      confidence: 1,
      source: "runtime",
      basedOn: opts.basedOn,
      appliedAt: Date.now(),
    };
  }

  private nextApprovedIntegrationCandidate(state: FactoryState): FactoryCandidateRecord | undefined {
    for (const taskId of state.workflow.taskIds) {
      const task = state.workflow.tasksById[taskId];
      if (!task || task.status !== "approved") continue;
      const candidate = this.latestTaskCandidate(state, taskId);
      if (!candidate || candidate.status !== "approved") continue;
      if (state.integration.activeCandidateId === candidate.candidateId) continue;
      if (state.integration.queuedCandidateIds.includes(candidate.candidateId)) continue;
      return candidate;
    }
    return undefined;
  }

  private resolveSelectedObjectiveId(
    objectives: ReadonlyArray<{ readonly objectiveId: string }>,
    preferredId?: string,
  ): string | undefined {
    if (preferredId && objectives.some((objective) => objective.objectiveId === preferredId)) return preferredId;
    return objectives[0]?.objectiveId;
  }

  private async hasActiveObjectiveSlot(): Promise<boolean> {
    const states = await this.listObjectiveStates();
    return states.some((state) =>
      !state.archivedAt
      && !this.releasesObjectiveSlot(state)
      && state.scheduler.slotState === "active"
      && !state.scheduler.releasedAt,
    );
  }

  private async enqueueObjectiveControl(
    objectiveId: string,
    reason: FactoryObjectiveControlJobPayload["reason"],
  ): Promise<void> {
    const created = await this.queue.enqueue({
      agentId: FACTORY_CONTROL_AGENT_ID,
      lane: "collect",
      sessionKey: `factory:objective:${objectiveId}`,
      singletonMode: reason === "admitted" ? "cancel" : "steer",
      maxAttempts: 2,
      payload: {
        kind: "factory.objective.control",
        objectiveId,
        reason,
      } satisfies FactoryObjectiveControlJobPayload,
    });
    this.sse.publish("jobs", created.id);
    if (
      this.redriveQueuedJob
      && created.status === "queued"
      && reason === "reconcile"
    ) {
      await this.redriveQueuedJob(created);
    }
  }

  async runObjectiveControl(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (payload.kind !== "factory.objective.control") {
      throw new FactoryServiceError(400, "invalid factory control payload");
    }
    const objectiveId = requireNonEmpty(payload.objectiveId, "objectiveId required");
    const reason = payload.reason === "admitted" || payload.reason === "reconcile"
      ? payload.reason
      : "startup";
    await this.ensureBootstrap();
    if (reason === "reconcile") {
      await this.processObjectiveReconcile(objectiveId);
    } else {
      await this.processObjectiveStartup(objectiveId, reason);
    }
    return {
      objectiveId,
      status: "completed",
      reason,
    };
  }

  private async rebalanceObjectiveSlots(): Promise<void> {
    const states = await this.listObjectiveStates();
    for (const state of states) {
      if (
        state.scheduler.slotState === "active"
        && !state.scheduler.releasedAt
        && (this.releasesObjectiveSlot(state) || Boolean(state.archivedAt))
      ) {
        await this.emitObjective(state.objectiveId, {
          type: "objective.slot.released",
          objectiveId: state.objectiveId,
          releasedAt: Date.now(),
          reason: state.archivedAt
            ? "slot released after objective archived"
            : `slot released after objective entered ${state.status}`,
        });
      }
    }

    const refreshed = await this.listObjectiveStates();
    const active = refreshed.find((state) =>
      !state.archivedAt
      && !this.releasesObjectiveSlot(state)
      && state.scheduler.slotState === "active"
      && !state.scheduler.releasedAt,
    );
    if (active) return;

    const next = refreshed.find((state) =>
      !state.archivedAt
      && !this.releasesObjectiveSlot(state)
      && (state.scheduler.slotState === "queued" || !state.scheduler.slotState || state.scheduler.releasedAt),
    );
    if (!next) return;
    await this.emitObjective(next.objectiveId, {
      type: "objective.slot.admitted",
      objectiveId: next.objectiveId,
      admittedAt: Date.now(),
    });
    await this.enqueueObjectiveControl(next.objectiveId, "admitted");
  }

  private async processObjectiveStartup(
    objectiveId: string,
    _reason: Exclude<FactoryObjectiveControlJobPayload["reason"], "reconcile">,
  ): Promise<void> {
    await processObjectiveStartupControl({
      getObjectiveState: (targetObjectiveId) => this.getObjectiveState(targetObjectiveId),
      isTerminalObjectiveStatus: (status) => this.isTerminalObjectiveStatus(status),
      rebalanceObjectiveSlots: () => this.rebalanceObjectiveSlots(),
      reactObjective: (targetObjectiveId) => this.reactObjective(targetObjectiveId),
    }, objectiveId);
  }

  private async processObjectiveReconcile(objectiveId: string): Promise<void> {
    await processObjectiveReconcileControl({
      getObjectiveState: (targetObjectiveId) => this.getObjectiveState(targetObjectiveId),
      isTerminalObjectiveStatus: (status) => this.isTerminalObjectiveStatus(status),
      rebalanceObjectiveSlots: () => this.rebalanceObjectiveSlots(),
      reactObjective: (targetObjectiveId) => this.reactObjective(targetObjectiveId),
    }, objectiveId);
  }

  private async latestObjectiveOperatorNote(objectiveId: string): Promise<string | undefined> {
    const chain = await this.runtime.chain(objectiveStream(objectiveId));
    for (const receipt of [...chain].reverse()) {
      const body = receipt.body;
      if (body.type === "objective.operator.noted") return body.message;
    }
    return undefined;
  }

  private async queueFollowUpTaskFromLatestNote(state: FactoryState): Promise<boolean> {
    if (state.workflow.activeTaskIds.length > 0) return false;
    const latestNote = await this.latestObjectiveOperatorNote(state.objectiveId);
    if (!latestNote) return false;
    const latestTask = [...state.workflow.taskIds]
      .map((taskId) => state.workflow.tasksById[taskId])
      .filter((task): task is FactoryTaskRecord => Boolean(task))
      .at(-1);
    if (latestTask?.prompt.includes(`Operator follow-up for this attempt:\n${latestNote}`)) return false;
    const now = Date.now();
    const basedOn = await this.currentHeadHash(state.objectiveId);
    const nextTask = this.createObjectiveTaskRecord({
      objectiveId: state.objectiveId,
      title: latestTask?.title ?? state.title,
      prompt: this.buildObjectiveTaskPrompt(state.prompt, latestNote),
      workerType: this.normalizeProfileWorkerType(
        this.objectiveProfileForState(state),
        latestTask?.workerType ?? this.objectiveProfileForState(state).objectivePolicy.defaultWorkerType,
      ),
      executionMode: latestTask?.executionMode ?? this.objectiveProfileForState(state).objectivePolicy.defaultTaskExecutionMode,
      baseCommit: latestTask ? this.resolveTaskBaseCommit(state, latestTask) : (state.integration.headCommit ?? state.baseHash),
      createdAt: now + 1,
      taskId: this.nextTaskId(state),
      sourceTaskId: latestTask?.taskId,
      basedOn,
    });
    const events: FactoryEvent[] = [];
    if (
      latestTask
      && latestTask.status !== "integrated"
      && latestTask.status !== "superseded"
    ) {
      events.push({
        type: "task.superseded",
        objectiveId: state.objectiveId,
        taskId: latestTask.taskId,
        reason: "Superseded by operator follow-up.",
        supersededAt: now,
      });
    }
    events.push({
      type: "task.added",
      objectiveId: state.objectiveId,
      task: nextTask,
      createdAt: nextTask.createdAt,
    });
    await this.emitObjectiveBatch(state.objectiveId, events, basedOn);
    await this.recordPlanningReceipt(state.objectiveId);
    return true;
  }

  private async syncFailedActiveTasks(state: FactoryState): Promise<void> {
    for (const taskId of [...state.workflow.activeTaskIds]) {
      const task = state.workflow.tasksById[taskId];
      if (!task?.jobId) continue;
      const job = await this.loadFreshJob(task.jobId);
      if (!job || !isTerminalJobStatus(job.status)) continue;
      if ((job.status === "failed" || job.status === "canceled") && (task.status === "running" || task.status === "reviewing")) {
        await this.emitObjective(state.objectiveId, {
          type: "task.blocked",
          objectiveId: state.objectiveId,
          taskId,
          reason: job.lastError ?? job.canceledReason ?? "factory task failed",
          blockedAt: Date.now(),
        });
      }
    }
  }

  private async redriveQueuedActiveTasks(state: FactoryState): Promise<void> {
    if (!this.redriveQueuedJob) return;
    for (const taskId of [...state.workflow.activeTaskIds]) {
      const task = state.workflow.tasksById[taskId];
      if (!task?.jobId) continue;
      if (task.status !== "running" && task.status !== "reviewing") continue;
      const job = await this.queue.getJob(task.jobId);
      if (!job || job.status !== "queued") continue;
      await this.redriveQueuedJob(job);
    }
  }

  async reactObjective(objectiveId: string): Promise<void> {
    await this.rebalanceObjectiveSlots();
    const refreshState = () => this.getObjectiveState(objectiveId);
    let state = await refreshState();

    if (this.isTerminalObjectiveStatus(state.status)) {
      await this.rebalanceObjectiveSlots();
      return;
    }
    if (state.scheduler.slotState === "queued") return;

    await this.syncFailedActiveTasks(state);
    await this.redriveQueuedActiveTasks(state);
    state = await refreshState();
    if (this.isTerminalObjectiveStatus(state.status)) {
      await this.rebalanceObjectiveSlots();
      return;
    }

    await this.stampCircuitBrokenTasks(state);
    state = await refreshState();

    const elapsedBlockedReason = this.derivePolicyBlockedReason(state);
    if (elapsedBlockedReason) {
      await this.emitObjective(objectiveId, {
        type: "objective.blocked",
        objectiveId,
        reason: elapsedBlockedReason,
        summary: elapsedBlockedReason,
        blockedAt: Date.now(),
      });
      await this.rebalanceObjectiveSlots();
      return;
    }

    if (state.workflow.taskIds.length === 0) {
      if (state.status === "blocked") {
        await this.rebalanceObjectiveSlots();
        return;
      }
      const createdAt = Date.now();
      const initialTask = this.createObjectiveTaskRecord({
        objectiveId,
        title: state.title,
        prompt: state.prompt,
        workerType: this.normalizeProfileWorkerType(
          this.objectiveProfileForState(state),
          this.objectiveProfileForState(state).objectivePolicy.defaultWorkerType,
        ),
        executionMode: this.objectiveProfileForState(state).objectivePolicy.defaultTaskExecutionMode,
        baseCommit: state.baseHash,
        createdAt,
      });
      await this.emitObjective(objectiveId, {
        type: "task.added",
        objectiveId,
        task: initialTask,
        createdAt,
      });
      await this.recordPlanningReceipt(objectiveId);
      state = await refreshState();
    }

    if (await this.queueFollowUpTaskFromLatestNote(state)) {
      state = await refreshState();
    }

    if (state.status === "blocked") {
      const blockedTasks = state.workflow.taskIds
        .map((taskId) => state.workflow.tasksById[taskId])
        .filter((task): task is FactoryTaskRecord => Boolean(task) && task.status === "blocked");
      if (blockedTasks.length > 0) {
        await this.emitObjectiveBatch(objectiveId, blockedTasks.map((task, index) => ({
          type: "task.unblocked" as const,
          objectiveId,
          taskId: task.taskId,
          readyAt: Date.now() + index,
        })));
        state = await refreshState();
      }
      if (state.status === "blocked") {
        await this.rebalanceObjectiveSlots();
        return;
      }
    }

    const activatable = factoryActivatableTasks(state);
    for (const task of activatable) {
      await this.emitObjective(objectiveId, {
        type: "task.ready",
        objectiveId,
        taskId: task.taskId,
        readyAt: Date.now(),
      });
    }
    if (activatable.length > 0) state = await refreshState();

    for (const task of factoryReadyTasks(state)) {
      const blockedReason = this.taskReworkPolicyBlockedReason(state, task);
      if (blockedReason) {
        await this.emitObjective(objectiveId, {
          type: "task.blocked",
          objectiveId,
          taskId: task.taskId,
          reason: blockedReason,
          blockedAt: Date.now(),
        });
      }
    }
    state = await refreshState();

    const dispatchPolicyBlockedReason = state.taskRunsUsed >= state.policy.budgets.maxTaskRuns
      ? `Policy blocked: objective exhausted maxTaskRuns (${state.taskRunsUsed}/${state.policy.budgets.maxTaskRuns}).`
      : undefined;
    if (dispatchPolicyBlockedReason && state.workflow.activeTaskIds.length === 0 && factoryReadyTasks(state).length > 0) {
      await this.emitObjective(objectiveId, {
        type: "objective.blocked",
        objectiveId,
        reason: dispatchPolicyBlockedReason,
        summary: dispatchPolicyBlockedReason,
        blockedAt: Date.now(),
      });
      await this.rebalanceObjectiveSlots();
      return;
    }

    while (true) {
      state = await refreshState();
      if (this.isTerminalObjectiveStatus(state.status) || state.scheduler.slotState === "queued") break;
      const capacity = Math.max(0, this.effectiveMaxParallelChildren(state) - state.workflow.activeTaskIds.length);
      if (capacity <= 0) break;
      const nextTask = factoryReadyTasks(state)[0];
      if (!nextTask) break;
      const basedOn = await this.currentHeadHash(objectiveId);
      try {
        await this.dispatchTask(state, nextTask, {
          expectedPrev: basedOn,
          prefixEvents: [
            this.runtimeDecisionEvent(
              state,
              `dispatch_${nextTask.taskId}`,
              `Dispatch ready task ${nextTask.taskId}.`,
              { basedOn, frontierTaskIds: [nextTask.taskId] },
            ),
          ],
        });
      } catch (err) {
        if (err instanceof FactoryStaleObjectiveError) break;
        throw err;
      }
    }

    state = await refreshState();
    const finalProjection = buildFactoryProjection(state);

    if (state.objectiveMode === "investigation") {
      const investigationReady = (
        finalProjection.tasks.length > 0
        && finalProjection.readyTasks.length === 0
        && finalProjection.activeTasks.length === 0
        && finalProjection.tasks.every((task) => ["approved", "superseded"].includes(task.status))
        && this.finalInvestigationReports(state).length > 0
      );
      const investigationBlocked = (
        finalProjection.tasks.length > 0
        && finalProjection.readyTasks.length === 0
        && finalProjection.activeTasks.length === 0
        && factoryActivatableTasks(state).length === 0
        && finalProjection.tasks.some((task) => task.status === "blocked")
      );

      if (investigationReady) {
        const synthesis = this.buildInvestigationSynthesis(state);
        if (synthesis) {
          const existing = state.investigation.synthesized;
          const changed = !existing
            || existing.summary !== synthesis.summary
            || existing.taskIds.join(",") !== synthesis.taskIds.join(",")
            || existing.report.conclusion !== synthesis.report.conclusion;
          if (changed) {
            await this.emitObjective(objectiveId, {
              type: "investigation.synthesized",
              objectiveId,
              summary: synthesis.summary,
              report: synthesis.report,
              taskIds: synthesis.taskIds,
              synthesizedAt: synthesis.synthesizedAt,
            });
            state = await refreshState();
            await this.commitInvestigationSynthesisMemory(state, state.investigation.synthesized ?? synthesis);
          }
        }
        if (state.status !== "completed") {
          await this.emitObjective(objectiveId, {
            type: "objective.completed",
            objectiveId,
            summary: state.investigation.synthesized?.summary
              ?? state.latestSummary
              ?? "Investigation objective completed.",
            completedAt: Date.now(),
          });
        }
        await this.rebalanceObjectiveSlots();
        return;
      }

      if (investigationBlocked && state.status !== "blocked") {
        const nextStep = await this.maybeAutonomousNextStepForBlockedObjective(objectiveId, state);
        if (nextStep === "retried") {
          await this.reactObjective(objectiveId);
          return;
        }
        if (nextStep !== "asked_human") {
          await this.emitObjective(objectiveId, {
            type: "objective.blocked",
            objectiveId,
            reason: "No runnable investigation tasks remained.",
            summary: "Investigation objective is blocked with no runnable tasks.",
            blockedAt: Date.now(),
          });
        }
        await this.rebalanceObjectiveSlots();
        return;
      }

      await this.rebalanceObjectiveSlots();
      return;
    }

    const integrationCandidate = (
      finalProjection.activeTasks.length === 0
      && (state.integration.status === "idle" || state.integration.status === "conflicted")
    )
      ? this.nextApprovedIntegrationCandidate(state)
      : undefined;
    if (integrationCandidate) {
      const basedOn = await this.currentHeadHash(objectiveId);
      try {
        await this.queueIntegration(state, integrationCandidate.candidateId, {
          expectedPrev: basedOn,
          prefixEvents: [
            this.runtimeDecisionEvent(
              state,
              `queue_integration_${integrationCandidate.candidateId}`,
              `Queue approved candidate ${integrationCandidate.candidateId} for integration.`,
              { basedOn, frontierTaskIds: [integrationCandidate.taskId] },
            ),
          ],
        });
      } catch (err) {
        if (!(err instanceof FactoryStaleObjectiveError)) throw err;
      }
      state = await refreshState();
    }

    const readyToPromoteBase = (
      state.workflow.taskIds.length > 0
      && state.workflow.taskIds
        .map((taskId) => state.workflow.tasksById[taskId])
        .filter((task): task is FactoryTaskRecord => Boolean(task))
        .every((task) => ["integrated", "superseded"].includes(task.status))
      && state.workflow.taskIds
        .map((taskId) => state.workflow.tasksById[taskId])
        .some((task) => Boolean(task) && task.status === "integrated")
      && state.integration.status === "validated"
    );
    const readyToPromoteBlockedReason = readyToPromoteBase
      ? factoryPromotionGateBlockedReason(state)
      : undefined;

    if (readyToPromoteBlockedReason) {
      await this.emitObjective(objectiveId, {
        type: "objective.blocked",
        objectiveId,
        reason: readyToPromoteBlockedReason,
        summary: readyToPromoteBlockedReason,
        blockedAt: Date.now(),
      });
      await this.rebalanceObjectiveSlots();
      return;
    }

    if (readyToPromoteBase && state.integration.activeCandidateId) {
      await this.emitObjective(objectiveId, {
        type: "integration.ready_to_promote",
        objectiveId,
        candidateId: state.integration.activeCandidateId,
        headCommit: state.integration.headCommit ?? state.baseHash,
        summary: state.integration.lastSummary ?? `All tasks integrated and validated. Ready to promote.`,
        readyAt: Date.now(),
      });
      state = await refreshState();

      if (state.policy.promotion.autoPromote && state.integration.activeCandidateId) {
        try {
          const basedOn = await this.currentHeadHash(objectiveId);
          await this.promoteIntegration(state, state.integration.activeCandidateId, {
            expectedPrev: basedOn,
            prefixEvents: [
              this.runtimeDecisionEvent(
                state,
                `promote_integration_${state.integration.activeCandidateId}`,
                `Promote integrated candidate ${state.integration.activeCandidateId}.`,
                { basedOn },
              ),
            ],
          });
        } catch (err) {
          if (!(err instanceof FactoryStaleObjectiveError)) throw err;
        }
        state = await refreshState();
      }
    }

    const completionReady = (
      finalProjection.tasks.length > 0
      && finalProjection.tasks.every((task) => ["integrated", "superseded"].includes(task.status))
      && state.integration.status === "promoted"
      && state.status !== "completed"
    );
    const emptyBlockedReady = (
      finalProjection.tasks.length > 0
      && finalProjection.readyTasks.length === 0
      && finalProjection.activeTasks.length === 0
      && (state.integration.status === "idle" || state.integration.status === "promoted")
      && finalProjection.tasks.every((task) => ["blocked", "superseded", "integrated"].includes(task.status))
      && !finalProjection.tasks.every((task) => ["integrated", "superseded"].includes(task.status))
      && state.status !== "blocked"
    );

    if (completionReady) {
      await this.emitObjective(objectiveId, {
        type: "objective.completed",
        objectiveId,
        summary: state.integration.lastSummary ?? "Factory objective completed.",
        completedAt: Date.now(),
      });
    } else if (emptyBlockedReady) {
      const nextStep = await this.maybeAutonomousNextStepForBlockedObjective(objectiveId, state);
      if (nextStep === "retried") {
        await this.reactObjective(objectiveId);
        return;
      }
      if (nextStep !== "asked_human") {
        await this.emitObjective(objectiveId, {
          type: "objective.blocked",
          objectiveId,
          reason: "No runnable tasks remained.",
          summary: "Factory objective is blocked with no runnable tasks.",
          blockedAt: Date.now(),
        });
      }
    }

    await this.rebalanceObjectiveSlots();
  }

  async runTask(payload: Record<string, unknown>, control?: CodexRunControl): Promise<Record<string, unknown>> {
    await this.ensureBootstrap();
    const parsed = this.parseTaskPayload(payload);
    const state = await this.getObjectiveState(parsed.objectiveId);
    const task = state.workflow.tasksById[parsed.taskId];
    if (!task) throw new FactoryServiceError(404, "factory task not found");
    if (parsed.executionMode === "isolated" && parsed.objectiveMode !== "investigation") {
      const blockedAt = Date.now();
      const reason = `factory delivery task ${parsed.taskId} cannot run in isolated mode; reroute it into a git worktree runtime before dispatching Codex.`;
      await this.commitTaskMemory(state, task, parsed.candidateId, reason, "blocked_isolated_runtime");
      await this.emitObjective(parsed.objectiveId, {
        type: "task.blocked",
        objectiveId: parsed.objectiveId,
        taskId: parsed.taskId,
        reason,
        blockedAt,
      });
      await this.reactObjective(parsed.objectiveId);
      return {
        objectiveId: parsed.objectiveId,
        taskId: parsed.taskId,
        candidateId: parsed.candidateId,
        status: "blocked",
      };
    }
    let rebuiltPacket = false;
    if (parsed.executionMode === "worktree") {
      const workspaceStatus = await this.git.worktreeStatus(parsed.workspacePath);
      if (!workspaceStatus.exists) {
        await this.git.restoreWorkspace({
          workspaceId: parsed.workspaceId,
          branchName: `hub/${parsed.workerType}/${parsed.workspaceId}`,
          workspacePath: parsed.workspacePath,
          baseHash: parsed.baseCommit,
        });
        rebuiltPacket = true;
      }
    } else {
      const exists = await pathExists(parsed.workspacePath);
      if (!exists) {
        await fs.mkdir(parsed.workspacePath, { recursive: true });
        rebuiltPacket = true;
      }
      await this.materializeIsolatedTaskSupportFiles(parsed.workspacePath, this.workerTaskProfile(parsed.profile));
    }
    const packetPresent = await this.taskPacketPresent(parsed);
    if (rebuiltPacket || !packetPresent || parsed.executionMode === "worktree") {
      await this.writeTaskPacket(state, task, parsed.candidateId, parsed.workspacePath);
    }
    const workspaceCommandEnv = await this.ensureWorkspaceCommandEnv(parsed.workspacePath);
    const resultSchemaPath = this.taskResultSchemaPath(parsed.resultPath);
    await fs.mkdir(path.dirname(resultSchemaPath), { recursive: true });
    await fs.writeFile(
      resultSchemaPath,
      JSON.stringify(parsed.objectiveMode === "investigation" ? FACTORY_INVESTIGATION_TASK_RESULT_SCHEMA : FACTORY_TASK_RESULT_SCHEMA, null, 2),
      "utf-8",
    );
    const execution = await this.codexExecutor.run({
      prompt: await this.renderTaskPrompt(state, task, parsed),
      workspacePath: parsed.workspacePath,
      promptPath: parsed.promptPath,
      lastMessagePath: parsed.lastMessagePath,
      stdoutPath: parsed.stdoutPath,
      stderrPath: parsed.stderrPath,
      model: FACTORY_TASK_CODEX_MODEL,
      jsonOutput: true,
      outputSchemaPath: resultSchemaPath,
      completionSignalPath: parsed.lastMessagePath,
      completionQuietMs: 1_500,
      reasoningEffort: severityWorkerReasoningEffort(parsed.profile.rootProfileId, parsed.objectiveMode, parsed.severity, task.taskKind),
      sandboxMode: sandboxModeForTask(),
      isolateCodexHome: true,
      objectiveId: parsed.objectiveId,
      taskId: parsed.taskId,
      candidateId: parsed.candidateId,
      integrationRef: parsed.integrationRef,
      contextRefs: parsed.contextRefs,
      skillBundlePaths: parsed.skillBundlePaths,
      repoSkillPaths: parsed.repoSkillPaths,
      env: {
        DATA_DIR: this.dataDir,
        RECEIPT_DATA_DIR: this.dataDir,
        PATH: workspaceCommandEnv.path,
      },
    }, control);
    const taskResult = await this.resolveTaskWorkerResult(parsed, execution);
    await fs.writeFile(parsed.resultPath, JSON.stringify(taskResult, null, 2), "utf-8");
    await this.applyTaskWorkerResult(parsed, taskResult);
    await this.reactObjective(parsed.objectiveId);
    return {
      objectiveId: parsed.objectiveId,
      taskId: parsed.taskId,
      candidateId: parsed.candidateId,
      status: "completed",
    };
  }

  private async detectArtifactIssues(
    workspacePath: string,
    workerArtifacts: ReadonlyArray<{
      readonly label: string;
      readonly path: string | null | undefined;
      readonly summary: string | null | undefined;
    }>,
  ): Promise<ReadonlyArray<FactoryArtifactIssue>> {
    return detectArtifactIssues(workspacePath, workerArtifacts);
  }

  async applyTaskWorkerResult(payload: FactoryTaskJobPayload, rawResult: Record<string, unknown>): Promise<void> {
    const state = await this.getObjectiveState(payload.objectiveId);
    const task = state.workflow.tasksById[payload.taskId];
    if (!task) throw new FactoryServiceError(404, "factory task not found");
    const summary = requireNonEmpty(rawResult.summary, "task result summary required");
    const workerArtifacts = Array.isArray(rawResult.artifacts)
      ? rawResult.artifacts
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          label: requireNonEmpty(item.label, "task artifact label required"),
          path: optionalTrimmedString(item.path),
          summary: optionalTrimmedString(item.summary),
        }))
      : [];
    const nextAction = optionalTrimmedString(rawResult.nextAction);
    const workerArtifactSummary = workerArtifacts.length > 0
      ? `Artifacts:\n${workerArtifacts.map((item) =>
        `- ${item.label}${item.path ? ` (${item.path})` : ""}${item.summary ? `: ${item.summary}` : ""}`
      ).join("\n")}`
      : undefined;
    const scriptsRun = normalizeExecutionScriptsRun(rawResult.scriptsRun);
    const completedAt = Date.now();
    const isInvestigation = state.objectiveMode === "investigation";
    const hasStructuredInvestigationReport = isInvestigation && isRecord(rawResult.report);
    let outcome: FactoryTaskResultOutcome;
    switch (optionalTrimmedString(rawResult.outcome)) {
      case "changes_requested":
      case "blocked":
      case "partial":
        outcome = optionalTrimmedString(rawResult.outcome) as FactoryTaskResultOutcome;
        break;
      default:
        outcome = "approved";
        break;
    }
    const artifactIssues = isInvestigation
      ? await this.detectArtifactIssues(payload.workspacePath, workerArtifacts)
      : [];
    const forcedPartialFromArtifacts = isInvestigation && outcome === "approved" && artifactIssues.length > 0;
    if (forcedPartialFromArtifacts) outcome = "partial";
    const artifactIssueSummary = artifactIssues.length > 0
      ? `Captured artifact warnings:\n${artifactIssues.map((issue) =>
        `- ${issue.summary}${issue.detail ? ` ${issue.detail}` : ""}`
      ).join("\n")}`
      : undefined;
    const effectiveSummary = forcedPartialFromArtifacts
      ? `${summary}${summary.endsWith(".") ? "" : "."} Captured evidence artifacts recorded command errors, so this investigation remains partial.`
      : summary;
    const handoff = [nextAction ?? effectiveSummary, workerArtifactSummary, artifactIssueSummary]
      .filter(Boolean)
      .join("\n\n") || effectiveSummary;
    const initialCompletion = normalizeTaskCompletionRecord(
      rawResult.completion,
      buildDefaultTaskCompletion({
        summary: effectiveSummary,
        workerArtifacts,
        scriptsRun,
      }),
    );

    if ((outcome === "blocked" || (outcome === "partial" && !isInvestigation)) && !hasStructuredInvestigationReport) {
      await this.commitTaskMemory(
        state,
        task,
        payload.candidateId,
        renderDeliveryResultText({ summary: effectiveSummary, handoff, scriptsRun, completion: initialCompletion }),
        outcome,
      );
      await this.emitObjective(payload.objectiveId, {
        type: "task.blocked",
        objectiveId: payload.objectiveId,
        taskId: payload.taskId,
        reason: handoff,
        blockedAt: completedAt,
      });
      return;
    }

    const status = await this.taskWorkspaceStatus(payload.workspacePath, payload.executionMode);
    const checkResults = isInvestigation
      ? []
      : await this.runChecks(state.checks, payload.workspacePath);
    const failedCheck = checkResults.find((check) => !check.ok);

    if (payload.executionMode === "isolated" && !isInvestigation) {
      const reason = `factory task ran in isolated runtime and cannot produce an integration commit: ${effectiveSummary}`;
      await this.commitTaskMemory(
        state,
        task,
        payload.candidateId,
        renderDeliveryResultText({ summary: effectiveSummary, handoff, scriptsRun, completion: initialCompletion }),
        "blocked_no_diff",
      );
      await this.emitObjective(payload.objectiveId, {
        type: "task.blocked",
        objectiveId: payload.objectiveId,
        taskId: payload.taskId,
        reason,
        blockedAt: completedAt,
      });
      return;
    }

    if (!status.dirty && !isInvestigation) {
      const noDiffReason = `factory task produced no tracked diff: ${effectiveSummary}`;
      await this.commitTaskMemory(
        state,
        task,
        payload.candidateId,
        renderDeliveryResultText({ summary: effectiveSummary, handoff, scriptsRun, completion: initialCompletion }),
        "blocked_no_diff",
      );
      await this.emitObjective(payload.objectiveId, {
        type: "task.blocked",
        objectiveId: payload.objectiveId,
        taskId: payload.taskId,
        reason: noDiffReason,
        blockedAt: completedAt,
      });
      return;
    }

    const committed = status.dirty && payload.executionMode === "worktree"
      ? await this.git.commitWorkspace(
          payload.workspacePath,
          isInvestigation
            ? `[factory][investigation][${payload.objectiveId}] ${payload.taskId} ${state.title}`
            : `[factory][${payload.objectiveId}] ${payload.taskId} ${state.title}`,
        )
      : undefined;
    const baseResultRefs = {
      manifest: fileRef(payload.manifestPath, "task manifest"),
      prompt: fileRef(payload.promptPath, "task prompt"),
      result: fileRef(payload.resultPath, "task result"),
      stdout: fileRef(payload.stdoutPath, "task stdout"),
      stderr: fileRef(payload.stderrPath, "task stderr"),
      lastMessage: fileRef(payload.lastMessagePath, "task last message"),
      contextPack: fileRef(payload.contextPackPath, "task recursive context pack"),
      memoryScript: fileRef(payload.memoryScriptPath, "task memory script"),
      memoryConfig: fileRef(payload.memoryConfigPath, "task memory config"),
    } satisfies Readonly<Record<string, GraphRef>>;

    if (isInvestigation) {
      const report = normalizeInvestigationReport(
        hasStructuredInvestigationReport
          ? rawResult.report
          : {
              conclusion: effectiveSummary,
              evidence: workerArtifacts.map((item) => ({
                title: item.label,
                summary: item.summary ?? item.path ?? item.label,
                detail: item.path ?? null,
              })),
              scriptsRun: [],
              disagreements: [],
              nextSteps: nextAction ? [nextAction] : [],
            },
        effectiveSummary,
      );
      const reportWithArtifactIssues: FactoryInvestigationReport = artifactIssues.length > 0
        ? {
            ...report,
            evidence: [
              ...report.evidence,
              {
                title: "Captured artifact warnings",
                summary: clipText(artifactIssues.map((issue) => issue.summary).join(" "), 280)
                  ?? "Captured evidence artifacts recorded command errors.",
                detail: clipText(
                  artifactIssues
                    .map((issue) => issue.detail ?? issue.path)
                    .filter(Boolean)
                    .join("\n"),
                  600,
                ),
              },
            ],
            scriptsRun: [
              ...report.scriptsRun,
              ...artifactIssues.map((issue) => ({
                command: `artifact:${path.basename(issue.path)}`,
                summary: issue.summary,
                status: issue.status,
              } satisfies FactoryInvestigationReport["scriptsRun"][number])),
            ],
          }
        : report;
      const reportWithChecks: FactoryInvestigationReport = checkResults.length > 0
        ? {
            ...reportWithArtifactIssues,
            evidence: [
              ...reportWithArtifactIssues.evidence,
              ...checkResults.map((check) => ({
                title: check.ok ? "Check passed" : "Check failed",
                summary: `${check.command} exited ${String(check.exitCode ?? "unknown")}`,
                detail: clipText((check.stderr || check.stdout).trim(), 600),
              })),
            ],
            scriptsRun: [
              ...reportWithArtifactIssues.scriptsRun,
              ...checkResults.map((check) => ({
                command: check.command,
                summary: check.ok ? "Passed." : "Failed.",
                status: check.ok ? "ok" : "error",
              } satisfies FactoryInvestigationReport["scriptsRun"][number])),
            ],
          }
        : reportWithArtifactIssues;
      const investigationCompletion = normalizeTaskCompletionRecord(
        rawResult.completion,
        buildDefaultTaskCompletion({
          summary: effectiveSummary,
          workerArtifacts,
          scriptsRun: reportWithChecks.scriptsRun,
          report: reportWithChecks,
          checkResults,
        }),
      );
      const resultRefs = {
        ...baseResultRefs,
        ...(committed ? { commit: commitRef(committed.hash, "evidence commit") } : {}),
      } satisfies Readonly<Record<string, GraphRef>>;
      await this.emitObjective(payload.objectiveId, {
        type: "investigation.reported",
        objectiveId: payload.objectiveId,
        taskId: payload.taskId,
        candidateId: payload.candidateId,
        outcome,
        summary: effectiveSummary,
        handoff,
        completion: investigationCompletion,
        report: reportWithChecks,
        artifactRefs: resultRefs,
        evidenceCommit: committed?.hash,
        reportedAt: completedAt,
      });
      await this.commitTaskMemory(
        state,
        task,
        payload.candidateId,
        renderInvestigationReportText(effectiveSummary, reportWithChecks, investigationCompletion, [resultRefs]),
        outcome === "blocked" || outcome === "partial" ? "investigation_reported_partial" : "investigation_reported",
      );
      return;
    }

    const deliveryCompletion = normalizeTaskCompletionRecord(
      rawResult.completion,
      buildDefaultTaskCompletion({
        summary: effectiveSummary,
        workerArtifacts,
        scriptsRun,
        checkResults,
      }),
    );

    const resultRefs = {
      ...baseResultRefs,
      ...(committed ? { commit: commitRef(committed.hash, "candidate commit") } : {}),
    } satisfies Readonly<Record<string, GraphRef>>;

    await this.emitObjective(payload.objectiveId, {
      type: "candidate.produced",
      objectiveId: payload.objectiveId,
      candidateId: payload.candidateId,
      taskId: payload.taskId,
      headCommit: committed?.hash ?? payload.baseCommit,
      summary: effectiveSummary,
      handoff,
      completion: deliveryCompletion,
      checkResults,
      scriptsRun,
      artifactRefs: resultRefs,
      tokensUsed: typeof rawResult.tokensUsed === "number" ? rawResult.tokensUsed : undefined,
      producedAt: completedAt,
    });
    await this.emitObjective(payload.objectiveId, {
      type: "task.review.requested",
      objectiveId: payload.objectiveId,
      taskId: payload.taskId,
      reviewRequestedAt: completedAt,
    });

    if (failedCheck) {
      const classification = await this.classifyFailedCheck(state, failedCheck, payload.baseCommit);
      const inheritedOnly = classification.inherited;
      const reviewStatus: Extract<FactoryCandidateStatus, "approved" | "changes_requested" | "rejected"> =
        inheritedOnly && outcome === "approved" ? "approved" : "changes_requested";
      const reviewSummary = inheritedOnly
        ? `${effectiveSummary} (checks only reproduced an inherited failure in ${failedCheck.command})`
        : `Verification failed: ${failedCheck.command}`;
      const reviewHandoff = inheritedOnly
        ? `${handoff}\n\n${buildInheritedFactoryFailureNote(failedCheck, classification)}`
        : handoff;
      await this.emitObjective(payload.objectiveId, {
        type: "candidate.reviewed",
        objectiveId: payload.objectiveId,
        candidateId: payload.candidateId,
        taskId: payload.taskId,
        status: reviewStatus,
        summary: reviewSummary,
        handoff: reviewHandoff,
        reviewedAt: completedAt,
      });
      await this.commitTaskMemory(
        state,
        task,
        payload.candidateId,
        renderDeliveryResultText({
          summary: reviewSummary,
          handoff: reviewHandoff,
          scriptsRun,
          completion: deliveryCompletion,
        }),
        reviewStatus,
      );
      return;
    }

    const reviewStatus: Extract<FactoryCandidateStatus, "approved" | "changes_requested" | "rejected"> =
      outcome === "changes_requested" ? "changes_requested" : "approved";
    await this.emitObjective(payload.objectiveId, {
      type: "candidate.reviewed",
      objectiveId: payload.objectiveId,
      candidateId: payload.candidateId,
      taskId: payload.taskId,
      status: reviewStatus,
      summary: effectiveSummary,
      handoff,
      reviewedAt: completedAt,
    });
    await this.commitTaskMemory(
      state,
      task,
      payload.candidateId,
      renderDeliveryResultText({ summary: effectiveSummary, handoff, scriptsRun, completion: deliveryCompletion }),
      reviewStatus,
    );
  }

  async runIntegrationValidation(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parsed = this.parseIntegrationPayload(payload);
    const state = await this.getObjectiveState(parsed.objectiveId);
    const startedAt = Date.now();
    await this.emitObjective(parsed.objectiveId, {
      type: "integration.validating",
      objectiveId: parsed.objectiveId,
      candidateId: parsed.candidateId,
      startedAt,
    });
    const results = await this.runChecks(parsed.checks, parsed.workspacePath);
    const failed = results.find((result) => !result.ok);
    const raw = JSON.stringify({ results }, null, 2);
    await fs.mkdir(path.dirname(parsed.resultPath), { recursive: true });
    await fs.writeFile(parsed.resultPath, raw, "utf-8");
    await fs.writeFile(parsed.stdoutPath, results.map((result) => result.stdout).join("\n"), "utf-8");
    await fs.writeFile(parsed.stderrPath, results.map((result) => result.stderr).join("\n"), "utf-8");
    if (failed) {
      const classification = await this.classifyFailedCheck(state, failed, state.integration.headCommit ?? state.baseHash);
      if (classification.inherited) {
        const head = await this.git.worktreeStatus(parsed.workspacePath);
        const summary = `Integration checks only reproduced inherited failures for ${parsed.candidateId}.`;
        await this.emitObjective(parsed.objectiveId, {
          type: "integration.validated",
          objectiveId: parsed.objectiveId,
          candidateId: parsed.candidateId,
          headCommit: head.head ?? state.integration.headCommit ?? state.baseHash,
          validationResults: results,
          summary,
          validatedAt: Date.now(),
        });
        await this.commitIntegrationMemory(
          state,
          parsed.candidateId,
          `${summary}\n\n${buildInheritedFactoryFailureNote(failed, classification)}`,
          ["integration", "validated", "inherited_failures"],
        );
        await this.reactObjective(parsed.objectiveId);
        return { objectiveId: parsed.objectiveId, candidateId: parsed.candidateId, status: "completed" };
      }
      await this.commitIntegrationMemory(state, parsed.candidateId, `Integration validation failed: ${failed.command}`, ["integration", "failed"]);
      await this.emitObjective(parsed.objectiveId, {
        type: "integration.conflicted",
        objectiveId: parsed.objectiveId,
        candidateId: parsed.candidateId,
        reason: `integration validation failed: ${failed.command}`,
        conflictedAt: Date.now(),
      });
      await this.emitObjective(parsed.objectiveId, {
        type: "objective.blocked",
        objectiveId: parsed.objectiveId,
        reason: `Integration validation failed for ${parsed.candidateId}: ${failed.command}`,
        summary: `Integration validation failed for ${parsed.candidateId}. React with the next task attempt once the fix is clear.`,
        blockedAt: Date.now(),
      });
      await this.reactObjective(parsed.objectiveId);
      return { objectiveId: parsed.objectiveId, candidateId: parsed.candidateId, status: "failed" };
    }
    const head = await this.git.worktreeStatus(parsed.workspacePath);
    await this.emitObjective(parsed.objectiveId, {
      type: "integration.validated",
      objectiveId: parsed.objectiveId,
      candidateId: parsed.candidateId,
      headCommit: head.head ?? state.integration.headCommit ?? state.baseHash,
      validationResults: results,
      summary: `Integration checks passed for ${parsed.candidateId}.`,
      validatedAt: Date.now(),
    });
    await this.commitIntegrationMemory(state, parsed.candidateId, `Integration checks passed for ${parsed.candidateId}.`, ["integration", "validated"]);
    await this.reactObjective(parsed.objectiveId);
    return { objectiveId: parsed.objectiveId, candidateId: parsed.candidateId, status: "completed" };
  }

  async loadFreshJob(jobId: string): Promise<JobRecord | undefined> {
    return this.queue.getJob(jobId);
  }

  private queueJobFromRecord(job: JobRecord): QueueJob {
    return {
      id: job.id,
      agentId: job.agentId,
      lane: job.lane,
      sessionKey: job.sessionKey,
      singletonMode: job.singletonMode,
      payload: { ...job.payload },
      status: job.status,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      leaseOwner: job.workerId,
      leaseUntil: job.leaseUntil,
      lastError: job.lastError,
      result: job.result ? { ...job.result } : undefined,
      canceledReason: job.canceledReason,
      abortRequested: job.abortRequested,
      commands: job.commands.map((command) => ({
        ...command,
        payload: command.payload ? { ...command.payload } : undefined,
      })),
    };
  }

  private objectiveJobsForTasks(tasks: ReadonlyArray<Pick<FactoryTaskView, "job">>): ReadonlyArray<QueueJob> {
    const jobsById = new Map<string, QueueJob>();
    for (const task of tasks) {
      if (!task.job) continue;
      jobsById.set(task.job.id, this.queueJobFromRecord(task.job));
    }
    return [...jobsById.values()].sort((a, b) =>
      b.updatedAt - a.updatedAt
      || b.createdAt - a.createdAt
      || b.id.localeCompare(a.id)
    );
  }

  private nextTaskOrdinal(state: FactoryState): number {
    return state.workflow.taskIds
      .map((taskId) => /^task_(\d+)$/i.exec(taskId)?.[1])
      .map((value) => Number.parseInt(value ?? "", 10))
      .filter((value) => Number.isFinite(value))
      .reduce((max, value) => Math.max(max, value), 0);
  }

  private nextTaskId(state: FactoryState, offset = 0): string {
    return taskOrdinalId(this.nextTaskOrdinal(state) + offset);
  }

  private async dispatchTask(
    state: FactoryState,
    task: FactoryTaskRecord,
    opts?: {
      readonly expectedPrev?: string;
      readonly prefixEvents?: ReadonlyArray<FactoryEvent>;
    },
  ): Promise<void> {
    state = await this.getObjectiveStateAtHead(state.objectiveId, opts?.expectedPrev);
    task = state.workflow.tasksById[task.taskId] ?? task;
    const profile = this.objectiveProfileForState(state);
    const workerType = this.normalizeProfileWorkerType(profile, String(task.workerType));
    if (!this.objectiveAllowsWorker(state, workerType)) {
      throw new FactoryServiceError(
        409,
        `worker '${workerType}' is not allowed by objective profile '${profile.rootProfileId}'`,
      );
    }
    if (state.workflow.activeTaskIds.length >= this.effectiveMaxParallelChildren(state)) {
      throw new FactoryServiceError(
        409,
        `objective already has ${state.workflow.activeTaskIds.length} active child runs; profile limit is ${this.effectiveMaxParallelChildren(state)}`,
      );
    }
    const candidateId = this.resolveDispatchCandidateId(state, task);
    const dispatchBaseCommit = this.resolveTaskBaseCommit(state, task);
    const workspaceId = `${state.objectiveId}_${task.taskId}_${candidateId}`;
    const executionMode = this.taskExecutionMode(state, task);
    const workspace = await this.ensureTaskRuntime(state, task, workspaceId, dispatchBaseCommit, {
      resetIfBaseMismatch: !state.candidates[candidateId] && !task.workspacePath,
    });
    const pinnedBaseCommit = workspace.baseHash;
    const candidateCreated = !state.candidates[candidateId]
      ? (() => {
        const createdAt = Date.now();
        const priorCandidate = this.latestTaskCandidate(state, task.taskId);
        return {
          type: "candidate.created",
          objectiveId: state.objectiveId,
          createdAt,
          candidate: {
            candidateId,
            taskId: task.taskId,
            status: "planned",
            parentCandidateId: priorCandidate?.candidateId,
            baseCommit: priorCandidate?.headCommit ?? pinnedBaseCommit,
            checkResults: [],
            artifactRefs: {},
            createdAt,
            updatedAt: createdAt,
          },
        } satisfies FactoryEvent;
      })()
      : undefined;
    const manifest = await this.writeTaskPacket(state, task, candidateId, workspace.path, pinnedBaseCommit);
    const jobId = `job_factory_${state.objectiveId}_${task.taskId}_${candidateId}`;
    await this.emitObjectiveBatch(state.objectiveId, [
      ...(opts?.prefixEvents ?? []),
      ...(candidateCreated ? [candidateCreated] : []),
      {
        type: "task.dispatched",
        objectiveId: state.objectiveId,
        taskId: task.taskId,
        candidateId,
        jobId,
        workspaceId,
        workspacePath: workspace.path,
        skillBundlePaths: manifest.skillBundlePaths,
        contextRefs: manifest.contextRefs,
        startedAt: Date.now(),
      },
    ], opts?.expectedPrev);

    const workerProfile = this.workerTaskProfile(profile);
    const payload: FactoryTaskJobPayload = {
      kind: "factory.task.run",
      objectiveId: state.objectiveId,
      taskId: task.taskId,
      workerType,
      objectiveMode: state.objectiveMode,
      severity: state.severity,
      candidateId,
      baseCommit: pinnedBaseCommit,
      executionMode,
      workspaceId,
      workspacePath: workspace.path,
      promptPath: manifest.promptPath,
      resultPath: manifest.resultPath,
      stdoutPath: manifest.stdoutPath,
      stderrPath: manifest.stderrPath,
      lastMessagePath: manifest.lastMessagePath,
      manifestPath: manifest.manifestPath,
      contextPackPath: manifest.contextPackPath,
      memoryScriptPath: manifest.memoryScriptPath,
      memoryConfigPath: manifest.memoryConfigPath,
      repoSkillPaths: manifest.repoSkillPaths,
      skillBundlePaths: manifest.skillBundlePaths,
      profile: workerProfile,
      profilePromptHash: profile.promptHash,
      profileSkillRefs: workerProfile.selectedSkills,
      sharedArtifactRefs: manifest.sharedArtifactRefs,
      contextRefs: manifest.contextRefs,
      integrationRef: state.integration.branchRef,
      problem: task.prompt,
      config: {
        workspace: workspace.path,
        memoryScope: `factory/objectives/${state.objectiveId}/tasks/${task.taskId}`,
        maxIterations: 6,
      },
    };
    const created = await this.queue.enqueue({
      jobId,
      agentId: "codex",
      lane: "collect",
      sessionKey: `factory:${state.objectiveId}:${task.taskId}`,
      singletonMode: "allow",
      maxAttempts: 2,
      payload,
    });
    this.sse.publish("jobs", created.id);
  }

  private async queueIntegration(
    state: FactoryState,
    candidateId: string,
    opts?: {
      readonly expectedPrev?: string;
      readonly prefixEvents?: ReadonlyArray<FactoryEvent>;
    },
  ): Promise<void> {
    const candidate = state.candidates[candidateId];
    if (state.integration.queuedCandidateIds.includes(candidateId) || state.integration.activeCandidateId === candidateId) {
      // console.log(`[DEBUG queueIntegration] SKIPPING candidateId: ${candidateId} as it is already queued or active.`);
      return;
    }
    // console.log(`[DEBUG queueIntegration] candidateId: ${candidateId}, candidateStatus: ${candidate?.status}, integrationStatus: ${state.integration.status}, stack: ${new Error().stack}`);
    if (!candidate?.headCommit) throw new FactoryServiceError(409, "candidate has no commit to integrate");
    const workspace = await this.git.ensureIntegrationWorkspace(state.objectiveId, state.integration.headCommit ?? state.baseHash);
    const now = Date.now();
    await this.emitObjectiveBatch(state.objectiveId, [
      ...(opts?.prefixEvents ?? []),
      {
        type: "integration.queued",
        objectiveId: state.objectiveId,
        candidateId,
        branchName: workspace.branchName,
        branchRef: workspaceRef(workspace.path, "integration workspace"),
        queuedAt: now,
      },
      {
        type: "integration.merging",
        objectiveId: state.objectiveId,
        candidateId,
        startedAt: now + 1,
      },
    ], opts?.expectedPrev);

    try {
      const merged = await this.git.mergeCommitIntoWorkspace(
        workspace.path,
        candidate.headCommit,
        `[factory][${state.objectiveId}] integrate ${candidateId}`
      );
      await this.emitObjective(state.objectiveId, {
        type: "merge.applied",
        objectiveId: state.objectiveId,
        candidateId,
        taskId: candidate.taskId,
        summary: `Integrated ${candidateId} into ${workspace.branchName}.`,
        mergeCommit: merged.hash,
        appliedAt: Date.now(),
      });
      await this.emitObjective(state.objectiveId, {
        type: "task.integrated",
        objectiveId: state.objectiveId,
        taskId: candidate.taskId,
        summary: `Integrated ${candidateId}.`,
        integratedAt: Date.now(),
      });
      await this.enqueueIntegrationValidation(state.objectiveId, candidateId, workspace.path, state.checks);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.emitObjective(state.objectiveId, {
        type: "candidate.conflicted",
        objectiveId: state.objectiveId,
        candidateId,
        reason: message,
        conflictedAt: Date.now(),
      });
      await this.emitObjective(state.objectiveId, {
        type: "integration.conflicted",
        objectiveId: state.objectiveId,
        candidateId,
        reason: message,
        conflictedAt: Date.now(),
      });
      await this.emitObjective(state.objectiveId, {
        type: "objective.blocked",
        objectiveId: state.objectiveId,
        reason: `Integration merge conflicted for ${candidateId}: ${message}`,
        summary: `Integration merge conflicted for ${candidateId}. React with the next task attempt after deciding how to resolve it.`,
        blockedAt: Date.now(),
      });
      await this.commitIntegrationMemory(state, candidateId, `Integration merge conflicted for ${candidateId}: ${message}`, ["integration", "conflicted"]);
      await this.reactObjective(state.objectiveId);
    }
  }

  private async enqueueIntegrationValidation(
    objectiveId: string,
    candidateId: string,
    workspacePath: string,
    checks: ReadonlyArray<string>,
  ): Promise<void> {
    const files = this.integrationFilePaths(workspacePath, candidateId);
    const payload: FactoryIntegrationJobPayload = {
      kind: "factory.integration.validate",
      objectiveId,
      candidateId,
      workspacePath,
      stdoutPath: files.stdoutPath,
      stderrPath: files.stderrPath,
      resultPath: files.resultPath,
      checks,
    };
    const created = await this.queue.enqueue({
      jobId: `job_factory_validate_${objectiveId}_${candidateId}`,
      agentId: "codex",
      lane: "collect",
      sessionKey: `factory:integration:${objectiveId}`,
      singletonMode: "allow",
      maxAttempts: 1,
      payload,
    });
    this.sse.publish("jobs", created.id);
  }

  private parseIntegrationPublishPayload(payload: Record<string, unknown>): FactoryIntegrationPublishJobPayload {
    if (payload.kind !== "factory.integration.publish") {
      throw new FactoryServiceError(400, "invalid integration publish payload");
    }
    return payload as unknown as FactoryIntegrationPublishJobPayload;
  }

  async runIntegrationPublish(payload: Record<string, unknown>, control?: CodexRunControl): Promise<Record<string, unknown>> {
    const parsed = this.parseIntegrationPublishPayload(payload);
    const state = await this.getObjectiveState(parsed.objectiveId);

    const workspaceCommandEnv = await this.ensureWorkspaceCommandEnv(parsed.workspacePath);
    const resultSchemaPath = path.join(path.dirname(parsed.resultPath), "schema.json");
    await fs.mkdir(path.dirname(resultSchemaPath), { recursive: true });
    await fs.writeFile(resultSchemaPath, JSON.stringify(FACTORY_PUBLISH_RESULT_SCHEMA, null, 2), "utf-8");

    const memoryConfigPath = path.join(path.dirname(parsed.resultPath), "memory.json");
    await fs.writeFile(memoryConfigPath, JSON.stringify({ scopes: [parsed.memoryScope] }, null, 2), "utf-8");
    try {
      const codexInput: CodexRunInput = {
        prompt: [
          "# Factory Integration Publish",
          "",
          `Objective ID: ${parsed.objectiveId}`,
          `Objective Title: ${state.title}`,
          `Candidate ID: ${parsed.candidateId}`,
          `Head Commit: ${state.integration.headCommit ?? state.baseHash}`,
          `Publish Memory Scope: ${parsed.memoryScope}`,
          "",
          "## Objective Prompt",
          state.prompt,
          "",
          "## Publish Contract",
          `Use \`receipt memory summarize factory/objectives/${parsed.objectiveId}\` and \`receipt inspect factory/objectives/${parsed.objectiveId}\` before writing the PR body.`,
          "Inspect `git remote -v`, push the current branch to a GitHub remote (prefer `origin` when present), open the PR with gh, then fetch the final PR metadata from the current branch.",
          "Before creating a new PR, check whether the current branch already has one with `gh pr view --json url,number,headRefName,baseRefName`.",
          "If `git push`, `gh pr create`, or `gh pr view` fail with a transient GitHub or network error, retry the command up to two more times with short backoff. After a failed `gh pr create`, check `gh pr view` once before concluding the PR was not created.",
          "Do not run builds or tests.",
          "Return exactly one JSON object matching this schema:",
          `{"summary":"short publish summary","prUrl":"https://github.com/...","prNumber":123,"headRefName":"branch-name","baseRefName":"main"}`,
          "Use null for prNumber, headRefName, or baseRefName only if GitHub does not return them.",
        ].join("\n"),
        workspacePath: parsed.workspacePath,
        promptPath: parsed.promptPath,
        lastMessagePath: parsed.lastMessagePath,
        stdoutPath: parsed.stdoutPath,
        stderrPath: parsed.stderrPath,
        model: FACTORY_TASK_CODEX_MODEL,
        jsonOutput: true,
        outputSchemaPath: resultSchemaPath,
        completionSignalPath: parsed.lastMessagePath,
        completionQuietMs: 1_500,
        reasoningEffort: "low",
        isolateCodexHome: true,
        objectiveId: parsed.objectiveId,
        taskId: "publish",
        candidateId: parsed.candidateId,
        contextRefs: parsed.contextRefs,
        skillBundlePaths: parsed.skillBundlePaths,
        repoSkillPaths: [],
        env: {
          DATA_DIR: this.dataDir,
          RECEIPT_DATA_DIR: this.dataDir,
          PATH: workspaceCommandEnv.path,
        },
      };
      let publishResult: FactoryPublishResult | undefined;
      let lastPublishError: unknown;
      for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt += 1) {
        try {
          const execution = await this.codexExecutor.run(codexInput, control);
          publishResult = await this.resolvePublishWorkerResult(parsed, execution);
          break;
        } catch (err) {
          lastPublishError = err;
          const message = err instanceof Error ? err.message : String(err);
          if (attempt >= PUBLISH_MAX_ATTEMPTS || !this.isRetryablePublishFailureMessage(message)) {
            throw err;
          }
          await sleep(attempt * 2_000);
        }
      }
      if (!publishResult) {
        throw lastPublishError instanceof Error ? lastPublishError : new Error(String(lastPublishError ?? "factory publish failed"));
      }
      await fs.writeFile(parsed.resultPath, JSON.stringify(publishResult, null, 2), "utf-8");
      const summary = publishResult.summary;
      await this.commitPublishMemory(state, parsed.candidateId, `${summary}\nPR: ${publishResult.prUrl}`, ["publish", "succeeded"]);
      await this.emitObjective(parsed.objectiveId, {
        type: "integration.promoted",
        objectiveId: parsed.objectiveId,
        candidateId: parsed.candidateId,
        promotedCommit: state.integration.headCommit ?? state.baseHash,
        summary,
        prUrl: publishResult.prUrl,
        prNumber: publishResult.prNumber ?? undefined,
        headRefName: publishResult.headRefName ?? undefined,
        baseRefName: publishResult.baseRefName ?? undefined,
        promotedAt: Date.now(),
      });
      await this.emitObjective(parsed.objectiveId, {
        type: "objective.completed",
        objectiveId: parsed.objectiveId,
        summary,
        completedAt: Date.now(),
      });
      await this.reactObjective(parsed.objectiveId);
      return {
        objectiveId: parsed.objectiveId,
        status: "completed",
        prUrl: publishResult.prUrl,
        prNumber: publishResult.prNumber,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = `Publishing failed: ${message}`;
      await this.commitPublishMemory(state, parsed.candidateId, reason, ["publish", "failed"]);
      await this.emitObjective(parsed.objectiveId, {
        type: "integration.conflicted",
        objectiveId: parsed.objectiveId,
        candidateId: parsed.candidateId,
        reason,
        headCommit: state.integration.headCommit ?? state.baseHash,
        conflictedAt: Date.now(),
      });
      await this.emitObjective(parsed.objectiveId, {
        type: "objective.blocked",
        objectiveId: parsed.objectiveId,
        reason,
        summary: reason,
        blockedAt: Date.now(),
      });
      await this.reactObjective(parsed.objectiveId);
      return { objectiveId: parsed.objectiveId, status: "failed", message: reason };
    }
  }

  private async promoteIntegration(
    state: FactoryState,
    candidateId: string,
    opts?: {
      readonly expectedPrev?: string;
      readonly prefixEvents?: ReadonlyArray<FactoryEvent>;
    },
  ): Promise<void> {
    const workspace = await this.git.ensureIntegrationWorkspace(state.objectiveId, state.integration.headCommit ?? state.baseHash);
    const status = await this.git.worktreeStatus(workspace.path);
    const commit = status.head ?? state.integration.headCommit;
    if (!commit) throw new FactoryServiceError(409, "integration branch has no HEAD to promote");
    await this.emitObjectiveBatch(state.objectiveId, [
      ...(opts?.prefixEvents ?? []),
      {
        type: "integration.promoting",
        objectiveId: state.objectiveId,
        candidateId,
        startedAt: Date.now(),
      },
    ], opts?.expectedPrev);

    const files = this.integrationFilePaths(workspace.path, "publish");
    const payload: FactoryIntegrationPublishJobPayload = {
      kind: "factory.integration.publish",
      objectiveId: state.objectiveId,
      candidateId,
      workspacePath: workspace.path,
      stdoutPath: files.stdoutPath,
      stderrPath: files.stderrPath,
      resultPath: files.resultPath,
      promptPath: path.join(path.dirname(files.resultPath), "prompt.txt"),
      lastMessagePath: path.join(path.dirname(files.resultPath), "last-message.txt"),
      memoryScope: `factory/objectives/${state.objectiveId}/publish`,
      contextRefs: [],
      skillBundlePaths: [path.join(this.git.repoRoot, "skills", "factory-pr-publisher", "SKILL.md")],
    };

    const created = await this.queue.enqueue({
      jobId: `job_factory_publish_${state.objectiveId}_${candidateId}`,
      agentId: "codex",
      lane: "collect",
      sessionKey: `factory:integration:${state.objectiveId}`,
      singletonMode: "allow",
      maxAttempts: 1,
      payload,
    });
    this.sse.publish("jobs", created.id);
  }

  private summarizedReceipts(
    chain: ReadonlyArray<{ readonly body: FactoryEvent; readonly hash: string; readonly ts: number }>,
    limit = 40,
  ): ReadonlyArray<{
    readonly type: string;
    readonly hash: string;
    readonly ts: number;
    readonly summary: string;
    readonly taskId?: string;
    readonly candidateId?: string;
  }> {
    return [...chain]
      .filter((receipt) => !CONTROL_RECEIPT_TYPES.has(receipt.body.type as never))
      .slice(-Math.max(1, Math.min(limit, 200)))
      .map((receipt) => {
        const ref = this.receiptTaskOrCandidateId(receipt.body);
        return {
          type: receipt.body.type,
          hash: receipt.hash,
          ts: receipt.ts,
          summary: this.summarizeReceipt(receipt.body),
          taskId: ref.taskId,
          candidateId: ref.candidateId,
        };
      });
  }

  private buildBlockedExplanation(
    state: FactoryState,
    receipts: ReadonlyArray<{
      readonly type: string;
      readonly hash: string;
      readonly ts: number;
      readonly summary: string;
      readonly taskId?: string;
      readonly candidateId?: string;
    }>,
  ): FactoryObjectiveCard["blockedExplanation"] | undefined {
    const dependentSummary = this.blockedDependentSummary(state);
    if (!state.blockedReason && state.status !== "blocked" && state.integration.status !== "conflicted") return undefined;
    const match = [...receipts]
      .reverse()
      .find((receipt) =>
        receipt.type === "objective.blocked"
        || receipt.type === "task.blocked"
        || receipt.type === "integration.conflicted"
        || receipt.type === "candidate.conflicted",
      );
    if (!match) {
      return state.blockedReason
        ? { summary: [state.blockedReason, dependentSummary].filter(Boolean).join(" ") }
        : undefined;
    }
    return {
      summary: [match.summary, dependentSummary].filter(Boolean).join(" "),
      taskId: match.taskId,
      candidateId: match.candidateId,
      receiptType: match.type,
      receiptHash: match.hash,
    };
  }

  private blockedDependentSummary(state: FactoryState): string | undefined {
    const blockedTaskIds = new Set(
      state.workflow.taskIds
        .map((taskId) => state.workflow.tasksById[taskId])
        .filter((task): task is FactoryTaskRecord => Boolean(task) && task.status === "blocked")
        .map((task) => task.taskId),
    );
    if (blockedTaskIds.size === 0) return undefined;
    const waiting = state.workflow.taskIds
      .map((taskId) => state.workflow.tasksById[taskId])
      .filter((task): task is FactoryTaskRecord => Boolean(task) && task.status === "pending")
      .map((task) => ({
        taskId: task.taskId,
        blockedBy: task.dependsOn.filter((depId) => blockedTaskIds.has(depId)),
      }))
      .filter((task) => task.blockedBy.length > 0);
    if (waiting.length === 0) return undefined;
    const preview = waiting
      .slice(0, 3)
      .map((task) => `${task.taskId} depends on ${task.blockedBy.join(", ")}`)
      .join("; ");
    const extra = waiting.length > 3 ? ` (+${waiting.length - 3} more)` : "";
    return `Waiting tasks: ${preview}${extra}.`;
  }

  private buildEvidenceCards(
    receipts: ReadonlyArray<{
      readonly type: string;
      readonly hash: string;
      readonly ts: number;
      readonly summary: string;
      readonly taskId?: string;
      readonly candidateId?: string;
    }>,
  ): FactoryObjectiveDetail["evidenceCards"] {
    return receipts
      .filter((receipt) =>
        receipt.type === "rebracket.applied"
        || receipt.type === "investigation.reported"
        || receipt.type === "investigation.synthesized"
        || receipt.type === "objective.blocked"
        || receipt.type === "task.blocked"
        || receipt.type === "integration.conflicted"
        || receipt.type === "merge.applied"
        || receipt.type === "integration.ready_to_promote"
        || receipt.type === "integration.promoted",
      )
      .slice(-12)
      .map((receipt) => ({
        kind:
          receipt.type === "rebracket.applied" ? "decision"
          : receipt.type.startsWith("investigation.") ? "report"
          : receipt.type === "merge.applied" ? "merge"
          : receipt.type === "integration.ready_to_promote" || receipt.type === "integration.promoted" ? "promotion"
          : "blocked",
        title:
          receipt.type === "rebracket.applied" ? "Latest decision"
          : receipt.type === "investigation.reported" ? "Investigation report"
          : receipt.type === "investigation.synthesized" ? "Investigation synthesis"
          : receipt.type === "merge.applied" ? "Integration merge"
          : receipt.type === "integration.ready_to_promote" ? "Ready to promote"
          : receipt.type === "integration.promoted" ? "Promoted"
          : "Blocked or conflicted",
        summary: receipt.summary,
        at: receipt.ts,
        taskId: receipt.taskId,
        candidateId: receipt.candidateId,
        receiptHash: receipt.hash,
        receiptType: receipt.type,
      }));
  }

  private buildActivity(
    tasks: ReadonlyArray<FactoryTaskView>,
    jobs: ReadonlyArray<QueueJob>,
    receipts: ReadonlyArray<{
      readonly type: string;
      readonly hash: string;
      readonly ts: number;
      readonly summary: string;
      readonly taskId?: string;
      readonly candidateId?: string;
    }>,
  ): FactoryObjectiveDetail["activity"] {
    const taskEntries = tasks
      .filter((task) => task.startedAt || task.reviewingAt || task.completedAt)
      .map((task) => ({
        kind: "task" as const,
        title: task.taskId,
        summary: `${task.title} [${task.status}]`,
        at: task.completedAt ?? task.reviewingAt ?? task.startedAt ?? task.createdAt,
        taskId: task.taskId,
        candidateId: task.candidateId,
      }));
    const jobEntries = jobs.slice(0, 10).map((job) => ({
      kind: "job" as const,
      title: job.id,
      summary: `${job.agentId} ${job.status}`,
      at: job.updatedAt,
      taskId: typeof (job.payload as Record<string, unknown>).taskId === "string" ? String((job.payload as Record<string, unknown>).taskId) : undefined,
      candidateId: typeof (job.payload as Record<string, unknown>).candidateId === "string" ? String((job.payload as Record<string, unknown>).candidateId) : undefined,
    }));
    const receiptEntries = receipts.slice(-12).map((receipt) => ({
      kind: "receipt" as const,
      title: receipt.type,
      summary: receipt.summary,
      at: receipt.ts,
      taskId: receipt.taskId,
      candidateId: receipt.candidateId,
    }));
    return [...taskEntries, ...jobEntries, ...receiptEntries]
      .sort((a, b) => b.at - a.at)
      .slice(0, 24);
  }

  private async buildObjectiveCard(
    state: FactoryState,
    queuePosition?: number,
    receipts?: ReadonlyArray<{
      readonly type: string;
      readonly hash: string;
      readonly ts: number;
      readonly summary: string;
      readonly taskId?: string;
      readonly candidateId?: string;
    }>,
  ): Promise<FactoryObjectiveCard> {
    const cacheKey = `${state.updatedAt}:${queuePosition ?? ""}`;
    const cached = this.objectiveCardCache.get(state.objectiveId);
    if (cached?.key === cacheKey) return cached.card;
    const projection = buildFactoryProjection(state);
    const latestCandidate = projection.candidates.at(-1);
    const needsBlockedReceipts = Boolean(state.blockedReason)
      || state.status === "blocked"
      || state.integration.status === "conflicted";
    const resolvedReceipts = receipts
      ?? (needsBlockedReceipts
        ? this.summarizedReceipts(await this.runtime.chain(objectiveStream(state.objectiveId)), 60)
        : []);
    const slotState = (this.isTerminalObjectiveStatus(state.status) || this.releasesObjectiveSlot(state) || state.scheduler.releasedAt)
      ? "released"
      : (state.scheduler.slotState ?? "active");
    const tokensUsed = Object.values(state.candidates).reduce((sum, c) => sum + (c.tokensUsed ?? 0), 0);
    const card = {
      objectiveId: state.objectiveId,
      title: state.title,
      status: state.status,
      phase: this.deriveObjectivePhase(state, {
        activeTasks: projection.activeTasks.length,
        readyTasks: projection.readyTasks.length,
      }),
      objectiveMode: state.objectiveMode,
      severity: state.severity,
      scheduler: {
        slotState,
        queuePosition,
      },
      archivedAt: state.archivedAt,
      updatedAt: state.updatedAt,
      latestSummary: state.latestSummary,
      blockedReason: state.blockedReason,
      sourceWarnings: state.sourceWarnings,
      blockedExplanation: needsBlockedReceipts
        ? this.buildBlockedExplanation(state, resolvedReceipts)
        : undefined,
      latestDecision: this.deriveLatestDecision(state),
      nextAction: this.deriveNextAction(state, queuePosition),
      activeTaskCount: projection.activeTasks.length,
      readyTaskCount: projection.readyTasks.length,
      taskCount: projection.tasks.length,
      integrationStatus: state.integration.status,
      latestCommitHash: state.integration.promotedCommit ?? state.integration.headCommit ?? latestCandidate?.headCommit,
      prUrl: state.integration.prUrl,
      prNumber: state.integration.prNumber,
      headRefName: state.integration.headRefName,
      baseRefName: state.integration.baseRefName,
      tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
      profile: this.objectiveProfileForState(state),
    };
    this.objectiveCardCache.set(state.objectiveId, {
      key: cacheKey,
      card,
    });
    return card;
  }

  private async buildObjectiveDetail(state: FactoryState, queuePosition?: number): Promise<FactoryObjectiveDetail> {
    const [chain, repoSkillPaths] = await Promise.all([
      this.runtime.chain(objectiveStream(state.objectiveId)),
      this.collectRepoSkillPaths(),
    ]);
    const receipts = this.summarizedReceipts(chain, 60);
    const sharedArtifactRefs = [
      artifactRef(this.objectiveProfileArtifactPath(state.objectiveId), "objective profile snapshot"),
      artifactRef(this.objectiveSkillSelectionArtifactPath(state.objectiveId), "objective profile skills"),
    ];
    const tasks = await Promise.all(
      state.workflow.taskIds.map(async (taskId) => {
        const task = state.workflow.tasksById[taskId];
        const job = task?.jobId ? await this.loadFreshJob(task.jobId) : undefined;
        const workspaceStatus = task?.workspacePath
          ? await this.taskWorkspaceStatus(task.workspacePath, task.executionMode ?? this.taskExecutionMode(state, task))
          : { exists: false, dirty: false };
        const filePaths = task?.workspacePath ? this.taskFilePaths(task.workspacePath, task.taskId) : undefined;
        const artifactActivity = task?.workspacePath
          ? await this.taskArtifactActivity(task.workspacePath, task.taskId)
          : [];
        const artifactSummary = this.summarizeTaskArtifactActivity(artifactActivity);
        return {
          ...task,
          candidate: task?.candidateId ? state.candidates[task.candidateId] : undefined,
          investigationReport: task ? state.investigation.reports[task.taskId] : undefined,
          completion: task ? factoryTaskCompletionForTask(state, task.taskId) : undefined,
          jobStatus: job?.status ?? (task?.jobId ? "missing" : undefined),
          job,
          workspaceExists: workspaceStatus.exists,
          workspaceDirty: workspaceStatus.dirty,
          workspaceHead: workspaceStatus.head,
          elapsedMs: task?.startedAt ? Math.max(0, Date.now() - task.startedAt) : undefined,
          manifestPath: filePaths?.manifestPath,
          contextPackPath: filePaths?.contextPackPath,
          promptPath: filePaths?.promptPath,
          memoryScriptPath: filePaths?.memoryScriptPath,
          stdoutPath: filePaths?.stdoutPath,
          stderrPath: filePaths?.stderrPath,
          lastMessagePath: filePaths?.lastMessagePath,
          stdoutTail: filePaths ? await this.readTextTail(filePaths.stdoutPath, 900) : undefined,
          stderrTail: filePaths ? await this.readTextTail(filePaths.stderrPath, 600) : undefined,
          lastMessage: filePaths ? await this.readTextTail(filePaths.lastMessagePath, 400) : undefined,
          artifactSummary,
          artifactActivity,
        } satisfies FactoryTaskView;
      })
    );
    const objectiveJobs = this.objectiveJobsForTasks(tasks);
    return {
      ...await this.buildObjectiveCard(state, queuePosition, receipts),
      prompt: state.prompt,
      channel: state.channel,
      baseHash: state.baseHash,
      sourceWarnings: state.sourceWarnings,
      checks: state.checks,
      profile: this.objectiveProfileForState(state),
      policy: state.policy,
      contextSources: this.buildContextSources(state, repoSkillPaths, sharedArtifactRefs),
      budgetState: this.buildBudgetState(state),
      createdAt: state.createdAt,
      planning: state.planning,
      tasks,
      investigation: {
        reports: this.investigationReports(state),
        synthesized: state.investigation.synthesized,
        finalReport: state.investigation.synthesized?.report ?? this.buildFinalInvestigationReport(state),
      },
      candidates: state.candidateOrder
        .map((candidateId) => state.candidates[candidateId])
        .filter((candidate): candidate is FactoryCandidateRecord => Boolean(candidate)),
      integration: state.integration,
      recentReceipts: receipts,
      evidenceCards: this.buildEvidenceCards(receipts),
      activity: this.buildActivity(tasks, objectiveJobs, receipts),
      latestRebracket: state.latestRebracket,
    };
  }

  private async buildObjectiveDebug(state: FactoryState, queuePosition?: number): Promise<FactoryDebugProjection> {
    const [detail, chain] = await Promise.all([
      this.buildObjectiveDetail(state, queuePosition),
      this.runtime.chain(objectiveStream(state.objectiveId)),
    ]);
    const objectiveJobs = this.objectiveJobsForTasks(detail.tasks);
    const activeJobs = objectiveJobs.filter((job) => !isTerminalJobStatus(job.status)).slice(0, 12);
    const taskWorktrees = await Promise.all(
      detail.tasks.map(async (task) => {
        const status = task.workspacePath
          ? await this.taskWorkspaceStatus(task.workspacePath, task.executionMode ?? this.taskExecutionMode(state, task))
          : { exists: false, dirty: false };
        return {
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          exists: status.exists,
          dirty: status.dirty,
          head: status.head,
          branch: status.branch,
        };
      }),
    );
    const integrationWorktree = state.integration.branchRef?.kind === "workspace"
      ? await this.git.worktreeStatus(state.integration.branchRef.ref).then((status) => ({
        workspacePath: state.integration.branchRef?.kind === "workspace" ? state.integration.branchRef.ref : undefined,
        exists: status.exists,
        dirty: status.dirty,
        head: status.head,
        branch: status.branch,
      }))
      : undefined;
    return {
      objectiveId: state.objectiveId,
      title: state.title,
      status: state.status,
      phase: detail.phase,
      scheduler: detail.scheduler,
      latestDecision: detail.latestDecision,
      nextAction: detail.nextAction,
      prUrl: detail.prUrl,
      prNumber: detail.prNumber,
      headRefName: detail.headRefName,
      baseRefName: detail.baseRefName,
      profile: detail.profile,
      policy: state.policy,
      contextSources: detail.contextSources,
      budgetState: detail.budgetState,
      recentReceipts: this.summarizedReceipts(chain, 40).map((receipt) => ({
        type: receipt.type,
        hash: receipt.hash,
        ts: receipt.ts,
        summary: receipt.summary,
      })),
      activeJobs,
      lastJobs: objectiveJobs.slice(0, 20),
      taskWorktrees,
      integrationWorktree,
      latestContextPacks: detail.tasks.map((task) => {
        if (!task.workspacePath) {
          return {
            taskId: task.taskId,
            candidateId: task.candidateId,
            contextPackPath: undefined,
            memoryScriptPath: undefined,
          };
        }
        const files = this.taskFilePaths(task.workspacePath, task.taskId);
        return {
          taskId: task.taskId,
          candidateId: task.candidateId,
          contextPackPath: files.contextPackPath,
          memoryScriptPath: files.memoryScriptPath,
        };
      }),
    };
  }

  private async emitObjectiveBatch(
    objectiveId: string,
    events: ReadonlyArray<FactoryEvent>,
    expectedPrev?: string,
  ): Promise<void> {
    if (events.length === 0) return;
    const stream = objectiveStream(objectiveId);
    try {
      await this.runtime.execute(stream, {
        type: "emit",
        eventId: makeEventId(stream),
        events,
        expectedPrev,
      });
    } catch (err) {
      if (
        typeof expectedPrev === "string"
        && err instanceof Error
        && err.message.startsWith("Expected prev hash ")
      ) {
        const actualPrev = /but head is (.+)$/.exec(err.message)?.[1];
        throw new FactoryStaleObjectiveError(objectiveId, expectedPrev, actualPrev);
      }
      throw err;
    }
    this.invalidateObjectiveProjection(objectiveId);
    this.sse.publish("factory", objectiveId);
    this.sse.publish("receipt");
  }

  private async emitObjective(objectiveId: string, event: FactoryEvent): Promise<void> {
    await this.emitObjectiveBatch(objectiveId, [event]);
  }

  private async currentHeadHash(objectiveId: string): Promise<string | undefined> {
    const chain = await this.runtime.chain(objectiveStream(objectiveId));
    return chain[chain.length - 1]?.hash;
  }

  private async discoverObjectiveStreams(): Promise<ReadonlyArray<string>> {
    const discovered = new Set<string>();
    const manifestPath = path.join(this.dataDir, "_streams.json");
    const raw = await readTextIfPresent(manifestPath) ?? "";
    let manifestLoaded = false;
    if (raw.trim()) {
      try {
        const manifest = JSON.parse(raw) as { readonly byStream?: Record<string, string> };
        manifestLoaded = true;
        for (const stream of Object.keys(manifest.byStream ?? {})) {
          if (stream.startsWith(`${FACTORY_STREAM_PREFIX}/`)) {
            discovered.add(stream);
          }
        }
      } catch {
        manifestLoaded = false;
      }
    }

    if (discovered.size > 0 || manifestLoaded) {
      return [...discovered].sort((a, b) => a.localeCompare(b));
    }

    const runtimeStreams = await this.runtime.listStreams(`${FACTORY_STREAM_PREFIX}/`);
    for (const stream of runtimeStreams) {
      if (stream.startsWith(`${FACTORY_STREAM_PREFIX}/`)) {
        discovered.add(stream);
      }
    }
    return [...discovered].sort((a, b) => a.localeCompare(b));
  }

  private dependsTransitivelyOn(
    state: FactoryState,
    taskId: string,
    targetTaskId: string,
    seen = new Set<string>(),
  ): boolean {
    if (seen.has(taskId)) return false;
    seen.add(taskId);
    const task = state.workflow.tasksById[taskId];
    if (!task) return false;
    if (task.dependsOn.includes(targetTaskId)) return true;
    return task.dependsOn.some((depId) => this.dependsTransitivelyOn(state, depId, targetTaskId, seen));
  }

  private latestTaskCandidate(state: FactoryState, taskId: string): FactoryCandidateRecord | undefined {
    for (let index = state.candidateOrder.length - 1; index >= 0; index -= 1) {
      const candidateId = state.candidateOrder[index];
      const candidate = state.candidates[candidateId];
      if (candidate?.taskId === taskId) return candidate;
    }
    return undefined;
  }

  private nextCandidateId(state: FactoryState, taskId: string): string {
    const ordinal = state.candidateOrder
      .map((candidateId) => state.candidates[candidateId])
      .filter((candidate): candidate is FactoryCandidateRecord => candidate?.taskId === taskId)
      .map((candidate) => /^.+_candidate_(\d+)$/i.exec(candidate.candidateId)?.[1])
      .map((value) => Number.parseInt(value ?? "", 10))
      .filter((value) => Number.isFinite(value))
      .reduce((max, value) => Math.max(max, value), 0);
    return `${taskId}_candidate_${String(ordinal + 1).padStart(2, "0")}`;
  }

  private resolveDispatchCandidateId(state: FactoryState, task: FactoryTaskRecord): string {
    const latest = this.latestTaskCandidate(state, task.taskId);
    if (!latest) return `${task.taskId}_candidate_01`;
    if (["planned", "running", "awaiting_review"].includes(latest.status)) return latest.candidateId;
    return this.nextCandidateId(state, task.taskId);
  }

  private collectDependencyClosure(
    state: FactoryState,
    taskId: string,
    seen = new Set<string>(),
  ): ReadonlyArray<string> {
    if (seen.has(taskId)) return [];
    seen.add(taskId);
    const task = state.workflow.tasksById[taskId];
    if (!task) return [];
    const collected: string[] = [];
    for (const depId of task.dependsOn) {
      collected.push(depId);
      for (const nested of this.collectDependencyClosure(state, depId, seen)) {
        if (!collected.includes(nested)) collected.push(nested);
      }
    }
    return collected;
  }

  private async summarizeScope(scope: string, query: string, maxChars: number): Promise<string | undefined> {
    if (!this.memoryTools) return undefined;
    try {
      const { summary } = await this.memoryTools.summarize({
        scope,
        query,
        limit: 6,
        maxChars,
        audit: {
          actor: "factory-service",
          operation: "summarize-scope",
        },
      });
      return summary.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async buildContextNode(
    state: FactoryState,
    taskId: string,
  ): Promise<FactoryContextTaskNode | undefined> {
    const task = state.workflow.tasksById[taskId];
    if (!task) return undefined;
    const candidate = this.latestTaskCandidate(state, taskId);
    const memorySummary = await this.summarizeScope(
      `factory/objectives/${state.objectiveId}/tasks/${taskId}`,
      `${task.title}\n${task.prompt}`,
      320,
    );
    const children = await Promise.all(task.dependsOn.map((depId) => this.buildContextNode(state, depId)));
    return {
      taskId: task.taskId,
      taskKind: task.taskKind,
      title: task.title,
      status: task.status,
      workerType: task.workerType,
      sourceTaskId: task.sourceTaskId,
      latestSummary: task.latestSummary,
      blockedReason: task.blockedReason,
      candidateId: candidate?.candidateId,
      candidateStatus: candidate?.status,
      memorySummary,
      children: children.filter((child): child is FactoryContextTaskNode => Boolean(child)),
    };
  }

  private async buildRelatedContextTask(
    state: FactoryState,
    taskId: string,
    relations: ReadonlySet<"focus" | "dependency" | "dependent">,
  ): Promise<FactoryContextRelatedTask | undefined> {
    const task = state.workflow.tasksById[taskId];
    if (!task) return undefined;
    const candidate = this.latestTaskCandidate(state, taskId);
    const memorySummary = await this.summarizeScope(
      `factory/objectives/${state.objectiveId}/tasks/${taskId}`,
      `${task.title}\n${task.prompt}`,
      320,
    );
    const relationOrder = ["focus", "dependency", "dependent"] as const;
    return {
      taskId: task.taskId,
      taskKind: task.taskKind,
      title: task.title,
      status: task.status,
      workerType: task.workerType,
      sourceTaskId: task.sourceTaskId,
      relations: relationOrder.filter((relation) => relations.has(relation)),
      latestSummary: task.latestSummary,
      blockedReason: task.blockedReason,
      candidateId: candidate?.candidateId,
      candidateStatus: candidate?.status,
      memorySummary,
    };
  }

  private summarizeReceipt(event: FactoryEvent): string {
    switch (event.type) {
      case "objective.operator.noted":
        return `Operator note: ${event.message}`;
      case "planning.receipt":
        return `planning receipt recorded: ${event.plan.taskGraph.length} task(s), ${event.plan.acceptanceCriteria.length} acceptance criteria`;
      case "objective.slot.queued":
        return "Objective queued for the repo execution slot.";
      case "objective.slot.admitted":
        return "Objective admitted to the repo execution slot.";
      case "objective.slot.released":
        return `Objective released its slot: ${event.reason}`;
      case "task.added":
        return `${event.task.taskId} added: ${event.task.title}`;
      case "task.blocked":
        return `${event.taskId} blocked: ${event.reason}`;
      case "task.unblocked":
        return `${event.taskId} unblocked`;
      case "task.superseded":
        return `${event.taskId} superseded: ${event.reason}`;
      case "candidate.produced":
        return `${event.candidateId} produced: ${event.summary}`;
      case "candidate.reviewed":
        return `${event.candidateId} ${event.status}: ${event.summary}`;
      case "investigation.reported":
        return `${event.taskId} ${event.outcome}: ${event.summary}`;
      case "investigation.synthesized":
        return `investigation synthesized: ${event.summary}`;
      case "candidate.conflicted":
        return `${event.candidateId} conflicted: ${event.reason}`;
      case "integration.conflicted":
        return `integration conflicted: ${event.reason}`;
      case "integration.ready_to_promote":
        return `integration ready: ${event.summary}`;
      case "integration.promoted":
        return `promoted: ${event.summary}`;
      case "rebracket.applied":
        return `orchestration chose ${event.selectedActionId ?? "none"}: ${event.reason}`;
      default:
        return event.type;
    }
  }

  private receiptTaskOrCandidateId(event: FactoryEvent): { readonly taskId?: string; readonly candidateId?: string } {
    switch (event.type) {
      case "planning.receipt":
        return {};
      case "task.added":
        return { taskId: event.task.taskId };
      case "task.ready":
      case "task.review.requested":
      case "task.approved":
      case "task.integrated":
      case "task.blocked":
      case "task.unblocked":
      case "task.superseded":
        return { taskId: event.taskId };
      case "task.dispatched":
        return { taskId: event.taskId, candidateId: event.candidateId };
      case "candidate.created":
        return { taskId: event.candidate.taskId, candidateId: event.candidate.candidateId };
      case "candidate.produced":
      case "candidate.reviewed":
      case "investigation.reported":
        return { taskId: event.taskId, candidateId: event.candidateId };
      case "investigation.synthesized":
        return {};
      case "candidate.conflicted":
      case "integration.queued":
      case "integration.merging":
      case "integration.validating":
      case "integration.validated":
      case "integration.promoting":
      case "integration.promoted":
        return { candidateId: event.candidateId };
      case "integration.ready_to_promote":
        return {};
      case "merge.applied":
        return { taskId: event.taskId, candidateId: event.candidateId };
      case "integration.conflicted":
        return { candidateId: event.candidateId };
      default:
        return {};
    }
  }

  private collectDependentClosure(
    state: FactoryState,
    taskId: string,
    seen = new Set<string>(),
  ): ReadonlyArray<string> {
    if (seen.has(taskId)) return [];
    seen.add(taskId);
    const directDependents = state.workflow.taskIds
      .map((id) => state.workflow.tasksById[id])
      .filter((task): task is FactoryTaskRecord => Boolean(task))
      .filter((task) => task.dependsOn.includes(taskId))
      .map((task) => task.taskId);
    const collected: string[] = [];
    for (const dependentId of directDependents) {
      if (!collected.includes(dependentId)) collected.push(dependentId);
      for (const nested of this.collectDependentClosure(state, dependentId, seen)) {
        if (!collected.includes(nested)) collected.push(nested);
      }
    }
    return collected;
  }

  private collectRelatedTaskRelations(
    state: FactoryState,
    taskId: string,
  ): ReadonlyMap<string, ReadonlySet<"focus" | "dependency" | "dependent">> {
    const relations = new Map<string, Set<"focus" | "dependency" | "dependent">>();
    const mark = (targetTaskId: string, relation: "focus" | "dependency" | "dependent"): void => {
      const current = relations.get(targetTaskId) ?? new Set<"focus" | "dependency" | "dependent">();
      current.add(relation);
      relations.set(targetTaskId, current);
    };
    mark(taskId, "focus");
    for (const depId of this.collectDependencyClosure(state, taskId)) mark(depId, "dependency");
    for (const dependentId of this.collectDependentClosure(state, taskId)) mark(dependentId, "dependent");
    return relations;
  }

  private taskRecency(task: FactoryTaskRecord): number {
    return task.completedAt ?? task.reviewingAt ?? task.startedAt ?? task.readyAt ?? task.createdAt;
  }

  private async buildObjectiveSliceTasks(
    state: FactoryState,
    taskIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<FactoryContextRelatedTask>> {
    const items = await Promise.all(
      taskIds.map((taskId) =>
        this.buildRelatedContextTask(
          state,
          taskId,
          new Set<"focus" | "dependency" | "dependent">(),
        )
      ),
    );
    return items.filter((item): item is FactoryContextRelatedTask => Boolean(item));
  }

  private async buildTaskContextPack(
    state: FactoryState,
    task: FactoryTaskRecord,
    candidateId: string,
    taskPrompt = task.prompt,
  ): Promise<FactoryContextPack> {
    const contextPackBuiltAt = Date.now();
    const chain = await this.runtime.chain(objectiveStream(state.objectiveId));
    const dependencyIds = this.collectDependencyClosure(state, task.taskId);
    const dependencyTree = await Promise.all(task.dependsOn.map((depId) => this.buildContextNode(state, depId)));
    const relatedTaskRelations = this.collectRelatedTaskRelations(state, task.taskId);
    const relatedTasks = await Promise.all(
      [...relatedTaskRelations.entries()].map(([relatedTaskId, relations]) =>
        this.buildRelatedContextTask(state, relatedTaskId, relations)
      ),
    );
    const syntheticCurrentCandidate = state.candidates[candidateId]
      ? undefined
      : {
          candidateId,
          taskId: task.taskId,
          status: "planned",
          parentCandidateId: this.latestTaskCandidate(state, task.taskId)?.candidateId,
          baseCommit: task.baseCommit,
          checkResults: [],
          artifactRefs: {},
          createdAt: contextPackBuiltAt,
          updatedAt: contextPackBuiltAt,
          scriptsRun: undefined,
          summary: undefined,
          headCommit: undefined,
          latestReason: undefined,
        } satisfies FactoryCandidateRecord;
    const lineage = [
      ...state.candidateOrder
        .map((id) => state.candidates[id])
        .filter((candidate): candidate is FactoryCandidateRecord => candidate?.taskId === task.taskId),
      ...(syntheticCurrentCandidate ? [syntheticCurrentCandidate] : []),
    ]
      .map((candidate) => ({
        candidateId: candidate.candidateId,
        parentCandidateId: candidate.parentCandidateId,
        status: candidate.status,
        summary: candidate.summary,
        headCommit: candidate.headCommit,
        latestReason: candidate.latestReason,
        scriptsRun: candidate.scriptsRun,
      }));
    const relatedTaskIds = new Set<string>([...relatedTaskRelations.keys(), ...dependencyIds]);
    const relatedCandidateIds = new Set<string>([
      candidateId,
      ...lineage.map((candidate) => candidate.candidateId),
      ...state.candidateOrder
        .map((id) => state.candidates[id])
        .filter((candidate): candidate is FactoryCandidateRecord => Boolean(candidate) && relatedTaskIds.has(candidate.taskId))
        .map((candidate) => candidate.candidateId),
    ]);
    const recentReceipts = [...chain]
      .reverse()
      .filter((receipt) => {
        const ref = this.receiptTaskOrCandidateId(receipt.body);
        return (ref.taskId && relatedTaskIds.has(ref.taskId))
          || (ref.candidateId && relatedCandidateIds.has(ref.candidateId))
          || receipt.body.type.startsWith("integration.")
          || receipt.body.type === "rebracket.applied";
      })
      .slice(0, 12)
      .reverse()
      .map((receipt) => {
        const ref = this.receiptTaskOrCandidateId(receipt.body);
        return {
          type: receipt.body.type,
          at: receipt.ts,
          taskId: ref.taskId,
          candidateId: ref.candidateId,
          summary: this.summarizeReceipt(receipt.body),
        } satisfies FactoryContextReceipt;
      });
    if (syntheticCurrentCandidate) {
      recentReceipts.push(
        {
          type: "candidate.created",
          at: contextPackBuiltAt,
          taskId: task.taskId,
          candidateId,
          summary: "candidate.created",
        },
        {
          type: "task.dispatched",
          at: contextPackBuiltAt + 1,
          taskId: task.taskId,
          candidateId,
          summary: "task.dispatched",
        },
      );
    }
    const focusedReceiptKeys = new Set(recentReceipts.map((receipt) => `${receipt.type}:${receipt.at}:${receipt.summary}`));
    const objectiveTasks = state.workflow.taskIds
      .map((taskId) => state.workflow.tasksById[taskId])
      .filter((node): node is FactoryTaskRecord => Boolean(node));
    const frontierTaskIds = objectiveTasks
      .filter((item) => ["ready", "running", "reviewing", "blocked"].includes(item.status))
      .sort((a, b) =>
        objectiveTaskStatusPriority(a.status) - objectiveTaskStatusPriority(b.status)
        || this.taskRecency(b) - this.taskRecency(a)
        || a.taskId.localeCompare(b.taskId)
      )
      .slice(0, 12)
      .map((item) => item.taskId);
    const recentCompletedTaskIds = objectiveTasks
      .filter((item) => ["approved", "integrated", "blocked", "superseded"].includes(item.status))
      .sort((a, b) => this.taskRecency(b) - this.taskRecency(a) || a.taskId.localeCompare(b.taskId))
      .slice(0, 8)
      .map((item) => item.taskId);
    const integrationTaskIds = objectiveTasks
      .filter((item) => {
        const candidateIdForTask = item.candidateId;
        if (!candidateIdForTask) return false;
        return state.integration.activeCandidateId === candidateIdForTask
          || state.integration.queuedCandidateIds.includes(candidateIdForTask);
      })
      .map((item) => item.taskId);
    const recentObjectiveReceipts = [...chain]
      .filter((receipt) => !CONTROL_RECEIPT_TYPES.has(receipt.body.type as never))
      .reverse()
      .map((receipt) => {
        const ref = this.receiptTaskOrCandidateId(receipt.body);
        return {
          type: receipt.body.type,
          at: receipt.ts,
          taskId: ref.taskId,
          candidateId: ref.candidateId,
          summary: this.summarizeReceipt(receipt.body),
        } satisfies FactoryContextReceipt;
      })
      .filter((receipt) => !focusedReceiptKeys.has(`${receipt.type}:${receipt.at}:${receipt.summary}`))
      .slice(0, 20)
      .reverse();
    const profile = this.workerTaskProfile(this.objectiveProfileForState(state));
    const [overview, objectiveMemory, integrationMemory, cloudExecutionContext] = await Promise.all([
      this.summarizeScope(`factory/objectives/${state.objectiveId}`, `${state.title}\n${task.title}`, 520),
      this.summarizeScope(`factory/objectives/${state.objectiveId}`, state.title, 360),
      this.summarizeScope(`factory/objectives/${state.objectiveId}/integration`, `${state.title}\nintegration`, 360),
      this.loadObjectiveCloudExecutionContext(profile),
    ]);
    const repoSkillPaths = await this.collectRepoSkillPaths();
    const helperCatalog = await loadFactoryHelperContext({
      profileRoot: this.profileRoot,
      provider: profile.cloudProvider ?? cloudExecutionContext.preferredProvider,
      objectiveTitle: state.title,
      objectivePrompt: state.prompt,
      taskTitle: task.title,
      taskPrompt,
      domain: "infrastructure",
    });
    const sharedArtifactRefs = [
      artifactRef(this.objectiveProfileArtifactPath(state.objectiveId), "objective profile snapshot"),
      artifactRef(this.objectiveSkillSelectionArtifactPath(state.objectiveId), "objective profile skills"),
      ...helperCatalogArtifactRefs(helperCatalog).map((ref) => artifactRef(ref.ref, ref.label)),
    ];
    const [frontierTasks, recentCompletedTasks, integrationTasks] = await Promise.all([
      this.buildObjectiveSliceTasks(state, frontierTaskIds),
      this.buildObjectiveSliceTasks(state, recentCompletedTaskIds),
      this.buildObjectiveSliceTasks(state, integrationTaskIds),
    ]);
    return {
      objectiveId: state.objectiveId,
      title: state.title,
      prompt: state.prompt,
      objectiveMode: state.objectiveMode,
      severity: state.severity,
      planning: state.planning,
      cloudExecutionContext,
      profile,
      task: {
        taskId: task.taskId,
        title: task.title,
        prompt: taskPrompt,
        workerType: task.workerType,
        executionMode: task.executionMode ?? profile.objectivePolicy.defaultTaskExecutionMode,
        status: task.status,
        candidateId,
      },
      integration: {
        status: state.integration.status,
        headCommit: state.integration.headCommit,
        activeCandidateId: state.integration.activeCandidateId,
        conflictReason: state.integration.conflictReason,
        lastSummary: state.integration.lastSummary,
      },
      dependencyTree: dependencyTree.filter((node): node is FactoryContextTaskNode => Boolean(node)),
      relatedTasks: relatedTasks
        .filter((node): node is FactoryContextRelatedTask => Boolean(node))
        .sort((a, b) => state.workflow.taskIds.indexOf(a.taskId) - state.workflow.taskIds.indexOf(b.taskId)),
      candidateLineage: lineage,
      recentReceipts,
      objectiveSlice: {
        frontierTasks,
        recentCompletedTasks,
        integrationTasks,
        recentObjectiveReceipts,
        objectiveMemorySummary: objectiveMemory,
        integrationMemorySummary: integrationMemory,
      },
      memory: {
        overview,
        objective: objectiveMemory,
        integration: integrationMemory,
      },
      investigation: {
        reports: state.investigation.reportOrder
          .map((taskId) => state.investigation.reports[taskId])
          .filter((report): report is FactoryInvestigationTaskReport => Boolean(report)),
        synthesized: state.investigation.synthesized,
      },
      helperCatalog,
      contextSources: {
        ...this.buildContextSources(state, repoSkillPaths, sharedArtifactRefs),
        profileSkillRefs: profile.selectedSkills,
      },
    };
  }

  private investigationReports(state: FactoryState): ReadonlyArray<FactoryInvestigationTaskReport> {
    return state.investigation.reportOrder
      .map((taskId) => state.investigation.reports[taskId])
      .filter((report): report is FactoryInvestigationTaskReport => Boolean(report));
  }

  private finalInvestigationReports(
    state: FactoryState,
  ): ReadonlyArray<FactoryInvestigationTaskReport> {
    return this.investigationReports(state).filter((report) => {
      const task = state.workflow.tasksById[report.taskId];
      if (!task || task.status !== "approved") return false;
      return true;
    });
  }

  private async commitInvestigationSynthesisMemory(
    state: FactoryState,
    synthesis: FactoryInvestigationSynthesisRecord,
  ): Promise<void> {
    if (!this.memoryTools) return;
    const reports = this.finalInvestigationReports(state).filter((report) => synthesis.taskIds.includes(report.taskId));
    const text = renderInvestigationReportText(
      synthesis.summary,
      synthesis.report,
      undefined,
      reports.map((report) => report.artifactRefs),
    );
    try {
      await this.memoryTools.commit({
        scope: `factory/objectives/${state.objectiveId}`,
        text,
        tags: ["factory", "objective", "investigation", "synthesized"],
      });
    } catch {
      // memory is auxiliary
    }
  }

  private buildFinalInvestigationReport(
    state: FactoryState,
  ): FactoryInvestigationReport {
    const reports = this.finalInvestigationReports(state);
    if (reports.length === 0) {
      return normalizeInvestigationReport(undefined, state.latestSummary ?? "No investigation findings were recorded.");
    }
    if (reports.length === 1) return reports[0]!.report;
    return {
      conclusion: reports.map((report) => `${report.taskId}: ${report.report.conclusion}`).join(" "),
      evidence: reports.flatMap((report) => report.report.evidence).slice(0, 16),
      scriptsRun: reports.flatMap((report) => report.report.scriptsRun).slice(0, 16),
      disagreements: [...new Set(reports.flatMap((report) => report.report.disagreements))],
      nextSteps: [...new Set(reports.flatMap((report) => report.report.nextSteps))],
    };
  }

  private buildInvestigationSynthesis(
    state: FactoryState,
  ): FactoryInvestigationSynthesisRecord | undefined {
    const reports = this.finalInvestigationReports(state);
    if (reports.length === 0) return undefined;
    if (reports.length === 1) {
      return {
        summary: reports[0]!.summary,
        report: reports[0]!.report,
        taskIds: [reports[0]!.taskId],
        synthesizedAt: Date.now(),
      };
    }
    const report = this.buildFinalInvestigationReport(state);
    return {
      summary: report.conclusion,
      report,
      taskIds: reports.map((item) => item.taskId),
      synthesizedAt: Date.now(),
    };
  }

  private resolveTaskBaseCommit(state: FactoryState, task: FactoryTaskRecord): string {
    if (task.candidateId) {
      const candidate = state.candidates[task.candidateId];
      if (candidate?.headCommit) return candidate.headCommit;
    }
    return state.integration.headCommit ?? task.baseCommit ?? state.baseHash;
  }

  private async ensureTaskRuntime(
    state: FactoryState,
    task: FactoryTaskRecord,
    workspaceId: string,
    pinnedBaseHash?: string,
    opts?: { readonly resetIfBaseMismatch?: boolean },
  ): Promise<{ readonly path: string; readonly branchName: string; readonly baseHash: string }> {
    if (this.taskExecutionMode(state, task) === "isolated") {
      return this.ensureIsolatedTaskRuntime(state, task, workspaceId, pinnedBaseHash);
    }
    return this.ensureTaskWorkspace(state, task, workspaceId, pinnedBaseHash, opts);
  }

  private async ensureTaskWorkspace(
    state: FactoryState,
    task: FactoryTaskRecord,
    workspaceId: string,
    pinnedBaseHash?: string,
    opts?: { readonly resetIfBaseMismatch?: boolean },
  ): Promise<{ readonly path: string; readonly branchName: string; readonly baseHash: string }> {
    const baseHash = pinnedBaseHash ?? this.resolveTaskBaseCommit(state, task);
    const workerType = this.normalizeProfileWorkerType(this.objectiveProfileForState(state), String(task.workerType));
    const workspacePath = path.join(this.git.worktreesDir, workspaceId);
    const branchName = `hub/${workerType}/${workspaceId}`;
    const existing = await this.git.worktreeStatus(workspacePath);
    if (existing.exists) {
      if (opts?.resetIfBaseMismatch && existing.head && existing.head !== baseHash) {
        const reset = await this.git.resetWorkspace(workspacePath, baseHash);
        return {
          path: workspacePath,
          branchName: reset.branch ?? existing.branch ?? branchName,
          baseHash: reset.head ?? baseHash,
        };
      }
      return {
        path: workspacePath,
        branchName: existing.branch ?? branchName,
        baseHash: existing.head ?? baseHash,
      };
    }
    const created = await this.git.createWorkspace({
      workspaceId,
      agentId: String(workerType),
      baseHash,
    });
    return created;
  }

  private async ensureIsolatedTaskRuntime(
    state: FactoryState,
    task: FactoryTaskRecord,
    workspaceId: string,
    pinnedBaseHash?: string,
  ): Promise<{ readonly path: string; readonly branchName: string; readonly baseHash: string }> {
    const runtimePath = this.taskRuntimeDir(workspaceId);
    const baseHash = pinnedBaseHash ?? this.resolveTaskBaseCommit(state, task);
    await fs.mkdir(runtimePath, { recursive: true });
    await this.materializeIsolatedTaskSupportFiles(runtimePath, this.workerTaskProfile(this.objectiveProfileForState(state)));
    return {
      path: runtimePath,
      branchName: `factory/isolated/${workspaceId}`,
      baseHash,
    };
  }

  private async materializeIsolatedTaskSupportFiles(
    runtimePath: string,
    profile: FactoryObjectiveProfileSnapshot,
  ): Promise<void> {
    const copyRoot = async (relativePath: string): Promise<void> => {
      const sourcePath = path.join(this.profileRoot, relativePath);
      const targetPath = path.join(runtimePath, relativePath);
      const stat = await fs.stat(sourcePath).catch(() => undefined);
      if (!stat) return;
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      if (stat.isDirectory()) {
        await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
        await fs.cp(sourcePath, targetPath, { recursive: true, force: true });
        return;
      }
      await fs.copyFile(sourcePath, targetPath);
    };

    const copiedSkillRoots = new Set<string>(["skills/factory-receipt-worker"]);
    for (const skillPath of profile.selectedSkills) {
      const trimmed = skillPath.trim();
      if (!trimmed || path.isAbsolute(trimmed)) continue;
      const normalized = trimmed.replace(/\\/g, "/");
      if (!normalized.startsWith("skills/")) continue;
      const segments = normalized.split("/").slice(0, 2);
      if (segments.length === 2) copiedSkillRoots.add(segments.join("/"));
    }

    await copyRoot("AGENTS.md");
    for (const skillRoot of copiedSkillRoots) {
      await copyRoot(skillRoot);
    }
  }

  private async taskWorkspaceStatus(
    workspacePath: string,
    executionMode: FactoryTaskExecutionMode,
  ): Promise<{ readonly exists: boolean; readonly dirty: boolean; readonly head?: string; readonly branch?: string }> {
    if (executionMode === "isolated") {
      const exists = await fs.access(workspacePath).then(() => true).catch(() => false);
      return {
        exists,
        dirty: false,
      };
    }
    return this.git.worktreeStatus(workspacePath);
  }

  private async removeTaskRuntimeWorkspace(workspacePath: string): Promise<void> {
    if (workspacePath.startsWith(this.git.worktreesDir)) {
      await this.git.removeWorkspace(workspacePath).catch(() => undefined);
      return;
    }
    await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  }

  private memoryScopesForTask(
    state: FactoryState,
    task: FactoryTaskRecord,
    candidateId: string,
    taskPrompt = task.prompt,
  ): ReadonlyArray<FactoryMemoryScopeSpec> {
    const baseQuery = `${state.title}\n${task.title}\n${taskPrompt}`;
    const scopes: FactoryMemoryScopeSpec[] = [
      {
        key: "agent",
        scope: `factory/agents/${String(task.workerType)}`,
        label: `Agent memory (${String(task.workerType)})`,
        defaultQuery: baseQuery,
      },
      {
        key: "repo",
        scope: "factory/repo/shared",
        label: "Repo shared memory",
        defaultQuery: `${state.title}\n${task.title}`,
      },
      {
        key: "objective",
        scope: `factory/objectives/${state.objectiveId}`,
        label: "Objective memory",
        defaultQuery: state.title,
      },
      {
        key: "task",
        scope: `factory/objectives/${state.objectiveId}/tasks/${task.taskId}`,
        label: "Task memory",
        defaultQuery: task.title,
      },
      {
        key: "candidate",
        scope: `factory/objectives/${state.objectiveId}/candidates/${candidateId}`,
        label: "Candidate memory",
        defaultQuery: `${candidateId}\n${task.title}`,
      },
      {
        key: "integration",
        scope: `factory/objectives/${state.objectiveId}/integration`,
        label: "Integration memory",
        defaultQuery: `${state.title}\nintegration`,
      },
    ];
    return scopes;
  }

  private buildMemoryScriptSource(configPath: string): string {
    return buildFactoryMemoryScriptSource(configPath);
  }

  private taskFilePaths(workspacePath: string, taskId: string) {
    const root = path.join(workspacePath, FACTORY_DATA_DIR);
    return {
      manifestPath: path.join(root, `${taskId}.manifest.json`),
      contextPackPath: path.join(root, `${taskId}.context-pack.json`),
      promptPath: path.join(root, `${taskId}.prompt.md`),
      resultPath: path.join(root, `${taskId}.result.json`),
      stdoutPath: path.join(root, `${taskId}.stdout.log`),
      stderrPath: path.join(root, `${taskId}.stderr.log`),
      lastMessagePath: path.join(root, `${taskId}.last-message.md`),
      skillBundlePath: path.join(root, `${taskId}.skill-bundle.json`),
      memoryScriptPath: path.join(root, `${taskId}.memory.cjs`),
      memoryConfigPath: path.join(root, `${taskId}.memory-scopes.json`),
    };
  }

  private taskPromptPath(workspacePath: string, targetPath: string): string {
    void workspacePath;
    return targetPath;
  }

  private async taskArtifactActivity(
    workspacePath: string,
    taskId: string,
  ): Promise<ReadonlyArray<FactoryArtifactActivity>> {
    const files = this.taskFilePaths(workspacePath, taskId);
    const root = path.dirname(files.manifestPath);
    const knownFiles = new Set([
      path.basename(files.manifestPath),
      path.basename(files.contextPackPath),
      path.basename(files.promptPath),
      path.basename(files.resultPath),
      path.basename(files.stdoutPath),
      path.basename(files.stderrPath),
      path.basename(files.lastMessagePath),
      path.basename(files.skillBundlePath),
      path.basename(files.memoryScriptPath),
      path.basename(files.memoryConfigPath),
      path.basename(this.taskResultSchemaPath(files.resultPath)),
    ]);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const artifacts = await Promise.all(entries
      .filter((entry) => entry.isFile())
      .filter((entry) => entry.name.startsWith(`${taskId}.`))
      .filter((entry) => !knownFiles.has(entry.name))
      .map(async (entry) => {
        const targetPath = path.join(root, entry.name);
        const stat = await fs.stat(targetPath).catch(() => undefined);
        if (!stat?.isFile()) return undefined;
        return {
          path: targetPath,
          label: entry.name,
          updatedAt: stat.mtimeMs,
          bytes: stat.size,
        } satisfies FactoryArtifactActivity;
      }));
    return artifacts
      .filter((artifact): artifact is FactoryArtifactActivity => Boolean(artifact))
      .sort((left, right) => right.updatedAt - left.updatedAt || right.bytes - left.bytes || left.label.localeCompare(right.label));
  }

  private summarizeTaskArtifactActivity(
    activity: ReadonlyArray<FactoryArtifactActivity>,
  ): string | undefined {
    if (activity.length === 0) return undefined;
    if (activity.length === 1) {
      return `Recent task artifact: ${activity[0]?.label}.`;
    }
    const listed = activity.slice(0, 2).map((artifact) => artifact.label).join(", ");
    const extra = activity.length > 2 ? ` +${activity.length - 2} more` : "";
    return `Recent task artifacts: ${listed}${extra}.`;
  }

  private integrationFilePaths(workspacePath: string, candidateId: string) {
    const root = path.join(workspacePath, FACTORY_DATA_DIR);
    return {
      resultPath: path.join(root, `${candidateId}.integration.json`),
      stdoutPath: path.join(root, `${candidateId}.integration.stdout.log`),
      stderrPath: path.join(root, `${candidateId}.integration.stderr.log`),
    };
  }

  private async writeTaskPacket(
    state: FactoryState,
    task: FactoryTaskRecord,
    candidateId: string,
    workspacePath: string,
    pinnedBaseCommit?: string,
  ): Promise<{
    readonly manifestPath: string;
    readonly contextPackPath: string;
    readonly promptPath: string;
    readonly resultPath: string;
    readonly stdoutPath: string;
    readonly stderrPath: string;
    readonly lastMessagePath: string;
    readonly memoryScriptPath: string;
    readonly memoryConfigPath: string;
    readonly repoSkillPaths: ReadonlyArray<string>;
    readonly skillBundlePaths: ReadonlyArray<string>;
    readonly sharedArtifactRefs: ReadonlyArray<GraphRef>;
    readonly contextRefs: ReadonlyArray<GraphRef>;
  }> {
    const profile = this.workerTaskProfile(this.objectiveProfileForState(state));
    const taskPrompt = this.effectiveTaskPrompt(state, task);
    const files = this.taskFilePaths(workspacePath, task.taskId);
    await fs.mkdir(path.dirname(files.manifestPath), { recursive: true });
    await fs.rm(files.resultPath, { force: true });
    const repoSkillPaths = await this.collectRepoSkillPaths();
    const memoryScopes = this.memoryScopesForTask(state, task, candidateId, taskPrompt);
    const contextPack = await this.buildTaskContextPack(state, task, candidateId, taskPrompt);
    const sharedArtifactRefs = contextPack.contextSources.sharedArtifactRefs;
    const skillBundle = {
      objectiveId: state.objectiveId,
      taskId: task.taskId,
      title: task.title,
      workerType: task.workerType,
      profile,
      selectedSkills: profile.selectedSkills,
      repoSkillPaths,
      generatedAt: Date.now(),
    };
    await fs.writeFile(files.skillBundlePath, JSON.stringify(skillBundle, null, 2), "utf-8");
    const manifest = {
      objective: {
        objectiveId: state.objectiveId,
        title: state.title,
        prompt: state.prompt,
        baseHash: state.baseHash,
        objectiveMode: state.objectiveMode,
        severity: state.severity,
        checks: state.checks,
      },
      profile,
      task: {
        taskId: task.taskId,
        title: task.title,
        prompt: taskPrompt,
        workerType: task.workerType,
        executionMode: task.executionMode ?? profile.objectivePolicy.defaultTaskExecutionMode,
        baseCommit: pinnedBaseCommit ?? this.resolveTaskBaseCommit(state, task),
        dependsOn: task.dependsOn,
      },
      candidate: state.candidates[candidateId] ?? {
        candidateId,
        taskId: task.taskId,
      },
      integration: state.integration,
      memory: {
        scriptPath: files.memoryScriptPath,
        configPath: files.memoryConfigPath,
        scopes: memoryScopes,
      },
      context: {
        packPath: files.contextPackPath,
      },
      contextSources: contextPack.contextSources,
      contextRefs: [
        ...task.contextRefs,
        ...sharedArtifactRefs,
        artifactRef(files.contextPackPath, "recursive context pack"),
      ],
      sharedArtifactRefs,
      repoSkillPaths,
      skillBundlePaths: [files.skillBundlePath],
      traceRefs: [
        stateRef(objectiveStream(state.objectiveId), "factory objective stream"),
        ...task.dependsOn.map((depId) => stateRef(`${objectiveStream(state.objectiveId)}:task/${depId}`, depId)),
      ],
    };
    const memoryConfig = {
      objectiveId: state.objectiveId,
      taskId: task.taskId,
      candidateId,
      contextPackPath: path.basename(files.contextPackPath),
      defaultQuery: `${state.title}\n${task.title}\n${taskPrompt}`,
      defaultLimit: 6,
      defaultMaxChars: 2400,
      scopes: memoryScopes,
    };
    await fs.writeFile(files.contextPackPath, JSON.stringify(contextPack, null, 2), "utf-8");
    await fs.writeFile(files.manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    await fs.writeFile(files.memoryConfigPath, JSON.stringify(memoryConfig, null, 2), "utf-8");
    await fs.writeFile(files.memoryScriptPath, this.buildMemoryScriptSource(files.memoryConfigPath), "utf-8");
    if (process.platform !== "win32") await fs.chmod(files.memoryScriptPath, 0o755);
    return {
      manifestPath: files.manifestPath,
      contextPackPath: files.contextPackPath,
      promptPath: files.promptPath,
      resultPath: files.resultPath,
      stdoutPath: files.stdoutPath,
      stderrPath: files.stderrPath,
      lastMessagePath: files.lastMessagePath,
      memoryScriptPath: files.memoryScriptPath,
      memoryConfigPath: files.memoryConfigPath,
      repoSkillPaths,
      skillBundlePaths: [files.skillBundlePath],
      sharedArtifactRefs,
      contextRefs: [
        ...task.contextRefs,
        ...sharedArtifactRefs,
        artifactRef(files.contextPackPath, "recursive context pack"),
      ],
    };
  }

  async prepareDirectCodexProbePacket(input: {
    readonly jobId: string;
    readonly prompt: string;
    readonly profileId?: string;
    readonly objectiveId?: string;
    readonly parentRunId?: string;
    readonly parentStream?: string;
    readonly stream?: string;
    readonly supervisorSessionId?: string;
    readonly readOnly?: boolean;
  }): Promise<{
    readonly artifactPaths: FactoryChatCodexArtifactPaths;
    readonly renderedPrompt: string;
    readonly readOnly: boolean;
    readonly env: NodeJS.ProcessEnv;
  }> {
    const readOnly = input.readOnly !== false;
    const artifactPaths = factoryChatCodexArtifactPaths(this.dataDir, input.jobId);
    await fs.mkdir(artifactPaths.root, { recursive: true });
    await fs.rm(artifactPaths.resultPath, { force: true });
    const profile = await this.resolveObjectiveProfileSnapshot(input.profileId).catch((): FactoryObjectiveProfileSnapshot => ({
      rootProfileId: input.profileId ?? "default",
      rootProfileLabel: input.profileId ?? "default",
      resolvedProfileHash: "",
      promptHash: "",
      promptPath: "",
      selectedSkills: [],
      cloudProvider: undefined,
      objectivePolicy: DEFAULT_FACTORY_OBJECTIVE_PROFILE.objectivePolicy,
    }));
    const includeFactoryObjectiveSkills = Boolean(input.objectiveId);
    const [cloudExecutionContext, allRepoSkillPaths] = await Promise.all([
      this.loadObjectiveCloudExecutionContext(profile),
      this.collectRepoSkillPaths(),
    ]);
    const repoSkillPaths = allRepoSkillPaths.filter((skillPath) =>
      includeFactoryObjectiveSkills
      || (!skillPath.includes("/skills/factory-receipt-worker/")
        && !skillPath.includes("/skills/factory-run-orchestrator/"))
    );
    const repoKey = repoKeyForRoot(this.git.repoRoot);
    const repoScope = `repos/${repoKey}`;
    const profileScope = `${repoScope}/profiles/${profile.rootProfileId}`;
    const objectiveScope = input.objectiveId ? `${profileScope}/objectives/${input.objectiveId}` : undefined;
    const workerScope = `${repoScope}/subagents/codex`;

    const memoryScopes = [
      {
        key: "repo",
        scope: repoScope,
        label: "Repo memory",
        defaultQuery: input.prompt,
      },
      {
        key: "profile",
        scope: profileScope,
        label: `Profile memory (${profile.rootProfileLabel})`,
        defaultQuery: input.prompt,
      },
      ...(objectiveScope ? [{
        key: "objective",
        scope: objectiveScope,
        label: "Objective memory",
        defaultQuery: input.prompt,
      }, {
        key: "integration",
        scope: `factory/objectives/${input.objectiveId}/integration`,
        label: "Integration memory",
        defaultQuery: input.prompt,
      }] : []),
      {
        key: "worker",
        scope: workerScope,
        label: "Codex worker memory",
        defaultQuery: input.prompt,
      },
    ] satisfies ReadonlyArray<FactoryMemoryScopeSpec>;

    const [
      repoMemory,
      profileMemory,
      workerMemory,
      objectiveDetail,
      objectiveDebug,
      objectiveReceipts,
      objectiveMemory,
      integrationMemory,
    ] = await Promise.all([
      this.summarizeScope(repoScope, input.prompt, 360),
      this.summarizeScope(profileScope, input.prompt, 360),
      this.summarizeScope(workerScope, input.prompt, 280),
      input.objectiveId ? this.getObjective(input.objectiveId) : Promise.resolve(undefined),
      input.objectiveId ? this.getObjectiveDebug(input.objectiveId) : Promise.resolve(undefined),
      input.objectiveId ? this.listObjectiveReceipts(input.objectiveId, { limit: 20 }) : Promise.resolve([]),
      objectiveScope ? this.summarizeScope(objectiveScope, input.prompt, 360) : Promise.resolve(undefined),
      input.objectiveId ? this.summarizeScope(`factory/objectives/${input.objectiveId}/integration`, input.prompt, 360) : Promise.resolve(undefined),
    ]);
    const helperCatalog = await loadFactoryHelperContext({
      profileRoot: this.profileRoot,
      provider: profile.cloudProvider ?? cloudExecutionContext.preferredProvider,
      objectiveTitle: objectiveDetail?.title,
      objectivePrompt: input.prompt,
      taskTitle: objectiveDetail?.title ? `Direct probe for ${objectiveDetail.title}` : "Direct Codex Probe",
      taskPrompt: input.prompt,
      domain: "infrastructure",
    });
    const helperRefs = helperCatalogArtifactRefs(helperCatalog).map((ref) => artifactRef(ref.ref, ref.label));

    const frontierTasks = (objectiveDetail?.tasks ?? [])
      .filter((task) => ["ready", "running", "reviewing", "blocked"].includes(task.status))
      .slice(0, 10)
      .map((task) => ({
        taskId: task.taskId,
        taskKind: task.taskKind,
        title: task.title,
        status: task.status,
        workerType: task.workerType,
        sourceTaskId: task.sourceTaskId,
        relations: ["focus"] as const,
        latestSummary: task.latestSummary,
        blockedReason: task.blockedReason,
        candidateId: task.candidateId,
        candidateStatus: task.candidate?.status,
      }));
    const recentCompletedTasks = (objectiveDetail?.tasks ?? [])
      .filter((task) => ["approved", "integrated", "blocked", "superseded"].includes(task.status))
      .slice(0, 8)
      .map((task) => ({
        taskId: task.taskId,
        taskKind: task.taskKind,
        title: task.title,
        status: task.status,
        workerType: task.workerType,
        sourceTaskId: task.sourceTaskId,
        relations: ["focus"] as const,
        latestSummary: task.latestSummary,
        blockedReason: task.blockedReason,
        candidateId: task.candidateId,
        candidateStatus: task.candidate?.status,
      }));
    const integrationTaskIds = new Set<string>();
    if (objectiveDetail?.integration.activeCandidateId) {
      const activeTask = objectiveDetail.tasks.find((task) => task.candidateId === objectiveDetail.integration.activeCandidateId);
      if (activeTask) integrationTaskIds.add(activeTask.taskId);
    }
    for (const candidateId of objectiveDetail?.integration.queuedCandidateIds ?? []) {
      const queuedTask = objectiveDetail?.tasks.find((task) => task.candidateId === candidateId);
      if (queuedTask) integrationTaskIds.add(queuedTask.taskId);
    }
    const integrationTasks = (objectiveDetail?.tasks ?? [])
      .filter((task) => integrationTaskIds.has(task.taskId))
      .slice(0, 8)
      .map((task) => ({
        taskId: task.taskId,
        taskKind: task.taskKind,
        title: task.title,
        status: task.status,
        workerType: task.workerType,
        sourceTaskId: task.sourceTaskId,
        relations: ["focus"] as const,
        latestSummary: task.latestSummary,
        blockedReason: task.blockedReason,
        candidateId: task.candidateId,
        candidateStatus: task.candidate?.status,
      }));

    const contextPack = {
      ...(input.objectiveId ? { objectiveId: input.objectiveId } : {}),
      probeId: input.jobId,
      title: objectiveDetail?.title ?? "Direct Codex Probe",
      prompt: input.prompt,
      mode: input.objectiveId
        ? (readOnly ? "read_only_direct_codex_probe" : "direct_codex")
        : (readOnly ? "read_only_repo_probe" : "direct_repo_probe"),
      cloudExecutionContext,
      profile,
      task: {
        taskId: `direct_codex_${input.jobId}`,
        title: objectiveDetail?.title ? `Direct probe for ${objectiveDetail.title}` : "Direct Codex Probe",
        prompt: input.prompt,
        workerType: "codex",
        status: "running",
        candidateId: input.jobId,
      },
      ...(objectiveDetail ? {
        integration: objectiveDetail.integration,
      } : {}),
      dependencyTree: [],
      relatedTasks: frontierTasks,
      candidateLineage: [],
      recentReceipts: objectiveReceipts.slice(-12).map((receipt) => ({
        type: receipt.type,
        at: receipt.ts,
        taskId: receipt.taskId,
        candidateId: receipt.candidateId,
        summary: receipt.summary,
      })),
      ...(objectiveDetail ? {
        objectiveSlice: {
          frontierTasks,
          recentCompletedTasks,
          integrationTasks,
          recentObjectiveReceipts: objectiveReceipts.map((receipt) => ({
            type: receipt.type,
            at: receipt.ts,
            taskId: receipt.taskId,
            candidateId: receipt.candidateId,
            summary: receipt.summary,
          })),
          objectiveMemorySummary: objectiveMemory,
          integrationMemorySummary: integrationMemory,
        },
      } : {}),
      memory: {
        overview: [repoMemory, profileMemory, objectiveMemory, workerMemory].filter(Boolean).join("\n\n") || undefined,
        objective: objectiveMemory,
        integration: integrationMemory,
      },
      contextSources: {
        repoSharedMemoryScope: repoScope,
        objectiveMemoryScope: objectiveScope ?? profileScope,
        integrationMemoryScope: input.objectiveId ? `factory/objectives/${input.objectiveId}/integration` : workerScope,
        profileSkillRefs: profile.selectedSkills,
        repoSkillPaths,
        sharedArtifactRefs: helperRefs,
      },
      helperCatalog,
      latestDecision: objectiveDetail?.latestDecision,
      blockedExplanation: objectiveDetail?.blockedExplanation,
      evidenceCards: objectiveDetail?.evidenceCards.slice(-8) ?? [],
      activeJobs: objectiveDebug?.activeJobs.slice(0, 8) ?? [],
      latestContextPacks: objectiveDebug?.latestContextPacks ?? [],
      session: {
        jobId: input.jobId,
        parentRunId: input.parentRunId,
        parentStream: input.parentStream,
        stream: input.stream,
        supervisorSessionId: input.supervisorSessionId,
      },
    };

    const memoryConfig = {
      objectiveId: input.objectiveId,
      taskId: `direct_codex_${input.jobId}`,
      candidateId: input.jobId,
      contextPackPath: artifactPaths.contextPackPath,
      defaultQuery: input.prompt,
      defaultLimit: 6,
      defaultMaxChars: 2400,
      scopes: memoryScopes,
    };
    const manifest = {
      kind: "factory.codex.probe",
      mode: readOnly ? "read_only" : "workspace_write",
      run: {
        jobId: input.jobId,
        parentRunId: input.parentRunId,
        parentStream: input.parentStream,
        stream: input.stream,
        supervisorSessionId: input.supervisorSessionId,
      },
      objective: objectiveDetail ? {
        objectiveId: objectiveDetail.objectiveId,
        title: objectiveDetail.title,
        status: objectiveDetail.status,
        phase: objectiveDetail.phase,
        latestSummary: objectiveDetail.latestSummary,
        nextAction: objectiveDetail.nextAction,
        latestDecision: objectiveDetail.latestDecision,
        blockedExplanation: objectiveDetail.blockedExplanation,
      } : undefined,
      profile,
      memory: {
        scriptPath: artifactPaths.memoryScriptPath,
        configPath: artifactPaths.memoryConfigPath,
        scopes: memoryScopes,
      },
      context: {
        packPath: artifactPaths.contextPackPath,
      },
      repoSkillPaths,
      sharedArtifactRefs: helperRefs,
      traceRefs: [
        ...(input.objectiveId ? [stateRef(objectiveStream(input.objectiveId), "factory objective stream")] : []),
        ...(input.parentStream ? [stateRef(input.parentStream, "parent Factory run stream")] : []),
      ],
      contract: {
        readOnly,
        summary: readOnly
          ? "This Codex probe is read-only. Use it for inspection, receipts, and diagnosis. Code changes must go through a Factory objective."
          : "This Codex run may edit the workspace.",
        objectiveBacked: Boolean(input.objectiveId),
      },
    };

    await fs.writeFile(artifactPaths.contextPackPath, JSON.stringify(contextPack, null, 2), "utf-8");
    await fs.writeFile(artifactPaths.manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    await fs.writeFile(artifactPaths.memoryConfigPath, JSON.stringify(memoryConfig, null, 2), "utf-8");
    await fs.writeFile(artifactPaths.memoryScriptPath, buildFactoryMemoryScriptSource(artifactPaths.memoryConfigPath), "utf-8");
    if (process.platform !== "win32") await fs.chmod(artifactPaths.memoryScriptPath, 0o755);

    const workspaceCommandEnv = await this.ensureWorkspaceCommandEnv(this.git.repoRoot);
    const renderedPrompt = this.renderDirectCodexProbePrompt({
      prompt: input.prompt,
      readOnly,
      artifactPaths,
      manifest,
      objective: objectiveDetail ? {
        objectiveId: objectiveDetail.objectiveId,
        title: objectiveDetail.title,
        status: objectiveDetail.status,
        phase: objectiveDetail.phase,
        latestDecision: objectiveDetail.latestDecision,
        blockedExplanation: objectiveDetail.blockedExplanation,
      } : undefined,
      cloudExecutionContext,
      helperCatalog,
      repoSkillPaths,
      recentReceipts: objectiveReceipts.slice(-10),
    });

    return {
      artifactPaths,
      renderedPrompt,
      readOnly,
      env: {
        DATA_DIR: this.dataDir,
        RECEIPT_DATA_DIR: this.dataDir,
        PATH: workspaceCommandEnv.path,
      },
    };
  }

  private async renderTaskPrompt(
    state: FactoryState,
    task: FactoryTaskRecord,
    payload: FactoryTaskJobPayload,
  ): Promise<string> {
    const cloudExecutionContext = await this.loadObjectiveCloudExecutionContext(payload.profile);
    const taskPrompt = this.effectiveTaskPrompt(state, task);
    const helperCatalog = await loadFactoryHelperContext({
      profileRoot: this.profileRoot,
      provider: payload.profile.cloudProvider ?? cloudExecutionContext.preferredProvider,
      objectiveTitle: state.title,
      objectivePrompt: state.prompt,
      taskTitle: task.title,
      taskPrompt,
      domain: "infrastructure",
    });
    const infrastructureTaskGuidance = renderInfrastructureTaskExecutionGuidance({
      profileCloudProvider: payload.profile.cloudProvider,
      objectiveMode: state.objectiveMode,
      cloudExecutionContext,
    });
    const dependencySummaries = task.dependsOn
      .map((depId) => state.workflow.tasksById[depId])
      .filter((dep): dep is FactoryTaskRecord => Boolean(dep))
      .map((dep) => `- ${dep.taskId}: ${dep.latestSummary ?? dep.title}`)
      .join("\n") || "- none";
    const downstreamSummaries = state.workflow.taskIds
      .map((taskId) => state.workflow.tasksById[taskId])
      .filter((candidate): candidate is FactoryTaskRecord => Boolean(candidate) && candidate.dependsOn.includes(task.taskId))
      .map((candidate) => `- ${candidate.taskId}: ${candidate.title}`)
      .join("\n") || "- none";
    const memorySummary = await this.loadMemorySummary(`factory/objectives/${state.objectiveId}/tasks/${task.taskId}`, taskPrompt);
    const validationSection = this.renderTaskValidationSection(state, task);
    const planningReceipt = state.planning ?? this.buildPlanningReceipt(state, state.updatedAt || Date.now());
    const manifestPathForPrompt = this.taskPromptPath(payload.workspacePath, payload.manifestPath);
    const contextPackPathForPrompt = this.taskPromptPath(payload.workspacePath, payload.contextPackPath);
    const memoryScriptPathForPrompt = this.taskPromptPath(payload.workspacePath, payload.memoryScriptPath);
    const resultPathForPrompt = payload.resultPath;
    return [
      `# Factory Task`,
      ``,
      `Objective: ${state.title}`,
      `Objective ID: ${state.objectiveId}`,
      `Objective Mode: ${state.objectiveMode}`,
      `Severity: ${state.severity}`,
      `Task ID: ${task.taskId}`,
      `Worker Type: ${task.workerType}`,
      `Task Runtime: ${payload.executionMode}`,
      `Profile: ${payload.profile.rootProfileLabel} (${payload.profile.rootProfileId})`,
      `Profile Cloud Provider: ${payload.profile.cloudProvider ?? "unspecified"}`,
      `Base Commit: ${payload.baseCommit}`,
      `Candidate ID: ${payload.candidateId}`,
      ``,
      `## Objective Prompt`,
      state.prompt,
      ``,
      `## Task Prompt`,
      taskPrompt,
      ``,
      ...renderPlanningReceiptLines(planningReceipt),
      ``,
      `## Dependencies`,
      dependencySummaries,
      ``,
      `## Task Boundary`,
      `Complete only ${task.taskId}. Do not absorb downstream work that already belongs to other planned tasks unless a tiny unblock is strictly required.`,
      `Downstream tasks already queued in this objective:`,
      downstreamSummaries,
      `If you notice adjacent copy, validation, or follow-up work outside this task's scope, mention it in the handoff instead of implementing it here.`,
      ``,
      `## Investigation Contract`,
      state.objectiveMode === "investigation"
        ? `This objective is investigation-first. Plan before you run commands. If the task prompt is broad, first narrow it to one concrete investigation question, one primary evidence path, and one stop condition. Use checked-in helpers first instead of writing a task-local script.`
        : `This objective is delivery-oriented. Prefer tracked repo changes and keep investigation folded into the implementation task.`,
      state.objectiveMode === "investigation"
        ? `A tracked diff is optional when an existing helper answers the task. If no checked-in helper matches and the missing behavior is clear, create or extend a checked-in helper in the repo, run it, and keep the helper in the task diff. Only stop when the helper contract is too ambiguous or repo edits are explicitly out of scope.`
        : `A non-validation task is expected to leave a tracked repo diff unless you are hard blocked.`,
      state.objectiveMode === "investigation"
        ? `Interpret command and script outputs in plain language. Do not just paste logs.`
        : `Capture implementation and validation results precisely in the handoff.`,
      state.objectiveMode === "investigation"
        ? `Do not convert a failed query, denied API, or helper error into "zero results". If a primary evidence path errors or stays incomplete, record that command as warning/error and use outcome "partial" or "blocked" instead of "approved".`
        : `If validation or evidence collection fails, report the failure directly instead of inferring success from missing output.`,
      `Make a short internal plan before the first tool: name the concrete question, the primary evidence path, the stop condition, and the one follow-up check that would change your answer.`,
      `Runtime compatibility: emit at most one tool call in each response, then wait for that tool result before issuing the next call. If you need several nearby packet or repo reads, combine them into one shell command instead of batching separate tool calls.`,
      `Use Codex subagents only for bounded sidecar work such as parsing a captured artifact, checking one secondary evidence path, or verifying a concrete claim.`,
      `Keep this task session as the single owner of the final JSON result. Any delegated ask must restate the objective ID, task ID, candidate ID, and exact artifact or question it owns.`,
      `Do not fan out broad parallel exploration when one primary evidence path is already producing enough signal to finish the task.`,
      cloudExecutionContext.preferredProvider
        ? `Local execution context already indicates ${cloudExecutionContext.preferredProvider}. Use that provider and its mounted scope by default unless the objective explicitly contradicts it.`
        : `If the local execution context clearly indicates one provider/profile/account, use it instead of asking the user to restate it.`,
      `If the helper catalog misses the required behavior and this run may edit the repo, use the mounted helper authoring skill to add or extend a checked-in helper instead of stopping at a no-helper report.`,
      `Do not emit commentary-style progress updates in this child session. Prefer the checked-in helper catalog when repeated CLI steps or evidence collection would otherwise be lossy.`,
      `Never print or persist raw secret, token, password, API key, or credential values in stdout, stderr, artifacts, or the final JSON. Report presence, source, and impact, but redact the value itself.`,
      ``,
      ...(infrastructureTaskGuidance.length > 0 ? [...infrastructureTaskGuidance, ``] : []),
      ...renderFactoryHelperPromptSection(helperCatalog),
      `## Live Cloud Context`,
      cloudExecutionContext.summary,
      ...cloudExecutionContext.guidance.map((item) => `- ${item}`),
      ``,
      ...validationSection,
      ``,
      `## Bootstrap Context`,
      `The prompt is bootstrap only. Prefer the packet files and memory script over broad repo exploration.`,
      `Read, in order:`,
      `1. AGENTS.md and skills/factory-receipt-worker/SKILL.md`,
      `2. Manifest: ${manifestPathForPrompt}`,
      `3. Context Pack: ${contextPackPathForPrompt}`,
      `4. Memory Script: ${memoryScriptPathForPrompt}`,
      `5. Repo skills from the manifest, especially any execution or permissions landscape notes`,
      `Mounted profile skills for this task:`,
      payload.profile.selectedSkills.map((skillPath) => `- ${skillPath}`).join("\n") || "- none",
      `Use only the checked-in repo skills named in this packet. Do not load unrelated global skills from ~/.codex or other home-directory skill folders unless this packet explicitly names them.`,
      `Read any mounted infrastructure or cloud profile skill before provider-sensitive commands.`,
      payload.executionMode === "worktree"
        ? `Do not call \`${FACTORY_CLI_PREFIX} factory inspect\` from inside this task worktree. The packet already mounts recent objective receipts and state, and worktree-side inspect can fail on receipt lock files outside the workspace.`
        : `This task runs in an isolated runtime directory, not a git worktree. Treat repo edits as out of scope unless the controller explicitly reroutes the task into a repo-writing profile.`,
      payload.executionMode === "worktree"
        ? `If the packet and memory script are still insufficient, say which evidence is missing in the handoff instead of probing live objective state from the task worktree.`
        : `If the packet and memory script are still insufficient, say which evidence is missing in the handoff instead of probing live objective state from the isolated runtime.`,
      ``,
      `## Memory Access`,
      `Use the layered memory script at ${memoryScriptPathForPrompt} instead of raw memory dumps.`,
      `Recommended commands:`,
      `- bun ${memoryScriptPathForPrompt} context 2800`,
      `- bun ${memoryScriptPathForPrompt} objective 1800`,
      `- bun ${memoryScriptPathForPrompt} scope task "${task.title}" 1400`,
      `- bun ${memoryScriptPathForPrompt} search repo "${task.title}" 6`,
      `Only write a durable memory note after gathering evidence from the packet, receipts, or repo files.`,
      ``,
      `## Result Contract`,
      `Return exactly one JSON object matching this schema:`,
      `Write JSON to ${resultPathForPrompt} with:`,
      state.objectiveMode === "investigation"
        ? `{ "outcome": "approved" | "changes_requested" | "blocked" | "partial", "summary": string, "artifacts": [{ "label": string, "path": string | null, "summary": string | null }], "completion": { "changed": string[], "proof": string[], "remaining": string[] }, "nextAction": string | null, "report": { "conclusion": string, "evidence": [{ "title": string, "summary": string, "detail": string | null }], "scriptsRun": [{ "command": string, "summary": string | null, "status": "ok" | "warning" | "error" | null }], "disagreements": string[], "nextSteps": string[] } | null }`
        : `{ "outcome": "approved" | "changes_requested" | "blocked" | "partial", "summary": string, "artifacts": [{ "label": string, "path": string | null, "summary": string | null }], "scriptsRun": [{ "command": string, "summary": string | null, "status": "ok" | "warning" | "error" | null }], "completion": { "changed": string[], "proof": string[], "remaining": string[] }, "nextAction": string | null }`,
      `Do not write this file yourself.`,
      `Do not write ${resultPathForPrompt} yourself. Return exactly that JSON object as your final response and the runtime will persist it there.`,
      `If you want to keep a richer markdown or JSON report, write it as a task artifact and reference it from artifacts. The final response itself must stay strict JSON.`,
      `Use "changes_requested" only when more work is clearly needed; use "blocked" only for a hard blocker; use "partial" when you produced meaningful evidence but could not fully finish.`,
      `Before you return final JSON, sanity-check that report.scriptsRun statuses match the actual command outcomes and that any artifact-level errors are reflected in outcome, summary, or next steps.`,
      state.objectiveMode === "investigation"
        ? `For investigation tasks, always include the report key. Use a report object whenever you gathered meaningful evidence; otherwise use null. Always include completion with changed, proof, and remaining arrays. Use [] for empty lists and null for detail, summary, status, nextAction, or report when they do not apply.`
        : `For delivery tasks, keep the envelope small. Always include scriptsRun and completion. Use [] when no command or small script materially informed the result, and use [] in completion.remaining when nothing is left.`,
      ``,
      `## Starting Hint`,
      memorySummary || "No durable task memory yet.",
    ].join("\n");
  }

  private effectiveTaskPrompt(
    state: FactoryState,
    task: Pick<FactoryTaskRecord, "prompt">,
  ): string {
    return rewriteInfrastructureTaskPromptForExecution({
      profileCloudProvider: this.objectiveProfileForState(state).cloudProvider,
      objectiveMode: state.objectiveMode,
      taskPrompt: task.prompt,
    });
  }

  private renderTaskValidationSection(state: FactoryState, task: FactoryTaskRecord): string[] {
    if (state.objectiveMode === "investigation" && !this.taskOwnsBroadValidation(task)) {
      return [
        `## Validation Guidance`,
        `This is a CLI investigation task. Do not run the broad repo validation suite unless you changed repo files or this task explicitly owns validation.`,
        `Helper evidence files written under .receipt/ do not count as repo changes for this purpose and should not trigger bun run build, bun run verify, or the full repo suite.`,
        ...(state.checks.length > 0
          ? [
              `Reserved full-suite commands if later evidence requires them:`,
              state.checks.map((check) => `- ${check}`).join("\n"),
            ]
          : []),
      ];
    }
    if (!this.shouldDeferBroadValidation(state, task)) {
      return [
        `## Checks`,
        state.checks.map((check) => `- ${check}`).join("\n") || "- none",
        `Run the relevant repo validation for this task and capture failures precisely in the handoff.`,
      ];
    }
    return [
      `## Validation Guidance`,
      `A later task in this objective owns the broad repo validation suite.`,
      `Do not run the full repo checks here unless this task is itself the validation pass or a tiny targeted check is strictly needed to de-risk the change.`,
      ...(state.checks.length > 0
        ? [
            `Reserved full-suite commands for later:`,
            state.checks.map((check) => `- ${check}`).join("\n"),
          ]
        : []),
    ];
  }

  private shouldDeferBroadValidation(state: FactoryState, task: FactoryTaskRecord): boolean {
    if (this.taskOwnsBroadValidation(task)) return false;
    const taskIndex = state.workflow.taskIds.indexOf(task.taskId);
    const laterTaskIds = taskIndex >= 0 ? state.workflow.taskIds.slice(taskIndex + 1) : [];
    return laterTaskIds
      .map((taskId) => state.workflow.tasksById[taskId])
      .some((candidate) => Boolean(candidate) && this.taskOwnsBroadValidation(candidate));
  }

  private taskOwnsBroadValidation(task: Pick<FactoryTaskRecord, "title" | "prompt">): boolean {
    const haystack = `${task.title}\n${task.prompt}`.toLowerCase();
    return haystack.includes("validation suite")
      || haystack.includes("run validation")
      || haystack.includes("lint")
      || haystack.includes("typecheck")
      || haystack.includes("build");
  }

  private renderDirectCodexProbePrompt(input: {
    readonly prompt: string;
    readonly readOnly: boolean;
    readonly artifactPaths: FactoryChatCodexArtifactPaths;
    readonly manifest: Record<string, unknown>;
    readonly objective?: {
      readonly objectiveId: string;
      readonly title: string;
      readonly status: FactoryObjectiveStatus;
      readonly phase: FactoryObjectivePhase;
      readonly latestDecision?: FactoryObjectiveCard["latestDecision"];
      readonly blockedExplanation?: FactoryObjectiveCard["blockedExplanation"];
    };
    readonly cloudExecutionContext: FactoryCloudExecutionContext;
    readonly helperCatalog?: FactoryHelperContext;
    readonly repoSkillPaths: ReadonlyArray<string>;
    readonly recentReceipts: ReadonlyArray<FactoryObjectiveReceiptSummary>;
  }): string {
    const objectiveStreamRef = input.objective ? objectiveStream(input.objective.objectiveId) : undefined;
    const profileSkills = isRecord(input.manifest.profile) && Array.isArray(input.manifest.profile.selectedSkills)
      ? input.manifest.profile.selectedSkills.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    return [
      `# Factory Direct Codex Probe`,
      ``,
      `Mode: ${input.readOnly ? "read-only probe" : "workspace-write"}`,
      `Workspace: ${this.git.repoRoot}`,
      ``,
      `## Operator Request`,
      input.prompt,
      ``,
      `## Probe Tactics`,
      `Start with a short internal plan. If the operator named a file, artifact, receipt, helper, or run, inspect that exact target before broader repo search or memory expansion.`,
      `If you use subagents, keep them as bounded sidecars and restate the probe context plus the exact artifact or question they own.`,
      `Do not parallelize broad repo exploration when one named artifact or one primary evidence path can answer the request.`,
      ``,
      `## Read-Only Contract`,
      input.readOnly
        ? `This Codex run is read-only. Inspect receipts, memory, files, and logs, but do not modify tracked files or generate patches. If code changes are required, explain the change and say that Factory must create or react an objective/worktree run.`
        : `This Codex run may edit the workspace.`,
      ``,
      `## Live Cloud Context`,
      input.cloudExecutionContext.summary,
      ...input.cloudExecutionContext.guidance.map((item) => `- ${item}`),
      ``,
      ...renderFactoryHelperPromptSection(input.helperCatalog),
      `## Bootstrap Context`,
      input.objective
        ? `Treat the prompt as bootstrap only. Read AGENTS.md and skills/factory-receipt-worker/SKILL.md before making claims about what context is available.`
        : `Treat the prompt as bootstrap only. Use the packet files, repo files, and memory script first. This direct probe is not a Factory task worktree and does not require Factory worker bootstrap commands.`,
      `Current packet files:`,
      `- Manifest: ${input.artifactPaths.manifestPath}`,
      `- Context Pack: ${input.artifactPaths.contextPackPath}`,
      `- Memory Script: ${input.artifactPaths.memoryScriptPath}`,
      `- Memory Config: ${input.artifactPaths.memoryConfigPath}`,
      `- Result Path: ${input.artifactPaths.resultPath}`,
      `- Prompt Path: ${input.artifactPaths.promptPath}`,
      ``,
      `## Objective-First Query Order`,
      `1. Packet files in this artifact directory`,
      input.objective ? `2. Current objective receipts and debug panels for ${input.objective.objectiveId}` : `2. Repo files/search in the current checkout`,
      `3. Scoped memory through the generated memory script`,
      `4. Broader history only if the packet or current objective explicitly points to it`,
      ``,
      input.objective ? `## Current Objective` : `## Current Context`,
      input.objective
        ? [
            `- Objective: ${input.objective.title} (${input.objective.objectiveId})`,
            `- Status: ${input.objective.status}`,
            `- Phase: ${input.objective.phase}`,
            input.objective.latestDecision ? `- Latest decision: ${input.objective.latestDecision.summary}` : "",
            input.objective.blockedExplanation ? `- Blocked explanation: ${input.objective.blockedExplanation.summary}` : "",
            `- If the packet and memory script are still insufficient, inspect the objective sequentially (not in parallel):`,
            `- ${FACTORY_CLI_PREFIX} factory inspect ${shellQuote(input.objective.objectiveId)} --json --panel receipts`,
            `- ${FACTORY_CLI_PREFIX} factory inspect ${shellQuote(input.objective.objectiveId)} --json --panel debug`,
            objectiveStreamRef ? `- ${FACTORY_CLI_PREFIX} inspect ${shellQuote(objectiveStreamRef)}` : "",
            objectiveStreamRef ? `- ${FACTORY_CLI_PREFIX} trace ${shellQuote(objectiveStreamRef)}` : "",
          ].filter(Boolean).join("\n")
        : [
            `- Use the packet, repo files, and memory first. This probe is not a Factory objective and should not call the objective inspect commands.`,
            `- Do not assume skills/factory-receipt-worker/SKILL.md applies unless a real objectiveId is present.`,
            `- Use current repo search/read results before escalating to broader receipt history.`,
          ].join("\n"),
      ``,
      `## Memory Access`,
      `Use the layered memory script at ${input.artifactPaths.memoryScriptPath} instead of pulling large raw memory dumps.`,
      `Recommended commands:`,
      `- bun ${input.artifactPaths.memoryScriptPath} context 2800`,
      `- bun ${input.artifactPaths.memoryScriptPath} objective 1800`,
      `- bun ${input.artifactPaths.memoryScriptPath} overview ${JSON.stringify(input.prompt)} 2400`,
      `- bun ${input.artifactPaths.memoryScriptPath} scope repo ${JSON.stringify(input.prompt)} 1400`,
      `- bun ${input.artifactPaths.memoryScriptPath} scope profile ${JSON.stringify(input.prompt)} 1400`,
      `- bun ${input.artifactPaths.memoryScriptPath} search repo ${JSON.stringify(input.prompt)} 6`,
      ...(input.readOnly ? [] : [`- bun ${input.artifactPaths.memoryScriptPath} commit worker "short durable note"`]),
      ``,
      `## Repo Skills`,
      `Profile-selected skills:`,
      profileSkills.map((skill) => `- ${skill}`).join("\n") || "- none",
      `Repo skill artifacts:`,
      input.repoSkillPaths.map((skill) => `- ${skill}`).join("\n") || "- none",
      `If a repo skill covers execution landscape, permissions, or infrastructure guardrails, read it before issuing AWS, IaC, or fleet-wide commands.`,
      ``,
      `## Recent Receipt Evidence`,
      input.recentReceipts.map((receipt) => `- ${receipt.type}: ${receipt.summary}`).join("\n") || "- none",
      ``,
      `## Delivery Boundary`,
      `Use this probe to inspect, summarize, and recommend. If implementation work is needed, say so explicitly and point the parent back to factory.dispatch.`,
    ].join("\n");
  }

  private parseTaskPayload(payload: Record<string, unknown>): FactoryTaskJobPayload {
    if (payload.kind !== "factory.task.run") throw new FactoryServiceError(400, "invalid factory task payload");
    return {
      kind: "factory.task.run",
      objectiveId: requireNonEmpty(payload.objectiveId, "objectiveId required"),
      taskId: requireNonEmpty(payload.taskId, "taskId required"),
      workerType: normalizeWorkerType(requireNonEmpty(payload.workerType, "workerType required")),
      objectiveMode: normalizeObjectiveModeInput(payload.objectiveMode, "delivery"),
      severity: normalizeObjectiveSeverityInput(payload.severity, 1),
      candidateId: requireNonEmpty(payload.candidateId, "candidateId required"),
      baseCommit: requireNonEmpty(payload.baseCommit, "baseCommit required"),
      executionMode: payload.executionMode === "isolated" ? "isolated" : "worktree",
      workspaceId: requireNonEmpty(payload.workspaceId, "workspaceId required"),
      workspacePath: requireNonEmpty(payload.workspacePath, "workspacePath required"),
      promptPath: requireNonEmpty(payload.promptPath, "promptPath required"),
      resultPath: requireNonEmpty(payload.resultPath, "resultPath required"),
      stdoutPath: requireNonEmpty(payload.stdoutPath, "stdoutPath required"),
      stderrPath: requireNonEmpty(payload.stderrPath, "stderrPath required"),
      lastMessagePath: requireNonEmpty(payload.lastMessagePath, "lastMessagePath required"),
      manifestPath: requireNonEmpty(payload.manifestPath, "manifestPath required"),
      contextPackPath: requireNonEmpty(payload.contextPackPath, "contextPackPath required"),
      memoryScriptPath: requireNonEmpty(payload.memoryScriptPath, "memoryScriptPath required"),
      memoryConfigPath: requireNonEmpty(payload.memoryConfigPath, "memoryConfigPath required"),
      repoSkillPaths: Array.isArray(payload.repoSkillPaths) ? payload.repoSkillPaths.filter((item): item is string => typeof item === "string") : [],
      skillBundlePaths: Array.isArray(payload.skillBundlePaths) ? payload.skillBundlePaths.filter((item): item is string => typeof item === "string") : [],
      profile: normalizeFactoryObjectiveProfileSnapshot(payload.profile),
      profilePromptHash: optionalTrimmedString(payload.profilePromptHash) ?? "",
      profileSkillRefs: Array.isArray(payload.profileSkillRefs) ? payload.profileSkillRefs.filter((item): item is string => typeof item === "string") : [],
      sharedArtifactRefs: Array.isArray(payload.sharedArtifactRefs)
        ? payload.sharedArtifactRefs.filter((item): item is GraphRef => isRecord(item) && typeof item.kind === "string" && typeof item.ref === "string")
        : [],
      contextRefs: Array.isArray(payload.contextRefs) ? payload.contextRefs.filter((item): item is GraphRef => isRecord(item) && typeof item.kind === "string" && typeof item.ref === "string") : [],
      integrationRef: isRecord(payload.integrationRef) && typeof payload.integrationRef.kind === "string" && typeof payload.integrationRef.ref === "string"
        ? payload.integrationRef as GraphRef
        : undefined,
      problem: requireNonEmpty(payload.problem, "problem required"),
      config: isRecord(payload.config) ? payload.config : {},
    };
  }

  private parseIntegrationPayload(payload: Record<string, unknown>): FactoryIntegrationJobPayload {
    if (payload.kind !== "factory.integration.validate") {
      throw new FactoryServiceError(400, "invalid factory integration payload");
    }
    return {
      kind: "factory.integration.validate",
      objectiveId: requireNonEmpty(payload.objectiveId, "objectiveId required"),
      candidateId: requireNonEmpty(payload.candidateId, "candidateId required"),
      workspacePath: requireNonEmpty(payload.workspacePath, "workspacePath required"),
      stdoutPath: requireNonEmpty(payload.stdoutPath, "stdoutPath required"),
      stderrPath: requireNonEmpty(payload.stderrPath, "stderrPath required"),
      resultPath: requireNonEmpty(payload.resultPath, "resultPath required"),
      checks: Array.isArray(payload.checks) ? payload.checks.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
    };
  }

  private taskResultSchemaPath(resultPath: string): string {
    return resultPath.replace(/\.json$/i, ".schema.json");
  }

  private async taskPacketPresent(
    payload: Pick<
      FactoryTaskJobPayload,
      "manifestPath" | "contextPackPath" | "memoryScriptPath" | "memoryConfigPath" | "skillBundlePaths"
    >,
  ): Promise<boolean> {
    const requiredPaths = [
      payload.manifestPath,
      payload.contextPackPath,
      payload.memoryScriptPath,
      payload.memoryConfigPath,
      ...payload.skillBundlePaths,
    ];
    for (const targetPath of requiredPaths) {
      if (!(await pathExists(targetPath))) return false;
    }
    return true;
  }

  private async resolveTaskWorkerResult(
    payload: Pick<FactoryTaskJobPayload, "lastMessagePath" | "resultPath">,
    execution: { readonly stdout: string; readonly lastMessage?: string; readonly tokensUsed?: number },
  ): Promise<Record<string, unknown>> {
    return resolveFactoryTaskWorkerResult(payload, execution);
  }

  private async resolvePublishWorkerResult(
    payload: Pick<FactoryIntegrationPublishJobPayload, "lastMessagePath">,
    execution: { readonly lastMessage?: string },
  ): Promise<FactoryPublishResult> {
    return resolveFactoryPublishWorkerResult(payload, execution);
  }

  private isRetryablePublishFailureMessage(message: string): boolean {
    const normalized = message.trim();
    if (!normalized) return false;
    if (HUMAN_INPUT_BLOCK_REASON_RE.test(normalized)) return false;
    return PUBLISH_TRANSIENT_FAILURE_RE.test(normalized);
  }

  private async ensureWorkspaceReceiptCli(workspacePath: string): Promise<string> {
    const repoReceiptBinDir = path.join(workspacePath, ".receipt", "bin");
    const repoShimPath = path.join(repoReceiptBinDir, process.platform === "win32" ? "receipt.cmd" : "receipt");
    if (workspacePath === this.git.repoRoot && await pathExists(repoShimPath)) {
      return repoReceiptBinDir;
    }
    const shimRoot = workspacePath === this.git.repoRoot
      ? path.join(
          this.dataDir,
          "factory",
          "repo-bin",
          createHash("sha1").update(workspacePath).digest("hex").slice(0, 12),
        )
      : workspacePath;
    const binDir = path.join(shimRoot, ".receipt", "bin");
    const shimPath = path.join(binDir, process.platform === "win32" ? "receipt.cmd" : "receipt");
    const { command, args, entryPath } = resolveCliInvocation(import.meta.url);
    await fs.mkdir(binDir, { recursive: true });
    const body = process.platform === "win32"
      ? [
          "@echo off",
          `set "DATA_DIR=${this.dataDir}"`,
          `set "RECEIPT_DATA_DIR=${this.dataDir}"`,
          `"${command}" "${entryPath}" %*`,
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          `export DATA_DIR=${shellQuote(this.dataDir)}`,
          `export RECEIPT_DATA_DIR=${shellQuote(this.dataDir)}`,
          `exec ${shellQuote(command)} ${args.map((arg) => shellQuote(arg)).join(" ")} "$@"`,
          "",
        ].join("\n");
    await fs.writeFile(shimPath, body, "utf-8");
    if (process.platform !== "win32") await fs.chmod(shimPath, 0o755);
    return binDir;
  }

  private async ensureWorkspaceCommandEnv(workspacePath: string): Promise<{
    readonly receiptBinDir: string;
    readonly path: string;
  }> {
    if (isPathWithinRoot(workspacePath, this.git.worktreesDir)) {
      await this.ensureWorkspaceDependencyLinks(workspacePath);
    }
    const receiptBinDir = await this.ensureWorkspaceReceiptCli(workspacePath);
    const workspaceNodeModulesBin = await pathExists(path.join(workspacePath, "node_modules", ".bin"))
      ? path.join(workspacePath, "node_modules", ".bin")
      : undefined;
    const repoNodeModulesBin = await pathExists(path.join(this.git.repoRoot, "node_modules", ".bin"))
      ? path.join(this.git.repoRoot, "node_modules", ".bin")
      : undefined;
    const repoReceiptBinDir = await pathExists(path.join(this.git.repoRoot, ".receipt", "bin"))
      ? path.join(this.git.repoRoot, ".receipt", "bin")
      : undefined;
    return {
      receiptBinDir,
      path: prependPaths(
        [receiptBinDir, workspaceNodeModulesBin, repoNodeModulesBin, repoReceiptBinDir, ...runtimeBunPathEntries()],
        process.env.PATH,
      ),
    };
  }

  private async ensureWorkspaceDependencyLinks(workspacePath: string): Promise<void> {
    const sourceNodeModulesPath = path.join(this.git.repoRoot, "node_modules");
    if (!(await pathExists(sourceNodeModulesPath))) return;
    const workspaceNodeModulesPath = path.join(workspacePath, "node_modules");
    const existing = await fs.lstat(workspaceNodeModulesPath).catch(() => undefined);
    if (existing) return;
    await fs.symlink(
      sourceNodeModulesPath,
      workspaceNodeModulesPath,
      process.platform === "win32" ? "junction" : "dir",
    );
  }

  private async loadMemorySummary(scope: string, query: string): Promise<string> {
    if (!this.memoryTools) return "";
    try {
      const { summary } = await this.memoryTools.summarize({
        scope,
        query,
        limit: 8,
        maxChars: 1_200,
        audit: {
          actor: "factory-service",
          operation: "load-memory-summary",
        },
      });
      return summary;
    } catch {
      return "";
    }
  }

  private async commitTaskMemory(
    state: FactoryState,
    task: FactoryTaskRecord,
    candidateId: string,
    summary: string,
    outcome: string,
  ): Promise<void> {
    if (!this.memoryTools) return;
    try {
      const scopes = this.memoryScopesForTask(state, task, candidateId);
      const byKey = new Map(scopes.map((scope) => [scope.key, scope]));
      await Promise.all([
        this.memoryTools.commit({
          scope: byKey.get("agent")?.scope ?? `factory/agents/${String(task.workerType)}`,
          text: `[${state.objectiveId}/${task.taskId}] ${summary}`,
          tags: ["factory", "agent", String(task.workerType), outcome],
        }),
        this.memoryTools.commit({
          scope: byKey.get("repo")?.scope ?? "factory/repo/shared",
          text: `[${state.objectiveId}/${task.taskId}] ${summary}`,
          tags: ["factory", "repo", outcome],
        }),
        this.memoryTools.commit({
          scope: byKey.get("objective")?.scope ?? `factory/objectives/${state.objectiveId}`,
          text: `[${task.taskId}] ${summary}`,
          tags: ["factory", task.taskId, outcome],
        }),
        this.memoryTools.commit({
          scope: byKey.get("task")?.scope ?? `factory/objectives/${state.objectiveId}/tasks/${task.taskId}`,
          text: summary,
          tags: ["factory", "task", outcome],
        }),
        this.memoryTools.commit({
          scope: byKey.get("candidate")?.scope ?? `factory/objectives/${state.objectiveId}/candidates/${candidateId}`,
          text: summary,
          tags: ["factory", "candidate", candidateId, outcome],
        }),
      ]);
    } catch {
      // memory is auxiliary
    }
  }

  private async commitIntegrationMemory(
    state: FactoryState,
    candidateId: string,
    summary: string,
    tags: ReadonlyArray<string>,
  ): Promise<void> {
    if (!this.memoryTools) return;
    try {
      await Promise.all([
        this.memoryTools.commit({
          scope: `factory/objectives/${state.objectiveId}`,
          text: `[integration/${candidateId}] ${summary}`,
          tags: ["factory", ...tags],
        }),
        this.memoryTools.commit({
          scope: `factory/objectives/${state.objectiveId}/integration`,
          text: summary,
          tags: ["factory", ...tags],
        }),
      ]);
    } catch {
      // memory is auxiliary
    }
  }

  private async commitPublishMemory(
    state: FactoryState,
    candidateId: string,
    summary: string,
    tags: ReadonlyArray<string>,
  ): Promise<void> {
    if (!this.memoryTools) return;
    try {
      await Promise.all([
        this.memoryTools.commit({
          scope: `factory/objectives/${state.objectiveId}`,
          text: `[publish/${candidateId}] ${summary}`,
          tags: ["factory", ...tags],
        }),
        this.memoryTools.commit({
          scope: `factory/objectives/${state.objectiveId}/integration`,
          text: summary,
          tags: ["factory", "integration", ...tags],
        }),
        this.memoryTools.commit({
          scope: `factory/objectives/${state.objectiveId}/publish`,
          text: summary,
          tags: ["factory", "publish", ...tags],
        }),
      ]);
    } catch {
      // memory is auxiliary
    }
  }

  private async collectCheckedInRepoSkillPaths(): Promise<ReadonlyArray<string>> {
    const root = path.join(this.git.repoRoot, "skills");
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(target);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name === "SKILL.md" || entry.name.endsWith(".md")) out.push(target);
      }
    };
    await walk(root);
    return out.sort((a, b) => a.localeCompare(b));
  }

  private async collectRepoSkillPaths(): Promise<ReadonlyArray<string>> {
    const checkedIn = await this.collectCheckedInRepoSkillPaths();
    return [...new Set(checkedIn)].sort((a, b) => a.localeCompare(b));
  }

  private async runChecks(commands: ReadonlyArray<string>, workspacePath: string): Promise<ReadonlyArray<FactoryCheckResult>> {
    const workspaceCommandEnv = await this.ensureWorkspaceCommandEnv(workspacePath);
    const results: FactoryCheckResult[] = [];
    for (const command of commands) {
      const startedAt = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error("check command timed out after 60 minutes")), 60 * 60 * 1000);
      try {
        const { stdout, stderr } = await execFileAsync("/bin/sh", ["-lc", command], {
          cwd: workspacePath,
          encoding: "utf-8",
          env: {
            ...process.env,
            DATA_DIR: this.dataDir,
            RECEIPT_DATA_DIR: this.dataDir,
            PATH: workspaceCommandEnv.path,
          },
          maxBuffer: 16 * 1024 * 1024,
          signal: ac.signal,
        });
        results.push({
          command,
          ok: true,
          exitCode: 0,
          stdout,
          stderr,
          startedAt,
          finishedAt: Date.now(),
        });
      } catch (err) {
        const failure = err as Error & { stdout?: string; stderr?: string; code?: number };
        results.push({
          command,
          ok: false,
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? failure.message,
          startedAt,
          finishedAt: Date.now(),
        });
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    return results;
  }

  private async baselineFailureSignature(
    state: FactoryState,
    command: string,
    baseHash: string,
  ): Promise<{
    readonly digest: string;
    readonly excerpt: string;
  } | undefined> {
    const cacheKey = `${state.objectiveId}:${baseHash}:${command}`;
    const existing = this.baselineCheckCache.get(cacheKey);
    if (existing) return existing;

    const pending = (async () => {
      const workspaceId = `factory_baseline_${safeWorkspacePart(state.objectiveId)}_${createHash("sha1").update(command).digest("hex").slice(0, 10)}`;
      const workspacePath = path.join(this.git.worktreesDir, workspaceId);
      const branchName = `hub/baseline/${workspaceId}`;
      try {
        const workspace = await this.git.restoreWorkspace({
          workspaceId,
          branchName,
          workspacePath,
          baseHash,
        });
        const [result] = await this.runChecks([command], workspace.path);
        if (!result || result.ok) return undefined;
        return buildFactoryFailureSignature(result, {
          worktreesDir: this.git.worktreesDir,
          repoRoot: this.git.repoRoot,
        });
      } catch {
        return undefined;
      } finally {
        await this.git.removeWorkspace(workspacePath).catch(() => undefined);
      }
    })();

    this.baselineCheckCache.set(cacheKey, pending);
    return pending;
  }

  private async classifyFailedCheck(
    state: FactoryState,
    check: FactoryCheckResult,
    baseHash: string = state.baseHash,
  ): Promise<{
    readonly inherited: boolean;
    readonly digest: string;
    readonly excerpt: string;
    readonly source?: string;
  }> {
    const { digest, excerpt } = buildFactoryFailureSignature(check, {
      worktreesDir: this.git.worktreesDir,
      repoRoot: this.git.repoRoot,
    });
    const prior = priorFactoryFailureSignatureMap(state, {
      worktreesDir: this.git.worktreesDir,
      repoRoot: this.git.repoRoot,
    }).get(digest);
    if (prior) {
      return {
        inherited: true,
        digest,
        excerpt,
        source: prior.source,
      };
    }
    const baseline = await this.baselineFailureSignature(state, check.command, baseHash);
    return {
      inherited: Boolean(baseline && baseline.digest === digest),
      digest,
      excerpt,
      source: baseline && baseline.digest === digest
        ? `baseline/${baseHash.slice(0, 8)}`
        : undefined,
    };
  }

  private async readTextTail(filePath: string | undefined, maxChars: number): Promise<string | undefined> {
    if (!filePath) return undefined;
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const trimmed = raw.trim();
      return trimmed ? tailText(trimmed, maxChars) : undefined;
    } catch {
      return undefined;
    }
  }

  private makeId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
