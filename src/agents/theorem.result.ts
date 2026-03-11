import type { TheoremAxiomEvidence, TheoremState } from "../modules/theorem.js";
import type { FailureRecord } from "../modules/failure.js";

export type TheoremFailureClass =
  | "missing_final_verify_receipt"
  | "artifact_mismatch"
  | "axle_verify_failed";

const withoutUpdatedAt = (failure: TheoremState["failure"] | undefined): FailureRecord | undefined => {
  if (!failure) return undefined;
  const { updatedAt: _updatedAt, ...rest } = failure;
  return {
    ...rest,
    evidence: rest.evidence ? { ...rest.evidence } : undefined,
  };
};

export type TheoremRunResult = {
  readonly runId: string;
  readonly stream: string;
  readonly runStream: string;
  readonly status: TheoremState["status"];
  readonly note?: string;
  readonly failure?: FailureRecord;
  readonly verificationStatus?: NonNullable<TheoremState["verification"]>["status"];
  readonly verificationReport?: string;
  readonly verificationEvidence?: TheoremAxiomEvidence;
  readonly failureClass?: TheoremFailureClass;
  readonly finalProof?: string;
};

export const classifyTheoremFailure = (
  verification: TheoremState["verification"] | undefined,
  requiresFinalAxiomVerify: boolean
): TheoremFailureClass | undefined => {
  if (!requiresFinalAxiomVerify || !verification || verification.status === "valid") return undefined;
  const report = verification.content;
  if (/AXIOM verification evidence missing/i.test(report)) return "missing_final_verify_receipt";
  if (/AXIOM artifact mismatch/i.test(report)) return "artifact_mismatch";
  return "axle_verify_failed";
};

export const buildTheoremRunResult = (opts: {
  readonly runId: string;
  readonly stream: string;
  readonly runStream: string;
  readonly state: TheoremState;
  readonly requiresFinalAxiomVerify: boolean;
}): TheoremRunResult => ({
  runId: opts.runId,
  stream: opts.stream,
  runStream: opts.runStream,
  status: opts.state.status,
  note: opts.state.statusNote,
  failure: withoutUpdatedAt(opts.state.failure),
  verificationStatus: opts.state.verification?.status,
  verificationReport: opts.state.verification?.content,
  verificationEvidence: opts.state.verification?.evidence,
  failureClass: classifyTheoremFailure(opts.state.verification, opts.requiresFinalAxiomVerify),
  finalProof: opts.state.solution?.content,
});
