export type FactoryLiveScopePayload = {
  readonly profileId?: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly runId?: string;
  readonly jobId?: string;
};

export type FactoryComposeResponseBody = {
  readonly location?: string;
  readonly live?: FactoryLiveScopePayload;
  readonly chat?: {
    readonly chatId?: string;
  };
  readonly selection?: {
    readonly objectiveId?: string;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
  };
  readonly queueDepth?: number;
  readonly error?: string;
};

export type FactoryChatIslandState = {
  readonly activeProfileLabel?: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly activeRunId?: string;
  readonly knownRunIds: ReadonlyArray<string>;
  readonly terminalRunIds: ReadonlyArray<string>;
};
