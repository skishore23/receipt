import type { JsonlQueue } from "../adapters/jsonl-queue.js";
import type { Runtime } from "../core/runtime.js";
import { makeEventId } from "../framework/http.js";
import type { FailureRecord } from "../modules/failure.js";
import type { TheoremCmd, TheoremEvent, TheoremState } from "../modules/theorem.js";
import type { TheoremFailureClass, TheoremRunResult } from "./theorem.result.js";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const isRecoveryFailure = (failureClass: TheoremFailureClass | undefined): failureClass is TheoremFailureClass =>
  failureClass === "missing_final_verify_receipt"
  || failureClass === "artifact_mismatch"
  || failureClass === "axle_verify_failed";

const buildFollowUpProblem = (opts: {
  readonly originalProblem: string;
  readonly sourceJobId: string;
  readonly sourceRunId: string;
  readonly failureClass: TheoremFailureClass;
  readonly verifierNote?: string;
  readonly failure?: FailureRecord;
  readonly verificationStatus?: string;
  readonly verificationReport?: string;
  readonly verificationEvidence?: Record<string, unknown>;
  readonly finalProof?: string;
}): string => {
  const sections: string[] = [
    "Continue the prior Axiom Guild run after final AXLE verification failed.",
    "",
    `Source job: ${opts.sourceJobId}`,
    `Source run: ${opts.sourceRunId}`,
    `Failure class: ${opts.failureClass}`,
    ...(opts.verificationStatus ? [`Verification status: ${opts.verificationStatus}`] : []),
    "",
    "Original problem:",
    opts.originalProblem,
  ];

  if (opts.finalProof) {
    sections.push("", "Latest candidate proof:", opts.finalProof);
  }
  if (opts.verifierNote) {
    sections.push("", "Verifier note:", opts.verifierNote);
  }
  if (opts.failure) {
    sections.push("", "Structured terminal failure:", JSON.stringify(opts.failure, null, 2));
  }
  if (opts.verificationReport) {
    sections.push("", "AXLE verification report:", opts.verificationReport);
  }
  if (opts.verificationEvidence) {
    sections.push("", "Latest AXLE validation details:", JSON.stringify(opts.verificationEvidence, null, 2));
  }

  sections.push(
    "",
    "Task:",
    "Plan the next attempt from these AXLE diagnostics. Use search, check, rename, decomposition, or repair steps as needed, but treat AXLE verification as the final gate."
  );
  return sections.join("\n").trim();
};

const emitFailureNote = async (opts: {
  readonly runtime: Runtime<TheoremCmd, TheoremEvent, TheoremState>;
  readonly baseStream: string;
  readonly runStream: string;
  readonly runId: string;
  readonly note: string;
}): Promise<void> => {
  const event: TheoremEvent = {
    type: "run.status",
    runId: opts.runId,
    status: "failed",
    agentId: "orchestrator",
    note: opts.note,
  };
  await opts.runtime.execute(opts.runStream, {
    type: "emit",
    event,
    eventId: makeEventId(opts.runStream),
  });
  await opts.runtime.execute(opts.baseStream, {
    type: "emit",
    event,
    eventId: makeEventId(opts.baseStream),
  });
};

export type AxiomGuildRecoveryResult = {
  readonly followUpJobId?: string;
  readonly followUpRunId?: string;
  readonly failureClass?: TheoremFailureClass;
  readonly note?: string;
};

export const maybeQueueAxiomGuildVerifyFailureFollowUp = async (opts: {
  readonly queue: JsonlQueue;
  readonly theoremRuntime: Runtime<TheoremCmd, TheoremEvent, TheoremState>;
  readonly payload: Record<string, unknown>;
  readonly result: TheoremRunResult;
  readonly jobId: string;
  readonly onJobQueued?: (jobId: string) => void;
  readonly onReceipt?: () => void;
}): Promise<AxiomGuildRecoveryResult> => {
  if (opts.result.status !== "failed" || !isRecoveryFailure(opts.result.failureClass)) {
    return {};
  }
  if (opts.payload.autoFollowUp === true || asString(opts.payload.followUpOfJobId)) {
    return {
      failureClass: opts.result.failureClass,
      note: opts.result.note,
    };
  }

  const stream = asString(opts.payload.stream) ?? opts.result.stream;
  const originalProblem = asString(opts.payload.problem) ?? "";
  const config = asRecord(opts.payload.config);
  const followUpRunId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const followUpProblem = buildFollowUpProblem({
    originalProblem,
    sourceJobId: opts.jobId,
    sourceRunId: opts.result.runId,
    failureClass: opts.result.failureClass,
    verifierNote: opts.result.note,
    failure: opts.result.failure,
    verificationStatus: opts.result.verificationStatus,
    verificationReport: opts.result.verificationReport,
    verificationEvidence: opts.result.verificationEvidence ? { ...opts.result.verificationEvidence } : undefined,
    finalProof: opts.result.finalProof,
  });

  const followUpJob = await opts.queue.enqueue({
    agentId: "axiom-guild",
    lane: "follow_up",
    sessionKey: `axiom-guild:auto-follow-up:${opts.jobId}`,
    singletonMode: "cancel",
    maxAttempts: 2,
    payload: {
      kind: asString(opts.payload.kind) ?? "axiom-guild.run",
      stream,
      runId: followUpRunId,
      problem: followUpProblem,
      ...(config ? { config: { ...config } } : {}),
      autoFollowUp: true,
      followUpOfJobId: opts.jobId,
      followUpOfRunId: opts.result.runId,
      failureClass: opts.result.failureClass,
      failure: opts.result.failure ? { ...opts.result.failure } : undefined,
    },
  });

  const note = `${opts.result.note ?? "Final AXLE verification failed."} Follow-up queued: ${followUpJob.id} (${followUpRunId}).`;
  await emitFailureNote({
    runtime: opts.theoremRuntime,
    baseStream: opts.result.stream,
    runStream: opts.result.runStream,
    runId: opts.result.runId,
    note,
  });
  opts.onJobQueued?.(followUpJob.id);
  opts.onJobQueued?.(opts.jobId);
  opts.onReceipt?.();
  return {
    followUpJobId: followUpJob.id,
    followUpRunId,
    failureClass: opts.result.failureClass,
    note,
  };
};
