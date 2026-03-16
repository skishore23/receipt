import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import {
  runTheoremGuild,
  type TheoremAxiomDelegateResult,
} from "../../src/agents/theorem.ts";
import { theoremRunStream } from "../../src/agents/theorem.streams.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import type { TheoremEvent } from "../../src/modules/theorem.ts";
import {
  decide as decideTheorem,
  reduce as reduceTheorem,
  initial as initialTheorem,
  type TheoremCmd,
  type TheoremState,
} from "../../src/modules/theorem.ts";
import { loadTheoremPrompts } from "../../src/prompts/theorem.ts";

const hashText = (input: string): string =>
  createHash("sha256").update(input, "utf-8").digest("hex");

const mkRuntime = (dir: string) => createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
  jsonlStore<TheoremEvent>(dir),
  jsonBranchStore(dir),
  decideTheorem,
  reduceTheorem,
  initialTheorem
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

const mkVerifyEvidence = (name = "foo_candidate"): TheoremAxiomDelegateResult => {
  const verifiedCandidateContent = [
    "namespace ReceiptHintCheck",
    "",
    `theorem ${name} : x = x := by`,
    "  rfl",
    "",
    "end ReceiptHintCheck",
  ].join("\n");
  const formalStatement = [
    "namespace ReceiptHintCheck",
    "",
    `theorem ${name} : x = x := sorry`,
    "",
    "end ReceiptHintCheck",
  ].join("\n");
  const verifiedCandidateHash = hashText(verifiedCandidateContent);
  const verifiedFormalStatementHash = hashText(formalStatement);
  return {
    status: "completed",
    summary: "AXLE tools: lean.verify\nvalidation: verified candidate",
    jobId: "job_axiom_hints",
    runId: "axiom_hints_run",
    stream: "agents/axiom",
    outcome: "verified",
    evidence: [{
      tool: "lean.verify",
      environment: "lean-4.28.0",
      candidateHash: verifiedCandidateHash,
      formalStatementHash: verifiedFormalStatementHash,
      ok: true,
      failedDeclarations: [],
      timings: { total_ms: 7 },
    }],
    verifiedCandidateContent,
    verifiedCandidateHash,
    verifiedFormalStatementHash,
  };
};

const mkLlm = (opts: {
  readonly explorerAAttempt?: Record<string, unknown>;
  readonly verify?: Record<string, unknown>;
  readonly proof?: Record<string, unknown>;
}) => async ({ system, user }: { system?: string; user: string }): Promise<string> => {
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
    if ((system ?? "").includes("Explorer A")) {
      return JSON.stringify(opts.explorerAAttempt ?? {
        attempt: "Step 1: Use reflexivity.\nStep 2: Conclude x = x.",
        lemmas: ["L1: reflexivity closes the goal"],
        gaps: [],
      });
    }
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
    return JSON.stringify(opts.verify ?? { status: "valid", notes: ["Proof is coherent."] });
  }
  if (user.includes("\"proof\": \"final proof text\"") || user.includes("\"proof\": \"revised proof text\"")) {
    return JSON.stringify(opts.proof ?? {
      proof: "Proof:\nStep 1: By reflexivity, x = x.\nConclusion.",
      confidence: 0.92,
      gaps: [],
    });
  }
  return "{}";
};

