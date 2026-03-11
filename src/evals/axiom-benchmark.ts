import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jsonBranchStore, jsonlStore } from "../adapters/jsonl.js";
import type { DelegationTools } from "../adapters/delegation.js";
import type { MemoryTools } from "../adapters/memory-tools.js";
import { llmStructured as openAiLlmStructured, llmText as openAiLlmText } from "../adapters/openai.js";
import { runAxiom, normalizeAxiomConfig, type AxiomRunInput } from "../agents/axiom.js";
import { createRuntime } from "../core/runtime.js";
import type { AgentCmd, AgentEvent, AgentState } from "../modules/agent.js";
import { decide as decideAgent, reduce as reduceAgent, initial as initialAgent } from "../modules/agent.js";
import { loadAxiomPrompts, type AxiomPromptConfig } from "../prompts/axiom.js";

export type AxiomBenchmarkCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
};

export type AxiomBenchmarkResult = {
  readonly benchmarkId: string;
  readonly title: string;
  readonly passed: boolean;
  readonly runId: string;
  readonly stream: string;
  readonly workspaceRoot: string;
  readonly finalResponse?: string;
  readonly checks: ReadonlyArray<AxiomBenchmarkCheck>;
};

export type AxiomBenchmarkCase = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly tags: ReadonlyArray<string>;
  readonly problem: string;
  readonly expectedFile: string;
  readonly theoremName: string;
  readonly seedFiles?: Readonly<Record<string, string>>;
};

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const mkRuntime = (dir: string) => createRuntime<AgentCmd, AgentEvent, AgentState>(
  jsonlStore<AgentEvent>(dir),
  jsonBranchStore(dir),
  decideAgent,
  reduceAgent,
  initialAgent
);

const makeMemoryTools = (): MemoryTools => ({
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

const makeDelegationTools = (): DelegationTools => ({
  "agent.delegate": async () => ({ output: "", summary: "" }),
  "agent.status": async () => ({ output: "", summary: "" }),
  "agent.inspect": async () => ({ output: "", summary: "" }),
});

export const AXIOM_BENCHMARKS: ReadonlyArray<AxiomBenchmarkCase> = [
  {
    id: "list_length_append_nat",
    title: "List Length Append",
    description: "Prove a standard list theorem in Lean, using the workspace and AXLE validation tools.",
    tags: ["starter", "lists", "library-search", "verification"],
    expectedFile: "Main.lean",
    theoremName: "list_length_append_nat",
    problem: [
      "Create `Main.lean` in the workspace.",
      "Use `import Mathlib`.",
      "Prove this exact theorem:",
      "",
      "theorem list_length_append_nat (xs ys : List Nat) :",
      "  List.length (xs ++ ys) = List.length xs + List.length ys := by",
      "  ...",
      "",
      "Requirements:",
      "- write the theorem into `Main.lean`",
      "- validate the result with AXLE using `lean.check_file` or `lean.verify_file`",
      "- do not leave any `sorry` in the final file",
      "- finish only after the theorem is validated",
    ].join("\n"),
  },
] as const;

export const getAxiomBenchmarkCase = (id: string): AxiomBenchmarkCase | undefined =>
  AXIOM_BENCHMARKS.find((item) => item.id === id);

const latestFinalResponse = (chain: ReadonlyArray<{ readonly body: AgentEvent }>): string | undefined => {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const event = chain[index]?.body;
    if (event?.type === "response.finalized") return event.content;
  }
  return undefined;
};

export const evaluateAxiomBenchmark = async (opts: {
  readonly benchmark: AxiomBenchmarkCase;
  readonly chain: ReadonlyArray<{ readonly body: AgentEvent }>;
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly stream: string;
}): Promise<AxiomBenchmarkResult> => {
  const { benchmark, chain, workspaceRoot, runId, stream } = opts;
  const expectedAbs = path.join(workspaceRoot, benchmark.expectedFile);
  const checks: AxiomBenchmarkCheck[] = [];

  const finalStatus = (() => {
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const event = chain[index]?.body;
      if (event?.type === "run.status") return event;
    }
    return undefined;
  })();
  checks.push({
    name: "run.completed",
    ok: finalStatus?.status === "completed",
    detail: finalStatus ? `status=${finalStatus.status}${finalStatus.note ? ` note=${finalStatus.note}` : ""}` : "missing run.status",
  });

  const fileExists = await fs.access(expectedAbs).then(() => true).catch(() => false);
  checks.push({
    name: "file.exists",
    ok: fileExists,
    detail: fileExists ? `found ${benchmark.expectedFile}` : `missing ${benchmark.expectedFile}`,
  });

  const fileContent = fileExists ? await fs.readFile(expectedAbs, "utf-8") : "";
  checks.push({
    name: "file.theorem_name",
    ok: fileContent.includes(`theorem ${benchmark.theoremName}`),
    detail: fileContent.includes(`theorem ${benchmark.theoremName}`)
      ? `found theorem ${benchmark.theoremName}`
      : `theorem ${benchmark.theoremName} not found in ${benchmark.expectedFile}`,
  });

  checks.push({
    name: "file.no_sorry",
    ok: !/\bsorry\b/.test(fileContent),
    detail: /\bsorry\b/.test(fileContent) ? "file still contains sorry" : "file has no sorry",
  });

  const axleValidation = chain.find((receipt) => {
    const event = receipt.body;
    return event.type === "tool.called"
      && (event.tool === "lean.check_file" || event.tool === "lean.verify_file")
      && !event.error
      && /okay/i.test(event.summary ?? "");
  });
  checks.push({
    name: "axle.validation",
    ok: Boolean(axleValidation),
    detail: axleValidation && axleValidation.body.type === "tool.called"
      ? `${axleValidation.body.tool}: ${axleValidation.body.summary ?? "okay"}`
      : "no successful lean.check_file or lean.verify_file found",
  });

  const finalResponse = latestFinalResponse(chain);
  checks.push({
    name: "response.present",
    ok: Boolean(finalResponse?.trim()),
    detail: finalResponse?.trim() ? "final response recorded" : "missing final response",
  });

  return {
    benchmarkId: benchmark.id,
    title: benchmark.title,
    passed: checks.every((check) => check.ok),
    runId,
    stream,
    workspaceRoot,
    finalResponse,
    checks,
  };
};

