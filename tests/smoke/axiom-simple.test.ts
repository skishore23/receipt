import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import { runAxiomSimple, type AxiomSimpleWorkerLaunchInput, type AxiomSimpleWorkerOutcome } from "../../src/agents/axiom-simple.ts";
import { axiomSimpleRunStream } from "../../src/agents/axiom-simple.streams.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import type { AxiomSimpleCmd, AxiomSimpleEvent, AxiomSimpleState, AxiomSimpleWorkerValidation } from "../../src/modules/axiom-simple.ts";
import {
  decide as decideAxiomSimple,
  initial as initialAxiomSimple,
  reduce as reduceAxiomSimple,
} from "../../src/modules/axiom-simple.ts";

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const mkRuntime = (dir: string) => createRuntime<AxiomSimpleCmd, AxiomSimpleEvent, AxiomSimpleState>(
  jsonlStore<AxiomSimpleEvent>(dir),
  jsonBranchStore(dir),
  decideAxiomSimple,
  reduceAxiomSimple,
  initialAxiomSimple
);

const mkValidation = (input: Partial<AxiomSimpleWorkerValidation> & Pick<AxiomSimpleWorkerValidation, "gate" | "ok" | "summary">): AxiomSimpleWorkerValidation => ({
  gate: input.gate,
  ok: input.ok,
  summary: input.summary,
  tool: input.tool,
  candidateHash: input.candidateHash,
  formalStatementHash: input.formalStatementHash,
  candidateContent: input.candidateContent,
  formalStatement: input.formalStatement,
  failedDeclarations: input.failedDeclarations ?? [],
});

const mkOutcome = async (
  input: AxiomSimpleWorkerLaunchInput,
  spec: {
    readonly status: AxiomSimpleWorkerOutcome["status"];
    readonly summary: string;
    readonly validation?: AxiomSimpleWorkerValidation;
    readonly successfulVerify?: AxiomSimpleWorkerValidation;
    readonly finalResponse?: string;
    readonly candidateContent?: string;
    readonly formalStatement?: string;
    readonly touchedPaths?: ReadonlyArray<string>;
    readonly failureMessage?: string;
    readonly iteration?: number;
    readonly failureCount?: number;
  }
): Promise<AxiomSimpleWorkerOutcome> => {
  const childRunId = `${input.parentRunId}_${input.workerId}`;
  const childStream = "agents/axiom";
  const snapshot = {
    childRunId,
    jobId: `job_${input.workerId}`,
    childStream,
    status: spec.status,
    iteration: spec.iteration ?? 1,
    lastTool: "lean.verify",
    lastToolSummary: spec.summary,
    validationGate: spec.validation?.gate,
    validationSummary: spec.validation?.summary ?? spec.successfulVerify?.summary,
    validationOk: spec.validation?.ok ?? spec.successfulVerify?.ok,
    verifyTool: spec.successfulVerify?.tool,
    verified: spec.successfulVerify?.ok,
    outputExcerpt: spec.finalResponse ?? spec.summary,
    observationExcerpt: spec.failureMessage,
    touchedPath: spec.touchedPaths?.[0],
    candidateHash: spec.successfulVerify?.candidateHash ?? spec.validation?.candidateHash,
    formalStatementHash: spec.successfulVerify?.formalStatementHash ?? spec.validation?.formalStatementHash,
    failedDeclarations: spec.successfulVerify?.failedDeclarations ?? spec.validation?.failedDeclarations ?? [],
    failureCount: spec.failureCount ?? 0,
  } as const;

  await input.onStarted?.({
    jobId: snapshot.jobId,
    childRunId,
    childStream,
    status: "queued",
  });
  await input.onProgress?.(snapshot);

  return {
    workerId: input.workerId,
    label: input.label,
    strategy: input.strategy,
    phase: input.phase,
    sourceWorkerId: input.sourceWorkerId,
    status: spec.status,
    jobId: snapshot.jobId,
    childRunId,
    childStream,
    snapshot,
    summary: spec.summary,
    finalResponse: spec.finalResponse,
    validation: spec.validation,
    successfulVerify: spec.successfulVerify,
    candidateContent: spec.candidateContent,
    formalStatement: spec.formalStatement,
    failureMessage: spec.failureMessage,
    touchedPaths: spec.touchedPaths ?? [],
  };
};

