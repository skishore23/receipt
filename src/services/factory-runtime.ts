import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import { CodexControlSignalError, LocalCodexExecutor } from "../adapters/codex-executor";
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
import { jsonBranchStore, jsonlStore } from "../adapters/jsonl";
import type { QueueJob } from "../adapters/jsonl-queue";
import { embed, llmStructured } from "../adapters/openai";
import { z } from "zod";
import { createRuntime } from "@receipt/core/runtime";
import type { JobHandler } from "../engine/runtime/job-worker";
import type { SseHub } from "../framework/sse-hub";
import type { JobCmd, JobEvent, JobState } from "../modules/job";
import { FACTORY_CONTROL_AGENT_ID, FactoryService } from "./factory-service";
import type { FactoryObjectiveAuditJobPayload } from "./factory-types";
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
import { isSqliteLockError } from "../db/client";

export type FactoryQueue = JobBackend;
export type FactoryJobRuntime = ReturnType<typeof createRuntime<JobCmd, JobEvent, JobState>>;

type FactoryServiceRuntimeOptions = {
  readonly dataDir: string;
  readonly queue: FactoryQueue;
  readonly jobRuntime: FactoryJobRuntime;
  readonly sse: SseHub;
  readonly repoRoot: string;
  readonly codexBin?: string;
  readonly repoSlotConcurrency?: number;
  readonly memoryTools?: MemoryTools;
  readonly redriveQueuedJob?: (job: QueueJob) => Promise<void>;
  readonly auditAutoFixEnabled?: boolean;
};

