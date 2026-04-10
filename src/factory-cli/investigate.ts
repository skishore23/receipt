import fs from "node:fs/promises";
import path from "node:path";

import { readFactoryParsedRun, type FactoryParsedRun } from "./parse";
import type { AuditRecommendation } from "./analyze";
import { readPersistedObjectiveAuditMetadata } from "../services/factory/objective-audit-artifacts";

type InvestigationFocusTaskRun = FactoryParsedRun["taskRuns"][number];
type InvestigationTask = NonNullable<FactoryParsedRun["objectiveAnalysis"]>["tasks"][number];
type InvestigationCandidate = NonNullable<FactoryParsedRun["objectiveAnalysis"]>["candidates"][number];
type InvestigationJob = NonNullable<FactoryParsedRun["objectiveAnalysis"]>["jobs"][number];
type InvestigationAgentRun = NonNullable<FactoryParsedRun["objectiveAnalysis"]>["agentRuns"][number];
type InvestigationAnomaly = NonNullable<FactoryParsedRun["objectiveAnalysis"]>["anomalies"][number];
type InvestigationTimelineItem = FactoryParsedRun["timeline"][number];

type InvestigationPacketContext = {
  readonly summaryPath?: string;
  readonly summaryText?: string;
  readonly manifestPath?: string;
  readonly contextPackPath?: string;
  readonly resultPath?: string;
  readonly lastMessagePath?: string;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
  readonly overview?: string;
  readonly objectiveMemory?: string;
  readonly integrationMemory?: string;
  readonly contractCriteria: ReadonlyArray<string>;
  readonly requiredChecks: ReadonlyArray<string>;
  readonly proofExpectation?: string;
  readonly alignmentVerdict?: "aligned" | "uncertain" | "drifted";
  readonly alignmentSatisfied: ReadonlyArray<string>;
  readonly alignmentMissing: ReadonlyArray<string>;
  readonly alignmentOutOfScope: ReadonlyArray<string>;
  readonly alignmentRationale?: string;
  readonly profileSkills: ReadonlyArray<string>;
  readonly selectedHelpers: ReadonlyArray<string>;
  readonly candidateLineage: ReadonlyArray<string>;
  readonly recentReceipts: ReadonlyArray<string>;
  readonly frontierTasks: ReadonlyArray<string>;
};

type InvestigationDag = {
  readonly roots: ReadonlyArray<string>;
  readonly edges: ReadonlyArray<string>;
  readonly lines: ReadonlyArray<string>;
};

type InvestigationAssessmentLevel = "low" | "medium" | "high";
type InvestigationAssessmentVerdict = "strong" | "mixed" | "weak";
type InvestigationEfficiency = "efficient" | "noisy" | "churn-heavy";
type InvestigationValidationSignal = "done" | "skipped" | "not-requested";

type InvestigationInterventions = {
  readonly recommendationCount: number;
  readonly synthesisDispatchCount: number;
  readonly recommendationApplied: boolean;
  readonly controllerCorrectionWorked: boolean;
  readonly latestRecommendation?: string;
  readonly timeline: ReadonlyArray<string>;
};

type InvestigationRunAssessment = {
  readonly verdict: InvestigationAssessmentVerdict;
  readonly easyRouteRisk: InvestigationAssessmentLevel;
  readonly efficiency: InvestigationEfficiency;
  readonly controlChurn: InvestigationAssessmentLevel;
  readonly contractCriteriaCount: number;
  readonly alignmentVerdict: "aligned" | "uncertain" | "drifted" | "not_reported";
  readonly correctiveSteerIssued: boolean;
  readonly alignedAfterCorrection: boolean;
  readonly recommendationApplied: boolean;
  readonly controllerCorrectionWorked: boolean;
  readonly proofPresent: boolean;
  readonly repoDiffProduced: boolean;
  readonly followUpValidation: InvestigationValidationSignal;
  readonly interventionRequired: boolean;
  readonly notes: ReadonlyArray<string>;
};

const VALIDATION_KEYWORD_RE = /\b(build|test|verify|lint|smoke|check|validat(?:e|ed|ion))\b/i;
const VALIDATION_OUTCOME_RE = /\b(passed|failed|completed|captured|executed|ran|run|succeeded|successful)\b/i;

export type FactoryReceiptInvestigation = {
  readonly requestedId?: string;
  readonly resolved: FactoryParsedRun["resolved"];
  readonly links: FactoryParsedRun["links"];
  readonly warnings: ReadonlyArray<string>;
  readonly summary: FactoryParsedRun["summary"] & {
    readonly whatHappened: ReadonlyArray<string>;
  };
  readonly objectiveMode: string;
  readonly window: FactoryParsedRun["window"];
  readonly inputs: FactoryParsedRun["inputs"];
  readonly outputs: FactoryParsedRun["outputs"];
  readonly dag: InvestigationDag;
  readonly packetContext?: InvestigationPacketContext;
  readonly timeline: ReadonlyArray<InvestigationTimelineItem>;
  readonly tasks: ReadonlyArray<InvestigationTask>;
  readonly candidates: ReadonlyArray<InvestigationCandidate>;
  readonly jobs: ReadonlyArray<InvestigationJob>;
  readonly agentRuns: ReadonlyArray<InvestigationAgentRun>;
  readonly anomalies: ReadonlyArray<InvestigationAnomaly>;
  readonly audit?: {
    readonly generatedAt?: number;
    readonly objectiveUpdatedAt?: number;
    readonly stale: boolean;
    readonly recommendationStatus: "ready" | "failed";
    readonly recommendationError?: string;
  };
  readonly recommendations: ReadonlyArray<AuditRecommendation>;
  readonly autoFixObjectiveId?: string;
  readonly interventions: InvestigationInterventions;
  readonly assessment: InvestigationRunAssessment;
};

