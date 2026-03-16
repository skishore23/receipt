#!/usr/bin/env bun

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const bun = process.execPath && path.basename(process.execPath).toLowerCase().startsWith("bun")
  ? process.execPath
  : "bun";
const child = spawn(bun, ["src/cli.ts", "new", ...args], {
  cwd: ROOT,
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});

child.on("error", (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
