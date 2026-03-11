import type { Runtime } from "../core/runtime.js";
import type { AxiomSimpleCmd, AxiomSimpleEvent, AxiomSimpleState, AxiomSimpleVerificationStatus, AxiomSimpleWorkerPhase, AxiomSimpleWorkerSnapshot, AxiomSimpleWorkerStatus, AxiomSimpleWorkerStrategy, AxiomSimpleWorkerValidation } from "../modules/axiom-simple.js";
import type { FailureRecord } from "../modules/failure.js";
import { clampNumber, createQueuedEmitter, getLatestRunId, parseFormNum, type AgentRunControl } from "../engine/runtime/workflow.js";
import { axiomSimpleRunStream } from "./axiom-simple.streams.js";

export const AXIOM_SIMPLE_WORKFLOW_ID = "axiom-simple-v1";
export const AXIOM_SIMPLE_WORKFLOW_VERSION = "1.0.0";

export type AxiomSimpleRunConfig = {
  readonly workerCount: 2 | 3;
  readonly repairMode: "auto" | "off";
};

export type AxiomSimpleRunControl = AgentRunControl;

export const AXIOM_SIMPLE_DEFAULT_CONFIG: AxiomSimpleRunConfig = {
  workerCount: 3,
  repairMode: "auto",
};

export const normalizeAxiomSimpleConfig = (
  input: Partial<AxiomSimpleRunConfig>,
): AxiomSimpleRunConfig => {
  const rawWorkerCount = Number.isFinite(input.workerCount ?? Number.NaN)
    ? Number(input.workerCount)
    : AXIOM_SIMPLE_DEFAULT_CONFIG.workerCount;
  const workerCount = clampNumber(Math.round(rawWorkerCount), 2, 3) as 2 | 3;
  return {
    workerCount,
    repairMode: input.repairMode === "off" ? "off" : "auto",
  };
};

export const parseAxiomSimpleConfig = (
  form: Record<string, string>,
): AxiomSimpleRunConfig =>
  normalizeAxiomSimpleConfig({
    workerCount: parseFormNum(form.workerCount) as 2 | 3 | undefined,
    repairMode: form.repairMode === "off" ? "off" : "auto",
  });

export type AxiomSimpleWorkerLaunchInput = {
  readonly parentRunId: string;
  readonly workerId: string;
  readonly label: string;
  readonly strategy: AxiomSimpleWorkerStrategy;
  readonly phase: AxiomSimpleWorkerPhase;
  readonly sourceWorkerId?: string;
  readonly task: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
  readonly onStarted?: (meta: {
    readonly jobId: string;
    readonly childRunId: string;
    readonly childStream: string;
    readonly status: AxiomSimpleWorkerStatus;
  }) => Promise<void>;
  readonly onProgress?: (snapshot: AxiomSimpleWorkerSnapshot) => Promise<void>;
};

export type AxiomSimpleWorkerOutcome = {
  readonly workerId: string;
  readonly label: string;
  readonly strategy: AxiomSimpleWorkerStrategy;
  readonly phase: AxiomSimpleWorkerPhase;
  readonly sourceWorkerId?: string;
  readonly status: AxiomSimpleWorkerStatus;
  readonly jobId: string;
  readonly childRunId: string;
  readonly childStream: string;
  readonly snapshot: AxiomSimpleWorkerSnapshot;
  readonly summary: string;
  readonly finalResponse?: string;
  readonly validation?: AxiomSimpleWorkerValidation;
  readonly successfulVerify?: AxiomSimpleWorkerValidation;
  readonly candidateContent?: string;
  readonly formalStatement?: string;
  readonly failureMessage?: string;
  readonly touchedPaths: ReadonlyArray<string>;
};

export type AxiomSimpleWorkerLauncher = (
  input: AxiomSimpleWorkerLaunchInput,
) => Promise<AxiomSimpleWorkerOutcome>;

