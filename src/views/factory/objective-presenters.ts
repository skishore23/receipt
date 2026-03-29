import { buildFactoryProjection, type FactoryState } from "../../modules/factory";
import type {
  FactoryObjectiveCard,
  FactoryObjectiveDetail,
} from "../../services/factory-types";
import type { FactorySelectedObjectiveCard } from "../factory-models";
import {
  buildObjectiveActionSet,
  buildObjectiveBottomLine,
  buildObjectiveEvidenceStats,
  buildObjectiveTimelineGroups,
  deriveObjectiveDisplayState,
  deriveObjectiveLifecycleSteps,
  deriveObjectiveReviewStatus,
} from "../factory/supervision";

export type FactoryObjectiveSummary = {
  readonly objectiveId: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly summary: string;
  readonly integrationStatus?: string;
  readonly latestCommitHash?: string;
  readonly prUrl?: string;
  readonly prNumber?: number;
  readonly link: string;
};

const objectiveDebugLink = (objectiveId: string): string =>
  `/factory/api/objectives/${encodeURIComponent(objectiveId)}/debug`;

const objectiveLink = (objectiveId: string): string =>
  `/factory?objective=${encodeURIComponent(objectiveId)}`;

const totalCandidateTokens = (state: FactoryState): number | undefined => {
  const total = Object.values(state.candidates).reduce((sum, candidate) => sum + (candidate.tokensUsed ?? 0), 0);
  return total > 0 ? total : undefined;
};

const latestCommitHashForState = (state: FactoryState): string | undefined => {
  const projection = buildFactoryProjection(state);
  const latestCandidate = projection.candidates.at(-1);
  return state.integration.promotedCommit ?? state.integration.headCommit ?? latestCandidate?.headCommit;
};

export const summarizeFactoryObjective = (
  detail: Pick<
    FactoryObjectiveCard,
    "objectiveId" | "title" | "status" | "phase" | "latestSummary" | "nextAction" | "integrationStatus" | "latestCommitHash" | "prUrl" | "prNumber"
  >,
): FactoryObjectiveSummary => ({
  objectiveId: detail.objectiveId,
  title: detail.title,
  status: detail.status,
  phase: detail.phase,
  summary: detail.latestSummary ?? detail.nextAction ?? detail.title,
  integrationStatus: detail.integrationStatus,
  latestCommitHash: detail.latestCommitHash,
  prUrl: detail.prUrl,
  prNumber: detail.prNumber,
  link: objectiveLink(detail.objectiveId),
});

