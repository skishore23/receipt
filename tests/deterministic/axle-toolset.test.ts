import { test, expect, describe } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAxleToolset } from "../../src/agents/axiom/axle-tools.ts";
import { normalizeAxiomConfig } from "../../src/agents/axiom/config.ts";
import { createCandidateTracker, hashText } from "../../src/agents/axiom/state.ts";
import type { AgentToolResult } from "../../src/agents/agent.ts";
import type { AxleResult } from "../../src/adapters/axle.ts";

const MAIN_CONTENT = "import Mathlib\n\ntheorem foo : 1 = 1 := by\n  rfl\n";
const FORMAL_CONTENT = "import Mathlib\n\ntheorem foo : 1 = 1 := by\n  sorry\n";

const TOOL_NAMES = [
  "lean.environments",
  "lean.check",
  "lean.verify",
  "lean.repair",
  "lean.extract_theorems",
  "lean.normalize",
  "lean.simplify",
  "lean.sorry2lemma",
  "lean.theorem2sorry",
  "lean.rename",
  "lean.theorem2lemma",
  "lean.have2lemma",
  "lean.have2sorry",
  "lean.disprove",
  "lean.cycle",
  "lean.check_file",
  "lean.verify_file",
  "lean.repair_file",
  "lean.normalize_file",
  "lean.simplify_file",
  "lean.sorry2lemma_file",
  "lean.theorem2sorry_file",
  "lean.rename_file",
  "lean.theorem2lemma_file",
  "lean.have2lemma_file",
  "lean.have2sorry_file",
  "lean.disprove_file",
  "lean.extract_theorems_file",
  "lean.cycle_file",
] as const;

type FetchCall = {
  readonly url: string;
  readonly pathname: string;
  readonly method: string;
  readonly auth: string | null;
  readonly body?: Record<string, unknown>;
};

type FetchHandler = (call: FetchCall, index: number) => unknown | Promise<unknown>;

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const axleResult = (content: string, overrides: Partial<AxleResult> = {}): AxleResult => ({
  okay: true,
  content,
  lean_messages: { errors: [], warnings: [], infos: [] },
  tool_messages: { errors: [], warnings: [], infos: [] },
  failed_declarations: [],
  timings: { total_ms: 12 },
  ...overrides,
});

const withWorkspace = async (
  label: string,
  run: (ctx: {
    readonly workspaceRoot: string;
    readonly toolset: ReturnType<typeof createAxleToolset>;
  }) => Promise<void>
): Promise<void> => {
  const dir = await mkTmp(label);
  const workspaceRoot = path.join(dir, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "Main.lean"), MAIN_CONTENT, "utf-8");
  await fs.writeFile(path.join(workspaceRoot, "Formal.lean"), FORMAL_CONTENT, "utf-8");

  try {
    const toolset = createAxleToolset(
      normalizeAxiomConfig({
        workspace: ".",
        leanEnvironment: "lean-4.28.0",
        leanTimeoutSeconds: 120,
        autoRepair: true,
      }),
      createCandidateTracker(workspaceRoot, ".receipt")
    );
    await run({ workspaceRoot, toolset });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

const withFetchStub = async (
  handler: FetchHandler,
  run: (calls: ReadonlyArray<FetchCall>) => Promise<void>
): Promise<void> => {
  const originalFetch = globalThis.fetch;
  const originalApiUrl = process.env.AXLE_API_URL;
  const originalApiKey = process.env.AXLE_API_KEY;
  const calls: FetchCall[] = [];

  process.env.AXLE_API_URL = "https://axle.example.test";
  process.env.AXLE_API_KEY = "test-key";

  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const headers = new Headers(init?.headers);
    const call: FetchCall = {
      url: url.toString(),
      pathname: url.pathname,
      method: init?.method ?? "GET",
      auth: headers.get("Authorization"),
      body: rawBody ? JSON.parse(rawBody) as Record<string, unknown> : undefined,
    };
    calls.push(call);
    const payload = await handler(call, calls.length - 1);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.AXLE_API_URL;
    else process.env.AXLE_API_URL = originalApiUrl;
    if (originalApiKey === undefined) delete process.env.AXLE_API_KEY;
    else process.env.AXLE_API_KEY = originalApiKey;
  }
};

