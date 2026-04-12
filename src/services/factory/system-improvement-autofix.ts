import { createHash } from "node:crypto";

import type { FactoryService } from "../factory-service";
import type {
  FactoryObjectiveInput,
  FactorySystemImprovementRecommendation,
  FactorySystemImprovementReport,
} from "../factory-types";

const SYSTEM_AUTO_FIX_KEY_PREFIX = "factory_system_auto_fix_key:";
export const SYSTEM_IMPROVEMENT_AUTOFIX_PROFILE_ID = "software";

const normalizeSystemPattern = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "other";
};

const isOpenObjectiveStatus = (status: string): boolean =>
  status !== "completed" && status !== "failed" && status !== "canceled";

export const systemAutoFixRecommendationKey = (
  recommendation: FactorySystemImprovementRecommendation,
): string =>
  createHash("sha1")
    .update(
      JSON.stringify({
        summary: recommendation.summary.trim().toLowerCase().replace(/\s+/g, " "),
        scope: recommendation.scope.trim().toLowerCase().replace(/\s+/g, " "),
        anomalyPatterns: [
          ...new Set(
            recommendation.anomalyPatterns.map(normalizeSystemPattern).filter(Boolean),
          ),
        ].sort(),
        metrics: recommendation.successMetrics.map((metric) => ({
          label: metric.label,
          baseline: metric.baseline,
          target: metric.target,
          severity: metric.severity,
        })),
      }),
    )
    .digest("hex")
    .slice(0, 16);

export const systemAutoFixPromptMarker = (key: string): string =>
  `${SYSTEM_AUTO_FIX_KEY_PREFIX}${key}`;

export const shouldCreateSystemAutoFixObjective = (
  recommendation: FactorySystemImprovementRecommendation | undefined,
): recommendation is FactorySystemImprovementRecommendation => Boolean(
  recommendation
  && recommendation.confidence === "high"
  && recommendation.anomalyPatterns.length > 0
  && recommendation.successMetrics.some((metric) => metric.severity === "hard_defect"),
);

export const findExistingSystemAutoFixObjective = async (
  factoryService: FactoryService,
  recommendation: FactorySystemImprovementRecommendation,
): Promise<string | undefined> => {
  const marker = systemAutoFixPromptMarker(
    systemAutoFixRecommendationKey(recommendation),
  );
  const activeObjectives = (await factoryService.listObjectives()).filter(
    (objective) => isOpenObjectiveStatus(objective.status),
  );
  for (const objective of activeObjectives) {
    const state = await factoryService.getObjectiveState(objective.objectiveId).catch(() => undefined);
    if (
      !state
      || state.archivedAt
      || state.channel !== "auto-fix"
      || !isOpenObjectiveStatus(state.status)
    ) {
      continue;
    }
    if (state.prompt.includes(marker)) return state.objectiveId;
  }
  return undefined;
};

export const buildSystemAutoFixObjectiveInput = (input: {
  readonly recommendation: FactorySystemImprovementRecommendation;
  readonly audit: FactorySystemImprovementReport["auditSummary"];
  readonly dst: FactorySystemImprovementReport["dstSummary"];
  readonly context: FactorySystemImprovementReport["contextSummary"];
  readonly triggerLabel: string;
}): FactoryObjectiveInput => {
  const key = systemAutoFixRecommendationKey(input.recommendation);
  return {
    title: input.recommendation.summary.slice(0, 96),
    objectiveMode: "delivery",
    severity: 1,
    channel: "auto-fix",
    profileId: SYSTEM_IMPROVEMENT_AUTOFIX_PROFILE_ID,
    startImmediately: true,
    prompt: [
      input.triggerLabel,
      "",
      "## Recommendation",
      input.recommendation.suggestedFix,
      "",
      "## Scope",
      input.recommendation.scope,
      "",
      "## Recurring Patterns",
      ...(input.recommendation.anomalyPatterns.length > 0
        ? input.recommendation.anomalyPatterns.map((pattern) => `- ${pattern}`)
        : ["- none"]),
      "",
      "## Baseline Metrics",
      `- Weak objectives in audit window: ${input.audit.weakObjectives}/${input.audit.objectivesAudited}`,
      `- Base DST failures: integrity=${input.dst.integrityFailures} replay=${input.dst.replayFailures} deterministic=${input.dst.deterministicFailures}`,
      `- Context DST hard failures: ${input.context.hardFailureCount}`,
      `- Context DST compatibility warnings: ${input.context.compatibilityWarningCount}`,
      "",
      "## Success Metrics",
      ...input.recommendation.successMetrics.flatMap((metric) => [
        `- ${metric.label} [${metric.severity}]`,
        `  baseline: ${metric.baseline}`,
        `  target: ${metric.target}`,
        ...metric.verification.map((command) => `  verify: ${command}`),
      ]),
      "",
      "## Acceptance Checks",
      ...(input.recommendation.acceptanceChecks.length > 0
        ? input.recommendation.acceptanceChecks.map((check) => `- ${check}`)
        : ["- bun src/cli.ts factory audit --limit 12 --json", "- bun src/cli.ts dst --json", "- bun src/cli.ts dst --context --json"]),
      "",
      "## Auto-fix Deduplication",
      systemAutoFixPromptMarker(key),
    ].join("\n"),
  };
};
