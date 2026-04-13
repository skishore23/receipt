import type { AuditRecommendation } from "../../../factory-cli/analyze";
import type { FactoryObjectiveSelfImprovement } from "../../../services/factory-types";
import { badge, displayLabel, esc, formatTs, type Tone } from "../../ui";

const recommendationConfidenceTone = (
  confidence: AuditRecommendation["confidence"],
): "neutral" | "info" | "success" | "warning" => {
  switch (confidence) {
    case "high":
      return "success";
    case "medium":
      return "info";
    default:
      return "warning";
  }
};

const titleCaseLabel = (value?: string): string => {
  const label = displayLabel(value);
  return label ? label.replace(/\b\w/g, (match) => match.toUpperCase()) : "";
};

const autoFixTone = (status?: string): Tone => {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return "info";
  if (normalized === "completed") return "success";
  if (normalized === "failed" || normalized === "canceled") return "danger";
  if (normalized === "blocked") return "warning";
  return "info";
};

const autoFixStateLabel = (status?: string): string | undefined => {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "completed") return "Fix completed";
  if (normalized === "failed") return "Fix failed";
  if (normalized === "canceled") return "Fix canceled";
  if (normalized === "blocked") return "Fix needs review";
  return "Fix in progress";
};

const statusPresentation = (
  selfImprovement: FactoryObjectiveSelfImprovement,
  actionableRecommendations: ReadonlyArray<AuditRecommendation>,
): {
  readonly label: string;
  readonly tone: Tone;
} => {
  if (selfImprovement.auditStatus === "failed") return { label: "Audit failed", tone: "danger" };
  if (selfImprovement.auditStatus === "running") return { label: "Audit running", tone: "info" };
  if (selfImprovement.auditStatus === "pending") return { label: "Audit queued", tone: "warning" };
  if (selfImprovement.auditStatus === "missing") return { label: "Audit missing", tone: "warning" };
  const linkedLabel = autoFixStateLabel(selfImprovement.autoFixObjectiveStatus);
  if (linkedLabel) return { label: linkedLabel, tone: autoFixTone(selfImprovement.autoFixObjectiveStatus) };
  if (selfImprovement.autoFixObjectiveId) return { label: "Auto-fix linked", tone: "info" };
  if (selfImprovement.stale) return { label: "Audit stale", tone: "warning" };
  if (selfImprovement.recommendationStatus === "failed") return { label: "Recommendations unavailable", tone: "warning" };
  if (actionableRecommendations.length > 0) return { label: "Recommendations ready", tone: "success" };
  return { label: "Audit recorded", tone: "neutral" };
};

const emptyRecommendationMessage = (
  selfImprovement: FactoryObjectiveSelfImprovement,
): string => {
  if (selfImprovement.recommendationStatus === "failed") {
    return selfImprovement.recommendationError
      ? `Recommendation generation failed: ${selfImprovement.recommendationError}`
      : "Audit completed, but recommendation generation failed.";
  }
  if (selfImprovement.stale) {
    if (selfImprovement.autoFixObjectiveStatus === "completed") {
      return "The linked auto-fix completed. Older recommendation text is hidden because the audit snapshot is stale.";
    }
    if (selfImprovement.autoFixObjectiveId) {
      const statusLabel = titleCaseLabel(selfImprovement.autoFixObjectiveStatus) || "linked";
      return `The linked auto-fix is ${statusLabel.toLowerCase()}. Older recommendation text is hidden because the audit snapshot is stale.`;
    }
    return "Latest audit snapshot predates the current objective state, so older recommendation text is hidden.";
  }
  if (selfImprovement.auditStatus === "pending" || selfImprovement.auditStatus === "running") {
    return "Audit has not produced a fresh recommendation snapshot yet.";
  }
  if (selfImprovement.auditStatus === "missing") {
    return "No fresh audit snapshot is available for this objective yet.";
  }
  if (selfImprovement.autoFixObjectiveStatus === "completed") {
    return "The linked auto-fix objective completed and no fresh recommendation is currently actionable.";
  }
  if (selfImprovement.autoFixObjectiveId) {
    return "A linked auto-fix objective already exists for this recommendation.";
  }
  return "Latest audit captured no actionable self-improvement to promote.";
};