const assertReportGate = (
  result: AgentToolResult,
  gate: "axle-check" | "axle-verify",
  tool: string
): NonNullable<AgentToolResult["reports"]>[number] => {
  const report = result.reports?.[0];
  expect(report).toBeTruthy();
  expect(report!.gate).toBe(gate);
  expect(report!.evidence?.tool).toBe(tool);
  return report!;
};

test("deterministic AXLE preflight exposes the full agent-facing tool surface", async () => {
  await withWorkspace("receipt-axle-surface", async ({ toolset }) => {
    expect(Object.keys(toolset.tools).sort()).toEqual([...TOOL_NAMES].sort());
    expect(Object.keys(toolset.specs).sort()).toEqual([...TOOL_NAMES].sort());
  });
});

describe("deterministic AXLE preflight covers every content tool exposed to the agent", () => {
  const cases = [
    {
      tool: "lean.environments",
      input: {},
      endpoint: "/v1/environments",
      response: [{ name: "lean-4.28.0", description: "Lean 4" }],
      assertBody: (body: FetchCall["body"]) => {
        expect(body).toBe(undefined);
      },
      assertResult: (result: AgentToolResult) => {
        expect(result.output).toMatch(/lean-4.28.0 - Lean 4/);
        expect(result.summary).toBe("environments: 1");
      },
    },
    {
      tool: "lean.check",
      input: { content: MAIN_CONTENT, mathlibLinter: true, ignoreImports: true, timeoutSeconds: 45 },
      endpoint: "/api/v1/check",
      response: axleResult(MAIN_CONTENT),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.content).toBe(MAIN_CONTENT);
        expect(body?.environment).toBe("lean-4.28.0");
        expect(body?.mathlib_linter).toBe(true);
        expect(body?.ignore_imports).toBe(true);
        expect(body?.timeout_seconds).toBe(45);
      },
      assertResult: (result: AgentToolResult) => {
        const report = assertReportGate(result, "axle-check", "lean.check");
        expect(report.evidence?.candidateHash).toBe(hashText(MAIN_CONTENT));
      },
    },
    {
      tool: "lean.verify",
      input: {
        content: MAIN_CONTENT,
        formal_statement: FORMAL_CONTENT,
        permittedSorries: ["foo"],
        mathlibLinter: true,
        useDefEq: false,
        timeoutSeconds: 61,
      },
      endpoint: "/api/v1/verify_proof",
      response: axleResult(MAIN_CONTENT),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.content).toBe(MAIN_CONTENT);
        expect(body?.formal_statement).toBe(FORMAL_CONTENT);
        expect(body?.permitted_sorries).toEqual(["foo"]);
        expect(body?.mathlib_linter).toBe(true);
        expect(body?.use_def_eq).toBe(false);
        expect(body?.timeout_seconds).toBe(61);
      },
      assertResult: (result: AgentToolResult) => {
        const report = assertReportGate(result, "axle-verify", "lean.verify");
        expect(report.evidence?.formalStatementHash).toBe(hashText(FORMAL_CONTENT));
      },
    },
    {
      tool: "lean.repair",
      input: { content: MAIN_CONTENT, names: "foo", repairs: "split,inline", terminalTactics: "simp\ngring" },
      endpoint: "/api/v1/repair_proofs",
      response: axleResult("theorem foo : 1 = 1 := by\n  simp\n", { repair_stats: { applied: 2 } }),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.names).toEqual(["foo"]);
        expect(body?.repairs).toEqual(["split", "inline"]);
        expect(body?.terminal_tactics).toEqual(["simp", "gring"]);
      },
      assertResult: (result: AgentToolResult) => {
        expect(result.output).toMatch(/repair_stats:/);
      },
    },
    {
      tool: "lean.extract_theorems",
      input: { content: MAIN_CONTENT },
      endpoint: "/api/v1/extract_theorems",
      response: axleResult(MAIN_CONTENT, {
        documents: {
          "Demo.foo": { content: "theorem foo : 1 = 1 := by\n  rfl\n" },
        },
      }),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.content).toBe(MAIN_CONTENT);
      },
      assertResult: (result: AgentToolResult) => {
        expect(result.output).toMatch(/documents: Demo\.foo/);
      },
    },
    {
      tool: "lean.normalize",
      input: { content: MAIN_CONTENT, normalizations: "beta,eta", failsafe: false },
      endpoint: "/api/v1/normalize",
      response: axleResult(MAIN_CONTENT, { normalize_stats: { rewrites: 3 } }),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.normalizations).toEqual(["beta", "eta"]);
        expect(body?.failsafe).toBe(false);
      },
      assertResult: (result: AgentToolResult) => {
        expect(result.output).toMatch(/normalize_stats:/);
      },
    },
    {
      tool: "lean.simplify",
      input: { content: MAIN_CONTENT, names: "foo", indices: "1,2", simplifications: "simp,nlinarith" },
      endpoint: "/api/v1/simplify_theorems",
      response: axleResult(MAIN_CONTENT, { simplification_stats: { rewrites: 1 } }),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.names).toEqual(["foo"]);
        expect(body?.indices).toEqual([1, 2]);
        expect(body?.simplifications).toEqual(["simp", "nlinarith"]);
      },
      assertResult: (result: AgentToolResult) => {
        expect(result.output).toMatch(/simplification_stats:/);
      },
    },
    {
      tool: "lean.sorry2lemma",
      input: { content: MAIN_CONTENT, names: "foo", extractSorries: false, extractErrors: false },
      endpoint: "/api/v1/sorry2lemma",
      response: axleResult("lemma foo_obligation : 1 = 1 := by\n  sorry\n"),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.names).toEqual(["foo"]);
        expect(body?.extract_sorries).toBe(false);
        expect(body?.extract_errors).toBe(false);
      },
      assertResult: (result: AgentToolResult) => {
        expect(result.output).toMatch(/lemma foo_obligation/);
      },
    },
    {
      tool: "lean.theorem2sorry",
      input: { content: MAIN_CONTENT, indices: [0] },
      endpoint: "/api/v1/theorem2sorry",
      response: axleResult("theorem foo : 1 = 1 := by\n  sorry\n"),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.indices).toEqual([0]);
      },
      assertResult: (result: AgentToolResult) => {
        expect(result.output).toMatch(/sorry/);
      },
    },
    {
      tool: "lean.rename",
      input: { content: MAIN_CONTENT, oldName: "foo", newName: "bar" },
      endpoint: "/api/v1/rename",
      response: axleResult("import Mathlib\n\n theorem bar : 1 = 1 := by\n  rfl\n"),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.declarations).toEqual({ foo: "bar" });
      },
      assertResult: (result: AgentToolResult) => {
        expect(result.output).toMatch(/declarations: \{"foo":"bar"\}/);
      },
    },
    {
      tool: "lean.theorem2lemma",
      input: { content: MAIN_CONTENT, names: "foo", target: "theorem" },
      endpoint: "/api/v1/theorem2lemma",
      response: axleResult(MAIN_CONTENT),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.names).toEqual(["foo"]);
        expect(body?.target).toBe("theorem");
      },
      assertResult: (result: AgentToolResult) => {
        expect(result.output).toMatch(/target: theorem/);
      },
    },
    {
      tool: "lean.have2lemma",
      input: {
        content: "theorem foo : 1 = 1 := by\n  have h : 1 = 1 := by\n    rfl\n  exact h\n",
        names: "foo",
        includeHaveBody: true,
        includeWholeContext: false,
        reconstructCallsite: true,
        verbosity: 2,
      },
      endpoint: "/api/v1/have2lemma",
      response: axleResult("lemma lifted_have : 1 = 1 := by\n  rfl\n", { lemma_names: ["lifted_have"] }),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.names).toEqual(["foo"]);
        expect(body?.include_have_body).toBe(true);
        expect(body?.include_whole_context).toBe(false);
        expect(body?.reconstruct_callsite).toBe(true);
        expect(body?.verbosity).toBe(2);
      },
      assertResult: (result: AgentToolResult) => {
        expect(result.output).toMatch(/lemma_names: lifted_have/);
      },
    },
    {
      tool: "lean.have2sorry",
      input: { content: MAIN_CONTENT, indices: "0" },
      endpoint: "/api/v1/have2sorry",
      response: axleResult("have h : 1 = 1 := sorry\nexact h\n"),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.indices).toEqual([0]);
      },
      assertResult: (result: AgentToolResult) => {
        expect(result.output).toMatch(/have h : 1 = 1 := sorry/);
      },
    },
    {
      tool: "lean.disprove",
      input: { content: MAIN_CONTENT, names: "foo" },
      endpoint: "/api/v1/disprove",
      response: axleResult(MAIN_CONTENT, { disproved_theorems: ["foo"] }),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.names).toEqual(["foo"]);
      },
      assertResult: (result: AgentToolResult) => {
        expect(result.output).toMatch(/disproved_theorems: foo/);
      },
    },
  ] as const;

  for (const spec of cases) {
    test(spec.tool, async () => {
      await withWorkspace(`receipt-${spec.tool.replace(/[^a-z0-9]+/gi, "-")}`, async ({ toolset }) => {
        await withFetchStub(async (call) => {
          expect(call.auth).toBe("Bearer test-key");
          expect(call.method).toBe(spec.tool === "lean.environments" ? "GET" : "POST");
          expect(call.pathname).toBe(spec.endpoint);
          spec.assertBody(call.body);
          return spec.response;
        }, async (calls) => {
          const result = await toolset.tools[spec.tool](spec.input);
          expect(calls.length).toBe(1);
          spec.assertResult(result);
        });
      });
    });
  }
});

