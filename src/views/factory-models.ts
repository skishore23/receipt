import type { ObjectiveAnalysis } from "../factory-cli/analyze";
import type { FactoryState } from "../modules/factory";
import type { FactoryBoardProjection, FactoryObjectiveDetail } from "../services/factory-types";
import type { FactoryWorkbenchModel } from "./factory-workbench";

export type FactoryViewMode = "default" | "mission-control";

export type FactoryChatProfileNav = {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly summary?: string;
  readonly selected: boolean;
};

export type FactoryChatObjectiveNav = {
  readonly objectiveId: string;
  readonly profileId?: string;
  readonly profileLabel?: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
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
  readonly summary?: string;
  readonly debugLink: string;
  readonly receiptsLink: string;
  readonly nextAction?: string;
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
  readonly checks?: ReadonlyArray<string>;
  readonly latestDecisionSummary?: string;
  readonly latestDecisionAt?: number;
  readonly tokensUsed?: number;
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
  readonly mode?: FactoryViewMode;
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly runId?: string;
  readonly knownRunIds?: ReadonlyArray<string>;
  readonly terminalRunIds?: ReadonlyArray<string>;
  readonly jobId?: string;
  readonly panel?: FactoryInspectorPanel;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly activeProfilePrimaryRole?: string;
  readonly activeProfileRoles?: ReadonlyArray<string>;
  readonly activeProfileResponsibilities?: ReadonlyArray<string>;
  readonly activeProfileSummary?: string;
  readonly activeProfileSections?: ReadonlyArray<FactoryProfileSectionView>;
  readonly activeProfileTools?: ReadonlyArray<string>;
  readonly selectedThread?: FactorySelectedObjectiveCard;
  readonly jobs?: ReadonlyArray<FactoryChatJobNav>;
  readonly activeCodex?: FactoryLiveCodexCard;
  readonly liveChildren?: ReadonlyArray<FactoryLiveChildCard>;
  readonly activeRun?: FactoryLiveRunCard;
  readonly workbench?: FactoryWorkbenchModel;
  readonly items: ReadonlyArray<FactoryChatItem>;
};

export type FactoryNavModel = {
  readonly mode?: FactoryViewMode;
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly chatId?: string;
  readonly panel?: FactoryInspectorPanel;
  readonly profiles: ReadonlyArray<FactoryChatProfileNav>;
  readonly objectives: ReadonlyArray<FactoryChatObjectiveNav>;
  readonly showAll?: boolean;
};

export type FactoryInspectorPanel = "overview" | "analysis" | "execution" | "live" | "receipts";

export type FactoryInspectorRouteModel = {
  readonly mode?: FactoryViewMode;
  readonly panel: FactoryInspectorPanel;
  readonly activeProfileId: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
};

export type FactoryInspectorTabsModel = FactoryInspectorRouteModel;

export type FactoryInspectorModel = FactoryInspectorRouteModel & {
  readonly objectiveMissing?: boolean;
  readonly selectedObjective?: FactorySelectedObjectiveCard;
  readonly activeCodex?: FactoryLiveCodexCard;
  readonly liveChildren?: ReadonlyArray<FactoryLiveChildCard>;
  readonly activeRun?: FactoryLiveRunCard;
  readonly workbench?: FactoryWorkbenchModel;
  readonly jobs: ReadonlyArray<FactoryChatJobNav>;
  readonly analysis?: ObjectiveAnalysis;
  readonly receipts?: FactoryObjectiveDetail["recentReceipts"];
  readonly debugInfo?: FactoryState;
  readonly tasks?: FactoryObjectiveDetail["tasks"];
};

export type FactoryChatShellModel = {
  readonly mode?: FactoryViewMode;
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly panel?: FactoryInspectorPanel;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly chat: FactoryChatIslandModel;
  readonly nav: FactoryNavModel;
  readonly inspector: FactoryInspectorModel;
};

export type FactoryWorkbenchWorkspaceModel = {
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly objectiveId?: string;
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
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly filter: FactoryWorkbenchFilterKey;
  readonly profiles: ReadonlyArray<FactoryChatProfileNav>;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly chat: FactoryChatIslandModel;
};

export type FactoryWorkbenchFilterKey =
  | "all"
  | "objective.running"
  | "objective.needs_attention"
  | "objective.queued"
  | "objective.completed";

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
};

export type FactoryWorkbenchObjectiveListSectionModel = {
  readonly key: string;
  readonly title: string;
  readonly shape: "objective-list";
  readonly count: number;
  readonly emptyMessage: string;
  readonly items: ReadonlyArray<FactoryChatObjectiveNav>;
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
  readonly callout?: string;
  readonly focus?: {
    readonly title: string;
    readonly summary: string;
    readonly status: string;
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
