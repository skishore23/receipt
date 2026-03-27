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