describe("deterministic AXLE preflight covers every file-based tool exposed to the agent", () => {
  const cases = [
    {
      tool: "lean.check_file",
      input: { path: "Main.lean", mathlibLinter: true },
      endpoint: "/api/v1/check",
      response: axleResult(MAIN_CONTENT),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.content).toBe(MAIN_CONTENT);
        expect(body?.mathlib_linter).toBe(true);
      },
      assertResult: async (result: AgentToolResult) => {
        const report = assertReportGate(result, "axle-check", "lean.check_file");
        expect(report.target).toBe("Main.lean");
      },
    },
    {
      tool: "lean.verify_file",
      input: { path: "Main.lean", formalStatementPath: "Formal.lean" },
      endpoint: "/api/v1/verify_proof",
      response: axleResult(MAIN_CONTENT),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.content).toBe(MAIN_CONTENT);
        expect(body?.formal_statement).toBe(FORMAL_CONTENT);
        expect(body?.use_def_eq).toBe(true);
      },
      assertResult: async (result: AgentToolResult) => {
        const report = assertReportGate(result, "axle-verify", "lean.verify_file");
        expect(report.target).toBe("Main.lean");
        expect(report.evidence?.formalStatementHash).toBe(hashText(FORMAL_CONTENT));
      },
    },
    {
      tool: "lean.repair_file",
      input: { path: "Main.lean", outputPath: "out/Repair.lean" },
      endpoint: "/api/v1/repair_proofs",
      response: axleResult("theorem foo : 1 = 1 := by\n  simp\n"),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.content).toBe(MAIN_CONTENT);
      },
      assertResult: async (result: AgentToolResult, workspaceRoot: string) => {
        expect(result.output).toMatch(/output_path: out\/Repair\.lean/);
        const written = await fs.readFile(path.join(workspaceRoot, "out/Repair.lean"), "utf-8");
        expect(written).toBe("theorem foo : 1 = 1 := by\n  simp\n");
      },
    },
    {
      tool: "lean.normalize_file",
      input: { path: "Main.lean", outputPath: "out/Normalize.lean", normalizations: "beta" },
      endpoint: "/api/v1/normalize",
      response: axleResult("theorem foo : 1 = 1 := by\n  exact rfl\n"),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.normalizations).toEqual(["beta"]);
      },
      assertResult: async (_result: AgentToolResult, workspaceRoot: string) => {
        const written = await fs.readFile(path.join(workspaceRoot, "out/Normalize.lean"), "utf-8");
        expect(written).toBe("theorem foo : 1 = 1 := by\n  exact rfl\n");
      },
    },
    {
      tool: "lean.simplify_file",
      input: { path: "Main.lean", outputPath: "out/Simplify.lean", simplifications: "simp" },
      endpoint: "/api/v1/simplify_theorems",
      response: axleResult("theorem foo : 1 = 1 := by\n  simpa\n"),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.simplifications).toEqual(["simp"]);
      },
      assertResult: async (_result: AgentToolResult, workspaceRoot: string) => {
        const written = await fs.readFile(path.join(workspaceRoot, "out/Simplify.lean"), "utf-8");
        expect(written).toBe("theorem foo : 1 = 1 := by\n  simpa\n");
      },
    },
    {
      tool: "lean.sorry2lemma_file",
      input: { path: "Main.lean", outputPath: "out/SorryToLemma.lean", extractErrors: false },
      endpoint: "/api/v1/sorry2lemma",
      response: axleResult("lemma foo_gap : 1 = 1 := by\n  sorry\n"),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.extract_errors).toBe(false);
      },
      assertResult: async (_result: AgentToolResult, workspaceRoot: string) => {
        const written = await fs.readFile(path.join(workspaceRoot, "out/SorryToLemma.lean"), "utf-8");
        expect(written).toBe("lemma foo_gap : 1 = 1 := by\n  sorry\n");
      },
    },
    {
      tool: "lean.theorem2sorry_file",
      input: { path: "Main.lean", outputPath: "out/TheoremToSorry.lean", indices: "0" },
      endpoint: "/api/v1/theorem2sorry",
      response: axleResult("theorem foo : 1 = 1 := by\n  sorry\n"),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.indices).toEqual([0]);
      },
      assertResult: async (_result: AgentToolResult, workspaceRoot: string) => {
        const written = await fs.readFile(path.join(workspaceRoot, "out/TheoremToSorry.lean"), "utf-8");
        expect(written).toBe("theorem foo : 1 = 1 := by\n  sorry\n");
      },
    },
    {
      tool: "lean.rename_file",
      input: { path: "Main.lean", outputPath: "out/Rename.lean", declarations: "foo=bar" },
      endpoint: "/api/v1/rename",
      response: axleResult("import Mathlib\n\ntheorem bar : 1 = 1 := by\n  rfl\n"),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.declarations).toEqual({ foo: "bar" });
      },
      assertResult: async (_result: AgentToolResult, workspaceRoot: string) => {
        const written = await fs.readFile(path.join(workspaceRoot, "out/Rename.lean"), "utf-8");
        expect(written).toMatch(/theorem bar/);
      },
    },
    {
      tool: "lean.theorem2lemma_file",
      input: { path: "Main.lean", outputPath: "out/TheoremToLemma.lean", names: "foo" },
      endpoint: "/api/v1/theorem2lemma",
      response: axleResult("import Mathlib\n\nlemma foo : 1 = 1 := by\n  rfl\n"),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.names).toEqual(["foo"]);
        expect(body?.target).toBe("lemma");
      },
      assertResult: async (_result: AgentToolResult, workspaceRoot: string) => {
        const written = await fs.readFile(path.join(workspaceRoot, "out/TheoremToLemma.lean"), "utf-8");
        expect(written).toMatch(/lemma foo/);
      },
    },
    {
      tool: "lean.have2lemma_file",
      input: { path: "Main.lean", outputPath: "out/HaveToLemma.lean", includeHaveBody: true },
      endpoint: "/api/v1/have2lemma",
      response: axleResult("lemma lifted_have : 1 = 1 := by\n  rfl\n", { lemma_names: ["lifted_have"] }),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.include_have_body).toBe(true);
      },
      assertResult: async (result: AgentToolResult, workspaceRoot: string) => {
        expect(result.output).toMatch(/lemma_names: lifted_have/);
        const written = await fs.readFile(path.join(workspaceRoot, "out/HaveToLemma.lean"), "utf-8");
        expect(written).toMatch(/lifted_have/);
      },
    },
    {
      tool: "lean.have2sorry_file",
      input: { path: "Main.lean", outputPath: "out/HaveToSorry.lean" },
      endpoint: "/api/v1/have2sorry",
      response: axleResult("have h : 1 = 1 := sorry\nexact h\n"),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.content).toBe(MAIN_CONTENT);
      },
      assertResult: async (_result: AgentToolResult, workspaceRoot: string) => {
        const written = await fs.readFile(path.join(workspaceRoot, "out/HaveToSorry.lean"), "utf-8");
        expect(written).toMatch(/sorry/);
      },
    },
    {
      tool: "lean.disprove_file",
      input: { path: "Main.lean", names: "foo" },
      endpoint: "/api/v1/disprove",
      response: axleResult(MAIN_CONTENT, { disproved_theorems: ["foo"] }),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.names).toEqual(["foo"]);
      },
      assertResult: async (result: AgentToolResult) => {
        expect(result.output).toMatch(/disproved_theorems: foo/);
      },
    },
    {
      tool: "lean.extract_theorems_file",
      input: { path: "Main.lean", outputDir: "out/extracted" },
      endpoint: "/api/v1/extract_theorems",
      response: axleResult(MAIN_CONTENT, {
        documents: {
          "Demo/foo": { content: "theorem foo : 1 = 1 := by\n  rfl\n" },
        },
      }),
      assertBody: (body: FetchCall["body"]) => {
        expect(body?.content).toBe(MAIN_CONTENT);
      },
      assertResult: async (_result: AgentToolResult, workspaceRoot: string) => {
        const written = await fs.readFile(path.join(workspaceRoot, "out/extracted/Demo_foo.lean"), "utf-8");
        expect(written).toBe("theorem foo : 1 = 1 := by\n  rfl\n");
      },
    },
  ] as const;

  for (const spec of cases) {
    test(spec.tool, async () => {
      await withWorkspace(`receipt-${spec.tool.replace(/[^a-z0-9]+/gi, "-")}`, async ({ workspaceRoot, toolset }) => {
        await withFetchStub(async (call) => {
          expect(call.auth).toBe("Bearer test-key");
          expect(call.method).toBe("POST");
          expect(call.pathname).toBe(spec.endpoint);
          spec.assertBody(call.body);
          return spec.response;
        }, async (calls) => {
          const result = await toolset.tools[spec.tool](spec.input);
          expect(calls.length).toBe(1);
          await spec.assertResult(result, workspaceRoot);
        });
      });
    });
  }
});

