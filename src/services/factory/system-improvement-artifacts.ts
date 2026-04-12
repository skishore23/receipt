import fs from "node:fs/promises";
import path from "node:path";

import type {
  FactorySystemImprovementMetric,
  FactorySystemImprovementRecommendation,
  FactorySystemImprovementReport,
} from "../factory-types";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asArray = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : [];

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const asStringArray = (value: unknown): ReadonlyArray<string> =>
  asArray(value)
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item));

const asCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;

const asConfidence = (
  value: unknown,
): FactorySystemImprovementRecommendation["confidence"] | undefined =>
  value === "low" || value === "medium" || value === "high"
    ? value
    : undefined;

const asSeverity = (
  value: unknown,
): FactorySystemImprovementMetric["severity"] | undefined =>
  value === "warning" || value === "hard_defect"
    ? value
    : undefined;

const parseMetric = (
  value: unknown,
): FactorySystemImprovementMetric | undefined => {
  const record = asRecord(value);
  const label = asString(record?.label);
  const baseline = asString(record?.baseline);
  const target = asString(record?.target);
  const severity = asSeverity(record?.severity);
  if (!label || !baseline || !target || !severity) return undefined;
  return {
    label,
    baseline,
    target,
    severity,
    verification: asStringArray(record?.verification),
  };
};

const parseRecommendation = (
  value: unknown,
): FactorySystemImprovementRecommendation | undefined => {
  const record = asRecord(value);
  const summary = asString(record?.summary);
  const scope = asString(record?.scope);
  const confidence = asConfidence(record?.confidence);
  const suggestedFix = asString(record?.suggestedFix);
  if (!summary || !scope || !confidence || !suggestedFix) return undefined;
  return {
    summary,
    scope,
    confidence,
    suggestedFix,
    anomalyPatterns: asStringArray(record?.anomalyPatterns),
    successMetrics: asArray(record?.successMetrics)
      .map((item) => parseMetric(item))
      .filter((item): item is FactorySystemImprovementMetric => Boolean(item)),
    acceptanceChecks: asStringArray(record?.acceptanceChecks),
  };
};

export const systemImprovementArtifactPaths = (
  dataDir: string,
): {
  readonly root: string;
  readonly jsonPath: string;
  readonly textPath: string;
} => {
  const root = path.join(dataDir, "factory", "artifacts", "repo");
  return {
    root,
    jsonPath: path.join(root, "system-improvement.json"),
    textPath: path.join(root, "system-improvement.md"),
  };
};

export const readPersistedSystemImprovementReport = async (
  dataDir: string,
): Promise<FactorySystemImprovementReport | undefined> => {
  try {
    const artifact = systemImprovementArtifactPaths(dataDir);
    const raw = await fs.readFile(artifact.jsonPath, "utf-8");
    const parsed = asRecord(JSON.parse(raw));
    const generatedAt = asCount(parsed?.generatedAt);
    const healthStatus = parsed?.healthStatus;
    if (
      !generatedAt
      || (healthStatus !== "healthy" && healthStatus !== "watch" && healthStatus !== "action_needed")
    ) {
      return undefined;
    }
    const auditSummary = asRecord(parsed?.auditSummary);
    const dstSummary = asRecord(parsed?.dstSummary);
    const contextSummary = asRecord(parsed?.contextSummary);
    if (!auditSummary || !dstSummary || !contextSummary) return undefined;
    const recommendations = asArray(parsed?.recommendations)
      .map((item) => parseRecommendation(item))
      .filter((item): item is FactorySystemImprovementRecommendation => Boolean(item));
    const selectedRecommendation = parseRecommendation(parsed?.selectedRecommendation);
    return {
      generatedAt,
      healthStatus,
      auditSummary: {
        objectivesAudited: asCount(auditSummary.objectivesAudited) ?? 0,
        weakObjectives: asCount(auditSummary.weakObjectives) ?? 0,
        strongObjectives: asCount(auditSummary.strongObjectives) ?? 0,
        topAnomalies: asArray(auditSummary.topAnomalies)
          .map((item) => {
            const record = asRecord(item);
            const category = asString(record?.category);
            const count = asCount(record?.count);
            return category && count !== undefined ? { category, count } : undefined;
          })
          .filter((item): item is { readonly category: string; readonly count: number } => Boolean(item)),
      },
      dstSummary: {
        streamCount: asCount(dstSummary.streamCount) ?? 0,
        integrityFailures: asCount(dstSummary.integrityFailures) ?? 0,
        replayFailures: asCount(dstSummary.replayFailures) ?? 0,
        deterministicFailures: asCount(dstSummary.deterministicFailures) ?? 0,
      },
      contextSummary: {
        runCount: asCount(contextSummary.runCount) ?? 0,
        hardFailureCount: asCount(contextSummary.hardFailureCount) ?? 0,
        compatibilityWarningCount: asCount(contextSummary.compatibilityWarningCount) ?? 0,
        replayFailures: asCount(contextSummary.replayFailures) ?? 0,
        deterministicFailures: asCount(contextSummary.deterministicFailures) ?? 0,
      },
      recommendations,
      selectedRecommendation: selectedRecommendation ?? recommendations[0],
      autoFixObjectiveId: asString(parsed?.autoFixObjectiveId),
    };
  } catch {
    return undefined;
  }
};
