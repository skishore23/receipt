import { type GraphRef } from "@receipt/core/graph";

import type {
  FactoryCandidateRecord,
  FactoryCandidateStatus,
  FactoryCheckResult,
  FactoryExecutionScriptRun,
  FactoryInvestigationReport,
  FactoryNormalizedObjectivePolicy,
  FactoryObjectiveHandoffStatus,
  FactoryObjectiveMode,
  FactoryObjectiveProfileSnapshot,
  FactoryPlanningReceiptRecord,
  FactoryObjectiveSeverity,
  FactoryRebracketRecord,
  FactoryTaskAlignmentRecord,
  FactoryTaskRecord,
  FactoryTaskCompletionRecord,
  FactoryTaskResultOutcome,
  FactoryWorkerHandoffOutcome,
  FactoryWorkerHandoffScope,
  FactoryWorkerType,
} from "./types";

export type MonitorCheckpointAction =
  | { readonly kind: "continue" }
  | { readonly kind: "steer"; readonly guidance: string }
  | { readonly kind: "split"; readonly subtasks: ReadonlyArray<{ readonly title: string; readonly prompt: string; readonly dependsOn?: ReadonlyArray<string> }> }
  | { readonly kind: "abort"; readonly reason: string };

export type FactoryEvent =
  | {
      readonly type: "objective.created";
      readonly objectiveId: string;
      readonly title: string;
      readonly prompt: string;
      readonly channel: string;
      readonly baseHash: string;
      readonly sourceWarnings?: ReadonlyArray<string>;
      readonly objectiveMode: FactoryObjectiveMode;
      readonly severity: FactoryObjectiveSeverity;
      readonly checks: ReadonlyArray<string>;
      readonly checksSource: "explicit" | "profile" | "default";
      readonly profile: FactoryObjectiveProfileSnapshot;
      readonly policy: FactoryNormalizedObjectivePolicy;
      readonly createdAt: number;
    }
  | {
      readonly type: "objective.operator.noted";
      readonly objectiveId: string;
      readonly message: string;
      readonly notedAt: number;
    }
  | {
      readonly type: "planning.receipt";
      readonly objectiveId: string;
      readonly plan: FactoryPlanningReceiptRecord;
      readonly plannedAt: number;
    }
  | {
      readonly type: "objective.slot.queued";
      readonly objectiveId: string;
      readonly queuedAt: number;
    }
  | {
      readonly type: "objective.slot.admitted";
      readonly objectiveId: string;
      readonly admittedAt: number;
    }
  | {
      readonly type: "objective.slot.released";
      readonly objectiveId: string;
      readonly releasedAt: number;
      readonly reason: string;
    }
  | {
      readonly type: "task.added";
      readonly objectiveId: string;
      readonly task: FactoryTaskRecord;
      readonly createdAt: number;
    }
  | {
      readonly type: "task.ready";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly readyAt: number;
    }
  | {
      readonly type: "task.dispatched";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly candidateId: string;
      readonly jobId: string;
      readonly workspaceId: string;
      readonly workspacePath: string;
      readonly skillBundlePaths: ReadonlyArray<string>;
      readonly contextRefs: ReadonlyArray<GraphRef>;
      readonly startedAt: number;
    }
  | {
      readonly type: "task.intervention.applied";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly candidateId: string;
      readonly jobId: string;
      readonly guidance: string;
      readonly guidanceKind: "steer" | "follow_up" | "mixed";
      readonly sourceCommandIds: ReadonlyArray<string>;
      readonly appliedAt: number;
    }
  | {
      readonly type: "task.intervention.restarted";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly candidateId: string;
      readonly jobId: string;
      readonly guidance: string;
      readonly guidanceKind: "steer" | "follow_up" | "mixed";
      readonly sourceCommandIds: ReadonlyArray<string>;
      readonly restartCount: number;
      readonly restartedAt: number;
    }
  | {
      readonly type: "worker.handoff";
      readonly objectiveId: string;
      readonly scope: FactoryWorkerHandoffScope;
      readonly workerType: FactoryWorkerType;
      readonly taskId?: string;
      readonly candidateId?: string;
      readonly outcome: FactoryWorkerHandoffOutcome;
      readonly summary: string;
      readonly handoff: string;
      readonly handedOffAt: number;
    }
  | {
      readonly type: "objective.handoff";
      readonly objectiveId: string;
      readonly title: string;
      readonly status: FactoryObjectiveHandoffStatus;
      readonly summary: string;
      readonly output?: string;
      readonly blocker?: string;
      readonly nextAction?: string;
      readonly handoffKey: string;
      readonly sourceUpdatedAt: number;
    }
  | {
      readonly type: "task.review.requested";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly reviewRequestedAt: number;
    }
  | {
      readonly type: "task.approved";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly summary: string;
      readonly approvedAt: number;
    }
  | {
      readonly type: "task.integrated";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly summary: string;
      readonly integratedAt: number;
    }
  | {
      readonly type: "task.noop_completed";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly candidateId: string;
      readonly summary: string;
      readonly completionReason?: "NO_CHANGES_REQUIRED";
      readonly completedAt: number;
    }
  | {
      readonly type: "task.blocked";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly reason: string;
      readonly blockedAt: number;
    }
  | {
      readonly type: "task.unblocked";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly readyAt: number;
    }
  | {
      readonly type: "task.superseded";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly reason: string;
      readonly supersededAt: number;
    }
  | {
      readonly type: "candidate.created";
      readonly objectiveId: string;
      readonly candidate: FactoryCandidateRecord;
      readonly createdAt: number;
    }
  | {
      readonly type: "candidate.produced";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly taskId: string;
      readonly headCommit: string;
      readonly summary: string;
      readonly handoff: string;
      readonly completion: FactoryTaskCompletionRecord;
      readonly alignment?: FactoryTaskAlignmentRecord;
      readonly checkResults: ReadonlyArray<FactoryCheckResult>;
      readonly scriptsRun?: ReadonlyArray<FactoryExecutionScriptRun>;
      readonly artifactRefs: Readonly<Record<string, GraphRef>>;
      readonly tokensUsed?: number;
      readonly producedAt: number;
    }
  | {
      readonly type: "candidate.reviewed";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly taskId: string;
      readonly status: Extract<FactoryCandidateStatus, "changes_requested" | "approved" | "rejected">;
      readonly summary: string;
      readonly handoff: string;
      readonly reviewedAt: number;
    }
  | {
      readonly type: "investigation.reported";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly candidateId: string;
      readonly outcome: FactoryTaskResultOutcome;
      readonly summary: string;
      readonly handoff: string;
      readonly completion: FactoryTaskCompletionRecord;
      readonly report: FactoryInvestigationReport;
      readonly artifactRefs: Readonly<Record<string, GraphRef>>;
      readonly evidenceCommit?: string;
      readonly reportedAt: number;
    }
  | {
      readonly type: "investigation.synthesized";
      readonly objectiveId: string;
      readonly summary: string;
      readonly report: FactoryInvestigationReport;
      readonly taskIds: ReadonlyArray<string>;
      readonly synthesizedAt: number;
    }
  | {
      readonly type: "candidate.conflicted";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly reason: string;
      readonly conflictedAt: number;
    }
  | (FactoryRebracketRecord & {
      readonly type: "rebracket.applied";
      readonly objectiveId: string;
    })
  | {
      readonly type: "merge.applied";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly taskId: string;
      readonly summary: string;
      readonly mergeCommit: string;
      readonly appliedAt: number;
    }
  | {
      readonly type: "integration.queued";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly branchName: string;
      readonly branchRef?: GraphRef;
      readonly queuedAt: number;
    }
  | {
      readonly type: "integration.merging";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly startedAt: number;
    }
  | {
      readonly type: "integration.validating";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly startedAt: number;
    }
  | {
      readonly type: "integration.validated";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly headCommit: string;
      readonly validationResults: ReadonlyArray<FactoryCheckResult>;
      readonly summary: string;
      readonly validatedAt: number;
    }
  | {
      readonly type: "integration.ready_to_promote";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly headCommit: string;
      readonly summary: string;
      readonly readyAt: number;
    }
  | {
      readonly type: "integration.promoting";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly startedAt: number;
    }
  | {
      readonly type: "integration.promoted";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly promotedCommit: string;
      readonly summary: string;
      readonly prUrl?: string;
      readonly prNumber?: number;
      readonly headRefName?: string;
      readonly baseRefName?: string;
      readonly promotedAt: number;
    }
  | {
      readonly type: "integration.conflicted";
      readonly objectiveId: string;
      readonly candidateId?: string;
      readonly reason: string;
      readonly headCommit?: string;
      readonly conflictedAt: number;
    }
  | {
      readonly type: "objective.completed";
      readonly objectiveId: string;
      readonly summary: string;
      readonly completedAt: number;
    }
  | {
      readonly type: "objective.blocked";
      readonly objectiveId: string;
      readonly reason: string;
      readonly summary: string;
      readonly blockedAt: number;
    }
  | {
      readonly type: "objective.failed";
      readonly objectiveId: string;
      readonly reason: string;
      readonly failedAt: number;
    }
  | {
      readonly type: "objective.canceled";
      readonly objectiveId: string;
      readonly reason?: string;
      readonly canceledAt: number;
    }
  | {
      readonly type: "objective.archived";
      readonly objectiveId: string;
      readonly archivedAt: number;
    }
  | {
      readonly type: "monitor.checkpoint";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly jobId: string;
      readonly checkpoint: number;
      readonly assessment: "progressing" | "stalled" | "off_track" | "failing";
      readonly reasoning: string;
      readonly action: MonitorCheckpointAction;
      readonly evaluatedAt: number;
    }
  | {
      readonly type: "monitor.intervention";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly jobId: string;
      readonly interventionKind: "steer" | "split" | "abort";
      readonly detail: string;
      readonly interventionAt: number;
    };

export type FactoryCmd = {
  readonly type: "emit";
  readonly event?: FactoryEvent;
  readonly events?: ReadonlyArray<FactoryEvent>;
  readonly eventId: string;
  readonly expectedPrev?: string;
};
