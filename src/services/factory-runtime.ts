import path from "node:path";
import fs from "node:fs/promises";

import type { DurableActivityController, DurableBackend } from "@receipt/durable";
import {
  CodexControlSignalError,
  LocalCodexExecutor,
} from "../adapters/codex-executor";
import type { JobBackend } from "../adapters/job-backend";
import {
  createMemoryTools,
  decideMemory,
  initialMemoryState,
  reduceMemory,
  type MemoryCmd,
  type MemoryEvent,
  type MemoryState,
  type MemoryTools,
} from "../adapters/memory-tools";
import { sqliteBranchStore, sqliteReceiptStore } from "../adapters/sqlite";
import type { QueueJob } from "../adapters/sqlite-queue";
import { embed, llmStructured } from "../adapters/openai";
import { z } from "zod";
import { createRuntime } from "@receipt/core/runtime";
import type { JobHandler } from "../engine/runtime/job-worker";
import type { SseHub } from "../framework/sse-hub";
import type { JobCmd, JobEvent, JobState } from "../modules/job";
import {
  FACTORY_CONTROL_AGENT_ID,
  FACTORY_MONITOR_AGENT_ID,
  FactoryService,
} from "./factory-service";
import type { FactoryObjectiveAuditJobPayload, FactoryServiceOptions } from "./factory-types";
import { runFactoryCodexJob } from "../agents/factory-chat";
import {
  readFactoryReceiptInvestigation,
  renderFactoryReceiptInvestigationText,
  type FactoryReceiptInvestigation,
} from "../factory-cli/investigate";
import type { AuditRecommendation } from "../factory-cli/analyze";
import {
  objectiveAuditArtifactPaths,
  readPersistedObjectiveAuditMetadata,
} from "./factory/objective-audit-artifacts";
import {
  systemImprovementArtifactPaths,
} from "./factory/system-improvement-artifacts";
import {
  buildSystemAutoFixObjectiveInput,
  findExistingSystemAutoFixObjective,
  shouldCreateSystemAutoFixObjective,
} from "./factory/system-improvement-autofix";
import {
  buildAutoFixObjectiveInput,
  findExistingAutoFixObjective,
} from "./factory/objective-audit-autofix";
import { readFactoryReceiptAudit } from "../factory-cli/audit";
import { runReceiptContextDstAudit, type ReceiptDstContextAuditReport } from "../cli/dst-context";
import { runReceiptDstAudit, type ReceiptDstAuditReport } from "../cli/dst";
import { isSqliteLockError } from "../db/client";
import {
  codexActivityKey,
  markDurableJobRunning,
  recoverPersistedJsonResult,
} from "../lib/durable-execution";
import type {
  FactorySystemImprovementRecommendation,
  FactorySystemImprovementReport,
} from "./factory-types";

export type FactoryQueue = JobBackend;
export type FactoryJobRuntime = ReturnType<
  typeof createRuntime<JobCmd, JobEvent, JobState>
>;

type FactoryServiceRuntimeOptions = {
  readonly dataDir: string;
  readonly queue: FactoryQueue;
  readonly durable?: DurableBackend;
  readonly jobRuntime: FactoryJobRuntime;
  readonly sse: SseHub;
  readonly repoRoot: string;
  readonly codexBin?: string;
  readonly repoSlotConcurrency?: number;
  readonly memoryTools?: MemoryTools;
  readonly redriveQueuedJob?: (job: QueueJob) => Promise<void>;
  readonly auditAutoFixEnabled?: boolean;
  readonly onObjectiveHandoff?: FactoryServiceOptions["onObjectiveHandoff"];
};

const isNoRetryError = (err: unknown): boolean => {
  if (!err || typeof err !== "object" || !("status" in err)) return false;
  const status = (err as { readonly status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
};

const isTerminalJobStatus = (status: unknown): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

type RecoveredInterruptionKind =
  | "lease_expired"
  | "child_exit"
  | "stall"
  | "timeout"
  | "unknown";

const interruptionKindFromText = (
  value: string | undefined,
): RecoveredInterruptionKind | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("lease expired")) return "lease_expired";
  if (normalized.includes("child_exit")) return "child_exit";
  if (normalized.includes("exited unexpectedly")) return "child_exit";
  if (normalized.includes("timed out") || normalized.includes("timeout")) return "timeout";
  if (normalized.includes("stalled")) return "stall";
  return undefined;
};

const interruptionKindForJob = (
  job: Pick<QueueJob, "status" | "lastError" | "leaseUntil" | "result">,
  now = Date.now(),
): RecoveredInterruptionKind => {
  const result = job.result && typeof job.result === "object" && !Array.isArray(job.result)
    ? job.result as Record<string, unknown>
    : undefined;
  const explicit = typeof result?.interruptionKind === "string"
    ? result.interruptionKind.trim()
    : "";
  if (
    explicit === "lease_expired"
    || explicit === "child_exit"
    || explicit === "stall"
    || explicit === "timeout"
    || explicit === "unknown"
  ) {
    return explicit;
  }
  const inferred = interruptionKindFromText(
    (typeof result?.interruptionSummary === "string" ? result.interruptionSummary : undefined)
    ?? job.lastError,
  );
  if (inferred) return inferred;
  if (
    (job.status === "leased" || job.status === "running")
    && typeof job.leaseUntil === "number"
    && job.leaseUntil <= now
  ) {
    return "lease_expired";
  }
  return "unknown";
};

const isRetryableAuditLockError = (error: unknown): boolean => {
  return isSqliteLockError(error);
};

const isRetryableObjectiveControlLockError = (error: unknown): boolean => {
  return isSqliteLockError(error);
};

const FACTORY_JOB_KEEPALIVE_MS = 5_000;
const FACTORY_JOB_KEEPALIVE_LEASE_MS = 30_000;

const withFactoryJobKeepalive = async <T>(
  service: FactoryService,
  jobId: string,
  workerId: string,
  work: () => Promise<T>,
): Promise<T> => {
  const timer = setInterval(() => {
    void service.queue
      .heartbeat(jobId, workerId, FACTORY_JOB_KEEPALIVE_LEASE_MS)
      .catch(() => undefined);
  }, FACTORY_JOB_KEEPALIVE_MS);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
};

const withObjectiveAuditRetry = async <T>(
  work: () => Promise<T>,
): Promise<T> => {
  let attempts = 0;
  while (true) {
    try {
      return await work();
    } catch (error) {
      attempts += 1;
      if (attempts >= 4 || !isRetryableAuditLockError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempts * 150));
    }
  }
};

export const withObjectiveControlRetry = async <T>(
  work: () => Promise<T>,
): Promise<T> => {
  let attempts = 0;
  while (true) {
    try {
      return await work();
    } catch (error) {
      attempts += 1;
      if (attempts >= 4 || !isRetryableObjectiveControlLockError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempts * 150));
    }
  }
};

type LiveGuidanceKind = "steer" | "follow_up" | "mixed";

type LiveGuidanceCommand = {
  readonly id: string;
  readonly command: "steer" | "follow_up";
  readonly payload?: Record<string, unknown>;
};

const guidanceMessageFromCommand = (
  command: LiveGuidanceCommand,
): string | undefined => {
  const payload = command.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const direct =
    typeof payload.message === "string" && payload.message.trim().length > 0
      ? payload.message.trim()
      : undefined;
  if (direct) return direct;
  if (
    command.command === "steer" &&
    typeof payload.problem === "string" &&
    payload.problem.trim().length > 0
  ) {
    return payload.problem.trim();
  }
  if (
    command.command === "follow_up" &&
    typeof payload.note === "string" &&
    payload.note.trim().length > 0
  ) {
    return payload.note.trim();
  }
  return undefined;
};

