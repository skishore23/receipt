import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const BUN = process.env.BUN_BIN?.trim() || process.execPath;

type CommandResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

const runCommand = (command: string, args: readonly string[]): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: ROOT,
      env: process.env,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });

test("smoke: project builds", async () => {
  const result = await runCommand(BUN, ["run", "build"]);

  expect(
    result.code,
  ).toBe(
    0,
  );
  expect(fs.existsSync(path.join(ROOT, "src", "client", "factory-client.ts"))).toBe(true);
  expect(fs.existsSync(path.join(ROOT, "src", "client", "factory-client.js"))).toBe(false);
  expect(fs.existsSync(path.join(ROOT, "dist", "assets", "factory.css"))).toBe(true);
  expect(fs.existsSync(path.join(ROOT, "dist", "assets", "factory-client.js"))).toBe(true);
  expect(fs.existsSync(path.join(ROOT, "dist", "assets", "htmx.min.js"))).toBe(true);
  expect(fs.existsSync(path.join(ROOT, "dist", "assets", "htmx-ext-sse.js"))).toBe(true);
}, 180_000);
