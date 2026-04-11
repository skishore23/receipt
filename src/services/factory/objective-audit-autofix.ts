import { createHash } from "node:crypto";

import type { AuditRecommendation } from "../../factory-cli/analyze";
import type { FactoryService } from "../factory-service";
import type { FactoryObjectiveInput } from "../factory-types";

const AUTO_FIX_KEY_PREFIX = "factory_auto_fix_key:";

const normalizeAuditPattern = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "other";
};

const isOpenObjectiveStatus = (status: string): boolean =>
  status !== "completed" && status !== "failed" && status !== "canceled";

export const autoFixRecommendationKey = (
  recommendation: AuditRecommendation,
): string =>
  createHash("sha1")
    .update(
      JSON.stringify({
        summary: recommendation.summary
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " "),
        scope: recommendation.scope.trim().toLowerCase().replace(/\s+/g, " "),
        anomalyPatterns: [
          ...new Set(
            recommendation.anomalyPatterns
              .map(normalizeAuditPattern)
              .filter(Boolean),
          ),
        ].sort(),
      }),
    )
    .digest("hex")
    .slice(0, 16);

export const autoFixPromptMarker = (key: string): string =>
  `${AUTO_FIX_KEY_PREFIX}${key}`;

export const findExistingAutoFixObjective = async (
  factoryService: FactoryService,
  recommendation: AuditRecommendation,
): Promise<string | undefined> => {
  const key = autoFixRecommendationKey(recommendation);
  const activeObjectives = (await factoryService.listObjectives()).filter(
    (objective) => isOpenObjectiveStatus(objective.status),
  );
  for (const objective of activeObjectives) {
    const state = await factoryService
      .getObjectiveState(objective.objectiveId)
      .catch(() => undefined);
    if (
      !state ||
      state.archivedAt ||
      state.channel !== "auto-fix" ||
      !isOpenObjectiveStatus(state.status)
    ) {
      continue;
    }
    if (state.prompt.includes(autoFixPromptMarker(key))) {
      return state.objectiveId;
    }
  }
  return undefined;
};

export const buildAutoFixObjectiveInput = (input: {
  readonly recommendation: AuditRecommendation;
  readonly sourceObjectiveId?: string;
  readonly profileId?: string;
  readonly patternCounts?: ReadonlyMap<string, number>;
  readonly triggerLabel: string;
}): FactoryObjectiveInput => {
  const normalizedPatterns = input.recommendation.anomalyPatterns
    .map(normalizeAuditPattern)
    .filter(Boolean);
  const dedupedPatterns = [...new Set(normalizedPatterns)];
  const autoFixKey = autoFixRecommendationKey(input.recommendation);
  return {
    title: input.recommendation.summary.slice(0, 96),
    prompt: [
      input.triggerLabel,
      ...(input.sourceObjectiveId
        ? ["", "## Source Objective", input.sourceObjectiveId]
        : []),
      "",
      "## Recommendation",
      input.recommendation.suggestedFix,
      "",
      "## Scope",
      input.recommendation.scope,
      "",
      `## Recurring Patterns (${dedupedPatterns.join(", ")})`,
      ...dedupedPatterns.map(
        (pattern) =>
          `- ${pattern}: ${input.patternCounts?.get(pattern) ?? 0} occurrence(s)`,
      ),
      "",
      "## Audit Deduplication",
      autoFixPromptMarker(autoFixKey),
    ].join("\n"),
    objectiveMode: "delivery",
    severity: 1,
    channel: "auto-fix",
    profileId: input.profileId,
    startImmediately: true,
  };
};