const coalesceLiveGuidanceSignal = (
  jobId: string,
  commands: ReadonlyArray<LiveGuidanceCommand>,
):
  | {
      readonly kind: "restart";
      readonly note: string;
      readonly meta: Record<string, unknown>;
    }
  | undefined => {
  const liveCommands = commands.filter(
    (command) => command.command === "steer" || command.command === "follow_up",
  );
  if (liveCommands.length === 0) return undefined;
  const messages = [
    ...new Set(
      liveCommands
        .map((command) => guidanceMessageFromCommand(command))
        .filter((item): item is string => Boolean(item)),
    ),
  ];
  if (messages.length === 0) return undefined;
  const guidanceKind: LiveGuidanceKind = liveCommands.every(
    (command) => command.command === "steer",
  )
    ? "steer"
    : liveCommands.every((command) => command.command === "follow_up")
      ? "follow_up"
      : "mixed";
  const note = messages.join("\n\n");
  return {
    kind: "restart",
    note,
    meta: {
      jobId,
      guidance: note,
      guidanceKind,
      sourceCommandIds: liveCommands.map((command) => command.id),
      appliedAt: Date.now(),
    },
  };
};

const appendLiveOperatorGuidance = (
  prompt: string,
  guidanceBlocks: ReadonlyArray<string>,
): string => {
  const normalizedPrompt = prompt.trimEnd();
  if (guidanceBlocks.length === 0) return normalizedPrompt;
  const section = [
    "## Live Operator Guidance",
    ...guidanceBlocks.map((guidance, index) => `${index + 1}. ${guidance}`),
  ].join("\n\n");
  return `${normalizedPrompt}\n\n${section}\n`;
};

const directCodexResultPath = (
  dataDir: string,
  jobId: string,
): string => path.join(dataDir, "factory", "codex", jobId, "result.json");

const AUTOFIX_PATTERN_THRESHOLD = 5;
const RECENT_AUDIT_PATTERN_WINDOW = 20;
const DEFAULT_AUTO_FIX_SOURCE_CHANNELS = ["trial"] as const;
const USAGE_LIMIT_ANOMALY_RE =
  /\b(usage_limit_reached|too many requests|rate limit|quota(?: exceeded| exhausted)?|429)\b/i;

const normalizeAuditPattern = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "other";
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asArray = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : [];

const asRecordArray = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const reportStructuredEvidenceStats = (report: FactoryReceiptInvestigation): {
  readonly evidenceCount: number;
  readonly scriptCount: number;
} => {
  const scriptsRun = report.canonicalEvidenceBundle?.scripts_run.map((item) => ({
    command: item.command,
  })) ?? [];
  return {
    evidenceCount: report.canonicalEvidenceBundle?.evidence_records.length ?? 0,
    scriptCount: scriptsRun.filter((item) => Boolean(asString(item.command))).length,
  };
};

const normalizeAuditChannel = (
  value: string | undefined,
): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
};

const normalizeAuditChannelList = (
  values: ReadonlyArray<string | undefined>,
): ReadonlyArray<string> => [
  ...new Set(
    values
      .map((value) => normalizeAuditChannel(value))
      .filter((value): value is string => Boolean(value)),
  ),
];

const categorizeAuditSummary = (summary: string): string | undefined => {
  const normalized = summary.toLowerCase();
  if (USAGE_LIMIT_ANOMALY_RE.test(summary)) return "quota_rate_limit";
  if (normalized.includes("lease expired")) return "lease_expired";
  if (isSqliteLockError(summary)) return "database_locked";
  if (normalized.includes("iteration budget exhausted"))
    return "iteration_budget_exhausted";
  if (/workspace (branch|path) already exists/i.test(summary))
    return "workspace_collision";
  if (
    /human input|operator|clarification|approval|permission denied|access denied|unauthorized|forbidden/i.test(
      summary,
    )
  ) {
    return "human_input_or_permission_gate";
  }
  return undefined;
};

const deriveRecommendationPatternsFromReport = (
  report: FactoryReceiptInvestigation,
): ReadonlyArray<string> => {
  const patterns = new Set<string>();
  const isDelivery = report.objectiveMode === "delivery";
  const structuredEvidence = reportStructuredEvidenceStats(report);
  for (const anomaly of report.anomalies) {
    if (anomaly.kind) patterns.add(normalizeAuditPattern(anomaly.kind));
    const summarized = categorizeAuditSummary(anomaly.summary);
    if (summarized) patterns.add(summarized);
  }
  for (const note of report.assessment.notes) {
    const normalized = note.toLowerCase();
    if (
      normalized.includes("scriptsrun") ||
      normalized.includes("captured command logs")
    )
      patterns.add("missing_scripts_run");
    if (normalized.includes("proof items")) patterns.add("missing_proof");
    if (isDelivery && normalized.includes("alignment report"))
      patterns.add("alignment_not_reported");
  }
  if (report.objectiveMode === "investigation" && structuredEvidence.evidenceCount === 0) {
    patterns.add("missing_structured_evidence");
  }
  if (report.objectiveMode === "investigation" && structuredEvidence.scriptCount === 0) {
    patterns.add("missing_scripts_run");
  }
  if (isDelivery && report.assessment.alignmentVerdict === "not_reported")
    patterns.add("alignment_not_reported");
  return [...patterns];
};

const AuditRecommendationSchema = z.object({
  recommendations: z.array(
    z.object({
      summary: z.string(),
      anomalyPatterns: z.array(z.string()),
      scope: z.string(),
      confidence: z.enum(["low", "medium", "high"]),
      suggestedFix: z.string(),
    }),
  ),
});

const SYSTEM_IMPROVEMENT_AUDIT_LIMIT = 12;

const FactorySystemImprovementRecommendationSchema = z.object({
  recommendations: z.array(
    z.object({
      summary: z.string(),
      anomalyPatterns: z.array(z.string()),
      scope: z.string(),
      confidence: z.enum(["low", "medium", "high"]),
      suggestedFix: z.string(),
      successMetrics: z.array(
        z.object({
          label: z.string(),
          baseline: z.string(),
          target: z.string(),
          verification: z.array(z.string()),
          severity: z.enum(["warning", "hard_defect"]),
        }),
      ),
      acceptanceChecks: z.array(z.string()),
    }),
  ),
});

type AuditRecommendationRun = {
  readonly recommendations: ReadonlyArray<AuditRecommendation>;
  readonly status: "ready" | "failed";
  readonly error?: string;
};

type FactorySystemImprovementRecommendationRun = {
  readonly recommendations: ReadonlyArray<FactorySystemImprovementRecommendation>;
  readonly status: "ready" | "failed";
  readonly error?: string;
};

const runAuditRecommendationGenerator = async (
  recommendationGenerator: (
    report: FactoryReceiptInvestigation,
    recentAuditEntries: ReadonlyArray<{ readonly text: string }>,
    patternCounts: ReadonlyMap<string, number>,
  ) => Promise<ReadonlyArray<AuditRecommendation>>,
  report: FactoryReceiptInvestigation,
  recentAuditEntries: ReadonlyArray<{ readonly text: string }>,
  patternCounts: ReadonlyMap<string, number>,
): Promise<AuditRecommendationRun> => {
  try {
    const recommendations = await recommendationGenerator(
      report,
      recentAuditEntries,
      patternCounts,
    );
    return {
      recommendations,
      status: "ready",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      recommendations: [],
      status: "failed",
      error: message,
    };
  }
};

