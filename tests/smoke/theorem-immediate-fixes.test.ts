import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import {
  compactTheoremPrompt,
  runTheoremGuild,
} from "../../src/agents/theorem.ts";
import { theoremRunStream } from "../../src/agents/theorem.streams.ts";
import type { Chain } from "../../src/core/types.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import type { TheoremEvent } from "../../src/modules/theorem.ts";
import {
  decide as decideTheorem,
  reduce as reduceTheorem,
  initial as initialTheorem,
  type TheoremCmd,
  type TheoremState,
} from "../../src/modules/theorem.ts";
import { computeWeights, pairKey } from "../../src/agents/theorem.rebracket.ts";
import { evaluateRoundRebracketEvidence } from "../../src/agents/theorem.evidence.ts";
import { loadTheoremPrompts } from "../../src/prompts/theorem.ts";
import {
  callWithStructuredRetries,
  parseVerifyPayload,
} from "../../src/agents/theorem.structured.ts";

const hashText = (input: string): string =>
  createHash("sha256").update(input, "utf-8").digest("hex");

const mkReceipt = (body: TheoremEvent, ts: number): Chain<TheoremEvent>[number] => ({
  id: `id_${ts}`,
  ts,
  stream: "theorem/runs/r1",
  body,
  hash: `hash_${ts}`,
});

test("theorem: structured retry recovers valid JSON on retry", async () => {
  let calls = 0;
  const result = await callWithStructuredRetries({
    llmText: async () => {
      calls += 1;
      return calls === 1
        ? "not json"
        : "{\"status\":\"valid\",\"notes\":[\"step references are sound\"]}";
    },
    user: "verify",
    parse: parseVerifyPayload,
    retries: 1,
  });

  expect(result.parsed).toBe(true);
  expect(result.attempts).toBe(2);
  expect(result.value.status).toBe("valid");
  expect(calls).toBe(2);
});

test("theorem: structured retry throws when parsing never succeeds", async () => {
  await expect(
    callWithStructuredRetries({
      llmText: async () => "still not json",
      user: "verify",
      parse: parseVerifyPayload,
      retries: 1,
    })
  ).rejects.toThrow(/structured parse failed/);
});

test("theorem: prompt compaction preserves merge sections instead of collapsing to head-tail only", () => {
  const left = `LEFT_HEAD\n${"L".repeat(3_200)}\nLEFT_TAIL`;
  const right = `RIGHT_HEAD\n${"R".repeat(3_200)}\nRIGHT_TAIL`;
  const prompt = [
    "Problem:",
    "theorem hall_target : True := by",
    "  trivial",
    "",
    "Left ((A o B)):",
    left,
    "",
    "Right (C):",
    right,
    "",
    "Task:",
    "Merge into one concise summary preserving only justified steps, with explicit unresolved gaps.",
    "Return JSON only in this schema:",
    "{",
    '  "summary": "merged summary",',
    '  "gaps": ["..."]',
    "}",
  ].join("\n");

  const compacted = compactTheoremPrompt(prompt, 1_800);
  expect(compacted.length <= 1_800).toBeTruthy();
  expect(compacted).toMatch(/Problem:/);
  expect(compacted).toMatch(/Left \(\(A o B\)\):/);
  expect(compacted).toMatch(/LEFT_HEAD/);
  expect(compacted).toMatch(/LEFT_TAIL/);
  expect(compacted).toMatch(/Right \(C\):/);
  expect(compacted).toMatch(/RIGHT_HEAD/);
  expect(compacted).toMatch(/RIGHT_TAIL/);
  expect(compacted).toMatch(/Return JSON only in this schema:/);
});