export type FactoryReceiptInvestigationRenderOptions = {
  readonly timelineLimit?: number;
  readonly contextChars?: number;
  readonly compact?: boolean;
};

type FactoryReceiptInvestigationReadOptions = {
  readonly asOfTs?: number;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asArray = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : [];

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const truncateInline = (value: string | undefined, max = 220): string | undefined => {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`;
};

const truncateBlock = (value: string | undefined, max = 2_400): string | undefined => {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`;
};

const excerptBlock = (value: string | undefined, input: {
  readonly maxChars: number;
  readonly maxLines: number;
}): string | undefined => {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, input.maxLines);
  return truncateBlock(lines.join("\n"), input.maxChars);
};

const uniqueStrings = (values: ReadonlyArray<string | undefined>): ReadonlyArray<string> =>
  [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];

const asRecordArray = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  asArray(value)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));

const asStringArray = (value: unknown): ReadonlyArray<string> =>
  asArray(value)
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item));

const formatDurationMs = (durationMs: number | undefined): string => {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return "n/a";
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
};

const formatTimestamp = (value: number | undefined): string =>
  typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : "n/a";

const pathExists = async (targetPath: string | undefined): Promise<boolean> => {
  if (!targetPath) return false;
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const resolveArtifactPath = (
  basePath: string | undefined,
  candidatePath: string | undefined,
): string | undefined => {
  if (!candidatePath) return undefined;
  return path.isAbsolute(candidatePath)
    ? candidatePath
    : (basePath ? path.resolve(path.dirname(basePath), candidatePath) : undefined);
};

const readTextIfExists = async (targetPath: string | undefined): Promise<string | undefined> => {
  if (!await pathExists(targetPath)) return undefined;
  return fs.readFile(targetPath!, "utf-8");
};

const selectFocusTaskRun = (parsed: FactoryParsedRun): InvestigationFocusTaskRun | undefined => {
  const runs = [...parsed.taskRuns].reverse();
  if (parsed.links.candidateId) {
    const candidateMatch = runs.find((taskRun) => taskRun.candidateId === parsed.links.candidateId);
    if (candidateMatch) return candidateMatch;
  }
  if (parsed.links.taskId) {
    const taskMatch = runs.find((taskRun) => taskRun.taskId === parsed.links.taskId);
    if (taskMatch) return taskMatch;
  }
  return runs[0];
};

const renderTaskLine = (task: InvestigationTask, candidatePasses: number | undefined): string => {
  const deps = task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "none";
  const candidate = task.candidateId ? ` candidate=${task.candidateId}` : "";
  const job = task.jobId ? ` job=${task.jobId}` : "";
  const passes = typeof candidatePasses === "number" ? ` passes=${candidatePasses}` : "";
  const wait = task.waitDurationMs !== undefined ? ` wait=${formatDurationMs(task.waitDurationMs)}` : "";
  const run = task.runDurationMs !== undefined ? ` run=${formatDurationMs(task.runDurationMs)}` : "";
  return `${task.taskId} [${task.status}] deps=${deps}${candidate}${job}${passes}${wait}${run} :: ${task.title}`;
};

const buildDag = (parsed: FactoryParsedRun): InvestigationDag => {
  const analysis = parsed.objectiveAnalysis;
  if (!analysis) {
    return { roots: [], edges: [], lines: [] };
  }
  const tasks = [...analysis.tasks].sort((left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId));
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const task of tasks) {
    indegree.set(task.taskId, task.dependsOn.length);
    for (const dep of task.dependsOn) {
      const current = dependents.get(dep) ?? [];
      current.push(task.taskId);
      dependents.set(dep, current);
    }
  }
  const roots = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.taskId);
  const visited = new Set<string>();
  const lines: string[] = [];
  const walk = (taskId: string, depth: number): void => {
    if (visited.has(taskId)) return;
    visited.add(taskId);
    const task = tasks.find((item) => item.taskId === taskId);
    if (!task) return;
    const candidatePasses = analysis.metrics.objective.candidatePassesByTask[taskId];
    lines.push(`${"  ".repeat(depth)}- ${renderTaskLine(task, candidatePasses)}`);
    const latestSummary = truncateInline(task.latestSummary, 180);
    if (latestSummary) lines.push(`${"  ".repeat(depth + 1)}summary: ${latestSummary}`);
    if (task.blockedReason) lines.push(`${"  ".repeat(depth + 1)}blocked: ${truncateInline(task.blockedReason, 180)}`);
    const children = [...(dependents.get(taskId) ?? [])].sort();
    for (const child of children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  for (const task of tasks) {
    if (!visited.has(task.taskId)) walk(task.taskId, 0);
  }
  const edges = tasks.flatMap((task) =>
    task.dependsOn.length > 0
      ? task.dependsOn.map((dep) => `${dep} -> ${task.taskId}`)
      : [`${task.taskId} (root)`],
  );
  return { roots, edges, lines };
};

const summarizeContextPack = async (taskRun: InvestigationFocusTaskRun | undefined): Promise<InvestigationPacketContext | undefined> => {
  if (!taskRun) return undefined;
  const manifestJson = asRecord(taskRun.manifest.json);
  const manifestContext = asRecord(manifestJson?.context);
  const manifestPath = taskRun.manifest.resolvedPath ?? taskRun.manifest.originalPath;
  const contextPackPath = taskRun.contextPack.resolvedPath ?? taskRun.contextPack.originalPath;
  const resultPath = taskRun.resultFile.resolvedPath ?? taskRun.resultFile.originalPath;
  const lastMessagePath = taskRun.lastMessage.resolvedPath ?? taskRun.lastMessage.originalPath;
  const stdoutPath = taskRun.stdout.resolvedPath ?? taskRun.stdout.originalPath;
  const stderrPath = taskRun.stderr.resolvedPath ?? taskRun.stderr.originalPath;
  const contextSummaryPath = resolveArtifactPath(
    manifestPath,
    asString(manifestContext?.summaryPath) ?? asString(taskRun.payload.contextSummaryPath),
  );
  const summaryText = await readTextIfExists(contextSummaryPath);
  const contextPackJson = asRecord(taskRun.contextPack.json);
  const contract = asRecord(contextPackJson?.contract) ?? asRecord(manifestJson?.contract);
  const memory = asRecord(contextPackJson?.memory);
  const contextSources = asRecord(contextPackJson?.contextSources);
  const helperCatalog = asRecord(contextPackJson?.helperCatalog);
  const objectiveSlice = asRecord(contextPackJson?.objectiveSlice);
  const resultJson = asRecord(taskRun.resultFile.json);
  const resultAlignment = asRecord(resultJson?.alignment);
  const candidateLineage = asArray(contextPackJson?.candidateLineage)
    .map((item) => {
      const entry = asRecord(item);
      const id = asString(entry?.candidateId);
      if (!id) return undefined;
      const status = asString(entry?.status) ?? "unknown";
      const summary = truncateInline(asString(entry?.handoff) ?? asString(entry?.summary), 180);
      return summary ? `${id} [${status}] ${summary}` : `${id} [${status}]`;
    })
    .filter((item): item is string => Boolean(item));
  const recentReceipts = asArray(contextPackJson?.recentReceipts)
    .map((item) => {
      const receipt = asRecord(item);
      const type = asString(receipt?.type) ?? "unknown";
      const summary = truncateInline(asString(receipt?.summary), 180) ?? "no summary";
      return `${type}: ${summary}`;
    })
    .filter(Boolean);
  const frontierTasks = asArray(objectiveSlice?.frontierTasks)
    .map((item) => {
      const entry = asRecord(item);
      const taskId = asString(entry?.taskId);
      const title = asString(entry?.title);
      const status = asString(entry?.status);
      if (!taskId || !title || !status) return undefined;
      return `${taskId} [${status}] ${title}`;
    })
    .filter((item): item is string => Boolean(item));
  return {
    summaryPath: contextSummaryPath,
    summaryText: summaryText?.trim() || undefined,
    manifestPath,
    contextPackPath,
    resultPath,
    lastMessagePath,
    stdoutPath,
    stderrPath,
    overview: asString(memory?.overview),
    objectiveMemory: asString(memory?.objective),
    integrationMemory: asString(memory?.integration),
    contractCriteria: asStringArray(contract?.acceptanceCriteria),
    requiredChecks: asStringArray(contract?.requiredChecks),
    proofExpectation: asString(contract?.proofExpectation),
    alignmentVerdict: resultAlignment?.verdict === "aligned" || resultAlignment?.verdict === "uncertain" || resultAlignment?.verdict === "drifted"
      ? resultAlignment.verdict
      : undefined,
    alignmentSatisfied: asStringArray(resultAlignment?.satisfied),
    alignmentMissing: asStringArray(resultAlignment?.missing),
    alignmentOutOfScope: asStringArray(resultAlignment?.outOfScope),
    alignmentRationale: asString(resultAlignment?.rationale),
    profileSkills: asArray(contextSources?.profileSkillRefs)
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item)),
    selectedHelpers: asArray(helperCatalog?.selectedHelpers)
      .map((item) => {
        const helper = asRecord(item);
        const id = asString(helper?.id);
        const description = truncateInline(asString(helper?.description), 140);
        return id ? `${id}${description ? `: ${description}` : ""}` : undefined;
      })
      .filter((item): item is string => Boolean(item)),
    candidateLineage,
    recentReceipts,
    frontierTasks,
  };
};

