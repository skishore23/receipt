import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CLI = path.join(ROOT, "src", "cli.ts");
const BUN = process.env.BUN_BIN?.trim() || "bun";

const run = (args: ReadonlyArray<string>): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(BUN, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: path.join(ROOT, "data"), RECEIPT_DATA_DIR: path.join(ROOT, "data") },
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