const readTaskHints = (config?: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined => {
  const hints = config?.taskHints;
  return hints && typeof hints === "object" && !Array.isArray(hints)
    ? hints as Record<string, unknown>
    : undefined;
};

const readRequiredValidation = (config?: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined => {
  const validation = config?.requiredValidation;
  return validation && typeof validation === "object" && !Array.isArray(validation)
    ? validation as Record<string, unknown>
    : undefined;
};

const readDelegateInput = (chain: Awaited<ReturnType<ReturnType<typeof mkRuntime>["chain"]>>) =>
  chain.find((receipt): receipt is typeof receipt & { body: Extract<TheoremEvent, { type: "tool.called" }> } =>
    receipt.body.type === "tool.called" && receipt.body.tool === "axiom.delegate"
  )?.body.input as Record<string, unknown> | undefined;

const runVerifyHintScenario = async (opts: {
  readonly label: string;
  readonly verify: Record<string, unknown>;
  readonly proof: Record<string, unknown>;
  readonly expectedReason: string;
  readonly expectedTools: ReadonlyArray<string>;
}): Promise<void> => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `receipt-theorem-${opts.label}-`));

  try {
    const runtime = mkRuntime(dataDir);
    const prompts = loadTheoremPrompts();
    const delegateCalls: Array<{ task: string; config?: Readonly<Record<string, unknown>> }> = [];
    const runId = `run_${Date.now()}_${opts.label}`;

    await runTheoremGuild({
      stream: "agents/axiom-guild",
      runId,
      problem: "Prove x = x",
      config: { rounds: 1, maxDepth: 1, memoryWindow: 20, branchThreshold: 2 },
      runtime,
      prompts,
      llmText: mkLlm({
        verify: opts.verify,
        proof: opts.proof,
      }),
      model: "gpt-4o",
      apiReady: true,
      axiomPolicy: "required",
      axiomConfig: {
        maxIterations: 8,
        autoRepair: true,
        formalStatementPath: "FormalStatement.lean",
      },
      axiomDelegate: async (input) => {
        delegateCalls.push({ task: input.task, config: input.config });
        return mkVerifyEvidence();
      },
    });

    expect(delegateCalls.length).toBe(1);
    const taskHints = readTaskHints(delegateCalls[0]?.config);
    expect(taskHints?.reason).toBe(opts.expectedReason);
    expect(taskHints?.preferredTools).toEqual(opts.expectedTools);
    expect(taskHints?.formalStatementPath).toBe("FormalStatement.lean");
    expect(readRequiredValidation(delegateCalls[0]?.config)).toEqual({
      kind: "axle-verify",
      formalStatementPath: "FormalStatement.lean",
    });

    const chain = await runtime.chain(theoremRunStream("agents/axiom-guild", runId));
    const delegateInput = readDelegateInput(chain);
    const inputHints = delegateInput?.hints as Record<string, unknown> | undefined;
    expect(inputHints?.reason).toBe(opts.expectedReason);
    expect(inputHints?.preferredTools).toEqual(opts.expectedTools);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
};