const buildInterventions = (
  parsed: FactoryParsedRun,
): Omit<InvestigationInterventions, "controllerCorrectionWorked"> => {
  const interventionTimeline = parsed.timeline
    .filter((item) => item.type === "monitor.recommendation" || item.type === "task.synthesis.dispatched")
    .map((item) => `${item.type}: ${truncateInline(item.summary, 220) ?? item.summary}`);
  const recommendations = parsed.timeline.filter((item) => item.type === "monitor.recommendation");
  const synthesisDispatches = parsed.timeline.filter((item) => item.type === "task.synthesis.dispatched");
  const latestRecommendation = interventionTimeline.at(-1);
  return {
    recommendationCount: recommendations.length,
    synthesisDispatchCount: synthesisDispatches.length,
    recommendationApplied: recommendations.length > 0,
    latestRecommendation,
    timeline: interventionTimeline,
  };
};

const buildAssessment = (
  parsed: FactoryParsedRun,
  packetContext: InvestigationPacketContext | undefined,
  focusTaskRun: InvestigationFocusTaskRun | undefined,
  interventions: Omit<InvestigationInterventions, "controllerCorrectionWorked">,
): InvestigationRunAssessment => {
  const analysis = parsed.objectiveAnalysis;
  const result = asRecord(parsed.outputs.result);
  const completion = asRecord(result?.completion);
  const report = asRecord(result?.report);
  const changed = asStringArray(completion?.changed);
  const proof = asStringArray(completion?.proof);
  const scriptsRun = [
    ...asRecordArray(result?.scriptsRun),
    ...asRecordArray(report?.scriptsRun),
  ];
  const scriptCount = scriptsRun.filter((item) => asString(item.command)).length;
  const commandCount = focusTaskRun?.stdout.commands.length ?? 0;
  const evidenceCount = asRecordArray(report?.evidence).length;
  const helperCount = packetContext?.selectedHelpers.length ?? 0;
  const controlJobs = analysis?.jobs.filter((job) => job.payloadKind === "factory.objective.control").length ?? 0;
  const stalledJobs = analysis?.jobs.filter((job) => job.status === "stalled").length ?? 0;
  const failedJobs = analysis?.jobs.filter((job) => job.status === "failed" || job.status === "canceled").length ?? 0;
  const leaseExpiredCount = analysis?.anomalies.filter((item) => item.summary.includes("lease expired")).length ?? 0;
  const budgetExceededCount = analysis?.anomalies.filter((item) => item.summary.includes("iteration budget exhausted")).length ?? 0;
  const dbLockedCount = analysis?.anomalies.filter((item) => item.summary.includes("database is locked")).length ?? 0;
  const workspaceCollisionCount = analysis?.anomalies.filter((item) => /workspace (branch|path) already exists/i.test(item.summary)).length ?? 0;
  const success = parsed.summary.status === "completed";
  const blocked = parsed.summary.status === "blocked" || parsed.summary.status === "failed" || parsed.summary.status === "canceled";
  const terminal = success || blocked;
  const inFlight = !terminal;
  const objectiveMode = analysis?.objectiveMode ?? "unknown";
  const proofPresent = proof.length > 0;
  const repoDiffProduced = changed.length > 0;
  const contractCriteriaCount = packetContext?.contractCriteria.length ?? 0;
  const alignmentVerdict = packetContext?.alignmentVerdict ?? "not_reported";
  const correctiveSteerIssued = parsed.timeline.some((item) =>
    item.type === "objective.operator.noted"
    && item.summary.includes("Alignment correction for this objective"),
  );
  const alignedAfterCorrection = correctiveSteerIssued && alignmentVerdict === "aligned";
  const requiredChecks = uniqueStrings([...(parsed.inputs.checks ?? []), ...(packetContext?.requiredChecks ?? [])]);
  const validationCommandSignals = uniqueStrings([
    ...scriptsRun.map((item) => asString(item.command)),
    ...(focusTaskRun?.stdout.commands.map((item) => item.command) ?? []),
  ]);
  const validationNarrativeSignals = uniqueStrings([
    ...scriptsRun.map((item) => asString(item.summary)),
    ...(focusTaskRun?.stdout.commands.map((item) => item.outputPreview) ?? []),
    ...proof,
  ]);
  const normalizedValidationCommands = validationCommandSignals.map((item) => item.toLowerCase());
  const normalizedValidationNarratives = validationNarrativeSignals.map((item) => item.toLowerCase());
  const normalizedRequiredChecks = requiredChecks.map((item) => item.toLowerCase());
  const validationRequested = normalizedRequiredChecks.length > 0
    || parsed.timeline.some((item) =>
      (item.type === "monitor.recommendation" || item.type === "objective.operator.noted")
      && VALIDATION_KEYWORD_RE.test(item.summary));
  const validationCommandMatched = normalizedRequiredChecks.some((check) =>
    normalizedValidationCommands.some((signal) => signal.includes(check)));
  const validationNarrativeMatched = normalizedRequiredChecks.some((check) =>
    normalizedValidationNarratives.some((signal) => signal.includes(check)));
  const validationNarrativePresent = normalizedValidationNarratives.some((signal) =>
    VALIDATION_KEYWORD_RE.test(signal) && VALIDATION_OUTCOME_RE.test(signal));
  const followUpValidation: InvestigationValidationSignal =
    !validationRequested
      ? "not-requested"
      : validationCommandMatched || validationNarrativeMatched || validationNarrativePresent
        ? "done"
        : "skipped";

  let easyRouteScore = 0;
  const notes: string[] = [];

  if (objectiveMode === "delivery" && success) {
    if (changed.length === 0) {
      easyRouteScore += 2;
      notes.push("Delivery result completed without listing changed files in completion metadata.");
    }
    if (proof.length === 0) {
      easyRouteScore += 1;
      notes.push("Delivery result completed without proof items in completion metadata.");
    }
    if ((parsed.inputs.checks?.length ?? 0) > 0 && scriptCount === 0 && commandCount === 0) {
      easyRouteScore += 2;
      notes.push("Declared validation checks were not reflected in scriptsRun or captured command logs.");
    }
    if (alignmentVerdict === "not_reported") {
      easyRouteScore += 1;
      notes.push("Delivery result did not include an explicit objective-alignment report.");
    } else if (alignmentVerdict === "uncertain") {
      easyRouteScore += 2;
      notes.push("Delivery result reported uncertain objective alignment.");
    } else if (alignmentVerdict === "drifted") {
      easyRouteScore += 3;
      notes.push("Delivery result reported drift from the stated objective contract.");
    }
  }

  if (objectiveMode === "investigation" && success) {
    if (evidenceCount === 0) {
      easyRouteScore += 2;
      notes.push("Investigation completed without structured evidence entries.");
    }
    if (scriptCount === 0 && commandCount === 0 && helperCount === 0) {
      easyRouteScore += 2;
      notes.push("Investigation completed without helper use, scriptsRun entries, or captured command logs.");
    }
  }

  if (scriptCount > 0 || commandCount > 0 || evidenceCount > 0 || helperCount > 0) {
    easyRouteScore = Math.max(0, easyRouteScore - 1);
    notes.push(`Captured ${scriptCount + commandCount} execution signal(s), ${evidenceCount} evidence item(s), and ${helperCount} helper hint(s).`);
  }
  if (interventions.recommendationApplied) {
    notes.push(
      `Controller-consumed monitor recommendations were recorded ${interventions.recommendationCount} time(s); synthesis was dispatched ${interventions.synthesisDispatchCount} time(s).`,
    );
  }
  if (inFlight) {
    notes.push(`Objective is still ${parsed.summary.status}, so this assessment is provisional rather than a final quality verdict.`);
  }
  if (contractCriteriaCount > 0) {
    notes.push(`Objective contract carried ${contractCriteriaCount} acceptance criteria into the worker packet.`);
  }
  if (correctiveSteerIssued) {
    notes.push(alignedAfterCorrection
      ? "Receipt issued one corrective alignment steer and the final result came back aligned."
      : "Receipt issued one corrective alignment steer before the final result.");
  }
  if (packetContext?.alignmentMissing.length) {
    notes.push(`Latest alignment report still marked ${packetContext.alignmentMissing.length} missing contract item(s).`);
  }
  if (packetContext?.alignmentOutOfScope.length) {
    notes.push(`Latest alignment report called out ${packetContext.alignmentOutOfScope.length} out-of-scope item(s).`);
  }

  const easyRouteRisk: InvestigationAssessmentLevel =
    easyRouteScore >= 3 ? "high" : easyRouteScore >= 1 ? "medium" : "low";

  const controlChurn: InvestigationAssessmentLevel =
    controlJobs >= 20 ? "high" : controlJobs >= 6 ? "medium" : "low";
  const synthesisLoop = inFlight && interventions.synthesisDispatchCount > 1;
  const severeSynthesisLoop = inFlight && interventions.synthesisDispatchCount >= 3;

  const efficiency: InvestigationEfficiency =
    severeSynthesisLoop || stalledJobs > 0 || controlJobs >= 20 || failedJobs >= 4 || leaseExpiredCount >= 3 || budgetExceededCount >= 2
      ? "churn-heavy"
      : synthesisLoop || controlJobs >= 6 || failedJobs >= 2 || leaseExpiredCount > 0 || budgetExceededCount > 0
        ? "noisy"
        : "efficient";

  if (controlJobs > 0 && controlChurn !== "low") {
    notes.push(`Control-plane churn was ${controlChurn} with ${controlJobs} objective-control job(s).`);
  }
  if (leaseExpiredCount > 0) {
    notes.push(`Lease expiry surfaced ${leaseExpiredCount} time(s); recovery quality is hard to judge until runtime stability improves.`);
  }
  if (stalledJobs > 0) {
    notes.push(`Live execution stalled on ${stalledJobs} job(s); the objective is not making forward progress.`);
  }
  if (budgetExceededCount > 0) {
    notes.push(`Iteration budgets were exhausted ${budgetExceededCount} time(s), which suggests poor convergence or an over-broad task frame.`);
  }
  if (dbLockedCount > 0) {
    notes.push(`Receipt database lock contention surfaced ${dbLockedCount} time(s).`);
  }
  if (workspaceCollisionCount > 0) {
    notes.push(`Workspace collisions surfaced ${workspaceCollisionCount} time(s).`);
  }
  if (synthesisLoop) {
    notes.push(severeSynthesisLoop
      ? "Repeated synthesis dispatches occurred without terminal completion; the runtime is churning after controller takeover."
      : "A synthesis dispatch was required before the run reached terminal completion.");
  }
  if (followUpValidation === "done") {
    notes.push("Validation evidence was captured after the worker change.");
  } else if (followUpValidation === "skipped") {
    notes.push("Validation looked requested but did not show up in scriptsRun or proof.");
  }

  const verdict: InvestigationAssessmentVerdict =
    blocked || severeSynthesisLoop || stalledJobs > 0 || easyRouteRisk === "high" || efficiency === "churn-heavy" || alignmentVerdict === "drifted"
      ? "weak"
      : inFlight || synthesisLoop || easyRouteRisk === "medium" || efficiency === "noisy" || dbLockedCount > 0 || workspaceCollisionCount > 0 || alignmentVerdict === "uncertain"
        ? "mixed"
        : "strong";
  const primaryOutcomeCaptured = objectiveMode === "delivery"
    ? repoDiffProduced
    : repoDiffProduced || evidenceCount > 0 || scriptCount > 0 || commandCount > 0;
  const alignmentSatisfiedForObjective = objectiveMode !== "delivery" || alignmentVerdict === "aligned";
  const controllerCorrectionWorked = (interventions.recommendationApplied || correctiveSteerIssued)
    && success
    && primaryOutcomeCaptured
    && proofPresent
    && easyRouteRisk !== "high"
    && alignmentSatisfiedForObjective;

  return {
    verdict,
    easyRouteRisk,
    efficiency,
    controlChurn,
    contractCriteriaCount,
    alignmentVerdict,
    correctiveSteerIssued,
    alignedAfterCorrection,
    recommendationApplied: interventions.recommendationApplied,
    controllerCorrectionWorked,
    proofPresent,
    repoDiffProduced,
    followUpValidation,
    interventionRequired: interventions.recommendationApplied || correctiveSteerIssued,
    notes: uniqueStrings(notes),
  };
};

