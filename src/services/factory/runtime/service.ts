import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { sqliteBranchStore, sqliteReceiptStore } from "../../../adapters/sqlite";
import type { SqliteQueue, QueueJob } from "../../../adapters/sqlite-queue";
import { CodexControlSignalError, type CodexExecutor, type CodexRunControl, type CodexRunInput, type CodexRunResult } from "../../../adapters/codex-executor";
import { HubGit } from "../../../adapters/hub-git";
import type { MemoryTools } from "../../../adapters/memory-tools";
import {
  DEFAULT_FACTORY_OBJECTIVE_POLICY,
  DEFAULT_FACTORY_OBJECTIVE_PROFILE,
  buildFactoryProjection,
  decideFactory,
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
  type FactoryProfileDispatchAction,
  type FactoryObjectiveSeverity,
  type FactoryObjectiveStatus,
  type FactoryState,
  type FactoryTaskAlignmentRecord,
  type FactoryTaskCompletionRecord,
  type FactoryTaskExecutionMode,
  type FactoryTaskExecutionPhase,
  type FactoryTaskPresentationRecord,
  type FactoryTaskResultOutcome,
  type FactoryTaskRecord,
  type FactoryWorkerHandoffOutcome,
  type FactoryWorkerHandoffScope,
  type FactoryWorkerType,
  type FactoryCandidateStatus,
  type MonitorRecommendation,
} from "../../../modules/factory";
import {
  assertFactoryProfileCreateModeAllowed,
  assertFactoryProfileDispatchActionAllowed,
  repoKeyForRoot,
  resolveFactoryChatProfile,
} from "../../factory-chat-profiles";
import {
  buildFactoryMemoryScriptSource,
  factoryChatCodexArtifactPaths,
  type FactoryChatCodexArtifactPaths,
} from "../../factory-codex-artifacts";
import {
  archiveFactoryTaskPacketArtifacts,
  archiveFactoryTaskPrompt,
} from "../../factory-task-packet-archive";
import {
  helperCatalogArtifactRefs,
  loadFactoryHelperContext,
} from "../../factory-helper-catalog";
import {
  scanFactoryCloudExecutionContext,
  type FactoryCloudExecutionContext,
} from "../../factory-cloud-context";
import { resolveFactoryCloudExecutionContext } from "../../factory-cloud-targeting";
import {
  renderInfrastructureTaskExecutionGuidance,
  taskNeedsCloudExecutionContext,
} from "../../factory-infrastructure-guidance";
import {
  buildInheritedFactoryFailureNote,
} from "../failure-policy";
import {
  buildBudgetState as buildObjectiveLifecycleBudgetState,
  deriveLatestDecision as deriveObjectiveLifecycleLatestDecision,
  deriveNextAction as deriveObjectiveLifecycleNextAction,
  deriveObjectivePhase as deriveLifecycleObjectivePhase,
  isTerminalObjectiveStatus as isLifecycleTerminalObjectiveStatus,
  objectiveElapsedMinutes as calculateObjectiveElapsedMinutes,
} from "./objective-lifecycle";
import {
  buildObjectiveSelfImprovement as buildObjectiveControlSelfImprovement,
  controlJobCancelReason as deriveControlJobCancelReason,
  objectiveConsumesRepoSlot as consumesObjectiveRepoSlot,
  releasesObjectiveProjectionSlot as releasesProjectedObjectiveSlot,
  releasesObjectiveSlot as releasesLiveObjectiveSlot,
  shouldRedriveQueuedControlJob as shouldRequeueObjectiveControlJob,
} from "./objective-control";
import {
  buildObjectiveHandoffEvent as buildTaskRunnerObjectiveHandoffEvent,
  buildWorkerHandoffEvent as buildTaskRunnerWorkerHandoffEvent,
  canAutonomouslyResolveDeliveryPartial as canTaskRunnerAutonomouslyResolveDeliveryPartial,
  isRetryablePublishFailureMessage as isTaskRunnerRetryablePublishFailureMessage,
  taskResultSchemaPath as buildTaskRunnerResultSchemaPath,
  validateTaskEvidence,
} from "./task-runner";
import {
  resolveTaskBaseCommit as resolveInvestigationTaskBaseCommit,
  taskPromptPath as buildInvestigationTaskPromptPath,
} from "./investigation";
import {
  buildFactoryPlanningReceipt,
  planningReceiptFingerprint,
} from "../planning";
import { monitorCheckpointIntervalMs, monitorDetectEvidence, runMonitorCheckpoint } from "../monitor-job";
import { MonitorCheckpointResultSchema, parseMonitorRecommendation } from "../monitor-checkpoint";
import { llmStructured, llmText } from "../../../adapters/openai";
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
  normalizeTaskPresentationRecord,
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
  type FactoryObjectiveAuditMetadata,
  readPersistedObjectiveAuditMetadata,
} from "../objective-audit-artifacts";
import {
  buildIntegrationFilePaths,
  buildTaskFilePaths,
  buildTaskMemoryScopes,
  listTaskArtifactActivity,
  listTaskReadableArtifacts,
  readTaskEvidenceContents,
  renderFactoryReceiptCliSurface,
  renderTaskContextSummary,
  summarizeTaskArtifactActivity,
  type FactoryContextPack,
  type FactoryMemoryScopeSpec,
  type FactoryReadableArtifact,
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
import {
  classifyObjectiveLiveJobAuthority,
  compareObjectiveScopedJobs,
  deriveObjectiveOperationalState,
  groupObjectiveScopedJobs,
  isTerminalQueueJobStatusValue,
  objectiveIdForQueueJob,
} from "../objective-status";
import {
  displayLiveJobStatus,
  isActiveQueueJobStatus,
  isFactoryExecutionQueueJob,
  isTerminalQueueJobStatus,
  liveExecutionSnapshotForJobs,
  liveJobStaleAt,
} from "../live-jobs";
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
import type { JobCmd, JobEvent, JobRecord, JobState } from "../../../modules/job";
import {
  listObjectiveProjectionRows,
  readObjectiveProjection,
  readObjectiveProjectionSummaries,
  syncChangedObjectiveProjections,
  syncObjectiveProjectionStream,
  type StoredObjectiveProjection,
  type StoredObjectiveProjectionSummary,
} from "../../../db/projectors";

const FACTORY_STREAM_PREFIX = "factory/objectives";
const DEFAULT_CHECKS = ["bun run build"] as const;
const DEFAULT_FACTORY_PROFILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const FACTORY_CONTROL_AGENT_ID = "factory-control";
export const FACTORY_MONITOR_AGENT_ID = "factory-monitor";
const OBJECTIVE_CONTROL_REDRIVE_AGE_MS = 30_000;
const SUPPORTED_WORKER_TYPES = new Set<FactoryWorkerType>(["codex", "agent", "infra"]);

const resolveRepoRoot = (repoRoot?: string): string =>
  repoRoot?.trim()
  || process.env.RECEIPT_REPO_ROOT?.trim()
  || process.cwd();
const FACTORY_TASK_CODEX_MODEL =
  process.env.RECEIPT_FACTORY_TASK_MODEL?.trim()
  || "gpt-5.4-mini";
const MAX_CONSECUTIVE_TASK_FAILURES = 5;
const MAX_OPEN_AUTO_FIX_OBJECTIVES = 3;
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

const READABLE_FACTORY_ARTIFACT_RE = /\.(json|md|txt|csv)$/i;
const TERMINAL_RENDER_MAX_FILE_BYTES = 32_768;
const TERMINAL_RENDER_MAX_ARTIFACTS = 6;
const TERMINAL_RENDER_TEXT_FILE_RE = /\.(?:md|markdown|txt|json|log|csv)$/i;
const FACTORY_TASK_EXECUTION_PHASE_ORDER: Readonly<Record<FactoryTaskExecutionPhase, number>> = {
  collecting_evidence: 0,
  evidence_ready: 1,
  synthesizing: 2,
};
const taskExecutionPhaseValue = (task?: FactoryTaskRecord): FactoryTaskExecutionPhase =>
  task?.executionPhase ?? "collecting_evidence";
const taskExecutionPhaseAtLeast = (
  task: FactoryTaskRecord | undefined,
  phase: FactoryTaskExecutionPhase,
): boolean => FACTORY_TASK_EXECUTION_PHASE_ORDER[taskExecutionPhaseValue(task)] >= FACTORY_TASK_EXECUTION_PHASE_ORDER[phase];
const monitorRecommendationsEqual = (
  left: MonitorRecommendation,
  right: MonitorRecommendation,
): boolean => {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "continue":
      return true;
    case "recommend_steer":
      return right.kind === "recommend_steer" && left.guidance === right.guidance;
    case "recommend_abort":
      return right.kind === "recommend_abort" && left.reason === right.reason;
    case "recommend_enter_synthesizing":
      return right.kind === "recommend_enter_synthesizing" && left.reason === right.reason;
    case "recommend_split":
      return right.kind === "recommend_split"
        && left.subtasks.length === right.subtasks.length
        && left.subtasks.every((subtask, index) => {
          const other = right.subtasks[index];
          if (!other) return false;
          const leftDependsOn = subtask.dependsOn ?? [];
          const rightDependsOn = other.dependsOn ?? [];
          return subtask.title === other.title
            && subtask.prompt === other.prompt
            && leftDependsOn.length === rightDependsOn.length
            && leftDependsOn.every((dependency, dependencyIndex) => dependency === rightDependsOn[dependencyIndex]);
        });
  }
};
const artifactKeyFromLabel = (label: string, index: number): string => {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized ? `workerArtifact_${normalized}_${index}` : `workerArtifact_${index}`;
};
const dedupeGraphRefs = (refs: ReadonlyArray<GraphRef>): ReadonlyArray<GraphRef> => {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.ref}:${ref.label ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
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

const factoryTaskRunJobId = (
  objectiveId: string,
  taskId: string,
  candidateId: string,
  taskPhase: FactoryTaskExecutionPhase,
  dispatchKey: string,
): string =>
  taskPhase === "synthesizing"
    ? `job_factory_${objectiveId}_${taskId}_${candidateId}_synthesizing_${dispatchKey}`
    : `job_factory_${objectiveId}_${taskId}_${candidateId}_${dispatchKey}`;

const factoryMonitorJobId = (
  objectiveId: string,
  taskId: string,
  candidateId: string,
  taskPhase: FactoryTaskExecutionPhase,
  dispatchKey: string,
): string =>
  taskPhase === "synthesizing"
    ? `job_factory_monitor_${objectiveId}_${taskId}_${candidateId}_synthesizing_${dispatchKey}`
    : `job_factory_monitor_${objectiveId}_${taskId}_${candidateId}_${dispatchKey}`;

const factoryDispatchKey = (): string =>
  `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const factoryRecommendationId = (
  objectiveId: string,
  taskId: string,
  candidateId: string,
  recommendedAt: number,
): string => `recommendation_${objectiveId}_${taskId}_${candidateId}_${recommendedAt.toString(36)}`;

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
    "Treat this section as highest priority. Apply it before any new inspection, parsing, or external command.",
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
const isDisplayActiveJobStatus = (status?: string): boolean =>
  status === "queued" || status === "running";

const resolveHandoffPhase = (
  taskPhase: FactoryTaskExecutionPhase | undefined,
  active: boolean,
  evidenceContents: ReadonlyArray<FactoryEvidenceContent> | undefined,
): FactoryLiveOutputHandoffPhase => {
  if (taskPhase === "synthesizing") return "synthesizing";
  if (taskPhase === "evidence_ready") return "evidence_ready";
  if (active) return "active";
  if (evidenceContents && evidenceContents.length > 0) return "evidence_ready";
  return "terminal_no_evidence";
};

const boardSectionForObjective = (
  objective: Pick<FactoryObjectiveCard, "displayState">,
): FactoryBoardSection => {
  if (objective.displayState === "Completed" || objective.displayState === "Canceled" || objective.displayState === "Archived") {
    return "completed";
  }
  if (objective.displayState === "Blocked" || objective.displayState === "Failed" || objective.displayState === "Stalled") {
    return "needs_attention";
  }
  if (objective.displayState === "Queued") return "queued";
  return "active";
};

const objectiveJobCacheKey = (jobs: ReadonlyArray<QueueJob>): string =>
  jobs
    .slice(0, 10)
    .map((job) => `${job.id}:${job.status}:${job.updatedAt}:${job.lastError ?? ""}`)
    .join("|");

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
  type FactoryTerminalRenderArtifact,
  type FactoryTerminalRenderInput,
  type FactoryTerminalRenderer,
  type FactoryObjectiveAlignmentSummary,
  type FactoryObjectiveCard,
  type FactoryObjectiveDetail,
  type FactoryComposeModel,
  type FactoryBoardSection,
  type FactoryBoardProjection,
  type FactoryLiveProjection,
  type FactoryLiveOutputTargetKind,
  type FactoryLiveOutputSnapshot,
  type FactoryLiveOutputHandoffPhase,
  type FactoryEvidenceContent,
  type FactoryDebugProjection,
  type FactoryTaskJobPayload,
  type FactoryIntegrationJobPayload,
  type FactoryIntegrationPublishJobPayload,
  type FactoryObjectiveAuditJobPayload,
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
  FactoryLiveOutputHandoffPhase,
  FactoryEvidenceContent,
  FactoryDebugProjection,
  FactoryTaskJobPayload,
  FactoryIntegrationJobPayload,
  FactoryIntegrationPublishJobPayload,
  FactoryObjectiveAuditJobPayload,
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

const isFactoryStaleObjectiveConflict = (err: unknown): boolean =>
  err instanceof FactoryStaleObjectiveError
  || (err instanceof Error && err.message.startsWith("Expected prev hash "));

const normalizeWorkerType = (value: string | undefined): FactoryWorkerType => {
  const normalized = (value ?? "codex").trim().toLowerCase() || "codex";
  return SUPPORTED_WORKER_TYPES.has(normalized) ? normalized : "codex";
};

const sandboxModeForTask = (): CodexRunInput["sandboxMode"] | undefined => undefined;

const taskOrdinalId = (index: number): string => `task_${String(index + 1).padStart(2, "0")}`;

const objectiveStream = (objectiveId: string): string => `${FACTORY_STREAM_PREFIX}/${objectiveId}`;


export class FactoryService {
  readonly dataDir: string;
  readonly queue: SqliteQueue;
  readonly jobRuntime: Runtime<JobCmd, JobEvent, JobState>;
  readonly sse: SseHub;
  readonly codexExecutor: CodexExecutor;
  readonly memoryTools?: MemoryTools;
  readonly git: HubGit;
  readonly profileRoot: string;
  private readonly repoSlotConcurrency: number;
  private readonly cloudExecutionContextProvider?: FactoryServiceOptions["cloudExecutionContextProvider"];
  private readonly redriveQueuedJob?: FactoryServiceOptions["redriveQueuedJob"];
  private readonly onObjectiveHandoff?: FactoryServiceOptions["onObjectiveHandoff"];
  private readonly terminalRenderer?: FactoryTerminalRenderer;
  private readonly baselineCheckCache = new Map<string, Promise<{
    readonly digest: string;
    readonly excerpt: string;
  } | undefined>>();
  private cloudExecutionContextPromise?: Promise<FactoryCloudExecutionContext>;

  private readonly runtime: Runtime<FactoryCmd, FactoryEvent, FactoryState>;
  private objectiveProjectionVersion = 0;
  private objectiveProjectionSummaryCache?: {
    readonly version: number;
    readonly summaries: ReadonlyArray<StoredObjectiveProjectionSummary>;
  };
  private objectiveProjectionRowCache?: {
    readonly version: number;
    readonly rows: ReadonlyArray<StoredObjectiveProjection>;
  };
  private objectiveListCache?: {
    readonly version: number;
    readonly queueVersion: number;
    readonly expiresAt?: number;
    readonly cards: ReadonlyArray<FactoryObjectiveCard>;
  };
  private readonly objectiveCardCache = new Map<string, {
    readonly key: string;
    readonly card: FactoryObjectiveCard;
  }>();
  private readonly objectiveControlEnqueueLocks = new Map<string, Promise<void>>();

  constructor(opts: FactoryServiceOptions) {
    this.dataDir = opts.dataDir;
    this.queue = opts.queue;
    this.jobRuntime = opts.jobRuntime;
    this.sse = opts.sse;
    this.codexExecutor = opts.codexExecutor;
    this.memoryTools = opts.memoryTools;
    this.cloudExecutionContextProvider = opts.cloudExecutionContextProvider;
    this.redriveQueuedJob = opts.redriveQueuedJob;
    this.onObjectiveHandoff = opts.onObjectiveHandoff;
    this.terminalRenderer = opts.terminalRenderer;
    this.git = new HubGit({
      dataDir: opts.dataDir,
      repoRoot: resolveRepoRoot(opts.repoRoot),
    });
    this.profileRoot = path.resolve(opts.profileRoot ?? DEFAULT_FACTORY_PROFILE_ROOT);
    this.repoSlotConcurrency = Number.isFinite(opts.repoSlotConcurrency)
      ? Math.max(1, Math.floor(opts.repoSlotConcurrency as number))
      : 1;
    this.runtime = createRuntime<FactoryCmd, FactoryEvent, FactoryState>(
      sqliteReceiptStore<FactoryEvent>(opts.dataDir),
      sqliteBranchStore(opts.dataDir),
      decideFactory,
      reduceFactory,
      initialFactoryState,
    );
  }

  async ensureBootstrap(): Promise<void> {
    await this.git.ensureReady();
  }

  async scheduleObjectiveControl(
    objectiveId: string,
    reason: FactoryObjectiveControlJobPayload["reason"],
  ): Promise<void> {
    await this.enqueueObjectiveControl(objectiveId, reason);
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
    this.objectiveProjectionSummaryCache = undefined;
    this.objectiveProjectionRowCache = undefined;
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
    opts?: {
      readonly taskPhase?: FactoryTaskExecutionPhase;
    },
  ): FactoryObjectiveContractRecord {
    const synthOnlyInvestigation = state.objectiveMode === "investigation" && opts?.taskPhase === "synthesizing";
    return {
      acceptanceCriteria: planningReceipt.acceptanceCriteria,
      allowedScope: [
        `Implement only what is needed to satisfy the accepted ${state.objectiveMode} objective for ${state.title}.`,
        state.objectiveMode === "investigation"
          ? "Make the minimum adjacent evidence or helper changes required to answer the question credibly."
          : "Make the minimum adjacent validation or helper changes required to ship the requested behavior.",
      ],
      disallowedScope: [
        "Do not broaden into unrelated refactors, formatting churn, or side quests outside the current objective.",
        "Do not claim downstream follow-up work as completed when it is only noted for handoff.",
      ],
      requiredChecks: synthOnlyInvestigation
        ? []
        : state.checks.length > 0 ? state.checks : planningReceipt.validationPlan,
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

  private baseWorkerTaskProfile(profile: FactoryObjectiveProfileSnapshot): FactoryObjectiveProfileSnapshot {
    const selectedSkills = this.workerTaskSkillRefs(profile.selectedSkills);
    if (selectedSkills.length === profile.selectedSkills.length) return profile;
    return {
      ...profile,
      selectedSkills,
    };
  }

  private async resolveExistingSkillRefs(skillRefs: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
    const resolved: string[] = [];
    for (const skillRef of skillRefs) {
      const trimmed = skillRef.trim();
      if (!trimmed) continue;
      const candidates = path.isAbsolute(trimmed)
        ? [trimmed]
        : [
            path.join(this.git.repoRoot, trimmed),
            path.join(this.profileRoot, trimmed),
          ];
      for (const absolute of candidates) {
        const exists = await fs.stat(absolute).then((stat) => stat.isFile()).catch(() => false);
        if (!exists) continue;
        resolved.push(trimmed);
        break;
      }
    }
    return dedupeStrings(resolved);
  }

  private resolveCloudProvider(
    profileCloudProvider: FactoryObjectiveProfileSnapshot["cloudProvider"],
    cloudExecutionContext?: FactoryCloudExecutionContext,
  ): FactoryObjectiveProfileSnapshot["cloudProvider"] {
    if (profileCloudProvider) return profileCloudProvider;
    if (!cloudExecutionContext) return undefined;
    if (cloudExecutionContext.preferredProvider) return cloudExecutionContext.preferredProvider;
    if (cloudExecutionContext.activeProviders.length === 1) return cloudExecutionContext.activeProviders[0];
    if (cloudExecutionContext.availableProviders.length === 1) return cloudExecutionContext.availableProviders[0];
    return undefined;
  }

  private async resolveWorkerTaskProfile(
    profile: FactoryObjectiveProfileSnapshot,
    cloudExecutionContext?: FactoryCloudExecutionContext,
  ): Promise<FactoryObjectiveProfileSnapshot> {
    const baseProfile = this.baseWorkerTaskProfile(profile);
    const resolvedProvider = this.resolveCloudProvider(baseProfile.cloudProvider, cloudExecutionContext);
    const providerSkills = baseProfile.rootProfileId === "infrastructure" && resolvedProvider
      ? await this.resolveExistingSkillRefs([
          `skills/factory-${resolvedProvider}-cli-cookbook/SKILL.md`,
          `skills/factory-infrastructure-${resolvedProvider}/SKILL.md`,
        ])
      : [];
    const selectedSkills = dedupeStrings([
      ...baseProfile.selectedSkills,
      ...providerSkills,
    ]);
    if (selectedSkills.join("\n") === baseProfile.selectedSkills.join("\n")
      && resolvedProvider === baseProfile.cloudProvider) {
      return baseProfile;
    }
    return {
      ...baseProfile,
      selectedSkills,
      cloudProvider: resolvedProvider,
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
      actionPolicy: {
        allowedDispatchActions: [...resolved.actionPolicy.allowedDispatchActions],
        allowedCreateModes: [...resolved.actionPolicy.allowedCreateModes],
      },
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

  private assertObjectiveProfileDispatchActionAllowed(
    profile: FactoryObjectiveProfileSnapshot,
    action: FactoryProfileDispatchAction,
  ): void {
    try {
      assertFactoryProfileDispatchActionAllowed({
        label: profile.rootProfileLabel,
        actionPolicy: profile.actionPolicy,
      }, action);
    } catch (err) {
      throw new FactoryServiceError(409, err instanceof Error ? err.message : "profile action is not allowed");
    }
  }

  private assertObjectiveProfileCreateModeAllowed(
    profile: FactoryObjectiveProfileSnapshot,
    objectiveMode: FactoryObjectiveMode,
  ): void {
    try {
      assertFactoryProfileCreateModeAllowed({
        label: profile.rootProfileLabel,
        actionPolicy: profile.actionPolicy,
      }, objectiveMode);
    } catch (err) {
      throw new FactoryServiceError(409, err instanceof Error ? err.message : "profile create mode is not allowed");
    }
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
    if (channel === "auto-fix" && await this.openAutoFixObjectiveCount() >= MAX_OPEN_AUTO_FIX_OBJECTIVES) {
      throw new FactoryServiceError(
        409,
        `auto-fix objective limit reached (${MAX_OPEN_AUTO_FIX_OBJECTIVES} open objectives)`,
      );
    }
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
    this.assertObjectiveProfileDispatchActionAllowed(profile, "create");
    this.assertObjectiveProfileCreateModeAllowed(profile, objectiveMode);
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
    const now = Date.now();
    const objectiveIds = (query?.objectiveIds ?? [])
      .map((objectiveId) => objectiveId.trim())
      .filter(Boolean);
    const profileId = query?.profileId?.trim();
    const projections = await this.listStoredObjectiveProjections();
    const queuePositions = this.queuePositionsForObjectiveSummaries(projections);
    const recentQueueJobs = await this.queue.listJobs({ limit: 2000 });
    const queueVersion = this.queue.snapshot().version;
    const liveExecution = liveExecutionSnapshotForJobs(recentQueueJobs, now);
    const objectiveJobsById = groupObjectiveScopedJobs(recentQueueJobs);
    if (objectiveIds.length > 0) {
      const objectiveIdSet = new Set(objectiveIds);
      const details = await Promise.all(
        projections
          .filter((projection) => objectiveIdSet.has(projection.objectiveId))
          .filter((projection) => !profileId || projection.state.profile.rootProfileId === profileId)
          .map((projection) => this.buildObjectiveCard(
            projection.state,
            queuePositions.get(projection.objectiveId),
            undefined,
            liveExecution.stalledObjectiveIds.has(projection.objectiveId),
            objectiveJobsById.get(projection.objectiveId) ?? [],
          )),
      );
      return details.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    const cached = this.objectiveListCache;
    if (
      cached
      && cached.version === this.objectiveProjectionVersion
      && cached.queueVersion === queueVersion
      && (cached.expiresAt === undefined || cached.expiresAt > now)
    ) {
      return profileId
        ? cached.cards.filter((card) => card.profile.rootProfileId === profileId)
        : cached.cards;
    }
    const details = await Promise.all(
      projections.map((projection) => this.buildObjectiveCard(
          projection.state,
          queuePositions.get(projection.objectiveId),
          undefined,
          liveExecution.stalledObjectiveIds.has(projection.objectiveId),
          objectiveJobsById.get(projection.objectiveId) ?? [],
        )),
    );
    const cards = details.sort((a, b) => b.updatedAt - a.updatedAt);
    this.objectiveListCache = {
      version: this.objectiveProjectionVersion,
      queueVersion,
      expiresAt: liveExecution.nextStatusChangeAt,
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
    control: {
      shouldAbort: () => Promise<boolean>;
      jobId?: string;
      workerId?: string;
      pollIntervalMs?: number;
      sleep?: (ms: number) => Promise<void>;
    },
  ): Promise<Record<string, unknown>> {
    const pollIntervalMs = Math.max(1, Math.floor(control.pollIntervalMs ?? 10_000));
    const sleepFor = control.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const monitorPayload = payload as unknown as FactoryMonitorJobPayload;
    let checkpoint = 0;
    const startedAt = Date.now();
    let lastCheckpointAt = startedAt;
    let evidenceDetectedAt: number | undefined;

    const checkpointIntervalMs = monitorCheckpointIntervalMs(
      monitorPayload.objectiveMode,
      monitorPayload.severity,
    );
    const loadMonitoredTask = async (): Promise<FactoryTaskRecord | undefined> => {
      const state = await this.getObjectiveState(monitorPayload.objectiveId).catch(() => undefined);
      if (!state) return undefined;
      const task = state.workflow.tasksById[monitorPayload.taskId];
      if (!task || task.candidateId !== monitorPayload.candidateId) return undefined;
      return task;
    };

    while (true) {
      await sleepFor(pollIntervalMs);

      const codexJob = await this.queue.getJob(monitorPayload.codexJobId);
      if (!codexJob || isTerminalQueueJobStatus(codexJob.status)) {
        return { status: "codex_job_completed", checkpoints: checkpoint };
      }

      if (await control.shouldAbort()) {
        return { status: "monitor_aborted", checkpoints: checkpoint };
      }

      const elapsedMs = Date.now() - startedAt;
      const hasEvidence = await monitorDetectEvidence(monitorPayload.evidenceDir);
      if (hasEvidence && !evidenceDetectedAt) evidenceDetectedAt = Date.now();
      const monitoredTask = await loadMonitoredTask();
      if (!monitoredTask || monitoredTask.status !== "running") {
        return { status: "task_not_active", checkpoints: checkpoint };
      }

      if (control.jobId && control.workerId) {
        await this.queue.progress(
          control.jobId,
          control.workerId,
          { phase: "polling", elapsedMs, evidencePresent: hasEvidence, checkpoints: checkpoint },
        ).catch(() => undefined);
      }

      const sinceLastCheckpoint = Date.now() - lastCheckpointAt;
      const evidenceStale = evidenceDetectedAt !== undefined
        && Date.now() - evidenceDetectedAt > checkpointIntervalMs;
      const shouldCheckpoint = sinceLastCheckpoint >= checkpointIntervalMs || evidenceStale;
      if (!shouldCheckpoint) continue;

      checkpoint += 1;
      lastCheckpointAt = Date.now();

      const result = await runMonitorCheckpoint({
        stdoutPath: monitorPayload.stdoutPath,
        stderrPath: monitorPayload.stderrPath,
        taskPrompt: monitorPayload.taskPrompt,
        elapsedMs,
        checkpoint,
        evidencePresent: hasEvidence,
        objectiveMode: monitorPayload.objectiveMode,
        taskExecutionPhase: taskExecutionPhaseValue(monitoredTask),
        evaluateLlm: async (prompt) => {
          const llmResult = await llmStructured({
            system: prompt.system,
            user: prompt.user,
            schema: MonitorCheckpointResultSchema,
            schemaName: "MonitorCheckpointResult",
          });
          const parsed = llmResult.parsed;
          return {
            assessment: parsed.assessment,
            reasoning: parsed.reasoning,
            recommendation: parseMonitorRecommendation(parsed.recommendation),
          };
        },
      });

      await this.emitObjective(monitorPayload.objectiveId, {
        type: "monitor.checkpoint",
        objectiveId: monitorPayload.objectiveId,
        taskId: monitorPayload.taskId,
        jobId: monitorPayload.codexJobId,
        checkpoint,
        assessment: result.assessment,
        reasoning: result.reasoning,
        recommendation: result.recommendation,
        evaluatedAt: Date.now(),
      });

      if (result.recommendation.kind === "continue") {
        continue;
      }

      const taskPhase = taskExecutionPhaseValue(monitoredTask);
      const recommendedAt = Date.now();
      const recommendationId = factoryRecommendationId(
        monitorPayload.objectiveId,
        monitorPayload.taskId,
        monitorPayload.candidateId,
        recommendedAt,
      );
      const objectiveChain = await this.runtime.chain(objectiveStream(monitorPayload.objectiveId));
      const resolvedRecommendationIds = new Set<string>();
      for (const block of objectiveChain) {
        const event = block.body;
        if (!event) continue;
        if (event.type === "monitor.recommendation.consumed" || event.type === "monitor.recommendation.obsoleted") {
          resolvedRecommendationIds.add(event.recommendationId);
        }
      }
      let priorRecommendationId: string | undefined;
      let priorRecommendation: MonitorRecommendation | undefined;
      for (let index = objectiveChain.length - 1; index >= 0; index -= 1) {
        const event = objectiveChain[index]?.body;
        if (!event || event.type !== "monitor.recommendation") continue;
        if (resolvedRecommendationIds.has(event.recommendationId)) continue;
        if (event.taskId !== monitorPayload.taskId || event.candidateId !== monitorPayload.candidateId) continue;
        priorRecommendationId = event.recommendationId;
        priorRecommendation = event.recommendation;
        break;
      }
      if (!this.shouldEmitMonitorRecommendation(taskPhase, result.recommendation, priorRecommendation)) {
        continue;
      }
      if (priorRecommendationId) {
        await this.emitObjective(monitorPayload.objectiveId, {
          type: "monitor.recommendation.obsoleted",
          objectiveId: monitorPayload.objectiveId,
          recommendationId: priorRecommendationId,
          taskId: monitorPayload.taskId,
          candidateId: monitorPayload.candidateId,
          reason: "superseded by a newer monitor recommendation for the active task candidate",
          obsoletedAt: recommendedAt,
        });
      }
      await this.emitObjective(monitorPayload.objectiveId, {
        type: "monitor.recommendation",
        objectiveId: monitorPayload.objectiveId,
        recommendationId,
        taskId: monitorPayload.taskId,
        candidateId: monitorPayload.candidateId,
        jobId: monitorPayload.codexJobId,
        recommendation: result.recommendation,
        reasoning: result.reasoning,
        recommendedAt,
      });
      await this.enqueueObjectiveControl(monitorPayload.objectiveId, "reconcile");
      if (result.recommendation.kind === "recommend_abort") {
        return { status: "recommended_abort", checkpoints: checkpoint, reason: result.recommendation.reason };
      }
      if (result.recommendation.kind === "recommend_split") {
        return { status: "recommended_split", checkpoints: checkpoint, subtasks: result.recommendation.subtasks.length };
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
    await this.syncObjectiveProjectionCache();
    const projected = readObjectiveProjection(this.dataDir, objectiveId);
    const state = projected?.state ?? await this.getObjectiveState(objectiveId);
    const summaries = await this.listObjectiveProjectionSummaries();
    const queuePositions = this.queuePositionsForObjectiveSummaries(summaries);
    return this.buildObjectiveDetail(
      state,
      queuePositions.get(objectiveId),
    );
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
    const summaries = await this.listObjectiveProjectionSummaries();
    const queuePositions = this.queuePositionsForObjectiveSummaries(summaries);
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
    const objectiveJobs = await this.listObjectiveScopedJobs(objectiveId, 12);
    const activeTasks = detail.tasks.filter((task) =>
      isDisplayActiveJobStatus(displayLiveJobStatus(task.job) ?? task.jobStatus ?? task.status));
    const recentJobs = objectiveJobs.slice(0, 8);
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
      const active = isDisplayActiveJobStatus(displayStatus);
      const artifactActivity = task.artifactActivity && task.artifactActivity.length > 0 ? task.artifactActivity : undefined;
      const evidenceContents = !active && task.workspacePath
        ? await readTaskEvidenceContents(task.workspacePath, artifactActivity ?? [])
        : undefined;
      const handoffPhase = resolveHandoffPhase(task.executionPhase, active, evidenceContents);
      return {
        objectiveId,
        focusKind,
        focusId,
        title: task.title,
        status: displayStatus,
        active,
        handoffPhase,
        summary: task.latestSummary ?? task.candidate?.summary ?? task.lastMessage ?? task.stderrTail ?? task.stdoutTail ?? task.artifactSummary,
        taskId: task.taskId,
        candidateId: task.candidateId,
        jobId: task.jobId,
        lastMessage: task.lastMessage,
        stdoutTail: task.stdoutTail,
        stderrTail: task.stderrTail,
        artifactSummary: task.artifactSummary,
        artifactActivity,
        evidenceContents: evidenceContents && evidenceContents.length > 0 ? evidenceContents : undefined,
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
    const active = isDisplayActiveJobStatus(displayStatus);
    const workspacePath = optionalTrimmedString(payload.workspacePath);
    const evidenceContents = !active && workspacePath
      ? await readTaskEvidenceContents(workspacePath, artifactActivity ?? [])
      : undefined;
    const detail = taskId
      ? await this.getObjective(objectiveId).catch(() => undefined)
      : undefined;
    const taskPhase = taskId
      ? detail?.tasks.find((item) => item.taskId === taskId)?.executionPhase
      : undefined;
    const handoffPhase = resolveHandoffPhase(taskPhase, active, evidenceContents);

    return {
      objectiveId,
      focusKind,
      focusId,
      title,
      status: displayStatus,
      active,
      handoffPhase,
      summary: artifactSummary ?? lastMessage ?? stderrTail ?? stdoutTail ?? summary,
      taskId,
      candidateId,
      jobId: job.id,
      lastMessage,
      stdoutTail,
      stderrTail,
      artifactSummary,
      artifactActivity: artifactActivity && artifactActivity.length > 0 ? artifactActivity : undefined,
      evidenceContents: evidenceContents && evidenceContents.length > 0 ? evidenceContents : undefined,
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
    const state = await this.getObjectiveState(objectiveId);
    this.assertObjectiveProfileDispatchActionAllowed(this.objectiveProfileForState(state), "react");
    const normalized = optionalTrimmedString(message);
    if (normalized) await this.addObjectiveNote(objectiveId, normalized);
    await this.reactObjective(objectiveId);
    return this.getObjective(objectiveId);
  }

  async promoteObjective(objectiveId: string): Promise<FactoryObjectiveDetail> {
    const state = await this.getObjectiveState(objectiveId);
    this.assertObjectiveProfileDispatchActionAllowed(this.objectiveProfileForState(state), "promote");
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
    this.assertObjectiveProfileDispatchActionAllowed(this.objectiveProfileForState(state), "cancel");
    await this.cancelObjectiveScopedJobs(objectiveId, reason ?? "factory objective canceled", "factory");
    const canceledAt = Date.now();
    const summary = reason ? `Objective canceled: ${reason}` : "Objective canceled.";
    await this.emitObjectiveBatch(objectiveId, [
      {
        type: "objective.canceled",
        objectiveId,
        canceledAt,
        reason,
      },
      await this.buildRenderedObjectiveHandoffEvent({
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
    this.assertObjectiveProfileDispatchActionAllowed(this.objectiveProfileForState(state), "archive");
    await this.cancelObjectiveScopedJobs(objectiveId, "factory objective archived", "factory");
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
    this.assertObjectiveProfileDispatchActionAllowed(this.objectiveProfileForState(state), "cleanup");
    await this.cancelObjectiveScopedJobs(objectiveId, "factory objective cleanup", "factory.cleanup");
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
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.resumeObjectivesOnce();
        return;
      } catch (err) {
        if (!isFactoryStaleObjectiveConflict(err) || attempt === 3) throw err;
        await this.queue.refresh();
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }

  private async resumeObjectivesOnce(): Promise<void> {
    await this.queue.refresh();
    await this.reconcileQueuedObjectiveControlJobs();
    await this.reconcileStaleObjectiveExecutionJobs();
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

  private isObjectiveAuditJob(job: QueueJob): job is QueueJob & {
    readonly payload: FactoryObjectiveAuditJobPayload;
  } {
    return job.agentId === FACTORY_CONTROL_AGENT_ID
      && job.payload.kind === "factory.objective.audit"
      && typeof job.payload.objectiveId === "string"
      && job.payload.objectiveId.trim().length > 0;
  }

  private compareRecentQueueJobs(left: QueueJob, right: QueueJob): number {
    return right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
      || right.id.localeCompare(left.id);
  }

  private async latestObjectiveAuditJob(objectiveId: string): Promise<QueueJob | undefined> {
    const jobs = await this.queue.listJobs({ limit: 500 });
    return jobs
      .filter((job) => this.isObjectiveAuditJob(job) && job.payload.objectiveId === objectiveId)
      .sort((left, right) => this.compareRecentQueueJobs(left, right))[0];
  }

  private buildObjectiveSelfImprovement(
    state: FactoryState,
    auditMetadata: FactoryObjectiveAuditMetadata | undefined,
    auditJob: QueueJob | undefined,
  ): FactoryObjectiveDetail["selfImprovement"] {
    return buildObjectiveControlSelfImprovement(state, auditMetadata, auditJob);
  }

  private controlJobCancelReason(
    state: Pick<FactoryState, "archivedAt" | "status"> | Pick<StoredObjectiveProjectionSummary, "archivedAt" | "status"> | undefined,
  ): string | undefined {
    return deriveControlJobCancelReason(state);
  }

  private shouldRedriveQueuedControlJob(job: QueueJob, now: number): boolean {
    return shouldRequeueObjectiveControlJob(job, now, OBJECTIVE_CONTROL_REDRIVE_AGE_MS);
  }

  private async reconcileQueuedObjectiveControlJobs(): Promise<void> {
    const active = (await this.queue.listJobs({ limit: 2000 }))
      .filter((job) => this.isObjectiveControlJob(job) && isActiveQueueJobStatus(job.status));
    if (active.length === 0) return;

    const summaries = await this.listObjectiveProjectionSummaries();
    const summariesById = new Map(summaries.map((summary) => [summary.objectiveId, summary] as const));
    const grouped = new Map<string, QueueJob[]>();
    for (const job of active) {
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
      const summary = summariesById.get(objectiveId);
      const cancelReason = this.controlJobCancelReason(summary);
      if (cancelReason) {
        await this.queue.cancel(current.id, cancelReason, "factory.resume");
        continue;
      }

      const state = objectiveId
        ? await this.getObjectiveState(objectiveId).catch(() => undefined)
        : undefined;
      if (
        current.status === "queued"
        && this.redriveQueuedJob
        && (
          (state ? this.hasPendingObjectiveControlWake(state) : false)
          || this.shouldRedriveQueuedControlJob(current, now)
        )
      ) {
        await this.redriveQueuedJob(current);
      }
    }
  }

  private async recoverPersistedStaleTaskResult(job: QueueJob): Promise<boolean> {
    if (!isRecord(job.payload) || job.payload.kind !== "factory.task.run") return false;
    let parsed: FactoryTaskJobPayload;
    try {
      parsed = this.parseTaskPayload(job.payload);
    } catch {
      return false;
    }
    let rawResult: Record<string, unknown>;
    try {
      const raw = await fs.readFile(parsed.resultPath, "utf-8");
      const parsedResult = JSON.parse(raw);
      if (!isRecord(parsedResult)) return false;
      rawResult = parsedResult;
    } catch {
      return false;
    }
    await this.applyTaskWorkerResult(parsed, rawResult);
    const completed = await this.queue.complete(job.id, job.leaseOwner ?? "factory.resume", {
      objectiveId: parsed.objectiveId,
      taskId: parsed.taskId,
      candidateId: parsed.candidateId,
      status: "completed",
      recoveredFromPersistedResult: true,
    });
    if (completed) {
      await this.enqueueObjectiveControl(parsed.objectiveId, "reconcile");
    }
    return Boolean(completed);
  }

  private async reconcileStaleObjectiveExecutionJobs(now = Date.now()): Promise<void> {
    const jobs = await this.queue.listJobs({ limit: 2000 });
    const summaries = await this.listObjectiveProjectionSummaries();
    const summariesById = new Map(summaries.map((summary) => [summary.objectiveId, summary] as const));
    const reconciledObjectiveIds = new Set<string>();

    for (const job of jobs) {
      if (!isActiveQueueJobStatus(job.status) || !isFactoryExecutionQueueJob(job)) continue;
      const objectiveId = objectiveIdForQueueJob(job);
      if (!objectiveId) continue;
      const summary = summariesById.get(objectiveId);
      if (!summary || summary.archivedAt || this.isTerminalObjectiveStatus(summary.status)) {
        await this.queue.cancel(
          job.id,
          summary ? this.objectiveCleanupReason(summary) : "objective execution job retired during startup reconciliation",
          "factory.resume",
        );
        continue;
      }
      const staleAt = liveJobStaleAt(job);
      if (typeof staleAt !== "number" || staleAt > now) continue;
      if (job.status === "queued" && this.redriveQueuedJob) {
        await this.redriveQueuedJob(job);
        continue;
      }
      if (await this.recoverPersistedStaleTaskResult(job)) {
        continue;
      }
      await this.queue.cancel(job.id, "stale active objective job reconciled during startup recovery", "factory.resume");
      reconciledObjectiveIds.add(objectiveId);
    }

    for (const objectiveId of reconciledObjectiveIds) {
      await this.enqueueObjectiveControl(objectiveId, "reconcile");
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
    return calculateObjectiveElapsedMinutes(state, now);
  }

  private shouldScheduleTerminalObjectiveCleanup(events: ReadonlyArray<FactoryEvent>): boolean {
    return events.some((event) =>
      event.type === "objective.completed"
      || event.type === "objective.failed"
      || event.type === "objective.canceled"
      || event.type === "objective.archived");
  }

  private objectiveCleanupReason(
    state: Pick<FactoryState, "archivedAt" | "status">,
  ): string {
    if (state.archivedAt) return "retired after terminal objective transition (archived)";
    return `retired after terminal objective transition (${state.status})`;
  }

  private async retireObjectiveScopedLiveJobs(
    objectiveId: string,
    reason: string,
  ): Promise<void> {
    const jobs = await this.listObjectiveScopedJobs(objectiveId, 2000);
    for (const job of jobs) {
      if (!isActiveQueueJobStatus(job.status)) continue;
      if (job.payload.kind === "factory.objective.audit" || job.payload.kind === "factory.objective.control") continue;
      await this.queue.cancel(job.id, reason, "factory.cleanup");
    }
  }

  private isTerminalObjectiveStatus(status: FactoryObjectiveStatus): boolean {
    return isLifecycleTerminalObjectiveStatus(status);
  }

  private objectiveConsumesRepoSlot(
    objective: Pick<FactoryState, "objectiveMode"> | FactoryObjectiveMode,
  ): boolean {
    return consumesObjectiveRepoSlot(objective);
  }

  private releasesObjectiveSlot(state: Pick<FactoryState, "status" | "integration">): boolean {
    return releasesLiveObjectiveSlot(state);
  }

  private releasesObjectiveProjectionSlot(
    summary: Pick<StoredObjectiveProjectionSummary, "status" | "integrationStatus">,
  ): boolean {
    return releasesProjectedObjectiveSlot(summary);
  }

  private async cancelObjectiveScopedJobs(
    objectiveId: string,
    reason: string,
    by: string,
  ): Promise<void> {
    const jobs = await this.listObjectiveScopedJobs(objectiveId, 2000);
    for (const job of jobs) {
      if (!isActiveQueueJobStatus(job.status)) continue;
      await this.queue.cancel(job.id, reason, by);
    }
  }

  private async openAutoFixObjectiveCount(): Promise<number> {
    const projections = await this.listStoredObjectiveProjections();
    return projections.filter((projection) =>
      !projection.archivedAt
      && projection.state.channel === "auto-fix"
      && !this.isTerminalObjectiveStatus(projection.status)
    ).length;
  }

  private async listObjectiveProjectionSummaries(): Promise<ReadonlyArray<StoredObjectiveProjectionSummary>> {
    await this.syncObjectiveProjectionCache();
    const cached = this.objectiveProjectionSummaryCache;
    if (cached && cached.version === this.objectiveProjectionVersion) {
      return cached.summaries;
    }
    const summaries = readObjectiveProjectionSummaries(this.dataDir)
      .filter((summary) => Boolean(summary.objectiveId))
      .sort((a, b) => a.createdAt - b.createdAt || a.objectiveId.localeCompare(b.objectiveId));
    this.objectiveProjectionSummaryCache = {
      version: this.objectiveProjectionVersion,
      summaries,
    };
    return summaries;
  }

  private async listStoredObjectiveProjections(): Promise<ReadonlyArray<StoredObjectiveProjection>> {
    await this.syncObjectiveProjectionCache();
    const cached = this.objectiveProjectionRowCache;
    if (cached && cached.version === this.objectiveProjectionVersion) {
      return cached.rows;
    }
    const rows = listObjectiveProjectionRows(this.dataDir)
      .filter((row) => Boolean(row.objectiveId))
      .sort((a, b) => a.createdAt - b.createdAt || a.objectiveId.localeCompare(b.objectiveId));
    this.objectiveProjectionRowCache = {
      version: this.objectiveProjectionVersion,
      rows,
    };
    return rows;
  }

  private queuePositionsForObjectiveSummaries(
    summaries: ReadonlyArray<StoredObjectiveProjectionSummary>,
  ): ReadonlyMap<string, number> {
    const queued = summaries
      .filter((summary) =>
        Boolean(summary.objectiveId)
        && !summary.archivedAt
        && this.objectiveConsumesRepoSlot(summary)
        && !this.isTerminalObjectiveStatus(summary.status)
        && summary.slotState === "queued",
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.objectiveId.localeCompare(b.objectiveId));
    return new Map(queued.map((summary, index) => [summary.objectiveId, index + 1] as const));
  }

  private deriveObjectivePhase(
    state: FactoryState,
    projection?: { readonly activeTasks: number; readonly readyTasks: number },
  ): FactoryObjectivePhase {
    return deriveLifecycleObjectivePhase(state, projection);
  }

  private deriveLatestDecision(state: FactoryState): FactoryObjectiveCard["latestDecision"] | undefined {
    return deriveObjectiveLifecycleLatestDecision(state);
  }

  private deriveNextAction(state: FactoryState, queuePosition?: number): string | undefined {
    return deriveObjectiveLifecycleNextAction(state, queuePosition);
  }

  private buildBudgetState(
    state: FactoryState,
    now = Date.now(),
    policyBlockedReason?: string,
  ): FactoryBudgetState {
    return buildObjectiveLifecycleBudgetState(
      state,
      (currentState, currentNow) => this.derivePolicyBlockedReason(currentState, currentNow),
      now,
      policyBlockedReason,
    );
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
        await this.buildRenderedObjectiveHandoffEvent({
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
    const summaries = await this.listObjectiveProjectionSummaries();
    const activeCount = summaries.filter((summary) =>
      !summary.archivedAt
      && this.objectiveConsumesRepoSlot(summary)
      && !this.releasesObjectiveProjectionSlot(summary)
      && summary.slotState === "active",
    ).length;
    return activeCount >= this.repoSlotConcurrency;
  }

  private hasPendingObjectiveControlWake(state: FactoryState): boolean {
    return (state.scheduler.controlWakeRequestedAt ?? 0) > (state.scheduler.controlWakeConsumedAt ?? 0);
  }

  private nextObjectiveControlWakeReason(
    state: FactoryState,
    fallback: FactoryObjectiveControlJobPayload["reason"],
  ): FactoryObjectiveControlJobPayload["reason"] {
    const requestedReason = state.scheduler.controlWakeReason;
    if (this.hasPendingObjectiveControlWake(state) && (requestedReason === "admitted" || requestedReason === "reconcile")) {
      return requestedReason;
    }
    return fallback;
  }

  private async requestObjectiveControlWake(
    objectiveId: string,
    reason: FactoryObjectiveControlJobPayload["reason"],
  ): Promise<boolean> {
    const state = await this.getObjectiveState(objectiveId).catch(() => undefined);
    if (!state?.objectiveId) return false;
    const requestedAt = Date.now();
    const pendingReason = state.scheduler.controlWakeReason;
    if (this.hasPendingObjectiveControlWake(state) && pendingReason === reason) return false;
    await this.emitObjective(objectiveId, {
      type: "objective.control.wake.requested",
      objectiveId,
      reason,
      requestedAt,
    });
    return true;
  }

  private async withObjectiveControlEnqueueLock(
    objectiveId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const previous = this.objectiveControlEnqueueLocks.get(objectiveId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const current = previous.catch(() => undefined).then(() => gate);
    this.objectiveControlEnqueueLocks.set(objectiveId, current);
    await previous.catch(() => undefined);
    try {
      await work();
    } finally {
      releaseCurrent();
      if (this.objectiveControlEnqueueLocks.get(objectiveId) === current) {
        this.objectiveControlEnqueueLocks.delete(objectiveId);
      }
    }
  }

  private async enqueueObjectiveControl(
    objectiveId: string,
    reason: FactoryObjectiveControlJobPayload["reason"],
  ): Promise<void> {
    await this.withObjectiveControlEnqueueLock(objectiveId, async () => {
      const wakeRequested = await this.requestObjectiveControlWake(objectiveId, reason);
      const sessionKey = `factory:objective:${objectiveId}`;
      const now = Date.now();
      const existing = (await this.listObjectiveScopedJobs(objectiveId, 2000))
        .filter((job) => this.isObjectiveControlJob(job) && isActiveQueueJobStatus(job.status))
        .sort((left, right) => this.compareRecentQueueJobs(left, right));
      const fresh: QueueJob[] = [];
      for (const job of existing) {
        const staleAt = liveJobStaleAt(job);
        if (typeof staleAt === "number" && staleAt <= now) {
          await this.queue.cancel(job.id, "stale objective control job replaced", "factory.control");
          continue;
        }
        fresh.push(job);
      }
      const current = fresh[0];
      for (const duplicate of fresh.slice(1)) {
        await this.queue.cancel(duplicate.id, "superseded duplicate objective control job", "factory.control");
      }
      if (current) {
        if (
          current.status === "queued"
          && this.redriveQueuedJob
          && (wakeRequested || this.shouldRedriveQueuedControlJob(current, now))
        ) {
          await this.redriveQueuedJob(current);
        }
        this.sse.publish("jobs", current.id);
        return;
      }
      const created = await this.queue.enqueue({
        agentId: FACTORY_CONTROL_AGENT_ID,
        lane: "collect",
        sessionKey,
        singletonMode: "allow",
        maxAttempts: 2,
        payload: {
          kind: "factory.objective.control",
          objectiveId,
          reason,
        } satisfies FactoryObjectiveControlJobPayload,
      });
      this.sse.publish("jobs", created.id);
      if (this.redriveQueuedJob && created.status === "queued") {
        await this.redriveQueuedJob(created);
      }
    });
  }

  async runObjectiveControl(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (payload.kind !== "factory.objective.control") {
      throw new FactoryServiceError(400, "invalid factory control payload");
    }
    const objectiveId = requireNonEmpty(payload.objectiveId, "objectiveId required");
    const reason: FactoryObjectiveControlJobPayload["reason"] =
      payload.reason === "admitted" || payload.reason === "reconcile"
      ? payload.reason
      : "startup";
    await this.ensureBootstrap();
    let nextReason: FactoryObjectiveControlJobPayload["reason"] = reason;
    let passes = 0;
    while (passes < 2) {
      passes += 1;
      const state = await this.getObjectiveState(objectiveId);
      if (state.archivedAt || this.isTerminalObjectiveStatus(state.status)) {
        await this.retireObjectiveScopedLiveJobs(objectiveId, this.objectiveCleanupReason(state));
        await this.rebalanceObjectiveSlots();
        return {
          objectiveId,
          status: "completed",
          reason: nextReason,
        };
      }
      const effectiveReason = this.nextObjectiveControlWakeReason(state, nextReason);
      if (this.hasPendingObjectiveControlWake(state)) {
        await this.emitObjective(objectiveId, {
          type: "objective.control.wake.consumed",
          objectiveId,
          reason: effectiveReason,
          consumedAt: Date.now(),
        });
      }
      if (effectiveReason === "reconcile") {
        await this.processObjectiveReconcile(objectiveId);
      } else {
        const startupReason: "startup" | "admitted" = effectiveReason === "admitted" ? "admitted" : "startup";
        await this.processObjectiveStartup(objectiveId, startupReason);
      }
      const refreshed = await this.getObjectiveState(objectiveId);
      if (refreshed.archivedAt || this.isTerminalObjectiveStatus(refreshed.status)) {
        await this.retireObjectiveScopedLiveJobs(objectiveId, this.objectiveCleanupReason(refreshed));
        await this.rebalanceObjectiveSlots();
        return {
          objectiveId,
          status: "completed",
          reason: effectiveReason,
        };
      }
      if (!this.hasPendingObjectiveControlWake(refreshed)) {
        return {
          objectiveId,
          status: "completed",
          reason: effectiveReason,
        };
      }
      nextReason = "reconcile";
    }
    return {
      objectiveId,
      status: "completed",
      reason: nextReason,
    };
  }

  private async rebalanceObjectiveSlots(): Promise<void> {
    const summaries = await this.listObjectiveProjectionSummaries();
    for (const summary of summaries) {
      if (
        this.objectiveConsumesRepoSlot(summary)
        && summary.slotState === "active"
        && (this.releasesObjectiveProjectionSlot(summary) || Boolean(summary.archivedAt))
      ) {
        await this.emitObjective(summary.objectiveId, {
          type: "objective.slot.released",
          objectiveId: summary.objectiveId,
          releasedAt: Date.now(),
          reason: summary.archivedAt
            ? "slot released after objective archived"
            : `slot released after objective entered ${summary.status}`,
        });
      }
    }

    const refreshed = await this.listObjectiveProjectionSummaries();
    const slotFreeQueued = refreshed.filter((summary) =>
      !summary.archivedAt
      && !this.objectiveConsumesRepoSlot(summary)
      && !this.releasesObjectiveProjectionSlot(summary)
      && (summary.slotState === "queued" || !summary.slotState)
    );
    for (const summary of slotFreeQueued) {
      await this.emitObjective(summary.objectiveId, {
        type: "objective.slot.admitted",
        objectiveId: summary.objectiveId,
        admittedAt: Date.now(),
      });
      await this.enqueueObjectiveControl(summary.objectiveId, "admitted");
    }

    const activeCount = refreshed.filter((summary) =>
      !summary.archivedAt
      && this.objectiveConsumesRepoSlot(summary)
      && !this.releasesObjectiveProjectionSlot(summary)
      && summary.slotState === "active",
    ).length;
    const availableSlots = Math.max(0, this.repoSlotConcurrency - activeCount);
    if (availableSlots <= 0) return;

    const next = refreshed.filter((summary) =>
      !summary.archivedAt
      && this.objectiveConsumesRepoSlot(summary)
      && !this.releasesObjectiveProjectionSlot(summary)
      && (summary.slotState === "queued" || !summary.slotState),
    ).slice(0, availableSlots);
    if (next.length === 0) return;
    for (const queued of next) {
      await this.emitObjective(queued.objectiveId, {
        type: "objective.slot.admitted",
        objectiveId: queued.objectiveId,
        admittedAt: Date.now(),
      });
      await this.enqueueObjectiveControl(queued.objectiveId, "admitted");
    }
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
      if (!job || !isTerminalQueueJobStatus(job.status)) continue;
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

  private async latestMonitorRecommendations(state: FactoryState): Promise<ReadonlyArray<{
    readonly recommendationId: string;
    readonly taskId: string;
    readonly candidateId: string;
    readonly recommendation: MonitorRecommendation;
    readonly reasoning: string;
    readonly recommendedAt: number;
  }>> {
    const chain = await this.runtime.chain(objectiveStream(state.objectiveId));
    const resolvedRecommendationIds = new Set<string>();
    for (const block of chain) {
      const event = block.body;
      if (!event) continue;
      if (event.type === "monitor.recommendation.consumed" || event.type === "monitor.recommendation.obsoleted") {
        resolvedRecommendationIds.add(event.recommendationId);
      }
    }
    const latestByTask = new Map<string, {
      readonly recommendationId: string;
      readonly taskId: string;
      readonly candidateId: string;
      readonly recommendation: MonitorRecommendation;
      readonly reasoning: string;
      readonly recommendedAt: number;
    }>();
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const event = chain[index]?.body;
      if (!event || event.type !== "monitor.recommendation") continue;
      if (resolvedRecommendationIds.has(event.recommendationId)) continue;
      if (latestByTask.has(event.taskId)) continue;
      latestByTask.set(event.taskId, {
        recommendationId: event.recommendationId,
        taskId: event.taskId,
        candidateId: event.candidateId,
        recommendation: event.recommendation,
        reasoning: event.reasoning,
        recommendedAt: event.recommendedAt,
      });
    }
    return [...latestByTask.values()].sort((left, right) => left.recommendedAt - right.recommendedAt);
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
    const monitorRecommendations = await this.latestMonitorRecommendations(state);
    return {
      latestObjectiveOperatorNote,
      taskReworkBlocks,
      monitorRecommendations,
      dispatchCapacity: Math.max(0, this.effectiveMaxParallelChildren(state) - state.workflow.activeTaskIds.length),
      policyBlockedReason: state.taskRunsUsed >= state.policy.budgets.maxTaskRuns
        ? `Policy blocked: objective exhausted maxTaskRuns (${state.taskRunsUsed}/${state.policy.budgets.maxTaskRuns}).`
        : undefined,
      readyToPromoteBlockedReason: factoryPromotionGateBlockedReason(state),
      hasInvestigationReports: this.finalInvestigationReports(state).length > 0,
      investigationSynthesisSummary: state.investigation.synthesized?.summary,
    };
  }

  private async buildObjectiveBlockedEvents(
    state: FactoryState,
    reason: string,
  ): Promise<ReadonlyArray<FactoryEvent>> {
    const blockedAt = Date.now();
    return [
      {
        type: "objective.blocked",
        objectiveId: state.objectiveId,
        reason,
        summary: reason,
        blockedAt,
      },
      await this.buildRenderedObjectiveHandoffEvent({
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

  private async cancelTaskExecutionJob(
    task: FactoryTaskRecord,
    reason: string,
  ): Promise<void> {
    if (!task.jobId) return;
    const job = await this.queue.getJob(task.jobId);
    if (!job || isTerminalQueueJobStatus(job.status)) return;
    await this.queue.cancel(task.jobId, reason, "factory.control");
  }

  private isFactoryMonitorJob(job: QueueJob): job is QueueJob & {
    readonly payload: FactoryMonitorJobPayload;
  } {
    return job.agentId === FACTORY_MONITOR_AGENT_ID
      && isRecord(job.payload)
      && job.payload.kind === "factory.task.monitor"
      && typeof job.payload.objectiveId === "string"
      && typeof job.payload.taskId === "string"
      && typeof job.payload.candidateId === "string";
  }

  private async enqueueTaskMonitor(
    state: FactoryState,
    task: FactoryTaskRecord,
  ): Promise<void> {
    if (!task.workspacePath || !task.jobId || !task.candidateId) return;
    const taskPhase = taskExecutionPhaseValue(task);
    const files = buildTaskFilePaths(task.workspacePath, task.taskId, taskPhase);
    const dispatchKey = factoryDispatchKey();
    await this.queue.enqueue({
      jobId: factoryMonitorJobId(state.objectiveId, task.taskId, task.candidateId, taskPhase, dispatchKey),
      agentId: FACTORY_MONITOR_AGENT_ID,
      lane: "collect",
      sessionKey: `factory:monitor:${state.objectiveId}:${task.taskId}`,
      singletonMode: "allow",
      maxAttempts: 1,
      payload: {
        kind: "factory.task.monitor",
        objectiveId: state.objectiveId,
        taskId: task.taskId,
        candidateId: task.candidateId,
        codexJobId: task.jobId,
        stdoutPath: files.stdoutPath,
        stderrPath: files.stderrPath,
        taskPrompt: task.prompt,
        splitDepth: task.splitDepth ?? 0,
        objectiveMode: state.objectiveMode,
        severity: state.severity,
        evidenceDir: path.join(path.dirname(files.stdoutPath), "evidence"),
      } satisfies FactoryMonitorJobPayload,
    });
  }

  private async syncActiveTaskMonitors(state: FactoryState): Promise<void> {
    const activeTasks = state.workflow.activeTaskIds
      .map((taskId) => state.workflow.tasksById[taskId])
      .filter((task): task is FactoryTaskRecord => Boolean(task) && task.status === "running");
    if (activeTasks.length === 0) return;
    const jobs = await this.listObjectiveScopedJobs(state.objectiveId, 2000);
    for (const task of activeTasks) {
      const activeMonitor = jobs.find((job) =>
        this.isFactoryMonitorJob(job)
        && isActiveQueueJobStatus(job.status)
        && job.payload.taskId === task.taskId
        && job.payload.candidateId === task.candidateId,
      );
      if (activeMonitor) {
        if (activeMonitor.status === "queued" && this.redriveQueuedJob) {
          await this.redriveQueuedJob(activeMonitor);
        }
        continue;
      }
      await this.enqueueTaskMonitor(state, task);
    }
  }

  private async applyMonitorRecommendation(
    state: FactoryState,
    recommendation: FactoryObjectivePlannerFacts["monitorRecommendations"][number],
  ): Promise<boolean> {
    state = await this.getObjectiveState(state.objectiveId);
    const task = state.workflow.tasksById[recommendation.taskId];
    if (!task || task.candidateId !== recommendation.candidateId) {
      await this.emitObjective(state.objectiveId, {
        type: "monitor.recommendation.obsoleted",
        objectiveId: state.objectiveId,
        recommendationId: recommendation.recommendationId,
        taskId: recommendation.taskId,
        candidateId: recommendation.candidateId,
        reason: "task candidate advanced before control consumed the monitor recommendation",
        obsoletedAt: Date.now(),
      }).catch(() => undefined);
      return false;
    }
    if (!["running", "reviewing"].includes(task.status)) {
      await this.emitObjective(state.objectiveId, {
        type: "monitor.recommendation.obsoleted",
        objectiveId: state.objectiveId,
        recommendationId: recommendation.recommendationId,
        taskId: recommendation.taskId,
        candidateId: recommendation.candidateId,
        reason: `task status advanced to ${task.status} before control consumed the monitor recommendation`,
        obsoletedAt: Date.now(),
      }).catch(() => undefined);
      return false;
    }
    const basedOn = await this.currentHeadHash(state.objectiveId);

    switch (recommendation.recommendation.kind) {
      case "continue":
        return false;
      case "recommend_enter_synthesizing": {
        if (taskExecutionPhaseAtLeast(task, "synthesizing")) {
          await this.emitObjective(state.objectiveId, {
            type: "monitor.recommendation.obsoleted",
            objectiveId: state.objectiveId,
            recommendationId: recommendation.recommendationId,
            taskId: recommendation.taskId,
            candidateId: recommendation.candidateId,
            reason: "task already entered synthesizing before control consumed the recommendation",
            obsoletedAt: Date.now(),
          }).catch(() => undefined);
          return false;
        }
        await this.cancelTaskExecutionJob(
          task,
          `controller retired evidence collection after monitor recommendation for ${task.taskId}`,
        );
        const prefixEvents: FactoryEvent[] = [
          this.runtimeDecisionEvent(
            state,
            `monitor_recommendation_${task.taskId}_enter_synthesizing`,
            recommendation.reasoning,
            { basedOn, frontierTaskIds: [task.taskId] },
          ),
        ];
        if (!taskExecutionPhaseAtLeast(task, "evidence_ready")) {
          prefixEvents.push({
            type: "task.phase.transitioned",
            objectiveId: state.objectiveId,
            taskId: task.taskId,
            candidateId: recommendation.candidateId,
            phase: "evidence_ready",
            reason: recommendation.recommendation.reason,
            changedAt: Date.now(),
          });
        }
        const dispatchKey = factoryDispatchKey();
        prefixEvents.push({
          type: "task.synthesis.dispatched",
          objectiveId: state.objectiveId,
          taskId: task.taskId,
          candidateId: recommendation.candidateId,
          jobId: factoryTaskRunJobId(state.objectiveId, task.taskId, recommendation.candidateId, "synthesizing", dispatchKey),
          detail: recommendation.recommendation.reason,
          dispatchedAt: Date.now(),
        });
        await this.dispatchTask(state, task, {
          expectedPrev: basedOn,
          prefixEvents,
          dispatchKey,
          taskPhaseOverride: "synthesizing",
        });
        await this.emitObjective(state.objectiveId, {
          type: "monitor.recommendation.consumed",
          objectiveId: state.objectiveId,
          recommendationId: recommendation.recommendationId,
          taskId: recommendation.taskId,
          candidateId: recommendation.candidateId,
          outcome: "enter_synthesizing",
          consumedAt: Date.now(),
        });
        return true;
      }
      case "recommend_steer": {
        if (taskExecutionPhaseAtLeast(task, "evidence_ready")) {
          return this.applyMonitorRecommendation(state, {
            ...recommendation,
            recommendation: {
              kind: "recommend_enter_synthesizing",
              reason: recommendation.recommendation.guidance,
            },
          });
        }
        await this.cancelTaskExecutionJob(
          task,
          `controller retired collection run for ${task.taskId} after monitor course correction`,
        );
        await this.emitObjectiveBatch(state.objectiveId, [
          this.runtimeDecisionEvent(
            state,
            `monitor_recommendation_${task.taskId}_follow_up`,
            recommendation.reasoning,
            { basedOn, frontierTaskIds: [task.taskId] },
          ),
          {
            type: "objective.operator.noted",
            objectiveId: state.objectiveId,
            message: recommendation.recommendation.guidance,
            notedAt: Date.now(),
          },
        ], basedOn);
        const refreshed = await this.getObjectiveState(state.objectiveId);
        await this.emitFollowUpTaskFromLatestNote(refreshed, recommendation.recommendation.guidance);
        await this.emitObjective(state.objectiveId, {
          type: "monitor.recommendation.consumed",
          objectiveId: state.objectiveId,
          recommendationId: recommendation.recommendationId,
          taskId: recommendation.taskId,
          candidateId: recommendation.candidateId,
          outcome: "follow_up",
          consumedAt: Date.now(),
        });
        return true;
      }
      case "recommend_split":
        await this.cancelTaskExecutionJob(task, `controller splitting ${task.taskId} after monitor recommendation`);
        await this.emitObjectiveBatch(state.objectiveId, [
          this.runtimeDecisionEvent(
            state,
            `monitor_recommendation_${task.taskId}_split`,
            recommendation.reasoning,
            { basedOn, frontierTaskIds: [task.taskId] },
          ),
        ], basedOn);
        await this.splitTask(state.objectiveId, task.taskId, recommendation.recommendation.subtasks);
        await this.emitObjective(state.objectiveId, {
          type: "monitor.recommendation.consumed",
          objectiveId: state.objectiveId,
          recommendationId: recommendation.recommendationId,
          taskId: recommendation.taskId,
          candidateId: recommendation.candidateId,
          outcome: "split",
          consumedAt: Date.now(),
        });
        return true;
      case "recommend_abort": {
        await this.cancelTaskExecutionJob(task, `controller aborting ${task.taskId} after monitor recommendation`);
        await this.emitObjectiveBatch(state.objectiveId, [
          this.runtimeDecisionEvent(
            state,
            `monitor_recommendation_${task.taskId}_abort`,
            recommendation.reasoning,
            { basedOn, frontierTaskIds: [task.taskId] },
          ),
          ...(await this.buildObjectiveBlockedEvents(state, recommendation.recommendation.reason)),
        ], basedOn);
        await this.emitObjective(state.objectiveId, {
          type: "monitor.recommendation.consumed",
          objectiveId: state.objectiveId,
          recommendationId: recommendation.recommendationId,
          taskId: recommendation.taskId,
          candidateId: recommendation.candidateId,
          outcome: "abort",
          consumedAt: Date.now(),
        });
        return true;
      }
    }
  }

  private shouldEmitMonitorRecommendation(
    taskPhase: FactoryTaskExecutionPhase,
    recommendation: MonitorRecommendation,
    priorRecommendation?: MonitorRecommendation,
  ): boolean {
    if (taskPhase === "synthesizing" && recommendation.kind === "recommend_enter_synthesizing") {
      return false;
    }
    if (priorRecommendation && monitorRecommendationsEqual(priorRecommendation, recommendation)) {
      return false;
    }
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

    for (const recommendation of facts.monitorRecommendations) {
      if (await this.applyMonitorRecommendation(state, recommendation)) return true;
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
        case "task.handle_monitor_recommendation":
          return [];
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
          const completedEvent = {
            type: "objective.completed" as const,
            objectiveId: state.objectiveId,
            summary: effect.summary,
            completedAt,
          };
          await this.emitObjectiveBatch(state.objectiveId, [
            completedEvent,
            await this.buildRenderedObjectiveHandoffEvent({
              state,
              status: "completed",
              summary: effect.summary,
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
            await this.buildRenderedObjectiveHandoffEvent({
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
    try {
      await reactFactoryObjective(objectiveId, {
        getObjectiveState: (targetObjectiveId) => this.getObjectiveState(targetObjectiveId),
        isTerminalObjectiveStatus: (status) => this.isTerminalObjectiveStatus(status),
        rebalanceObjectiveSlots: () => this.rebalanceObjectiveSlots(),
        syncFailedActiveTasks: (state) => this.syncFailedActiveTasks(state),
        syncActiveTaskMonitors: (state) => this.syncActiveTaskMonitors(state),
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
    } catch (err) {
      if (!isFactoryStaleObjectiveConflict(err)) throw err;
      await this.enqueueObjectiveControl(objectiveId, "reconcile").catch(() => undefined);
    }
  }

  async runTask(payload: Record<string, unknown>, control?: CodexRunControl): Promise<Record<string, unknown>> {
    await this.ensureBootstrap();
    const parsed = this.parseTaskPayload(payload);
    let state = await this.getObjectiveState(parsed.objectiveId);
    let task = state.workflow.tasksById[parsed.taskId];
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
      return {
        objectiveId: parsed.objectiveId,
        taskId: parsed.taskId,
        candidateId: parsed.candidateId,
        status: "blocked",
      };
    }
    const jobId = parsed.jobId;
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
        this.baseWorkerTaskProfile(parsed.profile),
      );
    }
    const packetPresent = await this.taskPacketPresent(parsed);
    if (rebuiltPacket || !packetPresent || parsed.executionMode === "worktree") {
      const baseProfile = this.objectiveProfileForState(state);
      const includeCloudExecutionContext = taskNeedsCloudExecutionContext({
        profileId: baseProfile.rootProfileId,
        profileCloudProvider: baseProfile.cloudProvider,
        taskTitle: task.title,
        taskPrompt: task.prompt,
      });
      const cloudExecutionContext = includeCloudExecutionContext
        ? await this.loadObjectiveCloudExecutionContext(baseProfile)
        : undefined;
      const packet = await this.writeTaskPacket(
        state,
        task,
        parsed.candidateId,
        parsed.workspacePath,
        parsed.taskPhase,
        parsed.profile,
        cloudExecutionContext,
      );
      await archiveFactoryTaskPacketArtifacts({
        dataDir: this.dataDir,
        jobId,
        manifestPath: packet.manifestPath,
        contextSummaryPath: packet.contextSummaryPath,
        contextPackPath: packet.contextPackPath,
        memoryConfigPath: packet.memoryConfigPath,
        memoryScriptPath: packet.memoryScriptPath,
        receiptCliPath: packet.receiptCliPath,
      });
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
    let execution;
    while (true) {
      try {
        state = await this.getObjectiveState(parsed.objectiveId);
        task = state.workflow.tasksById[parsed.taskId];
        if (!task) throw new FactoryServiceError(404, "factory task not found");
        const prompt = await this.renderTaskPrompt(state, task, parsed, guidanceHistory);
        await archiveFactoryTaskPrompt({
          dataDir: this.dataDir,
          jobId,
          prompt,
        });
        execution = await this.codexExecutor.run({
          prompt,
          workspacePath: parsed.workspacePath,
          promptPath: parsed.promptPath,
          lastMessagePath: parsed.lastMessagePath,
          stdoutPath: parsed.stdoutPath,
          stderrPath: parsed.stderrPath,
          evidencePath: parsed.evidencePath,
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
            DATA_DIR: workspaceCommandEnv.commandDataDir,
            RECEIPT_DATA_DIR: workspaceCommandEnv.commandDataDir,
            PATH: workspaceCommandEnv.path,
          },
        }, control);
        break;
      } catch (error) {
        if (!(error instanceof CodexControlSignalError) || error.signal.kind !== "restart") throw error;
        const guidance = parseFactoryLiveGuidance(error.signal);
        if (!guidance) throw error;
        guidanceHistory.push(guidance);
        if (parsed.taskPhase === "synthesizing" && guidanceHistory.length >= 3) {
          const fallbackResult = await this.buildFallbackInvestigationTaskResult(
            parsed,
            error.result,
            new Error("Synthesizing restart limit reached before the worker emitted a structured result."),
          );
          await fs.writeFile(parsed.resultPath, JSON.stringify(fallbackResult, null, 2), "utf-8");
          await this.applyTaskWorkerResult(parsed, fallbackResult);
          await this.reactObjective(parsed.objectiveId);
          return {
            objectiveId: parsed.objectiveId,
            taskId: parsed.taskId,
            candidateId: parsed.candidateId,
            status: "completed",
          };
        }
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
            presentation: effect.presentation,
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
            presentation: effect.presentation,
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
    return canTaskRunnerAutonomouslyResolveDeliveryPartial({
      ...input,
      controllerResolvableDeliveryPartialRe: CONTROLLER_RESOLVABLE_DELIVERY_PARTIAL_RE,
    });
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
    return buildTaskRunnerWorkerHandoffEvent(input);
  }

  private buildObjectiveHandoffEvent(input: {
    readonly state: FactoryState;
    readonly status: FactoryObjectiveHandoffStatus;
    readonly summary: string;
    readonly renderedBody?: string;
    readonly renderSourceHash?: string;
    readonly renderedAt?: number;
    readonly renderedBy?: "orchestrator_llm" | "fallback";
    readonly output?: string;
    readonly sourceUpdatedAt: number;
    readonly blocker?: string;
    readonly nextAction?: string;
  }): Extract<FactoryEvent, { readonly type: "objective.handoff" }> {
    return buildTaskRunnerObjectiveHandoffEvent(input);
  }

  private mergeArtifactRefs(
    records: ReadonlyArray<Readonly<Record<string, GraphRef>> | undefined>,
  ): Readonly<Record<string, GraphRef>> {
    return Object.fromEntries(
      records.flatMap((record) => Object.entries(record ?? {})),
    );
  }

  private inheritedArtifactDestination(
    workspacePath: string,
    sourcePath: string,
    label?: string,
  ): string {
    const packetDir = path.join(workspacePath, ".receipt", "factory");
    const normalized = sourcePath.replace(/\\/g, "/");
    const marker = "/.receipt/factory/";
    const markerIndex = normalized.lastIndexOf(marker);
    if (markerIndex >= 0) {
      const relative = normalized.slice(markerIndex + marker.length);
      return path.join(packetDir, relative);
    }
    const fileName = path.basename(label?.trim() || sourcePath);
    return path.join(packetDir, "inherited", fileName);
  }

  private async materializeInheritedReadableArtifacts(
    workspacePath: string,
    refs: ReadonlyArray<GraphRef>,
  ): Promise<ReadonlyArray<FactoryReadableArtifact>> {
    const readableArtifacts: FactoryReadableArtifact[] = [];
    for (const ref of refs) {
      if (ref.kind !== "artifact" && ref.kind !== "file") continue;
      const sourcePath = optionalTrimmedString(ref.ref);
      if (!sourcePath || !path.isAbsolute(sourcePath)) continue;
      const label = path.basename(optionalTrimmedString(ref.label) || sourcePath);
      if (!READABLE_FACTORY_ARTIFACT_RE.test(label)) continue;
      const stat = await fs.stat(sourcePath).catch(() => undefined);
      if (!stat?.isFile() || stat.size <= 0) continue;
      readableArtifacts.push({
        path: sourcePath,
        label,
        bytes: stat.size,
      });
    }
    return this.materializeReadableArtifactsIntoWorkspace(workspacePath, readableArtifacts);
  }

  private async materializeReadableArtifactsIntoWorkspace(
    workspacePath: string,
    artifacts: ReadonlyArray<FactoryReadableArtifact>,
  ): Promise<ReadonlyArray<FactoryReadableArtifact>> {
    const copied = new Map<string, FactoryReadableArtifact>();
    for (const artifact of artifacts) {
      const sourcePath = artifact.path;
      const label = path.basename(artifact.label);
      if (!READABLE_FACTORY_ARTIFACT_RE.test(label)) continue;
      const destinationPath = this.inheritedArtifactDestination(workspacePath, sourcePath, label);
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      if (destinationPath !== sourcePath) {
        await fs.copyFile(sourcePath, destinationPath).catch(() => undefined);
      }
      const copiedStat = await fs.stat(destinationPath).catch(() => undefined);
      if (!copiedStat?.isFile()) continue;
      copied.set(destinationPath, {
        path: destinationPath,
        label,
        bytes: copiedStat.size,
      });
    }
    return [...copied.values()]
      .sort((left, right) => right.bytes - left.bytes || left.label.localeCompare(right.label));
  }

  private latestRenderableCandidate(
    state: FactoryState,
    status: FactoryObjectiveHandoffStatus,
  ): FactoryCandidateRecord | undefined {
    for (let index = state.candidateOrder.length - 1; index >= 0; index -= 1) {
      const candidateId = state.candidateOrder[index]!;
      const candidate = state.candidates[candidateId];
      if (!candidate) continue;
      if (status === "completed") {
        if (candidate.status === "approved" || candidate.status === "integrated") return candidate;
        continue;
      }
      if (candidate.status === "planned") continue;
      return candidate;
    }
    return undefined;
  }

  private buildObjectiveHandoffFallbackBody(input: {
    readonly status: FactoryObjectiveHandoffStatus;
    readonly summary: string;
    readonly blocker?: string;
    readonly nextAction?: string;
    readonly candidate?: FactoryCandidateRecord;
    readonly presentation?: FactoryTaskPresentationRecord;
    readonly report?: FactoryInvestigationReport;
    readonly artifacts: ReadonlyArray<FactoryTerminalRenderArtifact>;
  }): string {
    const lines: string[] = [];
    const inlineBody = optionalTrimmedString(input.presentation?.inlineBody)
      ?? optionalTrimmedString(input.candidate?.handoff);
    const normalizedInline = inlineBody?.trim();
    if (normalizedInline && normalizedInline !== input.summary.trim()) {
      lines.push(normalizedInline);
    } else {
      lines.push(input.summary);
    }
    const reportConclusion = optionalTrimmedString(input.report?.conclusion);
    if (reportConclusion && reportConclusion !== input.summary.trim() && reportConclusion !== normalizedInline) {
      lines.push(reportConclusion);
    }
    if (input.artifacts.length > 0) {
      lines.push([
        "Artifacts:",
        ...input.artifacts.map((artifact) => `- ${artifact.label}: ${artifact.ref.ref}`),
      ].join("\n"));
    }
    if (input.status === "blocked" && input.blocker) {
      lines.push(`Blocker: ${input.blocker}`);
    }
    if (input.nextAction) {
      lines.push(`Next action: ${input.nextAction}`);
    }
    return lines.filter(Boolean).join("\n\n").trim() || input.summary;
  }

  private async loadTerminalRenderArtifacts(input: {
    readonly artifactRefs: Readonly<Record<string, GraphRef>>;
    readonly presentation?: FactoryTaskPresentationRecord;
  }): Promise<ReadonlyArray<FactoryTerminalRenderArtifact>> {
    const preferredLabels = new Set(input.presentation?.primaryArtifactLabels ?? []);
    const refs = Object.values(input.artifactRefs)
      .filter((ref) => ref.kind === "artifact" || ref.kind === "file");
    const ordered = refs
      .sort((a, b) => {
        const aPreferred = preferredLabels.has(a.label ?? "") ? 0 : 1;
        const bPreferred = preferredLabels.has(b.label ?? "") ? 0 : 1;
        if (aPreferred !== bPreferred) return aPreferred - bPreferred;
        return (a.label ?? a.ref).localeCompare(b.label ?? b.ref);
      })
      .slice(0, TERMINAL_RENDER_MAX_ARTIFACTS);
    const artifacts = await Promise.all(ordered.map(async (ref) => {
      if (!TERMINAL_RENDER_TEXT_FILE_RE.test(ref.ref)) {
        return {
          label: ref.label ?? path.basename(ref.ref),
          ref,
        } satisfies FactoryTerminalRenderArtifact;
      }
      try {
        const content = await fs.readFile(ref.ref, "utf-8");
        const trimmed = content.trim();
        const truncated = Buffer.byteLength(trimmed, "utf-8") > TERMINAL_RENDER_MAX_FILE_BYTES;
        const contentPreview = truncated
          ? trimmed.slice(0, TERMINAL_RENDER_MAX_FILE_BYTES)
          : trimmed;
        return {
          label: ref.label ?? path.basename(ref.ref),
          ref,
          ...(contentPreview ? { contentPreview } : {}),
          ...(truncated ? { contentTruncated: true } : {}),
        } satisfies FactoryTerminalRenderArtifact;
      } catch {
        return {
          label: ref.label ?? path.basename(ref.ref),
          ref,
        } satisfies FactoryTerminalRenderArtifact;
      }
    }));
    return artifacts;
  }

  private async defaultTerminalRenderer(input: FactoryTerminalRenderInput): Promise<string> {
    const system = [
      input.profile.promptBody?.trim(),
      input.profile.soulBody?.trim(),
      "Render the final user-facing factory objective handoff.",
      "Use the task presentation, report, and artifact previews as source of truth.",
      "Keep summary metadata terse and focus on the actual returned result.",
      "If an artifact preview already contains a markdown table or report that directly answers the objective, preserve it rather than rephrasing it.",
      "Do not mention internal controller/runtime mechanics unless they materially affect the outcome.",
      "Return markdown only. Do not wrap the response in code fences.",
    ].filter((part): part is string => Boolean(part && part.trim())).join("\n\n");
    const user = JSON.stringify({
      objectiveId: input.objectiveId,
      title: input.title,
      objectiveMode: input.objectiveMode,
      status: input.status,
      summary: input.summary,
      blocker: input.blocker,
      nextAction: input.nextAction,
      task: input.task,
      report: input.report,
      artifacts: input.artifacts,
    }, null, 2);
    return llmText({
      system,
      user,
    });
  }

  private async buildRenderedObjectiveHandoffEvent(input: {
    readonly state: FactoryState;
    readonly status: FactoryObjectiveHandoffStatus;
    readonly summary: string;
    readonly sourceUpdatedAt: number;
    readonly blocker?: string;
    readonly nextAction?: string;
  }): Promise<Extract<FactoryEvent, { readonly type: "objective.handoff" }>> {
    const resolvedProfile = await resolveFactoryChatProfile({
      requestedId: input.state.profile.rootProfileId,
      repoRoot: this.git.repoRoot,
      profileRoot: this.profileRoot,
    }).catch(() => undefined);
    const candidate = this.latestRenderableCandidate(input.state, input.status);
    const investigationReport = input.state.objectiveMode === "investigation"
      ? (
          input.state.investigation.synthesized?.report
          ?? this.finalInvestigationReports(input.state).at(-1)?.report
          ?? this.investigationReports(input.state).at(-1)?.report
        )
      : undefined;
    const investigationTask = input.state.objectiveMode === "investigation"
      ? (
          this.finalInvestigationReports(input.state).at(-1)
          ?? this.investigationReports(input.state).at(-1)
        )
      : undefined;
    const presentation = candidate?.presentation
      ?? investigationTask?.presentation;
    const artifactRefs = input.state.objectiveMode === "investigation"
      ? this.mergeArtifactRefs(
        input.status === "completed"
          ? this.finalInvestigationReports(input.state).map((report) => report.artifactRefs)
          : [investigationTask?.artifactRefs],
      )
      : candidate?.artifactRefs ?? {};
    const artifacts = await this.loadTerminalRenderArtifacts({
      artifactRefs,
      presentation,
    });
    const fallbackBody = this.buildObjectiveHandoffFallbackBody({
      status: input.status,
      summary: input.summary,
      blocker: input.blocker,
      nextAction: input.nextAction,
      candidate,
      presentation,
      report: investigationReport,
      artifacts,
    });
    const renderInput: FactoryTerminalRenderInput = {
      objectiveId: input.state.objectiveId,
      title: input.state.title,
      objectiveMode: input.state.objectiveMode,
      status: input.status,
      summary: input.summary,
      blocker: input.blocker,
      nextAction: input.nextAction,
      sourceUpdatedAt: input.sourceUpdatedAt,
      profile: {
        id: input.state.profile.rootProfileId,
        label: input.state.profile.rootProfileLabel,
        promptPath: resolvedProfile?.promptPath,
        promptBody: resolvedProfile?.root.mdBody,
        soulPath: resolvedProfile?.root.soulPath,
        soulBody: resolvedProfile?.root.soulBody,
        resolvedHash: resolvedProfile?.resolvedHash ?? input.state.profile.resolvedProfileHash,
      },
      ...(candidate || investigationTask
        ? {
            task: {
              taskId: candidate?.taskId ?? investigationTask?.taskId ?? "task",
              candidateId: candidate?.candidateId ?? investigationTask?.candidateId,
              summary: candidate?.summary ?? investigationTask?.summary,
              handoff: candidate?.handoff ?? investigationTask?.handoff,
              presentation,
            },
          }
        : {}),
      ...(investigationReport ? { report: investigationReport } : {}),
      artifacts,
      fallbackBody,
    };
    const renderSourceHash = createHash("sha1")
      .update(JSON.stringify(renderInput))
      .digest("hex")
      .slice(0, 16);
    if (
      input.state.latestHandoff?.renderSourceHash === renderSourceHash
      && input.state.latestHandoff.renderedBody
    ) {
      return this.buildObjectiveHandoffEvent({
        ...input,
        renderedBody: input.state.latestHandoff.renderedBody,
        renderSourceHash,
        renderedAt: input.state.latestHandoff.renderedAt ?? input.sourceUpdatedAt,
        renderedBy: input.state.latestHandoff.renderedBy ?? "fallback",
        output: input.state.latestHandoff.renderedBody,
      });
    }
    let renderedBody = fallbackBody;
    let renderedBy: "orchestrator_llm" | "fallback" = "fallback";
    try {
      const renderer = this.terminalRenderer ?? ((terminalInput: FactoryTerminalRenderInput) => this.defaultTerminalRenderer(terminalInput));
      const rendered = trimmedString(await renderer(renderInput));
      if (rendered) {
        renderedBody = rendered;
        renderedBy = "orchestrator_llm";
      }
    } catch {
      renderedBody = fallbackBody;
      renderedBy = "fallback";
    }
    return this.buildObjectiveHandoffEvent({
      ...input,
      renderedBody,
      renderSourceHash,
      renderedAt: Date.now(),
      renderedBy,
      output: renderedBody,
    });
  }

  async runChecks(commands: ReadonlyArray<string>, workspacePath: string): Promise<ReadonlyArray<FactoryCheckResult>> {
    return runFactoryChecks({
      commands,
      workspacePath,
      dataDir: this.dataDir,
      repoRoot: this.git.repoRoot,
      worktreesDir: this.git.worktreesDir,
    });
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
    const normalizedStructuredInvestigationReport = hasStructuredInvestigationReport
      ? normalizeInvestigationReport(rawResult.report, summary)
      : undefined;
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
    const presentation = normalizeTaskPresentationRecord({
      value: rawResult.presentation,
      handoff: explicitHandoff,
      summary: effectiveSummary,
      workerArtifacts,
      report: normalizedStructuredInvestigationReport,
    });
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
    const structuredEvidenceFailure = validateTaskEvidence({
      objectiveId: payload.objectiveId,
      taskId: payload.taskId,
      objectiveMode: state.objectiveMode,
      outcome,
      completion: initialCompletion,
      scriptsRun: state.objectiveMode === "investigation"
        ? normalizedStructuredInvestigationReport?.scriptsRun
        : scriptsRun,
      hasAlignment: state.objectiveMode === "delivery"
        ? isRecord(rawResult.alignment)
        : undefined,
      hasStructuredReport: state.objectiveMode === "investigation"
        ? hasStructuredInvestigationReport
        : undefined,
      reportIncludesEvidenceRecords: hasStructuredInvestigationReport && isRecord(rawResult.report)
        ? Object.hasOwn(rawResult.report, "evidenceRecords")
        : false,
      reportEvidenceRecords: normalizedStructuredInvestigationReport?.evidenceRecords,
    });
    if (structuredEvidenceFailure) throw new FactoryServiceError(400, structuredEvidenceFailure);

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
          presentation,
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
          presentation,
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
      evidence: fileRef(payload.evidencePath, "task evidence"),
      ...(payload.contextSummaryPath ? { contextSummary: fileRef(payload.contextSummaryPath, "task context summary") } : {}),
      contextPack: fileRef(payload.contextPackPath, "task recursive context pack"),
      memoryScript: fileRef(payload.memoryScriptPath, "task memory script"),
      memoryConfig: fileRef(payload.memoryConfigPath, "task memory config"),
    } satisfies Readonly<Record<string, GraphRef>>;
    const workerArtifactRefs = Object.fromEntries(
      workerArtifacts.flatMap((item, index) => {
        const rawPath = optionalTrimmedString(item.path);
        if (!rawPath) return [];
        const resolvedPath = path.isAbsolute(rawPath)
          ? rawPath
          : path.resolve(payload.workspacePath, rawPath);
        return [[artifactKeyFromLabel(item.label, index), artifactRef(resolvedPath, item.label)] as const];
      }),
    ) satisfies Readonly<Record<string, GraphRef>>;

    if (isInvestigation) {
      const report = normalizedStructuredInvestigationReport
        ?? normalizeInvestigationReport(
            {
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
        ...workerArtifactRefs,
        ...(committed ? { commit: commitRef(committed.hash, "evidence commit") } : {}),
      } satisfies Readonly<Record<string, GraphRef>>;
      const investigationEvents: FactoryEvent[] = [
        workerHandoff,
        ...(payload.taskPhase === "synthesizing"
          ? [(
              outcome === "blocked"
                ? {
                    type: "task.synthesis.blocked",
                    objectiveId: payload.objectiveId,
                    taskId: payload.taskId,
                    candidateId: payload.candidateId,
                    reason: effectiveSummary,
                    blockedAt: completedAt,
                  }
                : {
                    type: "task.synthesis.completed",
                    objectiveId: payload.objectiveId,
                    taskId: payload.taskId,
                    candidateId: payload.candidateId,
                    summary: effectiveSummary,
                    completedAt,
                  }
            ) satisfies FactoryEvent]
          : []),
        {
          type: "investigation.reported",
          objectiveId: payload.objectiveId,
          taskId: payload.taskId,
          candidateId: payload.candidateId,
          outcome,
          summary: effectiveSummary,
          handoff,
          presentation,
          completion: investigationCompletion,
          report: reportWithChecks,
          artifactRefs: resultRefs,
          evidenceCommit: committed?.hash,
          reportedAt: completedAt,
        },
      ];
      await this.emitObjectiveBatch(payload.objectiveId, investigationEvents);
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
        outcome === "blocked"
          ? "investigation_reported_partial"
          : outcome === "partial"
            ? "investigation_reported_with_gaps"
            : "investigation_reported",
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
      ...workerArtifactRefs,
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
    const finalCandidatePresentation: FactoryTaskPresentationRecord = (
      presentation.kind === "inline"
      || presentation.kind === "generic"
    )
      ? {
          ...presentation,
          inlineBody: candidateHandoff,
        }
      : presentation;

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
        presentation: finalCandidatePresentation,
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
        await this.buildRenderedObjectiveHandoffEvent({
          state,
          status: "blocked",
          summary: blockedSummary,
          blocker: blockedEvent.reason,
          sourceUpdatedAt: conflictedAt,
        }),
      ]);
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
    return { objectiveId: parsed.objectiveId, candidateId: parsed.candidateId, status: "completed" };
  }

  async loadFreshJob(jobId: string): Promise<JobRecord | undefined> {
    return this.queue.getJob(jobId);
  }

  private async listObjectiveScopedJobs(
    objectiveId: string,
    limit = 20,
  ): Promise<ReadonlyArray<QueueJob>> {
    const jobs = await this.queue.listJobs({ limit: 2000 });
    return jobs
      .filter((job) => objectiveIdForQueueJob(job) === objectiveId)
      .sort(compareObjectiveScopedJobs)
      .slice(0, Math.max(1, limit));
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
      readonly dispatchKey?: string;
      readonly taskPhaseOverride?: FactoryTaskExecutionPhase;
      readonly controllerGuidanceOverride?: string;
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
    const taskPhase = opts?.taskPhaseOverride ?? task.executionPhase ?? "collecting_evidence";
    const dispatchKey = opts?.dispatchKey ?? factoryDispatchKey();
    const dispatchBaseCommit = this.resolveTaskBaseCommit(state, task);
    const workspaceId = `${state.objectiveId}_${task.taskId}_${candidateId}`;
    const executionMode = this.taskExecutionMode(state, task);
    const includeCloudExecutionContext = taskNeedsCloudExecutionContext({
      profileId: profile.rootProfileId,
      profileCloudProvider: profile.cloudProvider,
      taskTitle: task.title,
      taskPrompt: task.prompt,
    });
    const cloudExecutionContext = includeCloudExecutionContext
      ? await this.loadObjectiveCloudExecutionContext(profile)
      : undefined;
    const workerProfile = await this.resolveWorkerTaskProfile(profile, cloudExecutionContext);
    const workspace = await ensureFactoryTaskRuntime({
      dataDir: this.dataDir,
      executionMode,
      git: this.git,
      profile: workerProfile,
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
    const jobId = factoryTaskRunJobId(state.objectiveId, task.taskId, candidateId, taskPhase, dispatchKey);
    const manifest = await this.writeTaskPacket(
      state,
      task,
      candidateId,
      workspace.path,
      taskPhase,
      workerProfile,
      cloudExecutionContext,
      pinnedBaseCommit,
    );
    await archiveFactoryTaskPacketArtifacts({
      dataDir: this.dataDir,
      jobId,
      manifestPath: manifest.manifestPath,
      contextSummaryPath: manifest.contextSummaryPath,
      contextPackPath: manifest.contextPackPath,
      memoryConfigPath: manifest.memoryConfigPath,
      memoryScriptPath: manifest.memoryScriptPath,
      receiptCliPath: manifest.receiptCliPath,
    });
    await this.emitObjectiveBatch(state.objectiveId, [
      ...(opts?.prefixEvents ?? []),
      ...(candidateCreated ? [candidateCreated] : []),
      {
        type: "task.dispatched",
        objectiveId: state.objectiveId,
        taskId: task.taskId,
        candidateId,
        taskPhase,
        jobId,
        workspaceId,
        workspacePath: workspace.path,
        skillBundlePaths: manifest.skillBundlePaths,
        contextRefs: manifest.contextRefs,
        startedAt: Date.now(),
      },
    ], opts?.expectedPrev);

    const payload: FactoryTaskJobPayload = {
      kind: "factory.task.run",
      jobId,
      objectiveId: state.objectiveId,
      taskId: task.taskId,
      taskPhase,
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
      evidencePath: manifest.evidencePath,
      manifestPath: manifest.manifestPath,
      contextSummaryPath: manifest.contextSummaryPath,
      contextPackPath: manifest.contextPackPath,
      memoryScriptPath: manifest.memoryScriptPath,
      memoryConfigPath: manifest.memoryConfigPath,
      receiptCliPath: manifest.receiptCliPath,
      repoSkillPaths: manifest.repoSkillPaths,
      skillBundlePaths: manifest.skillBundlePaths,
      profile: workerProfile,
      profilePromptHash: profile.promptHash,
      profileSkillRefs: workerProfile.selectedSkills,
      sharedArtifactRefs: manifest.sharedArtifactRefs,
      contextRefs: manifest.contextRefs,
      integrationRef: state.integration.branchRef,
      problem: task.prompt,
      controllerGuidance: opts?.controllerGuidanceOverride,
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
    const monitorJobId = factoryMonitorJobId(state.objectiveId, task.taskId, candidateId, taskPhase, dispatchKey);
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
      objectiveMode: state.objectiveMode,
      severity: state.severity,
      evidenceDir: path.join(path.dirname(manifest.stdoutPath), "evidence"),
    };
    await this.queue.enqueue({
      jobId: monitorJobId,
      agentId: FACTORY_MONITOR_AGENT_ID,
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
        await this.buildRenderedObjectiveHandoffEvent({
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
          DATA_DIR: workspaceCommandEnv.commandDataDir,
          RECEIPT_DATA_DIR: workspaceCommandEnv.commandDataDir,
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
        await this.buildRenderedObjectiveHandoffEvent({
          state,
          status: "completed",
          summary,
          sourceUpdatedAt: promotedAt,
        }),
      ]);
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
        await this.buildRenderedObjectiveHandoffEvent({
          state,
          status: "blocked",
          summary: reason,
          blocker: blockedEvent.reason,
          sourceUpdatedAt: blockedAt,
        }),
      ]);
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
    executionStalled = false,
    objectiveJobs: ReadonlyArray<QueueJob> = [],
  ): Promise<FactoryObjectiveCard> {
    const slotState = (this.isTerminalObjectiveStatus(state.status) || this.releasesObjectiveSlot(state) || state.scheduler.releasedAt)
      ? "released"
      : (state.scheduler.slotState ?? "active");
    const effectiveQueuePosition = slotState === "queued" ? queuePosition : undefined;
    const cacheKey = `${state.updatedAt}:${slotState}:${effectiveQueuePosition ?? ""}:${executionStalled ? "stalled" : "live"}:${objectiveJobCacheKey(objectiveJobs)}`;
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
    const tokensUsed = Object.values(state.candidates).reduce((sum, c) => sum + (c.tokensUsed ?? 0), 0);
    const contract = this.objectiveContractForState(state);
    const alignment = this.objectiveAlignmentForState(state);
    const operationalState = deriveObjectiveOperationalState({
      state,
      taskCount: projection.tasks.length,
      executionStalled,
      objectiveJobs,
    });
    const card = buildObjectiveCardRecord({
      state,
      queuePosition: effectiveQueuePosition,
      slotState,
      displayState: operationalState.displayState,
      phaseDetail: operationalState.phaseDetail,
      statusAuthority: operationalState.statusAuthority,
      hasAuthoritativeLiveJob: operationalState.hasAuthoritativeLiveJob,
      executionStalled,
      blockedExplanation: needsBlockedReceipts
        ? buildBlockedExplanation(state, resolvedReceipts)
        : undefined,
      latestDecision: this.deriveLatestDecision(state),
      nextAction:
        operationalState.phaseDetail === "waiting_for_control"
          ? "Controller is reconciling the objective handoff before the next pass."
          : operationalState.phaseDetail === "cleaning_up"
            ? "Controller is retiring lingering jobs after the objective finished."
            : executionStalled
              ? "Execution appears stalled. Review live output, react with guidance, or cancel the objective."
              : this.deriveNextAction(state, effectiveQueuePosition),
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

  private async buildObjectiveDetail(
    state: FactoryState,
    queuePosition?: number,
    executionStalled?: boolean,
    objectiveJobsInput?: ReadonlyArray<QueueJob>,
  ): Promise<FactoryObjectiveDetail> {
    const [chain, repoSkillPaths, auditMetadata, latestAuditJob, objectiveJobs] = await Promise.all([
      this.runtime.chain(objectiveStream(state.objectiveId)),
      this.collectRepoSkillPaths(),
      readPersistedObjectiveAuditMetadata(this.dataDir, state.objectiveId),
      this.latestObjectiveAuditJob(state.objectiveId).catch(() => undefined),
      objectiveJobsInput ? Promise.resolve(objectiveJobsInput) : this.listObjectiveScopedJobs(state.objectiveId, 40),
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
        const filePaths = task?.workspacePath
          ? buildTaskFilePaths(task.workspacePath, task.taskId, task.executionPhase)
          : undefined;
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
    const resolvedExecutionStalled = executionStalled
      ?? liveExecutionSnapshotForJobs(objectiveJobs).stalledObjectiveIds.has(state.objectiveId);
    return {
      ...await this.buildObjectiveCard(state, queuePosition, receipts, resolvedExecutionStalled, objectiveJobs),
      prompt: state.prompt,
      channel: state.channel,
      baseHash: state.baseHash,
      sourceWarnings: state.sourceWarnings,
      checks: state.checks,
      profile: this.objectiveProfileForState(state),
      selfImprovement: this.buildObjectiveSelfImprovement(state, auditMetadata, latestAuditJob),
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
    const objectiveJobs = await this.listObjectiveScopedJobs(state.objectiveId, 40);
    const [detail, chain] = await Promise.all([
      this.buildObjectiveDetail(state, queuePosition, undefined, objectiveJobs),
      this.runtime.chain(objectiveStream(state.objectiveId)),
    ]);
    const activeJobs = objectiveJobs.filter((job) => !isTerminalQueueJobStatusValue(job.status)).slice(0, 12);
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
      displayState: detail.displayState,
      phaseDetail: detail.phaseDetail,
      statusAuthority: detail.statusAuthority,
      hasAuthoritativeLiveJob: detail.hasAuthoritativeLiveJob,
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
      activeJobAuthorities: activeJobs.map((job) => ({
        jobId: job.id,
        authority: classifyObjectiveLiveJobAuthority(state, job),
      })),
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
        const files = buildTaskFilePaths(task.workspacePath, task.taskId, task.executionPhase);
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
    if (this.shouldScheduleTerminalObjectiveCleanup(events)) {
      await this.rebalanceObjectiveSlots();
      await this.enqueueObjectiveControl(objectiveId, "reconcile");
    }
    await this.publishObjectiveProjectionRefresh(objectiveId, events);
  }

  private async publishObjectiveProjectionRefresh(
    objectiveId: string,
    events?: ReadonlyArray<FactoryEvent>,
  ): Promise<void> {
    this.sse.publish("factory", objectiveId);
    this.sse.publish("objective-runtime", objectiveId);
    const detail = await this.getObjective(objectiveId).catch(() => undefined);
    const profileId = detail?.profile.rootProfileId?.trim();
    if (profileId) this.sse.publish("profile-board", profileId);
    this.sse.publish("receipt");
    if (this.onObjectiveHandoff && detail && events?.some((e) => e.type === "objective.handoff")) {
      const handoff = detail.latestHandoff;
      if (handoff && profileId) {
        this.onObjectiveHandoff({
          objectiveId,
          profileId,
          handoff,
          title: detail.title,
          status: detail.status,
          phase: detail.phase ?? detail.status,
        }).catch(() => undefined);
      }
    }
  }

  private async emitObjective(objectiveId: string, event: FactoryEvent): Promise<void> {
    await this.emitObjectiveBatch(objectiveId, [event]);
  }

  private async currentHeadHash(objectiveId: string): Promise<string | undefined> {
    const chain = await this.runtime.chain(objectiveStream(objectiveId));
    return chain[chain.length - 1]?.hash;
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
      case "objective.control.wake.requested":
        return `Objective control wake requested: ${event.reason}`;
      case "objective.control.wake.consumed":
        return `Objective control wake consumed: ${event.reason}`;
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
      case "task.phase.transitioned":
        return `${event.taskId} phase -> ${event.phase}${event.reason ? `: ${event.reason}` : ""}`;
      case "task.synthesis.dispatched":
        return `${event.taskId} dispatched synthesis run for ${event.candidateId}`;
      case "task.synthesis.completed":
        return `${event.taskId} synthesis completed: ${event.summary}`;
      case "task.synthesis.blocked":
        return `${event.taskId} synthesis blocked: ${event.reason}`;
      case "monitor.recommendation":
        return `${event.taskId} monitor recommended ${event.recommendation.kind}: ${event.reasoning}`;
      case "monitor.recommendation.consumed":
        return `${event.taskId} consumed monitor recommendation via ${event.outcome}`;
      case "monitor.recommendation.obsoleted":
        return `${event.taskId} obsoleted monitor recommendation: ${event.reason}`;
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
      case "objective.control.wake.requested":
      case "objective.control.wake.consumed":
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
      case "task.phase.transitioned":
      case "task.synthesis.dispatched":
      case "task.synthesis.completed":
      case "task.synthesis.blocked":
      case "monitor.recommendation":
      case "monitor.recommendation.consumed":
      case "monitor.recommendation.obsoleted":
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
    return resolveInvestigationTaskBaseCommit(state, task);
  }

  private taskPromptPath(workspacePath: string, targetPath: string): string {
    return buildInvestigationTaskPromptPath(workspacePath, targetPath);
  }

  private async writeTaskPacket(
    state: FactoryState,
    task: FactoryTaskRecord,
    candidateId: string,
    workspacePath: string,
    taskPhase: FactoryTaskExecutionPhase,
    workerProfile: FactoryObjectiveProfileSnapshot,
    cloudExecutionContext: FactoryCloudExecutionContext | undefined,
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
    readonly evidencePath: string;
    readonly memoryScriptPath: string;
    readonly memoryConfigPath: string;
      readonly receiptCliPath: string;
    readonly repoSkillPaths: ReadonlyArray<string>;
    readonly skillBundlePaths: ReadonlyArray<string>;
    readonly sharedArtifactRefs: ReadonlyArray<GraphRef>;
    readonly contextRefs: ReadonlyArray<GraphRef>;
  }> {
    const taskPrompt = effectiveFactoryTaskPrompt({
      profileCloudProvider: workerProfile.cloudProvider,
      objectiveMode: state.objectiveMode,
      taskPrompt: task.prompt,
    });
    const files = buildTaskFilePaths(workspacePath, task.taskId, taskPhase);
    await fs.mkdir(path.dirname(files.manifestPath), { recursive: true });
    await fs.rm(files.resultPath, { force: true });
    const repoSkillPaths = await this.collectWorkerRepoSkillPaths(workerProfile);
    const memoryScopes = buildTaskMemoryScopes(state, task, candidateId, taskPrompt);
    const contextPack = await buildFactoryTaskContextPack({
      runtime: this.runtime,
      memoryTools: this.memoryTools,
      profileRoot: this.profileRoot,
      latestTaskCandidate: (inputState, taskId) => this.latestTaskCandidate(inputState, taskId),
      objectiveContractForState: (inputState, planning) => this.objectiveContractForState(inputState, planning, {
        taskPhase,
      }),
      compactCloudExecutionContextForPacket: (context) => this.compactCloudExecutionContextForPacket(context),
      buildContextSources: (inputState, repoSkills, sharedRefs) => this.buildContextSources(inputState, repoSkills, sharedRefs),
      objectiveProfileArtifactPath: (objectiveId) => this.objectiveProfileArtifactPath(objectiveId),
      objectiveSkillSelectionArtifactPath: (objectiveId) => this.objectiveSkillSelectionArtifactPath(objectiveId),
      summarizeReceipt: (event) => this.summarizeReceipt(event),
      receiptTaskOrCandidateId: (event) => this.receiptTaskOrCandidateId(event),
      objectiveStream: (objectiveId) => objectiveStream(objectiveId),
    }, state, task, candidateId, workerProfile, cloudExecutionContext, repoSkillPaths, taskPrompt);
    const objectiveContract = this.objectiveContractForState(state, contextPack.planning, {
      taskPhase,
    });
    const sourceTask = task.sourceTaskId ? state.workflow.tasksById[task.sourceTaskId] : undefined;
    const inheritedSourceArtifactRefs = task.sourceTaskId
      ? this.mergeArtifactRefs([
          this.latestTaskCandidate(state, task.sourceTaskId)?.artifactRefs,
          state.investigation.reports[task.sourceTaskId]?.artifactRefs,
        ])
      : {};
    const sourceTaskArtifactActivity = sourceTask?.workspacePath
      ? await listTaskArtifactActivity(
          sourceTask.workspacePath,
          sourceTask.taskId,
          (resultPath) => this.taskResultSchemaPath(resultPath),
        )
      : [];
    const sourceTaskReadableArtifacts = sourceTask?.workspacePath
      ? await listTaskReadableArtifacts(sourceTask.workspacePath, sourceTaskArtifactActivity)
      : [];
    const inheritedReadableArtifacts = await this.materializeInheritedReadableArtifacts(
      workspacePath,
      Object.values(inheritedSourceArtifactRefs),
    );
    const inheritedSourceWorkspaceArtifacts = await this.materializeReadableArtifactsIntoWorkspace(
      workspacePath,
      sourceTaskReadableArtifacts,
    );
    const artifactActivity = await listTaskArtifactActivity(
      workspacePath,
      task.taskId,
      (resultPath) => this.taskResultSchemaPath(resultPath),
    );
    const mountedReadableArtifacts = await listTaskReadableArtifacts(
      workspacePath,
      artifactActivity,
      [...inheritedReadableArtifacts, ...inheritedSourceWorkspaceArtifacts],
    );
    const priorArtifactRefs = this.mergeArtifactRefs([
      this.latestTaskCandidate(state, task.taskId)?.artifactRefs,
      state.candidates[candidateId]?.artifactRefs,
      state.investigation.reports[task.taskId]?.artifactRefs,
      inheritedSourceArtifactRefs,
    ]);
    const sharedArtifactRefs = dedupeGraphRefs([
      ...contextPack.contextSources.sharedArtifactRefs,
      ...Object.values(priorArtifactRefs),
      ...mountedReadableArtifacts.map((artifact) => artifactRef(artifact.path, artifact.label)),
    ]);
    const contextPackWithArtifacts: FactoryContextPack = {
      ...contextPack,
      contextSources: {
        ...contextPack.contextSources,
        sharedArtifactRefs,
      },
    };
    const contextSummary = renderTaskContextSummary(contextPackWithArtifacts, {
      mountedReadableArtifacts,
    });
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
      profile: workerProfile,
      selectedSkills: workerProfile.selectedSkills,
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
      profile: workerProfile,
      task: {
        taskId: task.taskId,
        title: task.title,
        prompt: taskPrompt,
        workerType: task.workerType,
        executionMode: task.executionMode ?? workerProfile.objectivePolicy.defaultTaskExecutionMode,
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
      receiptCli: {
        surfacePath: files.receiptCliPath,
        factoryCliPrefix: FACTORY_CLI_PREFIX,
      },
      context: {
        summaryPath: files.contextSummaryPath,
        packPath: files.contextPackPath,
      },
      contextSources: contextPackWithArtifacts.contextSources,
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
    await fs.writeFile(files.contextPackPath, JSON.stringify(contextPackWithArtifacts, null, 2), "utf-8");
    await fs.writeFile(files.manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    await fs.writeFile(files.memoryConfigPath, JSON.stringify(memoryConfig, null, 2), "utf-8");
    await fs.writeFile(files.receiptCliPath, renderFactoryReceiptCliSurface({
      objectiveId: state.objectiveId,
      taskId: task.taskId,
      candidateId,
      memoryScriptPath: files.memoryScriptPath,
      receiptCliPath: files.receiptCliPath,
      factoryCliPrefix: FACTORY_CLI_PREFIX,
    }), "utf-8");
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
      evidencePath: files.evidencePath,
      memoryScriptPath: files.memoryScriptPath,
      memoryConfigPath: files.memoryConfigPath,
      receiptCliPath: files.receiptCliPath,
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
      actionPolicy: DEFAULT_FACTORY_OBJECTIVE_PROFILE.actionPolicy,
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
    const workerProfile = await this.resolveWorkerTaskProfile(profile, cloudExecutionContext);
    const helperCatalog = await loadFactoryHelperContext({
      profileRoot: this.profileRoot,
      provider: workerProfile.cloudProvider ?? cloudExecutionContext.preferredProvider,
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
      profile: workerProfile,
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
      profileSelectedSkills: workerProfile.selectedSkills,
      repoRoot: this.git.repoRoot,
      factoryCliPrefix: FACTORY_CLI_PREFIX,
    });

    return {
      artifactPaths,
      renderedPrompt,
      readOnly,
      env: {
        DATA_DIR: workspaceCommandEnv.commandDataDir,
        RECEIPT_DATA_DIR: workspaceCommandEnv.commandDataDir,
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
    const baseProfile = this.objectiveProfileForState(state);
    const includeCloudExecutionContext = taskNeedsCloudExecutionContext({
      profileId: payload.profile.rootProfileId,
      profileCloudProvider: payload.profile.cloudProvider ?? baseProfile.cloudProvider,
      taskTitle: task.title,
      taskPrompt: task.prompt,
    });
    const cloudExecutionContext = includeCloudExecutionContext
      ? await this.loadObjectiveCloudExecutionContext(baseProfile)
      : undefined;
    const workerProfile = await this.resolveWorkerTaskProfile(baseProfile, cloudExecutionContext);
    const taskPrompt = effectiveFactoryTaskPrompt({
      profileCloudProvider: workerProfile.cloudProvider,
      objectiveMode: state.objectiveMode,
      taskPrompt: task.prompt,
    });
    const helperCatalog = await loadFactoryHelperContext({
      profileRoot: this.profileRoot,
      provider: workerProfile.cloudProvider ?? cloudExecutionContext?.preferredProvider,
      objectiveTitle: state.title,
      objectivePrompt: state.prompt,
      taskTitle: task.title,
      taskPrompt,
      domain: "infrastructure",
    });
    const infrastructureTaskGuidance = cloudExecutionContext
      ? renderInfrastructureTaskExecutionGuidance({
          profileCloudProvider: workerProfile.cloudProvider,
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
    const objectiveContract = this.objectiveContractForState(state, planningReceipt, {
      taskPhase: payload.taskPhase,
    });
    const manifestPathForPrompt = this.taskPromptPath(payload.workspacePath, payload.manifestPath);
    const contextSummaryPathForPrompt = payload.contextSummaryPath
      ? this.taskPromptPath(payload.workspacePath, payload.contextSummaryPath)
      : undefined;
    const contextPackPathForPrompt = this.taskPromptPath(payload.workspacePath, payload.contextPackPath);
    const memoryScriptPathForPrompt = this.taskPromptPath(payload.workspacePath, payload.memoryScriptPath);
    const receiptCliPathForPrompt = this.taskPromptPath(payload.workspacePath, payload.receiptCliPath);
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
      receiptCliPathForPrompt,
      resultPathForPrompt,
      liveGuidanceSection,
      factoryCliPrefix: FACTORY_CLI_PREFIX,
    });
  }

  private parseTaskPayload(payload: Record<string, unknown>): FactoryTaskJobPayload {
    if (payload.kind !== "factory.task.run") throw new FactoryServiceError(400, "invalid factory task payload");
    return {
      kind: "factory.task.run",
      jobId: requireNonEmpty(payload.jobId, "jobId required"),
      objectiveId: requireNonEmpty(payload.objectiveId, "objectiveId required"),
      taskId: requireNonEmpty(payload.taskId, "taskId required"),
      taskPhase: payload.taskPhase === "evidence_ready" || payload.taskPhase === "synthesizing"
        ? payload.taskPhase
        : "collecting_evidence",
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
      evidencePath: requireNonEmpty(payload.evidencePath, "evidencePath required"),
      manifestPath: requireNonEmpty(payload.manifestPath, "manifestPath required"),
      contextSummaryPath: optionalTrimmedString(payload.contextSummaryPath),
      contextPackPath: requireNonEmpty(payload.contextPackPath, "contextPackPath required"),
      memoryScriptPath: requireNonEmpty(payload.memoryScriptPath, "memoryScriptPath required"),
      memoryConfigPath: requireNonEmpty(payload.memoryConfigPath, "memoryConfigPath required"),
      receiptCliPath: requireNonEmpty(payload.receiptCliPath, "receiptCliPath required"),
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
      controllerGuidance: optionalTrimmedString(payload.controllerGuidance),
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
    return buildTaskRunnerResultSchemaPath(resultPath);
  }

  private async taskPacketPresent(
    payload: Pick<
      FactoryTaskJobPayload,
      "manifestPath" | "contextSummaryPath" | "contextPackPath" | "memoryScriptPath" | "memoryConfigPath" | "receiptCliPath" | "skillBundlePaths"
    >,
  ): Promise<boolean> {
    const requiredPaths = [
      payload.manifestPath,
      ...(payload.contextSummaryPath ? [payload.contextSummaryPath] : []),
      payload.contextPackPath,
      payload.memoryScriptPath,
      payload.memoryConfigPath,
      payload.receiptCliPath,
      ...payload.skillBundlePaths,
    ];
    for (const targetPath of requiredPaths) {
      if (!(await pathExists(targetPath))) return false;
    }
    return true;
  }

  private async resolveTaskWorkerResult(
    payload: FactoryTaskJobPayload,
    execution: CodexRunResult,
  ): Promise<Record<string, unknown>> {
    try {
      return await resolveFactoryTaskWorkerResult(payload, execution);
    } catch (error) {
      if (payload.objectiveMode !== "investigation") throw error;
      return this.buildFallbackInvestigationTaskResult(payload, execution, error);
    }
  }

  private async buildFallbackInvestigationTaskResult(
    payload: Pick<
      FactoryTaskJobPayload,
      "objectiveId" | "taskId" | "workspacePath" | "resultPath" | "lastMessagePath" | "evidencePath"
    >,
    execution: CodexRunResult,
    error: unknown,
  ): Promise<Record<string, unknown>> {
    const telemetry = await this.readTaskTelemetryEvidence(payload.evidencePath);
    const command = clipText(optionalTrimmedString(telemetry?.command), 220) ?? "codex exec";
    const exitCode = typeof telemetry?.exitCode === "number"
      ? telemetry.exitCode
      : execution.exitCode ?? 1;
    const latestEventText = clipText(optionalTrimmedString(execution.latestEventText), 280);
    const lastMessage = clipText(optionalTrimmedString(execution.lastMessage), 280);
    const fallbackSummary = clipText(
      latestEventText
        ?? lastMessage
        ?? "Investigation did not emit the required structured JSON result; preserving raw evidence as a partial report.",
      280,
    ) ?? "Investigation did not emit the required structured JSON result; preserving raw evidence as a partial report.";
    const nextAction = "Review the preserved telemetry evidence and rerun with tighter steering if a structured report is required.";
    const structuredResultError = clipText(error instanceof Error ? error.message : String(error), 500);
    const telemetryProof = isRecord(telemetry?.proof) ? telemetry.proof : undefined;
    const telemetryVerified = clipText(optionalTrimmedString(telemetryProof?.verified), 280);
    const telemetryHow = clipText(optionalTrimmedString(telemetryProof?.how), 500);
    const fallbackScriptsRun = [{
      command,
      summary: clipText(
        exitCode === 0
          ? "Codex exited without writing a valid investigation result; telemetry evidence was preserved."
          : `Codex exited ${exitCode}; telemetry evidence was preserved for follow-up.`,
        280,
      ),
      status: exitCode === 0 ? "warning" : "error",
    }] satisfies ReadonlyArray<FactoryExecutionScriptRun>;
    const resultMissingDetail = [
      structuredResultError ? `Result parsing error: ${structuredResultError}` : undefined,
      execution.latestEventType ? `Latest event type: ${execution.latestEventType}` : undefined,
      latestEventText ? `Latest event: ${latestEventText}` : undefined,
      lastMessage ? `Last message: ${lastMessage}` : undefined,
    ].filter((item): item is string => Boolean(item)).join("\n");
    const telemetryFiles = Array.isArray(telemetry?.files)
      ? telemetry.files.filter((item): item is Record<string, unknown> => isRecord(item))
      : [];
    const telemetryDetail = [
      `Command: ${command}`,
      `Exit code: ${exitCode}`,
      telemetryVerified ? `Verified: ${telemetryVerified}` : undefined,
      telemetryHow ? `How: ${telemetryHow}` : undefined,
      telemetryFiles.length > 0 ? `Files captured: ${telemetryFiles.length}` : undefined,
    ].filter((item): item is string => Boolean(item)).join("\n");
    const evidenceRecords = [{
      objective_id: payload.objectiveId,
      task_id: payload.taskId,
      timestamp: typeof telemetry?.finishedAt === "number" ? telemetry.finishedAt : Date.now(),
      tool_name: "codex",
      command_or_api: command,
      inputs: {
        workspacePath: payload.workspacePath,
        resultPath: payload.resultPath,
        lastMessagePath: payload.lastMessagePath,
      },
      outputs: {
        exitCode,
        signal: execution.signal ?? null,
        latestEventType: execution.latestEventType ?? null,
        latestEventText: execution.latestEventText ?? null,
      },
      summary_metrics: {
        structured_result_missing: true,
        stdout_chars: execution.stdout.length,
        stderr_chars: execution.stderr.length,
        telemetry_files: telemetryFiles.length,
      },
    }];
    const fallbackResult: Record<string, unknown> = {
      outcome: "partial",
      summary: fallbackSummary,
      handoff: `${fallbackSummary}\n\nTelemetry evidence was preserved so the controller can inspect the raw stdout/stderr and task packet artifacts.`,
      presentation: {
        kind: "investigation_report",
        renderHint: "report",
        inlineBody: fallbackSummary,
        primaryArtifactLabels: ["task evidence", "task stdout", "task stderr"],
      },
      artifacts: [],
      completion: {
        changed: [fallbackSummary],
        proof: [
          fallbackScriptsRun[0]?.summary ?? "Telemetry evidence was preserved.",
          ...(telemetryVerified ? [telemetryVerified] : []),
        ].filter((item): item is string => Boolean(item)),
        remaining: [nextAction],
      },
      nextAction,
      report: {
        conclusion: fallbackSummary,
        evidence: [
          {
            title: "Structured result missing",
            summary: "Codex did not emit a valid structured investigation result.",
            detail: resultMissingDetail || undefined,
          },
          {
            title: "Telemetry evidence captured",
            summary: telemetryVerified ?? "Execution telemetry was preserved for controller-side analysis.",
            detail: telemetryDetail || undefined,
          },
        ],
        evidenceRecords,
        scriptsRun: fallbackScriptsRun,
        disagreements: [],
        nextSteps: [nextAction],
      },
    };
    return execution.tokensUsed !== undefined
      ? { ...fallbackResult, tokensUsed: execution.tokensUsed }
      : fallbackResult;
  }

  private async readTaskTelemetryEvidence(
    evidencePath: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const raw = await fs.readFile(evidencePath, "utf-8");
      const parsed = JSON.parse(raw);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async resolvePublishWorkerResult(
    payload: Pick<FactoryIntegrationPublishJobPayload, "lastMessagePath">,
    execution: { readonly lastMessage?: string },
  ): Promise<FactoryPublishResult> {
    return resolveFactoryPublishWorkerResult(payload, execution);
  }

  private isRetryablePublishFailureMessage(message: string): boolean {
    return isTaskRunnerRetryablePublishFailureMessage(message, {
      humanInputBlockReasonRe: HUMAN_INPUT_BLOCK_REASON_RE,
      publishTransientFailureRe: PUBLISH_TRANSIENT_FAILURE_RE,
    });
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

  private async collectWorkerRepoSkillPaths(
    profile: Pick<FactoryObjectiveProfileSnapshot, "selectedSkills">,
  ): Promise<ReadonlyArray<string>> {
    const selected = new Set<string>([
      "skills/factory-receipt-worker/SKILL.md",
      ...profile.selectedSkills,
    ]);
    const resolved: string[] = [];
    for (const skillRef of selected) {
      const trimmed = skillRef.trim();
      if (!trimmed) continue;
      const candidates = path.isAbsolute(trimmed)
        ? [trimmed]
        : [
            path.join(this.git.repoRoot, trimmed),
            path.join(this.profileRoot, trimmed),
          ];
      for (const absolute of candidates) {
        const exists = await fs.stat(absolute).then((stat) => stat.isFile()).catch(() => false);
        if (!exists) continue;
        resolved.push(absolute);
        break;
      }
    }
    return [...new Set(resolved)].sort((a, b) => a.localeCompare(b));
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
