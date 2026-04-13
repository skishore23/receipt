import type { ObjectiveAnalysis } from "../factory-cli/analyze";
import type { FactoryObjectiveHandoffRecord, FactoryState } from "../modules/factory";
import type {
  FactoryBoardProjection,
  FactoryObjectiveDisplayState,
  FactoryObjectiveDetail,
  FactoryObjectivePhaseDetail,
  FactoryObjectiveSelfImprovement,
  FactorySystemImprovementReport,
  FactoryObjectiveStatusAuthority,
} from "../services/factory-types";
import type { FactoryWorkbenchModel } from "./factory-workbench";
import type { FactoryChatContextProjection } from "../agents/factory/chat-context";

export type FactoryInspectorTab = "overview" | "chat";
export type FactoryDisplayState = FactoryObjectiveDisplayState;
export type FactoryLifecycleStepState = "done" | "current" | "upcoming" | "paused";

export type FactoryLifecycleStepModel = {
  readonly key: string;
  readonly label: string;
  readonly state: FactoryLifecycleStepState;
};

export type FactoryEvidenceStatModel = {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly tone?: "neutral" | "info" | "success" | "warning" | "danger";
};

export type FactoryTimelineItemModel = {
  readonly key: string;
  readonly title: string;
  readonly summary: string;
  readonly meta?: string;
  readonly at?: number;
  readonly emphasis?: "accent" | "warning" | "danger" | "success" | "muted";
};

export type FactoryTimelineGroupModel = {
  readonly key: string;
  readonly title: string;
  readonly collapsedByDefault?: boolean;
  readonly items: ReadonlyArray<FactoryTimelineItemModel>;
};

export type FactoryActionModel = {
  readonly label: string;
  readonly command?: string;
  readonly tone?: "primary" | "secondary" | "danger";
  readonly focusOnly?: boolean;
};

export type FactoryChatProfileNav = {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly summary?: string;
  readonly selected: boolean;
};

export type FactoryChatObjectiveNav = {
  readonly objectiveId: string;
  readonly chatId?: string;
  readonly profileId?: string;
  readonly profileLabel?: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly displayState?: FactoryDisplayState;
  readonly phaseDetail?: FactoryObjectivePhaseDetail;
  readonly statusAuthority?: FactoryObjectiveStatusAuthority;
  readonly hasAuthoritativeLiveJob?: boolean;
  readonly blockedReason?: string;
  readonly blockedExplanation?: string;
  readonly summary?: string;
  readonly updatedAt?: number;
  readonly selected: boolean;
  readonly slotState?: string;
  readonly activeTaskCount?: number;
  readonly readyTaskCount?: number;
  readonly taskCount?: number;
  readonly integrationStatus?: string;
  readonly tokensUsed?: number;
};

export type FactoryChatJobNav = {
  readonly jobId: string;
  readonly agentId: string;
  readonly status: string;
  readonly summary: string;
  readonly runId?: string;
  readonly objectiveId?: string;
  readonly updatedAt?: number;
  readonly link?: string;
  readonly selected?: boolean;
};