export type AxiomSimpleRunInput = {
  readonly stream: string;
  readonly runId: string;
  readonly runStream?: string;
  readonly problem: string;
  readonly config: AxiomSimpleRunConfig;
  readonly runtime: Runtime<AxiomSimpleCmd, AxiomSimpleEvent, AxiomSimpleState>;
  readonly launchWorker: AxiomSimpleWorkerLauncher;
  readonly broadcast?: () => void;
  readonly now?: () => number;
  readonly control?: AxiomSimpleRunControl;
};

export type AxiomSimpleRunResult = {
  readonly runId: string;
  readonly stream: string;
  readonly runStream: string;
  readonly status: AxiomSimpleState["status"];
  readonly note?: string;
  readonly winnerWorkerId?: string;
  readonly verificationStatus?: AxiomSimpleVerificationStatus;
  readonly finalOutput?: string;
  readonly failure?: FailureRecord;
};

const STRATEGY_ORDER: ReadonlyArray<AxiomSimpleWorkerStrategy> = [
  "direct",
  "decompose",
  "adversarial",
  "repair",
  "final_verify",
] as const;

const strategyRank = (strategy: AxiomSimpleWorkerStrategy): number =>
  STRATEGY_ORDER.indexOf(strategy);

const toFailure = (
  failure: AxiomSimpleState["failure"],
): FailureRecord | undefined => {
  if (!failure) return undefined;
  const { updatedAt: _updatedAt, ...rest } = failure;
  return {
    ...rest,
    evidence: rest.evidence ? { ...rest.evidence } : undefined,
  };
};

const buildAxiomSimpleRunResult = (opts: {
  readonly runId: string;
  readonly stream: string;
  readonly runStream: string;
  readonly state: AxiomSimpleState;
}): AxiomSimpleRunResult => ({
  runId: opts.runId,
  stream: opts.stream,
  runStream: opts.runStream,
  status: opts.state.status,
  note: opts.state.statusNote,
  winnerWorkerId: opts.state.winner?.workerId,
  verificationStatus: opts.state.solution?.verificationStatus,
  finalOutput: opts.state.solution?.content,
  failure: toFailure(opts.state.failure),
});

type CandidateScore = {
  readonly score: number;
  readonly reason: string;
  readonly verified: boolean;
  readonly failureCount: number;
  readonly repairDepth: number;
  readonly validationGate?: string;
  readonly validationSummary?: string;
};

const shouldIndexEvent = (event: AxiomSimpleEvent): boolean => {
  switch (event.type) {
    case "problem.set":
    case "run.configured":
    case "winner.selected":
    case "final.verify.completed":
    case "solution.finalized":
    case "failure.report":
      return true;
    case "run.status":
      return event.status !== "running";
    default:
      return false;
  }
};

const latestRunId = async (
  runtime: Runtime<AxiomSimpleCmd, AxiomSimpleEvent, AxiomSimpleState>,
  stream: string,
): Promise<string | undefined> => {
  const chain = await runtime.chain(stream);
  return getLatestRunId(chain, "problem.set");
};

const workerLabel = (strategy: AxiomSimpleWorkerStrategy, phase: AxiomSimpleWorkerPhase): string => {
  if (phase === "repair") return "Repair Worker";
  if (phase === "final_verify") return "Final Verify";
  if (strategy === "direct") return "Direct";
  if (strategy === "decompose") return "Decompose";
  return "Adversarial";
};

const initialStrategies = (workerCount: 2 | 3): ReadonlyArray<AxiomSimpleWorkerStrategy> =>
  workerCount === 2 ? ["direct", "decompose"] : ["direct", "decompose", "adversarial"];

const directTask = (problem: string): string => [
  "Solve this Lean theorem task directly with AXLE-backed Lean tools.",
  "Use concrete proof search, repair, and formal verification. Do not stop at prose.",
  "Before finalizing, try to produce real lean.verify or lean.verify_file evidence.",
  "",
  `Problem:\n${problem.trim()}`,
].join("\n");

