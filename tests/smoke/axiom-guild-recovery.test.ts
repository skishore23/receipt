import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import { jsonlQueue } from "../../src/adapters/jsonl-queue.ts";
import { maybeQueueAxiomGuildVerifyFailureFollowUp } from "../../src/agents/axiom-guild-recovery.ts";
import { runTheoremGuild, type TheoremAxiomDelegateResult, type TheoremRunResult } from "../../src/agents/theorem.ts";
import { theoremRunStream } from "../../src/agents/theorem.streams.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import {
  decide as decideJob,
  reduce as reduceJob,
  initial as initialJob,
  type JobCmd,
  type JobEvent,
  type JobState,
} from "../../src/modules/job.ts";
import {
  decide as decideTheorem,
  reduce as reduceTheorem,
  initial as initialTheorem,
  type TheoremCmd,
  type TheoremEvent,
  type TheoremState,
} from "../../src/modules/theorem.ts";
import { loadTheoremPrompts } from "../../src/prompts/theorem.ts";

const mkTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const mkTheoremRuntime = (dir: string) => createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
  jsonlStore<TheoremEvent>(dir),
  jsonBranchStore(dir),
  decideTheorem,
  reduceTheorem,
  initialTheorem
);

const mkJobRuntime = (dir: string) => createRuntime<JobCmd, JobEvent, JobState>(
  jsonlStore<JobEvent>(dir),
  jsonBranchStore(dir),
  decideJob,
  reduceJob,
  initialJob
);

const withPassKOne = async (fn: () => Promise<void>): Promise<void> => {
  const previous = process.env.THEOREM_PASS_K;
  process.env.THEOREM_PASS_K = "1";
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.THEOREM_PASS_K;
    else process.env.THEOREM_PASS_K = previous;
  }
};

const mkHallLlm = () => async ({ system, user }: { system?: string; user: string }): Promise<string> => {
  if (user.includes("\"action\": \"continue\" | \"done\"")) {
    return JSON.stringify({
      action: "continue",
      reason: "Need one more pass.",
      skip_lemma: false,
      skip_critique: false,
      skip_patch: false,
      skip_merge: false,
      focus: {},
    });
  }
  if (user.includes("\"attempt\": \"full attempt text\"")) {
    if ((system ?? "").includes("Explorer A")) {
      return JSON.stringify({
        attempt: "Step 1: Search Mathlib for the finite Hall theorem and any direct matching lemma.\nStep 2: If not exact, formalize the finite-set version and isolate the key cardinality lemma.",
        lemmas: ["L1: finite Hall cardinality criterion", "L2: matching extraction lemma"],
        gaps: [],
        axiom_task: "In Lean4/mathlib, search for and check the finite Hall theorem and the key matching/cardinality lemmas needed for the direct proof route.",
        axiom_config: { maxIterations: 8, autoRepair: true },
        axiom_hints: {
          preferredTools: ["lean.check", "lean.theorem2lemma"],
          reason: "decompose_theorem",
        },
      });
    }
    return JSON.stringify({
      attempt: "Step 1: Reformulate the bipartite matching statement.\nStep 2: Reduce to the finite Hall condition.",
      lemmas: ["L1: reformulation lemma"],
      gaps: [],
    });
  }
  if (user.includes("\"lemmas\": [") && user.includes("\"statement\"")) {
    return JSON.stringify({
      lemmas: [{ label: "L1", statement: "Finite Hall criterion gives a matching.", usage: "Main step" }],
    });
  }
  if (user.includes("\"issues\": [")) {
    return JSON.stringify({ issues: [], summary: "No additional issues." });
  }
  if (user.includes("\"patch\": \"patched proof text\"")) {
    return JSON.stringify({ patch: "No changes required.", remaining_gaps: [] });
  }
  if (user.includes("\"summary\": \"merged summary\"")) {
    return JSON.stringify({ summary: "Merged Hall proof summary.", gaps: [] });
  }
  if (user.includes("\"status\": \"valid | needs | false\"")) {
    return JSON.stringify({
      status: "needs",
      notes: ["Final AXLE verification failed on the finite Hall formalization; decompose the proof and repair the key matching lemma before retrying."],
    });
  }
  if (user.includes("\"proof\": \"final proof text\"") || user.includes("\"proof\": \"revised proof text\"")) {
    return JSON.stringify({
      proof: "Proof:\nStep 1: Use the finite Hall condition to obtain the matching criterion.\nStep 2: Apply the matching extraction lemma.\nConclusion.",
      confidence: 0.61,
      gaps: [],
    });
  }
  return "{}";
};

