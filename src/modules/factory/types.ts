import { type GraphRef } from "@receipt/core/graph";

export type FactoryObjectiveStatus =
  | "planning"
  | "executing"
  | "integrating"
  | "promoting"
  | "completed"
  | "blocked"
  | "failed"
  | "canceled";

export type FactoryTaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "reviewing"
  | "approved"
  | "integrated"
  | "blocked"
  | "superseded";

export type FactoryCandidateStatus =
  | "planned"
  | "running"
  | "awaiting_review"
  | "changes_requested"
  | "approved"
  | "integrated"
  | "rejected"
  | "conflicted";

export type FactoryIntegrationStatus =
  | "idle"
  | "queued"
  | "merging"
  | "validating"
  | "validated"
  | "ready_to_promote"
  | "promoting"
  | "promoted"
  | "conflicted";

export type FactoryWorkerType =
  | "codex"
  | "agent"
  | "infra"
  | string;

export type FactoryObjectiveMode =
  | "delivery"
  | "investigation";

export type FactoryObjectiveSeverity =
  | 1
  | 2
  | 3
  | 4
  | 5;

export type FactoryTaskResultOutcome =
  | "approved"
  | "changes_requested"
  | "blocked"
  | "partial";

export type FactoryProfileCloudProvider = "aws" | "gcp" | "azure";

export type FactoryInvestigationEvidence = {
  readonly title: string;
  readonly summary: string;
  readonly detail?: string;
};

export type FactoryExecutionScriptRun = {
  readonly command: string;
  readonly summary?: string;
  readonly status?: "ok" | "warning" | "error";
};

export type FactoryInvestigationScriptRun = FactoryExecutionScriptRun;

export type FactoryTaskCompletionRecord = {
  readonly changed: ReadonlyArray<string>;
  readonly proof: ReadonlyArray<string>;
  readonly remaining: ReadonlyArray<string>;
};

export type FactoryInvestigationReport = {
  readonly conclusion: string;
  readonly evidence: ReadonlyArray<FactoryInvestigationEvidence>;
  readonly scriptsRun: ReadonlyArray<FactoryInvestigationScriptRun>;
  readonly disagreements: ReadonlyArray<string>;
  readonly nextSteps: ReadonlyArray<string>;
};

export type FactoryInvestigationTaskReport = {
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
};

export type FactoryInvestigationSynthesisRecord = {
  readonly summary: string;
  readonly report: FactoryInvestigationReport;
  readonly taskIds: ReadonlyArray<string>;
  readonly synthesizedAt: number;
};

export type FactoryTaskExecutionMode = "worktree" | "isolated";

export type FactoryPlanningTaskRecord = {
  readonly taskId: string;
  readonly title: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly workerType: FactoryWorkerType;
  readonly executionMode: FactoryTaskExecutionMode;
  readonly status: FactoryTaskStatus;
};

export type FactoryPlanningReceiptRecord = {
  readonly goal: string;
  readonly constraints: ReadonlyArray<string>;
  readonly taskGraph: ReadonlyArray<FactoryPlanningTaskRecord>;
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly validationPlan: ReadonlyArray<string>;
  readonly plannedAt: number;
};

export type FactoryObjectiveProfilePolicy = {
  readonly allowedWorkerTypes: ReadonlyArray<FactoryWorkerType>;
  readonly defaultWorkerType: FactoryWorkerType;
  readonly defaultTaskExecutionMode: FactoryTaskExecutionMode;
  readonly defaultValidationMode: "repo_profile" | "none";
  readonly defaultObjectiveMode: FactoryObjectiveMode;
  readonly defaultSeverity: FactoryObjectiveSeverity;
  readonly maxParallelChildren: number;
  readonly allowObjectiveCreation: boolean;
};

export type FactoryObjectiveProfileSnapshot = {
  readonly rootProfileId: string;
  readonly rootProfileLabel: string;
  readonly resolvedProfileHash: string;
  readonly promptHash: string;
  readonly promptPath: string;
  readonly selectedSkills: ReadonlyArray<string>;
  readonly cloudProvider?: FactoryProfileCloudProvider;
  readonly objectivePolicy: FactoryObjectiveProfilePolicy;
};

export type FactoryObjectivePhase =
  | "planning"
  | "waiting_for_slot"
  | "executing"
  | "integrating"
  | "promoting"
  | "completed"
  | "blocked";

export type FactoryObjectiveSlotState = "queued" | "active" | "released";

export type FactoryObjectivePolicy = {
  readonly concurrency?: {
    readonly maxActiveTasks?: number;
  };
  readonly budgets?: {
    readonly maxTaskRuns?: number;
    readonly maxCandidatePassesPerTask?: number;
    readonly maxObjectiveMinutes?: number;
  };
  readonly throttles?: {
    readonly maxDispatchesPerReact?: number;
  };
  readonly promotion?: {
    readonly autoPromote?: boolean;
  };
};

export type FactoryNormalizedObjectivePolicy = {
  readonly concurrency: {
    readonly maxActiveTasks: number;
  };
  readonly budgets: {
    readonly maxTaskRuns: number;
    readonly maxCandidatePassesPerTask: number;
    readonly maxObjectiveMinutes: number;
  };
  readonly throttles: {
    readonly maxDispatchesPerReact: number;
  };
  readonly promotion: {
    readonly autoPromote: boolean;
  };
};

export type FactoryBudgetState = {
  readonly taskRunsUsed: number;
  readonly candidatePassesByTask: Readonly<Record<string, number>>;
  readonly consecutiveFailuresByTask: Readonly<Record<string, number>>;
  readonly elapsedMinutes: number;
  readonly lastDispatchAt?: number;
  readonly policyBlockedReason?: string;
};

