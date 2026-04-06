export type FailureStage =
  | "model_json"
  | "verification"
  | "finalizer"
  | "budget"
  | "runtime";

export type FailureRecord = {
  readonly stage: FailureStage;
  readonly failureClass: string;
  readonly message: string;
  readonly details?: string;
  readonly retryable?: boolean;
  readonly iteration?: number;
  readonly tool?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
};

export type FailureStateRecord = FailureRecord & {
  readonly updatedAt: number;
};

export const cloneFailureRecord = (failure: FailureRecord): FailureRecord => ({
  ...failure,
  evidence: failure.evidence ? { ...failure.evidence } : undefined,
});
