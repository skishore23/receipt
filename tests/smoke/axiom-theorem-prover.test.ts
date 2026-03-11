import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import type { DelegationTools } from "../../src/adapters/delegation.ts";
import type { MemoryTools } from "../../src/adapters/memory-tools.ts";
import { runAxiom, AXIOM_DEFAULT_CONFIG, normalizeAxiomConfig, type AxiomRunInput } from "../../src/agents/axiom.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import type { AgentCmd, AgentEvent, AgentState } from "../../src/modules/agent.ts";
import { decide as decideAgent, reduce as reduceAgent, initial as initialAgent } from "../../src/modules/agent.ts";
import { loadAxiomPrompts } from "../../src/prompts/axiom.ts";

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const mkRuntime = (dir: string) => createRuntime<AgentCmd, AgentEvent, AgentState>(
  jsonlStore<AgentEvent>(dir),
  jsonBranchStore(dir),
  decideAgent,
  reduceAgent,
  initialAgent
);

const mkMemoryTools = (): MemoryTools => ({
  read: async () => [],
  search: async () => [],
  summarize: async () => ({ summary: "", entries: [] }),
  commit: async (input) => ({
    id: `mem_${Date.now().toString(36)}`,
    scope: input.scope,
    text: input.text,
    tags: input.tags,
    meta: input.meta,
    ts: Date.now(),
  }),
  diff: async () => [],
  reindex: async () => 0,
});

const mkDelegationTools = (): DelegationTools => ({
  "agent.delegate": async () => ({ output: "", summary: "" }),
  "agent.status": async () => ({ output: "", summary: "" }),
  "agent.inspect": async () => ({ output: "", summary: "" }),
});

const structuredFromText = (llmText: AxiomRunInput["llmText"]): AxiomRunInput["llmStructured"] =>
  (async ({ system, user }) => {
    const raw = await llmText({ system, user });
    return {
      parsed: JSON.parse(raw) as never,
      raw,
    };
  }) as AxiomRunInput["llmStructured"];

const withStructured = (input: Omit<AxiomRunInput, "llmStructured">): AxiomRunInput => ({
  ...input,
  llmStructured: structuredFromText(input.llmText),
});

test("normalizeAxiomConfig applies long-horizon defaults", () => {
  const config = normalizeAxiomConfig({});
  assert.equal(config.maxIterations, AXIOM_DEFAULT_CONFIG.maxIterations);
  assert.equal(config.memoryScope, "axiom");
  assert.equal(config.autoRepair, true);
  assert.equal(config.leanEnvironment, "lean-4.28.0");
  assert.equal(config.localValidationMode, "off");
});

