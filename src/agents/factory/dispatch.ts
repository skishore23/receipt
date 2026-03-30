export type FactoryDispatchAction = "create" | "react" | "promote" | "cancel" | "cleanup" | "archive";
export type FactoryDispatchObjectiveMode = "delivery" | "investigation";

export type NormalizedFactoryDispatchInput = {
  readonly rawAction?: string;
  readonly action?: FactoryDispatchAction;
  readonly objectiveId?: string;
  readonly prompt?: string;
  readonly note?: string;
  readonly title?: string;
  readonly baseHash?: string;
  readonly objectiveMode?: FactoryDispatchObjectiveMode;
  readonly severity?: 1 | 2 | 3 | 4 | 5;
  readonly checks: ReadonlyArray<string>;
  readonly channel?: string;
  readonly profileId?: string;
  readonly reason?: string;
};

const FACTORY_DISPATCH_ACTIONS = new Set<FactoryDispatchAction>([
  "create",
  "react",
  "promote",
  "cancel",
  "cleanup",
  "archive",
]);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asStringList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
    : [];

const firstString = (...values: Array<string | undefined>): string | undefined =>
  values.find((value) => Boolean(value));

const looksLikeObjectiveId = (value: string): boolean =>
  /^objective_[a-z0-9]+(?:_[a-z0-9]+)*$/i.test(value);

const parseObjectiveMode = (value: unknown): FactoryDispatchObjectiveMode | undefined => {
  const mode = asString(value);
  if (mode === "delivery" || mode === "investigation") return mode;
  return undefined;
};

const parseSeverity = (value: unknown): 1 | 2 | 3 | 4 | 5 | undefined => {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < 1 || value > 5) return undefined;
  return value as 1 | 2 | 3 | 4 | 5;
};

export const normalizeFactoryDispatchInput = (value: unknown): NormalizedFactoryDispatchInput => {
  const record = asRecord(value) ?? {};
  const rawAction = asString(record.action);
  const action = rawAction && FACTORY_DISPATCH_ACTIONS.has(rawAction as FactoryDispatchAction)
    ? rawAction as FactoryDispatchAction
    : undefined;
  const objectiveText = (() => {
    const candidate = asString(record.objective);
    return candidate && !looksLikeObjectiveId(candidate) ? candidate : undefined;
  })();
  const explicitPrompt = asString(record.prompt);
  const explicitNote = asString(record.note);
  const aliasDescription = asString(record.description);
  const aliasTask = asString(record.task);
  const aliasInstructions = asString(record.instructions);
  const aliasRequest = asString(record.request);
  const aliasProblem = asString(record.problem);
  const aliasNotes = asString(record.notes);
  const aliasMessage = asString(record.message);
  const titleFromObjective = objectiveText && firstString(
    explicitPrompt,
    aliasDescription,
    aliasTask,
    aliasInstructions,
    aliasRequest,
    aliasProblem,
    aliasNotes,
    aliasMessage,
  )
    ? objectiveText
    : undefined;
  return {
    rawAction,
    action,
    objectiveId: asString(record.objectiveId),
    prompt: firstString(
      explicitPrompt,
      aliasDescription,
      aliasTask,
      aliasInstructions,
      aliasRequest,
      aliasProblem,
      aliasNotes,
      aliasMessage,
      objectiveText,
    ),
    note: firstString(
      explicitNote,
      aliasNotes,
      aliasMessage,
      aliasDescription,
      aliasTask,
      aliasInstructions,
      aliasRequest,
      aliasProblem,
      explicitPrompt,
      objectiveText,
    ),
    title: firstString(
      asString(record.title),
      asString(record.objectiveName),
      asString(record.objective_name),
      asString(record.name),
      titleFromObjective,
    ),
    baseHash: asString(record.baseHash),
    objectiveMode: parseObjectiveMode(record.objectiveMode ?? record.mode),
    severity: parseSeverity(record.severity),
    checks: asStringList(record.checks),
    channel: asString(record.channel),
    profileId: asString(record.profileId),
    reason: asString(record.reason),
  };
};

export const resolveFactoryDispatchAction = (
  input: NormalizedFactoryDispatchInput,
  objectiveId: string | undefined,
): FactoryDispatchAction => {
  if (input.rawAction && !input.action) {
    throw new Error(`unsupported factory.dispatch action '${input.rawAction}'`);
  }
  return input.action ?? (objectiveId ? "react" : "create");
};

export const isObjectiveContinuationBoundary = (input: {
  readonly status?: unknown;
  readonly archivedAt?: unknown;
}): boolean =>
  Boolean(input.archivedAt)
  || input.status === "blocked"
  || input.status === "completed"
  || input.status === "failed"
  || input.status === "canceled";