export const toFactorySelectedObjectiveCard = (
  selectedObjective: FactoryObjectiveCard | FactoryObjectiveDetail,
): FactorySelectedObjectiveCard => {
  const displayState = deriveObjectiveDisplayState(selectedObjective);
  const lifecycleSteps = deriveObjectiveLifecycleSteps(selectedObjective);
  const { primaryAction, secondaryActions } = buildObjectiveActionSet({
    objectiveId: selectedObjective.objectiveId,
    profileId: selectedObjective.profile.rootProfileId,
    profileLabel: selectedObjective.profile.rootProfileLabel,
    title: selectedObjective.title,
    status: selectedObjective.status,
    phase: selectedObjective.phase,
    displayState,
    summary: selectedObjective.latestSummary ?? selectedObjective.nextAction,
    bottomLine: buildObjectiveBottomLine(selectedObjective),
    debugLink: objectiveDebugLink(selectedObjective.objectiveId),
    receiptsLink: "/receipt",
    nextAction: selectedObjective.nextAction,
    createdAt: "createdAt" in selectedObjective ? selectedObjective.createdAt : undefined,
    updatedAt: selectedObjective.updatedAt,
    severity: selectedObjective.severity,
    objectiveMode: selectedObjective.objectiveMode,
    slotState: selectedObjective.scheduler.slotState,
    queuePosition: selectedObjective.scheduler.queuePosition,
    blockedReason: selectedObjective.blockedReason,
    blockedExplanation: selectedObjective.blockedExplanation?.summary,
    integrationStatus: selectedObjective.integrationStatus,
    activeTaskCount: selectedObjective.activeTaskCount,
    readyTaskCount: selectedObjective.readyTaskCount,
    taskCount: selectedObjective.taskCount,
    latestCommitHash: selectedObjective.latestCommitHash,
    prUrl: selectedObjective.prUrl,
    prNumber: selectedObjective.prNumber,
    checks: "checks" in selectedObjective ? selectedObjective.checks : undefined,
    latestDecisionSummary: selectedObjective.latestDecision?.summary,
    latestDecisionAt: selectedObjective.latestDecision?.at,
    tokensUsed: selectedObjective.tokensUsed,
    reviewStatus: deriveObjectiveReviewStatus(selectedObjective),
    lifecycleSteps,
    evidenceStats: buildObjectiveEvidenceStats(selectedObjective),
    timelineGroups: buildObjectiveTimelineGroups(selectedObjective),
  });
  return {
    objectiveId: selectedObjective.objectiveId,
    profileId: selectedObjective.profile.rootProfileId,
    profileLabel: selectedObjective.profile.rootProfileLabel,
    title: selectedObjective.title,
    status: selectedObjective.status,
    phase: selectedObjective.phase,
    displayState,
    summary: selectedObjective.latestSummary ?? selectedObjective.nextAction,
    bottomLine: buildObjectiveBottomLine(selectedObjective),
    debugLink: objectiveDebugLink(selectedObjective.objectiveId),
    receiptsLink: "/receipt",
    nextAction: selectedObjective.nextAction,
    createdAt: "createdAt" in selectedObjective ? selectedObjective.createdAt : undefined,
    updatedAt: selectedObjective.updatedAt,
    severity: selectedObjective.severity,
    objectiveMode: selectedObjective.objectiveMode,
    slotState: selectedObjective.scheduler.slotState,
    queuePosition: selectedObjective.scheduler.queuePosition,
    blockedReason: selectedObjective.blockedReason,
    blockedExplanation: selectedObjective.blockedExplanation?.summary,
    integrationStatus: selectedObjective.integrationStatus,
    activeTaskCount: selectedObjective.activeTaskCount,
    readyTaskCount: selectedObjective.readyTaskCount,
    taskCount: selectedObjective.taskCount,
    latestCommitHash: selectedObjective.latestCommitHash,
    prUrl: selectedObjective.prUrl,
    prNumber: selectedObjective.prNumber,
    checks: "checks" in selectedObjective ? selectedObjective.checks : undefined,
    latestDecisionSummary: selectedObjective.latestDecision?.summary,
    latestDecisionAt: selectedObjective.latestDecision?.at,
    tokensUsed: selectedObjective.tokensUsed,
    reviewStatus: deriveObjectiveReviewStatus(selectedObjective),
    lifecycleSteps,
    evidenceStats: buildObjectiveEvidenceStats(selectedObjective),
    timelineGroups: buildObjectiveTimelineGroups(selectedObjective),
    primaryAction,
    secondaryActions,
  };
};

export const toFactoryStateSelectedObjectiveCard = (
  state: FactoryState,
): FactorySelectedObjectiveCard => {
  const projection = buildFactoryProjection(state);
  const status = state.status;
  const displayState = status === "completed"
    ? "Completed"
    : status === "blocked"
      ? "Blocked"
      : status === "failed"
        ? "Failed"
        : status === "canceled"
          ? "Canceled"
          : state.scheduler.slotState === "queued"
            ? "Ready"
            : state.status === "planning" && projection.tasks.length === 0
              ? "Draft"
              : "Running";
  return {
    objectiveId: state.objectiveId,
    profileId: state.profile.rootProfileId,
    profileLabel: state.profile.rootProfileLabel,
    title: state.title,
    status: state.status,
    phase: state.status,
    displayState,
    summary: state.latestSummary,
    bottomLine: state.latestSummary,
    debugLink: objectiveDebugLink(state.objectiveId),
    receiptsLink: "/receipt",
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    severity: state.severity,
    objectiveMode: state.objectiveMode,
    slotState: state.scheduler.slotState,
    blockedReason: state.blockedReason,
    integrationStatus: state.integration.status,
    activeTaskCount: projection.activeTasks.length,
    readyTaskCount: projection.readyTasks.length,
    taskCount: projection.tasks.length,
    latestCommitHash: latestCommitHashForState(state),
    prUrl: state.integration.prUrl,
    prNumber: state.integration.prNumber,
    checks: state.checks,
    tokensUsed: totalCandidateTokens(state),
  };
};