const isNoRetryError = (err: unknown): boolean => {
  if (!err || typeof err !== "object" || !("status" in err)) return false;
  const status = (err as { readonly status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
};

const isTerminalJobStatus = (status: unknown): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const isRetryableAuditLockError = (error: unknown): boolean => {
  return isSqliteLockError(error);
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

type LiveGuidanceKind = "steer" | "follow_up" | "mixed";

type LiveGuidanceCommand = {
  readonly id: string;
  readonly command: "steer" | "follow_up";
  readonly payload?: Record<string, unknown>;
};

const guidanceMessageFromCommand = (command: LiveGuidanceCommand): string | undefined => {
  const payload = command.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const direct = typeof payload.message === "string" && payload.message.trim().length > 0
    ? payload.message.trim()
    : undefined;
  if (direct) return direct;
  if (command.command === "steer" && typeof payload.problem === "string" && payload.problem.trim().length > 0) {
    return payload.problem.trim();
  }
  if (command.command === "follow_up" && typeof payload.note === "string" && payload.note.trim().length > 0) {
    return payload.note.trim();
  }
  return undefined;
};

const coalesceLiveGuidanceSignal = (
  jobId: string,
  commands: ReadonlyArray<LiveGuidanceCommand>,
): {
  readonly kind: "restart";
  readonly note: string;
  readonly meta: Record<string, unknown>;
} | undefined => {
  const liveCommands = commands.filter((command) => command.command === "steer" || command.command === "follow_up");
  if (liveCommands.length === 0) return undefined;
  const messages = [...new Set(liveCommands.map((command) => guidanceMessageFromCommand(command)).filter((item): item is string => Boolean(item)))];
  if (messages.length === 0) return undefined;
  const guidanceKind: LiveGuidanceKind =
    liveCommands.every((command) => command.command === "steer")
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

const appendLiveOperatorGuidance = (prompt: string, guidanceBlocks: ReadonlyArray<string>): string => {
  const normalizedPrompt = prompt.trimEnd();
  if (guidanceBlocks.length === 0) return normalizedPrompt;
  const section = [
    "## Live Operator Guidance",
    ...guidanceBlocks.map((guidance, index) => `${index + 1}. ${guidance}`),
  ].join("\n\n");
  return `${normalizedPrompt}\n\n${section}\n`;
};

const AUTOFIX_PATTERN_THRESHOLD = 5;
const RECENT_AUDIT_PATTERN_WINDOW = 20;
const USAGE_LIMIT_ANOMALY_RE = /\b(usage_limit_reached|too many requests|rate limit|quota(?: exceeded| exhausted)?|429)\b/i;

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
    ? value as Record<string, unknown>
    : undefined;

const asArray = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : [];

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const categorizeAuditSummary = (summary: string): string | undefined => {
  const normalized = summary.toLowerCase();
  if (USAGE_LIMIT_ANOMALY_RE.test(summary)) return "quota_rate_limit";
  if (normalized.includes("lease expired")) return "lease_expired";
  if (isSqliteLockError(summary)) return "database_locked";
  if (normalized.includes("iteration budget exhausted")) return "iteration_budget_exhausted";
  if (/workspace (branch|path) already exists/i.test(summary)) return "workspace_collision";
  if (/human input|operator|clarification|approval|permission denied|access denied|unauthorized|forbidden/i.test(summary)) {
    return "human_input_or_permission_gate";
  }
  return undefined;
};

const deriveRecommendationPatternsFromReport = (report: FactoryReceiptInvestigation): ReadonlyArray<string> => {
  const patterns = new Set<string>();
  for (const anomaly of report.anomalies) {
    if (anomaly.kind) patterns.add(normalizeAuditPattern(anomaly.kind));
    const summarized = categorizeAuditSummary(anomaly.summary);
    if (summarized) patterns.add(summarized);
  }
  for (const note of report.assessment.notes) {
    const normalized = note.toLowerCase();
    if (normalized.includes("without structured evidence entries")) patterns.add("missing_structured_evidence");
    if (normalized.includes("scriptsrun") || normalized.includes("captured command logs")) patterns.add("missing_scripts_run");
    if (normalized.includes("proof items")) patterns.add("missing_proof");
    if (normalized.includes("alignment report")) patterns.add("alignment_not_reported");
  }
  if (report.assessment.alignmentVerdict === "not_reported") patterns.add("alignment_not_reported");
  return [...patterns];
};

const AuditRecommendationSchema = z.object({
  recommendations: z.array(z.object({
    summary: z.string(),
    anomalyPatterns: z.array(z.string()),
    scope: z.string(),
    confidence: z.enum(["low", "medium", "high"]),
    suggestedFix: z.string(),
  })),
});

type AuditRecommendationRun = {
  readonly recommendations: ReadonlyArray<AuditRecommendation>;
  readonly status: "ready" | "failed";
  readonly error?: string;
};

const AUTO_FIX_KEY_PREFIX = "factory_auto_fix_key:";

const autoFixRecommendationKey = (recommendation: AuditRecommendation): string =>
  createHash("sha1")
    .update(JSON.stringify({
      summary: recommendation.summary.trim().toLowerCase().replace(/\s+/g, " "),
      scope: recommendation.scope.trim().toLowerCase().replace(/\s+/g, " "),
      anomalyPatterns: [...new Set(recommendation.anomalyPatterns.map(normalizeAuditPattern).filter(Boolean))].sort(),
    }))
    .digest("hex")
    .slice(0, 16);

const autoFixPromptMarker = (key: string): string =>
  `${AUTO_FIX_KEY_PREFIX}${key}`;

const isOpenObjectiveStatus = (status: string): boolean =>
  status !== "completed" && status !== "failed" && status !== "canceled";

const findExistingAutoFixObjective = async (
  factoryService: FactoryService,
  recommendation: AuditRecommendation,
): Promise<string | undefined> => {
  const key = autoFixRecommendationKey(recommendation);
  const activeObjectives = (await factoryService.listObjectives())
    .filter((objective) => isOpenObjectiveStatus(objective.status));
  for (const objective of activeObjectives) {
    const state = await factoryService.getObjectiveState(objective.objectiveId).catch(() => undefined);
    if (!state || state.archivedAt || state.channel !== "auto-fix" || !isOpenObjectiveStatus(state.status)) continue;
    if (state.prompt.includes(autoFixPromptMarker(key))) {
      return state.objectiveId;
    }
  }
  return undefined;
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
    const recommendations = await recommendationGenerator(report, recentAuditEntries, patternCounts);
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
    throw new Error("OPENAI_API_KEY not set for audit recommendation generation");
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
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
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
      currentPatterns.length > 0 ? currentPatterns.map((pattern) => `- ${pattern}`).join("\n") : "none",
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
    anomalyPatterns: recommendation.anomalyPatterns.map(normalizeAuditPattern).filter(Boolean),
    scope: recommendation.scope.trim() || "unknown",
  }));
};

const objectiveIdFromAuditEntry = (text: string): string | undefined => {
  const match = text.match(/^\[([^\]]+)\]/m);
  return match?.[1]?.trim();
};