test("axiom-guild queues one Hall-style orchestrator follow-up after final AXLE verification failure", async () => {
  await withPassKOne(async () => {
    const dir = await mkTempDir("receipt-axiom-guild-recovery");

    try {
      const theoremRuntime = mkTheoremRuntime(dir);
      const jobRuntime = mkJobRuntime(dir);
      const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
      const prompts = loadTheoremPrompts({ name: "axiom-guild", tag: "axiom-guild" });
      const delegateCalls: Array<{ task: string; config?: Readonly<Record<string, unknown>> }> = [];
      const runId = `run_${Date.now()}_hall_recovery`;

      const result = await runTheoremGuild({
        stream: "agents/axiom-guild",
        runId,
        problem: "Prove Hall's marriage theorem in finite form for a bipartite graph with finite left and right parts.",
        config: { rounds: 1, maxDepth: 1, memoryWindow: 20, branchThreshold: 2 },
        runtime: theoremRuntime,
        prompts,
        llmText: mkHallLlm(),
        model: "gpt-4o",
        apiReady: true,
        axiomPolicy: "required",
        axiomConfig: {
          maxIterations: 8,
          autoRepair: true,
          formalStatementPath: "HallFinite.sorry.lean",
        },
        axiomDelegate: async ({ task, config }): Promise<TheoremAxiomDelegateResult> => {
          delegateCalls.push({ task, config });
          return delegateCalls.length === 1
            ? {
                status: "completed",
                summary: "AXLE tools: lean.check\nvalidation: searched Mathlib Hall lemmas and checked the finite theorem names.",
                jobId: "job_hall_search",
                runId: "axiom_hall_search",
                stream: "agents/axiom",
                outcome: "explored",
                evidence: [{
                  tool: "lean.check",
                  environment: "lean-4.28.0",
                  ok: true,
                  failedDeclarations: [],
                  timings: { total_ms: 11 },
                }],
              }
            : {
                status: "completed",
                summary: "AXLE tools: lean.verify\nvalidation: finite Hall proof still fails on the extracted matching lemma.",
                jobId: "job_hall_verify",
                runId: "axiom_hall_verify",
                stream: "agents/axiom",
                outcome: "axle_verify_failed",
                evidence: [{
                  tool: "lean.verify",
                  environment: "lean-4.28.0",
                  candidateHash: "cand_hall",
                  formalStatementHash: "stmt_hall",
                  ok: false,
                  failedDeclarations: ["hallFiniteMatching"],
                  timings: { total_ms: 23 },
                }],
              };
        },
      });

      expect(result.status).toBe("failed");
      expect(result.failureClass).toBe("axle_verify_failed");
      expect(result.failure?.failureClass).toBe("axle_verify_failed");
      expect(delegateCalls.length >= 2).toBeTruthy();
      expect((delegateCalls[0]?.config as Record<string, unknown> | undefined)?.requiredValidation).toBe(undefined);
      expect((delegateCalls[delegateCalls.length - 1]?.config as Record<string, unknown> | undefined)?.requiredValidation).toEqual({
        kind: "axle-verify",
        formalStatementPath: "HallFinite.sorry.lean",
      });

      const recovery = await maybeQueueAxiomGuildVerifyFailureFollowUp({
        queue,
        theoremRuntime,
        payload: {
          kind: "axiom-guild.run",
          stream: "agents/axiom-guild",
          problem: "Prove Hall's marriage theorem in finite form for a bipartite graph with finite left and right parts.",
          config: { rounds: 1, maxDepth: 1, memoryWindow: 20, branchThreshold: 2 },
        },
        result,
        jobId: "job_hall_failed",
      });

      expect(recovery.failureClass).toBe("axle_verify_failed");
      expect(recovery.followUpJobId).toBeTruthy();
      expect(recovery.followUpRunId).toBeTruthy();

      const followUpJob = await queue.getJob(recovery.followUpJobId!);
      expect(followUpJob).toBeTruthy();
      expect(followUpJob?.agentId).toBe("axiom-guild");
      expect(followUpJob?.payload.autoFollowUp).toBe(true);
      expect(followUpJob?.payload.followUpOfJobId).toBe("job_hall_failed");
      expect(followUpJob?.payload.followUpOfRunId).toBe(runId);
      expect(followUpJob?.payload.failureClass).toBe("axle_verify_failed");
      expect((followUpJob?.payload.failure as Record<string, unknown> | undefined)?.failureClass).toBe("axle_verify_failed");
      expect(String(followUpJob?.payload.problem ?? "")).toMatch(/Hall's marriage theorem/i);
      expect(String(followUpJob?.payload.problem ?? "")).toMatch(/Structured terminal failure/i);
      expect(String(followUpJob?.payload.problem ?? "")).toMatch(/AXLE verification report/i);
      expect(String(followUpJob?.payload.problem ?? "")).toMatch(/matching lemma/i);

      const chain = await theoremRuntime.chain(theoremRunStream("agents/axiom-guild", runId));
      const finalStatus = chain.findLast((receipt): receipt is typeof receipt & { body: Extract<TheoremEvent, { type: "run.status" }> } =>
        receipt.body.type === "run.status"
      );
      expect(finalStatus?.body.status).toBe("failed");
      expect(finalStatus?.body.note ?? "").toMatch(/Follow-up queued:/i);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}, 120_000);

test("axiom-guild follow-up recovery does not recurse for auto-followed runs", async () => {
  const dir = await mkTempDir("receipt-axiom-guild-no-recurse");

  try {
    const theoremRuntime = mkTheoremRuntime(dir);
    const jobRuntime = mkJobRuntime(dir);
    const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
    const result: TheoremRunResult = {
      runId: "run_auto_followed",
      stream: "agents/axiom-guild",
      runStream: theoremRunStream("agents/axiom-guild", "run_auto_followed"),
      status: "failed",
      note: "Final verification failed: AXIOM verification evidence missing.",
      failure: {
        stage: "verification",
        failureClass: "missing_final_verify_receipt",
        message: "Final verification failed: AXIOM verification evidence missing.",
        retryable: true,
      },
      verificationStatus: "needs",
      verificationReport: "AXIOM verification evidence missing.",
      failureClass: "missing_final_verify_receipt",
      finalProof: "theorem foo := by\n  sorry",
    };

    const recovery = await maybeQueueAxiomGuildVerifyFailureFollowUp({
      queue,
      theoremRuntime,
      payload: {
        kind: "axiom-guild.run",
        stream: "agents/axiom-guild",
        problem: "Retry the previous theorem.",
        autoFollowUp: true,
        followUpOfJobId: "job_source",
      },
      result,
      jobId: "job_auto_followed",
    });

    expect(recovery.followUpJobId).toBe(undefined);
    expect((await queue.listJobs()).length).toBe(0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("axiom-guild follow-up recovery skips successful final verification", async () => {
  const dir = await mkTempDir("receipt-axiom-guild-success");

  try {
    const theoremRuntime = mkTheoremRuntime(dir);
    const jobRuntime = mkJobRuntime(dir);
    const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
    const result: TheoremRunResult = {
      runId: "run_success",
      stream: "agents/axiom-guild",
      runStream: theoremRunStream("agents/axiom-guild", "run_success"),
      status: "completed",
      failure: undefined,
      verificationStatus: "valid",
      verificationReport: "AXLE verified the proof.",
      finalProof: "theorem foo := by\n  rfl",
    };

    const recovery = await maybeQueueAxiomGuildVerifyFailureFollowUp({
      queue,
      theoremRuntime,
      payload: {
        kind: "axiom-guild.run",
        stream: "agents/axiom-guild",
        problem: "Prove foo",
      },
      result,
      jobId: "job_success",
    });

    expect(recovery.followUpJobId).toBe(undefined);
    expect((await queue.listJobs()).length).toBe(0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