test("theorem: round evidence gates rebracketing with branchThreshold", () => {
  const runId = "r1";
  const chain: Chain<TheoremEvent> = [
    mkReceipt({
      type: "attempt.proposed",
      runId,
      claimId: "attempt_r1_a",
      agentId: "explorer_a",
      content: "Attempt A",
    }, 1),
    mkReceipt({
      type: "attempt.proposed",
      runId,
      claimId: "attempt_r1_b",
      agentId: "explorer_b",
      content: "Attempt B",
    }, 2),
    mkReceipt({
      type: "critique.raised",
      runId,
      claimId: "critique_r1_1",
      agentId: "skeptic",
      targetClaimId: "attempt_r1_a",
      content: "Issue in step 2",
    }, 3),
    mkReceipt({
      type: "critique.raised",
      runId,
      claimId: "critique_r1_2",
      agentId: "skeptic",
      targetClaimId: "attempt_r1_a",
      content: "Issue in assumption",
    }, 4),
  ];

  const lowThreshold = evaluateRoundRebracketEvidence(chain, 1, 1);
  const highThreshold = evaluateRoundRebracketEvidence(chain, 1, 5);

  expect(lowThreshold.shouldRebracket).toBe(true);
  expect(highThreshold.shouldRebracket).toBe(false);
  expect(lowThreshold.score > highThreshold.score - 0.0001).toBeTruthy();
});

test("theorem: summary uses contribute to pod-pair weights", () => {
  const runId = "r1";
  const chain: Chain<TheoremEvent> = [
    mkReceipt({
      type: "attempt.proposed",
      runId,
      claimId: "attempt_r1_a",
      agentId: "explorer_a",
      content: "Attempt A",
    }, 1),
    mkReceipt({
      type: "attempt.proposed",
      runId,
      claimId: "attempt_r1_b",
      agentId: "explorer_b",
      content: "Attempt B",
    }, 2),
    mkReceipt({
      type: "summary.made",
      runId,
      claimId: "merge_r1_1",
      agentId: "synthesizer",
      bracket: "(A o B)",
      content: "Merged",
      uses: ["attempt_r1_a", "attempt_r1_b"],
    }, 3),
  ];

  const weights = computeWeights(chain);
  expect(weights.get(pairKey("A", "B"))).toBe(1);
});

test("theorem: structured phases run end-to-end with mocked JSON responses", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-theorem-structured-"));
  const oldPassK = process.env.THEOREM_PASS_K;
  process.env.THEOREM_PASS_K = "1";

  try {
    const runtime = createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
      jsonlStore<TheoremEvent>(dataDir),
      jsonBranchStore(dataDir),
      decideTheorem,
      reduceTheorem,
      initialTheorem
    );
    const prompts = loadTheoremPrompts();
    const llmText = async (opts: { system?: string; user: string }): Promise<string> => {
      const user = opts.user;
      if (user.includes("\"action\": \"continue\" | \"done\"")) {
        return JSON.stringify({
          action: "continue",
          reason: "keep going",
          skip_lemma: false,
          skip_critique: false,
          skip_patch: false,
          skip_merge: false,
          focus: {},
        });
      }
      if (user.includes("\"attempt\": \"full attempt text\"")) {
        return JSON.stringify({
          attempt: "Step 1: Let x = x.\nStep 2: Therefore the statement holds.",
          lemmas: ["L1: Reflexivity of equality"],
          gaps: [],
        });
      }
      if (user.includes("\"lemmas\": [") && user.includes("\"statement\"")) {
        return JSON.stringify({
          lemmas: [{ label: "L1", statement: "For any x, x = x.", usage: "Step 1" }],
        });
      }
      if (user.includes("\"issues\": [")) {
        return JSON.stringify({ issues: [], summary: "No issues found." });
      }
      if (user.includes("\"patch\": \"patched proof text\"")) {
        return JSON.stringify({ patch: "No changes required.", remaining_gaps: [] });
      }
      if (user.includes("\"summary\": \"merged summary\"")) {
        return JSON.stringify({ summary: "Merged proof summary.", gaps: [] });
      }
      if (user.includes("\"status\": \"valid | needs | false\"")) {
        return JSON.stringify({ status: "valid", notes: ["Proof is logically valid."] });
      }
      if (user.includes("\"proof\": \"final proof text\"") || user.includes("\"proof\": \"revised proof text\"")) {
        return JSON.stringify({
          proof: "Proof:\nStep 1: x = x by reflexivity.\nConclusion.",
          confidence: 0.9,
          gaps: [],
        });
      }
      return "{}";
    };

    const runId = `run_${Date.now()}_structured`;
    await runTheoremGuild({
      stream: "theorem",
      runId,
      problem: "Prove x = x",
      config: { rounds: 1, maxDepth: 1, memoryWindow: 20, branchThreshold: 2 },
      runtime,
      prompts,
      llmText,
      model: "gpt-4o",
      apiReady: true,
    });

    const chain = await runtime.chain(theoremRunStream("theorem", runId));
    expect(chain.some((r) => r.body.type === "solution.finalized")).toBeTruthy();
    expect(
      chain.some((r) => r.body.type === "verification.report" && r.body.status === "valid")
    ).toBeTruthy();
  } finally {
    if (oldPassK === undefined) delete process.env.THEOREM_PASS_K;
    else process.env.THEOREM_PASS_K = oldPassK;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 120_000);