const buildWhatHappened = (
  parsed: FactoryParsedRun,
  packetContext: InvestigationPacketContext | undefined,
  interventions: Omit<InvestigationInterventions, "controllerCorrectionWorked">,
): ReadonlyArray<string> => {
  const analysis = parsed.objectiveAnalysis;
  const bullets: string[] = [];
  if (analysis) {
    bullets.push(
      `${analysis.title} is currently ${analysis.status} in ${analysis.objectiveMode} mode with ${analysis.tasks.length} task(s), ${analysis.candidates.length} candidate pass(es), and ${analysis.jobs.length} job(s).`,
    );
    bullets.push(
      `Planning/dispatch flow observed ${analysis.metrics.objective.dispatches} dispatch(es), ${analysis.metrics.objective.rebrackets} rebracket decision(s), and peak concurrency ${analysis.metrics.objective.maxObservedActiveTasks}/${analysis.metrics.objective.concurrencyLimit}.`,
    );
    if (analysis.latestSummary) {
      bullets.push(`Latest objective summary: ${truncateInline(analysis.latestSummary, 260) ?? analysis.latestSummary}`);
    }
    if (analysis.blockedReason) {
      bullets.push(`Current blocker: ${truncateInline(analysis.blockedReason, 260) ?? analysis.blockedReason}`);
    }
    const integrationReady = analysis.metrics.objective.eventCounts["integration.ready_to_promote"] ?? 0;
    const promoted = analysis.metrics.objective.eventCounts["integration.promoted"] ?? 0;
    const published = analysis.jobs.filter((job) => job.payloadKind === "factory.integration.publish").length;
    if (integrationReady > 0 || promoted > 0 || published > 0) {
      bullets.push(
        `Integration/publish flow: ready_to_promote=${integrationReady}, promoted=${promoted}, publish_jobs=${published}.`,
      );
    }
    const highSeverity = analysis.anomalies.filter((item) => item.severity === "high");
    if (highSeverity.length > 0) {
      bullets.push(`High-severity anomalies: ${highSeverity.slice(0, 3).map((item) => truncateInline(item.summary, 120) ?? item.summary).join(" | ")}`);
    }
  } else {
    bullets.push(`Resolved ${parsed.resolved.kind} target without a linked objective analysis.`);
  }
  if (parsed.links.taskId) {
    const focusedTask = analysis?.tasks.find((task) => task.taskId === parsed.links.taskId);
    if (focusedTask) {
      bullets.push(
        `Focused task ${focusedTask.taskId} is ${focusedTask.status}${focusedTask.candidateId ? ` with candidate ${focusedTask.candidateId}` : ""}.`,
      );
    }
  }
  if (interventions.recommendationCount > 0 || interventions.synthesisDispatchCount > 0) {
    bullets.push(
      `Monitor recommendations were recorded ${interventions.recommendationCount} time(s); synthesis was dispatched ${interventions.synthesisDispatchCount} time(s).`,
    );
  }
  if (packetContext?.alignmentVerdict) {
    bullets.push(`Latest worker alignment verdict: ${packetContext.alignmentVerdict}.`);
  }
  if (packetContext?.summaryPath) {
    bullets.push(`Worker packet summary available at ${packetContext.summaryPath}.`);
  }
  return uniqueStrings(bullets);
};