export const renderObjectiveSelfImprovementSnapshot = (input: {
  readonly objectiveId: string;
  readonly selfImprovement?: FactoryObjectiveSelfImprovement;
  readonly compact?: boolean;
  readonly actionButtonClass: string;
  readonly buildObjectiveHref: (objectiveId: string, profileId?: string) => string;
  readonly buildApplyAction: (objectiveId: string) => string;
}): string => {
  const selfImprovement = input.selfImprovement;
  if (!selfImprovement) return "";
  const compact = input.compact ?? false;
  const actionableRecommendations = selfImprovement.stale ? [] : selfImprovement.recommendations;
  const recommendations = actionableRecommendations.slice(0, compact ? 1 : 3);
  const hiddenRecommendationCount = Math.max(0, actionableRecommendations.length - recommendations.length);
  const recurringPatterns = selfImprovement.recurringPatterns.slice(0, compact ? 2 : 4);
  const canApplyRecommendations = !compact
    && selfImprovement.recommendationStatus === "ready"
    && !selfImprovement.stale
    && !selfImprovement.autoFixObjectiveId;
  const status = statusPresentation(selfImprovement, actionableRecommendations);
  const meta = [
    selfImprovement.auditedAt ? `Audited ${formatTs(selfImprovement.auditedAt)}` : undefined,
    selfImprovement.stale ? "snapshot stale" : undefined,
    `${actionableRecommendations.length} actionable recommendation${actionableRecommendations.length === 1 ? "" : "s"}`,
  ].filter((value): value is string => Boolean(value)).join(" · ");
  const autoFixHref = selfImprovement.autoFixObjectiveId
    ? input.buildObjectiveHref(selfImprovement.autoFixObjectiveId, selfImprovement.autoFixObjectiveProfileId)
    : undefined;
  return `<section class="border border-border bg-muted/25 px-4 py-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Self Improvement</div>
      ${badge(status.label, status.tone)}
    </div>
    ${meta ? `<div class="mt-2 text-xs leading-5 text-muted-foreground">${esc(meta)}</div>` : ""}
    ${selfImprovement.auditStatusMessage ? `<div class="mt-3 border border-border bg-background px-3 py-2 text-sm leading-6 text-muted-foreground">${esc(selfImprovement.auditStatusMessage)}</div>` : ""}
    ${recommendations.length > 0 ? `<div class="mt-3 space-y-2">
      ${recommendations.map((recommendation, index) => `<div class="border border-border bg-background px-3 py-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold leading-6 text-foreground">${esc(recommendation.summary)}</div>
            <div class="mt-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">${esc(recommendation.scope)}</div>
          </div>
          ${badge(displayLabel(recommendation.confidence) ?? recommendation.confidence, recommendationConfidenceTone(recommendation.confidence))}
        </div>
        ${compact ? "" : `<div class="mt-2 text-sm leading-6 text-muted-foreground">${esc(recommendation.suggestedFix)}</div>`}
        ${recommendation.anomalyPatterns.length > 0 ? `<div class="mt-2 flex flex-wrap gap-2">
          ${recommendation.anomalyPatterns.slice(0, compact ? 2 : 4).map((pattern) => `<span class="inline-flex items-center border border-border bg-muted/25 px-2 py-1 text-[11px] text-muted-foreground">${esc(pattern)}</span>`).join("")}
        </div>` : ""}
        ${canApplyRecommendations ? `<form class="mt-3" data-factory-inline-submit="true" data-factory-inline-pending-label="Applying..." data-factory-inline-pending-status="Applying self-improvement recommendation..." action="${esc(input.buildApplyAction(input.objectiveId))}" method="post">
          <input type="hidden" name="recommendationIndex" value="${esc(String(index))}" />
          <button type="submit" class="${input.actionButtonClass}">Apply</button>
          <div data-factory-inline-status="true" class="mt-2 hidden border border-border bg-muted px-3 py-2 text-xs leading-5 text-card-foreground" aria-live="polite"></div>
        </form>` : ""}
      </div>`).join("")}
    </div>` : `<div class="mt-3 text-sm leading-6 text-muted-foreground">${esc(emptyRecommendationMessage(selfImprovement))}</div>`}
    ${hiddenRecommendationCount > 0 ? `<div class="mt-2 text-xs leading-5 text-muted-foreground">+${esc(String(hiddenRecommendationCount))} more recommendation${hiddenRecommendationCount === 1 ? "" : "s"} in the latest audit.</div>` : ""}
    ${recurringPatterns.length > 0 ? `<div class="mt-3 flex flex-wrap gap-2">
      ${recurringPatterns.map((pattern) => `<span class="inline-flex items-center border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground">${esc(`${pattern.pattern} ×${pattern.count}`)}</span>`).join("")}
    </div>` : ""}
    ${selfImprovement.autoFixObjectiveId ? `<div class="mt-3 border border-info/20 bg-info/10 px-3 py-2 text-sm leading-6 text-foreground">
      Auto-fix objective:
      ${autoFixHref
        ? `<a href="${esc(autoFixHref)}" data-factory-href="${esc(autoFixHref)}" class="font-semibold text-primary underline-offset-2 hover:underline">${esc(selfImprovement.autoFixObjectiveId)}</a>`
        : `<span class="font-semibold">${esc(selfImprovement.autoFixObjectiveId)}</span>`}
      ${selfImprovement.autoFixObjectiveStatus ? `<span class="ml-2 inline-flex align-middle">${badge(titleCaseLabel(selfImprovement.autoFixObjectiveStatus) || selfImprovement.autoFixObjectiveStatus, autoFixTone(selfImprovement.autoFixObjectiveStatus))}</span>` : ""}
    </div>` : ""}
  </section>`;
};