test("theorem forwards explicit axiom_hints from structured explorer output to axiom.delegate", async () => {
  await withPassKOne(async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-theorem-explicit-hints-"));

    try {
      const runtime = mkRuntime(dataDir);
      const prompts = loadTheoremPrompts();
      const delegateCalls: Array<{ task: string; config?: Readonly<Record<string, unknown>> }> = [];
      const runId = `run_${Date.now()}_explicit_hints`;

      await runTheoremGuild({
        stream: "agents/axiom-guild",
        runId,
        problem: "Prove x = x",
        config: { rounds: 1, maxDepth: 1, memoryWindow: 20, branchThreshold: 2 },
        runtime,
        prompts,
        llmText: mkLlm({
          explorerAAttempt: {
            attempt: "Step 1: Formalize the branch.\nStep 2: Use reflexivity.",
            lemmas: ["L1: reflexivity closes the goal"],
            gaps: [],
            axiom_task: "Rewrite Main.lean and verify the branch with AXLE.",
            axiom_config: { maxIterations: 6, autoRepair: true },
            axiom_hints: {
              preferredTools: ["lean.rename", "lean.theorem2lemma"],
              reason: "name_conflict",
              targetPath: "Main.lean",
              formalStatementPath: "Main.sorry.lean",
              declarationName: "foo",
            },
          },
        }),
        model: "gpt-4o",
        apiReady: true,
        axiomPolicy: "required",
        axiomConfig: {
          maxIterations: 8,
          autoRepair: true,
          formalStatementPath: "FormalStatement.lean",
        },
        axiomDelegate: async (input) => {
          delegateCalls.push({ task: input.task, config: input.config });
          return delegateCalls.length === 1
            ? {
                status: "completed",
                summary: "AXLE worker rewrote Main.lean and checked the branch.",
                jobId: "job_explicit_hints_branch",
                runId: "axiom_explicit_hints_branch",
                stream: "agents/axiom",
                outcome: "completed",
              }
            : mkVerifyEvidence();
        },
      });

      expect(delegateCalls.length).toBe(2);
      const taskHints = readTaskHints(delegateCalls[0]?.config);
      expect(taskHints?.reason).toBe("name_conflict");
      expect((taskHints?.preferredTools as string[] | undefined)?.slice(0, 2)).toEqual(["lean.rename", "lean.theorem2lemma"]);
      expect(taskHints?.targetPath).toBe("Main.lean");
      expect(taskHints?.formalStatementPath).toBe("Main.sorry.lean");
      expect(taskHints?.declarationName).toBe("foo");
      expect(readRequiredValidation(delegateCalls[0]?.config)).toBe(undefined);
      expect(readRequiredValidation(delegateCalls[1]?.config)).toEqual({
        kind: "axle-verify",
        formalStatementPath: "FormalStatement.lean",
      });

      const chain = await runtime.chain(theoremRunStream("agents/axiom-guild", runId));
      const delegateInput = readDelegateInput(chain);
      const inputHints = delegateInput?.hints as Record<string, unknown> | undefined;
      expect(inputHints?.reason).toBe("name_conflict");
      expect((inputHints?.preferredTools as string[] | undefined)?.slice(0, 2)).toEqual(["lean.rename", "lean.theorem2lemma"]);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
}, 120_000);

test("theorem infers rename-first AXLE repair hints for required verification", async () => {
  await withPassKOne(async () => {
    await runVerifyHintScenario({
      label: "rename_hints",
      verify: {
        status: "needs",
        notes: ["The declaration has already been declared in Mathlib; rename it before verification."],
      },
      proof: {
        proof: "Proof:\nStep 1: Formalize the theorem.\nStep 2: Resolve the naming collision.\nConclusion.",
        confidence: 0.71,
        gaps: [],
      },
      expectedReason: "name_conflict",
      expectedTools: ["lean.rename", "lean.theorem2sorry", "lean.verify"],
    });
  });
}, 120_000);

test("theorem infers decomposition-oriented AXLE repair hints for required verification", async () => {
  await withPassKOne(async () => {
    await runVerifyHintScenario({
      label: "decompose_hints",
      verify: {
        status: "needs",
        notes: ["Split the monolithic argument into an intermediate lemma before verification."],
      },
      proof: {
        proof: "Proof:\nStep 1: Establish the main invariant.\nStep 2: Reuse it to finish.\nConclusion.",
        confidence: 0.68,
        gaps: [],
      },
      expectedReason: "decompose_theorem",
      expectedTools: ["lean.theorem2lemma", "lean.theorem2sorry", "lean.verify"],
    });
  });
}, 120_000);

test("theorem infers have-obligation AXLE repair hints for required verification", async () => {
  await withPassKOne(async () => {
    await runVerifyHintScenario({
      label: "have_hints",
      verify: {
        status: "needs",
        notes: ["Extract the have callsite and repair that local obligation before verifying the theorem."],
      },
      proof: {
        proof: "theorem foo : x = x := by\n  have h : x = x := by\n    rfl\n  exact h",
        confidence: 0.66,
        gaps: [],
      },
      expectedReason: "extract_have_obligation",
      expectedTools: ["lean.have2lemma", "lean.have2sorry", "lean.theorem2sorry", "lean.verify"],
    });
  });
}, 120_000);