const decomposeTask = (problem: string): string => [
  "Solve this Lean theorem task with an explicit decomposition strategy.",
  "Prefer theorem-to-sorry, theorem-to-lemma, sorry-to-lemma, and repair-oriented structure edits when useful.",
  "Preserve the original theorem statement and finish with formal verification if possible.",
  "",
  `Problem:\n${problem.trim()}`,
].join("\n");

const adversarialTask = (problem: string): string => [
  "Investigate this Lean theorem adversarially.",
  "Try to expose hidden assumptions, find counterexamples, or formally disprove the claim when false.",
  "If the theorem survives scrutiny, still produce a real formally verified proof.",
  "",
  `Problem:\n${problem.trim()}`,
].join("\n");

const repairTask = (problem: string, winner: AxiomSimpleWorkerOutcome): string => {
  const basis = winner.candidateContent ?? winner.finalResponse ?? winner.summary;
  const validation = winner.validation?.summary ?? winner.failureMessage ?? winner.summary;
  return [
    "Repair the candidate below without changing the theorem statement.",
    "Use AXLE repair and verification tools aggressively.",
    "If the candidate is unsalvageable, explain that explicitly after trying formal repair and verification.",
    "",
    `Original problem:\n${problem.trim()}`,
    "",
    `Candidate to repair:\n${basis.trim() || "(no candidate content available)"}`,
    "",
    `Current verification signal:\n${validation}`,
  ].join("\n");
};

const finalVerifyTask = (problem: string, selected: AxiomSimpleWorkerOutcome): string => {
  const candidate = selected.candidateContent ?? selected.finalResponse ?? "";
  const formalStatement = selected.formalStatement?.trim() ?? "";
  return [
    "Perform a verification-only AXLE pass on the exact candidate below.",
    "Do not improve, rewrite, or change the theorem statement. Only verify the selected artifact.",
    "Call lean.verify or lean.verify_file so the run emits axle-verify evidence with candidate and formal-statement hashes.",
    "",
    `Original problem:\n${problem.trim()}`,
    "",
    formalStatement ? `Formal statement:\n${formalStatement}` : "Formal statement: unavailable; infer it from the selected candidate if needed.",
    "",
    `Selected candidate:\n${candidate.trim() || selected.summary}`,
  ].join("\n");
};

const baseChildConfig = (): Readonly<Record<string, unknown>> => ({
  maxIterations: 12,
  maxToolOutputChars: 6_000,
  memoryScope: "axiom",
  workspace: ".",
  leanEnvironment: process.env.AXIOM_LEAN_ENVIRONMENT ?? "lean-4.28.0",
  leanTimeoutSeconds: 120,
  autoRepair: true,
  requiredValidation: { kind: "axle-verify" },
});

const initialChildConfig = (strategy: AxiomSimpleWorkerStrategy): Readonly<Record<string, unknown>> => {
  if (strategy === "decompose") {
    return {
      ...baseChildConfig(),
      taskHints: {
        reason: "decompose_theorem",
        preferredTools: ["lean.theorem2sorry", "lean.sorry2lemma", "lean.theorem2lemma", "lean.repair", "lean.verify"],
      },
    };
  }
  if (strategy === "adversarial") {
    return {
      ...baseChildConfig(),
      taskHints: {
        preferredTools: ["lean.disprove", "lean.verify", "lean.check"],
      },
      autoRepair: false,
    };
  }
  return {
    ...baseChildConfig(),
    taskHints: {
      preferredTools: ["lean.verify", "lean.repair", "lean.check"],
    },
  };
};

const repairChildConfig = (): Readonly<Record<string, unknown>> => ({
  ...baseChildConfig(),
  taskHints: {
    preferredTools: ["lean.repair", "lean.verify"],
  },
});

const finalVerifyChildConfig = (): Readonly<Record<string, unknown>> => ({
  ...baseChildConfig(),
  maxIterations: 6,
  autoRepair: false,
  taskHints: {
    preferredTools: ["lean.verify", "lean.verify_file"],
  },
});

