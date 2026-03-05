import type { AgentAction } from "../../sdk/actions.js";

export type SelectionReason =
  | "declaration-order"
  | "exclusive"
  | "concurrency-cap"
  | "settled";

export type SelectionResult<View, EmitFn> = {
  readonly selected: ReadonlyArray<AgentAction<View, EmitFn>>;
  readonly reason: SelectionReason;
};

export const SCHEDULER_POLICY_VERSION = "scheduler-v1";

export const selectDeterministicActions = <View, EmitFn>(
  runnable: ReadonlyArray<AgentAction<View, EmitFn>>,
  defaultMaxConcurrency = 1
): SelectionResult<View, EmitFn> => {
  if (runnable.length === 0) {
    return { selected: [], reason: "settled" };
  }

  const ordered = [...runnable];
  const exclusive = ordered.find((a) => a.exclusive);
  if (exclusive) {
    return { selected: [exclusive], reason: "exclusive" };
  }

  const hardCap = Math.max(
    1,
    ordered.reduce((min, action) => {
      if (typeof action.maxConcurrency !== "number") return min;
      return Math.min(min, Math.max(1, Math.floor(action.maxConcurrency)));
    }, Math.max(1, defaultMaxConcurrency))
  );

  return {
    selected: ordered.slice(0, hardCap),
    reason: hardCap < ordered.length ? "concurrency-cap" : "declaration-order",
  };
};