const generateAuditRecommendations = async (
  report: FactoryReceiptInvestigation,
  recentAuditEntries: ReadonlyArray<{ readonly text: string }>,
  patternCounts: ReadonlyMap<string, number>,
): Promise<ReadonlyArray<AuditRecommendation>> => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY not set for audit recommendation generation",
    );
  }
  const anomalySummary = report.anomalies
    .slice(0, 20)
    .map((a) => `- [${a.severity}] ${a.summary}`)
    .join("\n");
  const assessmentSummary = [
    `Verdict: ${report.assessment.verdict}`,
    `Efficiency: ${report.assessment.efficiency}`,
    `Control churn: ${report.assessment.controlChurn}`,
    `Easy route risk: ${report.assessment.easyRouteRisk}`,
    ...report.assessment.notes.slice(0, 8).map((n) => `- ${n}`),
  ].join("\n");
  const recentHistory = recentAuditEntries
    .slice(0, 10)
    .map((e) => e.text.slice(0, 300))
    .join("\n---\n");
  const whatHappened = report.summary.whatHappened?.join("\n") ?? "";
  const currentPatterns = deriveRecommendationPatternsFromReport(report);
  const recurringPatterns = [...patternCounts.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, 12)
    .map(([pattern, count]) => `- ${pattern}: ${count}`)
    .join("\n");

  const result = await llmStructured({
    system: [
      "You are an expert software reliability engineer analyzing Factory objective audit reports.",
      "Generate concrete, actionable recommendations for code improvements.",
      "Each recommendation must include:",
      "- summary: what to fix (one sentence)",
      "- anomalyPatterns: normalized snake_case pattern ids tied to the current issues",
      "- scope: the primary file path or subsystem to change",
      "- confidence: low, medium, or high",
      "- suggestedFix: concrete description of the code change (file paths, logic changes)",
      "Look at cross-run patterns in the recent audit history to identify recurring issues.",
      "Do not generate recommendations for external/infrastructure issues (API rate limits, permission denials) unless a code-level mitigation exists.",
      "Return an empty array if no actionable recommendations exist.",
    ].join("\n"),
    user: [
      "## Current Objective Audit",
      whatHappened,
      "",
      "## Assessment",
      assessmentSummary,
      "",
      "## Anomalies",
      anomalySummary || "none",
      "",
      "## Current Objective Patterns",
      currentPatterns.length > 0
        ? currentPatterns.map((pattern) => `- ${pattern}`).join("\n")
        : "none",
      "",
      "## Recent Recurring Patterns",
      recurringPatterns || "none",
      "",
      "## Recent Audit History (cross-run patterns)",
      recentHistory || "none",
    ].join("\n"),
    schema: AuditRecommendationSchema,
    schemaName: "AuditRecommendations",
  });
  return result.parsed.recommendations.map((recommendation) => ({
    ...recommendation,
    anomalyPatterns: recommendation.anomalyPatterns
      .map(normalizeAuditPattern)
      .filter(Boolean),
    scope: recommendation.scope.trim() || "unknown",
  }));
};

const compactDstSummary = (
  report: ReceiptDstAuditReport,
): FactorySystemImprovementReport["dstSummary"] => ({
  streamCount: report.streamCount,
  integrityFailures: report.integrityFailures,
  replayFailures: report.replayFailures,
  deterministicFailures: report.deterministicFailures,
});

const compactContextDstSummary = (
  report: ReceiptDstContextAuditReport,
): FactorySystemImprovementReport["contextSummary"] => {
  const compatibilityWarningCount = report.runs.reduce(
    (sum, run) => sum + run.warnings.length,
    0,
  );
  const hardFailureCount = report.runs.filter(
    (run) => run.issues.length > 0 || !run.integrity.ok,
  ).length;
  return {
    runCount: report.runCount,
    hardFailureCount,
    compatibilityWarningCount,
    replayFailures: report.replayFailures,
    deterministicFailures: report.deterministicFailures,
  };
};

const compactAuditSummary = (
  report: Awaited<ReturnType<typeof readFactoryReceiptAudit>>,
): FactorySystemImprovementReport["auditSummary"] => ({
  objectivesAudited: report.summary.objectivesAudited,
  weakObjectives: report.summary.verdicts.weak ?? 0,
  strongObjectives: report.summary.verdicts.strong ?? 0,
  topAnomalies: report.anomalyCategories.slice(0, 8).map((item) => ({
    category: item.category,
    count: item.count,
  })),
});

const deriveSystemHealthStatus = (input: {
  readonly dst: FactorySystemImprovementReport["dstSummary"];
  readonly context: FactorySystemImprovementReport["contextSummary"];
  readonly audit: FactorySystemImprovementReport["auditSummary"];
}): FactorySystemImprovementReport["healthStatus"] => {
  if (
    input.dst.integrityFailures > 0
    || input.dst.replayFailures > 0
    || input.dst.deterministicFailures > 0
    || input.context.hardFailureCount > 0
    || input.context.replayFailures > 0
    || input.context.deterministicFailures > 0
  ) {
    return "action_needed";
  }
  if (
    input.audit.weakObjectives > 0
    || input.context.compatibilityWarningCount > 0
    || input.audit.topAnomalies.length > 0
  ) {
    return "watch";
  }
  return "healthy";
};

const renderSystemImprovementInput = (input: {
  readonly audit: FactorySystemImprovementReport["auditSummary"];
  readonly dst: FactorySystemImprovementReport["dstSummary"];
  readonly context: FactorySystemImprovementReport["contextSummary"];
}): string => {
  const anomalyLines = input.audit.topAnomalies.length > 0
    ? input.audit.topAnomalies.map((item) => `- ${item.category}: ${item.count}`).join("\n")
    : "none";
  return [
    "## Repo Audit Summary",
    `Objectives audited: ${input.audit.objectivesAudited}`,
    `Weak objectives: ${input.audit.weakObjectives}`,
    `Strong objectives: ${input.audit.strongObjectives}`,
    "",
    "## Top Anomalies",
    anomalyLines,
    "",
    "## DST Summary",
    `Streams scanned: ${input.dst.streamCount}`,
    `Integrity failures: ${input.dst.integrityFailures}`,
    `Replay failures: ${input.dst.replayFailures}`,
    `Deterministic failures: ${input.dst.deterministicFailures}`,
    "",
    "## Context DST Summary",
    `Runs scanned: ${input.context.runCount}`,
    `Hard failures: ${input.context.hardFailureCount}`,
    `Compatibility warnings: ${input.context.compatibilityWarningCount}`,
    `Replay failures: ${input.context.replayFailures}`,
    `Deterministic failures: ${input.context.deterministicFailures}`,
  ].join("\n");
};

const systemMetricVerification = (
  label: string,
): ReadonlyArray<string> => {
  switch (label) {
    case "base_dst":
      return ["bun src/cli.ts dst --json"];
    case "context_dst":
      return ["bun src/cli.ts dst --context --json"];
    case "factory_audit":
      return ["bun src/cli.ts factory audit --limit 12 --json"];
    default:
      return [
        "bun src/cli.ts factory audit --limit 12 --json",
        "bun src/cli.ts dst --json",
        "bun src/cli.ts dst --context --json",
      ];
  }
};

const normalizeSystemRecommendations = (
  recommendations: ReadonlyArray<z.infer<typeof FactorySystemImprovementRecommendationSchema>["recommendations"][number]>,
): ReadonlyArray<FactorySystemImprovementRecommendation> =>
  recommendations.map((recommendation) => ({
    summary: recommendation.summary.trim(),
    anomalyPatterns: recommendation.anomalyPatterns
      .map((pattern) => normalizeAuditPattern(pattern))
      .filter(Boolean),
    scope: recommendation.scope.trim() || "unknown",
    confidence: recommendation.confidence,
    suggestedFix: recommendation.suggestedFix.trim(),
    successMetrics: recommendation.successMetrics.map((metric) => ({
      label: metric.label.trim() || "metric",
      baseline: metric.baseline.trim(),
      target: metric.target.trim(),
      severity: metric.severity,
      verification: metric.verification
        .map((item) => item.trim())
        .filter(Boolean),
    })).filter((metric) => metric.baseline && metric.target),
    acceptanceChecks: recommendation.acceptanceChecks
      .map((item) => item.trim())
      .filter(Boolean),
  }));