test("theorem: explorer can delegate to axiom worker and merge the result into branch receipts", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-theorem-axiom-"));
  const oldPassK = process.env.THEOREM_PASS_K;
  process.env.THEOREM_PASS_K = "1";

  try {
    const runtime = createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
      jsonlStore<TheoremEvent>(dataDir),
      jsonBranchStore(dataDir),
      decideTheorem,
      reduceTheorem,
      initialTheorem
    );
    const prompts = loadTheoremPrompts();
    let axiomCalls = 0;
    const llmText = async (opts: { system?: string; user: string }): Promise<string> => {
      const user = opts.user;
      const system = opts.system ?? "";
      if (user.includes("\"action\": \"continue\" | \"done\"")) {
        return JSON.stringify({
          action: "continue",
          reason: "keep going",
          skip_lemma: false,
          skip_critique: false,
          skip_patch: false,
          skip_merge: false,
          focus: {},
        });
      }
      if (user.includes("\"attempt\": \"full attempt text\"")) {
        if (system.includes("Explorer A")) {
          return JSON.stringify({
            attempt: "Step 1: Formalize the equality statement.\nStep 2: Use reflexivity in Lean.",
            lemmas: ["L1: Equality is reflexive."],
            gaps: [],
            axiom_task: "Write Main.lean proving theorem foo : x = x and validate it with AXLE.",
            axiom_config: { maxIterations: 6, autoRepair: true },
          });
        }
        return JSON.stringify({
          attempt: "Step 1: Use reflexivity.\nStep 2: Conclude the theorem.",
          lemmas: ["L1: Reflexivity"],
          gaps: [],
        });
      }
      if (user.includes("\"lemmas\": [") && user.includes("\"statement\"")) {
        return JSON.stringify({
          lemmas: [{ label: "L1", statement: "For any x, x = x.", usage: "Main step" }],
        });
      }
      if (user.includes("\"issues\": [")) {
        return JSON.stringify({ issues: [], summary: "No issues found." });
      }
      if (user.includes("\"patch\": \"patched proof text\"")) {
        return JSON.stringify({ patch: "No changes required.", remaining_gaps: [] });
      }
      if (user.includes("\"summary\": \"merged summary\"")) {
        return JSON.stringify({ summary: "Merged proof summary with AXLE-backed branch evidence.", gaps: [] });
      }
      if (user.includes("\"status\": \"valid | needs | false\"")) {
        return JSON.stringify({ status: "valid", notes: ["The branch arguments are coherent."] });
      }
      if (user.includes("\"proof\": \"final proof text\"") || user.includes("\"proof\": \"revised proof text\"")) {
        return JSON.stringify({
          proof: "Proof:\nStep 1: By reflexivity, x = x.\nConclusion.",
          confidence: 0.91,
          gaps: [],
        });
      }
      return "{}";
    };

    const runId = `run_${Date.now()}_axiom_worker`;
    await runTheoremGuild({
      stream: "theorem",
      runId,
      problem: "Prove x = x",
      config: { rounds: 1, maxDepth: 1, memoryWindow: 20, branchThreshold: 2 },
      runtime,
      prompts,
      llmText,
      model: "gpt-4o",
      apiReady: true,
      axiomDelegate: async ({ task }) => {
        axiomCalls += 1;
        return {
          status: "completed",
          jobId: "job_axiom_test",
          runId: "axiom_subrun_1",
          stream: "agents/axiom",
          summary: `Validated Lean branch for task: ${task}\nMain.lean compiles with no errors.`,
        };
      },
    });

    const mainChain = await runtime.chain(theoremRunStream("theorem", runId));
    const branchChain = await runtime.chain(`${theoremRunStream("theorem", runId)}/branches/explorer_a`);

    expect(axiomCalls).toBe(1);
    expect(
      mainChain.some((r) => r.body.type === "tool.called" && r.body.tool === "axiom.delegate")
    ).toBeTruthy();
    expect(
      mainChain.some((r) => r.body.type === "subagent.merged" && /Main\.lean compiles/.test(r.body.summary))
    ).toBeTruthy();
    expect(
      branchChain.some((r) => r.body.type === "attempt.proposed" && /AXIOM Worker:\nValidated Lean branch/.test(r.body.content))
    ).toBeTruthy();
    expect(
      mainChain.some((r) => r.body.type === "solution.finalized")
    ).toBeTruthy();
  } finally {
    if (oldPassK === undefined) delete process.env.THEOREM_PASS_K;
    else process.env.THEOREM_PASS_K = oldPassK;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 120_000);

