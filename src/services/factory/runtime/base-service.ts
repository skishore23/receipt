import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { jsonBranchStore, jsonlStore } from "../../../adapters/jsonl";
import type { JsonlQueue, QueueJob } from "../../../adapters/jsonl-queue";
import { CodexControlSignalError, type CodexExecutor, type CodexRunControl, type CodexRunInput } from "../../../adapters/codex-executor";
import { HubGit } from "../../../adapters/hub-git";
import type { MemoryTools } from "../../../adapters/memory-tools";
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
  type FactoryObjectiveContractRecord,
  type FactoryObjectivePhase,
  type FactoryObjectiveHandoffStatus,
  type FactoryObjectiveMode,
  type FactoryCheckResult,
  type FactoryCmd,
  type FactoryEvent,
  type FactoryObjectiveProfileSnapshot,
  type FactoryObjectiveSeverity,
  type FactoryObjectiveStatus,
  type FactoryState,
  type FactoryTaskAlignmentRecord,
  type FactoryTaskCompletionRecord,
  type FactoryTaskExecutionMode,
  type FactoryTaskResultOutcome,
  type FactoryTaskRecord,
  type FactoryTaskStatus,
  type FactoryWorkerHandoffOutcome,
  type FactoryWorkerHandoffScope,
  type FactoryWorkerType,
  type FactoryCandidateStatus,
} from "../../../modules/factory";
import { repoKeyForRoot, resolveFactoryChatProfile } from "../../factory-chat-profiles";
import {
  buildFactoryMemoryScriptSource,
  factoryChatCodexArtifactPaths,
  type FactoryChatCodexArtifactPaths,
} from "../../factory-codex-artifacts";
import {
  helperCatalogArtifactRefs,
  loadFactoryHelperContext,
} from "../../factory-helper-catalog";
import {
  scanFactoryCloudExecutionContext,
  type FactoryCloudExecutionContext,
  type FactoryCloudProvider,
} from "../../factory-cloud-context";
import { resolveFactoryCloudExecutionContext } from "../../factory-cloud-targeting";
import {
  cloudProviderDefaultsToAws,
  renderInfrastructureTaskExecutionGuidance,
  taskNeedsCloudExecutionContext,
} from "../../factory-infrastructure-guidance";
import {
  buildInheritedFactoryFailureNote,
} from "../failure-policy";
import {
  buildFactoryPlanningReceipt,
  planningReceiptFingerprint,
} from "../planning";
import { runMonitorCheckpoint } from "../monitor-job";
import { MonitorCheckpointResultSchema } from "../monitor-checkpoint";
import { llmStructured } from "../../../adapters/openai";
import {
  factoryPromotionGateBlockedReason,
  factoryTaskCompletionForTask,
} from "../promotion-gate";
import {
  buildDefaultTaskCompletion,
  FACTORY_INVESTIGATION_TASK_RESULT_SCHEMA,
  FACTORY_PUBLISH_RESULT_SCHEMA,
  FACTORY_TASK_RESULT_SCHEMA,
  normalizeExecutionScriptsRun,
  normalizeInvestigationReport,
  normalizeTaskAlignmentRecord,
  normalizeTaskCompletionRecord,
  renderDeliveryResultText,
  renderInvestigationReportText,
} from "../result-contracts";
import {
  resolveFactoryPublishWorkerResult,
  resolveFactoryTaskWorkerResult,
  type FactoryPublishResult,
} from "../worker-results";
import {
  detectArtifactIssues,
  pathExists,
  readdirIfPresent,
  type FactoryArtifactIssue,
} from "../artifact-inspection";
import { inferObjectiveLiveOutputFocusFromDetail } from "../live-output";
import {
  processObjectiveReconcileControl,
  processObjectiveStartupControl,
} from "../objective-control";
import {
  buildIntegrationFilePaths,
  buildTaskFilePaths,
  buildTaskMemoryScopes,
  listTaskArtifactActivity,
  renderTaskContextSummary,
  summarizeTaskArtifactActivity,
  type FactoryContextPack,
  type FactoryMemoryScopeSpec,
} from "../task-packets";
import {
  buildFactoryDirectCodexProbeContextPack,
  buildFactoryTaskContextPack,
} from "../context/task-context";
import {
  classifyFactoryFailedCheck,
  ensureFactoryWorkspaceCommandEnv,
  factoryTaskWorkspaceStatus,
  runFactoryChecks,
} from "../check-runner";
import {
  commitFactoryIntegrationMemory,
  commitFactoryInvestigationSynthesisMemory,
  commitFactoryPublishMemory,
  commitFactoryTaskMemory,
  loadFactoryMemorySummary,
  summarizeFactoryMemoryScope,
} from "../memory/store";
import {
  effectiveFactoryTaskPrompt,
  renderFactoryDirectCodexProbePrompt,
  renderFactoryTaskPrompt,
  renderFactoryTaskValidationSection,
} from "../prompt-rendering";
import {
  ensureFactoryTaskRuntime,
  factoryTaskRuntimesRoot,
  materializeFactoryIsolatedTaskSupportFiles,
  removeFactoryTaskRuntimeWorkspace,
} from "../task-runtime";
import {
  buildBlockedExplanation,
  buildObjectiveActivity,
  buildObjectiveCardRecord,
  buildObjectiveEvidenceCards,
  summarizeObjectiveReceipts,
} from "../objective-presenters";
import { reactFactoryObjective } from "../objective/reactor";
import { planTaskResult } from "../planner";
import {
  factoryRebracketReason,
  type FactoryRebracketEffect,
} from "../rebracket-policy";
import type {
  FactoryObjectivePlannerFacts,
  FactoryPlannerEffect,
  FactoryTaskReworkBlock,
  FactoryTaskResultPlannerInput,
} from "../effects";
import { transientFactoryOperationMessage } from "./transient-recovery";
import { createRuntime, type Runtime } from "@receipt/core/runtime";
import { type GraphRef } from "@receipt/core/graph";
import { makeEventId, optionalTrimmedString, requireTrimmedString, trimmedString } from "../../../framework/http";
import type { SseHub } from "../../../framework/sse-hub";
import { resolveCliInvocation } from "../../../lib/runtime-paths";
import type { JobCmd, JobEvent, JobRecord, JobState, JobStatus } from "../../../modules/job";
import { readObjectiveStatesFromProjection, syncChangedObjectiveProjections, syncObjectiveProjectionStream } from "../../../db/projectors";

