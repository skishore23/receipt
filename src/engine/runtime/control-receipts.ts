export type ControlReceipt =
  | {
      readonly type: "run.started";
      readonly runId: string;
      readonly agentId: string;
      readonly agentVersion: string;
      readonly runtimePolicyVersion: string;
      readonly mergePolicyVersion?: string;
    }
  | {
      readonly type: "run.completed";
      readonly runId: string;
      readonly note?: string;
    }
  | {
      readonly type: "run.failed";
      readonly runId: string;
      readonly error: string;
    }
  | {
      readonly type: "action.selected";
      readonly runId: string;
      readonly actionIds: ReadonlyArray<string>;
      readonly reason: string;
      readonly policyVersion: string;
    }
  | {
      readonly type: "action.started";
      readonly runId: string;
      readonly actionId: string;
      readonly kind?: string;
    }
  | {
      readonly type: "action.completed";
      readonly runId: string;
      readonly actionId: string;
      readonly kind?: string;
    }
  | {
      readonly type: "action.failed";
      readonly runId: string;
      readonly actionId: string;
      readonly kind?: string;
      readonly error: string;
    }
  | {
      readonly type: "human.requested";
      readonly runId: string;
      readonly actionId: string;
      readonly note?: string;
    }
  | {
      readonly type: "human.responded";
      readonly runId: string;
      readonly actionId: string;
      readonly note?: string;
    }
  | {
      readonly type: "goal.completed";
      readonly runId: string;
      readonly note?: string;
    }
  | {
      readonly type: "merge.applied";
      readonly runId: string;
      readonly mergePolicyId: string;
      readonly mergePolicyVersion: string;
      readonly candidateId: string;
      readonly reason?: string;
    };

export const CONTROL_POLICY_VERSION = "runtime-policy-v1";

export const CONTROL_RECEIPT_TYPES = new Set<ControlReceipt["type"]>([
  "run.started",
  "run.completed",
  "run.failed",
  "action.selected",
  "action.started",
  "action.completed",
  "action.failed",
  "human.requested",
  "human.responded",
  "goal.completed",
  "merge.applied",
]);
