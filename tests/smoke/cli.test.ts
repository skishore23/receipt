import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { receipt } from "@receipt/core/chain";

import { jsonlStore as legacyJsonlStore } from "../../src/adapters/legacy-jsonl";
import { resolveBunRuntime } from "../../src/lib/runtime-paths";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CLI = path.join(ROOT, "src", "cli.ts");
const BUN = resolveBunRuntime();

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const run = (
  args: ReadonlyArray<string>,
  envOverrides: Record<string, string> = {},
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(BUN, [CLI, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATA_DIR: path.join(ROOT, "data"),
        RECEIPT_DATA_DIR: path.join(ROOT, "data"),
        ...envOverrides,
      },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

test("cli: help and jobs commands are available", async () => {
  const dataDir = await createTempDir("receipt-cli-help");
  try {
    const env = {
      DATA_DIR: dataDir,
      RECEIPT_DATA_DIR: dataDir,
    };
    const help = await run(["help"], env);
    expect(help.code).toBe(0);
    expect(help.stdout.includes("receipt <command>")).toBe(true);
    expect(help.stdout.includes("factory [init|run|create|compose|watch|inspect|replay|replay-chat|analyze|parse|investigate|audit")).toBe(true);

    const jobs = await run(["jobs", "--limit", "1"], env);
    expect(jobs.code).toBe(0);
    expect(jobs.stdout.includes("\"jobs\"")).toBe(true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);

test("cli: legacy jsonl data requires migration and migrate imports the stream into sqlite", async () => {
  const dataDir = await createTempDir("receipt-cli-migrate");
  try {
    const store = legacyJsonlStore<{ readonly type: string }>(dataDir);
    const stream = "agents/test/runs/run_legacy_cli";
    const first = receipt(stream, undefined, { type: "seed.alpha" }, 1_000);
    const second = receipt(stream, first.hash, { type: "seed.beta" }, 2_000);
    await store.append(first);
    await store.append(second);

    const before = await run(["trace", stream], {
      DATA_DIR: dataDir,
      RECEIPT_DATA_DIR: dataDir,
    });
    expect(before.code).toBe(1);
    expect(before.stderr.includes("legacy JSONL data detected")).toBe(true);

    const migrated = await run(["migrate", "sqlite", "--data-dir", dataDir], {
      DATA_DIR: dataDir,
      RECEIPT_DATA_DIR: dataDir,
    });
    expect(migrated.code).toBe(0);
    const migratedPayload = JSON.parse(migrated.stdout) as {
      readonly ok: boolean;
      readonly importedReceipts: number;
      readonly importedStreams: number;
    };
    expect(migratedPayload.ok).toBe(true);
    expect(migratedPayload.importedReceipts).toBe(2);
    expect(migratedPayload.importedStreams).toBe(1);

    const after = await run(["trace", stream], {
      DATA_DIR: dataDir,
      RECEIPT_DATA_DIR: dataDir,
    });
    expect(after.code).toBe(0);
    expect(after.stdout.includes("seed.alpha")).toBe(true);
    expect(after.stdout.includes("seed.beta")).toBe(true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);

test("cli: run uses the Resonate backend and fails fast when dispatch is unavailable", async () => {
  const dataDir = await createTempDir("receipt-cli-run-resonate");
  try {
    const result = await run([
      "run",
      "agent",
      "--problem",
      "probe",
    ], {
      DATA_DIR: dataDir,
      RECEIPT_DATA_DIR: dataDir,
      JOB_BACKEND: "resonate",
      RESONATE_URL: "http://127.0.0.1:1",
    });

    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr.includes("error:")).toBe(true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);
