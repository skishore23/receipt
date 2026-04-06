import fs from "node:fs/promises";
import path from "node:path";

import type { AuditRecommendation } from "../../factory-cli/analyze";

export type FactoryObjectiveAuditMetadata = {
  readonly generatedAt: number;
  readonly objectiveUpdatedAt?: number;
  readonly recommendationStatus: "ready" | "failed";
  readonly recommendationError?: string;
  readonly recommendations: ReadonlyArray<AuditRecommendation>;
  readonly autoFixObjectiveId?: string;
  readonly recurringPatterns: ReadonlyArray<{
    readonly pattern: string;
    readonly count: number;
  }>;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asArray = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : [];

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asStringArray = (value: unknown): ReadonlyArray<string> =>
  asArray(value)
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item));

const asConfidence = (value: unknown): AuditRecommendation["confidence"] =>
  value === "low" || value === "medium" || value === "high"
    ? value
    : "medium";

const asRecommendationStatus = (value: unknown): FactoryObjectiveAuditMetadata["recommendationStatus"] | undefined =>
  value === "ready" || value === "failed"
    ? value
    : undefined;

const parseRecommendation = (value: unknown): AuditRecommendation | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const summary = asString(record.summary);
  const suggestedFix = asString(record.suggestedFix);
  if (!summary || !suggestedFix) return undefined;
  return {
    summary,
    anomalyPatterns: asStringArray(record.anomalyPatterns),
    scope: asString(record.scope) ?? "unknown",
    confidence: asConfidence(record.confidence),
    suggestedFix,
  };
};

export const objectiveAuditArtifactPaths = (dataDir: string, objectiveId: string): {
  readonly root: string;
  readonly jsonPath: string;
  readonly textPath: string;
} => {
  const root = path.join(dataDir, "factory", "artifacts", objectiveId);
  return {
    root,
    jsonPath: path.join(root, "objective.audit.json"),
    textPath: path.join(root, "objective.audit.md"),
  };
};

export const readPersistedObjectiveAuditMetadata = async (
  dataDir: string,
  objectiveId: string,
): Promise<FactoryObjectiveAuditMetadata | undefined> => {
  try {
    const artifact = objectiveAuditArtifactPaths(dataDir, objectiveId);
    const raw = await fs.readFile(artifact.jsonPath, "utf-8");
    const parsed = asRecord(JSON.parse(raw));
    const audit = asRecord(parsed?.audit);
    if (!audit) return undefined;
    const generatedAt =
      typeof audit.generatedAt === "number" && Number.isFinite(audit.generatedAt) && audit.generatedAt > 0
        ? audit.generatedAt
        : undefined;
    const recommendationStatus = asRecommendationStatus(audit.recommendationStatus);
    if (!generatedAt || !recommendationStatus) return undefined;
    const objectiveUpdatedAt =
      typeof audit.objectiveUpdatedAt === "number" && Number.isFinite(audit.objectiveUpdatedAt)
        ? audit.objectiveUpdatedAt
        : undefined;
    return {
      generatedAt,
      objectiveUpdatedAt,
      recommendationStatus,
      recommendationError: asString(audit.recommendationError),
      recommendations: asArray(audit.recommendations)
        .map((item) => parseRecommendation(item))
        .filter((item): item is AuditRecommendation => Boolean(item)),
      autoFixObjectiveId: asString(audit.autoFixObjectiveId),
      recurringPatterns: asArray(audit.recurringPatterns)
        .map((item) => {
          const record = asRecord(item);
          const pattern = asString(record?.pattern);
          const count =
            typeof record?.count === "number" && Number.isFinite(record.count)
              ? Math.max(0, Math.floor(record.count))
              : undefined;
          return pattern && count !== undefined ? { pattern, count } : undefined;
        })
        .filter((item): item is NonNullable<FactoryObjectiveAuditMetadata["recurringPatterns"][number]> => Boolean(item)),
    };
  } catch {
    return undefined;
  }
};
