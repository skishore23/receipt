export const FACTORY_DISPATCH_ACTIONS = [
  "create",
  "react",
  "promote",
  "cancel",
  "cleanup",
  "archive",
] as const;

export const FACTORY_DISPATCH_OBJECTIVE_MODES = [
  "delivery",
  "investigation",
] as const;

export type FactoryDispatchAction = typeof FACTORY_DISPATCH_ACTIONS[number];
export type FactoryDispatchObjectiveMode = typeof FACTORY_DISPATCH_OBJECTIVE_MODES[number];

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
  readonly reason?: string;
};

const FACTORY_DISPATCH_ACTION_SET = new Set<FactoryDispatchAction>(FACTORY_DISPATCH_ACTIONS);

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
  const action = rawAction && FACTORY_DISPATCH_ACTION_SET.has(rawAction as FactoryDispatchAction)
    ? rawAction as FactoryDispatchAction
    : undefined;
  return {
    rawAction,
    action,
    objectiveId: asString(record.objectiveId),
    prompt: asString(record.prompt),
    note: asString(record.note),
    title: asString(record.title),
    baseHash: asString(record.baseHash),
    objectiveMode: parseObjectiveMode(record.objectiveMode),
    severity: parseSeverity(record.severity),
    checks: asStringList(record.checks),
    channel: asString(record.channel),
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
