#!/usr/bin/env node

import process from "node:process";

import { AXIOM_GUILD_BENCHMARKS, getAxiomGuildBenchmarkCase, runAxiomGuildBenchmarkCase } from "../src/evals/axiom-guild-benchmark.js";

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
  "npm run eval:axiom-guild -- --case <id> [--json] [--keep-workspace]",
  "",
  "Available cases:",
  ...AXIOM_GUILD_BENCHMARKS.map((item) => `- ${item.id}: ${item.title}`),
].join("\n");

const main = async (): Promise<void> => {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const selected = asString(flags, "case") ?? AXIOM_GUILD_BENCHMARKS[0]?.id;
  if (!selected) {
    throw new Error("no benchmark cases available");
  }
  const benchmark = getAxiomGuildBenchmarkCase(selected);
  if (!benchmark) {
    throw new Error(`unknown benchmark case '${selected}'\n\n${usage()}`);
  }

  const result = await runAxiomGuildBenchmarkCase({
    benchmark,
    keepWorkspace: flags["keep-workspace"] === true,
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.benchmarkId} - ${result.title}`);
    for (const check of result.checks) {
      console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    }
  }

  process.exitCode = result.passed ? 0 : 1;
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