export type FactorySchedulerRecord = {
  readonly slotState?: FactoryObjectiveSlotState;
  readonly queuedAt?: number;
  readonly admittedAt?: number;
  readonly releasedAt?: number;
  readonly releaseReason?: string;
};

export type FactoryCheckResult = {
  readonly command: string;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: number;
  readonly finishedAt: number;
};

export type FactoryRebracketRecord = {
  readonly frontierTaskIds: ReadonlyArray<string>;
  readonly selectedActionId?: string;
  readonly reason: string;
  readonly confidence?: number;
  readonly source: "orchestrator" | "runtime";
  readonly appliedAt: number;
  readonly basedOn?: string;
};

export type FactoryTaskRecord = {
  readonly nodeId: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly status: FactoryTaskStatus;
  readonly taskId: string;
  readonly taskKind: "planned";
  readonly title: string;
  readonly prompt: string;
  readonly workerType: FactoryWorkerType;
  readonly executionMode?: FactoryTaskExecutionMode;
  readonly sourceTaskId?: string;
  readonly baseCommit: string;
  readonly latestSummary?: string;
  readonly latestTraceSummary?: string;
  readonly blockedReason?: string;
  readonly candidateId?: string;
  readonly workspaceId?: string;
  readonly workspacePath?: string;
  readonly jobId?: string;
  readonly skillBundlePaths: ReadonlyArray<string>;
  readonly contextRefs: ReadonlyArray<GraphRef>;
  readonly artifactRefs: Readonly<Record<string, GraphRef>>;
  readonly basedOn?: string;
  readonly createdAt: number;
  readonly readyAt?: number;
  readonly startedAt?: number;
  readonly reviewingAt?: number;
  readonly completedAt?: number;
};

export type FactoryCandidateRecord = {
  readonly candidateId: string;
  readonly taskId: string;
  readonly status: FactoryCandidateStatus;
  readonly parentCandidateId?: string;
  readonly baseCommit: string;
  readonly headCommit?: string;
  readonly summary?: string;
  readonly handoff?: string;
  readonly completion?: FactoryTaskCompletionRecord;
  readonly checkResults: ReadonlyArray<FactoryCheckResult>;
  readonly scriptsRun?: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly artifactRefs: Readonly<Record<string, GraphRef>>;
  readonly latestReason?: string;
  readonly tokensUsed?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly approvedAt?: number;
  readonly integratedAt?: number;
  readonly conflictReason?: string;
};

export type FactoryWorkflowStatus =
  | "active"
  | "completed"
  | "blocked"
  | "failed"
  | "canceled";

export type FactoryIntegrationRecord = {
  readonly status: FactoryIntegrationStatus;
  readonly branchName?: string;
  readonly branchRef?: GraphRef;
  readonly headCommit?: string;
  readonly queuedCandidateIds: ReadonlyArray<string>;
  readonly activeCandidateId?: string;
  readonly validationResults: ReadonlyArray<FactoryCheckResult>;
  readonly lastSummary?: string;
  readonly conflictReason?: string;
  readonly promotedCommit?: string;
  readonly prUrl?: string;
  readonly prNumber?: number;
  readonly headRefName?: string;
  readonly baseRefName?: string;
  readonly updatedAt: number;
};

export type FactoryWorkflowState = {
  readonly objectiveId: string;
  readonly status: FactoryWorkflowStatus;
  readonly activeTaskIds: ReadonlyArray<string>;
  readonly taskIds: ReadonlyArray<string>;
  readonly tasksById: Readonly<Record<string, FactoryTaskRecord>>;
  readonly updatedAt: number;
};

export type FactoryState = {
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
  readonly status: FactoryObjectiveStatus;
  readonly archivedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly taskRunsUsed: number;
  readonly candidatePassesByTask: Readonly<Record<string, number>>;
  readonly consecutiveFailuresByTask: Readonly<Record<string, number>>;
  readonly lastDispatchAt?: number;
  readonly candidates: Readonly<Record<string, FactoryCandidateRecord>>;
  readonly candidateOrder: ReadonlyArray<string>;
  readonly workflow: FactoryWorkflowState;
  readonly integration: FactoryIntegrationRecord;
  readonly scheduler: FactorySchedulerRecord;
  readonly planning?: FactoryPlanningReceiptRecord;
  readonly investigation: {
    readonly reports: Readonly<Record<string, FactoryInvestigationTaskReport>>;
    readonly reportOrder: ReadonlyArray<string>;
    readonly synthesized?: FactoryInvestigationSynthesisRecord;
  };
  readonly latestRebracket?: FactoryRebracketRecord;
};

export type FactoryProjection = {
  readonly objectiveId: string;
  readonly title: string;
  readonly status: FactoryObjectiveStatus;
  readonly archivedAt?: number;
  readonly updatedAt: number;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly activeTasks: ReadonlyArray<FactoryTaskRecord>;
  readonly readyTasks: ReadonlyArray<FactoryTaskRecord>;
  readonly pendingTasks: ReadonlyArray<FactoryTaskRecord>;
  readonly completedTasks: ReadonlyArray<FactoryTaskRecord>;
  readonly blockedTasks: ReadonlyArray<FactoryTaskRecord>;
  readonly tasks: ReadonlyArray<FactoryTaskRecord>;
  readonly candidates: ReadonlyArray<FactoryCandidateRecord>;
  readonly integration: FactoryIntegrationRecord;
};
