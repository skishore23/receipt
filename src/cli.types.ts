export type FlagValue = string | boolean | ReadonlyArray<string>;

export type Flags = Readonly<Record<string, FlagValue>>;
