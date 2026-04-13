import type { QueueJob } from "../../../adapters/sqlite-queue";
import type { StoredObjectiveProjectionSummary } from "../../../db/projectors";
import type { FactoryObjectiveAuditMetadata } from "../objective-audit-artifacts";
import type { FactoryObjectiveDetail } from "../../factory-types";
import type { FactoryObjectiveMode, FactoryObjectiveStatus, FactoryState } from "../../../modules/factory";
import { isTerminalObjectiveStatus } from "./objective-lifecycle";

export const isAuditEligibleObjectiveStatus = (status: FactoryObjectiveStatus): boolean =>
  isTerminalObjectiveStatus(status) || status === "blocked";

export const buildObjectiveSelfImprovement = (
  state: FactoryState,
  auditMetadata: FactoryObjectiveAuditMetadata | undefined,
  auditJob: QueueJob | undefined,
  autoFixObjectiveState?: Pick<FactoryState, "objectiveId" | "status" | "profile">,
): FactoryObjectiveDetail["selfImprovement"] => {
  const hasAuditSnapshot = Boolean(auditMetadata);
  const auditEligible = isAuditEligibleObjectiveStatus(state.status);
  const stale = typeof auditMetadata?.objectiveUpdatedAt === "number"
    ? auditMetadata.objectiveUpdatedAt < state.updatedAt
    : false;
  const activeAuditStatus = auditJob?.status === "queued"
    ? "pending"
    : auditJob?.status === "leased" || auditJob?.status === "running"
      ? "running"
      : undefined;
  const auditStatus = activeAuditStatus
    ?? (auditJob?.status === "failed"
      ? "failed"
      : hasAuditSnapshot && !stale
        ? "ready"
        : auditEligible || hasAuditSnapshot || Boolean(auditJob)
          ? "missing"
          : undefined);
  if (!auditStatus) return undefined;
  const auditStatusMessage = auditStatus === "pending"
    ? "Objective audit is queued."
    : auditStatus === "running"
      ? "Objective audit is running."
      : auditStatus === "failed"
        ? (auditJob?.lastError
          ? `Objective audit failed: ${auditJob.lastError}`
          : "Objective audit failed before a fresh snapshot was recorded.")
        : stale
          ? "Latest audit snapshot predates the current objective state."
          : auditStatus === "missing"
            ? "No fresh audit snapshot has been recorded for this objective yet."
            : undefined;
  return {
    auditedAt: auditMetadata?.generatedAt && auditMetadata.generatedAt > 0 ? auditMetadata.generatedAt : undefined,
    auditStatus,
    auditStatusMessage,
    stale,
    recommendationStatus: auditMetadata?.recommendationStatus,
    recommendationError: auditMetadata?.recommendationError,
    recommendations: auditMetadata?.recommendations ?? [],
    autoFixObjectiveId: auditMetadata?.autoFixObjectiveId,
    ...(autoFixObjectiveState
      ? {
          autoFixObjectiveStatus: autoFixObjectiveState.status,
          autoFixObjectiveProfileId: autoFixObjectiveState.profile.rootProfileId,
        }
      : {}),
    recurringPatterns: auditMetadata?.recurringPatterns ?? [],
  };
};

export const controlJobCancelReason = (
  state: Pick<FactoryState, "archivedAt" | "status"> | Pick<StoredObjectiveProjectionSummary, "archivedAt" | "status"> | undefined,
): string | undefined => {
  if (!state) return "objective control job canceled because the objective no longer exists";
  if (state.archivedAt) return "objective control job canceled because the objective is archived";
  if (state.status === "blocked") return "objective control job canceled because the objective is blocked";
  if (isTerminalObjectiveStatus(state.status)) {
    return `objective control job canceled because the objective is ${state.status}`;
  }
  return undefined;
};

export const shouldRedriveQueuedControlJob = (
  job: QueueJob,
  now: number,
  redriveAgeMs: number,
): boolean => {
  if (job.commands.length > 0) return true;
  const ageMs = Math.max(now - job.updatedAt, now - job.createdAt);
  return ageMs >= redriveAgeMs;
};

export const objectiveConsumesRepoSlot = (
  objective: Pick<FactoryState, "objectiveMode"> | FactoryObjectiveMode,
): boolean => {
  const objectiveMode = typeof objective === "string" ? objective : objective.objectiveMode;
  return objectiveMode !== "investigation";
};

export const releasesObjectiveSlot = (state: Pick<FactoryState, "status" | "integration">): boolean => {
  const { status } = state;
  if (isTerminalObjectiveStatus(status) || status === "blocked" || status === "promoting") return true;
  const integrationStatus = state.integration?.status;
  return integrationStatus === "ready_to_promote" || integrationStatus === "promoting" || integrationStatus === "promoted";
};

export const releasesObjectiveProjectionSlot = (
  summary: Pick<StoredObjectiveProjectionSummary, "status" | "integrationStatus">,
): boolean => {
  const { status } = summary;
  if (isTerminalObjectiveStatus(status) || status === "blocked" || status === "promoting") return true;
  return summary.integrationStatus === "ready_to_promote"
    || summary.integrationStatus === "promoting"
    || summary.integrationStatus === "promoted";
};