export const runAxiomBenchmarkCase = async (opts: {
  readonly benchmark: AxiomBenchmarkCase;
  readonly prompts?: AxiomPromptConfig;
  readonly llmText?: AxiomRunInput["llmText"];
  readonly llmStructured?: AxiomRunInput["llmStructured"];
  readonly keepWorkspace?: boolean;
  readonly maxIterations?: number;
}): Promise<AxiomBenchmarkResult> => {
  const benchmark = opts.benchmark;
  const root = await mkTmp(`axiom-bench-${benchmark.id}`);
  const dataDir = path.join(root, "data");
  const workspaceRoot = path.join(root, "workspace");
  const stream = "agents/axiom";
  const runId = `bench_${benchmark.id}_${Date.now().toString(36)}`;

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  for (const [rel, content] of Object.entries(benchmark.seedFiles ?? {})) {
    const abs = path.join(workspaceRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
  }

  const runtime = mkRuntime(dataDir);
  const prompts = opts.prompts ?? loadAxiomPrompts();
  const llmText = opts.llmText ?? openAiLlmText;
  const llmStructured = opts.llmStructured ?? openAiLlmStructured;
  const usingDefaultLlm = !opts.llmText || !opts.llmStructured;

  if (usingDefaultLlm && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing; cannot run live Axiom benchmark");
  }

  try {
    await runAxiom({
      stream,
      runId,
      problem: benchmark.problem,
      config: normalizeAxiomConfig({
        maxIterations: opts.maxIterations ?? 12,
        workspace: ".",
        memoryScope: `axiom.benchmark.${benchmark.id}`,
        autoRepair: true,
        localValidationMode: "off",
      }),
      runtime,
      prompts,
      llmText,
      llmStructured,
      model: process.env.OPENAI_MODEL ?? "gpt-5.2",
      apiReady: true,
      memoryTools: makeMemoryTools(),
      delegationTools: makeDelegationTools(),
      workspaceRoot,
    });

    const chain = await runtime.chain(`${stream}/runs/${runId}`);
    return await evaluateAxiomBenchmark({ benchmark, chain, workspaceRoot, runId, stream });
  } finally {
    if (!opts.keepWorkspace) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
};
