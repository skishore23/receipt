// ============================================================================
// Branch Metadata Module - receipt-native branch index
// ============================================================================

import type { Branch, Reducer } from "@receipt/core/types";

export type BranchMetaEvent = {
  readonly type: "branch.meta.upsert";
  readonly branch: Branch;
};

export type BranchMetaState = {
  readonly branches: Readonly<Record<string, Branch>>;
};

export const initial: BranchMetaState = {
  branches: {},
};

export const reduce: Reducer<BranchMetaState, BranchMetaEvent> = (state, event) => {
  switch (event.type) {
    case "branch.meta.upsert":
      return {
        ...state,
        branches: {
          ...state.branches,
          [event.branch.name]: event.branch,
        },
      };
    default:
      return state;
  }
};
