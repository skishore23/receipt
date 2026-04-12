import { buildFactoryProjection, type FactoryObjectivePhase, type FactoryState } from "../../modules/factory";
import type {
  FactoryObjectiveCard,
  FactoryObjectiveDetail,
} from "../../services/factory-types";
import { deriveObjectiveOperationalState } from "../../services/factory/objective-status";
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

const phaseForStateCard = (
  state: FactoryState,
  phaseDetail: FactorySelectedObjectiveCard["phaseDetail"],
): FactoryObjectivePhase => {
  if (state.status === "collecting_evidence" || state.status === "evidence_ready" || state.status === "synthesizing") {
    return state.status;
  }
  if (state.status === "waiting_for_slot" || state.scheduler.slotState === "queued") return "waiting_for_slot";
  if (phaseDetail === "waiting_for_synthesis") return "evidence_ready";
  if (phaseDetail === "waiting_for_control") return "planning";
  if (state.status === "planning") return "planning";
  if (state.status === "integrating") return "integrating";
  if (state.status === "promoting") return "promoting";
  if (state.status === "completed") return "completed";
  return "blocked";
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
    phaseDetail: selectedObjective.phaseDetail,
    statusAuthority: selectedObjective.statusAuthority,
    hasAuthoritativeLiveJob: selectedObjective.hasAuthoritativeLiveJob,
    summary: selectedObjective.latestSummary ?? selectedObjective.nextAction,
    bottomLine: buildObjectiveBottomLine(selectedObjective),
    renderedBody: selectedObjective.latestHandoff?.renderedBody ?? selectedObjective.latestHandoff?.output,
    latestHandoff: selectedObjective.latestHandoff,
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
    selfImprovement: selectedObjective.selfImprovement,
    systemImprovement: selectedObjective.systemImprovement,
    contract: selectedObjective.contract,
    alignment: selectedObjective.alignment,
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
    phaseDetail: selectedObjective.phaseDetail,
    statusAuthority: selectedObjective.statusAuthority,
    hasAuthoritativeLiveJob: selectedObjective.hasAuthoritativeLiveJob,
    summary: selectedObjective.latestSummary ?? selectedObjective.nextAction,
    bottomLine: buildObjectiveBottomLine(selectedObjective),
    renderedBody: selectedObjective.latestHandoff?.renderedBody ?? selectedObjective.latestHandoff?.output,
    latestHandoff: selectedObjective.latestHandoff,
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
    selfImprovement: selectedObjective.selfImprovement,
    systemImprovement: selectedObjective.systemImprovement,
    contract: selectedObjective.contract,
    alignment: selectedObjective.alignment,
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
  const operationalState = deriveObjectiveOperationalState({
    state,
    taskCount: projection.tasks.length,
    executionStalled: false,
    objectiveJobs: [],
  });
  return {
    objectiveId: state.objectiveId,
    profileId: state.profile.rootProfileId,
    profileLabel: state.profile.rootProfileLabel,
    title: state.title,
    status: state.status,
    phase: phaseForStateCard(state, operationalState.phaseDetail),
    displayState: operationalState.displayState,
    phaseDetail: operationalState.phaseDetail,
    statusAuthority: operationalState.statusAuthority,
    hasAuthoritativeLiveJob: operationalState.hasAuthoritativeLiveJob,
    summary: state.latestSummary,
    bottomLine: state.latestSummary,
    renderedBody: state.latestHandoff?.renderedBody ?? state.latestHandoff?.output,
    latestHandoff: state.latestHandoff,
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