const runSystemImprovementRecommendationGenerator = async (
  recommendationGenerator: (
    input: {
      readonly audit: FactorySystemImprovementReport["auditSummary"];
      readonly dst: FactorySystemImprovementReport["dstSummary"];
      readonly context: FactorySystemImprovementReport["contextSummary"];
      readonly healthStatus: FactorySystemImprovementReport["healthStatus"];
    },
  ) => Promise<ReadonlyArray<FactorySystemImprovementRecommendation>>,
  input: {
    readonly audit: FactorySystemImprovementReport["auditSummary"];
    readonly dst: FactorySystemImprovementReport["dstSummary"];
    readonly context: FactorySystemImprovementReport["contextSummary"];
    readonly healthStatus: FactorySystemImprovementReport["healthStatus"];
  },
): Promise<FactorySystemImprovementRecommendationRun> => {
  try {
    return {
      recommendations: await recommendationGenerator(input),
      status: "ready",
    };
  } catch (error) {
    return {
      recommendations: [],
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const generateSystemImprovementRecommendations = async (
  input: {
    readonly audit: FactorySystemImprovementReport["auditSummary"];
    readonly dst: FactorySystemImprovementReport["dstSummary"];
    readonly context: FactorySystemImprovementReport["contextSummary"];
    readonly healthStatus: FactorySystemImprovementReport["healthStatus"];
  },
): Promise<ReadonlyArray<FactorySystemImprovementRecommendation>> => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY not set for repo-wide system recommendation generation",
    );
  }
  const result = await llmStructured({
    system: [
      "You are an expert software reliability engineer analyzing repo-wide Receipt and Factory health signals.",
      "Generate a small ranked set of repo-wide software-engineering improvements.",
      "Prioritize recurring engine-level issues over one-off objective-local fixes.",
      "Ignore historical schema drift warnings unless they indicate current hard failures.",
      "Prefer one high-leverage orchestrator/runtime change over many narrow fixes.",
      "Recommendations must be suitable for a software delivery objective executed by Codex.",
      "Each recommendation must include:",
      "- summary",
      "- anomalyPatterns",
      "- scope",
      "- confidence",
      "- suggestedFix",
      "- successMetrics with label, baseline, target, verification, severity",
      "- acceptanceChecks",
      "Use labels base_dst, context_dst, and factory_audit when those system metrics are relevant.",
      "Return an empty array if no repo-wide improvement is justified.",
    ].join("\n"),
    user: [
      `Current health status: ${input.healthStatus}`,
      "",
      renderSystemImprovementInput(input),
    ].join("\n"),
    schema: FactorySystemImprovementRecommendationSchema,
    schemaName: "FactorySystemImprovementRecommendations",
  });
  return normalizeSystemRecommendations(result.parsed.recommendations).map((recommendation) => ({
    ...recommendation,
    successMetrics: recommendation.successMetrics.map((metric) => ({
      ...metric,
      verification: metric.verification.length > 0
        ? metric.verification
        : systemMetricVerification(metric.label),
    })),
  }));
};

const renderSystemImprovementText = (
  report: FactorySystemImprovementReport,
): string => {
  const recommendation = report.selectedRecommendation ?? report.recommendations[0];
  return [
    "# Repo-Wide System Improvement",
    "",
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
    `Health: ${report.healthStatus}`,
    "",
    "## Audit",
    `Objectives audited: ${report.auditSummary.objectivesAudited}`,
    `Weak objectives: ${report.auditSummary.weakObjectives}`,
    `Strong objectives: ${report.auditSummary.strongObjectives}`,
    ...(report.auditSummary.topAnomalies.length > 0
      ? ["Top anomalies:", ...report.auditSummary.topAnomalies.map((item) => `- ${item.category}: ${item.count}`)]
      : ["Top anomalies: none"]),
    "",
    "## DST",
    `Streams: ${report.dstSummary.streamCount}`,
    `Failures: integrity=${report.dstSummary.integrityFailures} replay=${report.dstSummary.replayFailures} deterministic=${report.dstSummary.deterministicFailures}`,
    "",
    "## Context DST",
    `Runs: ${report.contextSummary.runCount}`,
    `Hard failures: ${report.contextSummary.hardFailureCount}`,
    `Compatibility warnings: ${report.contextSummary.compatibilityWarningCount}`,
    `Failures: replay=${report.contextSummary.replayFailures} deterministic=${report.contextSummary.deterministicFailures}`,
    "",
    "## Recommendation",
    recommendation
      ? `- [${recommendation.confidence}] ${recommendation.summary}`
      : "- none",
    ...(recommendation
      ? [
          `- scope=${recommendation.scope}`,
          `- fix=${recommendation.suggestedFix}`,
          ...(recommendation.successMetrics.length > 0
            ? ["", "## Metrics", ...recommendation.successMetrics.flatMap((metric) => [
                `- ${metric.label} [${metric.severity}] baseline=${metric.baseline} target=${metric.target}`,
                ...metric.verification.map((command) => `  verify: ${command}`),
              ])]
            : []),
        ]
      : []),
    ...(report.autoFixObjectiveId
      ? ["", "## Auto-fix", `- Objective: ${report.autoFixObjectiveId}`]
      : []),
  ].join("\n");
};

const objectiveIdFromAuditEntry = (text: string): string | undefined => {
  const match = text.match(/^\[([^\]]+)\]/m);
  return match?.[1]?.trim();
};

const readPersistedAuditPatterns = async (
  dataDir: string,
  objectiveId: string,
): Promise<ReadonlyArray<string>> => {
  const metadata = await readPersistedObjectiveAuditMetadata(
    dataDir,
    objectiveId,
  );
  if (metadata?.recommendations.length) {
    return [
      ...new Set(
        metadata.recommendations
          .flatMap((recommendation) =>
            recommendation.anomalyPatterns.map(normalizeAuditPattern),
          )
          .filter(Boolean),
      ),
    ];
  }
  try {
    const artifact = objectiveAuditArtifactPaths(dataDir, objectiveId);
    const raw = JSON.parse(
      await fs.readFile(artifact.jsonPath, "utf-8"),
    ) as Record<string, unknown>;
    const objectiveMode = asString(raw.objectiveMode);
    const anomalies = asArray(raw.anomalies);
    const assessment = asRecord(raw.assessment);
    const notes = asArray(assessment?.notes)
      .map((note) => asString(note))
      .filter((note): note is string => Boolean(note));
    const outputs = asRecord(raw.outputs);
    const result = asRecord(outputs?.result);
    const report = asRecord(result?.report);
    const scriptCount = [
      ...asRecordArray(result?.scriptsRun),
      ...asRecordArray(report?.scriptsRun),
    ].filter((item) => Boolean(asString(item.command))).length;
    const evidenceCount = asRecordArray(report?.evidenceRecords).length;
    const patterns = new Set<string>();
    for (const entry of anomalies) {
      const anomaly = asRecord(entry);
      const kind = asString(anomaly?.kind);
      const summary = asString(anomaly?.summary);
      if (kind) patterns.add(normalizeAuditPattern(kind));
      if (summary) {
        const categorized = categorizeAuditSummary(summary);
        if (categorized) patterns.add(categorized);
      }
    }
    for (const note of notes) {
      const normalized = note.toLowerCase();
      if (
        normalized.includes("scriptsrun") ||
        normalized.includes("captured command logs")
      )
        patterns.add("missing_scripts_run");
      if (normalized.includes("proof items")) patterns.add("missing_proof");
      if (objectiveMode === "delivery" && normalized.includes("alignment report"))
        patterns.add("alignment_not_reported");
    }
    if (objectiveMode === "investigation" && evidenceCount === 0)
      patterns.add("missing_structured_evidence");
    if (objectiveMode === "investigation" && scriptCount === 0)
      patterns.add("missing_scripts_run");
    const alignmentVerdict = asString(assessment?.alignmentVerdict);
    if (objectiveMode === "delivery" && alignmentVerdict === "not_reported")
      patterns.add("alignment_not_reported");
    return [...patterns];
  } catch {
    return [];
  }
};

const readPersistedAuditChannel = async (
  dataDir: string,
  objectiveId: string,
): Promise<string | undefined> => {
  const metadata = await readPersistedObjectiveAuditMetadata(
    dataDir,
    objectiveId,
  );
  return normalizeAuditChannel(metadata?.objectiveChannel);
};