export type FactorySelectedObjectiveCard = {
  readonly objectiveId: string;
  readonly profileId?: string;
  readonly profileLabel?: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly displayState?: FactoryDisplayState;
  readonly phaseDetail?: FactoryObjectivePhaseDetail;
  readonly statusAuthority?: FactoryObjectiveStatusAuthority;
  readonly hasAuthoritativeLiveJob?: boolean;
  readonly summary?: string;
  readonly bottomLine?: string;
  readonly renderedBody?: string;
  readonly latestHandoff?: FactoryObjectiveHandoffRecord;
  readonly debugLink: string;
  readonly receiptsLink: string;
  readonly nextAction?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly severity?: number;
  readonly objectiveMode?: string;
  readonly slotState?: string;
  readonly queuePosition?: number;
  readonly blockedReason?: string;
  readonly blockedExplanation?: string;
  readonly integrationStatus?: string;
  readonly activeTaskCount?: number;
  readonly readyTaskCount?: number;
  readonly taskCount?: number;
  readonly latestCommitHash?: string;
  readonly prUrl?: string;
  readonly prNumber?: number;
  readonly selfImprovement?: FactoryObjectiveSelfImprovement;
  readonly systemImprovement?: FactorySystemImprovementReport;
  readonly contract?: {
    readonly acceptanceCriteria: ReadonlyArray<string>;
    readonly allowedScope: ReadonlyArray<string>;
    readonly disallowedScope: ReadonlyArray<string>;
    readonly requiredChecks: ReadonlyArray<string>;
    readonly proofExpectation: string;
  };
  readonly alignment?: {
    readonly verdict: "aligned" | "uncertain" | "drifted";
    readonly satisfied: ReadonlyArray<string>;
    readonly missing: ReadonlyArray<string>;
    readonly outOfScope: ReadonlyArray<string>;
    readonly rationale: string;
    readonly gateStatus: "passed" | "correction_requested" | "blocked" | "not_reported";
    readonly correctiveAction?: string;
    readonly correctionAttempted: boolean;
    readonly correctedAfterReview: boolean;
    readonly sourceTaskId?: string;
    readonly sourceCandidateId?: string;
  };
  readonly checks?: ReadonlyArray<string>;
  readonly latestDecisionSummary?: string;
  readonly latestDecisionAt?: number;
  readonly tokensUsed?: number;
  readonly reviewStatus?: string;
  readonly lifecycleSteps?: ReadonlyArray<FactoryLifecycleStepModel>;
  readonly evidenceStats?: ReadonlyArray<FactoryEvidenceStatModel>;
  readonly timelineGroups?: ReadonlyArray<FactoryTimelineGroupModel>;
  readonly primaryAction?: FactoryActionModel;
  readonly secondaryActions?: ReadonlyArray<FactoryActionModel>;
};

export type FactoryLiveCodexCard = {
  readonly jobId: string;
  readonly status: string;
  readonly summary: string;
  readonly latestNote?: string;
  readonly tokensUsed?: number;
  readonly stderrTail?: string;
  readonly stdoutTail?: string;
  readonly runId?: string;
  readonly task?: string;
  readonly updatedAt?: number;
  readonly abortRequested?: boolean;
  readonly rawLink: string;
  readonly running: boolean;
};

export type FactoryLiveChildCard = {
  readonly jobId: string;
  readonly agentId: string;
  readonly worker: string;
  readonly status: string;
  readonly summary: string;
  readonly latestNote?: string;
  readonly tokensUsed?: number;
  readonly stderrTail?: string;
  readonly stdoutTail?: string;
  readonly runId?: string;
  readonly parentRunId?: string;
  readonly stream?: string;
  readonly parentStream?: string;
  readonly task?: string;
  readonly updatedAt?: number;
  readonly abortRequested?: boolean;
  readonly rawLink: string;
  readonly running: boolean;
};

export type FactoryLiveRunCard = {
  readonly runId: string;
  readonly profileLabel: string;
  readonly status: string;
  readonly summary: string;
  readonly updatedAt?: number;
  readonly lastToolName?: string;
  readonly lastToolSummary?: string;
  readonly steps?: ReadonlyArray<FactoryRunStep>;
  readonly link?: string;
};

export type FactoryRunStepKind =
  | "thought"
  | "action"
  | "tool"
  | "memory"
  | "validation";

export type FactoryRunStepTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger";

export type FactoryRunStep = {
  readonly key: string;
  readonly kind: FactoryRunStepKind;
  readonly label: string;
  readonly summary: string;
  readonly detail?: string;
  readonly meta?: string;
  readonly tone: FactoryRunStepTone;
  readonly at?: number;
  readonly active?: boolean;
};

export type FactoryProfileSectionView = {
  readonly title: string;
  readonly items: ReadonlyArray<string>;
};

export type FactoryWorkCard = {
  readonly key: string;
  readonly title: string;
  readonly worker: string;
  readonly status: string;
  readonly summary: string;
  readonly detail?: string;
  readonly meta?: string;
  readonly link?: string;
  readonly objectiveId?: string;
  readonly jobId?: string;
  readonly running?: boolean;
  readonly abortRequested?: boolean;
  readonly variant?: "live-output";
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly subject?: string;
  readonly latestNote?: string;
  readonly artifactSummary?: string;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
};

export type FactoryChatItem =
  | {
      readonly key: string;
      readonly kind: "user";
      readonly body: string;
      readonly meta?: string;
    }
  | {
      readonly key: string;
      readonly kind: "assistant";
      readonly body: string;
      readonly meta?: string;
    }
  | {
      readonly key: string;
      readonly kind: "system";
      readonly title: string;
      readonly body: string;
      readonly meta?: string;
    }
  | {
      readonly key: string;
      readonly kind: "work";
      readonly card: FactoryWorkCard;
    }
  | {
      readonly key: string;
      readonly kind: "objective_event";
      readonly title: string;
      readonly summary: string;
      readonly objectiveId: string;
    };

