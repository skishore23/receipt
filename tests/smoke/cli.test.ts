import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  const help = await run(["help"]);
  expect(help.code).toBe(0);
  expect(help.stdout.includes("receipt <command>")).toBe(true);

  const jobs = await run(["jobs", "--limit", "1"]);
  expect(jobs.code).toBe(0);
  expect(jobs.stdout.includes("\"jobs\"")).toBe(true);
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