test("theorem: axiom-required policy completes only with final AXLE verify evidence", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-theorem-axiom-required-"));
  const oldPassK = process.env.THEOREM_PASS_K;
  process.env.THEOREM_PASS_K = "1";

  try {
    const runtime = createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
      jsonlStore<TheoremEvent>(dataDir),
      jsonBranchStore(dataDir),
      decideTheorem,
      reduceTheorem,
      initialTheorem
    );
    const prompts = loadTheoremPrompts();
    const axiomTasks: string[] = [];
    const verifiedContent = [
      "namespace ReceiptAxiomVerify",
      "",
      "theorem foo_candidate : x = x := by",
      "  rfl",
      "",
      "end ReceiptAxiomVerify",
    ].join("\n");
    const formalStatement = [
      "namespace ReceiptAxiomVerify",
      "",
      "theorem foo_candidate : x = x := sorry",
      "",
      "end ReceiptAxiomVerify",
    ].join("\n");

    const llmText = async ({ user }: { system?: string; user: string }): Promise<string> => {
      if (user.includes("\"action\": \"continue\" | \"done\"")) {
        return JSON.stringify({
          action: "continue",
          reason: "continue",
          skip_lemma: false,
          skip_critique: false,
          skip_patch: false,
          skip_merge: false,
          focus: {},
        });
      }
      if (user.includes("\"attempt\": \"full attempt text\"")) {
        return JSON.stringify({
          attempt: "Step 1: Use reflexivity.\nStep 2: Conclude x = x.",
          lemmas: ["L1: reflexivity closes the goal"],
          gaps: [],
        });
      }
      if (user.includes("\"lemmas\": [") && user.includes("\"statement\"")) {
        return JSON.stringify({
          lemmas: [{ label: "L1", statement: "For any x, x = x.", usage: "Main step" }],
        });
      }
      if (user.includes("\"issues\": [")) {
        return JSON.stringify({ issues: [], summary: "No issues found." });
      }
      if (user.includes("\"patch\": \"patched proof text\"")) {
        return JSON.stringify({ patch: "No changes required.", remaining_gaps: [] });
      }
      if (user.includes("\"summary\": \"merged summary\"")) {
        return JSON.stringify({ summary: "Merged proof summary.", gaps: [] });
      }
      if (user.includes("\"status\": \"valid | needs | false\"")) {
        return JSON.stringify({ status: "valid", notes: ["The prose proof is coherent."] });
      }
      if (user.includes("\"proof\": \"final proof text\"") || user.includes("\"proof\": \"revised proof text\"")) {
        return JSON.stringify({
          proof: "Proof:\nStep 1: By reflexivity, x = x.\nConclusion.",
          confidence: 0.93,
          gaps: [],
        });
      }
      return "{}";
    };

    const runId = `run_${Date.now()}_axiom_required`;
    await runTheoremGuild({
      stream: "agents/axiom-guild",
      runId,
      problem: "Prove x = x",
      config: { rounds: 1, maxDepth: 1, memoryWindow: 20, branchThreshold: 2 },
      runtime,
      prompts,
      llmText,
      model: "gpt-4o",
      apiReady: true,
      axiomPolicy: "required",
      axiomConfig: { maxIterations: 12, autoRepair: true },
      axiomDelegate: async ({ task }) => {
        axiomTasks.push(task);
        return {
          status: "completed",
          jobId: "job_verify",
          runId: "axiom_subrun_verify",
          stream: "agents/axiom",
          outcome: "verified",
          summary: "AXLE tools: lean.verify\nvalidation: verified candidate Lean branch",
          evidence: [{
            tool: "lean.verify",
            environment: "lean-4.28.0",
            candidateHash: hashText(verifiedContent),
            formalStatementHash: hashText(formalStatement),
            ok: true,
            failedDeclarations: [],
            timings: { total_ms: 8 },
          }],
          verifiedCandidateContent: verifiedContent,
          verifiedCandidateHash: hashText(verifiedContent),
          verifiedFormalStatementHash: hashText(formalStatement),
        };
      },
    });

    const mainChain = await runtime.chain(theoremRunStream("agents/axiom-guild", runId));
    const toolEvents = mainChain.filter((r): r is typeof r & { body: Extract<TheoremEvent, { type: "tool.called" }> } =>
      r.body.type === "tool.called" && r.body.tool === "axiom.delegate"
    );
    const verifyReport = mainChain.find((r): r is typeof r & { body: Extract<TheoremEvent, { type: "verification.report" }> } =>
      r.body.type === "verification.report"
    );
    const finalStatus = mainChain.findLast((r): r is typeof r & { body: Extract<TheoremEvent, { type: "run.status" }> } =>
      r.body.type === "run.status"
    );
    const finalSolution = mainChain.findLast((r): r is typeof r & { body: Extract<TheoremEvent, { type: "solution.finalized" }> } =>
      r.body.type === "solution.finalized"
    );

    expect(axiomTasks.length).toBe(1);
    expect(
      axiomTasks.some((task) => task.includes("Use AXLE as the required ground-truth verifier"))
    ).toBeTruthy();
    expect(toolEvents.length).toBe(1);
    expect(finalStatus?.body.status).toBe("completed");
    expect(
      verifyReport?.body.content.includes("AXIOM Worker:\nAXLE tools: lean.verify")
    ).toBeTruthy();
    expect(verifyReport?.body.status).toBe("valid");
    expect(verifyReport?.body.evidence?.tool).toBe("lean.verify");
    expect(finalSolution?.body.content).toBe(verifiedContent);
  } finally {
    if (oldPassK === undefined) delete process.env.THEOREM_PASS_K;
    else process.env.THEOREM_PASS_K = oldPassK;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 120_000);