export const readFactoryReceiptInvestigation = async (
  dataDir: string,
  repoRoot: string,
  requestedId?: string,
  options: FactoryReceiptInvestigationReadOptions = {},
): Promise<FactoryReceiptInvestigation> => {
  const parsed = await readFactoryParsedRun(dataDir, repoRoot, requestedId, options);
  const analysis = parsed.objectiveAnalysis;
  const warnings = [...parsed.warnings];
  const objectiveId =
    parsed.links.objectiveId
    ?? (parsed.resolved.kind === "objective" ? parsed.resolved.id : undefined);
  const persistedAudit = objectiveId
    ? await readPersistedObjectiveAuditMetadata(dataDir, objectiveId)
    : undefined;
  const auditStale = Boolean(
    persistedAudit
    && typeof persistedAudit.objectiveUpdatedAt === "number"
    && typeof options.asOfTs === "number"
    && persistedAudit.objectiveUpdatedAt < options.asOfTs,
  );
  if (auditStale) {
    warnings.push("Persisted objective audit is stale relative to the latest objective update.");
  }
  if (persistedAudit?.recommendationStatus === "failed") {
    warnings.push(`Audit recommendation generation failed${persistedAudit.recommendationError ? `: ${persistedAudit.recommendationError}` : "."}`);
  }
  const focusTaskRun = selectFocusTaskRun(parsed);
  const packetContext = await summarizeContextPack(focusTaskRun);
  const interventionSignals = buildInterventions(parsed);
  const assessment = buildAssessment(parsed, packetContext, focusTaskRun, interventionSignals);
  return {
    requestedId,
    resolved: parsed.resolved,
    links: parsed.links,
    warnings,
    summary: {
      ...parsed.summary,
      whatHappened: buildWhatHappened(parsed, packetContext, interventionSignals),
    },
    objectiveMode: analysis?.objectiveMode ?? "unknown",
    window: parsed.window,
    inputs: parsed.inputs,
    outputs: parsed.outputs,
    dag: buildDag(parsed),
    packetContext,
    timeline: parsed.timeline,
    tasks: analysis?.tasks ?? [],
    candidates: analysis?.candidates ?? [],
    jobs: analysis?.jobs ?? [],
    agentRuns: analysis?.agentRuns ?? [],
    anomalies: analysis?.anomalies ?? [],
    audit: persistedAudit
      ? {
          generatedAt: persistedAudit.generatedAt > 0 ? persistedAudit.generatedAt : undefined,
          objectiveUpdatedAt: persistedAudit.objectiveUpdatedAt,
          stale: auditStale,
          recommendationStatus: persistedAudit.recommendationStatus,
          recommendationError: persistedAudit.recommendationError,
        }
      : undefined,
    recommendations: persistedAudit?.recommendations.length
      ? persistedAudit.recommendations
      : analysis?.recommendations ?? [],
    autoFixObjectiveId: persistedAudit?.autoFixObjectiveId,
    interventions: {
      ...interventionSignals,
      controllerCorrectionWorked: assessment.controllerCorrectionWorked,
    },
    assessment,
  };
};