const filterRecentAuditEntriesBySourceChannel = async (
  dataDir: string,
  recentAuditEntries: ReadonlyArray<{ readonly text: string }>,
  allowedChannels: ReadonlySet<string>,
): Promise<ReadonlyArray<{ readonly text: string }>> => {
  if (allowedChannels.size === 0) return [];
  const filtered: Array<{ readonly text: string }> = [];
  const channelCache = new Map<string, string | undefined>();
  for (const entry of recentAuditEntries) {
    const objectiveId = objectiveIdFromAuditEntry(entry.text);
    if (!objectiveId) continue;
    let channel = channelCache.get(objectiveId);
    if (channel === undefined && !channelCache.has(objectiveId)) {
      channel = await readPersistedAuditChannel(dataDir, objectiveId);
      channelCache.set(objectiveId, channel);
    }
    if (channel && allowedChannels.has(channel)) filtered.push(entry);
  }
  return filtered;
};

const clusterRecentAuditPatterns = async (
  dataDir: string,
  recentAuditEntries: ReadonlyArray<{ readonly text: string }>,
): Promise<ReadonlyMap<string, number>> => {
  const counts = new Map<string, number>();
  const seenObjectiveIds = new Set<string>();
  for (const entry of recentAuditEntries) {
    const objectiveId = objectiveIdFromAuditEntry(entry.text);
    if (!objectiveId || seenObjectiveIds.has(objectiveId)) continue;
    seenObjectiveIds.add(objectiveId);
    const patterns = await readPersistedAuditPatterns(dataDir, objectiveId);
    for (const pattern of new Set(
      patterns.map(normalizeAuditPattern).filter(Boolean),
    )) {
      counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
    }
  }
  return counts;
};

const selectAutoFixRecommendation = (
  recommendations: ReadonlyArray<AuditRecommendation>,
  patternCounts: ReadonlyMap<string, number>,
): AuditRecommendation | undefined =>
  recommendations
    .map((recommendation) => ({
      recommendation,
      recurringPatterns: recommendation.anomalyPatterns
        .map(normalizeAuditPattern)
        .filter(
          (pattern) =>
            (patternCounts.get(pattern) ?? 0) >= AUTOFIX_PATTERN_THRESHOLD,
        ),
      maxCount: Math.max(
        0,
        ...recommendation.anomalyPatterns.map(
          (pattern) => patternCounts.get(normalizeAuditPattern(pattern)) ?? 0,
        ),
      ),
    }))
    .filter(
      (entry) =>
        entry.recommendation.confidence === "high" &&
        entry.recurringPatterns.length > 0,
    )
    .sort(
      (left, right) =>
        right.maxCount - left.maxCount ||
        right.recurringPatterns.length - left.recurringPatterns.length ||
        left.recommendation.summary.localeCompare(right.recommendation.summary),
    )[0]?.recommendation;

const renderObjectiveAuditText = (input: {
  readonly report: FactoryReceiptInvestigation;
  readonly recommendations: ReadonlyArray<AuditRecommendation>;
  readonly recommendationStatus: "ready" | "failed";
  readonly recommendationError?: string;
  readonly autoFixObjectiveId?: string;
}): string => {
  const base = renderFactoryReceiptInvestigationText(input.report, {
    timelineLimit: 20,
    contextChars: 1_600,
  });
  const section = [
    "",
    "## Audit Recommendations",
    ...(input.recommendationStatus === "failed"
      ? [`- generation failed: ${input.recommendationError ?? "unknown error"}`]
      : []),
    ...(input.recommendations.length > 0
      ? input.recommendations.map(
          (recommendation) =>
            `- [${recommendation.confidence}] ${recommendation.summary} · scope=${recommendation.scope}${recommendation.anomalyPatterns.length > 0 ? ` · patterns=${recommendation.anomalyPatterns.join(",")}` : ""}`,
        )
      : ["- none"]),
    ...(input.autoFixObjectiveId
      ? [
          "",
          "## Auto-fix",
          `- Objective: ${input.autoFixObjectiveId} (delivery, severity 1)`,
        ]
      : []),
  ];
  return `${base}\n${section.join("\n")}\n`;
};

const parseObjectiveAuditPayload = (
  payload: Record<string, unknown>,
): FactoryObjectiveAuditJobPayload => {
  if (payload.kind !== "factory.objective.audit") {
    throw new Error("invalid factory objective audit payload");
  }
  const objectiveId =
    typeof payload.objectiveId === "string" ? payload.objectiveId.trim() : "";
  if (!objectiveId)
    throw new Error("factory objective audit payload missing objectiveId");
  const objectiveStatus =
    typeof payload.objectiveStatus === "string"
      ? payload.objectiveStatus.trim()
      : "";
  if (!objectiveStatus)
    throw new Error("factory objective audit payload missing objectiveStatus");
  const objectiveUpdatedAt =
    typeof payload.objectiveUpdatedAt === "number" &&
    Number.isFinite(payload.objectiveUpdatedAt)
      ? payload.objectiveUpdatedAt
      : Date.now();
  return {
    kind: "factory.objective.audit",
    objectiveId,
    objectiveStatus,
    objectiveUpdatedAt,
    objectiveChannel: asString(payload.objectiveChannel),
  };
};

const renderObjectiveAuditMemoryText = (input: {
  readonly objectiveId: string;
  readonly objectiveStatus: string;
  readonly verdict: string;
  readonly easyRouteRisk: string;
  readonly efficiency: string;
  readonly controlChurn: string;
  readonly notes: ReadonlyArray<string>;
  readonly recommendations: ReadonlyArray<AuditRecommendation>;
  readonly recommendationStatus: "ready" | "failed";
  readonly recommendationError?: string;
  readonly autoFixObjectiveId?: string;
  readonly jsonPath: string;
  readonly textPath: string;
}): string => {
  const lines = [
    "Summary",
    `${input.objectiveId} finished ${input.objectiveStatus} with verdict=${input.verdict}, easy_route_risk=${input.easyRouteRisk}, efficiency=${input.efficiency}, control_churn=${input.controlChurn}.`,
    "",
    "Assessment",
    `- Verdict: ${input.verdict}`,
    `- Easy route risk: ${input.easyRouteRisk}`,
    `- Efficiency: ${input.efficiency}`,
    `- Control churn: ${input.controlChurn}`,
    "",
    "Notes",
    ...(input.notes.length > 0
      ? input.notes.map((item) => `- ${item}`)
      : ["- none"]),
    "",
    "Recommendations",
    ...(input.recommendationStatus === "failed"
      ? [`- generation_failed: ${input.recommendationError ?? "unknown error"}`]
      : []),
    ...(input.recommendations.length > 0
      ? input.recommendations.map(
          (r) =>
            `- [${r.confidence}] scope=${r.scope}${r.anomalyPatterns.length > 0 ? ` patterns=${r.anomalyPatterns.join(",")}` : ""} ${r.summary}`,
        )
      : ["- none"]),
    ...(input.autoFixObjectiveId
      ? [
          "",
          "Auto-fix",
          `- Objective: ${input.autoFixObjectiveId} (delivery, severity 1)`,
        ]
      : []),
    "",
    "Artifacts",
    `- JSON: ${input.jsonPath}`,
    `- Text: ${input.textPath}`,
  ];
  return lines.join("\n");
};

const createDefaultMemoryTools = (dataDir: string): MemoryTools => {
  const memoryRuntime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
    sqliteReceiptStore<MemoryEvent>(dataDir),
    sqliteBranchStore(dataDir),
    decideMemory,
    reduceMemory,
    initialMemoryState,
  );
  return createMemoryTools({
    dir: dataDir,
    runtime: memoryRuntime,
    embed: process.env.OPENAI_API_KEY ? embed : undefined,
  });
};

