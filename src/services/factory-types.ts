import type { GraphRef } from "@receipt/core/graph";
import type { QueueCommandRecord, QueueJob } from "../adapters/jsonl-queue";
import type {
  FactoryBudgetState,
  FactoryCandidateRecord,
  FactoryInvestigationReport,
  FactoryInvestigationSynthesisRecord,
  FactoryInvestigationTaskReport,
  FactoryObjectiveMode,
  FactoryNormalizedObjectivePolicy,
  FactoryObjectivePhase,
  FactoryPlanningReceiptRecord,
  FactoryObjectivePolicy,
  FactoryObjectiveProfileSnapshot,
  FactoryObjectiveSeverity,
  FactoryObjectiveSlotState,
  FactoryObjectiveStatus,
  FactoryState,
  FactoryTaskExecutionMode,
  FactoryTaskCompletionRecord,
  FactoryTaskRecord,
  FactoryWorkerType,
} from "../modules/factory";
import type { JobRecord, JobStatus } from "../modules/job";
import type { FactoryCloudExecutionContext } from "./factory-cloud-context";

export const FACTORY_PROFILE_SUMMARY = "Using checked-in Factory profiles and skills only.";

export class FactoryServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type FactoryServiceOptions = {
  readonly dataDir: string;
  readonly queue: import("../adapters/jsonl-queue").JsonlQueue;
  readonly jobRuntime: import("@receipt/core/runtime").Runtime<
    import("../modules/job").JobCmd,
    import("../modules/job").JobEvent,
    import("../modules/job").JobState
  >;
  readonly sse: import("../framework/sse-hub").SseHub;
  readonly codexExecutor: import("../adapters/codex-executor").CodexExecutor;
  readonly memoryTools?: import("../adapters/memory-tools").MemoryTools;
  readonly repoRoot?: string;
  readonly profileRoot?: string;
  readonly cloudExecutionContextProvider?: () => Promise<FactoryCloudExecutionContext>;
};

export type FactoryObjectiveInput = {
  readonly objectiveId?: string;
  readonly title: string;
  readonly prompt: string;
  readonly baseHash?: string;
  readonly objectiveMode?: FactoryObjectiveMode;
  readonly severity?: FactoryObjectiveSeverity;
  readonly checks?: ReadonlyArray<string>;
  readonly channel?: string;
  readonly policy?: FactoryObjectivePolicy;
  readonly profileId?: string;
  readonly startImmediately?: boolean;
};

export type FactoryObjectiveComposeInput = {
  readonly prompt: string;
  readonly objectiveId?: string;
  readonly title?: string;
  readonly baseHash?: string;
  readonly objectiveMode?: FactoryObjectiveMode;
  readonly severity?: FactoryObjectiveSeverity;
  readonly checks?: ReadonlyArray<string>;
  readonly channel?: string;
  readonly policy?: FactoryObjectivePolicy;
  readonly profileId?: string;
  readonly startImmediately?: boolean;
};

export type FactoryQueuedJobCommand = {
  readonly job: QueueJob;
  readonly command: QueueCommandRecord;
};

export type FactoryContextSources = {
  readonly repoSharedMemoryScope: string;
  readonly objectiveMemoryScope: string;
  readonly integrationMemoryScope: string;
  readonly profileSkillRefs: ReadonlyArray<string>;
  readonly repoSkillPaths: ReadonlyArray<string>;
  readonly sharedArtifactRefs: ReadonlyArray<GraphRef>;
};

export type FactoryTaskView = FactoryTaskRecord & {
  readonly candidate?: FactoryCandidateRecord;
  readonly investigationReport?: FactoryInvestigationTaskReport;
  readonly completion?: FactoryTaskCompletionRecord;
  readonly jobStatus?: JobStatus | "missing";
  readonly job?: JobRecord;
  readonly workspaceExists: boolean;
  readonly workspaceDirty: boolean;
  readonly workspaceHead?: string;
  readonly elapsedMs?: number;
  readonly manifestPath?: string;
  readonly contextPackPath?: string;
  readonly promptPath?: string;
  readonly memoryScriptPath?: string;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
  readonly lastMessagePath?: string;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  readonly lastMessage?: string;
  readonly artifactSummary?: string;
  readonly artifactActivity?: ReadonlyArray<FactoryArtifactActivity>;
};

export type FactoryArtifactActivity = {
  readonly path: string;
  readonly label: string;
  readonly updatedAt: number;
  readonly bytes: number;
};