const FACTORY_STREAM_PREFIX = "factory/objectives";
const DEFAULT_CHECKS = ["bun run build"] as const;
const DEFAULT_FACTORY_PROFILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
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
const USAGE_LIMIT_BLOCK_REASON_RE = /\b(usage_limit_reached|too many requests|rate limit|quota(?: exceeded| exhausted)?|429)\b/i;
const RETRYABLE_BLOCK_REASON_RE = /\b(factory task failed|lease expired|timed out|timeout|missing structured factory task result|transient|temporary|connection reset|econnreset|spawn|signal|unexpectedly canceled|interrupted)\b/i;
const NON_RETRYABLE_BLOCK_REASON_RE = /\b(no tracked diff|isolated runtime|cannot run in isolated mode|policy blocked|circuit[- ]broken|integration validation failed)\b/i;
const HUMAN_INPUT_BLOCK_REASON_RE = /\b(missing (?:dependency |implementation |product |design )?details?|need .*detail|need .*guidance|need .*clarification|choose|which (?:approach|option|api|path)|operator|human|approval|permission denied|access denied|unauthorized|credentials|auth(?:entication|orization)?|forbidden)\b/i;
const CONTROLLER_RESOLVABLE_DELIVERY_PARTIAL_RE = /\b(final clean completion|clean final termination|terminal success marker|orchestration layer needs|controller requires a pristine worktree|confirm or clean up|codex-home-runtime|\.receipt(?:\/|`)?|pristine worktree)\b/i;
const AUTONOMOUS_RETRY_MAX_CANDIDATE_PASSES = 1;
const ALIGNMENT_CORRECTION_NOTE_PREFIX = "Alignment correction for this objective:";
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
const dedupeGraphRefs = (refs: ReadonlyArray<GraphRef>): ReadonlyArray<GraphRef> => {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.ref}:${ref.label ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
const formatContractLines = (
  title: string,
  items: ReadonlyArray<string>,
): ReadonlyArray<string> => items.length > 0 ? [title, ...items.map((item) => `- ${item}`), ""] : [];
const renderAlignmentCorrectionNote = (input: {
  readonly taskId: string;
  readonly alignment: FactoryTaskAlignmentRecord;
  readonly contract: FactoryObjectiveContractRecord;
}): string => {
  const lines = [
    ALIGNMENT_CORRECTION_NOTE_PREFIX,
    `Task: ${input.taskId}`,
    `Reported verdict: ${input.alignment.verdict}`,
    input.alignment.missing.length > 0
      ? `Missing contract items: ${input.alignment.missing.join(" | ")}`
      : undefined,
    input.alignment.outOfScope.length > 0
      ? `Out-of-scope work to remove or avoid claiming: ${input.alignment.outOfScope.join(" | ")}`
      : undefined,
    input.contract.requiredChecks.length > 0
      ? `Required checks: ${input.contract.requiredChecks.join(", ")}`
      : "Required checks: use the task contract proof and validation plan.",
    `Proof expectation: ${input.contract.proofExpectation}`,
    `Worker rationale: ${input.alignment.rationale}`,
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
};

type FactoryLiveGuidanceKind = "steer" | "follow_up" | "mixed";

type FactoryLiveGuidance = {
  readonly guidance: string;
  readonly guidanceKind: FactoryLiveGuidanceKind;
  readonly sourceCommandIds: ReadonlyArray<string>;
  readonly jobId?: string;
  readonly appliedAt: number;
};

const parseFactoryLiveGuidance = (
  signal: { readonly note?: string; readonly meta?: Record<string, unknown> } | undefined,
): FactoryLiveGuidance | undefined => {
  const meta = signal?.meta;
  const guidance = trimmedString(
    typeof meta?.guidance === "string"
      ? meta.guidance
      : signal?.note,
  );
  if (!guidance) return undefined;
  const guidanceKind = meta?.guidanceKind === "steer" || meta?.guidanceKind === "follow_up" || meta?.guidanceKind === "mixed"
    ? meta.guidanceKind
    : "mixed";
  const sourceCommandIds = Array.isArray(meta?.sourceCommandIds)
    ? [...new Set(meta.sourceCommandIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0))]
    : [];
  const jobId = trimmedString(typeof meta?.jobId === "string" ? meta.jobId : undefined);
  const appliedAt = typeof meta?.appliedAt === "number" && Number.isFinite(meta.appliedAt)
    ? meta.appliedAt
    : Date.now();
  return {
    guidance,
    guidanceKind,
    sourceCommandIds,
    jobId,
    appliedAt,
  };
};

const renderLiveOperatorGuidanceSection = (
  guidanceHistory: ReadonlyArray<FactoryLiveGuidance>,
): string | undefined => {
  if (guidanceHistory.length === 0) return undefined;
  const lines = [
    "## Live Operator Guidance",
    ...guidanceHistory.flatMap((item, index) => {
      const label =
        item.guidanceKind === "mixed"
          ? "Live steer/follow-up"
          : item.guidanceKind === "follow_up"
            ? "Live follow-up"
            : "Live steer";
      return [
        `${index + 1}. ${label} at ${new Date(item.appliedAt).toISOString()}`,
        item.guidance,
      ];
    }),
    "",
  ];
  return lines.join("\n");
};
const dedupeStrings = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values.map((item) => item.trim()).filter(Boolean))];
const isTerminalJobStatus = (status?: JobStatus | "missing"): boolean =>
  status === "completed" || status === "failed" || status === "canceled";
const isActiveJobStatus = (status?: JobStatus | "missing"): boolean =>
  status === "queued" || status === "leased" || status === "running";
const LIVE_JOB_STALE_AFTER_MS = 90_000;
const jobProgressAt = (job: QueueJob | undefined): number | undefined => {
  const result = isRecord(job?.result) ? job.result : undefined;
  return typeof result?.progressAt === "number" && Number.isFinite(result.progressAt)
    ? result.progressAt
    : undefined;
};
const displayLiveJobStatus = (job: QueueJob | undefined, now = Date.now()): string | undefined => {
  if (!job) return undefined;
  if (isTerminalJobStatus(job.status)) return job.status;
  const progressAt = jobProgressAt(job);
  if (job.status === "running" && typeof progressAt === "number" && now - progressAt >= LIVE_JOB_STALE_AFTER_MS) {
    return "stalled";
  }
  if (job.status === "leased") return "running";
  return job.status;
};
const isDisplayActiveJobStatus = (status?: string): boolean =>
  status === "queued" || status === "running";
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
  type FactoryObjectiveAlignmentSummary,
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
  type FactoryMonitorJobPayload,
  type FactoryObjectiveReceiptSummary,
  type FactoryObjectiveReceiptQuery,
  FACTORY_PROFILE_SUMMARY,
} from "../../factory-types";

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
} from "../../factory-types";

class FactoryStaleObjectiveError extends Error {
  readonly objectiveId: string;
  readonly expectedPrev: string;

  constructor(objectiveId: string, expectedPrev: string, actualPrev?: string) {
    super(`factory objective ${objectiveId} advanced before applying a mutation (${expectedPrev} -> ${actualPrev ?? "undefined"})`);
    this.objectiveId = objectiveId;
    this.expectedPrev = expectedPrev;
  }
}

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


export class FactoryServiceBase {
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

  private async syncObjectiveProjectionCache(): Promise<void> {
    await this.ensureBootstrap();
    const changedStreams = await syncChangedObjectiveProjections(this.dataDir, this.runtime);
    if (changedStreams.length > 0) this.invalidateObjectiveProjection();
  }

  async projectionVersionFresh(): Promise<number> {
    await this.syncObjectiveProjectionCache();
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
      repoSkillPaths: dedupeStrings(repoSkillPaths),
      sharedArtifactRefs: dedupeGraphRefs(sharedArtifactRefs),
    };
  }

  private compactCloudExecutionContextForPacket(
    context: FactoryCloudExecutionContext,
  ): FactoryContextPack["cloudExecutionContext"] {
    return {
      summary: context.summary,
      availableProviders: context.availableProviders,
      activeProviders: context.activeProviders,
      preferredProvider: context.preferredProvider,
      guidance: context.guidance,
      aws: context.aws
        ? {
            cliPath: context.aws.cliPath,
            version: context.aws.version,
            profiles: context.aws.profiles,
            selectedProfile: context.aws.selectedProfile,
            defaultRegion: context.aws.defaultRegion,
            callerIdentity: context.aws.callerIdentity,
            ec2RegionScope: context.aws.ec2RegionScope
              ? {
                  queryableRegions: context.aws.ec2RegionScope.queryableRegions,
                  skippedRegions: context.aws.ec2RegionScope.skippedRegions,
                }
              : undefined,
          }
        : undefined,
      gcp: context.gcp,
      azure: context.azure,
    };
  }

  private objectiveContractForState(
    state: FactoryState,
    planningReceipt = state.planning ?? this.buildPlanningReceipt(state, state.updatedAt || Date.now()),
  ): FactoryObjectiveContractRecord {
    return {
      acceptanceCriteria: planningReceipt.acceptanceCriteria,
      allowedScope: [
        `Implement only what is needed to satisfy the accepted delivery objective for ${state.title}.`,
        "Make the minimum adjacent validation or helper changes required to ship the requested behavior.",
      ],
      disallowedScope: [
        "Do not broaden into unrelated refactors, formatting churn, or side quests outside the current objective.",
        "Do not claim downstream follow-up work as completed when it is only noted for handoff.",
      ],
      requiredChecks: state.checks.length > 0 ? state.checks : planningReceipt.validationPlan,
      proofExpectation: state.objectiveMode === "investigation"
        ? "Return concrete evidence and a clear conclusion with any uncertainty called out."
        : "Return concrete changed files, validation evidence, and no unresolved delivery work in completion.remaining.",
    };
  }

  private latestObjectiveAlignmentCandidate(
    state: FactoryState,
  ): { readonly task: FactoryTaskRecord; readonly candidate: FactoryCandidateRecord } | undefined {
    for (let index = state.candidateOrder.length - 1; index >= 0; index -= 1) {
      const candidateId = state.candidateOrder[index];
      const candidate = candidateId ? state.candidates[candidateId] : undefined;
      if (!candidate) continue;
      const task = state.workflow.tasksById[candidate.taskId];
      if (!task) continue;
      return { task, candidate };
    }
    return undefined;
  }

  private objectiveAlignmentForState(state: FactoryState): FactoryObjectiveAlignmentSummary | undefined {
    if (state.objectiveMode !== "delivery") return undefined;
    const latest = this.latestObjectiveAlignmentCandidate(state);
    if (!latest) return undefined;
    const correctionAttempted = Boolean(
      latest.task.sourceTaskId
      || latest.task.prompt.includes(ALIGNMENT_CORRECTION_NOTE_PREFIX),
    );
    const alignment = latest.candidate.alignment;
    if (!alignment) {
      return {
        verdict: "uncertain",
        satisfied: [],
        missing: [],
        outOfScope: [],
        rationale: "The worker did not report an explicit alignment review for this candidate.",
        gateStatus: "not_reported",
        correctiveAction: "Require the next task result to report the objective contract alignment explicitly.",
        correctionAttempted,
        correctedAfterReview: false,
        sourceTaskId: latest.task.taskId,
        sourceCandidateId: latest.candidate.candidateId,
      };
    }
    const correctedAfterReview = alignment.verdict === "aligned" && correctionAttempted;
    return {
      ...alignment,
      gateStatus: alignment.verdict === "aligned"
        ? "passed"
        : correctionAttempted
          ? "blocked"
          : "correction_requested",
      correctiveAction: alignment.verdict === "aligned"
        ? undefined
        : correctionAttempted
          ? "Receipt already issued one corrective pass. Further work stays blocked until the missing contract items are resolved."
          : "Receipt should queue one focused corrective follow-up before promotion.",
      correctionAttempted,
      correctedAfterReview,
      sourceTaskId: latest.task.taskId,
      sourceCandidateId: latest.candidate.candidateId,
    };
  }

  private defaultDeliveryAlignment(
    state: FactoryState,
    completion: FactoryTaskCompletionRecord,
  ): FactoryTaskAlignmentRecord {
    const contract = this.objectiveContractForState(state);
    const inferredAligned = completion.remaining.length === 0 && completion.proof.length > 0;
    return {
      verdict: inferredAligned ? "aligned" : "uncertain",
      satisfied: inferredAligned ? contract.acceptanceCriteria : [],
      missing: inferredAligned ? [] : contract.acceptanceCriteria,
      outOfScope: [],
      rationale: inferredAligned
        ? "The worker did not emit an explicit alignment block, but the controller inferred alignment from proof-backed completion with no remaining work."
        : "The worker did not emit an explicit alignment block, so the controller could not prove the full objective contract was satisfied.",
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
      taskPrompt: effectiveFactoryTaskPrompt({
        profileCloudProvider: this.objectiveProfileForState(input.state).cloudProvider,
        objectiveMode: input.state.objectiveMode,
        taskPrompt: input.task.prompt,
      }),
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
      taskPrompt: effectiveFactoryTaskPrompt({
        profileCloudProvider: this.objectiveProfileForState(input.state).cloudProvider,
        objectiveMode: input.state.objectiveMode,
        taskPrompt: input.task.prompt,
      }),
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
    const consumesRepoSlot = this.objectiveConsumesRepoSlot(objectiveMode);
    const hasActiveSlot = consumesRepoSlot
      ? await this.hasActiveObjectiveSlot()
      : false;
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
    readonly profileId?: string;
  }): Promise<ReadonlyArray<FactoryObjectiveCard>> {
    const objectiveIds = (query?.objectiveIds ?? [])
      .map((objectiveId) => objectiveId.trim())
      .filter(Boolean);
    const profileId = query?.profileId?.trim();
    await this.syncObjectiveProjectionCache();
    if (objectiveIds.length > 0) {
      const states = await this.listObjectiveStates();
      const queuePositions = this.queuePositionsForStates(states);
      const objectiveIdSet = new Set(objectiveIds);
      const details = await Promise.all(
        states
          .filter((state) => objectiveIdSet.has(state.objectiveId))
          .filter((state) => !profileId || state.profile.rootProfileId === profileId)
          .map((state) => this.buildObjectiveCard(state, queuePositions.get(state.objectiveId))),
      );
      return details.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    const cached = this.objectiveListCache;
    if (cached && cached.version === this.objectiveProjectionVersion) {
      return profileId
        ? cached.cards.filter((card) => card.profile.rootProfileId === profileId)
        : cached.cards;
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
    return profileId
      ? cards.filter((card) => card.profile.rootProfileId === profileId)
      : cards;
  }

  async getObjectiveState(objectiveId: string): Promise<FactoryState> {
    await this.ensureBootstrap();
    const state = normalizeFactoryState(await this.runtime.state(objectiveStream(objectiveId)));
    if (!state.objectiveId) throw new FactoryServiceError(404, "factory objective not found");
    return state;
  }

  async splitTask(
    objectiveId: string,
    parentTaskId: string,
    subtasks: ReadonlyArray<{ readonly title: string; readonly prompt: string; readonly dependsOn?: ReadonlyArray<string> }>,
  ): Promise<void> {
    const MAX_SPLIT_DEPTH = 2;
    const state = await this.getObjectiveState(objectiveId);
    const parentTask = state.workflow.tasksById[parentTaskId];
    if (!parentTask) throw new FactoryServiceError(404, `task ${parentTaskId} not found`);
    const currentDepth = parentTask.splitDepth ?? 0;
    if (currentDepth >= MAX_SPLIT_DEPTH) {
      throw new FactoryServiceError(409, `Cannot split task ${parentTaskId}: maximum split depth (${MAX_SPLIT_DEPTH}) reached`);
    }

    const basedOn = await this.currentHeadHash(objectiveId);
    const now = Date.now();
    const baseOrdinal = this.nextTaskOrdinal(state);
    const events: FactoryEvent[] = [];

    // Supersede parent
    if (parentTask.status !== "integrated" && parentTask.status !== "superseded") {
      events.push({
        type: "task.superseded",
        objectiveId,
        taskId: parentTaskId,
        reason: "Split by monitor into subtasks.",
        supersededAt: now,
      });
    }

    // Pre-compute all subtask IDs so forward references work
    const subtaskIds = subtasks.map((_, i) => taskOrdinalId(baseOrdinal + i));
    for (let i = 0; i < subtasks.length; i++) {
      const sub = subtasks[i];
      const taskId = subtaskIds[i];
      const dependsOn = (sub.dependsOn ?? []).map((indexStr) => {
        const idx = parseInt(indexStr, 10);
        if (Number.isFinite(idx) && idx >= 0 && idx < subtaskIds.length && idx !== i) {
          return subtaskIds[idx];
        }
        return indexStr;
      });

      const taskRecord = this.createObjectiveTaskRecord({
        objectiveId,
        title: sub.title,
        prompt: sub.prompt,
        workerType: parentTask.workerType,
        executionMode: parentTask.executionMode ?? this.objectiveProfileForState(state).objectivePolicy.defaultTaskExecutionMode,
        baseCommit: parentTask.baseCommit,
        createdAt: now + 1 + i,
        taskId,
        sourceTaskId: parentTaskId,
        basedOn,
      });

      events.push({
        type: "task.added",
        objectiveId,
        task: { ...taskRecord, splitDepth: currentDepth + 1, dependsOn },
        createdAt: now + 1 + i,
      });
    }

    await this.emitObjectiveBatch(objectiveId, events, basedOn);
  }

  async runMonitorJob(
    payload: Record<string, unknown>,
    control: { shouldAbort: () => Promise<boolean> },
  ): Promise<Record<string, unknown>> {
    const CHECKPOINT_INTERVAL_MS = 30 * 60 * 1_000;
    const POLL_INTERVAL_MS = 15_000;
    const monitorPayload = payload as unknown as FactoryMonitorJobPayload;
    let checkpoint = 0;
    const startedAt = Date.now();
    let lastCheckpointAt = Date.now();

    while (true) {
      // Poll frequently for codex job completion, only checkpoint every 30 min
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      // Check if codex job is still running
      const codexJob = await this.queue.getJob(monitorPayload.codexJobId);
      if (!codexJob || isTerminalJobStatus(codexJob.status)) {
        return { status: "codex_job_completed", checkpoints: checkpoint };
      }

      if (await control.shouldAbort()) {
        return { status: "monitor_aborted", checkpoints: checkpoint };
      }

      // Only run LLM evaluation at checkpoint intervals
      if (Date.now() - lastCheckpointAt < CHECKPOINT_INTERVAL_MS) {
        continue;
      }

      checkpoint += 1;
      lastCheckpointAt = Date.now();
      const elapsedMs = Date.now() - startedAt;

      const result = await runMonitorCheckpoint({
        stdoutPath: monitorPayload.stdoutPath,
        stderrPath: monitorPayload.stderrPath,
        taskPrompt: monitorPayload.taskPrompt,
        elapsedMs,
        checkpoint,
        evaluateLlm: async (prompt) => {
          const llmResult = await llmStructured({
            system: prompt.system,
            user: prompt.user,
            schema: MonitorCheckpointResultSchema,
            schemaName: "MonitorCheckpointResult",
          });
          return llmResult.parsed;
        },
      });

      // Emit checkpoint receipt
      await this.emitObjective(monitorPayload.objectiveId, {
        type: "monitor.checkpoint",
        objectiveId: monitorPayload.objectiveId,
        taskId: monitorPayload.taskId,
        jobId: monitorPayload.codexJobId,
        checkpoint,
        assessment: result.assessment,
        reasoning: result.reasoning,
        action: result.action,
        evaluatedAt: Date.now(),
      });

      // Act on result
      if (result.action.kind === "continue") {
        continue;
      }

      if (result.action.kind === "steer") {
        await this.emitObjective(monitorPayload.objectiveId, {
          type: "monitor.intervention",
          objectiveId: monitorPayload.objectiveId,
          taskId: monitorPayload.taskId,
          jobId: monitorPayload.codexJobId,
          interventionKind: "steer",
          detail: result.action.guidance,
          interventionAt: Date.now(),
        });
        await this.queue.queueCommand({
          jobId: monitorPayload.codexJobId,
          command: "steer",
          payload: { message: result.action.guidance },
        });
        continue;
      }

      if (result.action.kind === "split") {
        await this.emitObjective(monitorPayload.objectiveId, {
          type: "monitor.intervention",
          objectiveId: monitorPayload.objectiveId,
          taskId: monitorPayload.taskId,
          jobId: monitorPayload.codexJobId,
          interventionKind: "split",
          detail: `Splitting into ${result.action.subtasks.length} subtasks`,
          interventionAt: Date.now(),
        });
        await this.queue.queueCommand({
          jobId: monitorPayload.codexJobId,
          command: "abort",
          payload: {},
        });
        await this.splitTask(
          monitorPayload.objectiveId,
          monitorPayload.taskId,
          result.action.subtasks,
        );
        return { status: "split", checkpoints: checkpoint, subtasks: result.action.subtasks.length };
      }

      if (result.action.kind === "abort") {
        await this.emitObjective(monitorPayload.objectiveId, {
          type: "monitor.intervention",
          objectiveId: monitorPayload.objectiveId,
          taskId: monitorPayload.taskId,
          jobId: monitorPayload.codexJobId,
          interventionKind: "abort",
          detail: result.action.reason,
          interventionAt: Date.now(),
        });
        await this.queue.queueCommand({
          jobId: monitorPayload.codexJobId,
          command: "abort",
          payload: {},
        });
        return { status: "aborted", checkpoints: checkpoint, reason: result.action.reason };
      }
    }
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
    return summarizeObjectiveReceipts(chain, {
      limit: 200,
      summarizeReceipt: (event) => this.summarizeReceipt(event),
      receiptTaskOrCandidateId: (event) => this.receiptTaskOrCandidateId(event),
    })
      .filter((receipt) => !query.taskId || receipt.taskId === query.taskId)
      .filter((receipt) => !query.candidateId || receipt.candidateId === query.candidateId)
      .filter((receipt) => typeFilter.size === 0 || typeFilter.has(receipt.type))
      .slice(-limit);
  }

  async buildBoardProjection(query?: string | {
    readonly selectedObjectiveId?: string;
    readonly profileId?: string;
  }): Promise<FactoryBoardProjection> {
    const selectedObjectiveId = typeof query === "string" ? query : query?.selectedObjectiveId;
    const profileId = typeof query === "string" ? undefined : query?.profileId;
    const objectives = (await this.listObjectives(profileId ? { profileId } : undefined))
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
      const displayStatus = displayLiveJobStatus(task.job) ?? task.jobStatus ?? task.status;
      return {
        objectiveId,
        focusKind,
        focusId,
        title: task.title,
        status: displayStatus,
        active: isDisplayActiveJobStatus(displayStatus),
        summary: task.latestSummary ?? task.candidate?.summary ?? task.lastMessage ?? task.stderrTail ?? task.stdoutTail ?? task.artifactSummary,
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
        artifactActivity = await listTaskArtifactActivity(
          workspacePath,
          taskId,
          (resultPath) => this.taskResultSchemaPath(resultPath),
        );
        artifactSummary = summarizeTaskArtifactActivity(artifactActivity);
      }
    } else if (payloadKind === "factory.integration.validate") {
      title = candidateId ? `Integration ${candidateId}` : "Integration validation";
      stdoutTail = await this.readTextTail(optionalTrimmedString(payload.stdoutPath), 900);
      stderrTail = await this.readTextTail(optionalTrimmedString(payload.stderrPath), 600);
    }
    const displayStatus = displayLiveJobStatus(job) ?? job.status;

    return {
      objectiveId,
      focusKind,
      focusId,
      title,
      status: displayStatus,
      active: isDisplayActiveJobStatus(displayStatus),
      summary: artifactSummary ?? lastMessage ?? stderrTail ?? stdoutTail ?? summary,
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
    const canceledAt = Date.now();
    const summary = reason ? `Objective canceled: ${reason}` : "Objective canceled.";
    await this.emitObjectiveBatch(objectiveId, [
      {
        type: "objective.canceled",
        objectiveId,
        canceledAt,
        reason,
      },
      this.buildObjectiveHandoffEvent({
        state,
        status: "canceled",
        summary,
        blocker: reason,
        sourceUpdatedAt: canceledAt,
      }),
    ]);
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
    const runtimeEntries = await readdirIfPresent(factoryTaskRuntimesRoot(this.dataDir), { withFileTypes: true });
    for (const entry of runtimeEntries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(`${objectiveId}_`)) continue;
      workspacePaths.add(path.join(factoryTaskRuntimesRoot(this.dataDir), entry.name));
    }
    if (state.integration.branchRef?.kind === "workspace") {
      workspacePaths.add(state.integration.branchRef.ref);
    }
    await Promise.all(
      [...workspacePaths].map(async (workspacePath) => {
        await removeFactoryTaskRuntimeWorkspace({
          workspacePath,
          worktreesDir: this.git.worktreesDir,
          git: this.git,
        });
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

  async queueJobSteer(
    jobId: string,
    message: string,
    by = "factory.cli",
  ): Promise<FactoryQueuedJobCommand> {
    const normalized = optionalTrimmedString(message);
    if (!normalized) throw new FactoryServiceError(400, "steer message required");
    return this.queueJobCommand(jobId, {
      command: "steer",
      payload: {
        message: normalized,
        problem: normalized,
      },
      by,
    });
  }

  async queueJobFollowUp(
    jobId: string,
    message: string,
    by = "factory.cli",
  ): Promise<FactoryQueuedJobCommand> {
    const normalized = optionalTrimmedString(message);
    if (!normalized) throw new FactoryServiceError(400, "follow-up message required");
    return this.queueJobCommand(jobId, {
      command: "follow_up",
      payload: {
        message: normalized,
        note: normalized,
      },
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

      const objectiveId = typeof current.payload.objectiveId === "string" ? current.payload.objectiveId : "";
      const state = statesById.get(objectiveId);
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
      readonly command: "abort" | "steer" | "follow_up";
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

  private objectiveConsumesRepoSlot(
    objective: Pick<FactoryState, "objectiveMode"> | FactoryObjectiveMode,
  ): boolean {
    const objectiveMode = typeof objective === "string" ? objective : objective.objectiveMode;
    return objectiveMode !== "investigation";
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
    await this.syncObjectiveProjectionCache();
    const cached = this.objectiveStateListCache;
    if (cached && cached.version === this.objectiveProjectionVersion) {
      return cached.states;
    }
    const resolvedStates = readObjectiveStatesFromProjection(this.dataDir)
      .map((state) => normalizeFactoryState(state))
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
        && this.objectiveConsumesRepoSlot(state)
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
    return this.reworkPassCapReason(task.taskId, passes, state.policy.budgets.maxCandidatePassesPerTask);
  }

  private reworkPassCapReason(taskId: string, passes: number, maxPasses: number): string | undefined {
    if (passes < maxPasses) return undefined;
    return `Policy blocked: ${taskId} exhausted maxCandidatePassesPerTask (${passes}/${maxPasses}).`;
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
    if (USAGE_LIMIT_BLOCK_REASON_RE.test(reason)) {
      return `Autonomous execution blocked for ${task.taskId}: ${reason}`;
    }
    if (HUMAN_INPUT_BLOCK_REASON_RE.test(reason)) {
      return `Human input requested for ${task.taskId}: ${reason}`;
    }
    return `Autonomous recovery stopped for ${task.taskId}: ${reason}`;
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
      const blockedAt = Date.now();
      const blockedEvent = {
        type: "objective.blocked" as const,
        objectiveId,
        reason: askReason,
        summary: askReason,
        blockedAt,
      };
      await this.emitObjectiveBatch(objectiveId, [
        this.runtimeDecisionEvent(
          state,
          `ask_human_${askTask.taskId}`,
          askReason,
          { basedOn, frontierTaskIds: [askTask.taskId] },
        ),
        blockedEvent,
        this.buildObjectiveHandoffEvent({
          state,
          status: "blocked",
          summary: blockedEvent.summary,
          blocker: blockedEvent.reason,
          sourceUpdatedAt: blockedAt,
        }),
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
      && this.objectiveConsumesRepoSlot(state)
      && !this.releasesObjectiveSlot(state)
      && state.scheduler.slotState === "active"
      && !state.scheduler.releasedAt,
    );
  }

  private objectiveControlIdempotencyKey(state: FactoryState): string {
    const plan = state.planning
      ?? buildFactoryPlanningReceipt({
        state,
        profile: this.objectiveProfileForState(state),
        resolveTaskExecutionMode: (task) => this.resolveTaskExecutionMode(task),
      });
    const planHash = createHash("sha256").update(planningReceiptFingerprint(plan)).digest("hex").slice(0, 16);
    return `${state.objectiveId}:${planHash}`;
  }

  private async enqueueObjectiveControl(
    objectiveId: string,
    reason: FactoryObjectiveControlJobPayload["reason"],
  ): Promise<void> {
    const state = await this.getObjectiveState(objectiveId).catch(() => undefined);
    const created = await this.queue.enqueue({
      agentId: FACTORY_CONTROL_AGENT_ID,
      lane: "collect",
      sessionKey: `factory:objective:${objectiveId}`,
      idempotencyKey: state ? this.objectiveControlIdempotencyKey(state) : `factory:objective:${objectiveId}`,
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
        this.objectiveConsumesRepoSlot(state)
        && state.scheduler.slotState === "active"
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
    const slotFreeQueued = refreshed.filter((state) =>
      !state.archivedAt
      && !this.objectiveConsumesRepoSlot(state)
      && !this.releasesObjectiveSlot(state)
      && (state.scheduler.slotState === "queued" || !state.scheduler.slotState || state.scheduler.releasedAt)
    );
    for (const state of slotFreeQueued) {
      await this.emitObjective(state.objectiveId, {
        type: "objective.slot.admitted",
        objectiveId: state.objectiveId,
        admittedAt: Date.now(),
      });
      await this.enqueueObjectiveControl(state.objectiveId, "admitted");
    }

    const active = refreshed.find((state) =>
      !state.archivedAt
      && this.objectiveConsumesRepoSlot(state)
      && !this.releasesObjectiveSlot(state)
      && state.scheduler.slotState === "active"
      && !state.scheduler.releasedAt,
    );
    if (active) return;

    const next = refreshed.find((state) =>
      !state.archivedAt
      && this.objectiveConsumesRepoSlot(state)
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

  private buildInitialObjectiveTask(state: FactoryState): FactoryTaskRecord {
    const createdAt = Date.now();
    return this.createObjectiveTaskRecord({
      objectiveId: state.objectiveId,
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
  }

  private latestObjectiveTask(state: FactoryState): FactoryTaskRecord | undefined {
    return [...state.workflow.taskIds]
      .map((taskId) => state.workflow.tasksById[taskId])
      .filter((task): task is FactoryTaskRecord => Boolean(task))
      .at(-1);
  }

  private async emitFollowUpTaskFromLatestNote(
    state: FactoryState,
    latestNote: string,
  ): Promise<void> {
    const latestTask = this.latestObjectiveTask(state);
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
  }

  private async syncFailedActiveTasks(state: FactoryState): Promise<void> {
    for (const taskId of [...state.workflow.activeTaskIds]) {
      const task = state.workflow.tasksById[taskId];
      if (!task?.jobId) continue;
      const job = await this.loadFreshJob(task.jobId);
      if (!job || !isTerminalJobStatus(job.status)) continue;
      if ((job.status === "failed" || job.status === "canceled") && (task.status === "running" || task.status === "reviewing")) {
        const reason = job.lastError ?? job.canceledReason ?? "factory task failed";
        const blockedAt = Date.now();
        await this.emitObjectiveBatch(state.objectiveId, [
          this.buildWorkerHandoffEvent({
            objectiveId: state.objectiveId,
            scope: "task",
            workerType: task.workerType,
            taskId,
            candidateId: task.candidateId,
            outcome: job.status,
            summary: reason,
            handoff: reason,
            handedOffAt: blockedAt,
          }),
          {
            type: "task.blocked",
            objectiveId: state.objectiveId,
            taskId,
            reason,
            blockedAt,
          },
        ]);
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

  private async syncInvestigationSynthesisIfReady(state: FactoryState): Promise<boolean> {
    if (state.objectiveMode !== "investigation") return false;
    const projection = buildFactoryProjection(state);
    const investigationReady = (
      projection.tasks.length > 0
      && projection.readyTasks.length === 0
      && projection.activeTasks.length === 0
      && projection.tasks.every((task) => ["approved", "superseded"].includes(task.status))
      && this.finalInvestigationReports(state).length > 0
    );
    if (!investigationReady) return false;
    const synthesis = this.buildInvestigationSynthesis(state);
    if (!synthesis) return false;
    const existing = state.investigation.synthesized;
    const changed = !existing
      || existing.summary !== synthesis.summary
      || existing.taskIds.join(",") !== synthesis.taskIds.join(",")
      || existing.report.conclusion !== synthesis.report.conclusion;
    if (!changed) return false;
    await this.emitObjective(state.objectiveId, {
      type: "investigation.synthesized",
      objectiveId: state.objectiveId,
      summary: synthesis.summary,
      report: synthesis.report,
      taskIds: synthesis.taskIds,
      synthesizedAt: synthesis.synthesizedAt,
    });
    const refreshed = await this.getObjectiveState(state.objectiveId);
    const committedSynthesis = refreshed.investigation.synthesized ?? synthesis;
    await commitFactoryInvestigationSynthesisMemory(
      this.memoryTools,
      refreshed.objectiveId,
      committedSynthesis,
      this.finalInvestigationReports(refreshed).filter((report) => committedSynthesis.taskIds.includes(report.taskId)),
    );
    return true;
  }

  private async collectObjectivePlannerFacts(state: FactoryState): Promise<FactoryObjectivePlannerFacts> {
    const latestObjectiveOperatorNote = await this.latestObjectiveOperatorNote(state.objectiveId);
    const taskReworkBlocks: FactoryTaskReworkBlock[] = [];
    for (const task of factoryReadyTasks(state)) {
      const reason = this.taskReworkPolicyBlockedReason(state, task);
      if (!reason) continue;
      taskReworkBlocks.push({
        taskId: task.taskId,
        reason,
      });
    }
    return {
      latestObjectiveOperatorNote,
      taskReworkBlocks,
      dispatchCapacity: Math.max(0, this.effectiveMaxParallelChildren(state) - state.workflow.activeTaskIds.length),
      policyBlockedReason: state.taskRunsUsed >= state.policy.budgets.maxTaskRuns
        ? `Policy blocked: objective exhausted maxTaskRuns (${state.taskRunsUsed}/${state.policy.budgets.maxTaskRuns}).`
        : undefined,
      readyToPromoteBlockedReason: factoryPromotionGateBlockedReason(state),
      hasInvestigationReports: this.finalInvestigationReports(state).length > 0,
      investigationSynthesisSummary: state.investigation.synthesized?.summary,
    };
  }

  private buildObjectiveBlockedEvents(
    state: FactoryState,
    reason: string,
  ): ReadonlyArray<FactoryEvent> {
    const blockedAt = Date.now();
    return [
      {
        type: "objective.blocked",
        objectiveId: state.objectiveId,
        reason,
        summary: reason,
        blockedAt,
      },
      this.buildObjectiveHandoffEvent({
        state,
        status: "blocked",
        summary: reason,
        blocker: reason,
        sourceUpdatedAt: blockedAt,
      }),
    ];
  }

  private async scheduleTransientObjectiveReconcile(
    state: FactoryState,
    input: {
      readonly operation: string;
      readonly selectedActionId: string;
      readonly frontierTaskIds?: ReadonlyArray<string>;
    },
    error: unknown,
  ): Promise<boolean> {
    const transientMessage = transientFactoryOperationMessage(error);
    if (!transientMessage) return false;
    const basedOn = await this.currentHeadHash(state.objectiveId);
    try {
      await this.emitObjectiveBatch(state.objectiveId, [
        this.runtimeDecisionEvent(
          state,
          input.selectedActionId,
          `Reconcile objective after transient ${input.operation} failure: ${clipText(transientMessage, 240) ?? transientMessage}`,
          {
            basedOn,
            frontierTaskIds: input.frontierTaskIds,
          },
        ),
      ], basedOn);
    } catch (emitErr) {
      if (!(emitErr instanceof FactoryStaleObjectiveError)) throw emitErr;
    }
    await this.enqueueObjectiveControl(state.objectiveId, "reconcile");
    return true;
  }

  private async applyObjectivePreparationEffects(
    state: FactoryState,
    effects: ReadonlyArray<FactoryPlannerEffect>,
    facts: FactoryObjectivePlannerFacts,
  ): Promise<boolean> {
    const initial = effects.find((effect) => effect.type === "objective.add_initial_task");
    if (initial) {
      const task = this.buildInitialObjectiveTask(state);
      await this.emitObjective(state.objectiveId, {
        type: "task.added",
        objectiveId: state.objectiveId,
        task,
        createdAt: task.createdAt,
      });
      await this.recordPlanningReceipt(state.objectiveId);
      return true;
    }

    const followUp = effects.find((effect) => effect.type === "objective.queue_follow_up_task");
    if (followUp && facts.latestObjectiveOperatorNote) {
      await this.emitFollowUpTaskFromLatestNote(state, facts.latestObjectiveOperatorNote);
      return true;
    }

    const taskEvents = effects.flatMap((effect): FactoryEvent[] => {
      const at = Date.now();
      switch (effect.type) {
        case "task.unblock":
          return [{
            type: "task.unblocked",
            objectiveId: state.objectiveId,
            taskId: effect.taskId,
            readyAt: at,
          }];
        case "task.ready":
          return [{
            type: "task.ready",
            objectiveId: state.objectiveId,
            taskId: effect.taskId,
            readyAt: at,
          }];
        case "task.block":
          return [{
            type: "task.blocked",
            objectiveId: state.objectiveId,
            taskId: effect.taskId,
            reason: effect.reason,
            blockedAt: at,
          }];
        default:
          return [];
      }
    });
    if (taskEvents.length === 0) return false;
    await this.emitObjectiveBatch(state.objectiveId, taskEvents);
    return true;
  }

  private async applyObjectiveDispatchEffect(
    state: FactoryState,
    effect: Extract<FactoryPlannerEffect, { readonly type: "task.dispatch" }>,
    selection?: { readonly actionId: string; readonly reason: string },
  ): Promise<"applied" | "reconcile_scheduled"> {
    const task = state.workflow.tasksById[effect.taskId];
    if (!task) return "applied";
    const basedOn = await this.currentHeadHash(state.objectiveId);
    try {
      await this.dispatchTask(state, task, {
        expectedPrev: basedOn,
        prefixEvents: [
          this.runtimeDecisionEvent(
            state,
            selection?.actionId ?? `dispatch_${task.taskId}`,
            selection?.reason ?? factoryRebracketReason(effect),
            { basedOn, frontierTaskIds: [task.taskId] },
          ),
        ],
      });
      return "applied";
    } catch (err) {
      if (err instanceof FactoryStaleObjectiveError) return "applied";
      if (await this.scheduleTransientObjectiveReconcile(state, {
        operation: `dispatch ${task.taskId}`,
        selectedActionId: selection?.actionId ?? `retry_dispatch_${task.taskId}`,
        frontierTaskIds: [task.taskId],
      }, err)) {
        return "reconcile_scheduled";
      }
      throw err;
    }
  }

  private async applyObjectiveFinalEffect(
    state: FactoryState,
    effect: Exclude<FactoryRebracketEffect, { readonly type: "task.dispatch" }>,
    selection?: { readonly actionId: string; readonly reason: string },
  ): Promise<"applied" | "retried" | "asked_human" | "reconcile_scheduled"> {
    switch (effect.type) {
      case "integration.queue": {
        const basedOn = await this.currentHeadHash(state.objectiveId);
        try {
          await this.queueIntegration(state, effect.candidateId, {
            expectedPrev: basedOn,
            prefixEvents: [
              this.runtimeDecisionEvent(
                state,
                selection?.actionId ?? `queue_integration_${effect.candidateId}`,
                selection?.reason ?? factoryRebracketReason(effect),
                { basedOn, frontierTaskIds: [effect.taskId] },
              ),
            ],
          });
        } catch (err) {
          if (err instanceof FactoryStaleObjectiveError) return "applied";
          if (await this.scheduleTransientObjectiveReconcile(state, {
            operation: `queue integration ${effect.candidateId}`,
            selectedActionId: selection?.actionId ?? `retry_queue_integration_${effect.candidateId}`,
            frontierTaskIds: [effect.taskId],
          }, err)) {
            return "reconcile_scheduled";
          }
          throw err;
        }
        return "applied";
      }
      case "integration.ready_to_promote":
        await this.emitObjective(state.objectiveId, {
          type: "integration.ready_to_promote",
          objectiveId: state.objectiveId,
          candidateId: effect.candidateId,
          headCommit: effect.headCommit,
          summary: effect.summary,
          readyAt: Date.now(),
        });
        return "applied";
      case "integration.promote": {
        const basedOn = await this.currentHeadHash(state.objectiveId);
        try {
          await this.promoteIntegration(state, effect.candidateId, {
            expectedPrev: basedOn,
            prefixEvents: [
              this.runtimeDecisionEvent(
                state,
                selection?.actionId ?? `promote_integration_${effect.candidateId}`,
                selection?.reason ?? factoryRebracketReason(effect),
                { basedOn },
              ),
            ],
          });
        } catch (err) {
          if (err instanceof FactoryStaleObjectiveError) return "applied";
          if (await this.scheduleTransientObjectiveReconcile(state, {
            operation: `promote integration ${effect.candidateId}`,
            selectedActionId: selection?.actionId ?? `retry_promote_integration_${effect.candidateId}`,
          }, err)) {
            return "reconcile_scheduled";
          }
          throw err;
        }
        return "applied";
      }
      case "objective.complete":
        {
          const completedAt = Date.now();
          const output = state.objectiveMode === "investigation"
            ? this.buildInvestigationOutput(state)
            : undefined;
          const completedEvent = {
            type: "objective.completed" as const,
            objectiveId: state.objectiveId,
            summary: effect.summary,
            completedAt,
          };
          await this.emitObjectiveBatch(state.objectiveId, [
            completedEvent,
            this.buildObjectiveHandoffEvent({
              state,
              status: "completed",
              summary: effect.summary,
              output,
              sourceUpdatedAt: completedAt,
            }),
          ]);
        }
        return "applied";
      case "objective.block":
        if (effect.allowAutonomousNextStep) {
          const nextStep = await this.maybeAutonomousNextStepForBlockedObjective(state.objectiveId, state);
          if (nextStep === "retried") return "retried";
          if (nextStep === "asked_human") return "asked_human";
        }
        {
          const blockedAt = Date.now();
          const blockedEvent = {
            type: "objective.blocked" as const,
            objectiveId: state.objectiveId,
            reason: effect.reason,
            summary: effect.summary,
            blockedAt,
          };
          await this.emitObjectiveBatch(state.objectiveId, [
            blockedEvent,
            this.buildObjectiveHandoffEvent({
              state,
              status: "blocked",
              summary: effect.summary,
              blocker: effect.reason,
              sourceUpdatedAt: blockedAt,
            }),
          ]);
        }
        return "applied";
      default:
        return "applied";
    }
  }

  async reactObjective(objectiveId: string): Promise<void> {
    await reactFactoryObjective(objectiveId, {
      getObjectiveState: (targetObjectiveId) => this.getObjectiveState(targetObjectiveId),
      isTerminalObjectiveStatus: (status) => this.isTerminalObjectiveStatus(status),
      rebalanceObjectiveSlots: () => this.rebalanceObjectiveSlots(),
      syncFailedActiveTasks: (state) => this.syncFailedActiveTasks(state),
      redriveQueuedActiveTasks: (state) => this.redriveQueuedActiveTasks(state),
      stampCircuitBrokenTasks: (state) => this.stampCircuitBrokenTasks(state),
      derivePolicyBlockedReason: (state) => this.derivePolicyBlockedReason(state),
      buildObjectiveBlockedEvents: (state, reason) => this.buildObjectiveBlockedEvents(state, reason),
      emitObjectiveBatch: (targetObjectiveId, events, expectedPrev) => this.emitObjectiveBatch(targetObjectiveId, events, expectedPrev),
      syncInvestigationSynthesisIfReady: (state) => this.syncInvestigationSynthesisIfReady(state),
      collectObjectivePlannerFacts: (state) => this.collectObjectivePlannerFacts(state),
      applyObjectivePreparationEffects: (state, effects, facts) => this.applyObjectivePreparationEffects(state, effects, facts),
      applyObjectiveDispatchEffect: (state, effect, selection) => this.applyObjectiveDispatchEffect(state, effect, selection),
      applyObjectiveFinalEffect: (state, effect, selection) => this.applyObjectiveFinalEffect(state, effect, selection),
    });
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
      await commitFactoryTaskMemory(
        this.memoryTools,
        state,
        task,
        parsed.candidateId,
        reason,
        "blocked_isolated_runtime",
      );
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
      await materializeFactoryIsolatedTaskSupportFiles(
        parsed.workspacePath,
        this.profileRoot,
        this.workerTaskProfile(parsed.profile),
      );
    }
    const packetPresent = await this.taskPacketPresent(parsed);
    if (rebuiltPacket || !packetPresent || parsed.executionMode === "worktree") {
      await this.writeTaskPacket(state, task, parsed.candidateId, parsed.workspacePath);
    }
    const workspaceCommandEnv = await ensureFactoryWorkspaceCommandEnv({
      workspacePath: parsed.workspacePath,
      dataDir: this.dataDir,
      repoRoot: this.git.repoRoot,
      worktreesDir: this.git.worktreesDir,
    });
    const resultSchemaPath = this.taskResultSchemaPath(parsed.resultPath);
    await fs.mkdir(path.dirname(resultSchemaPath), { recursive: true });
    await fs.writeFile(
      resultSchemaPath,
      JSON.stringify(parsed.objectiveMode === "investigation" ? FACTORY_INVESTIGATION_TASK_RESULT_SCHEMA : FACTORY_TASK_RESULT_SCHEMA, null, 2),
      "utf-8",
    );
    const guidanceHistory: FactoryLiveGuidance[] = [];
    let restartCount = 0;
    let execution;
    while (true) {
      try {
        execution = await this.codexExecutor.run({
          prompt: await this.renderTaskPrompt(state, task, parsed, guidanceHistory),
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
        break;
      } catch (error) {
        if (!(error instanceof CodexControlSignalError) || error.signal.kind !== "restart") throw error;
        const guidance = parseFactoryLiveGuidance(error.signal);
        if (!guidance) throw error;
        guidanceHistory.push(guidance);
        restartCount += 1;
        const restartedAt = Date.now();
        await this.emitObjectiveBatch(parsed.objectiveId, [
          {
            type: "task.intervention.applied",
            objectiveId: parsed.objectiveId,
            taskId: parsed.taskId,
            candidateId: parsed.candidateId,
            jobId: guidance.jobId ?? parsed.workspaceId,
            guidance: guidance.guidance,
            guidanceKind: guidance.guidanceKind,
            sourceCommandIds: guidance.sourceCommandIds,
            appliedAt: guidance.appliedAt,
          },
          {
            type: "task.intervention.restarted",
            objectiveId: parsed.objectiveId,
            taskId: parsed.taskId,
            candidateId: parsed.candidateId,
            jobId: guidance.jobId ?? parsed.workspaceId,
            guidance: guidance.guidance,
            guidanceKind: guidance.guidanceKind,
            sourceCommandIds: guidance.sourceCommandIds,
            restartCount,
            restartedAt,
          },
        ]);
      }
    }
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

  private async emitTaskResultPlannerEffects(
    objectiveId: string,
    effects: ReadonlyArray<FactoryPlannerEffect>,
    opts?: {
      readonly workerHandoff?: Extract<FactoryEvent, { readonly type: "worker.handoff" }>;
    },
  ): Promise<void> {
    const events = [
      ...(opts?.workerHandoff ? [opts.workerHandoff] : []),
      ...effects.flatMap((effect): FactoryEvent[] => {
      switch (effect.type) {
        case "task.block":
          return [{
            type: "task.blocked",
            objectiveId,
            taskId: effect.taskId,
            reason: effect.reason,
            blockedAt: Date.now(),
          }];
        case "candidate.produce":
          return [{
            type: "candidate.produced",
            objectiveId,
            candidateId: effect.candidateId,
            taskId: effect.taskId,
            headCommit: effect.headCommit,
            summary: effect.summary,
            handoff: effect.handoff,
            completion: effect.completion,
            alignment: effect.alignment,
            checkResults: effect.checkResults,
            scriptsRun: effect.scriptsRun,
            artifactRefs: effect.artifactRefs,
            tokensUsed: effect.tokensUsed,
            producedAt: effect.producedAt,
          }];
        case "task.review.request":
          return [{
            type: "task.review.requested",
            objectiveId,
            taskId: effect.taskId,
            reviewRequestedAt: effect.reviewRequestedAt,
          }];
        case "candidate.review":
          return [{
            type: "candidate.reviewed",
            objectiveId,
            candidateId: effect.candidateId,
            taskId: effect.taskId,
            status: effect.status,
            summary: effect.summary,
            handoff: effect.handoff,
            reviewedAt: effect.reviewedAt,
          }];
        case "task.noop_complete":
          return [{
            type: "task.noop_completed",
            objectiveId,
            taskId: effect.taskId,
            candidateId: effect.candidateId,
            summary: effect.summary,
            completedAt: effect.completedAt,
          }];
        default:
          return [];
      }
      }),
    ] satisfies ReadonlyArray<FactoryEvent>;
    await this.emitObjectiveBatch(objectiveId, events);
  }

  private canAutonomouslyResolveDeliveryPartial(input: {
    readonly completion: FactoryTaskCompletionRecord;
    readonly scriptsRun: ReadonlyArray<FactoryExecutionScriptRun>;
    readonly nextAction?: string;
    readonly failedCheck?: FactoryCheckResult;
  }): boolean {
    if (input.failedCheck) return false;
    if (input.completion.changed.length === 0) return false;
    if (input.completion.proof.length === 0) return false;
    if (input.scriptsRun.some((item) => item.status === "error")) return false;
    const unresolved = [
      ...input.completion.remaining,
      ...(input.nextAction ? [input.nextAction] : []),
    ]
      .map((item) => trimmedString(item))
      .filter((item): item is string => Boolean(item));
    return unresolved.every((item) => CONTROLLER_RESOLVABLE_DELIVERY_PARTIAL_RE.test(item));
  }

  private buildWorkerHandoffEvent(input: {
    readonly objectiveId: string;
    readonly scope: FactoryWorkerHandoffScope;
    readonly workerType: FactoryWorkerType;
    readonly outcome: FactoryWorkerHandoffOutcome;
    readonly summary: string;
    readonly handoff: string;
    readonly handedOffAt: number;
    readonly taskId?: string;
    readonly candidateId?: string;
  }): Extract<FactoryEvent, { readonly type: "worker.handoff" }> {
    return {
      type: "worker.handoff",
      objectiveId: input.objectiveId,
      scope: input.scope,
      workerType: input.workerType,
      outcome: input.outcome,
      summary: input.summary,
      handoff: input.handoff,
      handedOffAt: input.handedOffAt,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.candidateId ? { candidateId: input.candidateId } : {}),
    };
  }

  private defaultObjectiveHandoffNextAction(
    state: FactoryState,
    status: FactoryObjectiveHandoffStatus,
  ): string | undefined {
    if (status === "completed" || status === "canceled") return undefined;
    if (status === "failed") return "Inspect the failure details, react with guidance, or cancel the objective.";
    return state.objectiveMode === "investigation"
      ? "Review the blocking receipt, adjust the investigation, or cancel the objective."
      : "Review the blocking receipt and react or cancel the objective.";
  }

  private buildObjectiveHandoffEvent(input: {
    readonly state: FactoryState;
    readonly status: FactoryObjectiveHandoffStatus;
    readonly summary: string;
    readonly output?: string;
    readonly sourceUpdatedAt: number;
    readonly blocker?: string;
    readonly nextAction?: string;
  }): Extract<FactoryEvent, { readonly type: "objective.handoff" }> {
    const effectiveNextAction = optionalTrimmedString(input.nextAction)
      ?? this.defaultObjectiveHandoffNextAction(input.state, input.status);
    const handoffKey = createHash("sha1")
      .update(JSON.stringify({
        objectiveId: input.state.objectiveId,
        status: input.status,
        summary: input.summary,
        blocker: input.blocker,
        nextAction: effectiveNextAction,
        sourceUpdatedAt: input.sourceUpdatedAt,
      }))
      .digest("hex")
      .slice(0, 16);
    return {
      type: "objective.handoff",
      objectiveId: input.state.objectiveId,
      title: input.state.title,
      status: input.status,
      summary: input.summary,
      ...(input.output ? { output: input.output } : {}),
      ...(input.blocker ? { blocker: input.blocker } : {}),
      ...(effectiveNextAction ? { nextAction: effectiveNextAction } : {}),
      handoffKey,
      sourceUpdatedAt: input.sourceUpdatedAt,
    };
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
    const explicitHandoff = optionalTrimmedString(rawResult.handoff) ?? nextAction ?? effectiveSummary;
    const handoff = [explicitHandoff, workerArtifactSummary, artifactIssueSummary]
      .filter(Boolean)
      .join("\n\n") || effectiveSummary;
    const workerHandoff = this.buildWorkerHandoffEvent({
      objectiveId: payload.objectiveId,
      scope: "task",
      workerType: task.workerType,
      taskId: payload.taskId,
      candidateId: payload.candidateId,
      outcome,
      summary: effectiveSummary,
      handoff,
      handedOffAt: completedAt,
    });
    const initialCompletion = normalizeTaskCompletionRecord(
      rawResult.completion,
      buildDefaultTaskCompletion({
        summary: effectiveSummary,
        workerArtifacts,
        scriptsRun,
      }),
    );
    const initialAlignment = state.objectiveMode === "delivery"
      ? normalizeTaskAlignmentRecord(
          rawResult.alignment,
          this.defaultDeliveryAlignment(state, initialCompletion),
        )
      : undefined;

    if (outcome === "blocked" && !hasStructuredInvestigationReport) {
      await commitFactoryTaskMemory(
        this.memoryTools,
        state,
        task,
        payload.candidateId,
        renderDeliveryResultText({
          summary: effectiveSummary,
          handoff,
          scriptsRun,
          completion: initialCompletion,
          alignment: initialAlignment,
        }),
        outcome,
      );
      await this.emitTaskResultPlannerEffects(payload.objectiveId, planTaskResult({
        taskId: payload.taskId,
        candidateId: payload.candidateId,
        outcome,
        workspaceDirty: false,
        hasFailedCheck: false,
        blockedReason: handoff,
        candidate: {
          headCommit: payload.baseCommit,
          summary: effectiveSummary,
          handoff,
          completion: initialCompletion,
          alignment: initialAlignment,
          checkResults: [],
          scriptsRun,
          artifactRefs: {},
          producedAt: completedAt,
        },
        review: {
          status: "changes_requested",
          summary: effectiveSummary,
          handoff,
          reviewedAt: completedAt,
        },
      }), {
        workerHandoff,
      });
      return;
    }

    const status = await factoryTaskWorkspaceStatus({
      workspacePath: payload.workspacePath,
      executionMode: payload.executionMode,
      git: this.git,
    });
    const checkResults = isInvestigation
      ? []
      : await runFactoryChecks({
        commands: state.checks,
        workspacePath: payload.workspacePath,
        dataDir: this.dataDir,
        repoRoot: this.git.repoRoot,
        worktreesDir: this.git.worktreesDir,
      });
    const failedCheck = checkResults.find((check) => !check.ok);

    if (payload.executionMode === "isolated" && !isInvestigation) {
      const reason = `factory task ran in isolated runtime and cannot produce an integration commit: ${effectiveSummary}`;
      await commitFactoryTaskMemory(
        this.memoryTools,
        state,
        task,
        payload.candidateId,
        renderDeliveryResultText({
          summary: effectiveSummary,
          handoff,
          scriptsRun,
          completion: initialCompletion,
          alignment: initialAlignment,
        }),
        "blocked_isolated_runtime",
      );
      await this.emitTaskResultPlannerEffects(payload.objectiveId, planTaskResult({
        taskId: payload.taskId,
        candidateId: payload.candidateId,
        outcome,
        workspaceDirty: false,
        hasFailedCheck: false,
        blockedReason: reason,
        candidate: {
          headCommit: payload.baseCommit,
          summary: effectiveSummary,
          handoff,
          completion: initialCompletion,
          alignment: initialAlignment,
          checkResults,
          scriptsRun,
          artifactRefs: {},
          producedAt: completedAt,
        },
        review: {
          status: "changes_requested",
          summary: effectiveSummary,
          handoff,
          reviewedAt: completedAt,
        },
      }), {
        workerHandoff,
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
      ...(payload.contextSummaryPath ? { contextSummary: fileRef(payload.contextSummaryPath, "task context summary") } : {}),
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
      await this.emitObjectiveBatch(payload.objectiveId, [
        workerHandoff,
        {
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
        },
      ]);
      await commitFactoryTaskMemory(
        this.memoryTools,
        state,
        task,
        payload.candidateId,
        renderInvestigationReportText(
          effectiveSummary,
          reportWithChecks,
          investigationCompletion,
          [resultRefs],
          handoff,
        ),
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
    const deliveryContract = this.objectiveContractForState(state);
    const deliveryAlignment = normalizeTaskAlignmentRecord(
      rawResult.alignment,
      this.defaultDeliveryAlignment(state, deliveryCompletion),
    );
    const controllerResolvedPartial = outcome === "partial"
      && this.canAutonomouslyResolveDeliveryPartial({
        completion: deliveryCompletion,
        scriptsRun,
        nextAction,
        failedCheck,
      });
    const effectiveDeliveryCompletion = controllerResolvedPartial
      ? {
          ...deliveryCompletion,
          proof: [...new Set([...deliveryCompletion.proof, "Controller reran the configured checks successfully."])],
          remaining: [],
        } satisfies FactoryTaskCompletionRecord
      : deliveryCompletion;
    const controllerResolvedPartialSummary = controllerResolvedPartial
      ? `${effectiveSummary} Controller verification cleared the partial delivery handoff after rerunning the configured checks.`
      : effectiveSummary;
    const controllerResolvedPartialHandoff = controllerResolvedPartial
      ? `${handoff}\n\nController verification reran the configured checks successfully and resolved the remaining validation/cleanup notes.`
      : handoff;

    const resultRefs = {
      ...baseResultRefs,
      ...(committed ? { commit: commitRef(committed.hash, "candidate commit") } : {}),
    } satisfies Readonly<Record<string, GraphRef>>;

    let reviewStatus: Extract<FactoryCandidateStatus, "approved" | "changes_requested" | "rejected"> =
      outcome === "changes_requested" || outcome === "partial" ? "changes_requested" : "approved";
    let reviewSummary = controllerResolvedPartialSummary;
    let reviewHandoff = controllerResolvedPartialHandoff;
    let plannerOutcome = controllerResolvedPartial ? "approved" : outcome;
    let candidateSummary = controllerResolvedPartialSummary;
    let candidateHandoff = controllerResolvedPartialHandoff;
    if (controllerResolvedPartial) {
      reviewStatus = "approved";
    }
    const alignmentCorrectionAttempted = Boolean(
      task.sourceTaskId
      || task.prompt.includes(ALIGNMENT_CORRECTION_NOTE_PREFIX),
    );
    if (deliveryAlignment.verdict !== "aligned") {
      const alignmentDetail = [
        `Objective contract alignment is ${deliveryAlignment.verdict}.`,
        deliveryAlignment.missing.length > 0
          ? `Missing: ${deliveryAlignment.missing.join(" | ")}`
          : undefined,
        deliveryAlignment.outOfScope.length > 0
          ? `Out-of-scope: ${deliveryAlignment.outOfScope.join(" | ")}`
          : undefined,
        `Rationale: ${deliveryAlignment.rationale}`,
      ].filter((item): item is string => Boolean(item)).join(" ");
      candidateSummary = `${candidateSummary} ${alignmentDetail}`.trim();
      candidateHandoff = `${candidateHandoff}\n\n${alignmentDetail}`.trim();
      reviewSummary = candidateSummary;
      reviewHandoff = candidateHandoff;
      reviewStatus = "changes_requested";
      plannerOutcome = "changes_requested";
      if (!alignmentCorrectionAttempted) {
        await this.addObjectiveNote(payload.objectiveId, renderAlignmentCorrectionNote({
          taskId: payload.taskId,
          alignment: deliveryAlignment,
          contract: deliveryContract,
        }));
      }
    }
    if (failedCheck) {
      const classification = await classifyFactoryFailedCheck({
        state,
        check: failedCheck,
        baseHash: payload.baseCommit,
        dataDir: this.dataDir,
        git: this.git,
        baselineCheckCache: this.baselineCheckCache,
      });
      const inheritedOnly = classification.inherited;
      reviewStatus = inheritedOnly && plannerOutcome === "approved" ? "approved" : "changes_requested";
      reviewSummary = inheritedOnly
        ? `${candidateSummary} (checks only reproduced an inherited failure in ${failedCheck.command})`
        : `Verification failed: ${failedCheck.command}`;
      reviewHandoff = inheritedOnly
        ? `${candidateHandoff}\n\n${buildInheritedFactoryFailureNote(failedCheck, classification)}`
        : candidateHandoff;
    }
    const reworkBlockedReason = reviewStatus === "changes_requested"
      ? (
          deliveryAlignment.verdict !== "aligned" && alignmentCorrectionAttempted
            ? [
                `Alignment gate blocked: ${payload.taskId} is still ${deliveryAlignment.verdict} after one corrective pass.`,
                deliveryAlignment.missing.length > 0
                  ? `Missing contract items: ${deliveryAlignment.missing.join(" | ")}.`
                  : undefined,
                deliveryAlignment.outOfScope.length > 0
                  ? `Out-of-scope work: ${deliveryAlignment.outOfScope.join(" | ")}.`
                  : undefined,
              ].filter((item): item is string => Boolean(item)).join(" ")
            : this.reworkPassCapReason(
                payload.taskId,
                state.candidatePassesByTask[payload.taskId] ?? 0,
                state.policy.budgets.maxCandidatePassesPerTask,
              )
        )
      : undefined;

    const plannerInput: FactoryTaskResultPlannerInput = {
      taskId: payload.taskId,
      candidateId: payload.candidateId,
      outcome: plannerOutcome,
      workspaceDirty: status.dirty,
      hasFailedCheck: Boolean(failedCheck),
      reworkBlockedReason,
      candidate: {
        headCommit: committed?.hash ?? payload.baseCommit,
        summary: candidateSummary,
        handoff: candidateHandoff,
        completion: effectiveDeliveryCompletion,
        alignment: deliveryAlignment,
        checkResults,
        scriptsRun,
        artifactRefs: resultRefs,
        tokensUsed: typeof rawResult.tokensUsed === "number" ? rawResult.tokensUsed : undefined,
        producedAt: completedAt,
      },
      review: {
        status: reviewStatus,
        summary: reviewSummary,
        handoff: reviewHandoff,
        reviewedAt: completedAt,
      },
    };
    await this.emitTaskResultPlannerEffects(payload.objectiveId, planTaskResult(plannerInput), {
      workerHandoff,
    });
    await commitFactoryTaskMemory(
      this.memoryTools,
      state,
      task,
      payload.candidateId,
      renderDeliveryResultText({
        summary: reviewSummary,
        handoff: reviewHandoff,
        scriptsRun,
        completion: effectiveDeliveryCompletion,
        alignment: deliveryAlignment,
      }),
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
    const results = await runFactoryChecks({
      commands: parsed.checks,
      workspacePath: parsed.workspacePath,
      dataDir: this.dataDir,
      repoRoot: this.git.repoRoot,
      worktreesDir: this.git.worktreesDir,
    });
    const failed = results.find((result) => !result.ok);
    const raw = JSON.stringify({ results }, null, 2);
    await fs.mkdir(path.dirname(parsed.resultPath), { recursive: true });
    await fs.writeFile(parsed.resultPath, raw, "utf-8");
    await fs.writeFile(parsed.stdoutPath, results.map((result) => result.stdout).join("\n"), "utf-8");
    await fs.writeFile(parsed.stderrPath, results.map((result) => result.stderr).join("\n"), "utf-8");
    if (failed) {
      const classification = await classifyFactoryFailedCheck({
        state,
        check: failed,
        baseHash: state.integration.headCommit ?? state.baseHash,
        dataDir: this.dataDir,
        git: this.git,
        baselineCheckCache: this.baselineCheckCache,
      });
      if (classification.inherited) {
        const head = await this.git.worktreeStatus(parsed.workspacePath);
        const summary = `Integration checks only reproduced inherited failures for ${parsed.candidateId}.`;
        const validatedAt = Date.now();
        await this.emitObjectiveBatch(parsed.objectiveId, [
          this.buildWorkerHandoffEvent({
            objectiveId: parsed.objectiveId,
            scope: "integration_validation",
            workerType: "integration.validate",
            candidateId: parsed.candidateId,
            outcome: "validated",
            summary,
            handoff: `${summary} Controller may continue because the failure is inherited.`,
            handedOffAt: validatedAt,
          }),
          {
            type: "integration.validated",
            objectiveId: parsed.objectiveId,
            candidateId: parsed.candidateId,
            headCommit: head.head ?? state.integration.headCommit ?? state.baseHash,
            validationResults: results,
            summary,
            validatedAt,
          },
        ]);
        await commitFactoryIntegrationMemory(
          this.memoryTools,
          state,
          parsed.candidateId,
          {
            summary,
            handoff: `${summary} Controller may continue because the failure is inherited.`,
            details: [buildInheritedFactoryFailureNote(failed, classification)],
            tags: ["integration", "validated", "inherited_failures"],
          },
        );
        await this.reactObjective(parsed.objectiveId);
        return { objectiveId: parsed.objectiveId, candidateId: parsed.candidateId, status: "completed" };
      }
      const conflictedAt = Date.now();
      const reason = `integration validation failed: ${failed.command}`;
      const blockedSummary = `Integration validation failed for ${parsed.candidateId}. React with the next task attempt once the fix is clear.`;
      await commitFactoryIntegrationMemory(this.memoryTools, state, parsed.candidateId, {
        summary: reason,
        handoff: blockedSummary,
        tags: ["integration", "failed"],
      });
      const blockedEvent = {
        type: "objective.blocked" as const,
        objectiveId: parsed.objectiveId,
        reason: `Integration validation failed for ${parsed.candidateId}: ${failed.command}`,
        summary: blockedSummary,
        blockedAt: conflictedAt,
      };
      await this.emitObjectiveBatch(parsed.objectiveId, [
        this.buildWorkerHandoffEvent({
          objectiveId: parsed.objectiveId,
          scope: "integration_validation",
          workerType: "integration.validate",
          candidateId: parsed.candidateId,
          outcome: "failed",
          summary: reason,
          handoff: blockedSummary,
          handedOffAt: conflictedAt,
        }),
        {
          type: "integration.conflicted",
          objectiveId: parsed.objectiveId,
          candidateId: parsed.candidateId,
          reason,
          conflictedAt,
        },
        blockedEvent,
        this.buildObjectiveHandoffEvent({
          state,
          status: "blocked",
          summary: blockedSummary,
          blocker: blockedEvent.reason,
          sourceUpdatedAt: conflictedAt,
        }),
      ]);
      await this.reactObjective(parsed.objectiveId);
      return { objectiveId: parsed.objectiveId, candidateId: parsed.candidateId, status: "failed" };
    }
    const head = await this.git.worktreeStatus(parsed.workspacePath);
    const validatedAt = Date.now();
    const summary = `Integration checks passed for ${parsed.candidateId}.`;
    await this.emitObjectiveBatch(parsed.objectiveId, [
      this.buildWorkerHandoffEvent({
        objectiveId: parsed.objectiveId,
        scope: "integration_validation",
        workerType: "integration.validate",
        candidateId: parsed.candidateId,
        outcome: "validated",
        summary,
        handoff: `${summary} Controller may continue toward promotion.`,
        handedOffAt: validatedAt,
      }),
      {
        type: "integration.validated",
        objectiveId: parsed.objectiveId,
        candidateId: parsed.candidateId,
        headCommit: head.head ?? state.integration.headCommit ?? state.baseHash,
        validationResults: results,
        summary,
        validatedAt,
      },
    ]);
    await commitFactoryIntegrationMemory(this.memoryTools, state, parsed.candidateId, {
      summary,
      handoff: `${summary} Controller may continue toward promotion.`,
      tags: ["integration", "validated"],
    });
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
    const workspace = await ensureFactoryTaskRuntime({
      dataDir: this.dataDir,
      executionMode,
      git: this.git,
      profile: this.workerTaskProfile(profile),
      profileRoot: this.profileRoot,
      workspaceId,
      workerType,
      baseHash: dispatchBaseCommit,
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
      contextSummaryPath: manifest.contextSummaryPath,
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

    // Dispatch monitor job alongside codex task
    const monitorJobId = `job_factory_monitor_${state.objectiveId}_${task.taskId}_${candidateId}`;
    const monitorPayload: FactoryMonitorJobPayload = {
      kind: "factory.task.monitor",
      objectiveId: state.objectiveId,
      taskId: task.taskId,
      candidateId,
      codexJobId: jobId,
      stdoutPath: manifest.stdoutPath,
      stderrPath: manifest.stderrPath,
      taskPrompt: task.prompt,
      splitDepth: task.splitDepth ?? 0,
    };
    await this.queue.enqueue({
      jobId: monitorJobId,
      agentId: "codex",
      lane: "collect",
      sessionKey: `factory:monitor:${state.objectiveId}:${task.taskId}`,
      singletonMode: "allow",
      maxAttempts: 1,
      payload: monitorPayload,
    });
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
    if (candidate?.integrationDisposition === "noop") return;
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
      if (await this.scheduleTransientObjectiveReconcile(state, {
        operation: `merge integration ${candidateId}`,
        selectedActionId: `retry_merge_integration_${candidateId}`,
        frontierTaskIds: [candidate.taskId],
      }, err)) {
        return;
      }
      await this.emitObjective(state.objectiveId, {
        type: "candidate.conflicted",
        objectiveId: state.objectiveId,
        candidateId,
        reason: message,
        conflictedAt: Date.now(),
      });
      const blockedAt = Date.now();
      const blockedEvent = {
        type: "objective.blocked" as const,
        objectiveId: state.objectiveId,
        reason: `Integration merge conflicted for ${candidateId}: ${message}`,
        summary: `Integration merge conflicted for ${candidateId}. React with the next task attempt after deciding how to resolve it.`,
        blockedAt,
      };
      await this.emitObjectiveBatch(state.objectiveId, [
        {
          type: "integration.conflicted",
          objectiveId: state.objectiveId,
          candidateId,
          reason: message,
          conflictedAt: blockedAt,
        },
        blockedEvent,
        this.buildObjectiveHandoffEvent({
          state,
          status: "blocked",
          summary: blockedEvent.summary,
          blocker: blockedEvent.reason,
          sourceUpdatedAt: blockedAt,
        }),
      ]);
      await commitFactoryIntegrationMemory(this.memoryTools, state, candidateId, {
        summary: `Integration merge conflicted for ${candidateId}: ${message}`,
        handoff: blockedEvent.summary,
        tags: ["integration", "conflicted"],
      });
      await this.reactObjective(state.objectiveId);
    }
  }

  private async enqueueIntegrationValidation(
    objectiveId: string,
    candidateId: string,
    workspacePath: string,
    checks: ReadonlyArray<string>,
  ): Promise<void> {
    const files = buildIntegrationFilePaths(workspacePath, candidateId);
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
    const candidate = state.candidates[parsed.candidateId];
    const candidateTask = candidate ? state.workflow.tasksById[candidate.taskId] : undefined;
    const chain = await this.runtime.chain(objectiveStream(parsed.objectiveId));
    const recentContextReceipts = [...chain]
      .reverse()
      .filter((receipt) => {
        const ref = this.receiptTaskOrCandidateId(receipt.body);
        return ref.candidateId === parsed.candidateId
          || (candidate?.taskId ? ref.taskId === candidate.taskId : false)
          || receipt.body.type.startsWith("integration.")
          || receipt.body.type === "merge.applied"
          || receipt.body.type === "rebracket.applied";
      })
      .slice(0, 12)
      .reverse()
      .map((receipt) => `- ${receipt.body.type}: ${this.summarizeReceipt(receipt.body)}`);
    const [objectiveMemorySummary, integrationMemorySummary, publishMemorySummary] = await Promise.all([
      summarizeFactoryMemoryScope({
        memoryTools: this.memoryTools,
        scope: `factory/objectives/${parsed.objectiveId}`,
        query: state.title,
        maxChars: 360,
        operation: "summarize-scope",
      }),
      summarizeFactoryMemoryScope({
        memoryTools: this.memoryTools,
        scope: `factory/objectives/${parsed.objectiveId}/integration`,
        query: `${state.title}\nintegration`,
        maxChars: 320,
        operation: "summarize-scope",
      }),
      summarizeFactoryMemoryScope({
        memoryTools: this.memoryTools,
        scope: `factory/objectives/${parsed.objectiveId}/publish`,
        query: `${state.title}\npublish`,
        maxChars: 260,
        operation: "summarize-scope",
      }),
    ]);

    const workspaceCommandEnv = await ensureFactoryWorkspaceCommandEnv({
      workspacePath: parsed.workspacePath,
      dataDir: this.dataDir,
      repoRoot: this.git.repoRoot,
      worktreesDir: this.git.worktreesDir,
    });
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
          "## Context Snapshot",
          candidateTask ? `Task: ${candidateTask.taskId} · ${candidateTask.title}` : "Task: unknown",
          candidate?.summary ? `Candidate summary: ${candidate.summary}` : "",
          candidate?.handoff ? `Candidate handoff: ${candidate.handoff}` : "",
          state.integration.lastSummary ? `Integration summary: ${state.integration.lastSummary}` : "",
          objectiveMemorySummary ? `Objective memory: ${objectiveMemorySummary}` : "",
          integrationMemorySummary ? `Integration memory: ${integrationMemorySummary}` : "",
          publishMemorySummary ? `Publish memory: ${publishMemorySummary}` : "",
          recentContextReceipts.length > 0 ? "Recent objective receipts:" : "",
          ...recentContextReceipts,
          "",
          "## Publish Contract",
          `Use \`receipt memory summarize factory/objectives/${parsed.objectiveId}\` and \`receipt inspect factory/objectives/${parsed.objectiveId}\` before writing the PR body.`,
          "Inspect `git remote -v`, push the current branch to a GitHub remote (prefer `origin` when present), open the PR with gh, then fetch the final PR metadata from the current branch.",
          "Before creating a new PR, check whether the current branch already has one with `gh pr view --json url,number,headRefName,baseRefName`.",
          "If `git push`, `gh pr create`, or `gh pr view` fail with a transient GitHub or network error, retry the command up to two more times with short backoff. After a failed `gh pr create`, check `gh pr view` once before concluding the PR was not created.",
          "Do not run builds or tests.",
          "Return exactly one JSON object matching this schema:",
          `{"summary":"short publish summary","handoff":"explicit publish handoff for the controller","prUrl":"https://github.com/...","prNumber":123,"headRefName":"branch-name","baseRefName":"main"}`,
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
      await commitFactoryPublishMemory(this.memoryTools, state, parsed.candidateId, {
        summary,
        handoff: publishResult.handoff,
        details: [
          `PR: ${publishResult.prUrl}`,
          publishResult.headRefName ? `Head ref: ${publishResult.headRefName}` : "",
          publishResult.baseRefName ? `Base ref: ${publishResult.baseRefName}` : "",
        ].filter(Boolean),
        tags: ["publish", "succeeded"],
      });
      const promotedAt = Date.now();
      await this.emitObjectiveBatch(parsed.objectiveId, [
        this.buildWorkerHandoffEvent({
          objectiveId: parsed.objectiveId,
          scope: "integration_publish",
          workerType: "integration.publish",
          candidateId: parsed.candidateId,
          outcome: "published",
          summary,
          handoff: publishResult.handoff,
          handedOffAt: promotedAt,
        }),
        {
          type: "integration.promoted",
          objectiveId: parsed.objectiveId,
          candidateId: parsed.candidateId,
          promotedCommit: state.integration.headCommit ?? state.baseHash,
          summary,
          prUrl: publishResult.prUrl,
          prNumber: publishResult.prNumber ?? undefined,
          headRefName: publishResult.headRefName ?? undefined,
          baseRefName: publishResult.baseRefName ?? undefined,
          promotedAt,
        },
        {
          type: "objective.completed",
          objectiveId: parsed.objectiveId,
          summary,
          completedAt: promotedAt,
        },
        this.buildObjectiveHandoffEvent({
          state,
          status: "completed",
          summary,
          sourceUpdatedAt: promotedAt,
        }),
      ]);
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
      await commitFactoryPublishMemory(this.memoryTools, state, parsed.candidateId, {
        summary: reason,
        handoff: reason,
        tags: ["publish", "failed"],
      });
      const blockedAt = Date.now();
      const blockedEvent = {
        type: "objective.blocked" as const,
        objectiveId: parsed.objectiveId,
        reason,
        summary: reason,
        blockedAt,
      };
      await this.emitObjectiveBatch(parsed.objectiveId, [
        this.buildWorkerHandoffEvent({
          objectiveId: parsed.objectiveId,
          scope: "integration_publish",
          workerType: "integration.publish",
          candidateId: parsed.candidateId,
          outcome: "failed",
          summary: reason,
          handoff: reason,
          handedOffAt: blockedAt,
        }),
        {
          type: "integration.conflicted",
          objectiveId: parsed.objectiveId,
          candidateId: parsed.candidateId,
          reason,
          headCommit: state.integration.headCommit ?? state.baseHash,
          conflictedAt: blockedAt,
        },
        blockedEvent,
        this.buildObjectiveHandoffEvent({
          state,
          status: "blocked",
          summary: reason,
          blocker: blockedEvent.reason,
          sourceUpdatedAt: blockedAt,
        }),
      ]);
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
    const candidate = state.candidates[candidateId];
    const workspace = await this.git.ensureIntegrationWorkspace(state.objectiveId, state.integration.headCommit ?? state.baseHash);
    const status = await this.git.worktreeStatus(workspace.path);
    const commit = status.head ?? state.integration.headCommit;
    if (!commit) throw new FactoryServiceError(409, "integration branch has no HEAD to promote");
    const publishSkillPaths = [...new Set([
      ...(candidate?.taskId ? state.workflow.tasksById[candidate.taskId]?.skillBundlePaths ?? [] : []),
      path.join(this.git.repoRoot, "skills", "factory-pr-publisher", "SKILL.md"),
    ])];
    const publishContextRefs = (() => {
      const refs = [
        stateRef(objectiveStream(state.objectiveId), "factory objective stream"),
        workspaceRef(workspace.path, "integration workspace"),
        ...(candidate?.taskId ? state.workflow.tasksById[candidate.taskId]?.contextRefs ?? [] : []),
        ...Object.values(candidate?.artifactRefs ?? {}),
      ];
      const seen = new Set<string>();
      return refs.filter((ref) => {
        const key = `${ref.kind}:${ref.ref}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    })();
    await this.emitObjectiveBatch(state.objectiveId, [
      ...(opts?.prefixEvents ?? []),
      {
        type: "integration.promoting",
        objectiveId: state.objectiveId,
        candidateId,
        startedAt: Date.now(),
      },
    ], opts?.expectedPrev);

    const files = buildIntegrationFilePaths(workspace.path, "publish");
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
      contextRefs: publishContextRefs,
      skillBundlePaths: publishSkillPaths,
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

  private async buildObjectiveCard(
    state: FactoryState,
    queuePosition?: number,
    receipts?: ReadonlyArray<FactoryObjectiveReceiptSummary>,
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
        ? summarizeObjectiveReceipts(await this.runtime.chain(objectiveStream(state.objectiveId)), {
          limit: 60,
          summarizeReceipt: (event) => this.summarizeReceipt(event),
          receiptTaskOrCandidateId: (event) => this.receiptTaskOrCandidateId(event),
        })
        : []);
    const slotState = (this.isTerminalObjectiveStatus(state.status) || this.releasesObjectiveSlot(state) || state.scheduler.releasedAt)
      ? "released"
      : (state.scheduler.slotState ?? "active");
    const tokensUsed = Object.values(state.candidates).reduce((sum, c) => sum + (c.tokensUsed ?? 0), 0);
    const contract = this.objectiveContractForState(state);
    const alignment = this.objectiveAlignmentForState(state);
    const card = buildObjectiveCardRecord({
      state,
      queuePosition,
      slotState,
      blockedExplanation: needsBlockedReceipts
        ? buildBlockedExplanation(state, resolvedReceipts)
        : undefined,
      latestDecision: this.deriveLatestDecision(state),
      nextAction: this.deriveNextAction(state, queuePosition),
      activeTaskCount: projection.activeTasks.length,
      readyTaskCount: projection.readyTasks.length,
      taskCount: projection.tasks.length,
      latestCommitHash: state.integration.promotedCommit ?? state.integration.headCommit ?? latestCandidate?.headCommit,
      contract,
      alignment,
      tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
      profile: this.objectiveProfileForState(state),
      phase: this.deriveObjectivePhase(state, {
        activeTasks: projection.activeTasks.length,
        readyTasks: projection.readyTasks.length,
      }),
    });
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
    const receipts = summarizeObjectiveReceipts(chain, {
      limit: 60,
      summarizeReceipt: (event) => this.summarizeReceipt(event),
      receiptTaskOrCandidateId: (event) => this.receiptTaskOrCandidateId(event),
    });
    const sharedArtifactRefs = [
      artifactRef(this.objectiveProfileArtifactPath(state.objectiveId), "objective profile snapshot"),
      artifactRef(this.objectiveSkillSelectionArtifactPath(state.objectiveId), "objective profile skills"),
    ];
    const tasks = await Promise.all(
      state.workflow.taskIds.map(async (taskId) => {
        const task = state.workflow.tasksById[taskId];
        const job = task?.jobId ? await this.loadFreshJob(task.jobId) : undefined;
        const workspaceStatus = task?.workspacePath
          ? await factoryTaskWorkspaceStatus({
            workspacePath: task.workspacePath,
            executionMode: task.executionMode ?? this.taskExecutionMode(state, task),
            git: this.git,
          })
          : { exists: false, dirty: false };
        const filePaths = task?.workspacePath ? buildTaskFilePaths(task.workspacePath, task.taskId) : undefined;
        const artifactActivity = task?.workspacePath
          ? await listTaskArtifactActivity(
            task.workspacePath,
            task.taskId,
            (resultPath) => this.taskResultSchemaPath(resultPath),
          )
          : [];
        const artifactSummary = summarizeTaskArtifactActivity(artifactActivity);
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
          contextSummaryPath: filePaths?.contextSummaryPath,
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
      evidenceCards: buildObjectiveEvidenceCards(receipts),
      activity: buildObjectiveActivity(tasks, objectiveJobs, receipts),
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
          ? await factoryTaskWorkspaceStatus({
            workspacePath: task.workspacePath,
            executionMode: task.executionMode ?? this.taskExecutionMode(state, task),
            git: this.git,
          })
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
      recentReceipts: summarizeObjectiveReceipts(chain, {
        limit: 40,
        summarizeReceipt: (event) => this.summarizeReceipt(event),
        receiptTaskOrCandidateId: (event) => this.receiptTaskOrCandidateId(event),
      }).map((receipt) => ({
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
        const files = buildTaskFilePaths(task.workspacePath, task.taskId);
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
      await syncObjectiveProjectionStream(this.dataDir, this.runtime, stream);
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
    await this.publishObjectiveProjectionRefresh(objectiveId);
  }

  private async publishObjectiveProjectionRefresh(objectiveId: string): Promise<void> {
    this.sse.publish("factory", objectiveId);
    this.sse.publish("objective-runtime", objectiveId);
    const detail = await this.getObjective(objectiveId).catch(() => undefined);
    const profileId = detail?.profile.rootProfileId?.trim();
    if (profileId) this.sse.publish("profile-board", profileId);
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
      case "worker.handoff":
        return `${event.scope} ${event.outcome} handoff: ${event.handoff}`;
      case "objective.handoff":
        return `Objective ${event.status} handoff: ${event.summary}`;
      case "task.blocked":
        return `${event.taskId} blocked: ${event.reason}`;
      case "task.unblocked":
        return `${event.taskId} unblocked`;
      case "task.noop_completed":
        return `${event.taskId} completed with no repo diff: ${event.summary}`;
      case "task.superseded":
        return `${event.taskId} superseded: ${event.reason}`;
      case "task.intervention.applied":
        return `${event.taskId} live ${event.guidanceKind} applied: ${event.guidance}`;
      case "task.intervention.restarted":
        return `${event.taskId} restarted after live ${event.guidanceKind}: ${event.guidance}`;
      case "candidate.produced":
        return `${event.candidateId} produced: ${event.handoff || event.summary}`;
      case "candidate.reviewed":
        return `${event.candidateId} ${event.status}: ${event.handoff || event.summary}`;
      case "investigation.reported":
        return `${event.taskId} ${event.outcome}: ${event.handoff || event.summary}`;
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
      case "task.noop_completed":
      case "task.blocked":
      case "task.unblocked":
      case "task.superseded":
        return "candidateId" in event
          ? { taskId: event.taskId, candidateId: event.candidateId }
          : { taskId: event.taskId };
      case "task.dispatched":
      case "task.intervention.applied":
      case "task.intervention.restarted":
        return { taskId: event.taskId, candidateId: event.candidateId };
      case "worker.handoff":
        return {
          ...(event.taskId ? { taskId: event.taskId } : {}),
          ...(event.candidateId ? { candidateId: event.candidateId } : {}),
        };
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

  private buildInvestigationOutput(state: FactoryState): string | undefined {
    const report = state.investigation.synthesized?.report
      ?? this.buildFinalInvestigationReport(state);
    const details = report.evidence
      .map((e) => e.detail ?? e.summary)
      .filter(Boolean);
    return details.length > 0 ? details.join("\n\n") : undefined;
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

  private taskPromptPath(workspacePath: string, targetPath: string): string {
    void workspacePath;
    return targetPath;
  }

  private async writeTaskPacket(
    state: FactoryState,
    task: FactoryTaskRecord,
    candidateId: string,
    workspacePath: string,
    pinnedBaseCommit?: string,
  ): Promise<{
    readonly manifestPath: string;
    readonly contextSummaryPath: string;
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
    const taskPrompt = effectiveFactoryTaskPrompt({
      profileCloudProvider: this.objectiveProfileForState(state).cloudProvider,
      objectiveMode: state.objectiveMode,
      taskPrompt: task.prompt,
    });
    const files = buildTaskFilePaths(workspacePath, task.taskId);
    await fs.mkdir(path.dirname(files.manifestPath), { recursive: true });
    await fs.rm(files.resultPath, { force: true });
    const repoSkillPaths = await this.collectRepoSkillPaths();
    const memoryScopes = buildTaskMemoryScopes(state, task, candidateId, taskPrompt);
    const contextPack = await buildFactoryTaskContextPack({
      runtime: this.runtime,
      memoryTools: this.memoryTools,
      profileRoot: this.profileRoot,
      collectRepoSkillPaths: () => this.collectRepoSkillPaths(),
      latestTaskCandidate: (inputState, taskId) => this.latestTaskCandidate(inputState, taskId),
      objectiveProfileForState: (inputState) => this.objectiveProfileForState(inputState),
      objectiveContractForState: (inputState, planning) => this.objectiveContractForState(inputState, planning),
      workerTaskProfile: (profileSnapshot) => this.workerTaskProfile(profileSnapshot),
      loadObjectiveCloudExecutionContext: (profileSnapshot) => this.loadObjectiveCloudExecutionContext(profileSnapshot),
      compactCloudExecutionContextForPacket: (context) => this.compactCloudExecutionContextForPacket(context),
      buildContextSources: (inputState, repoSkills, sharedRefs) => this.buildContextSources(inputState, repoSkills, sharedRefs),
      objectiveProfileArtifactPath: (objectiveId) => this.objectiveProfileArtifactPath(objectiveId),
      objectiveSkillSelectionArtifactPath: (objectiveId) => this.objectiveSkillSelectionArtifactPath(objectiveId),
      summarizeReceipt: (event) => this.summarizeReceipt(event),
      receiptTaskOrCandidateId: (event) => this.receiptTaskOrCandidateId(event),
      objectiveStream: (objectiveId) => objectiveStream(objectiveId),
    }, state, task, candidateId, taskPrompt);
    const objectiveContract = this.objectiveContractForState(state, contextPack.planning);
    const sharedArtifactRefs = dedupeGraphRefs(contextPack.contextSources.sharedArtifactRefs);
    const contextSummary = renderTaskContextSummary(contextPack);
    const contextRefs = dedupeGraphRefs([
      ...task.contextRefs,
      ...sharedArtifactRefs,
      artifactRef(files.contextSummaryPath, "task context summary"),
      artifactRef(files.contextPackPath, "recursive context pack"),
    ]);
    const skillBundle = {
      objectiveId: state.objectiveId,
      taskId: task.taskId,
      title: task.title,
      workerType: task.workerType,
      profile,
      selectedSkills: profile.selectedSkills,
      repoSkillPaths: dedupeStrings(repoSkillPaths),
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
      contract: objectiveContract,
      memory: {
        scriptPath: files.memoryScriptPath,
        configPath: files.memoryConfigPath,
        scopes: memoryScopes,
      },
      context: {
        summaryPath: files.contextSummaryPath,
        packPath: files.contextPackPath,
      },
      contextSources: contextPack.contextSources,
      contextRefs,
      sharedArtifactRefs,
      repoSkillPaths: dedupeStrings(repoSkillPaths),
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
      contextSummaryPath: path.basename(files.contextSummaryPath),
      contextPackPath: path.basename(files.contextPackPath),
      defaultQuery: `${state.title}\n${task.title}\n${taskPrompt}`,
      defaultLimit: 6,
      defaultMaxChars: 2400,
      scopes: memoryScopes,
    };
    await fs.writeFile(files.contextSummaryPath, contextSummary, "utf-8");
    await fs.writeFile(files.contextPackPath, JSON.stringify(contextPack, null, 2), "utf-8");
    await fs.writeFile(files.manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    await fs.writeFile(files.memoryConfigPath, JSON.stringify(memoryConfig, null, 2), "utf-8");
    await fs.writeFile(files.memoryScriptPath, buildFactoryMemoryScriptSource(files.memoryConfigPath), "utf-8");
    if (process.platform !== "win32") await fs.chmod(files.memoryScriptPath, 0o755);
    return {
      manifestPath: files.manifestPath,
      contextSummaryPath: files.contextSummaryPath,
      contextPackPath: files.contextPackPath,
      promptPath: files.promptPath,
      resultPath: files.resultPath,
      stdoutPath: files.stdoutPath,
      stderrPath: files.stderrPath,
      lastMessagePath: files.lastMessagePath,
      memoryScriptPath: files.memoryScriptPath,
      memoryConfigPath: files.memoryConfigPath,
      repoSkillPaths: dedupeStrings(repoSkillPaths),
      skillBundlePaths: [files.skillBundlePath],
      sharedArtifactRefs,
      contextRefs,
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
      summarizeFactoryMemoryScope({
        memoryTools: this.memoryTools,
        scope: repoScope,
        query: input.prompt,
        maxChars: 360,
        operation: "summarize-scope",
      }),
      summarizeFactoryMemoryScope({
        memoryTools: this.memoryTools,
        scope: profileScope,
        query: input.prompt,
        maxChars: 360,
        operation: "summarize-scope",
      }),
      summarizeFactoryMemoryScope({
        memoryTools: this.memoryTools,
        scope: workerScope,
        query: input.prompt,
        maxChars: 280,
        operation: "summarize-scope",
      }),
      input.objectiveId ? this.getObjective(input.objectiveId) : Promise.resolve(undefined),
      input.objectiveId ? this.getObjectiveDebug(input.objectiveId) : Promise.resolve(undefined),
      input.objectiveId ? this.listObjectiveReceipts(input.objectiveId, { limit: 20 }) : Promise.resolve([]),
      objectiveScope
        ? summarizeFactoryMemoryScope({
            memoryTools: this.memoryTools,
            scope: objectiveScope,
            query: input.prompt,
            maxChars: 360,
            operation: "summarize-scope",
          })
        : Promise.resolve(undefined),
      input.objectiveId
        ? summarizeFactoryMemoryScope({
            memoryTools: this.memoryTools,
            scope: `factory/objectives/${input.objectiveId}/integration`,
            query: input.prompt,
            maxChars: 360,
            operation: "summarize-scope",
          })
        : Promise.resolve(undefined),
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

    const contextPack = buildFactoryDirectCodexProbeContextPack({
      jobId: input.jobId,
      prompt: input.prompt,
      objectiveId: input.objectiveId,
      parentRunId: input.parentRunId,
      parentStream: input.parentStream,
      stream: input.stream,
      supervisorSessionId: input.supervisorSessionId,
      readOnly,
      profile,
      cloudExecutionContext: this.compactCloudExecutionContextForPacket(cloudExecutionContext),
      repoScope,
      profileScope,
      objectiveScope,
      workerScope,
      repoSkillPaths,
      helperRefs,
      helperCatalog,
      memoryScopes,
      repoMemory,
      profileMemory,
      workerMemory,
      objectiveMemory,
      integrationMemory,
      objectiveDetail,
      objectiveDebug,
    });

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

    const workspaceCommandEnv = await ensureFactoryWorkspaceCommandEnv({
      workspacePath: this.git.repoRoot,
      dataDir: this.dataDir,
      repoRoot: this.git.repoRoot,
      worktreesDir: this.git.worktreesDir,
    });
    const renderedPrompt = renderFactoryDirectCodexProbePrompt({
      prompt: input.prompt,
      readOnly,
      artifactPaths,
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
      profileSelectedSkills: profile.selectedSkills,
      repoRoot: this.git.repoRoot,
      factoryCliPrefix: FACTORY_CLI_PREFIX,
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
    guidanceHistory: ReadonlyArray<FactoryLiveGuidance> = [],
  ): Promise<string> {
    const taskPrompt = effectiveFactoryTaskPrompt({
      profileCloudProvider: this.objectiveProfileForState(state).cloudProvider,
      objectiveMode: state.objectiveMode,
      taskPrompt: task.prompt,
    });
    const includeCloudExecutionContext = taskNeedsCloudExecutionContext({
      profileCloudProvider: payload.profile.cloudProvider,
      taskTitle: task.title,
      taskPrompt,
    });
    const cloudExecutionContext = includeCloudExecutionContext
      ? await this.loadObjectiveCloudExecutionContext(payload.profile)
      : undefined;
    const helperCatalog = await loadFactoryHelperContext({
      profileRoot: this.profileRoot,
      provider: payload.profile.cloudProvider ?? cloudExecutionContext?.preferredProvider,
      objectiveTitle: state.title,
      objectivePrompt: state.prompt,
      taskTitle: task.title,
      taskPrompt,
      domain: "infrastructure",
    });
    const infrastructureTaskGuidance = cloudExecutionContext
      ? renderInfrastructureTaskExecutionGuidance({
          profileCloudProvider: payload.profile.cloudProvider,
          objectiveMode: state.objectiveMode,
          cloudExecutionContext,
        })
      : [];
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
    const memorySummary = await loadFactoryMemorySummary(
      this.memoryTools,
      `factory/objectives/${state.objectiveId}/tasks/${task.taskId}`,
      taskPrompt,
    );
    const validationSection = renderFactoryTaskValidationSection(state, task);
    const planningReceipt = state.planning ?? this.buildPlanningReceipt(state, state.updatedAt || Date.now());
    const objectiveContract = this.objectiveContractForState(state, planningReceipt);
    const manifestPathForPrompt = this.taskPromptPath(payload.workspacePath, payload.manifestPath);
    const contextSummaryPathForPrompt = payload.contextSummaryPath
      ? this.taskPromptPath(payload.workspacePath, payload.contextSummaryPath)
      : undefined;
    const contextPackPathForPrompt = this.taskPromptPath(payload.workspacePath, payload.contextPackPath);
    const memoryScriptPathForPrompt = this.taskPromptPath(payload.workspacePath, payload.memoryScriptPath);
    const resultPathForPrompt = payload.resultPath;
    const liveGuidanceSection = renderLiveOperatorGuidanceSection(guidanceHistory);
    return renderFactoryTaskPrompt({
      state,
      task,
      payload,
      taskPrompt,
      planningReceipt,
      objectiveContract,
      cloudExecutionContext,
      helperCatalog,
      infrastructureTaskGuidance,
      dependencySummaries,
      downstreamSummaries,
      memorySummary,
      validationSection,
      manifestPathForPrompt,
      contextSummaryPathForPrompt,
      contextPackPathForPrompt,
      memoryScriptPathForPrompt,
      resultPathForPrompt,
      liveGuidanceSection,
      factoryCliPrefix: FACTORY_CLI_PREFIX,
    });
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
      contextSummaryPath: optionalTrimmedString(payload.contextSummaryPath),
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
      "manifestPath" | "contextSummaryPath" | "contextPackPath" | "memoryScriptPath" | "memoryConfigPath" | "skillBundlePaths"
    >,
  ): Promise<boolean> {
    const requiredPaths = [
      payload.manifestPath,
      ...(payload.contextSummaryPath ? [payload.contextSummaryPath] : []),
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
    return runFactoryChecks({
      commands,
      workspacePath,
      dataDir: this.dataDir,
      repoRoot: this.git.repoRoot,
      worktreesDir: this.git.worktreesDir,
    });
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
