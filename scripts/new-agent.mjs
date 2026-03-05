#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = process.platform === "win32" ? "tsx.cmd" : "tsx";

const args = process.argv.slice(2);
const child = spawn(tsx, ["src/cli.ts", "new", ...args], {
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
