import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CLI = path.join(ROOT, "src", "cli.ts");
const BUN = process.env.BUN_BIN?.trim() || "bun";

const run = (
  args: ReadonlyArray<string>,
  envOverrides?: NodeJS.ProcessEnv,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(BUN, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: path.join(ROOT, "data"), RECEIPT_DATA_DIR: path.join(ROOT, "data"), ...envOverrides },
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
  expect(help.stdout.includes("receipt start [--reset]")).toBe(true);

  const jobs = await run(["jobs", "--limit", "1"]);
  expect(jobs.code).toBe(0);
  expect(jobs.stdout.includes("\"jobs\"")).toBe(true);
}, 60_000);

test("cli: invalid setup config fails until --reset", async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-cli-invalid-config-"));
  const configDir = path.join(tempHome, ".receipt");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ version: 999 }), "utf-8");

  const failed = await run(["help"], { HOME: tempHome });
  expect(failed.code).toBe(1);
  expect(failed.stderr.includes("receipt start --reset")).toBe(true);
}, 60_000);
