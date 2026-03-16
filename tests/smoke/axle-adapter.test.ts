import { test, expect } from "bun:test";

import {
  axleHaveToLemma,
  axleHaveToSorry,
  axleRename,
  axleTheoremToLemma,
  axleVerifyProof,
  type AxleResult,
} from "../../src/adapters/axle.ts";

type FetchCall = {
  readonly url: string;
  readonly method: string;
  readonly auth: string | null;
  readonly body: Record<string, unknown>;
};

test("axle adapter routes structure-editing tools to the expected endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  const responses: AxleResult[] = [
    {
      okay: true,
      content: "theorem bar : 1 = 1 := by\n  rfl\n",
      lean_messages: { errors: [], warnings: [], infos: [] },
      tool_messages: { errors: [], warnings: [], infos: [] },
      failed_declarations: [],
      timings: { total_ms: 11 },
    },
    {
      okay: true,
      content: "lemma foo : 1 = 1 := by\n  rfl\n",
      lean_messages: { errors: [], warnings: [], infos: [] },
      tool_messages: { errors: [], warnings: [], infos: [] },
      failed_declarations: [],
      timings: { total_ms: 12 },
    },
    {
      okay: true,
      content: "lemma lifted_have : 1 = 1 := by\n  rfl\n",
      lean_messages: { errors: [], warnings: [], infos: [] },
      tool_messages: { errors: [], warnings: [], infos: [] },
      failed_declarations: [],
      timings: { total_ms: 13 },
      lemma_names: ["lifted_have"],
    },
    {
      okay: true,
      content: "have h : 1 = 1 := sorry\nexact h\n",
      lean_messages: { errors: [], warnings: [], infos: [] },
      tool_messages: { errors: [], warnings: [], infos: [] },
      failed_declarations: [],
      timings: { total_ms: 14 },
    },
  ];

  globalThis.fetch = (async (input, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: headers.get("Authorization"),
      body,
    });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected fetch URL: ${String(input)}`);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const baseUrl = "https://axle.example.test";
    const apiKey = "test-key";

    const renamed = await axleRename({
      content: "theorem foo : 1 = 1 := by\n  rfl\n",
      declarations: { foo: "bar" },
      environment: "lean-4.28.0",
      ignore_imports: true,
      timeout_seconds: 90,
    }, { baseUrl, apiKey });
    const theoremAsLemma = await axleTheoremToLemma({
      content: "theorem foo : 1 = 1 := by\n  rfl\n",
      names: ["foo"],
      target: "lemma",
      environment: "lean-4.28.0",
      ignore_imports: true,
      timeout_seconds: 60,
    }, { baseUrl, apiKey });
    const liftedHave = await axleHaveToLemma({
      content: "theorem foo : 1 = 1 := by\n  have h : 1 = 1 := by\n    rfl\n  exact h\n",
      include_have_body: true,
      reconstruct_callsite: true,
      verbosity: 2,
      environment: "lean-4.28.0",
      ignore_imports: true,
      timeout_seconds: 75,
    }, { baseUrl, apiKey });
    const haveAsSorry = await axleHaveToSorry({
      content: "theorem foo : 1 = 1 := by\n  have h : 1 = 1 := by\n    rfl\n  exact h\n",
      indices: [0],
      environment: "lean-4.28.0",
      ignore_imports: true,
      timeout_seconds: 45,
    }, { baseUrl, apiKey });

    expect(
      calls.map((call) => ({ url: call.url, method: call.method, body: call.body })),
    ).toEqual(
      [
        {
          url: "https://axle.example.test/api/v1/rename",
          method: "POST",
          body: {
            content: "theorem foo : 1 = 1 := by\n  rfl\n",
            declarations: { foo: "bar" },
            environment: "lean-4.28.0",
            ignore_imports: true,
            timeout_seconds: 90,
          },
        },
        {
          url: "https://axle.example.test/api/v1/theorem2lemma",
          method: "POST",
          body: {
            content: "theorem foo : 1 = 1 := by\n  rfl\n",
            names: ["foo"],
            target: "lemma",
            environment: "lean-4.28.0",
            ignore_imports: true,
            timeout_seconds: 60,
          },
        },
        {
          url: "https://axle.example.test/api/v1/have2lemma",
          method: "POST",
          body: {
            content: "theorem foo : 1 = 1 := by\n  have h : 1 = 1 := by\n    rfl\n  exact h\n",
            include_have_body: true,
            reconstruct_callsite: true,
            verbosity: 2,
            environment: "lean-4.28.0",
            ignore_imports: true,
            timeout_seconds: 75,
          },
        },
        {
          url: "https://axle.example.test/api/v1/have2sorry",
          method: "POST",
          body: {
            content: "theorem foo : 1 = 1 := by\n  have h : 1 = 1 := by\n    rfl\n  exact h\n",
            indices: [0],
            environment: "lean-4.28.0",
            ignore_imports: true,
            timeout_seconds: 45,
          },
        },
      ]
    );
    expect(calls.every((call) => call.auth === "Bearer test-key")).toBeTruthy();
    expect(renamed.content).toMatch(/theorem bar/);
    expect(theoremAsLemma.content).toMatch(/lemma foo/);
    expect(liftedHave.lemma_names).toEqual(["lifted_have"]);
    expect(haveAsSorry.content).toMatch(/sorry/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("axle verify retries import mismatch with ignore_imports and treats user_error as failure", async () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("Authorization"),
      body,
    });
    const isRetry = body.ignore_imports === true;
    const response = isRetry
      ? {
          okay: true,
          content: "import Mathlib.Combinatorics.Hall\n\ntheorem hall_marriage_finset := by\n  trivial\n",
          lean_messages: { errors: [], warnings: [], infos: [] },
          tool_messages: { errors: [], warnings: [], infos: [] },
          failed_declarations: [],
          timings: { total_ms: 7 },
        }
      : {
          user_error: "Imports mismatch: expected '[Mathlib]', got '[Mathlib.Combinatorics.Hall]'",
          info: {
            total_request_time_ms: 5,
            queue_time_ms: 1,
            execution_time_ms: 4,
          },
        };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await axleVerifyProof({
      content: "import Mathlib.Combinatorics.Hall\n\ntheorem hall_marriage_finset := by\n  trivial\n",
      formal_statement: "import Mathlib.Combinatorics.Hall\n\ntheorem hall_marriage_finset := by\n  sorry\n",
      environment: "lean-4.28.0",
      timeout_seconds: 30,
    }, { baseUrl: "https://axle.example.test" });

    expect(result.okay).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[0]?.url).toBe("https://axle.example.test/api/v1/verify_proof");
    expect(calls[0]?.body.ignore_imports).toBe(undefined);
    expect(calls[1]?.body.ignore_imports).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