test("theorem: axiom-required policy fails when final AXLE evidence is only lean.check", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-theorem-axiom-check-only-"));
  const oldPassK = process.env.THEOREM_PASS_K;
  process.env.THEOREM_PASS_K = "1";

  try {
    const runtime = createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
      jsonlStore<TheoremEvent>(dataDir),
      jsonBranchStore(dataDir),
      decideTheorem,
      reduceTheorem,
      initialTheorem
    );
    const prompts = loadTheoremPrompts();

    const llmText = async ({ user }: { system?: string; user: string }): Promise<string> => {
      if (user.includes("\"action\": \"continue\" | \"done\"")) {
        return JSON.stringify({
          action: "continue",
          reason: "continue",
          skip_lemma: false,
          skip_critique: false,
          skip_patch: false,
          skip_merge: false,
          focus: {},
        });
      }
      if (user.includes("\"attempt\": \"full attempt text\"")) {
        return JSON.stringify({
          attempt: "Step 1: Use reflexivity.\nStep 2: Conclude x = x.",
          lemmas: ["L1: reflexivity closes the goal"],
          gaps: [],
        });
      }
      if (user.includes("\"lemmas\": [") && user.includes("\"statement\"")) {
        return JSON.stringify({
          lemmas: [{ label: "L1", statement: "For any x, x = x.", usage: "Main step" }],
        });
      }
      if (user.includes("\"issues\": [")) {
        return JSON.stringify({ issues: [], summary: "No issues found." });
      }
      if (user.includes("\"patch\": \"patched proof text\"")) {
        return JSON.stringify({ patch: "No changes required.", remaining_gaps: [] });
      }
      if (user.includes("\"summary\": \"merged summary\"")) {
        return JSON.stringify({ summary: "Merged proof summary.", gaps: [] });
      }
      if (user.includes("\"status\": \"valid | needs | false\"")) {
        return JSON.stringify({ status: "valid", notes: ["The prose proof is coherent."] });
      }
      if (user.includes("\"proof\": \"final proof text\"") || user.includes("\"proof\": \"revised proof text\"")) {
        return JSON.stringify({
          proof: "Proof:\nStep 1: By reflexivity, x = x.\nConclusion.",
          confidence: 0.93,
          gaps: [],
        });
      }
      return "{}";
    };

    const runId = `run_${Date.now()}_axiom_check_only`;
    await runTheoremGuild({
      stream: "agents/axiom-guild",
      runId,
      problem: "Prove x = x",
      config: { rounds: 1, maxDepth: 1, memoryWindow: 20, branchThreshold: 2 },
      runtime,
      prompts,
      llmText,
      model: "gpt-4o",
      apiReady: true,
      axiomPolicy: "required",
      axiomConfig: { maxIterations: 12, autoRepair: true },
      axiomDelegate: async () => ({
        status: "completed",
        jobId: "job_check_only",
        runId: "axiom_subrun_check_only",
        stream: "agents/axiom",
        outcome: "no_final_verify",
        summary: "AXLE tools: lean.check\nvalidation: candidate compiles but was not verify_proof-checked",
        evidence: [{
          tool: "lean.check",
          environment: "lean-4.28.0",
          candidateHash: hashText("theorem foo : x = x := by\n  rfl"),
          ok: true,
          failedDeclarations: [],
          timings: { total_ms: 6 },
        }],
      }),
    });

    const chain = await runtime.chain(theoremRunStream("agents/axiom-guild", runId));
    const finalStatus = chain.findLast((r): r is typeof r & { body: Extract<TheoremEvent, { type: "run.status" }> } =>
      r.body.type === "run.status"
    );
    const verifyReport = chain.findLast((r): r is typeof r & { body: Extract<TheoremEvent, { type: "verification.report" }> } =>
      r.body.type === "verification.report"
    );

    expect(finalStatus?.body.status).toBe("failed");
    expect(verifyReport?.body.status).toBe("needs");
    expect(verifyReport?.body.content ?? "").toMatch(/AXIOM verification evidence missing/i);
  } finally {
    if (oldPassK === undefined) delete process.env.THEOREM_PASS_K;
    else process.env.THEOREM_PASS_K = oldPassK;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 120_000);