const readPersistedAuditPatterns = async (
  dataDir: string,
  objectiveId: string,
): Promise<ReadonlyArray<string>> => {
  const metadata = await readPersistedObjectiveAuditMetadata(dataDir, objectiveId);
  if (metadata?.recommendations.length) {
    return [...new Set(metadata.recommendations.flatMap((recommendation) =>
      recommendation.anomalyPatterns.map(normalizeAuditPattern)).filter(Boolean))];
  }
  try {
    const artifact = objectiveAuditArtifactPaths(dataDir, objectiveId);
    const raw = JSON.parse(await fs.readFile(artifact.jsonPath, "utf-8")) as Record<string, unknown>;
    const anomalies = asArray(raw.anomalies);
    const assessment = asRecord(raw.assessment);
    const notes = asArray(assessment?.notes).map((note) => asString(note)).filter((note): note is string => Boolean(note));
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
      if (normalized.includes("without structured evidence entries")) patterns.add("missing_structured_evidence");
      if (normalized.includes("scriptsrun") || normalized.includes("captured command logs")) patterns.add("missing_scripts_run");
      if (normalized.includes("proof items")) patterns.add("missing_proof");
      if (normalized.includes("alignment report")) patterns.add("alignment_not_reported");
    }
    const alignmentVerdict = asString(assessment?.alignmentVerdict);
    if (alignmentVerdict === "not_reported") patterns.add("alignment_not_reported");
    return [...patterns];
  } catch {
    return [];
  }
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
    for (const pattern of new Set(patterns.map(normalizeAuditPattern).filter(Boolean))) {
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
        .filter((pattern) => (patternCounts.get(pattern) ?? 0) >= AUTOFIX_PATTERN_THRESHOLD),
      maxCount: Math.max(
        0,
        ...recommendation.anomalyPatterns.map((pattern) => patternCounts.get(normalizeAuditPattern(pattern)) ?? 0),
      ),
    }))
    .filter((entry) =>
      entry.recommendation.confidence === "high"
      && entry.recurringPatterns.length > 0)
    .sort((left, right) =>
      right.maxCount - left.maxCount
      || right.recurringPatterns.length - left.recurringPatterns.length
      || left.recommendation.summary.localeCompare(right.recommendation.summary))[0]
    ?.recommendation;

