import type { Tone } from "../ui";

export type RuntimeQueueSummary = {
  readonly total: number;
  readonly queued: number;
  readonly leased: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly canceled: number;
  readonly updatedAt?: number;
  readonly approximate: boolean;
  readonly visibleJobs: number;
};

export type RuntimeObjectiveCard = {
  readonly objectiveId: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly scheduler: string;
  readonly integrationStatus: string;
  readonly activeTaskCount: number;
  readonly readyTaskCount: number;
  readonly taskCount: number;
  readonly profileId?: string;
  readonly updatedAt?: number;
  readonly summary?: string;
};

export type RuntimeJobCard = {
  readonly jobId: string;
  readonly agentId: string;
  readonly lane: string;
  readonly kind?: string;
  readonly status: string;
  readonly objectiveId?: string;
  readonly runId?: string;
  readonly stream?: string;
  readonly updatedAt?: number;
  readonly leaseUntil?: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly summary: string;
};

export type RuntimeRunCard = {
  readonly runId: string;
  readonly stream: string;
  readonly status: string;
  readonly objectiveId?: string;
  readonly iteration: number;
  readonly toolCount: number;
  readonly lastTool?: string;
  readonly updatedAt?: number;
  readonly worker?: string;
  readonly problem?: string;
  readonly summary: string;
};

export type RuntimeActivityItem = {
  readonly id: string;
  readonly kind: "objective" | "job" | "run";
  readonly title: string;
  readonly summary: string;
  readonly at?: number;
  readonly tone: Tone;
};

export type RuntimeStoreMetric = {
  readonly name: string;
  readonly kind: string;
  readonly description: string;
  readonly count: number;
  readonly updatedAt?: number;
};

export type RuntimeSystemMetrics = {
  readonly recentReceiptCount: number;
  readonly receiptWindowMinutes: number;
  readonly jobProjectionCount: number;
  readonly objectiveProjectionCount: number;
  readonly chatProjectionCount: number;
  readonly memoryEntryCount: number;
  readonly streamCount: number;
  readonly receiptCount: number;
  readonly changeCount: number;
  readonly branchCount: number;
  readonly recentBackgroundJobCount: number;
  readonly visibleToolCallCount: number;
  readonly delegatedJobCount: number;
  readonly activeChildJobCount: number;
  readonly mergedChildRunCount: number;
  readonly latestLeaseUntil?: number;
  readonly activeObjectiveTitles: ReadonlyArray<string>;
  readonly recentToolNames: ReadonlyArray<string>;
};

export type RuntimeDashboardModel = {
  readonly generatedAt: number;
  readonly queue: RuntimeQueueSummary;
  readonly objectiveCount: number;
  readonly activeObjectiveCount: number;
  readonly liveRunCount: number;
  readonly latestUpdateAt?: number;
  readonly objectives: ReadonlyArray<RuntimeObjectiveCard>;
  readonly jobs: ReadonlyArray<RuntimeJobCard>;
  readonly runs: ReadonlyArray<RuntimeRunCard>;
  readonly activity: ReadonlyArray<RuntimeActivityItem>;
  readonly stores: ReadonlyArray<RuntimeStoreMetric>;
  readonly metrics: RuntimeSystemMetrics;
};