const scoreOutcome = (
  outcome: AxiomSimpleWorkerOutcome,
  repairDepth: number,
): CandidateScore => {
  let score = 0;
  const reasons: string[] = [];
  const verified = Boolean(outcome.successfulVerify?.ok);
  if (verified) {
    score += 1_000;
    reasons.push("successful lean.verify evidence");
  } else if (outcome.validation?.gate === "axle-verify" && outcome.validation.ok) {
    score += 700;
    reasons.push("positive axle-verify report");
  } else if (outcome.validation?.gate === "axle-check" && outcome.validation.ok) {
    score += 450;
    reasons.push("positive axle-check report");
  } else if (outcome.validation?.gate === "axle-verify") {
    score += 220;
    reasons.push("attempted axle-verify");
  } else if (outcome.validation?.gate === "axle-check") {
    score += 120;
    reasons.push("attempted axle-check");
  }

  if (outcome.candidateContent?.trim()) {
    score += 25;
    reasons.push("candidate content captured");
  }
  if (outcome.finalResponse?.trim()) {
    score += 10;
    reasons.push("final response captured");
  }

  score -= outcome.snapshot.failureCount * 5;
  score -= repairDepth * 2;

  if (reasons.length === 0) reasons.push("best available worker output");

  return {
    score,
    reason: reasons.join("; "),
    verified,
    failureCount: outcome.snapshot.failureCount,
    repairDepth,
    validationGate: outcome.validation?.gate,
    validationSummary: outcome.validation?.summary,
  };
};

const compareScored = (
  left: { readonly strategy: AxiomSimpleWorkerStrategy; readonly score: CandidateScore },
  right: { readonly strategy: AxiomSimpleWorkerStrategy; readonly score: CandidateScore },
): number =>
  right.score.score - left.score.score
  || left.score.failureCount - right.score.failureCount
  || left.score.repairDepth - right.score.repairDepth
  || strategyRank(left.strategy) - strategyRank(right.strategy);

const classifyVerificationStatus = (
  outcome: AxiomSimpleWorkerOutcome,
): AxiomSimpleVerificationStatus => {
  if (outcome.successfulVerify?.ok) return "verified";
  const body = [
    outcome.validation?.summary ?? "",
    outcome.summary,
    outcome.finalResponse ?? "",
    outcome.failureMessage ?? "",
  ].join("\n").toLowerCase();
  if (/\bdisprov|counterexample|theorem is false|claim is false\b/.test(body)) return "false";
  if (outcome.validation?.gate === "axle-verify") return "needs";
  return "failed";
};

const bestContent = (outcome: AxiomSimpleWorkerOutcome): string =>
  outcome.successfulVerify?.candidateContent
  ?? outcome.candidateContent
  ?? outcome.finalResponse
  ?? outcome.summary;

const finalSummary = (
  status: AxiomSimpleVerificationStatus,
  outcome: AxiomSimpleWorkerOutcome,
): string => {
  const header = status === "verified"
    ? "Final verification passed."
    : status === "false"
      ? "Final verification indicates the theorem is false."
      : "Final verification did not produce a verified artifact.";
  return [
    header,
    outcome.validation?.summary ?? outcome.summary,
    outcome.failureMessage ?? "",
  ].filter(Boolean).join("\n");
};

const emitRuntimeFailure = async (
  emit: (event: AxiomSimpleEvent) => Promise<void>,
  runId: string,
  message: string,
  details?: string,
): Promise<void> => {
  await emit({
    type: "failure.report",
    runId,
    agentId: "orchestrator",
    failure: {
      stage: "runtime",
      failureClass: "runtime_error",
      message,
      details,
      retryable: true,
    },
  });
  await emit({
    type: "run.status",
    runId,
    status: "failed",
    agentId: "orchestrator",
    note: message,
  });
};

export const getLatestAxiomSimpleRunId = latestRunId;