const renderObjectiveAuditText = (input: {
  readonly report: FactoryReceiptInvestigation;
  readonly recommendations: ReadonlyArray<AuditRecommendation>;
  readonly recommendationStatus: "ready" | "failed";
  readonly recommendationError?: string;
  readonly autoFixObjectiveId?: string;
}): string => {
  const base = renderFactoryReceiptInvestigationText(input.report, { timelineLimit: 20, contextChars: 1_600 });
  const section = [
    "",
    "## Audit Recommendations",
    ...(input.recommendationStatus === "failed"
      ? [`- generation failed: ${input.recommendationError ?? "unknown error"}`]
      : []),
    ...(input.recommendations.length > 0
      ? input.recommendations.map((recommendation) =>
          `- [${recommendation.confidence}] ${recommendation.summary} · scope=${recommendation.scope}${recommendation.anomalyPatterns.length > 0 ? ` · patterns=${recommendation.anomalyPatterns.join(",")}` : ""}`)
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

const parseObjectiveAuditPayload = (payload: Record<string, unknown>): FactoryObjectiveAuditJobPayload => {
  if (payload.kind !== "factory.objective.audit") {
    throw new Error("invalid factory objective audit payload");
  }
  const objectiveId = typeof payload.objectiveId === "string" ? payload.objectiveId.trim() : "";
  if (!objectiveId) throw new Error("factory objective audit payload missing objectiveId");
  const objectiveStatus = typeof payload.objectiveStatus === "string" ? payload.objectiveStatus.trim() : "";
  if (!objectiveStatus) throw new Error("factory objective audit payload missing objectiveStatus");
  const objectiveUpdatedAt = typeof payload.objectiveUpdatedAt === "number" && Number.isFinite(payload.objectiveUpdatedAt)
    ? payload.objectiveUpdatedAt
    : Date.now();
  return {
    kind: "factory.objective.audit",
    objectiveId,
    objectiveStatus,
    objectiveUpdatedAt,
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
    ...(input.notes.length > 0 ? input.notes.map((item) => `- ${item}`) : ["- none"]),
    "",
    "Recommendations",
    ...(input.recommendationStatus === "failed"
      ? [`- generation_failed: ${input.recommendationError ?? "unknown error"}`]
      : []),
    ...(input.recommendations.length > 0
      ? input.recommendations.map((r) =>
          `- [${r.confidence}] scope=${r.scope}${r.anomalyPatterns.length > 0 ? ` patterns=${r.anomalyPatterns.join(",")}` : ""} ${r.summary}`)
      : ["- none"]),
    ...(input.autoFixObjectiveId
      ? ["", "Auto-fix", `- Objective: ${input.autoFixObjectiveId} (delivery, severity 1)`]
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
    jsonlStore<MemoryEvent>(dataDir),
    jsonBranchStore(dataDir),
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

export const createFactoryServiceRuntime = (opts: FactoryServiceRuntimeOptions): {
  readonly service: FactoryService;
  readonly memoryTools: MemoryTools;
} => {
  const memoryTools = opts.memoryTools ?? createDefaultMemoryTools(opts.dataDir);

  const service = new FactoryService({
    dataDir: opts.dataDir,
    queue: opts.queue,
    jobRuntime: opts.jobRuntime,
    sse: opts.sse,
    codexExecutor: new LocalCodexExecutor({ bin: opts.codexBin }),
    memoryTools,
    repoRoot: opts.repoRoot,
    repoSlotConcurrency: opts.repoSlotConcurrency,
    redriveQueuedJob: opts.redriveQueuedJob,
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
  readonly recommendationGenerator?: (
    report: FactoryReceiptInvestigation,
    recentAuditEntries: ReadonlyArray<{ readonly text: string }>,
    patternCounts: ReadonlyMap<string, number>,
  ) => Promise<ReadonlyArray<AuditRecommendation>>;
}): Promise<Record<string, unknown>> => {
  const parsed = parseObjectiveAuditPayload(input.payload);
  const report = await withObjectiveAuditRetry(() =>
    readFactoryReceiptInvestigation(
      input.dataDir,
      input.repoRoot,
      parsed.objectiveId,
      { asOfTs: parsed.objectiveUpdatedAt },
    )
  );
  const artifacts = objectiveAuditArtifactPaths(input.dataDir, parsed.objectiveId);
  await fs.mkdir(artifacts.root, { recursive: true });

  // Read recent audit entries for cross-run patterns
  const recentAuditEntries = await input.memoryTools.read({
    scope: "factory/audits/repo",
    limit: RECENT_AUDIT_PATTERN_WINDOW,
  }).catch(() => []);
  const patternCounts = await clusterRecentAuditPatterns(input.dataDir, recentAuditEntries);

  // Generate LLM recommendations
  const recommendationGenerator = input.recommendationGenerator ?? generateAuditRecommendations;
  const recommendationRun = await runAuditRecommendationGenerator(
    recommendationGenerator,
    report,
    recentAuditEntries,
    patternCounts,
  );
  const recommendations = recommendationRun.recommendations;

  // Auto-fix: create a delivery objective when a high-confidence recommendation matches recurring patterns.
  let autoFixObjectiveId: string | undefined;
  if (input.factoryService && input.autoFixEnabled !== false) {
    const autoFixRec = selectAutoFixRecommendation(recommendations, patternCounts);
    if (autoFixRec) {
      try {
        const existingObjectiveId = await findExistingAutoFixObjective(input.factoryService, autoFixRec);
        if (existingObjectiveId) {
          autoFixObjectiveId = existingObjectiveId;
        } else {
          const autoFixKey = autoFixRecommendationKey(autoFixRec);
          const objective = await input.factoryService.createObjective({
            title: autoFixRec.summary.slice(0, 96),
            prompt: [
              "Auto-fix triggered by recurring audit recommendation.",
              "",
              "## Recommendation",
              autoFixRec.suggestedFix,
              "",
              "## Scope",
              autoFixRec.scope,
              "",
              `## Recurring Patterns (${autoFixRec.anomalyPatterns.join(", ")})`,
              ...autoFixRec.anomalyPatterns.map((pattern) =>
                `- ${normalizeAuditPattern(pattern)}: ${patternCounts.get(normalizeAuditPattern(pattern)) ?? 0} occurrence(s)`),
              "",
              "## Audit Deduplication",
              autoFixPromptMarker(autoFixKey),
            ].join("\n"),
            objectiveMode: "delivery",
            severity: 1,
            channel: "auto-fix",
            startImmediately: true,
          });
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
      recommendationStatus: recommendationRun.status,
      recommendationError: recommendationRun.error,
      recommendations,
      autoFixObjectiveId,
      recurringPatterns: [...patternCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 20)
        .map(([pattern, count]) => ({ pattern, count })),
    },
  };
  await fs.writeFile(artifacts.jsonPath, JSON.stringify(persistedReport, null, 2), "utf-8");
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
      `alignment=${report.assessment.alignmentVerdict}`,
      `recommendation_generation=${recommendationRun.status}`,
      report.assessment.correctiveSteerIssued
        ? `corrective_steer=issued aligned_after_correction=${report.assessment.alignedAfterCorrection ? "yes" : "no"}`
        : "corrective_steer=none",
      ...(recommendationRun.error ? [`recommendation_error=${recommendationRun.error}`] : []),
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
      tags: ["factory", "audit", parsed.objectiveStatus, report.assessment.verdict],
    }),
      input.memoryTools.commit({
      scope: "factory/audits/repo",
      text: `[${parsed.objectiveId}] ${memoryText}`,
      tags: ["factory", "audit", "repo", parsed.objectiveStatus, report.assessment.verdict],
    }),
    ]);
  });

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
  };
};

export const createFactoryWorkerHandlers = (
  service: FactoryService,
  opts: {
    readonly auditAutoFixEnabled?: boolean;
  } = {},
): Record<typeof FACTORY_CONTROL_AGENT_ID | "codex", JobHandler> => ({
  [FACTORY_CONTROL_AGENT_ID]: async (job, ctx) => {
    await ctx.pullCommands(["abort", "steer"]);
    try {
      const auditMemoryTools = service.memoryTools;
      const result = job.payload.kind === "factory.objective.audit"
        ? await runFactoryObjectiveAudit({
            dataDir: service.dataDir,
            repoRoot: service.git.repoRoot,
            memoryTools: auditMemoryTools ?? (() => { throw new Error("factory objective audit requires memory tools"); })(),
            payload: job.payload as Record<string, unknown>,
            factoryService: service,
            autoFixEnabled: opts.auditAutoFixEnabled,
          })
        : await service.runObjectiveControl(job.payload as Record<string, unknown>);
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message,
        result: {
          ...(typeof job.payload.objectiveId === "string" ? { objectiveId: job.payload.objectiveId } : {}),
          status: "failed",
          message,
        },
        noRetry: isNoRetryError(err),
      };
    }
  },
  codex: async (job, ctx) => {
    try {
      if (job.payload.kind === "factory.task.monitor") {
        const result = await service.runMonitorJob(
          job.payload as Record<string, unknown>,
          {
            shouldAbort: async () => {
              const latest = await service.queue.getJob(job.id);
              return latest?.abortRequested === true || isTerminalJobStatus(latest?.status);
            },
          },
        );
        return { ok: true, result };
      }

      const result = job.payload.kind === "factory.task.run"
        ? await service.runTask(job.payload, {
          shouldAbort: async () => {
            const latest = await service.queue.getJob(job.id);
            return latest?.abortRequested === true
              || isTerminalJobStatus(latest?.status);
          },
          pollSignal: async () => {
            const commands = await ctx.pullCommands(["abort", "steer", "follow_up"]);
            if (commands.some((command) => command.command === "abort")) return { kind: "abort" as const };
            const restart = coalesceLiveGuidanceSignal(
              job.id,
              commands
                .filter((command): command is typeof command & { readonly command: "steer" | "follow_up" } =>
                  command.command === "steer" || command.command === "follow_up")
                .map((command) => ({
                  id: command.id,
                  command: command.command,
                  payload: command.payload,
                })),
            );
            if (restart) return restart;
            const latest = await service.queue.getJob(job.id);
            if (latest?.abortRequested === true || isTerminalJobStatus(latest?.status)) return { kind: "abort" };
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
        })
        : job.payload.kind === "factory.codex.run" || job.payload.kind === "codex.run"
          ? await (async () => {
            const payload = job.payload as Record<string, unknown>;
            const basePrompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
            if (!basePrompt) {
              throw new Error(job.payload.kind === "factory.codex.run" ? "factory codex prompt required" : "codex prompt required");
            }
            const timeoutMs = typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
              ? Math.max(30_000, Math.min(Math.floor(payload.timeoutMs), 900_000))
              : 180_000;
            const guidanceHistory: string[] = [];
            while (true) {
              try {
                return await runFactoryCodexJob({
                  dataDir: service.dataDir,
                  repoRoot: service.git.repoRoot,
                  jobId: job.id,
                  prompt: appendLiveOperatorGuidance(basePrompt, guidanceHistory),
                  timeoutMs,
                  executor: service.codexExecutor,
                  factoryService: service,
                  payload,
                  onProgress: async (update) => {
                    await service.queue.progress(job.id, ctx.workerId, update);
                  },
                }, {
                  shouldAbort: async () => {
                    const latest = await service.queue.getJob(job.id);
                    return latest?.abortRequested === true || isTerminalJobStatus(latest?.status);
                  },
                  pollSignal: async () => {
                    const commands = await ctx.pullCommands(["abort", "steer", "follow_up"]);
                    if (commands.some((command) => command.command === "abort")) return { kind: "abort" as const };
                    const restart = coalesceLiveGuidanceSignal(
                      job.id,
                      commands
                        .filter((command): command is typeof command & { readonly command: "steer" | "follow_up" } =>
                          command.command === "steer" || command.command === "follow_up")
                        .map((command) => ({
                          id: command.id,
                          command: command.command,
                          payload: command.payload,
                        })),
                    );
                    if (restart) return restart;
                    const latest = await service.queue.getJob(job.id);
                    if (latest?.abortRequested === true || isTerminalJobStatus(latest?.status)) return { kind: "abort" };
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
                });
              } catch (error) {
                if (!(error instanceof CodexControlSignalError) || error.signal.kind !== "restart") throw error;
                const guidance = typeof error.signal.note === "string" ? error.signal.note.trim() : "";
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
                return aborts.length > 0
                  || job.abortRequested === true
                  || isTerminalJobStatus(latest?.status);
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
            throw new Error(`unsupported codex payload kind: ${String(job.payload.kind ?? "unknown")}`);
          })();
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message,
        result: {
          ...(typeof job.payload.objectiveId === "string" ? { objectiveId: job.payload.objectiveId } : {}),
          status: "failed",
          message,
        },
        noRetry: isNoRetryError(err),
      };
    }
  },
});
