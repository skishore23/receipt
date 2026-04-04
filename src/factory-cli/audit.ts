import { getReceiptDb } from "../db/client";
import {
  readFactoryReceiptInvestigation,
  type FactoryReceiptInvestigation,
} from "./investigate";
import type { AuditRecommendation } from "./analyze";

type AuditObjectiveSample = {
  readonly objectiveId: string;
  readonly title?: string;
  readonly status?: string;
  readonly verdict: FactoryReceiptInvestigation["assessment"]["verdict"];
  readonly easyRouteRisk: FactoryReceiptInvestigation["assessment"]["easyRouteRisk"];
  readonly efficiency: FactoryReceiptInvestigation["assessment"]["efficiency"];
  readonly controlChurn: FactoryReceiptInvestigation["assessment"]["controlChurn"];
  readonly alignmentVerdict: FactoryReceiptInvestigation["assessment"]["alignmentVerdict"];
  readonly correctiveSteerIssued: boolean;
  readonly alignedAfterCorrection: boolean;
  readonly jobs: number;
  readonly tasks: number;
  readonly anomalies: number;
  readonly interventions: number;
  readonly restartCount: number;
  readonly courseCorrectionWorked: boolean;
  readonly recommendations: ReadonlyArray<AuditRecommendation>;
  readonly latestSummary?: string;
  readonly durationMs?: number;
};

type AuditMemoryHygiene = {
  readonly totalFactoryEntries: number;
  readonly repoSharedEntries: number;
  readonly repoSharedRunScopedEntries: number;
  readonly agentEntries: number;
  readonly agentRunScopedEntries: number;
  readonly objectiveEntries: number;
  readonly taskEntries: number;
  readonly taskEntriesWithHandoff: number;
  readonly candidateEntries: number;
  readonly candidateEntriesWithHandoff: number;
  readonly integrationEntries: number;
  readonly integrationEntriesWithHandoff: number;
  readonly publishEntries: number;
  readonly publishEntriesWithHandoff: number;
  readonly staleSharedExamples: ReadonlyArray<string>;
  readonly staleAgentExamples: ReadonlyArray<string>;
};

type AuditSummary = {
  readonly objectivesAudited: number;
  readonly sampledObjectiveIds: ReadonlyArray<string>;
  readonly statuses: Readonly<Record<string, number>>;
  readonly verdicts: Readonly<Record<string, number>>;
  readonly easyRouteRisk: Readonly<Record<string, number>>;
  readonly efficiency: Readonly<Record<string, number>>;
  readonly controlChurn: Readonly<Record<string, number>>;
  readonly avgJobsPerObjective: number;
  readonly avgTasksPerObjective: number;
  readonly avgDurationMs?: number;
};

type AuditAnomalyCategory = {
  readonly category: string;
  readonly count: number;
};

export type FactoryReceiptAuditReport = {
  readonly dataDir: string;
  readonly repoRoot: string;
  readonly limit: number;
  readonly targetedObjectiveId?: string;
  readonly summary: AuditSummary;
  readonly objectives: ReadonlyArray<AuditObjectiveSample>;
  readonly anomalyCategories: ReadonlyArray<AuditAnomalyCategory>;
  readonly memoryHygiene: AuditMemoryHygiene;
  readonly improvements: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
};

const asCountRecord = (values: ReadonlyArray<string | undefined>): Readonly<Record<string, number>> => {
  const next: Record<string, number> = {};
  for (const value of values) {
    const key = value?.trim();
    if (!key) continue;
    next[key] = (next[key] ?? 0) + 1;
  }
  return next;
};

const average = (values: ReadonlyArray<number | undefined>): number | undefined => {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (nums.length === 0) return undefined;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
};

const formatDurationMs = (durationMs: number | undefined): string => {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return "n/a";
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
};

