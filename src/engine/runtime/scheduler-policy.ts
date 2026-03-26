import type { AgentAction } from "../../sdk/actions";

export type SelectionReason =
  | "priority-order"
  | "exclusive"
  | "concurrency-cap"
  | "settled";

export type SelectionResult<View, EmitFn> = {
  readonly selected: ReadonlyArray<AgentAction<View, EmitFn>>;
  readonly reason: SelectionReason;
};

export const SCHEDULER_POLICY_VERSION = "scheduler-v2";

const actionPriority = (kind: AgentAction<unknown, unknown>["kind"]): number => {
  switch (kind) {
    case "human":
      return 0;
    case "assistant":
      return 1;
    case "action":
      return 2;
    case "tool":
    default:
      return 3;
  }
};

export const selectDeterministicActions = <View, EmitFn>(
  runnable: ReadonlyArray<AgentAction<View, EmitFn>>,
  defaultMaxConcurrency = 1
): SelectionResult<View, EmitFn> => {
  if (runnable.length === 0) {
    return { selected: [], reason: "settled" };
  }

  const ordered = [...runnable].sort((left, right) =>
    actionPriority(left.kind) - actionPriority(right.kind)
  );
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
    reason: hardCap < ordered.length ? "concurrency-cap" : "priority-order",
  };
};