test("runAxiom uses native structured actions when available", async () => {
  const dir = await mkTmp("receipt-axiom-structured");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace");

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });

  const runtime = mkRuntime(dataDir);
  const memoryTools = mkMemoryTools();
  const delegationTools = mkDelegationTools();

  let textCalls = 0;
  let structuredCalls = 0;
  const input: AxiomRunInput = {
    stream: "agents/axiom",
    runId: "axiom_structured",
    problem: "Finish immediately.",
    config: normalizeAxiomConfig({
      maxIterations: 2,
      workspace: ".",
      localValidationMode: "off",
    }),
    runtime,
    prompts: loadAxiomPrompts(),
    llmText: async () => {
      textCalls += 1;
      return JSON.stringify({
        thought: "unexpected text fallback",
        action: {
          type: "final",
          text: "fallback",
        },
      });
    },
    llmStructured: async () => {
      structuredCalls += 1;
      return {
        parsed: {
          thought: "done",
          action: {
            type: "final",
            text: "complete",
          },
        },
        raw: "{\"thought\":\"done\",\"action\":{\"type\":\"final\",\"text\":\"complete\"}}",
      };
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools,
    workspaceRoot,
  };

  try {
    await runAxiom(input);

    const runChain = await runtime.chain("agents/axiom/runs/axiom_structured");
    const finalEvent = runChain.findLast((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "response.finalized" }> } =>
      receipt.body.type === "response.finalized"
    );
    const jsonValidation = runChain.find((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "validation.report" }> } =>
      receipt.body.type === "validation.report" && receipt.body.gate === "model_json"
    );

    assert.equal(textCalls, 0, "expected runAxiom to use native structured actions");
    assert.equal(structuredCalls, 1, "expected a single structured final action");
    assert.match(finalEvent?.body.content ?? "", /complete/);
    assert.equal(jsonValidation?.body.ok, true);
    assert.match(jsonValidation?.body.summary ?? "", /native structured action parsed/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runAxiom uses lean file tools through the durable agent loop", async () => {
  const dir = await mkTmp("receipt-axiom-run");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace");
  const originalFetch = globalThis.fetch;
  const originalApiUrl = process.env.AXLE_API_URL;
  const originalApiKey = process.env.AXLE_API_KEY;

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, "Main.lean"),
    "import Mathlib\n\ntheorem foo : 1 = 1 := by\n  rfl\n",
    "utf-8"
  );

  const runtime = mkRuntime(dataDir);

  const memoryTools: MemoryTools = {
    read: async () => [],
    search: async () => [],
    summarize: async () => ({ summary: "", entries: [] }),
    commit: async (input) => ({
      id: `mem_${Date.now().toString(36)}`,
      scope: input.scope,
      text: input.text,
      tags: input.tags,
      meta: input.meta,
      ts: Date.now(),
    }),
    diff: async () => [],
    reindex: async () => 0,
  };

  const delegationTools: DelegationTools = {
    "agent.delegate": async () => ({ output: "", summary: "" }),
    "agent.status": async () => ({ output: "", summary: "" }),
    "agent.inspect": async () => ({ output: "", summary: "" }),
  };

  const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  process.env.AXLE_API_URL = "https://axle.example.test";
  process.env.AXLE_API_KEY = "test-key";

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/check")) {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), "Bearer test-key");
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      fetchCalls.push({ url, body });
      return new Response(JSON.stringify({
        okay: true,
        content: body.content,
        lean_messages: { errors: [], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: [],
        timings: { total_ms: 12 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  let llmCalls = 0;
  const input = withStructured({
    stream: "agents/axiom",
    runId: "axiom_demo",
    problem: "Check Main.lean and confirm whether theorem foo is valid.",
    config: normalizeAxiomConfig({
      maxIterations: 3,
      workspace: ".",
      leanEnvironment: "lean-4.28.0",
      autoRepair: true,
      localValidationMode: "off",
    }),
    runtime,
    prompts: loadAxiomPrompts(),
    llmText: async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return JSON.stringify({
          thought: "Check the Lean file first.",
          action: {
            type: "tool",
            name: "lean.check_file",
            input: { path: "Main.lean" },
          },
        });
      }
      return JSON.stringify({
        thought: "Lean accepted the file, report success.",
        action: {
          type: "final",
          text: "Verified Main.lean with lean.check_file; theorem foo currently compiles in lean-4.28.0.",
        },
      });
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools,
    workspaceRoot,
  });

  try {
    await runAxiom(input);

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.url, "https://axle.example.test/api/v1/check");
    assert.equal(fetchCalls[0]?.body.environment, "lean-4.28.0");
    assert.match(String(fetchCalls[0]?.body.content ?? ""), /theorem foo/);

    const runChain = await runtime.chain("agents/axiom/runs/axiom_demo");
    assert.ok(runChain.some((receipt) => receipt.body.type === "run.configured"), "missing run.configured");
    assert.ok(runChain.some((receipt) => receipt.body.type === "tool.called" && receipt.body.tool === "lean.check_file"), "missing lean.check_file call");
    const axleValidation = runChain.find((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "validation.report" }> } =>
      receipt.body.type === "validation.report" && receipt.body.gate === "axle-check"
    );
    assert.equal(axleValidation?.body.evidence?.tool, "lean.check_file");
    assert.ok(axleValidation?.body.evidence?.candidateHash, "missing candidate hash on AXLE validation report");

    const configEvent = runChain.find((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "run.configured" }> } =>
      receipt.body.type === "run.configured"
    );
    assert.equal(configEvent?.body.workflow.id, "axiom-v1");
    assert.equal(configEvent?.body.config.extra?.leanEnvironment, "lean-4.28.0");

    const finalEvent = runChain.findLast((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "response.finalized" }> } =>
      receipt.body.type === "response.finalized"
    );
    assert.match(finalEvent?.body.content ?? "", /Verified Main\.lean/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.AXLE_API_URL;
    else process.env.AXLE_API_URL = originalApiUrl;
    if (originalApiKey === undefined) delete process.env.AXLE_API_KEY;
    else process.env.AXLE_API_KEY = originalApiKey;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runAxiom rejects text-only AXLE verify claims until lean.verify_file actually runs", async () => {
  const dir = await mkTmp("receipt-axiom-verify-guard");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace");
  const originalFetch = globalThis.fetch;
  const originalApiUrl = process.env.AXLE_API_URL;
  const originalApiKey = process.env.AXLE_API_KEY;

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, "CompositionFacts.lean"),
    "import Mathlib\n\ntheorem foo : 1 = 1 := by\n  rfl\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspaceRoot, "CompositionFacts.sorry.lean"),
    "import Mathlib\n\ntheorem foo : 1 = 1 := sorry\n",
    "utf-8"
  );

  const runtime = mkRuntime(dataDir);

  const memoryTools: MemoryTools = {
    read: async () => [],
    search: async () => [],
    summarize: async () => ({ summary: "", entries: [] }),
    commit: async (input) => ({
      id: `mem_${Date.now().toString(36)}`,
      scope: input.scope,
      text: input.text,
      tags: input.tags,
      meta: input.meta,
      ts: Date.now(),
    }),
    diff: async () => [],
    reindex: async () => 0,
  };

  const delegationTools: DelegationTools = {
    "agent.delegate": async () => ({ output: "", summary: "" }),
    "agent.status": async () => ({ output: "", summary: "" }),
    "agent.inspect": async () => ({ output: "", summary: "" }),
  };

  const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  process.env.AXLE_API_URL = "https://axle.example.test";
  process.env.AXLE_API_KEY = "test-key";

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    fetchCalls.push({ url, body });

    if (url.endsWith("/api/v1/verify_proof")) {
      return new Response(JSON.stringify({
        okay: true,
        content: body.content,
        lean_messages: { errors: [], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: [],
        timings: { total_ms: 14 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  let llmCalls = 0;
  const input = withStructured({
    stream: "agents/axiom",
    runId: "axiom_verify_guard",
    problem: "Review CompositionFacts.lean and finalize only after the configured validation contract is satisfied.",
    config: normalizeAxiomConfig({
      maxIterations: 4,
      workspace: ".",
      leanEnvironment: "lean-4.28.0",
      autoRepair: true,
      localValidationMode: "off",
      requiredValidation: {
        kind: "axle-verify",
        formalStatementPath: "CompositionFacts.sorry.lean",
      },
    }),
    runtime,
    prompts: loadAxiomPrompts(),
    llmText: async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return JSON.stringify({
          thought: "Verification already succeeded, report success.",
          action: {
            type: "final",
            text: "AXLE verification succeeded.",
          },
        });
      }
      if (llmCalls === 2) {
        return JSON.stringify({
          thought: "Run the required AXLE verify tool for real.",
          action: {
            type: "tool",
            name: "lean.verify_file",
            input: {
              path: "CompositionFacts.lean",
              formalStatementPath: "CompositionFacts.sorry.lean",
            },
          },
        });
      }
      return JSON.stringify({
        thought: "The AXLE verification receipt is now present.",
        action: {
          type: "final",
          text: "Verified CompositionFacts.lean with AXLE.",
        },
      });
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools,
    workspaceRoot,
  });

  try {
    await runAxiom(input);

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.url, "https://axle.example.test/api/v1/verify_proof");
    assert.match(String(fetchCalls[0]?.body.content ?? ""), /theorem foo/);
    assert.match(String(fetchCalls[0]?.body.formal_statement ?? ""), /sorry/);

    const runChain = await runtime.chain("agents/axiom/runs/axiom_verify_guard");
    const finalizerReject = runChain.find((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "validation.report" }> } =>
      receipt.body.type === "validation.report" && receipt.body.gate === "finalizer"
    );
    assert.equal(finalizerReject?.body.ok, false);
    assert.match(finalizerReject?.body.summary ?? "", /requires AXLE verification/i);

    const axleVerify = runChain.find((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "validation.report" }> } =>
      receipt.body.type === "validation.report" && receipt.body.gate === "axle-verify"
    );
    assert.equal(axleVerify?.body.ok, true);
    assert.equal(axleVerify?.body.evidence?.tool, "lean.verify_file");
    assert.ok(axleVerify?.body.evidence?.candidateHash, "missing candidate hash on AXLE verify report");
    assert.ok(axleVerify?.body.evidence?.formalStatementHash, "missing formal statement hash on AXLE verify report");

    const finalEvent = runChain.findLast((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "response.finalized" }> } =>
      receipt.body.type === "response.finalized"
    );
    assert.match(finalEvent?.body.content ?? "", /Verified CompositionFacts\.lean with AXLE\./);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.AXLE_API_URL;
    else process.env.AXLE_API_URL = originalApiUrl;
    if (originalApiKey === undefined) delete process.env.AXLE_API_KEY;
    else process.env.AXLE_API_KEY = originalApiKey;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runAxiom keeps rejecting finalize when AXLE verification failed", async () => {
  const dir = await mkTmp("receipt-axiom-verify-failure");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace");
  const originalFetch = globalThis.fetch;
  const originalApiUrl = process.env.AXLE_API_URL;
  const originalApiKey = process.env.AXLE_API_KEY;

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, "CompositionFacts.lean"),
    "import Mathlib\n\ntheorem foo : 1 = 2 := by\n  omega\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspaceRoot, "CompositionFacts.sorry.lean"),
    "import Mathlib\n\ntheorem foo : 1 = 2 := sorry\n",
    "utf-8"
  );

  const runtime = mkRuntime(dataDir);

  const memoryTools: MemoryTools = {
    read: async () => [],
    search: async () => [],
    summarize: async () => ({ summary: "", entries: [] }),
    commit: async (input) => ({
      id: `mem_${Date.now().toString(36)}`,
      scope: input.scope,
      text: input.text,
      tags: input.tags,
      meta: input.meta,
      ts: Date.now(),
    }),
    diff: async () => [],
    reindex: async () => 0,
  };

  const delegationTools: DelegationTools = {
    "agent.delegate": async () => ({ output: "", summary: "" }),
    "agent.status": async () => ({ output: "", summary: "" }),
    "agent.inspect": async () => ({ output: "", summary: "" }),
  };

  process.env.AXLE_API_URL = "https://axle.example.test";
  process.env.AXLE_API_KEY = "test-key";

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/verify_proof")) {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      return new Response(JSON.stringify({
        okay: false,
        content: body.content,
        lean_messages: { errors: ["type mismatch"], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: ["foo"],
        timings: { total_ms: 18 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  let llmCalls = 0;
  const input = withStructured({
    stream: "agents/axiom",
    runId: "axiom_verify_failed",
    problem: "Review CompositionFacts.lean and follow the configured verification contract.",
    config: normalizeAxiomConfig({
      maxIterations: 3,
      workspace: ".",
      leanEnvironment: "lean-4.28.0",
      autoRepair: true,
      localValidationMode: "off",
      requiredValidation: {
        kind: "axle-verify",
        formalStatementPath: "CompositionFacts.sorry.lean",
      },
    }),
    runtime,
    prompts: loadAxiomPrompts(),
    llmText: async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return JSON.stringify({
          thought: "Run AXLE verify first.",
          action: {
            type: "tool",
            name: "lean.verify_file",
            input: {
              path: "CompositionFacts.lean",
              formalStatementPath: "CompositionFacts.sorry.lean",
            },
          },
        });
      }
      return JSON.stringify({
        thought: "Try to finalize despite the failed verification.",
        action: {
          type: "final",
          text: "This proof is done.",
        },
      });
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools,
    workspaceRoot,
  });

  try {
    await runAxiom(input);

    const runChain = await runtime.chain("agents/axiom/runs/axiom_verify_failed");
    const axleVerify = runChain.find((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "validation.report" }> } =>
      receipt.body.type === "validation.report" && receipt.body.gate === "axle-verify"
    );
    assert.equal(axleVerify?.body.ok, false);

    const finalizerReject = runChain.findLast((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "validation.report" }> } =>
      receipt.body.type === "validation.report" && receipt.body.gate === "finalizer"
    );
    assert.equal(finalizerReject?.body.ok, false);
    assert.match(finalizerReject?.body.summary ?? "", /verification ran and failed/i);

    const finalStatus = runChain.findLast((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "run.status" }> } =>
      receipt.body.type === "run.status"
    );
    assert.equal(finalStatus?.body.status, "failed");
    assert.match(finalStatus?.body.note ?? "", /iteration budget exhausted/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.AXLE_API_URL;
    else process.env.AXLE_API_URL = originalApiUrl;
    if (originalApiKey === undefined) delete process.env.AXLE_API_KEY;
    else process.env.AXLE_API_KEY = originalApiKey;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runAxiom exposes AXLE structure-editing content tools and records task hints", async () => {
  const dir = await mkTmp("receipt-axiom-structure-content");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace");
  const originalFetch = globalThis.fetch;
  const originalApiUrl = process.env.AXLE_API_URL;
  const originalApiKey = process.env.AXLE_API_KEY;

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });

  const runtime = mkRuntime(dataDir);
  const memoryTools = mkMemoryTools();
  const delegationTools = mkDelegationTools();

  const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  process.env.AXLE_API_URL = "https://axle.example.test";
  process.env.AXLE_API_KEY = "test-key";

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    fetchCalls.push({ url, body });

    if (url.endsWith("/api/v1/rename")) {
      return new Response(JSON.stringify({
        okay: true,
        content: "import Mathlib\n\ntheorem bar : 1 = 1 := by\n  rfl\n",
        lean_messages: { errors: [], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: [],
        timings: { total_ms: 7 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/v1/theorem2lemma")) {
      return new Response(JSON.stringify({
        okay: true,
        content: "import Mathlib\n\nlemma bar : 1 = 1 := by\n  rfl\n",
        lean_messages: { errors: [], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: [],
        timings: { total_ms: 8 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/v1/have2lemma")) {
      return new Response(JSON.stringify({
        okay: true,
        content: "import Mathlib\n\nlemma baz.h1 : 1 = 1 := sorry\n\ntheorem baz : 1 = 1 := by\n  have h : 1 = 1 := by\n    rfl\n  exact h\n",
        lean_messages: { errors: [], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: [],
        lemma_names: ["baz.h1"],
        timings: { total_ms: 9 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/v1/have2sorry")) {
      return new Response(JSON.stringify({
        okay: true,
        content: "import Mathlib\n\ntheorem baz : 1 = 1 := by\n  have h : 1 = 1 := sorry\n  exact h\n",
        lean_messages: { errors: [], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: [],
        timings: { total_ms: 10 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  let llmCalls = 0;
  const input = withStructured({
    stream: "agents/axiom",
    runId: "axiom_structure_content",
    problem: "Refactor and validate the candidate Lean snippets.",
    config: normalizeAxiomConfig({
      maxIterations: 6,
      workspace: ".",
      leanEnvironment: "lean-4.28.0",
      autoRepair: true,
      localValidationMode: "off",
      taskHints: {
        reason: "name_conflict",
        preferredTools: ["lean.rename", "lean.verify"],
        declarationName: "foo",
      },
    }),
    runtime,
    prompts: loadAxiomPrompts(),
    llmText: async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return JSON.stringify({
          thought: "Rename the conflicting declaration first.",
          action: {
            type: "tool",
            name: "lean.rename",
            input: {
              content: "import Mathlib\n\ntheorem foo : 1 = 1 := by\n  rfl\n",
              declarations: { foo: "bar" },
            },
          },
        });
      }
      if (llmCalls === 2) {
        return JSON.stringify({
          thought: "Convert the theorem keyword to lemma for easier reuse.",
          action: {
            type: "tool",
            name: "lean.theorem2lemma",
            input: {
              content: "import Mathlib\n\ntheorem bar : 1 = 1 := by\n  rfl\n",
            },
          },
        });
      }
      if (llmCalls === 3) {
        return JSON.stringify({
          thought: "Extract the local have proof into a lemma.",
          action: {
            type: "tool",
            name: "lean.have2lemma",
            input: {
              content: "import Mathlib\n\ntheorem baz : 1 = 1 := by\n  have h : 1 = 1 := by\n    rfl\n  exact h\n",
              reconstructCallsite: true,
            },
          },
        });
      }
      if (llmCalls === 4) {
        return JSON.stringify({
          thought: "Replace the have proof body with sorry for focused repair.",
          action: {
            type: "tool",
            name: "lean.have2sorry",
            input: {
              content: "import Mathlib\n\ntheorem baz : 1 = 1 := by\n  have h : 1 = 1 := by\n    rfl\n  exact h\n",
            },
          },
        });
      }
      return JSON.stringify({
        thought: "The structure-editing AXLE tools all ran successfully.",
        action: {
          type: "final",
          text: "Completed AXLE structure edits.",
        },
      });
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools,
    workspaceRoot,
  });

  try {
    await runAxiom(input);

    assert.deepEqual(
      fetchCalls.map((call) => call.url),
      [
        "https://axle.example.test/api/v1/rename",
        "https://axle.example.test/api/v1/theorem2lemma",
        "https://axle.example.test/api/v1/have2lemma",
        "https://axle.example.test/api/v1/have2sorry",
      ]
    );

    const runChain = await runtime.chain("agents/axiom/runs/axiom_structure_content");
    const configEvent = runChain.find((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "run.configured" }> } =>
      receipt.body.type === "run.configured"
    );
    assert.equal(configEvent?.body.config.extra?.taskHints?.reason, "name_conflict");

    const problemEvent = runChain.find((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "problem.set" }> } =>
      receipt.body.type === "problem.set"
    );
    assert.match(problemEvent?.body.problem ?? "", /Task hints \(structured\)/);
    assert.match(problemEvent?.body.problem ?? "", /lean\.rename, lean\.verify/);

    const observed = runChain.filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "tool.observed" }> } =>
      receipt.body.type === "tool.observed"
    );
    assert.ok(observed.some((receipt) => receipt.body.tool === "lean.rename" && /theorem bar/.test(receipt.body.output)));
    assert.ok(observed.some((receipt) => receipt.body.tool === "lean.theorem2lemma" && /lemma bar/.test(receipt.body.output)));
    assert.ok(observed.some((receipt) => receipt.body.tool === "lean.have2lemma" && /lemma_names: baz\.h1/.test(receipt.body.output)));
    assert.ok(observed.some((receipt) => receipt.body.tool === "lean.have2sorry" && /have h : 1 = 1 := sorry/.test(receipt.body.output)));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.AXLE_API_URL;
    else process.env.AXLE_API_URL = originalApiUrl;
    if (originalApiKey === undefined) delete process.env.AXLE_API_KEY;
    else process.env.AXLE_API_KEY = originalApiKey;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runAxiom rewrites workspace files with AXLE structure-editing file tools", async () => {
  const dir = await mkTmp("receipt-axiom-structure-file");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace");
  const originalFetch = globalThis.fetch;
  const originalApiUrl = process.env.AXLE_API_URL;
  const originalApiKey = process.env.AXLE_API_KEY;

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "Rename.lean"), "import Mathlib\n\ntheorem foo : 1 = 1 := by\n  rfl\n", "utf-8");
  await fs.writeFile(path.join(workspaceRoot, "Lemmaize.lean"), "import Mathlib\n\ntheorem bar : 1 = 1 := by\n  rfl\n", "utf-8");
  await fs.writeFile(path.join(workspaceRoot, "HaveLemma.lean"), "import Mathlib\n\ntheorem baz : 1 = 1 := by\n  have h : 1 = 1 := by\n    rfl\n  exact h\n", "utf-8");
  await fs.writeFile(path.join(workspaceRoot, "HaveSorry.lean"), "import Mathlib\n\ntheorem qux : 1 = 1 := by\n  have h : 1 = 1 := by\n    rfl\n  exact h\n", "utf-8");

  const runtime = mkRuntime(dataDir);
  const memoryTools = mkMemoryTools();
  const delegationTools = mkDelegationTools();

  process.env.AXLE_API_URL = "https://axle.example.test";
  process.env.AXLE_API_KEY = "test-key";

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;

    if (url.endsWith("/api/v1/rename")) {
      return new Response(JSON.stringify({
        okay: true,
        content: "import Mathlib\n\ntheorem bar : 1 = 1 := by\n  rfl\n",
        lean_messages: { errors: [], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: [],
        timings: { total_ms: 7 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/v1/theorem2lemma")) {
      return new Response(JSON.stringify({
        okay: true,
        content: "import Mathlib\n\nlemma bar : 1 = 1 := by\n  rfl\n",
        lean_messages: { errors: [], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: [],
        timings: { total_ms: 8 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/v1/have2lemma")) {
      return new Response(JSON.stringify({
        okay: true,
        content: "import Mathlib\n\nlemma baz.h1 : 1 = 1 := sorry\n\ntheorem baz : 1 = 1 := by\n  have h : 1 = 1 := by\n    rfl\n  exact h\n",
        lean_messages: { errors: [], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: [],
        lemma_names: ["baz.h1"],
        timings: { total_ms: 9 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/v1/have2sorry")) {
      return new Response(JSON.stringify({
        okay: true,
        content: "import Mathlib\n\ntheorem qux : 1 = 1 := by\n  have h : 1 = 1 := sorry\n  exact h\n",
        lean_messages: { errors: [], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: [],
        timings: { total_ms: 10 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    throw new Error(`Unexpected fetch URL: ${url} body=${JSON.stringify(body)}`);
  }) as typeof fetch;

  let llmCalls = 0;
  const input = withStructured({
    stream: "agents/axiom",
    runId: "axiom_structure_file",
    problem: "Rewrite the workspace Lean files with AXLE structure-editing tools.",
    config: normalizeAxiomConfig({
      maxIterations: 6,
      workspace: ".",
      leanEnvironment: "lean-4.28.0",
      autoRepair: true,
      localValidationMode: "off",
    }),
    runtime,
    prompts: loadAxiomPrompts(),
    llmText: async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return JSON.stringify({
          thought: "Rename the declaration in Rename.lean.",
          action: { type: "tool", name: "lean.rename_file", input: { path: "Rename.lean", declarations: { foo: "bar" } } },
        });
      }
      if (llmCalls === 2) {
        return JSON.stringify({
          thought: "Convert theorem keywords to lemmas in Lemmaize.lean.",
          action: { type: "tool", name: "lean.theorem2lemma_file", input: { path: "Lemmaize.lean" } },
        });
      }
      if (llmCalls === 3) {
        return JSON.stringify({
          thought: "Extract have blocks into lemmas in HaveLemma.lean.",
          action: { type: "tool", name: "lean.have2lemma_file", input: { path: "HaveLemma.lean", reconstructCallsite: true } },
        });
      }
      if (llmCalls === 4) {
        return JSON.stringify({
          thought: "Replace have proof bodies with sorry in HaveSorry.lean.",
          action: { type: "tool", name: "lean.have2sorry_file", input: { path: "HaveSorry.lean" } },
        });
      }
      return JSON.stringify({
        thought: "All workspace files have been rewritten.",
        action: { type: "final", text: "Workspace files rewritten with AXLE structure-editing tools." },
      });
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools,
    workspaceRoot,
  });

  try {
    await runAxiom(input);

    assert.match(await fs.readFile(path.join(workspaceRoot, "Rename.lean"), "utf-8"), /theorem bar/);
    assert.match(await fs.readFile(path.join(workspaceRoot, "Lemmaize.lean"), "utf-8"), /lemma bar/);
    assert.match(await fs.readFile(path.join(workspaceRoot, "HaveLemma.lean"), "utf-8"), /lemma baz\.h1/);
    assert.match(await fs.readFile(path.join(workspaceRoot, "HaveSorry.lean"), "utf-8"), /have h : 1 = 1 := sorry/);

    const runChain = await runtime.chain("agents/axiom/runs/axiom_structure_file");
    const toolCalls = runChain.filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "tool.called" }> } =>
      receipt.body.type === "tool.called"
    );
    assert.ok(toolCalls.some((receipt) => receipt.body.tool === "lean.rename_file"));
    assert.ok(toolCalls.some((receipt) => receipt.body.tool === "lean.theorem2lemma_file"));
    assert.ok(toolCalls.some((receipt) => receipt.body.tool === "lean.have2lemma_file"));
    assert.ok(toolCalls.some((receipt) => receipt.body.tool === "lean.have2sorry_file"));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.AXLE_API_URL;
    else process.env.AXLE_API_URL = originalApiUrl;
    if (originalApiKey === undefined) delete process.env.AXLE_API_KEY;
    else process.env.AXLE_API_KEY = originalApiKey;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runAxiom exposes lean.theorem2sorry_file through the durable agent loop", async () => {
  const dir = await mkTmp("receipt-axiom-theorem2sorry");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace");
  const originalFetch = globalThis.fetch;
  const originalApiUrl = process.env.AXLE_API_URL;
  const originalApiKey = process.env.AXLE_API_KEY;

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, "Exercises.lean"),
    [
      "import Mathlib",
      "",
      "theorem left_as_exercise : 1 = 1 := by",
      "  rfl",
      "",
      "theorem keep_me : 2 = 2 := by",
      "  rfl",
      "",
    ].join("\n"),
    "utf-8"
  );

  const runtime = mkRuntime(dataDir);

  const memoryTools: MemoryTools = {
    read: async () => [],
    search: async () => [],
    summarize: async () => ({ summary: "", entries: [] }),
    commit: async (input) => ({
      id: `mem_${Date.now().toString(36)}`,
      scope: input.scope,
      text: input.text,
      tags: input.tags,
      meta: input.meta,
      ts: Date.now(),
    }),
    diff: async () => [],
    reindex: async () => 0,
  };

  const delegationTools: DelegationTools = {
    "agent.delegate": async () => ({ output: "", summary: "" }),
    "agent.status": async () => ({ output: "", summary: "" }),
    "agent.inspect": async () => ({ output: "", summary: "" }),
  };

  const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  process.env.AXLE_API_URL = "https://axle.example.test";
  process.env.AXLE_API_KEY = "test-key";

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    fetchCalls.push({ url, body });

    if (url.endsWith("/api/v1/theorem2sorry")) {
      return new Response(JSON.stringify({
        okay: true,
        content: [
          "import Mathlib",
          "",
          "theorem left_as_exercise : 1 = 1 := sorry",
          "",
          "theorem keep_me : 2 = 2 := by",
          "  rfl",
          "",
        ].join("\n"),
        lean_messages: { errors: [], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: [],
        timings: { total_ms: 18 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/api/v1/check")) {
      return new Response(JSON.stringify({
        okay: true,
        content: body.content,
        lean_messages: { errors: [], warnings: [], infos: [] },
        tool_messages: { errors: [], warnings: [], infos: [] },
        failed_declarations: [],
        timings: { total_ms: 10 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  let llmCalls = 0;
  const input = withStructured({
    stream: "agents/axiom",
    runId: "axiom_theorem2sorry",
    problem: "Turn left_as_exercise into an exercise by replacing its proof with sorry and validate the result.",
    config: normalizeAxiomConfig({
      maxIterations: 4,
      workspace: ".",
      leanEnvironment: "lean-4.28.0",
      localValidationMode: "off",
    }),
    runtime,
    prompts: loadAxiomPrompts(),
    llmText: async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return JSON.stringify({
          thought: "Convert the selected theorem into sorry form first.",
          action: {
            type: "tool",
            name: "lean.theorem2sorry_file",
            input: { path: "Exercises.lean", names: ["left_as_exercise"] },
          },
        });
      }
      if (llmCalls === 2) {
        return JSON.stringify({
          thought: "Validate the rewritten file with AXLE.",
          action: {
            type: "tool",
            name: "lean.check_file",
            input: { path: "Exercises.lean" },
          },
        });
      }
      return JSON.stringify({
        thought: "The exercise file is ready.",
        action: {
          type: "final",
          text: "Rewrote left_as_exercise with theorem2sorry and validated Exercises.lean with AXLE.",
        },
      });
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools,
    workspaceRoot,
  });

  try {
    await runAxiom(input);

    assert.equal(fetchCalls[0]?.url, "https://axle.example.test/api/v1/theorem2sorry");
    assert.deepEqual(fetchCalls[0]?.body.names, ["left_as_exercise"]);
    assert.equal(fetchCalls[1]?.url, "https://axle.example.test/api/v1/check");

    const rewritten = await fs.readFile(path.join(workspaceRoot, "Exercises.lean"), "utf-8");
    assert.match(rewritten, /theorem left_as_exercise : 1 = 1 := sorry/);
    assert.match(rewritten, /theorem keep_me : 2 = 2 := by/);

    const runChain = await runtime.chain("agents/axiom/runs/axiom_theorem2sorry");
    assert.ok(
      runChain.some((receipt) => receipt.body.type === "tool.called" && receipt.body.tool === "lean.theorem2sorry_file"),
      "missing lean.theorem2sorry_file call"
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.AXLE_API_URL;
    else process.env.AXLE_API_URL = originalApiUrl;
    if (originalApiKey === undefined) delete process.env.AXLE_API_KEY;
    else process.env.AXLE_API_KEY = originalApiKey;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runAxiom enforces local Lean validation when required", async () => {
  const dir = await mkTmp("receipt-axiom-local");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  const originalFetch = globalThis.fetch;
  const originalApiUrl = process.env.AXLE_API_URL;
  const originalApiKey = process.env.AXLE_API_KEY;
  const originalPath = process.env.PATH;

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "lakefile.toml"), "name = \"demo\"\n", "utf-8");
  await fs.writeFile(
    path.join(workspaceRoot, "Main.lean"),
    "import Mathlib\n\ntheorem foo : 1 = 1 := by\n  rfl\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(binDir, "lake"),
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then",
      "  echo 'Lake version 5.0.0'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"env\" ] && [ \"$2\" = \"lean\" ]; then",
      "  if [ -f \"$3\" ]; then",
      "    echo \"validated $3\"",
      "    exit 0",
      "  fi",
      "  echo \"missing file: $3\" >&2",
      "  exit 1",
      "fi",
      "if [ \"$1\" = \"build\" ]; then",
      "  echo 'build ok'",
      "  exit 0",
      "fi",
      "echo \"unexpected args: $@\" >&2",
      "exit 2",
      "",
    ].join("\n"),
    "utf-8"
  );
  await fs.chmod(path.join(binDir, "lake"), 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

  const runtime = mkRuntime(dataDir);

  const memoryTools: MemoryTools = {
    read: async () => [],
    search: async () => [],
    summarize: async () => ({ summary: "", entries: [] }),
    commit: async (input) => ({
      id: `mem_${Date.now().toString(36)}`,
      scope: input.scope,
      text: input.text,
      tags: input.tags,
      meta: input.meta,
      ts: Date.now(),
    }),
    diff: async () => [],
    reindex: async () => 0,
  };

  const delegationTools: DelegationTools = {
    "agent.delegate": async () => ({ output: "", summary: "" }),
    "agent.status": async () => ({ output: "", summary: "" }),
    "agent.inspect": async () => ({ output: "", summary: "" }),
  };

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
        timings: { total_ms: 11 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  let llmCalls = 0;
  const input = withStructured({
    stream: "agents/axiom",
    runId: "axiom_local_validation",
    problem: "Check Main.lean and report whether theorem foo compiles.",
    config: normalizeAxiomConfig({
      maxIterations: 3,
      workspace: ".",
      leanEnvironment: "lean-4.28.0",
      autoRepair: true,
      localValidationMode: "require",
    }),
    runtime,
    prompts: loadAxiomPrompts(),
    llmText: async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return JSON.stringify({
          thought: "Use AXLE to check the theorem file first.",
          action: {
            type: "tool",
            name: "lean.check_file",
            input: { path: "Main.lean" },
          },
        });
      }
      return JSON.stringify({
        thought: "The file compiles, so finalize.",
        action: {
          type: "final",
          text: "Main.lean compiles and theorem foo is valid.",
        },
      });
    },
    model: "test-model",
    apiReady: true,
    memoryTools,
    delegationTools,
    workspaceRoot,
  });

  try {
    await runAxiom(input);

    const runChain = await runtime.chain("agents/axiom/runs/axiom_local_validation");
    const validationEvent = runChain.findLast((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "validation.report" }> } =>
      receipt.body.type === "validation.report" && receipt.body.gate === "local-lean"
    );
    assert.equal(validationEvent?.body.ok, true);
    assert.equal(validationEvent?.body.target, "Main.lean");

    const finalEvent = runChain.findLast((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "response.finalized" }> } =>
      receipt.body.type === "response.finalized"
    );
    assert.match(finalEvent?.body.content ?? "", /Local Lean validation passed on Main\.lean/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.AXLE_API_URL;
    else process.env.AXLE_API_URL = originalApiUrl;
    if (originalApiKey === undefined) delete process.env.AXLE_API_KEY;
    else process.env.AXLE_API_KEY = originalApiKey;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