export type FactoryObjectiveCard = {
  readonly objectiveId: string;
  readonly title: string;
  readonly status: FactoryObjectiveStatus;
  readonly phase: FactoryObjectivePhase;
  readonly objectiveMode: FactoryObjectiveMode;
  readonly severity: FactoryObjectiveSeverity;
  readonly scheduler: {
    readonly slotState: FactoryObjectiveSlotState;
    readonly queuePosition?: number;
  };
  readonly archivedAt?: number;
  readonly updatedAt: number;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly tokensUsed?: number;
  readonly blockedExplanation?: {
    readonly summary: string;
    readonly taskId?: string;
    readonly candidateId?: string;
    readonly receiptType?: string;
    readonly receiptHash?: string;
  };
  readonly latestDecision?: {
    readonly summary: string;
    readonly at: number;
    readonly source: "orchestrator" | "fallback" | "runtime" | "system";
    readonly selectedActionId?: string;
  };
  readonly nextAction?: string;
  readonly activeTaskCount: number;
  readonly readyTaskCount: number;
  readonly taskCount: number;
  readonly integrationStatus: FactoryState["integration"]["status"];
  readonly latestCommitHash?: string;
  readonly prUrl?: string;
  readonly prNumber?: number;
  readonly headRefName?: string;
  readonly baseRefName?: string;
  readonly profile: FactoryObjectiveProfileSnapshot;
};

export type FactoryObjectiveDetail = FactoryObjectiveCard & {
  readonly prompt: string;
  readonly channel: string;
  readonly baseHash: string;
  readonly checks: ReadonlyArray<string>;
  readonly profile: FactoryObjectiveProfileSnapshot;
  readonly policy: FactoryNormalizedObjectivePolicy;
  readonly contextSources: FactoryContextSources;
  readonly budgetState: FactoryBudgetState;
  readonly createdAt: number;
  readonly planning?: FactoryPlanningReceiptRecord;
  readonly investigation: {
    readonly reports: ReadonlyArray<FactoryInvestigationTaskReport>;
    readonly synthesized?: FactoryInvestigationSynthesisRecord;
    readonly finalReport: FactoryInvestigationReport;
  };
  readonly tasks: ReadonlyArray<FactoryTaskView>;
  readonly candidates: ReadonlyArray<FactoryCandidateRecord>;
  readonly integration: FactoryState["integration"];
  readonly recentReceipts: ReadonlyArray<{
    readonly type: string;
    readonly hash: string;
    readonly ts: number;
    readonly summary: string;
    readonly taskId?: string;
    readonly candidateId?: string;
  }>;
  readonly evidenceCards: ReadonlyArray<{
    readonly kind: "decision" | "blocked" | "merge" | "promotion" | "report";
    readonly title: string;
    readonly summary: string;
    readonly at: number;
    readonly taskId?: string;
    readonly candidateId?: string;
    readonly receiptHash?: string;
    readonly receiptType: string;
  }>;
  readonly activity: ReadonlyArray<{
    readonly kind: "task" | "job" | "receipt";
    readonly title: string;
    readonly summary: string;
    readonly at: number;
    readonly taskId?: string;
    readonly candidateId?: string;
  }>;
  readonly latestRebracket?: FactoryState["latestRebracket"];
};

export type FactoryComposeModel = {
  readonly defaultBranch: string;
  readonly sourceDirty: boolean;
  readonly sourceBranch?: string;
  readonly objectiveCount: number;
  readonly defaultPolicy: FactoryNormalizedObjectivePolicy;
  readonly profileSummary: string;
  readonly defaultValidationCommands: ReadonlyArray<string>;
};

export type FactoryBoardSection =
  | "needs_attention"
  | "active"
  | "queued"
  | "completed";

export type FactoryBoardProjection = {
  readonly objectives: ReadonlyArray<FactoryObjectiveCard & { readonly section: FactoryBoardSection }>;
  readonly sections: Readonly<Record<FactoryBoardSection, ReadonlyArray<FactoryObjectiveCard & { readonly section: FactoryBoardSection }>>>;
  readonly selectedObjectiveId?: string;
};

export type FactoryLiveProjection = {
  readonly selectedObjectiveId?: string;
  readonly objectiveTitle?: string;
  readonly objectiveStatus?: FactoryObjectiveStatus;
  readonly phase?: FactoryObjectivePhase;
  readonly activeTasks: ReadonlyArray<FactoryTaskView>;
  readonly recentJobs: ReadonlyArray<QueueJob>;
};

export type FactoryLiveOutputTargetKind = "task" | "job";