test("theorem: optional runs keep completed status when verifier returns needs", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-theorem-optional-needs-"));
  const oldPassK = process.env.THEOREM_PASS_K;
  process.env.THEOREM_PASS_K = "1";

  try {
    const runtime = createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
      jsonlStore<TheoremEvent>(dataDir),
      jsonBranchStore(dataDir),
      decideTheorem,
      reduceTheorem,
      initialTheorem
    );
    const prompts = loadTheoremPrompts();
    const llmText = async ({ user }: { system?: string; user: string }): Promise<string> => {
      if (user.includes("\"action\": \"continue\" | \"done\"")) {
        return JSON.stringify({
          action: "continue",
          reason: "continue",
          skip_lemma: false,
          skip_critique: false,
          skip_patch: false,
          skip_merge: false,
          focus: {},
        });
      }
      if (user.includes("\"attempt\": \"full attempt text\"")) {
        return JSON.stringify({
          attempt: "Step 1: Try a direct argument.\nStep 2: This still needs a missing justification.",
          lemmas: [],
          gaps: ["Need a tighter final step."],
        });
      }
      if (user.includes("Extract 2-6 precise lemmas that are actually used.")) {
        return JSON.stringify({
          lemmas: [
            { label: "L1", statement: "A tighter final step is still needed.", usage: "Remaining gap tracking." },
          ],
        });
      }
      if (user.includes("List concrete flaws or missing steps.")) {
        return JSON.stringify({ issues: [], summary: "No extra critique." });
      }
      if (user.includes("Patch the attempt for the provided critiques only.")) {
        return JSON.stringify({ patch: "No changes required.", remaining_gaps: ["Need a tighter final step."] });
      }
      if (user.includes("\"summary\": \"merged summary\"")) {
        return JSON.stringify({ summary: "Merged summary with one remaining gap.", gaps: ["Need a tighter final step."] });
      }
      if (user.includes("\"status\": \"valid | needs | false\"")) {
        return JSON.stringify({ status: "needs", notes: ["Need a tighter final step."] });
      }
      if (user.includes("\"proof\": \"final proof text\"") || user.includes("\"proof\": \"revised proof text\"")) {
        return JSON.stringify({
          proof: "Proof:\nA draft argument remains incomplete.\nEND_OF_PROOF",
          confidence: 0.51,
          gaps: ["Need a tighter final step."],
        });
      }
      return "{}";
    };

    const runId = `run_${Date.now()}_optional_needs`;
    const result = await runTheoremGuild({
      stream: "agents/theorem",
      runId,
      problem: "Prove a theorem with one remaining gap.",
      config: { rounds: 1, maxDepth: 1, memoryWindow: 20, branchThreshold: 2 },
      runtime,
      prompts,
      llmText,
      model: "gpt-4o",
      apiReady: true,
    });

    const chain = await runtime.chain(theoremRunStream("agents/theorem", runId));
    const finalStatus = chain.findLast((r): r is typeof r & { body: Extract<TheoremEvent, { type: "run.status" }> } =>
      r.body.type === "run.status"
    );
    const failureReport = chain.findLast((r): r is typeof r & { body: Extract<TheoremEvent, { type: "failure.report" }> } =>
      r.body.type === "failure.report"
    );

    expect(result.status).toBe("completed");
    expect(finalStatus?.body.status).toBe("completed");
    expect(finalStatus?.body.note ?? "").toMatch(/Final verification failed:/);
    expect(failureReport).toBe(undefined);
  } finally {
    if (oldPassK === undefined) delete process.env.THEOREM_PASS_K;
    else process.env.THEOREM_PASS_K = oldPassK;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 120_000);
