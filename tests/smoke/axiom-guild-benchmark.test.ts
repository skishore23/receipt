import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  AXIOM_GUILD_BENCHMARKS,
  getAxiomGuildBenchmarkCase,
  runAxiomGuildBenchmarkCase,
} from "../../src/evals/axiom-guild-benchmark.ts";

const structuredFromText = <T extends { system?: string; user: string }>(llmText: (opts: T) => Promise<string>) =>
  (async ({ system, user }: { system?: string; user: string }) => {
    const raw = await llmText({ system, user } as T);
    return {
      parsed: JSON.parse(raw) as never,
      raw,
    };
  });

test("axiom-guild benchmark registry includes infinitely_many_primes", () => {
  const item = getAxiomGuildBenchmarkCase("infinitely_many_primes");
  assert.ok(item);
  assert.equal(item?.theoremName, "infinitely_many_primes");
  assert.equal(AXIOM_GUILD_BENCHMARKS.length >= 1, true);
});

test("axiom-guild benchmark runner requires final queued AXLE verify evidence", async () => {
  const benchmark = getAxiomGuildBenchmarkCase("infinitely_many_primes");
  assert.ok(benchmark, "missing axiom-guild benchmark case");

  const referenceContent = await fs.readFile(path.join(process.cwd(), benchmark!.referenceFile), "utf-8");
  const theoremToSorryContent = referenceContent.replace(
    /theorem infinitely_many_primes : ∀ n : Nat, ∃ p > n, Nat\.Prime p := by[\s\S]*?namespace EuclidNat/,
    "theorem infinitely_many_primes : ∀ n : Nat, ∃ p > n, Nat.Prime p := sorry\n\nnamespace EuclidNat"
  );

  const originalFetch = globalThis.fetch;
  const originalApiUrl = process.env.AXLE_API_URL;
  const originalApiKey = process.env.AXLE_API_KEY;
  const originalPassK = process.env.THEOREM_PASS_K;
  process.env.AXLE_API_URL = "https://axle.example.test";
  process.env.AXLE_API_KEY = "test-key";
  process.env.THEOREM_PASS_K = "1";

  const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    fetchCalls.push({ url, body });

    if (url.endsWith("/api/v1/theorem2sorry")) {
      return new Response(JSON.stringify({
        okay: true,
        content: theoremToSorryContent,
        lean_messages: { errors: [], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: [],
        timings: { total_ms: 11 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/api/v1/verify_proof")) {
      assert.equal(body.formal_statement, theoremToSorryContent);
      assert.equal(body.content, referenceContent);
      return new Response(JSON.stringify({
        okay: true,
        content: referenceContent,
        lean_messages: { errors: [], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: [],
        timings: { total_ms: 19 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  let axiomVerifyCalls = 0;
  const llmText = async ({ user }: { system?: string; user: string }) => {
    if (user.includes("Goal:")) {
      axiomVerifyCalls += 1;
      if (axiomVerifyCalls === 1) {
        return JSON.stringify({
          thought: "Verify the reference candidate against the exact sorried theorem artifact.",
          action: {
            type: "tool",
            name: "lean.verify",
            input: {
              content: referenceContent,
              formal_statement: theoremToSorryContent,
              environment: "lean-4.28.0",
            },
          },
        });
      }
      return JSON.stringify({
        thought: "AXLE verified the candidate.",
        action: {
          type: "final",
          text: "Final AXLE verification succeeded against the theorem2sorry artifact.",
        },
      });
    }

    if (user.includes("Task:\nDecide whether the solution is complete.")) {
      return JSON.stringify({
        action: "continue",
        reason: "Need the final AXLE gate before completion.",
        skip_lemma: true,
        skip_critique: true,
        skip_patch: true,
        skip_merge: false,
        focus: {},
      });
    }
    if (user.includes("Task:\nWrite a solution attempt with numbered steps.")) {
      return JSON.stringify({
        attempt: "Use `Nat.exists_infinite_primes` to obtain a prime `p > n` and close the goal directly.",
        lemmas: ["L1: `Nat.exists_infinite_primes (n + 1)` produces a prime strictly above `n`."],
        gaps: [],
      });
    }
    if (user.includes("Merge into one concise summary") || user.includes("Produce one concise summary")) {
      return JSON.stringify({
        summary: "Use `Nat.exists_infinite_primes` and strengthen `p > n + 1` to `p > n`.",
        gaps: [],
      });
    }
    if (user.includes("\"status\": \"valid | needs | false\"") && user.includes("\"axiom_task\"")) {
      return JSON.stringify({
        status: "valid",
        notes: ["The mathematical route is sound; require AXLE for the final Lean gate."],
      });
    }
    if (user.includes("Task:\nProduce the final proof/solution.") || user.includes("Task:\nFix the proof using verifier notes.")) {
      return JSON.stringify({
        proof: [
          "Proof:",
          "Use `Nat.exists_infinite_primes (n + 1)` to obtain a prime `p` with `n + 1 < p`.",
          "Then `n < p` follows, so the theorem holds.",
        ].join("\n"),
        confidence: 0.94,
        gaps: [],
      });
    }
    return "{}";
  };
  try {
    const result = await runAxiomGuildBenchmarkCase({
      benchmark: benchmark!,
      keepWorkspace: false,
      llmText,
      llmStructured: structuredFromText(llmText),
    });

    assert.equal(result.passed, true);
    assert.equal(result.benchmarkId, "infinitely_many_primes");
    assert.equal(result.checks.every((check) => check.ok), true);
    assert.equal(axiomVerifyCalls >= 2, true, "expected queued Axiom verify tool call plus final response");
    assert.equal(fetchCalls[0]?.url, "https://axle.example.test/api/v1/theorem2sorry");
    assert.equal(fetchCalls.some((call) => call.url === "https://axle.example.test/api/v1/verify_proof"), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.AXLE_API_URL;
    else process.env.AXLE_API_URL = originalApiUrl;
    if (originalApiKey === undefined) delete process.env.AXLE_API_KEY;
    else process.env.AXLE_API_KEY = originalApiKey;
    if (originalPassK === undefined) delete process.env.THEOREM_PASS_K;
    else process.env.THEOREM_PASS_K = originalPassK;
  }
});