export type FactoryLiveOutputSnapshot = {
  readonly objectiveId: string;
  readonly focusKind: FactoryLiveOutputTargetKind;
  readonly focusId: string;
  readonly title: string;
  readonly status: string;
  readonly active: boolean;
  readonly summary?: string;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly jobId?: string;
  readonly lastMessage?: string;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  readonly artifactSummary?: string;
  readonly artifactActivity?: ReadonlyArray<FactoryArtifactActivity>;
};

export type FactoryDebugProjection = {
  readonly objectiveId: string;
  readonly title: string;
  readonly status: FactoryObjectiveStatus;
  readonly phase: FactoryObjectivePhase;
  readonly scheduler: {
    readonly slotState: FactoryObjectiveSlotState;
    readonly queuePosition?: number;
  };
  readonly latestDecision?: FactoryObjectiveCard["latestDecision"];
  readonly nextAction?: string;
  readonly prUrl?: string;
  readonly prNumber?: number;
  readonly headRefName?: string;
  readonly baseRefName?: string;
  readonly profile: FactoryObjectiveProfileSnapshot;
  readonly policy: FactoryNormalizedObjectivePolicy;
  readonly contextSources: FactoryContextSources;
  readonly budgetState: FactoryBudgetState;
  readonly recentReceipts: ReadonlyArray<{
    readonly type: string;
    readonly hash: string;
    readonly ts: number;
    readonly summary: string;
  }>;
  readonly activeJobs: ReadonlyArray<QueueJob>;
  readonly lastJobs: ReadonlyArray<QueueJob>;
  readonly taskWorktrees: ReadonlyArray<{
    readonly taskId: string;
    readonly workspacePath?: string;
    readonly exists: boolean;
    readonly dirty: boolean;
    readonly head?: string;
    readonly branch?: string;
  }>;
  readonly integrationWorktree?: {
    readonly workspacePath?: string;
    readonly exists: boolean;
    readonly dirty: boolean;
    readonly head?: string;
    readonly branch?: string;
  };
  readonly latestContextPacks: ReadonlyArray<{
    readonly taskId: string;
    readonly candidateId?: string;
    readonly contextPackPath?: string;
    readonly memoryScriptPath?: string;
  }>;
};

export type FactoryTaskJobPayload = {
  readonly kind: "factory.task.run";
  readonly objectiveId: string;
  readonly taskId: string;
  readonly workerType: FactoryWorkerType;
  readonly objectiveMode: FactoryObjectiveMode;
  readonly severity: FactoryObjectiveSeverity;
  readonly candidateId: string;
  readonly baseCommit: string;
  readonly executionMode: FactoryTaskExecutionMode;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly resultPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly lastMessagePath: string;
  readonly manifestPath: string;
  readonly contextPackPath: string;
  readonly memoryScriptPath: string;
  readonly memoryConfigPath: string;
  readonly repoSkillPaths: ReadonlyArray<string>;
  readonly skillBundlePaths: ReadonlyArray<string>;
  readonly profile: FactoryObjectiveProfileSnapshot;
  readonly profilePromptHash: string;
  readonly profileSkillRefs: ReadonlyArray<string>;
  readonly sharedArtifactRefs: ReadonlyArray<GraphRef>;
  readonly contextRefs: ReadonlyArray<GraphRef>;
  readonly integrationRef?: GraphRef;
  readonly problem: string;
  readonly config: Readonly<Record<string, unknown>>;
};

export type FactoryIntegrationJobPayload = {
  readonly kind: "factory.integration.validate";
  readonly objectiveId: string;
  readonly candidateId: string;
  readonly workspacePath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly resultPath: string;
  readonly checks: ReadonlyArray<string>;
};

export type FactoryIntegrationPublishJobPayload = {
  readonly kind: "factory.integration.publish";
  readonly objectiveId: string;
  readonly candidateId: string;
  readonly workspacePath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly resultPath: string;
  readonly promptPath: string;
  readonly lastMessagePath: string;
  readonly memoryScope: string;
  readonly contextRefs: ReadonlyArray<GraphRef>;
  readonly skillBundlePaths: ReadonlyArray<string>;
};

export type FactoryObjectiveControlJobPayload = {
  readonly kind: "factory.objective.control";
  readonly objectiveId: string;
  readonly reason: "startup" | "admitted";
};

export type FactoryObjectiveReceiptSummary = {
  readonly type: string;
  readonly hash: string;
  readonly ts: number;
  readonly summary: string;
  readonly taskId?: string;
  readonly candidateId?: string;
};

export type FactoryObjectiveReceiptQuery = {
  readonly limit?: number;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly types?: ReadonlyArray<string>;
};