export const createFactoryServiceRuntime = (
  opts: FactoryServiceRuntimeOptions,
): {
  readonly service: FactoryService;
  readonly memoryTools: MemoryTools;
} => {
  const memoryTools =
    opts.memoryTools ?? createDefaultMemoryTools(opts.dataDir);

  const service = new FactoryService({
    dataDir: opts.dataDir,
    queue: opts.queue,
    durable: opts.durable,
    jobRuntime: opts.jobRuntime,
    sse: opts.sse,
    codexExecutor: new LocalCodexExecutor({ bin: opts.codexBin }),
    memoryTools,
    repoRoot: opts.repoRoot,
    repoSlotConcurrency: opts.repoSlotConcurrency,
    redriveQueuedJob: opts.redriveQueuedJob,
    onObjectiveHandoff: opts.onObjectiveHandoff,
  });

  return {
    service,
    memoryTools,
  };
};

export const runFactoryObjectiveAudit = async (input: {
  readonly dataDir: string;
  readonly repoRoot: string;
  readonly memoryTools: MemoryTools;
  readonly payload: Record<string, unknown>;
  readonly factoryService?: FactoryService;
  readonly autoFixEnabled?: boolean;
  readonly autoFixSourceChannels?: ReadonlyArray<string>;
  readonly recommendationGenerator?: (
    report: FactoryReceiptInvestigation,
    recentAuditEntries: ReadonlyArray<{ readonly text: string }>,
    patternCounts: ReadonlyMap<string, number>,
  ) => Promise<ReadonlyArray<AuditRecommendation>>;
  readonly systemRecommendationGenerator?: (
    input: {
      readonly audit: FactorySystemImprovementReport["auditSummary"];
      readonly dst: FactorySystemImprovementReport["dstSummary"];
      readonly context: FactorySystemImprovementReport["contextSummary"];
      readonly healthStatus: FactorySystemImprovementReport["healthStatus"];
    },
  ) => Promise<ReadonlyArray<FactorySystemImprovementRecommendation>>;
}): Promise<Record<string, unknown>> => {
  const parsed = parseObjectiveAuditPayload(input.payload);
  const report = await withObjectiveAuditRetry(() =>
    readFactoryReceiptInvestigation(
      input.dataDir,
      input.repoRoot,
      parsed.objectiveId,
      { asOfTs: parsed.objectiveUpdatedAt },
    ),
  );
  const artifacts = objectiveAuditArtifactPaths(
    input.dataDir,
    parsed.objectiveId,
  );
  await fs.mkdir(artifacts.root, { recursive: true });
  const allowedAutoFixChannels = new Set(
    normalizeAuditChannelList(
      input.autoFixSourceChannels ?? DEFAULT_AUTO_FIX_SOURCE_CHANNELS,
    ),
  );
  const objectiveState = input.factoryService
    ? await input.factoryService
        .getObjectiveState(parsed.objectiveId)
        .catch(() => undefined)
    : undefined;
  const objectiveChannel =
    normalizeAuditChannel(parsed.objectiveChannel) ??
    normalizeAuditChannel(objectiveState?.channel);
  const autoFixSourceEligible = Boolean(
    objectiveChannel &&
    allowedAutoFixChannels.size > 0 &&
    allowedAutoFixChannels.has(objectiveChannel),
  );

  // Read recent audit entries for cross-run patterns
  const repoAuditEntries = await input.memoryTools
    .read({
      scope: "factory/audits/repo",
      limit: RECENT_AUDIT_PATTERN_WINDOW,
    })
    .catch(() => []);
  const recentAuditEntries =
    allowedAutoFixChannels.size > 0
      ? await filterRecentAuditEntriesBySourceChannel(
          input.dataDir,
          repoAuditEntries,
          allowedAutoFixChannels,
        )
      : [];
  const patternCounts = await clusterRecentAuditPatterns(
    input.dataDir,
    recentAuditEntries,
  );

  // Generate LLM recommendations
  const recommendationGenerator =
    input.recommendationGenerator ?? generateAuditRecommendations;
  const recommendationRun = await runAuditRecommendationGenerator(
    recommendationGenerator,
    report,
    recentAuditEntries,
    patternCounts,
  );
  const recommendations = recommendationRun.recommendations;

  // Auto-fix: create a delivery objective when a high-confidence recommendation matches recurring patterns.
  let autoFixObjectiveId: string | undefined;
  if (
    input.factoryService &&
    input.autoFixEnabled !== false &&
    autoFixSourceEligible
  ) {
    const autoFixRec = selectAutoFixRecommendation(
      recommendations,
      patternCounts,
    );
    if (autoFixRec) {
      try {
        const existingObjectiveId = await findExistingAutoFixObjective(
          input.factoryService,
          autoFixRec,
        );
        if (existingObjectiveId) {
          autoFixObjectiveId = existingObjectiveId;
        } else {
          const objective = await input.factoryService.createObjective(
            buildAutoFixObjectiveInput({
              recommendation: autoFixRec,
              patternCounts,
              triggerLabel:
                "Auto-fix triggered by recurring audit recommendation.",
            }),
          );
          autoFixObjectiveId = objective.objectiveId;
        }
      } catch {
        // auto-fix is best-effort
      }
    }
  }

  const persistedReport = {
    ...report,
    recommendations,
    autoFixObjectiveId,
    audit: {
      generatedAt: Date.now(),
      objectiveUpdatedAt: parsed.objectiveUpdatedAt,
      objectiveChannel,
      recommendationStatus: recommendationRun.status,
      recommendationError: recommendationRun.error,
      recommendations,
      autoFixObjectiveId,
      recurringPatterns: [...patternCounts.entries()]
        .sort(
          (left, right) =>
            right[1] - left[1] || left[0].localeCompare(right[0]),
        )
        .slice(0, 20)
        .map(([pattern, count]) => ({ pattern, count })),
    },
  };
  await fs.writeFile(
    artifacts.jsonPath,
    JSON.stringify(persistedReport, null, 2),
    "utf-8",
  );
  await fs.writeFile(
    artifacts.textPath,
    renderObjectiveAuditText({
      report,
      recommendations,
      recommendationStatus: recommendationRun.status,
      recommendationError: recommendationRun.error,
      autoFixObjectiveId,
    }),
    "utf-8",
  );

  const memoryText = renderObjectiveAuditMemoryText({
    objectiveId: parsed.objectiveId,
    objectiveStatus: parsed.objectiveStatus,
    verdict: report.assessment.verdict,
    easyRouteRisk: report.assessment.easyRouteRisk,
    efficiency: report.assessment.efficiency,
    controlChurn: report.assessment.controlChurn,
    notes: [
      ...report.assessment.notes.slice(0, 6),
      `objective_channel=${objectiveChannel ?? "unknown"}`,
      `auto_fix_source_channels=${allowedAutoFixChannels.size > 0 ? [...allowedAutoFixChannels].join(",") : "none"}`,
      `auto_fix_source_eligible=${autoFixSourceEligible ? "yes" : "no"}`,
      `alignment=${report.assessment.alignmentVerdict}`,
      `recommendation_generation=${recommendationRun.status}`,
      report.assessment.correctiveSteerIssued
        ? `corrective_steer=issued aligned_after_correction=${report.assessment.alignedAfterCorrection ? "yes" : "no"}`
        : "corrective_steer=none",
      ...(recommendationRun.error
        ? [`recommendation_error=${recommendationRun.error}`]
        : []),
    ],
    recommendations: recommendations.slice(0, 6),
    recommendationStatus: recommendationRun.status,
    recommendationError: recommendationRun.error,
    autoFixObjectiveId,
    jsonPath: artifacts.jsonPath,
    textPath: artifacts.textPath,
  });
  await withObjectiveAuditRetry(async () => {
    await Promise.all([
      input.memoryTools.commit({
        scope: `factory/audits/objectives/${parsed.objectiveId}`,
        text: memoryText,
        tags: [
          "factory",
          "audit",
          parsed.objectiveStatus,
          report.assessment.verdict,
          ...(objectiveChannel ? [`channel:${objectiveChannel}`] : []),
        ],
      }),
      input.memoryTools.commit({
        scope: "factory/audits/repo",
        text: `[${parsed.objectiveId}] ${memoryText}`,
        tags: [
          "factory",
          "audit",
          "repo",
          parsed.objectiveStatus,
          report.assessment.verdict,
          ...(objectiveChannel ? [`channel:${objectiveChannel}`] : []),
        ],
      }),
    ]);
  });

  let systemImprovementReport: FactorySystemImprovementReport | undefined;
  let systemImprovementError: string | undefined;
  try {
    const [auditReport, dstReport, contextReport] = await Promise.all([
      readFactoryReceiptAudit(
        input.dataDir,
        input.repoRoot,
        SYSTEM_IMPROVEMENT_AUDIT_LIMIT,
      ),
      runReceiptDstAudit(input.dataDir, { includeContext: false }),
      runReceiptContextDstAudit(input.dataDir, {
        repoRoot: input.repoRoot,
      }),
    ]);
    const compactAudit = compactAuditSummary(auditReport);
    const compactDst = compactDstSummary(dstReport);
    const compactContext = compactContextDstSummary(contextReport);
    const healthStatus = deriveSystemHealthStatus({
      audit: compactAudit,
      dst: compactDst,
      context: compactContext,
    });
    const systemRecommendationRun =
      await runSystemImprovementRecommendationGenerator(
        input.systemRecommendationGenerator
          ?? generateSystemImprovementRecommendations,
        {
          audit: compactAudit,
          dst: compactDst,
          context: compactContext,
          healthStatus,
        },
      );
    const selectedRecommendation =
      systemRecommendationRun.recommendations[0];
    let systemAutoFixObjectiveId: string | undefined;
    if (
      input.factoryService
      && input.autoFixEnabled !== false
      && autoFixSourceEligible
      && shouldCreateSystemAutoFixObjective(selectedRecommendation)
    ) {
      const existingObjectiveId = await findExistingSystemAutoFixObjective(
        input.factoryService,
        selectedRecommendation,
      );
      if (existingObjectiveId) {
        systemAutoFixObjectiveId = existingObjectiveId;
      } else {
        try {
          const objective = await input.factoryService.createObjective(
            buildSystemAutoFixObjectiveInput({
              recommendation: selectedRecommendation,
              audit: compactAudit,
              dst: compactDst,
              context: compactContext,
              triggerLabel:
                "Repo-wide self-improvement recommendation triggered this software delivery objective.",
            }),
          );
          systemAutoFixObjectiveId = objective.objectiveId;
        } catch {
          // system auto-fix is best-effort
        }
      }
    }
    systemImprovementReport = {
      generatedAt: Date.now(),
      healthStatus,
      auditSummary: compactAudit,
      dstSummary: compactDst,
      contextSummary: compactContext,
      recommendations: systemRecommendationRun.recommendations,
      selectedRecommendation,
      autoFixObjectiveId: systemAutoFixObjectiveId,
    };
    const artifact = systemImprovementArtifactPaths(input.dataDir);
    await fs.mkdir(artifact.root, { recursive: true });
    await fs.writeFile(
      artifact.jsonPath,
      JSON.stringify(systemImprovementReport, null, 2),
      "utf-8",
    );
    await fs.writeFile(
      artifact.textPath,
      renderSystemImprovementText(systemImprovementReport),
      "utf-8",
    );
  } catch (error) {
    systemImprovementError =
      error instanceof Error ? error.message : String(error);
  }

  return {
    objectiveId: parsed.objectiveId,
    objectiveStatus: parsed.objectiveStatus,
    objectiveUpdatedAt: parsed.objectiveUpdatedAt,
    verdict: report.assessment.verdict,
    easyRouteRisk: report.assessment.easyRouteRisk,
    efficiency: report.assessment.efficiency,
    controlChurn: report.assessment.controlChurn,
    alignmentVerdict: report.assessment.alignmentVerdict,
    correctiveSteerIssued: report.assessment.correctiveSteerIssued,
    alignedAfterCorrection: report.assessment.alignedAfterCorrection,
    jsonPath: artifacts.jsonPath,
    textPath: artifacts.textPath,
    recommendations: recommendations.length,
    recommendationStatus: recommendationRun.status,
    recommendationError: recommendationRun.error,
    autoFixObjectiveId,
    systemImprovementStatus: systemImprovementReport ? "ready" : "failed",
    systemImprovementError,
    systemAutoFixObjectiveId: systemImprovementReport?.autoFixObjectiveId,
  };
};