export type FactoryChatIslandModel = {
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly runId?: string;
  readonly knownRunIds?: ReadonlyArray<string>;
  readonly terminalRunIds?: ReadonlyArray<string>;
  readonly jobId?: string;
  readonly panel?: FactoryInspectorPanel;
  readonly inspectorTab?: FactoryInspectorTab;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly activeProfilePrimaryRole?: string;
  readonly activeProfileRoles?: ReadonlyArray<string>;
  readonly activeProfileResponsibilities?: ReadonlyArray<string>;
  readonly activeProfileSummary?: string;
  readonly activeProfileSoulSummary?: string;
  readonly activeProfileProfileSummary?: string;
  readonly activeProfileSections?: ReadonlyArray<FactoryProfileSectionView>;
  readonly activeProfileTools?: ReadonlyArray<string>;
  readonly userPreferencesSummary?: string;
  readonly selectedThread?: FactorySelectedObjectiveCard;
  readonly jobs?: ReadonlyArray<FactoryChatJobNav>;
  readonly activeCodex?: FactoryLiveCodexCard;
  readonly liveChildren?: ReadonlyArray<FactoryLiveChildCard>;
  readonly activeRun?: FactoryLiveRunCard;
  readonly workbench?: FactoryWorkbenchModel;
  readonly chatContext?: FactoryChatContextProjection;
  readonly items: ReadonlyArray<FactoryChatItem>;
};

export type FactoryInspectorPanel = "overview" | "analysis" | "execution" | "live" | "receipts";

export type FactoryInspectorRouteModel = {
  readonly panel: FactoryInspectorPanel;
  readonly inspectorTab?: FactoryInspectorTab;
  readonly activeProfileId: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
};

export type FactoryInspectorModel = FactoryInspectorRouteModel & {
  readonly objectiveMissing?: boolean;
  readonly activeProfileLabel?: string;
  readonly activeProfilePrimaryRole?: string;
  readonly activeProfileSummary?: string;
  readonly activeProfileSoulSummary?: string;
  readonly activeProfileProfileSummary?: string;
  readonly activeProfileResponsibilities?: ReadonlyArray<string>;
  readonly activeProfileSections?: ReadonlyArray<FactoryProfileSectionView>;
  readonly selectedObjective?: FactorySelectedObjectiveCard;
  readonly activeCodex?: FactoryLiveCodexCard;
  readonly liveChildren?: ReadonlyArray<FactoryLiveChildCard>;
  readonly activeRun?: FactoryLiveRunCard;
  readonly workbench?: FactoryWorkbenchModel;
  readonly chatContext?: FactoryChatContextProjection;
  readonly jobs: ReadonlyArray<FactoryChatJobNav>;
  readonly analysis?: ObjectiveAnalysis;
  readonly receipts?: FactoryObjectiveDetail["recentReceipts"];
  readonly debugInfo?: FactoryState;
  readonly tasks?: FactoryObjectiveDetail["tasks"];
};

export type FactoryWorkbenchWorkspaceModel = {
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly chatId: string;
  readonly objectiveId?: string;
  readonly inspectorTab?: FactoryInspectorTab;
  readonly detailTab: FactoryWorkbenchDetailTab;
  readonly page: number;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly filter: FactoryWorkbenchFilterKey;
  readonly filters: ReadonlyArray<FactoryWorkbenchFilterModel>;
  readonly selectedObjective?: FactorySelectedObjectiveCard;
  readonly activeCodex?: FactoryLiveCodexCard;
  readonly liveChildren?: ReadonlyArray<FactoryLiveChildCard>;
  readonly activeRun?: FactoryLiveRunCard;
  readonly workbench?: FactoryWorkbenchModel;
  readonly board: FactoryBoardProjection;
  readonly activeObjectives: ReadonlyArray<FactoryChatObjectiveNav>;
  readonly pastObjectives: ReadonlyArray<FactoryChatObjectiveNav>;
  readonly blocks: ReadonlyArray<FactoryWorkbenchBlockModel>;
};

export type FactoryWorkbenchPageModel = {
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly chatId: string;
  readonly objectiveId?: string;
  readonly inspectorTab?: FactoryInspectorTab;
  readonly detailTab: FactoryWorkbenchDetailTab;
  readonly page: number;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly filter: FactoryWorkbenchFilterKey;
  readonly profiles: ReadonlyArray<FactoryChatProfileNav>;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly chat: FactoryChatIslandModel;
  readonly inspector?: FactoryInspectorModel;
};