export const renderFactoryReceiptInvestigationText = (
  report: FactoryReceiptInvestigation,
  opts: FactoryReceiptInvestigationRenderOptions = {},
): string => {
  const compact = opts.compact === true;
  const timelineLimit = Math.max(1, opts.timelineLimit ?? (compact ? 12 : 20));
  const contextChars = Math.max(200, opts.contextChars ?? (compact ? 700 : 1_200));
  const contextExcerpt = excerptBlock(report.packetContext?.summaryText, {
    maxChars: contextChars,
    maxLines: compact ? 8 : 14,
  });
  const taskLines = report.tasks.length > 0
    ? report.tasks
      .slice(0, compact ? 4 : report.tasks.length)
      .map((task) =>
        `- ${renderTaskLine(task, undefined)}${task.latestSummary ? ` :: ${truncateInline(task.latestSummary, 140)}` : ""}`)
    : ["- none"];
  const candidateLines = report.candidates.length > 0
    ? report.candidates
      .slice(0, compact ? 4 : report.candidates.length)
      .map((candidate) =>
        `- ${candidate.candidateId} [${candidate.status}] task=${candidate.taskId}${candidate.tokensUsed ? ` tokens=${candidate.tokensUsed}` : ""}${candidate.summary ? ` :: ${truncateInline(candidate.summary, 140)}` : ""}`)
    : ["- none"];
  const jobLines = report.jobs.length > 0
    ? report.jobs
      .slice(0, compact ? 5 : report.jobs.length)
      .map((job) =>
        `- ${job.jobId} [${job.status}] ${job.payloadKind ?? "unknown"}${job.payloadTaskId ? ` task=${job.payloadTaskId}` : ""}${job.payloadCandidateId ? ` candidate=${job.payloadCandidateId}` : ""}${job.lastError ? ` :: ${truncateInline(job.lastError, 140)}` : ""}`)
    : ["- none"];
  const lines = [
    "# Factory Receipt Investigation",
    "",
    `Requested: ${report.requestedId ?? "latest"}`,
    `Resolved: ${report.resolved.kind} via ${report.resolved.matchedBy}`,
    `Stream: ${report.resolved.stream}`,
    report.links.objectiveId ? `Objective: ${report.links.objectiveId}` : undefined,
    report.links.taskId ? `Task: ${report.links.taskId}` : undefined,
    report.links.candidateId ? `Candidate: ${report.links.candidateId}` : undefined,
    report.links.jobId ? `Job: ${report.links.jobId}` : undefined,
    report.links.runId ? `Run: ${report.links.runId}` : undefined,
    report.summary.title ? `Title: ${report.summary.title}` : undefined,
    report.summary.status ? `Status: ${report.summary.status}` : undefined,
    report.window.durationMs !== undefined ? `Duration: ${formatDurationMs(report.window.durationMs)}` : undefined,
    "",
    "## What Happened",
    ...(report.summary.whatHappened.length > 0
      ? report.summary.whatHappened.map((item) => `- ${item}`)
      : ["- No high-level narrative could be derived."]),
    report.summary.text ? `- Latest text: ${truncateInline(report.summary.text, 260) ?? report.summary.text}` : undefined,
    report.summary.blockedReason ? `- Blocked reason: ${truncateInline(report.summary.blockedReason, 260) ?? report.summary.blockedReason}` : undefined,
    "",
    "## Assessment",
    `Verdict: ${report.assessment.verdict}`,
    `Easy route risk: ${report.assessment.easyRouteRisk}`,
    `Efficiency: ${report.assessment.efficiency}`,
    `Control churn: ${report.assessment.controlChurn}`,
    `Contract criteria: ${report.assessment.contractCriteriaCount}`,
    `Alignment verdict: ${report.assessment.alignmentVerdict}`,
    `Corrective steer issued: ${report.assessment.correctiveSteerIssued ? "yes" : "no"}`,
    `Aligned after correction: ${report.assessment.alignedAfterCorrection ? "yes" : "no"}`,
    `Proof present: ${report.assessment.proofPresent ? "yes" : "no"}`,
    `Repo diff produced: ${report.assessment.repoDiffProduced ? "yes" : "no"}`,
    `Follow-up validation: ${report.assessment.followUpValidation}`,
    `Recommendation applied: ${report.assessment.recommendationApplied ? "yes" : "no"}`,
    `Controller correction worked: ${report.assessment.controllerCorrectionWorked ? "yes" : "no"}`,
    ...(report.assessment.notes.length > 0
      ? report.assessment.notes.map((item) => `- ${truncateInline(item, 240) ?? item}`)
      : ["- No additional assessment notes."]),
    "",
    "## Interventions",
    `Recommendations: ${report.interventions.recommendationCount}`,
    `Synthesis dispatches: ${report.interventions.synthesisDispatchCount}`,
    `Recommendation applied: ${report.interventions.recommendationApplied ? "yes" : "no"}`,
    `Controller correction worked: ${report.interventions.controllerCorrectionWorked ? "yes" : "no"}`,
    report.interventions.latestRecommendation ? `Latest recommendation: ${truncateInline(report.interventions.latestRecommendation, 240) ?? report.interventions.latestRecommendation}` : undefined,
    ...(report.interventions.timeline.length > 0
      ? report.interventions.timeline.map((item) => `- ${item}`)
      : ["- none"]),
    "",
    "## Context",
    report.inputs.objectivePrompt ? `Objective prompt: ${truncateBlock(report.inputs.objectivePrompt, Math.min(contextChars, compact ? 320 : 520))}` : undefined,
    report.inputs.taskPrompt ? `Focused task prompt: ${truncateBlock(report.inputs.taskPrompt, Math.min(contextChars, compact ? 320 : 520))}` : undefined,
    report.inputs.checks && report.inputs.checks.length > 0 ? `Checks: ${report.inputs.checks.join(", ")}` : "Checks: none",
    report.packetContext?.contractCriteria.length ? `Contract criteria: ${report.packetContext.contractCriteria.length}` : undefined,
    ...((report.packetContext?.contractCriteria.slice(0, compact ? 3 : 6).map((item) => `- ${item}`)) ?? []),
    report.packetContext?.requiredChecks.length ? `Contract checks: ${report.packetContext.requiredChecks.join(", ")}` : undefined,
    report.packetContext?.proofExpectation ? `Proof expectation: ${report.packetContext.proofExpectation}` : undefined,
    report.packetContext?.alignmentVerdict ? `Worker alignment verdict: ${report.packetContext.alignmentVerdict}` : undefined,
    report.packetContext?.alignmentMissing.length ? `Alignment missing: ${report.packetContext.alignmentMissing.join(" | ")}` : undefined,
    report.packetContext?.alignmentOutOfScope.length ? `Alignment out of scope: ${report.packetContext.alignmentOutOfScope.join(" | ")}` : undefined,
    report.packetContext?.alignmentRationale ? `Alignment rationale: ${truncateInline(report.packetContext.alignmentRationale, compact ? 180 : 260)}` : undefined,
    report.packetContext?.profileSkills.length ? `Profile skills: ${report.packetContext.profileSkills.join(", ")}` : undefined,
    report.packetContext?.selectedHelpers.length ? `Selected helpers: ${report.packetContext.selectedHelpers.join(" | ")}` : undefined,
    !compact && report.packetContext?.overview ? `Packet overview: ${truncateInline(report.packetContext.overview, 260)}` : undefined,
    !compact && report.packetContext?.objectiveMemory ? `Objective memory: ${truncateInline(report.packetContext.objectiveMemory, 260)}` : undefined,
    !compact && report.packetContext?.integrationMemory ? `Integration memory: ${truncateInline(report.packetContext.integrationMemory, 260)}` : undefined,
    contextExcerpt ? "Context summary excerpt:" : undefined,
    contextExcerpt,
    report.packetContext?.summaryPath ? `Context summary path: ${report.packetContext.summaryPath}` : undefined,
    report.packetContext?.manifestPath ? `Manifest path: ${report.packetContext.manifestPath}` : undefined,
    report.packetContext?.contextPackPath ? `Context pack path: ${report.packetContext.contextPackPath}` : undefined,
    report.packetContext?.resultPath ? `Result path: ${report.packetContext.resultPath}` : undefined,
    report.packetContext?.lastMessagePath ? `Last message path: ${report.packetContext.lastMessagePath}` : undefined,
    !compact && report.packetContext?.candidateLineage.length ? "Candidate lineage:" : undefined,
    ...(!compact ? (report.packetContext?.candidateLineage.slice(0, 8).map((item) => `- ${item}`) ?? []) : []),
    !compact && report.packetContext?.recentReceipts.length ? "Recent worker receipts:" : undefined,
    ...(!compact ? (report.packetContext?.recentReceipts.slice(0, 8).map((item) => `- ${item}`) ?? []) : []),
    "",
    "## DAG Flow",
    report.dag.lines.length > 0 ? undefined : "- No task DAG was available.",
    ...report.dag.lines,
    report.dag.edges.length > 0 ? "Edges:" : undefined,
    ...(report.dag.edges.length > 0 ? report.dag.edges.map((edge) => `- ${edge}`) : []),
    "",
    "## Tasks",
    ...taskLines,
    "",
    "## Candidates",
    ...candidateLines,
    "",
    "## Jobs",
    ...jobLines,
    ...(!compact ? [
      "",
      "## Agent Runs",
      ...(report.agentRuns.length > 0
        ? report.agentRuns.map((run) =>
            `- ${run.runId} [${run.status}] iter=${run.iterations} tools=${run.toolCalls} errors=${run.toolErrors}${run.finalResponsePreview ? ` :: ${truncateInline(run.finalResponsePreview, 140)}` : ""}`)
        : ["- none"]),
    ] : []),
    "",
    "## Anomalies",
    ...(report.anomalies.length > 0
      ? report.anomalies.map((anomaly) =>
          `- [${anomaly.severity}] ${anomaly.summary}${anomaly.at ? ` · ${formatTimestamp(anomaly.at)}` : ""}`)
      : ["- none"]),
    "",
    "## Recommendations",
    report.audit?.generatedAt ? `Audit snapshot: ${formatTimestamp(report.audit.generatedAt)}` : undefined,
    report.audit?.stale ? "- Snapshot is stale relative to the latest objective state." : undefined,
    report.audit?.recommendationStatus === "failed"
      ? `- Recommendation generation failed: ${report.audit.recommendationError ?? "unknown error"}`
      : undefined,
    ...(report.recommendations.length > 0
      ? report.recommendations.map((item) =>
          `- [${item.confidence}] ${item.summary} · scope=${item.scope}${item.anomalyPatterns.length > 0 ? ` · patterns=${item.anomalyPatterns.join(",")}` : ""}`)
      : ["- none"]),
    ...(report.autoFixObjectiveId
      ? [
          "",
          "## Auto-fix",
          `- Triggered: ${report.autoFixObjectiveId}`,
        ]
      : []),
    "",
    `## Timeline (first ${Math.min(timelineLimit, report.timeline.length)} of ${report.timeline.length})`,
    ...(report.timeline.length > 0
      ? report.timeline.slice(0, timelineLimit).map((item) =>
          `- ${formatTimestamp(item.at)} [${item.source}] ${item.summary}`)
      : ["- none"]),
    ...(report.warnings.length > 0
      ? [
          "",
          "## Warnings",
          ...report.warnings.map((warning) => `- ${warning}`),
        ]
      : []),
  ].filter((line): line is string => line !== undefined);

  return lines.join("\n");
};