export const createFactoryWorkerHandlers = (
  service: FactoryService,
  opts: {
    readonly auditAutoFixEnabled?: boolean;
    readonly auditAutoFixSourceChannels?: ReadonlyArray<string>;
  } = {},
): Record<typeof FACTORY_CONTROL_AGENT_ID | typeof FACTORY_MONITOR_AGENT_ID | "codex", JobHandler> => ({
  [FACTORY_CONTROL_AGENT_ID]: async (job, ctx) => {
    await ctx.pullCommands(["abort", "steer"]);
    try {
      if (service.durable) await markDurableJobRunning(service.durable, job);
      const auditMemoryTools = service.memoryTools;
      const result =
        job.payload.kind === "factory.objective.audit"
          ? await runFactoryObjectiveAudit({
              dataDir: service.dataDir,
              repoRoot: service.git.repoRoot,
              memoryTools:
                auditMemoryTools ??
                (() => {
                  throw new Error(
                    "factory objective audit requires memory tools",
                  );
                })(),
              payload: job.payload as Record<string, unknown>,
              factoryService: service,
              autoFixEnabled: opts.auditAutoFixEnabled,
              autoFixSourceChannels: opts.auditAutoFixSourceChannels,
            })
          : await withObjectiveControlRetry(() =>
              service.runObjectiveControl(
                job.payload as Record<string, unknown>,
              )
            );
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message,
        result: {
          ...(typeof job.payload.objectiveId === "string"
            ? { objectiveId: job.payload.objectiveId }
            : {}),
          status: "failed",
          message,
        },
        noRetry: isNoRetryError(err),
      };
    }
  },
  [FACTORY_MONITOR_AGENT_ID]: async (job, ctx) => {
    try {
      if (service.durable) await markDurableJobRunning(service.durable, job);
      const result = await withFactoryJobKeepalive(
        service,
        job.id,
        ctx.workerId,
        () => service.runMonitorJob(
          job.payload as Record<string, unknown>,
          {
            jobId: job.id,
            shouldAbort: async () => {
              const latest = await service.queue.getJob(job.id);
              return (
                latest?.abortRequested === true ||
                isTerminalJobStatus(latest?.status)
              );
            },
            workerId: ctx.workerId,
          },
        ),
      );
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message,
        result: {
          ...(typeof job.payload.objectiveId === "string"
            ? { objectiveId: job.payload.objectiveId }
            : {}),
          status: "failed",
          message,
        },
        noRetry: isNoRetryError(err),
      };
    }
  },
  codex: async (job, ctx) => {
    try {
      if (service.durable) await markDurableJobRunning(service.durable, job);
      const result = await withFactoryJobKeepalive(
        service,
        job.id,
        ctx.workerId,
        async () => job.payload.kind === "factory.task.run"
          ? await (async () => {
              const runTaskWithControl = (
                activityController?: DurableActivityController<Record<string, unknown>>,
              ): Promise<Record<string, unknown>> => service.runTask(job.payload, {
                shouldAbort: async () => {
                  const latest = await service.queue.getJob(job.id);
                  return (
                    latest?.abortRequested === true ||
                    isTerminalJobStatus(latest?.status)
                  );
                },
                pollSignal: async () => {
                  const commands = await ctx.pullCommands([
                    "abort",
                    "steer",
                    "follow_up",
                  ]);
                  if (commands.some((command) => command.command === "abort"))
                    return { kind: "abort" as const };
                  const restart = coalesceLiveGuidanceSignal(
                    job.id,
                    commands
                      .filter(
                        (
                          command,
                        ): command is typeof command & {
                          readonly command: "steer" | "follow_up";
                        } =>
                          command.command === "steer" ||
                          command.command === "follow_up",
                      )
                      .map((command) => ({
                        id: command.id,
                        command: command.command,
                        payload: command.payload,
                      })),
                  );
                  if (restart) return restart;
                  const latest = await service.queue.getJob(job.id);
                  if (
                    latest?.abortRequested === true ||
                    isTerminalJobStatus(latest?.status)
                  )
                    return { kind: "abort" };
                  return undefined;
                },
                onProgress: async (update) => {
                  await service.queue.progress(job.id, ctx.workerId, {
                    worker: "codex",
                    ...update,
                  });
                },
                onChildSpawn: async (update) => {
                  ctx.registerLeaseProcess({
                    pid: update.pid,
                    label: "codex child",
                  });
                },
                onChildExit: async () => {
                  ctx.clearLeaseProcess();
                },
                ...(activityController ? { activityController } : {}),
              });

              if (!service.durable) {
                return runTaskWithControl();
              }

              let recoveredTaskResult:
                | Awaited<ReturnType<FactoryService["recoverTaskWorkerResult"]>>
                | undefined;
              const durableResult = await service.durable.runDurableActivity({
                key: codexActivityKey(job.id),
                input: {
                  jobId: job.id,
                  payload: { ...(job.payload as Record<string, unknown>) },
                },
                metadata: {
                  kind: String(job.payload.kind ?? "factory.task.run"),
                  objectiveId: typeof job.payload.objectiveId === "string" ? job.payload.objectiveId : undefined,
                },
                recover: async () => {
                  recoveredTaskResult = await service.recoverTaskWorkerResult(
                    job.payload as Record<string, unknown>,
                    { reason: "durable activity recovery before rerun" },
                  );
                  return recoveredTaskResult?.output;
                },
                run: async (activityController) =>
                  runTaskWithControl(activityController),
              }).then((activity) => activity.result);

              if (!recoveredTaskResult) {
                return durableResult;
              }
              await service.finalizeRecoveredTaskWorkerResult(
                job.payload as Record<string, unknown>,
                recoveredTaskResult.output,
              );
              return service.buildRecoveredTaskJobResult({
                output: recoveredTaskResult.output,
                recoverySource: recoveredTaskResult.recoverySource,
                interruptionKind: interruptionKindForJob(job),
              });
            })()
          : job.payload.kind === "factory.codex.run" ||
              job.payload.kind === "codex.run"
            ? await (async () => {
                const payload = job.payload as Record<string, unknown>;
                const basePrompt =
                  typeof payload.prompt === "string"
                    ? payload.prompt.trim()
                    : "";
                if (!basePrompt) {
                  throw new Error(
                    job.payload.kind === "factory.codex.run"
                      ? "factory codex prompt required"
                      : "codex prompt required",
                  );
                }
                const timeoutMs =
                  typeof payload.timeoutMs === "number" &&
                  Number.isFinite(payload.timeoutMs)
                    ? Math.max(
                        30_000,
                        Math.min(Math.floor(payload.timeoutMs), 900_000),
                      )
                    : 180_000;
                const guidanceHistory: string[] = [];
                while (true) {
                  try {
                    const runCodex = (): Promise<Record<string, unknown>> =>
                      runFactoryCodexJob(
                        {
                          dataDir: service.dataDir,
                          repoRoot: service.git.repoRoot,
                          jobId: job.id,
                          prompt: appendLiveOperatorGuidance(
                            basePrompt,
                            guidanceHistory,
                          ),
                          timeoutMs,
                          executor: service.codexExecutor,
                          factoryService: service,
                          payload,
                          onProgress: async (update) => {
                            await service.queue.progress(
                              job.id,
                              ctx.workerId,
                              update,
                            );
                          },
                        },
                        {
                          shouldAbort: async () => {
                            const latest = await service.queue.getJob(job.id);
                            return (
                              latest?.abortRequested === true ||
                              isTerminalJobStatus(latest?.status)
                            );
                          },
                          pollSignal: async () => {
                            const commands = await ctx.pullCommands([
                              "abort",
                              "steer",
                              "follow_up",
                            ]);
                            if (
                              commands.some(
                                (command) => command.command === "abort",
                              )
                            )
                              return { kind: "abort" as const };
                            const restart = coalesceLiveGuidanceSignal(
                              job.id,
                              commands
                                .filter(
                                  (
                                    command,
                                  ): command is typeof command & {
                                    readonly command: "steer" | "follow_up";
                                  } =>
                                    command.command === "steer" ||
                                    command.command === "follow_up",
                                )
                                .map((command) => ({
                                  id: command.id,
                                  command: command.command,
                                  payload: command.payload,
                                })),
                            );
                            if (restart) return restart;
                            const latest = await service.queue.getJob(job.id);
                            if (
                              latest?.abortRequested === true ||
                              isTerminalJobStatus(latest?.status)
                            )
                              return { kind: "abort" };
                            return undefined;
                          },
                          onChildSpawn: async (update) => {
                            ctx.registerLeaseProcess({
                              pid: update.pid,
                              label: "codex child",
                            });
                          },
                          onChildExit: async () => {
                            ctx.clearLeaseProcess();
                          },
                        },
                      );
                    if (!service.durable) {
                      return await runCodex();
                    }
                    return await service.durable.runDurableActivity({
                      key: codexActivityKey(job.id),
                      input: {
                        jobId: job.id,
                        payload,
                      },
                      metadata: {
                        kind: String(job.payload.kind ?? "factory.codex.run"),
                      },
                      recover: async () =>
                        recoverPersistedJsonResult(
                          directCodexResultPath(service.dataDir, job.id),
                        ),
                      run: runCodex,
                    }).then((activity) => activity.result);
                  } catch (error) {
                    if (
                      !(error instanceof CodexControlSignalError) ||
                      error.signal.kind !== "restart"
                    )
                      throw error;
                    const guidance =
                      typeof error.signal.note === "string"
                        ? error.signal.note.trim()
                        : "";
                    if (guidance) guidanceHistory.push(guidance);
                    continue;
                  }
                }
              })()
            : job.payload.kind === "factory.integration.validate"
              ? await service.runIntegrationValidation(job.payload)
              : job.payload.kind === "factory.integration.publish"
                ? await service.runIntegrationPublish(job.payload, {
                    shouldAbort: async () => {
                      const aborts = await ctx.pullCommands(["abort"]);
                      const latest = await service.queue.getJob(job.id);
                      return (
                        aborts.length > 0 ||
                        job.abortRequested === true ||
                        isTerminalJobStatus(latest?.status)
                      );
                    },
                    onChildSpawn: async (update) => {
                      ctx.registerLeaseProcess({
                        pid: update.pid,
                        label: "codex child",
                      });
                    },
                    onChildExit: async () => {
                      ctx.clearLeaseProcess();
                    },
                  })
                : (() => {
                    throw new Error(
                      `unsupported codex payload kind: ${String(job.payload.kind ?? "unknown")}`,
                    );
                  })(),
      );
      const objectiveId = typeof result.objectiveId === "string" ? result.objectiveId : undefined;
      const afterComplete = objectiveId !== undefined
        && (
          job.payload.kind === "factory.task.run"
          || job.payload.kind === "factory.integration.validate"
          || job.payload.kind === "factory.integration.publish"
        )
        && result?.status !== "skipped_terminal_state"
        ? async () => {
            await service.reactObjective(objectiveId);
          }
        : undefined;
      return { ok: true, result, afterComplete };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message,
        result: {
          ...(typeof job.payload.objectiveId === "string"
            ? { objectiveId: job.payload.objectiveId }
            : {}),
          status: "failed",
          message,
        },
        noRetry: isNoRetryError(err),
      };
    }
  },
});