test("deterministic AXLE preflight exercises repair-aware cycle tools before agent runs", async () => {
  await withWorkspace("receipt-axle-cycle", async ({ workspaceRoot, toolset }) => {
    await withFetchStub(async (call, index) => {
      expect(call.auth).toBe("Bearer test-key");
      if (index === 0) {
        expect(call.pathname).toBe("/api/v1/verify_proof");
        return axleResult(MAIN_CONTENT, {
          okay: false,
          lean_messages: { errors: ["unsolved goals"], warnings: [], infos: [] },
        });
      }
      if (index === 1) {
        expect(call.pathname).toBe("/api/v1/repair_proofs");
        return axleResult("theorem foo : 1 = 1 := by\n  simpa\n", { repair_stats: { applied: 1 } });
      }
      if (index === 2) {
        expect(call.pathname).toBe("/api/v1/verify_proof");
        return axleResult("theorem foo : 1 = 1 := by\n  simpa\n");
      }
      if (index === 3) {
        expect(call.pathname).toBe("/api/v1/check");
        return axleResult(MAIN_CONTENT, {
          okay: false,
          lean_messages: { errors: ["type mismatch"], warnings: [], infos: [] },
        });
      }
      if (index === 4) {
        expect(call.pathname).toBe("/api/v1/repair_proofs");
        return axleResult("theorem foo : 1 = 1 := by\n  exact rfl\n", { repair_stats: { applied: 1 } });
      }
      if (index === 5) {
        expect(call.pathname).toBe("/api/v1/check");
        return axleResult("theorem foo : 1 = 1 := by\n  exact rfl\n");
      }
      throw new Error(`Unexpected AXLE call #${index} to ${call.pathname}`);
    }, async (calls) => {
      const contentResult = await toolset.tools["lean.cycle"]({
        content: MAIN_CONTENT,
        formal_statement: FORMAL_CONTENT,
      });
      expect(calls.length).toBe(3);
      expect(contentResult.output).toMatch(/repaired: yes/);
      expect(contentResult.output).toMatch(/repair_stats: \{"applied":1\}/);

      const fileResult = await toolset.tools["lean.cycle_file"]({
        path: "Main.lean",
        outputPath: "out/Cycle.lean",
      });
      expect(calls.length).toBe(6);
      expect(fileResult.output).toMatch(/repaired: yes/);
      const written = await fs.readFile(path.join(workspaceRoot, "out/Cycle.lean"), "utf-8");
      expect(written).toBe("theorem foo : 1 = 1 := by\n  exact rfl\n");
    });
  });
});