export const runAxiomSimple = async (
  input: AxiomSimpleRunInput,
): Promise<AxiomSimpleRunResult> => {
  const now = input.now ?? Date.now;
  const baseStream = input.stream;
  const runStream = input.runStream ?? axiomSimpleRunStream(baseStream, input.runId);
  const emitRun = createQueuedEmitter({
    runtime: input.runtime,
    stream: runStream,
    wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as AxiomSimpleCmd),
    onEmit: () => input.broadcast?.(),
    onError: (err) => console.error("axiom-simple emit failed", err),
  });
  const emitIndex = createQueuedEmitter({
    runtime: input.runtime,
    stream: baseStream,
    wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as AxiomSimpleCmd),
    onError: (err) => console.error("axiom-simple index emit failed", err),
  });
  const emit = async (event: AxiomSimpleEvent) => {
    await emitRun(event);
    if (shouldIndexEvent(event)) await emitIndex(event);
  };

  const checkAbort = async (stage: string): Promise<boolean> => {
    if (!input.control?.checkAbort) return false;
    const aborted = await input.control.checkAbort();
    if (!aborted) return false;
    await emit({
      type: "run.status",
      runId: input.runId,
      status: "failed",
      agentId: "orchestrator",
      note: `canceled at ${stage}`,
    });
    return true;
  };

  try {
    const problem = input.problem.trim();
    if (!problem) {
      await emitRuntimeFailure(emit, input.runId, "problem required");
      const state = await input.runtime.state(runStream);
      return buildAxiomSimpleRunResult({ runId: input.runId, stream: baseStream, runStream, state });
    }

    await emit({ type: "problem.set", runId: input.runId, problem, agentId: "orchestrator" });
    await emit({
      type: "run.configured",
      runId: input.runId,
      agentId: "orchestrator",
      workflow: { id: AXIOM_SIMPLE_WORKFLOW_ID, version: AXIOM_SIMPLE_WORKFLOW_VERSION },
      config: input.config,
      updatedAt: now(),
    });
    await emit({ type: "run.status", runId: input.runId, status: "running", agentId: "orchestrator" });

    const initialPlans = initialStrategies(input.config.workerCount).map((strategy, index) => ({
      workerId: `worker_${strategy}`,
      label: workerLabel(strategy, "initial"),
      strategy,
      phase: "initial" as const,
      order: index,
    }));

    for (const plan of initialPlans) {
      await emit({
        type: "worker.planned",
        runId: input.runId,
        workerId: plan.workerId,
        label: plan.label,
        strategy: plan.strategy,
        phase: plan.phase,
        order: plan.order,
      });
    }

    const initialOutcomes = await Promise.all(initialPlans.map(async (plan) => {
      const task = plan.strategy === "direct"
        ? directTask(problem)
        : plan.strategy === "decompose"
          ? decomposeTask(problem)
          : adversarialTask(problem);
      const outcome = await input.launchWorker({
        parentRunId: input.runId,
        workerId: plan.workerId,
        label: plan.label,
        strategy: plan.strategy,
        phase: plan.phase,
        task,
        config: initialChildConfig(plan.strategy),
        onStarted: async (meta) => {
          await emit({
            type: "worker.started",
            runId: input.runId,
            workerId: plan.workerId,
            jobId: meta.jobId,
            childRunId: meta.childRunId,
            childStream: meta.childStream,
            status: meta.status,
          });
        },
        onProgress: async (snapshot) => {
          await emit({
            type: "worker.progressed",
            runId: input.runId,
            workerId: plan.workerId,
            snapshot,
          });
        },
      });
      await emit({
        type: "worker.completed",
        runId: input.runId,
        workerId: plan.workerId,
        status: outcome.status,
        snapshot: outcome.snapshot,
        summary: outcome.summary,
      });
      return outcome;
    }));

    if (await checkAbort("initial-workers")) {
      const state = await input.runtime.state(runStream);
      return buildAxiomSimpleRunResult({ runId: input.runId, stream: baseStream, runStream, state });
    }

    const scoredInitial = initialOutcomes.map((outcome) => ({
      outcome,
      score: scoreOutcome(outcome, 0),
    }));
    scoredInitial.sort((left, right) => compareScored(
      { strategy: left.outcome.strategy, score: left.score },
      { strategy: right.outcome.strategy, score: right.score },
    ));

    for (const item of scoredInitial) {
      await emit({
        type: "candidate.scored",
        runId: input.runId,
        workerId: item.outcome.workerId,
        score: item.score.score,
        reason: item.score.reason,
        verified: item.score.verified,
        failureCount: item.score.failureCount,
        repairDepth: item.score.repairDepth,
        validationGate: item.score.validationGate,
        validationSummary: item.score.validationSummary,
      });
    }

    const winner = scoredInitial[0];
    if (!winner) {
      await emitRuntimeFailure(emit, input.runId, "no worker outcomes produced");
      const state = await input.runtime.state(runStream);
      return buildAxiomSimpleRunResult({ runId: input.runId, stream: baseStream, runStream, state });
    }

    await emit({
      type: "winner.selected",
      runId: input.runId,
      workerId: winner.outcome.workerId,
      score: winner.score.score,
      reason: winner.score.reason,
    });

    let selectedArtifact = winner.outcome;
    if (!winner.score.verified && input.config.repairMode === "auto") {
      const repairWorkerId = `${winner.outcome.workerId}_repair`;
      await emit({
        type: "worker.planned",
        runId: input.runId,
        workerId: repairWorkerId,
        label: workerLabel("repair", "repair"),
        strategy: "repair",
        phase: "repair",
        sourceWorkerId: winner.outcome.workerId,
        order: initialPlans.length,
      });
      await emit({
        type: "repair.started",
        runId: input.runId,
        sourceWorkerId: winner.outcome.workerId,
        workerId: repairWorkerId,
        note: winner.score.reason,
      });
      const repairOutcome = await input.launchWorker({
        parentRunId: input.runId,
        workerId: repairWorkerId,
        label: workerLabel("repair", "repair"),
        strategy: "repair",
        phase: "repair",
        sourceWorkerId: winner.outcome.workerId,
        task: repairTask(problem, winner.outcome),
        config: repairChildConfig(),
        onStarted: async (meta) => {
          await emit({
            type: "worker.started",
            runId: input.runId,
            workerId: repairWorkerId,
            jobId: meta.jobId,
            childRunId: meta.childRunId,
            childStream: meta.childStream,
            status: meta.status,
          });
        },
        onProgress: async (snapshot) => {
          await emit({
            type: "worker.progressed",
            runId: input.runId,
            workerId: repairWorkerId,
            snapshot,
          });
        },
      });
      await emit({
        type: "worker.completed",
        runId: input.runId,
        workerId: repairWorkerId,
        status: repairOutcome.status,
        snapshot: repairOutcome.snapshot,
        summary: repairOutcome.summary,
      });
      await emit({
        type: "repair.completed",
        runId: input.runId,
        sourceWorkerId: winner.outcome.workerId,
        workerId: repairWorkerId,
        status: repairOutcome.status,
        summary: repairOutcome.summary,
      });
      const repairScore = scoreOutcome(repairOutcome, 1);
      await emit({
        type: "candidate.scored",
        runId: input.runId,
        workerId: repairOutcome.workerId,
        score: repairScore.score,
        reason: repairScore.reason,
        verified: repairScore.verified,
        failureCount: repairScore.failureCount,
        repairDepth: repairScore.repairDepth,
        validationGate: repairScore.validationGate,
        validationSummary: repairScore.validationSummary,
      });
      selectedArtifact = compareScored(
        { strategy: repairOutcome.strategy, score: repairScore },
        { strategy: winner.outcome.strategy, score: winner.score },
      ) < 0 ? repairOutcome : winner.outcome;
    }

    if (await checkAbort("repair")) {
      const state = await input.runtime.state(runStream);
      return buildAxiomSimpleRunResult({ runId: input.runId, stream: baseStream, runStream, state });
    }

    const finalVerifyWorkerId = `${selectedArtifact.workerId}_verify`;
    await emit({
      type: "worker.planned",
      runId: input.runId,
      workerId: finalVerifyWorkerId,
      label: workerLabel("final_verify", "final_verify"),
      strategy: "final_verify",
      phase: "final_verify",
      sourceWorkerId: selectedArtifact.workerId,
      order: initialPlans.length + 1,
    });
    await emit({
      type: "final.verify.started",
      runId: input.runId,
      sourceWorkerId: selectedArtifact.workerId,
      workerId: finalVerifyWorkerId,
      note: selectedArtifact.validation?.summary ?? selectedArtifact.summary,
    });

    const finalVerifyOutcome = await input.launchWorker({
      parentRunId: input.runId,
      workerId: finalVerifyWorkerId,
      label: workerLabel("final_verify", "final_verify"),
      strategy: "final_verify",
      phase: "final_verify",
      sourceWorkerId: selectedArtifact.workerId,
      task: finalVerifyTask(problem, selectedArtifact),
      config: finalVerifyChildConfig(),
      onStarted: async (meta) => {
        await emit({
          type: "worker.started",
          runId: input.runId,
          workerId: finalVerifyWorkerId,
          jobId: meta.jobId,
          childRunId: meta.childRunId,
          childStream: meta.childStream,
          status: meta.status,
        });
      },
      onProgress: async (snapshot) => {
        await emit({
          type: "worker.progressed",
          runId: input.runId,
          workerId: finalVerifyWorkerId,
          snapshot,
        });
      },
    });
    await emit({
      type: "worker.completed",
      runId: input.runId,
      workerId: finalVerifyWorkerId,
      status: finalVerifyOutcome.status,
      snapshot: finalVerifyOutcome.snapshot,
      summary: finalVerifyOutcome.summary,
    });

    const verificationStatus = classifyVerificationStatus(finalVerifyOutcome);
    await emit({
      type: "final.verify.completed",
      runId: input.runId,
      sourceWorkerId: selectedArtifact.workerId,
      workerId: finalVerifyWorkerId,
      status: verificationStatus,
      summary: finalSummary(verificationStatus, finalVerifyOutcome),
      validation: finalVerifyOutcome.successfulVerify ?? finalVerifyOutcome.validation,
      snapshot: finalVerifyOutcome.snapshot,
    });

    const finalizedContent = bestContent(
      verificationStatus === "verified" ? finalVerifyOutcome : selectedArtifact,
    );
    const gaps = verificationStatus === "verified"
      ? []
      : [`Final verification status: ${verificationStatus}`];
    await emit({
      type: "solution.finalized",
      runId: input.runId,
      workerId: verificationStatus === "verified" ? finalVerifyWorkerId : selectedArtifact.workerId,
      childRunId: verificationStatus === "verified" ? finalVerifyOutcome.childRunId : selectedArtifact.childRunId,
      verificationStatus,
      content: finalizedContent,
      summary: finalSummary(verificationStatus, finalVerifyOutcome),
      gaps,
    });

    if (verificationStatus !== "verified") {
      await emit({
        type: "failure.report",
        runId: input.runId,
        agentId: "orchestrator",
        failure: {
          stage: "verification",
          failureClass: "final_verify_failed",
          message: `Final verification failed: ${verificationStatus}`,
          details: finalVerifyOutcome.summary,
          retryable: true,
          evidence: finalVerifyOutcome.validation ? {
            gate: finalVerifyOutcome.validation.gate,
            summary: finalVerifyOutcome.validation.summary,
            tool: finalVerifyOutcome.validation.tool,
          } : undefined,
        },
      });
    }

    await emit({
      type: "run.status",
      runId: input.runId,
      status: verificationStatus === "verified" ? "completed" : "failed",
      agentId: "orchestrator",
      note: verificationStatus === "verified"
        ? undefined
        : `Final verification failed: ${verificationStatus}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emitRuntimeFailure(emit, input.runId, message);
  }

  const state = await input.runtime.state(runStream);
  return buildAxiomSimpleRunResult({
    runId: input.runId,
    stream: baseStream,
    runStream,
    state,
  });
};