const truncateInline = (value: string | undefined, max = 180): string | undefined => {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`;
};

const safeLimit = (limit: number): number =>
  Math.max(1, Math.min(Math.floor(limit), 200));

const USAGE_LIMIT_ANOMALY_RE = /\b(usage_limit_reached|too many requests|rate limit|quota(?: exceeded| exhausted)?|429)\b/i;

const recentObjectiveIds = (dataDir: string, limit: number): ReadonlyArray<string> => {
  const db = getReceiptDb(dataDir);
  const rows = db.sqlite.query(`
    SELECT name
    FROM streams
    WHERE name LIKE 'factory/objectives/%'
    ORDER BY updated_at DESC, last_ts DESC, name DESC
    LIMIT ${safeLimit(limit)}
  `).all() as Array<{ readonly name: string }>;
  return rows
    .map((row) => row.name.replace(/^factory\/objectives\//u, ""))
    .filter((value, index, values) => values.indexOf(value) === index);
};

const objectiveSnapshotTs = (dataDir: string, objectiveId: string): number | undefined => {
  const db = getReceiptDb(dataDir);
  const row = db.sqlite.query(`
    SELECT COALESCE(updated_at, last_ts) AS ts
    FROM streams
    WHERE name = ?
    LIMIT 1
  `).get(`factory/objectives/${objectiveId}`) as { readonly ts?: number } | undefined;
  const ts = Number(row?.ts);
  return Number.isFinite(ts) ? ts : undefined;
};

const categorizeAnomaly = (summary: string): string => {
  const normalized = summary.toLowerCase();
  if (USAGE_LIMIT_ANOMALY_RE.test(summary)) return "quota / rate limit";
  if (normalized.includes("lease expired")) return "lease expired";
  if (normalized.includes("database is locked")) return "database is locked";
  if (normalized.includes("iteration budget exhausted")) return "iteration budget exhausted";
  if (/workspace (branch|path) already exists/i.test(summary)) return "workspace collision";
  if (/human input|operator|clarification|approval|permission denied|access denied|unauthorized|forbidden/i.test(summary)) {
    return "human input or permission gate";
  }
  return truncateInline(summary, 80) ?? "other";
};

const countScalar = (dataDir: string, sql: string): number => {
  const db = getReceiptDb(dataDir);
  const row = db.sqlite.query(sql).get() as { readonly value?: number } | undefined;
  return Number(row?.value ?? 0);
};

const queryExamples = (dataDir: string, sql: string): ReadonlyArray<string> => {
  const db = getReceiptDb(dataDir);
  const rows = db.sqlite.query(sql).all() as Array<{ readonly value?: string }>;
  return rows.map((row) => row.value?.trim()).filter((value): value is string => Boolean(value));
};

const readMemoryHygiene = (dataDir: string): AuditMemoryHygiene => ({
  totalFactoryEntries: countScalar(dataDir, `SELECT COUNT(*) AS value FROM memory_entries WHERE scope LIKE 'factory/%'`),
  repoSharedEntries: countScalar(dataDir, `SELECT COUNT(*) AS value FROM memory_entries WHERE scope='factory/repo/shared'`),
  repoSharedRunScopedEntries: countScalar(dataDir, `SELECT COUNT(*) AS value FROM memory_entries WHERE scope='factory/repo/shared' AND text LIKE '[objective_%/%] %'`),
  agentEntries: countScalar(dataDir, `SELECT COUNT(*) AS value FROM memory_entries WHERE scope LIKE 'factory/agents/%'`),
  agentRunScopedEntries: countScalar(dataDir, `SELECT COUNT(*) AS value FROM memory_entries WHERE scope LIKE 'factory/agents/%' AND text LIKE '[objective_%/%] %'`),
  objectiveEntries: countScalar(dataDir, `SELECT COUNT(*) AS value FROM memory_entries WHERE scope LIKE 'factory/objectives/%' AND scope NOT LIKE '%/tasks/%' AND scope NOT LIKE '%/candidates/%' AND scope NOT LIKE '%/integration' AND scope NOT LIKE '%/publish'`),
  taskEntries: countScalar(dataDir, `SELECT COUNT(*) AS value FROM memory_entries WHERE scope LIKE 'factory/objectives/%/tasks/%'`),
  taskEntriesWithHandoff: countScalar(dataDir, `SELECT COUNT(*) AS value FROM memory_entries WHERE scope LIKE 'factory/objectives/%/tasks/%' AND (instr(text, 'Handoff\n') > 0 OR instr(text, 'Handoff\r\n') > 0)`),
  candidateEntries: countScalar(dataDir, `SELECT COUNT(*) AS value FROM memory_entries WHERE scope LIKE 'factory/objectives/%/candidates/%'`),
  candidateEntriesWithHandoff: countScalar(dataDir, `SELECT COUNT(*) AS value FROM memory_entries WHERE scope LIKE 'factory/objectives/%/candidates/%' AND (instr(text, 'Handoff\n') > 0 OR instr(text, 'Handoff\r\n') > 0)`),
  integrationEntries: countScalar(dataDir, `SELECT COUNT(*) AS value FROM memory_entries WHERE scope LIKE 'factory/objectives/%/integration'`),
  integrationEntriesWithHandoff: countScalar(dataDir, `SELECT COUNT(*) AS value FROM memory_entries WHERE scope LIKE 'factory/objectives/%/integration' AND (instr(text, 'Handoff\n') > 0 OR instr(text, 'Handoff\r\n') > 0)`),
  publishEntries: countScalar(dataDir, `SELECT COUNT(*) AS value FROM memory_entries WHERE scope LIKE 'factory/objectives/%/publish'`),
  publishEntriesWithHandoff: countScalar(dataDir, `SELECT COUNT(*) AS value FROM memory_entries WHERE scope LIKE 'factory/objectives/%/publish' AND (instr(text, 'Handoff\n') > 0 OR instr(text, 'Handoff\r\n') > 0)`),
  staleSharedExamples: queryExamples(dataDir, `
    SELECT substr(replace(text, char(10), ' | '), 1, 220) AS value
    FROM memory_entries
    WHERE scope='factory/repo/shared' AND text LIKE '[objective_%/%] %'
    ORDER BY ts DESC
    LIMIT 5
  `),
  staleAgentExamples: queryExamples(dataDir, `
    SELECT substr(replace(text, char(10), ' | '), 1, 220) AS value
    FROM memory_entries
    WHERE scope LIKE 'factory/agents/%' AND text LIKE '[objective_%/%] %'
    ORDER BY ts DESC
    LIMIT 5
  `),
});

const buildImprovements = (
  objectives: ReadonlyArray<AuditObjectiveSample>,
  anomalyCategories: ReadonlyArray<AuditAnomalyCategory>,
  memoryHygiene: AuditMemoryHygiene,
): ReadonlyArray<string> => {
  const verdicts = asCountRecord(objectives.map((objective) => objective.verdict));
  const improvements: string[] = [];

  if ((verdicts.weak ?? 0) > 0) {
    improvements.push(`${verdicts.weak}/${objectives.length} audited objective(s) landed in a weak verdict.`);
  }

  const topAnomaly = anomalyCategories[0];
  if (topAnomaly && topAnomaly.count > 0) {
    improvements.push(`Most common anomaly across the audit window: ${topAnomaly.category} (${topAnomaly.count}).`);
  }

  const allRecs = objectives.flatMap((o) => o.recommendations);
  const autoFixCount = allRecs.filter((r) => r.autoFix).length;
  if (autoFixCount > 0) {
    improvements.push(`${autoFixCount} auto-fix recommendation(s) from LLM audit analysis.`);
  }

  if (memoryHygiene.repoSharedRunScopedEntries > 0) {
    improvements.push(`Repo shared memory still contains ${memoryHygiene.repoSharedRunScopedEntries} run-specific entries.`);
  }
  if (memoryHygiene.agentRunScopedEntries > 0) {
    improvements.push(`Agent memory still contains ${memoryHygiene.agentRunScopedEntries} run-specific entries.`);
  }

  return [...new Set(improvements)];
};

export const readFactoryReceiptAudit = async (
  dataDir: string,
  repoRoot: string,
  limit = 12,
  objectiveId?: string,
): Promise<FactoryReceiptAuditReport> => {
  const targetedObjectiveId = objectiveId?.trim();
  const objectiveIds = targetedObjectiveId ? [targetedObjectiveId] : recentObjectiveIds(dataDir, limit);
  const warnings: string[] = [];
  const investigations = await Promise.all(objectiveIds.map(async (objectiveId) => {
    try {
      const asOfTs = objectiveSnapshotTs(dataDir, objectiveId);
      return await readFactoryReceiptInvestigation(
        dataDir,
        repoRoot,
        objectiveId,
        typeof asOfTs === "number" ? { asOfTs } : {},
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (targetedObjectiveId) {
        throw new Error(`Failed to audit objective ${targetedObjectiveId}: ${message}`);
      }
      warnings.push(`Failed to audit ${objectiveId}: ${message}`);
      return undefined;
    }
  }));
  const reports = investigations.filter((report): report is FactoryReceiptInvestigation => Boolean(report));
  const objectives = reports.map((report) => ({
    objectiveId: report.links.objectiveId ?? report.resolved.id,
    title: report.summary.title,
    status: report.summary.status,
    verdict: report.assessment.verdict,
    easyRouteRisk: report.assessment.easyRouteRisk,
    efficiency: report.assessment.efficiency,
    controlChurn: report.assessment.controlChurn,
    alignmentVerdict: report.assessment.alignmentVerdict,
    correctiveSteerIssued: report.assessment.correctiveSteerIssued,
    alignedAfterCorrection: report.assessment.alignedAfterCorrection,
    jobs: report.jobs.length,
    tasks: report.tasks.length,
    anomalies: report.anomalies.length,
    interventions: report.interventions.count,
    restartCount: report.interventions.restartCount,
    courseCorrectionWorked: report.interventions.courseCorrectionWorked,
    recommendations: report.recommendations,
    latestSummary: report.summary.text,
    durationMs: report.window.durationMs,
  } satisfies AuditObjectiveSample));

  const anomalyCounts = new Map<string, number>();
  for (const report of reports) {
    for (const anomaly of report.anomalies) {
      const category = categorizeAnomaly(anomaly.summary);
      anomalyCounts.set(category, (anomalyCounts.get(category) ?? 0) + 1);
    }
  }
  const anomalyCategories = [...anomalyCounts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category))
    .slice(0, 12);

  const memoryHygiene = readMemoryHygiene(dataDir);
  const summary: AuditSummary = {
    objectivesAudited: objectives.length,
    sampledObjectiveIds: objectives.map((objective) => objective.objectiveId),
    statuses: asCountRecord(objectives.map((objective) => objective.status)),
    verdicts: asCountRecord(objectives.map((objective) => objective.verdict)),
    easyRouteRisk: asCountRecord(objectives.map((objective) => objective.easyRouteRisk)),
    efficiency: asCountRecord(objectives.map((objective) => objective.efficiency)),
    controlChurn: asCountRecord(objectives.map((objective) => objective.controlChurn)),
    avgJobsPerObjective: average(objectives.map((objective) => objective.jobs)) ?? 0,
    avgTasksPerObjective: average(objectives.map((objective) => objective.tasks)) ?? 0,
    avgDurationMs: average(objectives.map((objective) => objective.durationMs)),
  };

  const improvements = buildImprovements(objectives, anomalyCategories, memoryHygiene);
  const rankedObjectives = [...objectives].sort((left, right) => {
    const score = (objective: AuditObjectiveSample): number => {
      let total = 0;
      if (objective.verdict === "weak") total += 6;
      else if (objective.verdict === "mixed") total += 3;
      if (objective.easyRouteRisk === "high") total += 4;
      else if (objective.easyRouteRisk === "medium") total += 2;
      if (objective.efficiency === "churn-heavy") total += 4;
      else if (objective.efficiency === "noisy") total += 2;
      if (objective.controlChurn === "high") total += 3;
      else if (objective.controlChurn === "medium") total += 1;
      total += Math.min(4, objective.anomalies);
      return total;
    };
    return score(right) - score(left)
      || right.jobs - left.jobs
      || (right.durationMs ?? 0) - (left.durationMs ?? 0)
      || left.objectiveId.localeCompare(right.objectiveId);
  });

  return {
    dataDir,
    repoRoot,
    limit: safeLimit(limit),
    ...(targetedObjectiveId ? { targetedObjectiveId } : {}),
    summary,
    objectives: rankedObjectives,
    anomalyCategories,
    memoryHygiene,
    improvements,
    warnings,
  };
};

const formatCounts = (counts: Readonly<Record<string, number>>): string =>
  Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ") || "none";

export const renderFactoryReceiptAuditText = (report: FactoryReceiptAuditReport): string => {
  const sampledLabel = report.targetedObjectiveId
    ? `Targeted objective: ${report.targetedObjectiveId}`
    : `Sampled objectives: ${report.summary.objectivesAudited} (limit ${report.limit})`;
  const lines = [
    "# Factory Receipt Audit",
    "",
    `Repo root: ${report.repoRoot}`,
    `Data dir: ${report.dataDir}`,
    sampledLabel,
    report.targetedObjectiveId ? `Objectives audited: ${report.summary.objectivesAudited}` : undefined,
    report.summary.avgDurationMs !== undefined ? `Average duration: ${formatDurationMs(report.summary.avgDurationMs)}` : undefined,
    `Average jobs/objective: ${report.summary.avgJobsPerObjective.toFixed(1)}`,
    `Average tasks/objective: ${report.summary.avgTasksPerObjective.toFixed(1)}`,
    "",
    "## Summary",
    `Statuses: ${formatCounts(report.summary.statuses)}`,
    `Verdicts: ${formatCounts(report.summary.verdicts)}`,
    `Easy route risk: ${formatCounts(report.summary.easyRouteRisk)}`,
    `Efficiency: ${formatCounts(report.summary.efficiency)}`,
    `Control churn: ${formatCounts(report.summary.controlChurn)}`,
    "",
    "## Improvement Signals",
    ...(report.improvements.length > 0
      ? report.improvements.map((item) => `- ${item}`)
      : ["- No repo-level improvement signals were derived from the sampled objectives."]),
    "",
    "## Top Anomalies",
    ...(report.anomalyCategories.length > 0
      ? report.anomalyCategories.map((item) => `- ${item.category}: ${item.count}`)
      : ["- none"]),
    "",
    "## Memory Hygiene",
    `- Factory memory entries: ${report.memoryHygiene.totalFactoryEntries}`,
    `- Repo shared entries: ${report.memoryHygiene.repoSharedEntries} (${report.memoryHygiene.repoSharedRunScopedEntries} run-specific)`,
    `- Agent entries: ${report.memoryHygiene.agentEntries} (${report.memoryHygiene.agentRunScopedEntries} run-specific)`,
    `- Objective entries: ${report.memoryHygiene.objectiveEntries}`,
    `- Task entries with handoff: ${report.memoryHygiene.taskEntriesWithHandoff}/${report.memoryHygiene.taskEntries}`,
    `- Candidate entries with handoff: ${report.memoryHygiene.candidateEntriesWithHandoff}/${report.memoryHygiene.candidateEntries}`,
    `- Integration entries with handoff: ${report.memoryHygiene.integrationEntriesWithHandoff}/${report.memoryHygiene.integrationEntries}`,
    `- Publish entries with handoff: ${report.memoryHygiene.publishEntriesWithHandoff}/${report.memoryHygiene.publishEntries}`,
    ...(report.memoryHygiene.staleSharedExamples.length > 0
      ? [
          "Stale repo-shared examples:",
          ...report.memoryHygiene.staleSharedExamples.map((item) => `- ${item}`),
        ]
      : []),
    ...(report.memoryHygiene.staleAgentExamples.length > 0
      ? [
          "Stale agent-memory examples:",
          ...report.memoryHygiene.staleAgentExamples.map((item) => `- ${item}`),
        ]
      : []),
    "",
    "## Objectives",
    ...(report.objectives.length > 0
      ? report.objectives.slice(0, 12).map((objective) => [
          `- ${objective.objectiveId} [${objective.status ?? "unknown"}] verdict=${objective.verdict} easy=${objective.easyRouteRisk} efficiency=${objective.efficiency} churn=${objective.controlChurn} jobs=${objective.jobs} tasks=${objective.tasks} anomalies=${objective.anomalies} interventions=${objective.interventions} restarts=${objective.restartCount} course_correction=${objective.courseCorrectionWorked ? "yes" : "no"}`,
          `  alignment: verdict=${objective.alignmentVerdict} corrective_steer=${objective.correctiveSteerIssued ? "yes" : "no"} aligned_after_correction=${objective.alignedAfterCorrection ? "yes" : "no"}`,
          objective.title ? `  title: ${objective.title}` : "",
          objective.latestSummary ? `  summary: ${truncateInline(objective.latestSummary, 180) ?? objective.latestSummary}` : "",
          objective.recommendations[0] ? `  recommendation: ${objective.recommendations[0].summary}` : "",
        ].filter(Boolean).join("\n"))
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
