#!/usr/bin/env bun

import { resolveFactoryRuntimeConfig } from "../src/factory-cli/config";
import {
  readFactoryReceiptInvestigation,
  renderFactoryReceiptInvestigationText,
} from "../src/factory-cli/investigate";

type ParsedArgs = {
  readonly targetId?: string;
  readonly json: boolean;
  readonly timelineLimit?: number;
  readonly contextChars?: number;
  readonly dataDir?: string;
  readonly repoRootOverride?: string;
  readonly help: boolean;
};

const usage = (): string => [
  "Usage:",
  "  bun scripts/factory-investigate.ts <objective|task|candidate|job|run> [--json]",
  "  bun scripts/factory-investigate.ts latest [--timeline-limit 60] [--context-chars 3200]",
  "",
  "Flags:",
  "  --json                 Print structured JSON instead of text",
  "  --timeline-limit <n>   Limit rendered timeline items in text mode",
  "  --context-chars <n>    Limit rendered context block size in text mode",
  "  --data-dir <path>      Override receipt data dir",
  "  --repo-root <path>     Override repo root used for artifact path resolution",
  "  -h, --help             Show this help",
].join("\n");

const parseNumberFlag = (value: string | undefined, flag: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive number`);
  }
  return Math.floor(parsed);
};

const parseArgs = (argv: ReadonlyArray<string>): ParsedArgs => {
  let targetId: string | undefined;
  let json = false;
  let timelineLimit: number | undefined;
  let contextChars: number | undefined;
  let dataDir: string | undefined;
  let repoRootOverride: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--timeline-limit") {
      timelineLimit = parseNumberFlag(argv[index + 1], "--timeline-limit");
      index += 1;
      continue;
    }
    if (arg === "--context-chars") {
      contextChars = parseNumberFlag(argv[index + 1], "--context-chars");
      index += 1;
      continue;
    }
    if (arg === "--data-dir") {
      const next = argv[index + 1]?.trim();
      if (!next) throw new Error("--data-dir requires a path");
      dataDir = next;
      index += 1;
      continue;
    }
    if (arg === "--repo-root") {
      const next = argv[index + 1]?.trim();
      if (!next) throw new Error("--repo-root requires a path");
      repoRootOverride = next;
      index += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (!targetId) {
      targetId = arg;
      continue;
    }
    throw new Error(`Unexpected argument '${arg}'`);
  }

  return {
    targetId,
    json,
    timelineLimit,
    contextChars,
    dataDir,
    repoRootOverride,
    help,
  };
};

const main = async (): Promise<void> => {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const runtime = await resolveFactoryRuntimeConfig(
    process.cwd(),
    parsed.repoRootOverride,
  );
  const dataDir = parsed.dataDir ?? runtime.dataDir;
  const repoRoot = parsed.repoRootOverride ?? runtime.repoRoot;
  const report = await readFactoryReceiptInvestigation(dataDir, repoRoot, parsed.targetId);

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderFactoryReceiptInvestigationText(report, {
    timelineLimit: parsed.timelineLimit,
    contextChars: parsed.contextChars,
  })}\n`);
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});
