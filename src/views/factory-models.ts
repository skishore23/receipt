export type FactoryChatProfileNav = {
  readonly id: string;
  readonly label: string;
  readonly summary?: string;
  readonly selected: boolean;
};

export type FactoryChatObjectiveNav = {
  readonly objectiveId: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly summary?: string;
  readonly updatedAt?: number;
  readonly selected: boolean;
  readonly slotState?: string;
  readonly activeTaskCount?: number;
  readonly readyTaskCount?: number;
  readonly taskCount?: number;
  readonly integrationStatus?: string;
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
  readonly repoProfileStatus?: string;
  readonly latestCommitHash?: string;
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
  readonly link?: string;
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
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly activeProfileSummary?: string;
  readonly activeProfileSections?: ReadonlyArray<FactoryProfileSectionView>;
  readonly activeProfileTools?: ReadonlyArray<string>;
  readonly selectedThread?: FactorySelectedObjectiveCard;
  readonly jobs?: ReadonlyArray<FactoryChatJobNav>;
  readonly activeCodex?: FactoryLiveCodexCard;
  readonly liveChildren?: ReadonlyArray<FactoryLiveChildCard>;
  readonly activeRun?: FactoryLiveRunCard;
  readonly items: ReadonlyArray<FactoryChatItem>;
};

export type FactoryNavModel = {
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly profiles: ReadonlyArray<FactoryChatProfileNav>;
  readonly objectives: ReadonlyArray<FactoryChatObjectiveNav>;
  readonly showAll?: boolean;
};

export type FactoryInspectorPanel = "overview" | "execution" | "live" | "receipts" | "debug";

export type FactoryInspectorModel = {
  readonly panel: FactoryInspectorPanel;
  readonly selectedObjective?: FactorySelectedObjectiveCard;
  readonly activeCodex?: FactoryLiveCodexCard;
  readonly liveChildren?: ReadonlyArray<FactoryLiveChildCard>;
  readonly activeRun?: FactoryLiveRunCard;
  readonly jobs: ReadonlyArray<FactoryChatJobNav>;
  readonly receipts?: ReadonlyArray<any>;
  readonly debugInfo?: any;
  readonly tasks?: ReadonlyArray<any>;
};

export type FactoryChatShellModel = {
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly chat: FactoryChatIslandModel;
  readonly nav: FactoryNavModel;
  readonly inspector: FactoryInspectorModel;
};
