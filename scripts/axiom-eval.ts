#!/usr/bin/env node

import process from "node:process";

import { AXIOM_BENCHMARKS, getAxiomBenchmarkCase, runAxiomBenchmarkCase } from "../src/evals/axiom-benchmark.js";
import type { AxiomPromptConfig } from "../src/prompts/axiom.js";

const parseArgs = (argv: ReadonlyArray<string>): Readonly<Record<string, string | boolean>> => {
  const out: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    index += 1;
  }
  return out;
};

const asString = (flags: Readonly<Record<string, string | boolean>>, key: string): string | undefined => {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
};

const usage = (): string => [
  "npm run eval:axiom -- --case <id> [--json] [--keep-workspace] [--max-iterations <n>]",
  "",
  "Available cases:",
  ...AXIOM_BENCHMARKS.map((item) => `- ${item.id}: ${item.title}`),
].join("\n");

const loadPromptOverride = (): AxiomPromptConfig | undefined => {
  const artifactType = process.env.IMPROVEMENT_ARTIFACT_TYPE;
  const target = process.env.IMPROVEMENT_TARGET;
  const patch = process.env.IMPROVEMENT_PATCH;
  if (artifactType !== "prompt_patch") return undefined;
  if (target !== "prompts/axiom.prompts.json") return undefined;
  if (!patch?.trim()) return undefined;
  const parsed = JSON.parse(patch) as AxiomPromptConfig;
  if (typeof parsed.system !== "string" || !parsed.user || typeof parsed.user.loop !== "string") {
    throw new Error("IMPROVEMENT_PATCH for prompts/axiom.prompts.json is not a valid prompt config");
  }
  return parsed;
};

const main = async (): Promise<void> => {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const selected = asString(flags, "case") ?? AXIOM_BENCHMARKS[0]?.id;
  if (!selected) {
    throw new Error("no benchmark cases available");
  }
  const benchmark = getAxiomBenchmarkCase(selected);
  if (!benchmark) {
    throw new Error(`unknown benchmark case '${selected}'\n\n${usage()}`);
  }

  const prompts = loadPromptOverride();
  const maxIterationsRaw = asString(flags, "max-iterations");
  const maxIterations = maxIterationsRaw ? Number(maxIterationsRaw) : undefined;
  const result = await runAxiomBenchmarkCase({
    benchmark,
    prompts,
    keepWorkspace: flags["keep-workspace"] === true,
    maxIterations: Number.isFinite(maxIterations) ? maxIterations : undefined,
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.benchmarkId} - ${result.title}`);
    for (const check of result.checks) {
      console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    }
    if (result.finalResponse) {
      console.log("\nFinal response:\n" + result.finalResponse);
    }
  }

  process.exitCode = result.passed ? 0 : 1;
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
