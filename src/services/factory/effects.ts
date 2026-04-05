import type { GraphRef } from "@receipt/core/graph";

import type {
  FactoryCandidateStatus,
  FactoryAlignmentReportRecord,
  FactoryCheckResult,
  FactoryExecutionScriptRun,
  FactoryState,
  FactoryTaskAlignmentRecord,
  FactoryTaskCompletionRecord,
  FactoryTaskResultOutcome,
} from "../../modules/factory";

export type FactoryCandidateReviewStatus = Extract<FactoryCandidateStatus, "approved" | "changes_requested" | "rejected">;

export type FactoryTaskReworkBlock = {
  readonly taskId: string;
  readonly reason: string;
};

export type FactoryObjectivePlannerFacts = {
  readonly latestObjectiveOperatorNote?: string;
  readonly taskReworkBlocks: ReadonlyArray<FactoryTaskReworkBlock>;
  readonly dispatchCapacity: number;
  readonly policyBlockedReason?: string;
  readonly readyToPromoteBlockedReason?: string;
  readonly hasInvestigationReports: boolean;
  readonly investigationSynthesisSummary?: string;
};

export type FactoryTaskResultPlannerInput = {
  readonly taskId: string;
  readonly candidateId: string;
  readonly outcome: FactoryTaskResultOutcome;
  readonly workspaceDirty: boolean;
  readonly hasFailedCheck: boolean;
  readonly blockedReason?: string;
  readonly reworkBlockedReason?: string;
  readonly candidate: {
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
  };
  readonly review: {
    readonly status: FactoryCandidateReviewStatus;
    readonly summary: string;
    readonly handoff: string;
    readonly reviewedAt: number;
  };
};

export type FactoryPlannerEffect =
  | {
      readonly type: "objective.add_initial_task";
    }
  | {
      readonly type: "objective.queue_follow_up_task";
      readonly sourceTaskId?: string;
      readonly supersedeTaskId?: string;
    }
  | {
      readonly type: "task.ready";
      readonly taskId: string;
    }
  | {
      readonly type: "task.unblock";
      readonly taskId: string;
    }
  | {
      readonly type: "task.block";
      readonly taskId: string;
      readonly reason: string;
    }
  | {
      readonly type: "task.dispatch";
      readonly taskId: string;
    }
  | {
      readonly type: "task.review.request";
      readonly taskId: string;
      readonly reviewRequestedAt: number;
    }
  | {
      readonly type: "task.noop_complete";
      readonly taskId: string;
      readonly candidateId: string;
      readonly summary: string;
      readonly completedAt: number;
    }
  | {
      readonly type: "candidate.produce";
      readonly candidateId: string;
      readonly taskId: string;
      readonly headCommit: string;
      readonly summary: string;
      readonly handoff: string;
      readonly completion: FactoryTaskCompletionRecord;
      readonly alignment?: FactoryTaskAlignmentRecord;
      readonly checkResults: ReadonlyArray<FactoryCheckResult>;
      readonly scriptsRun?: ReadonlyArray<FactoryExecutionScriptRun>;
      readonly alignmentReport?: FactoryAlignmentReportRecord;
      readonly artifactRefs: Readonly<Record<string, GraphRef>>;
      readonly tokensUsed?: number;
      readonly producedAt: number;
    }
  | {
      readonly type: "candidate.review";
      readonly candidateId: string;
      readonly taskId: string;
      readonly status: FactoryCandidateReviewStatus;
      readonly summary: string;
      readonly handoff: string;
      readonly reviewedAt: number;
    }
  | {
      readonly type: "integration.queue";
      readonly candidateId: string;
      readonly taskId: string;
    }
  | {
      readonly type: "integration.ready_to_promote";
      readonly candidateId: string;
      readonly headCommit: string;
      readonly summary: string;
    }
  | {
      readonly type: "integration.promote";
      readonly candidateId: string;
    }
  | {
      readonly type: "objective.complete";
      readonly summary: string;
    }
  | {
      readonly type: "objective.block";
      readonly reason: string;
      readonly summary: string;
      readonly allowAutonomousNextStep?: boolean;
    };

export type FactoryObjectivePlannerInput = {
  readonly state: FactoryState;
  readonly facts: FactoryObjectivePlannerFacts;
};
