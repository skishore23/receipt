import assert from "node:assert/strict";
import test from "node:test";

import { AXIOM_BENCHMARKS, getAxiomBenchmarkCase, runAxiomBenchmarkCase } from "../../src/evals/axiom-benchmark.ts";

const structuredFromText = <T extends { system?: string; user: string }>(llmText: (opts: T) => Promise<string>) =>
  (async ({ system, user }: { system?: string; user: string }) => {
    const raw = await llmText({ system, user } as T);
    return {
      parsed: JSON.parse(raw) as never,
      raw,
    };
  });

test("axiom benchmark registry includes the starter theorem", () => {
  const item = getAxiomBenchmarkCase("list_length_append_nat");
  assert.ok(item);
  assert.equal(item?.theoremName, "list_length_append_nat");
  assert.equal(AXIOM_BENCHMARKS.length >= 1, true);
});

test("axiom benchmark runner passes for the starter theorem with AXLE validation", async () => {
  const benchmark = getAxiomBenchmarkCase("list_length_append_nat");
  assert.ok(benchmark, "missing benchmark case");

  const originalFetch = globalThis.fetch;
  const originalApiUrl = process.env.AXLE_API_URL;
  const originalApiKey = process.env.AXLE_API_KEY;
  process.env.AXLE_API_URL = "https://axle.example.test";
  process.env.AXLE_API_KEY = "test-key";

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/check")) {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      return new Response(JSON.stringify({
        okay: true,
        content: body.content,
        lean_messages: { errors: [], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: [],
        timings: { total_ms: 9 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  let calls = 0;
  const llmText = async () => {
    calls += 1;
    if (calls === 1) {
      return JSON.stringify({
        thought: "Write the theorem file first.",
        action: {
          type: "tool",
          name: "write",
          input: {
            path: "Main.lean",
            content: [
              "import Mathlib",
              "",
              "theorem list_length_append_nat (xs ys : List Nat) :",
              "  List.length (xs ++ ys) = List.length xs + List.length ys := by",
              "  simpa using List.length_append xs ys",
              "",
            ].join("\n"),
          },
        },
      });
    }
    if (calls === 2) {
      return JSON.stringify({
        thought: "Validate the file with AXLE.",
        action: {
          type: "tool",
          name: "lean.check_file",
          input: { path: "Main.lean" },
        },
      });
    }
    return JSON.stringify({
      thought: "The theorem is validated.",
      action: {
        type: "final",
        text: "Main.lean now contains list_length_append_nat and it was validated with AXLE.",
      },
    });
  };
  try {
    const result = await runAxiomBenchmarkCase({
      benchmark: benchmark!,
      keepWorkspace: false,
      llmText,
      llmStructured: structuredFromText(llmText),
    });

    assert.equal(result.passed, true);
    assert.equal(result.benchmarkId, "list_length_append_nat");
    assert.match(result.finalResponse ?? "", /validated with AXLE/i);
    assert.equal(result.checks.every((check) => check.ok), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.AXLE_API_URL;
    else process.env.AXLE_API_URL = originalApiUrl;
    if (originalApiKey === undefined) delete process.env.AXLE_API_KEY;
    else process.env.AXLE_API_KEY = originalApiKey;
  }
});