export type WorkbenchVersionEnvelope = {
  readonly routeKey: string;
  readonly profileId: string;
  readonly chatId: string;
  readonly objectiveId?: string;
  readonly boardVersion: string;
  readonly focusVersion: string;
  readonly chatVersion: string;
};

export type FactoryWorkbenchFilterKey =
  | "objective.running"
  | "objective.needs_attention"
  | "objective.queued"
  | "objective.completed";

export const DEFAULT_FACTORY_WORKBENCH_FILTER: FactoryWorkbenchFilterKey = "objective.running";

export type FactoryWorkbenchDetailTab =
  | "action"
  | "review"
  | "queue";

export type FactoryWorkbenchFilterModel = {
  readonly key: FactoryWorkbenchFilterKey;
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
};

export type FactoryWorkbenchStatModel = {
  readonly key: string;
  readonly label: string;
  readonly value: string;
};

export type FactoryWorkbenchSummarySectionModel = {
  readonly key: string;
  readonly title: string;
  readonly shape: "summary";
  readonly empty: boolean;
  readonly eyebrow?: string;
  readonly headline: string;
  readonly message: string;
  readonly tokenCount?: string;
  readonly stats: ReadonlyArray<FactoryWorkbenchStatModel>;
  readonly objective?: FactorySelectedObjectiveCard;
  readonly systemImprovement?: FactorySystemImprovementReport;
  readonly currentRun?: FactoryLiveRunCard;
  readonly focus?: {
    readonly title: string;
    readonly summary: string;
    readonly status: string;
    readonly active?: boolean;
    readonly jobId?: string;
    readonly taskId?: string;
    readonly candidateId?: string;
    readonly lastMessage?: string;
    readonly stdoutTail?: string;
    readonly stderrTail?: string;
    readonly loading?: {
      readonly label: string;
      readonly summary: string;
      readonly detail?: string;
      readonly highlights?: ReadonlyArray<string>;
      readonly nextAction?: string;
      readonly tone: "info" | "warning" | "danger" | "success";
    };
  };
  readonly latestDecisionSummary?: string;
  readonly latestDecisionAt?: number;
  readonly activityCount: number;
  readonly activityItems: ReadonlyArray<FactoryWorkbenchActivityItemModel>;
};

export type FactoryWorkbenchObjectiveListSectionModel = {
  readonly key: string;
  readonly title: string;
  readonly shape: "objective-list";
  readonly count: number;
  readonly emptyMessage: string;
  readonly items: ReadonlyArray<FactoryChatObjectiveNav>;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly hasPreviousPage: boolean;
  readonly hasNextPage: boolean;
};

export type FactoryWorkbenchActivityItemModel = {
  readonly key: string;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly meta?: string;
  readonly at?: number;
};

export type FactoryWorkbenchActivitySectionModel = {
  readonly key: string;
  readonly title: string;
  readonly shape: "activity-list";
  readonly count: number;
  readonly emptyMessage: string;
  readonly items: ReadonlyArray<FactoryWorkbenchActivityItemModel>;
  readonly timelineGroups?: ReadonlyArray<FactoryTimelineGroupModel>;
  readonly callout?: string;
  readonly focus?: {
    readonly title: string;
    readonly summary: string;
    readonly status: string;
    readonly active?: boolean;
    readonly jobId?: string;
    readonly taskId?: string;
    readonly candidateId?: string;
    readonly lastMessage?: string;
    readonly stdoutTail?: string;
    readonly stderrTail?: string;
    readonly loading?: {
      readonly label: string;
      readonly summary: string;
      readonly detail?: string;
      readonly highlights?: ReadonlyArray<string>;
      readonly nextAction?: string;
      readonly tone: "info" | "warning" | "danger" | "success";
    };
  };
  readonly run?: FactoryLiveRunCard;
};

export type FactoryWorkbenchSectionModel =
  | FactoryWorkbenchSummarySectionModel
  | FactoryWorkbenchObjectiveListSectionModel
  | FactoryWorkbenchActivitySectionModel;

export type FactoryWorkbenchBlockModel = {
  readonly key: string;
  readonly layout: "full" | "split";
  readonly sections: ReadonlyArray<FactoryWorkbenchSectionModel>;
};
