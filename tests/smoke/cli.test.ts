import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const tsx = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

const run = (args: ReadonlyArray<string>): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(tsx, ["src/cli.ts", ...args], { cwd: ROOT, env: { ...process.env, DATA_DIR: path.join(ROOT, "data") }, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

test("cli: help and jobs commands are available", { timeout: 60_000 }, async () => {
  const help = await run(["help"]);
  assert.equal(help.code, 0);
  assert.equal(help.stdout.includes("receipt <command>"), true);

  const jobs = await run(["jobs", "--limit", "1"]);
  assert.equal(jobs.code, 0);
  assert.equal(jobs.stdout.includes("\"jobs\""), true);
});