test("runAxiomSimple finalizes after an initially verified worker without repair", async () => {
  const dir = await mkTmp("receipt-axiom-simple-direct");
  const runtime = mkRuntime(dir);
  const runId = "axiom_simple_verified";
  const runStream = axiomSimpleRunStream("agents/axiom-simple", runId);

  const verified = mkValidation({
    gate: "axle-verify",
    ok: true,
    summary: "Verified candidate.",
    tool: "lean.verify",
    candidateHash: "cand-direct",
    formalStatementHash: "stmt-direct",
    candidateContent: "theorem direct : 1 = 1 := by rfl",
    formalStatement: "theorem direct : 1 = 1",
  });

  try {
    await runAxiomSimple({
      stream: "agents/axiom-simple",
      runId,
      problem: "Prove 1 = 1 in Lean.",
      config: { workerCount: 3, repairMode: "auto" },
      runtime,
      broadcast: () => {},
      launchWorker: async (input) => {
        if (input.phase === "final_verify") {
          return mkOutcome(input, {
            status: "completed",
            summary: "Final verify passed.",
            validation: verified,
            successfulVerify: verified,
            finalResponse: "Final verified proof.",
            candidateContent: verified.candidateContent,
            formalStatement: verified.formalStatement,
            touchedPaths: ["Main.lean"],
          });
        }
        if (input.strategy === "direct") {
          return mkOutcome(input, {
            status: "completed",
            summary: "Direct worker verified immediately.",
            validation: verified,
            successfulVerify: verified,
            finalResponse: "Direct verified proof.",
            candidateContent: verified.candidateContent,
            formalStatement: verified.formalStatement,
            touchedPaths: ["Main.lean"],
          });
        }
        return mkOutcome(input, {
          status: "failed",
          summary: `${input.workerId} failed to verify.`,
          validation: mkValidation({
            gate: "axle-check",
            ok: false,
            summary: `${input.workerId} failed.`,
            tool: "lean.check",
          }),
          failureMessage: `${input.workerId} failed`,
        });
      },
    });

    const chain = await runtime.chain(runStream);
    const eventTypes = chain.map((receipt) => receipt.body.type);
    expect(eventTypes.includes("repair.started")).toBe(false);
    expect(eventTypes.includes("final.verify.completed")).toBe(true);

    const winner = chain.find((receipt): receipt is typeof receipt & {
      readonly body: Extract<AxiomSimpleEvent, { readonly type: "winner.selected" }>;
    } => receipt.body.type === "winner.selected");
    const finalVerify = chain.find((receipt): receipt is typeof receipt & {
      readonly body: Extract<AxiomSimpleEvent, { readonly type: "final.verify.completed" }>;
    } => receipt.body.type === "final.verify.completed");
    const finalStatus = chain.findLast((receipt): receipt is typeof receipt & {
      readonly body: Extract<AxiomSimpleEvent, { readonly type: "run.status" }>;
    } => receipt.body.type === "run.status");

    expect(winner?.body.workerId).toBe("worker_direct");
    expect(finalVerify?.body.status).toBe("verified");
    expect(finalStatus?.body.status).toBe("completed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runAxiomSimple launches one repair loop and verifies the repaired candidate", async () => {
  const dir = await mkTmp("receipt-axiom-simple-repair");
  const runtime = mkRuntime(dir);
  const runId = "axiom_simple_repair";
  const runStream = axiomSimpleRunStream("agents/axiom-simple", runId);

  const partial = mkValidation({
    gate: "axle-check",
    ok: true,
    summary: "Candidate compiles but not yet verified.",
    tool: "lean.check",
    candidateContent: "theorem partial : 1 = 1 := by simp",
    formalStatement: "theorem partial : 1 = 1",
  });
  const repaired = mkValidation({
    gate: "axle-verify",
    ok: true,
    summary: "Repair verified candidate.",
    tool: "lean.verify",
    candidateHash: "cand-repair",
    formalStatementHash: "stmt-repair",
    candidateContent: "theorem repaired : 1 = 1 := by rfl",
    formalStatement: "theorem repaired : 1 = 1",
  });

  try {
    await runAxiomSimple({
      stream: "agents/axiom-simple",
      runId,
      problem: "Repair a weak proof attempt.",
      config: { workerCount: 2, repairMode: "auto" },
      runtime,
      broadcast: () => {},
      launchWorker: async (input) => {
        if (input.phase === "repair") {
          return mkOutcome(input, {
            status: "completed",
            summary: "Repair worker fixed the proof.",
            validation: repaired,
            successfulVerify: repaired,
            finalResponse: "Repair completed with verification.",
            candidateContent: repaired.candidateContent,
            formalStatement: repaired.formalStatement,
            touchedPaths: ["Repair.lean"],
          });
        }
        if (input.phase === "final_verify") {
          return mkOutcome(input, {
            status: "completed",
            summary: "Final verify confirmed repair.",
            validation: repaired,
            successfulVerify: repaired,
            finalResponse: "Final verified repair.",
            candidateContent: repaired.candidateContent,
            formalStatement: repaired.formalStatement,
            touchedPaths: ["Repair.lean"],
          });
        }
        if (input.strategy === "decompose") {
          return mkOutcome(input, {
            status: "completed",
            summary: "Best initial candidate needs repair.",
            validation: partial,
            candidateContent: partial.candidateContent,
            formalStatement: partial.formalStatement,
            finalResponse: "Candidate ready for repair.",
            touchedPaths: ["Scratch.lean"],
          });
        }
        return mkOutcome(input, {
          status: "failed",
          summary: `${input.workerId} failed`,
          validation: mkValidation({
            gate: "axle-check",
            ok: false,
            summary: `${input.workerId} failed`,
            tool: "lean.check",
          }),
          failureMessage: `${input.workerId} failed`,
          failureCount: 1,
        });
      },
    });

    const chain = await runtime.chain(runStream);
    const repairStarted = chain.find((receipt): receipt is typeof receipt & {
      readonly body: Extract<AxiomSimpleEvent, { readonly type: "repair.started" }>;
    } => receipt.body.type === "repair.started");
    const finalVerifyStarted = chain.find((receipt): receipt is typeof receipt & {
      readonly body: Extract<AxiomSimpleEvent, { readonly type: "final.verify.started" }>;
    } => receipt.body.type === "final.verify.started");
    const finalVerifyCompleted = chain.find((receipt): receipt is typeof receipt & {
      readonly body: Extract<AxiomSimpleEvent, { readonly type: "final.verify.completed" }>;
    } => receipt.body.type === "final.verify.completed");

    expect(repairStarted?.body.sourceWorkerId).toBe("worker_decompose");
    expect(finalVerifyStarted?.body.sourceWorkerId).toBe("worker_decompose_repair");
    expect(finalVerifyCompleted?.body.status).toBe("verified");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
