#!/usr/bin/env bun

import { spawn } from "node:child_process";

const cwd = process.cwd();
const resonatePath = typeof Bun.which === "function" ? Bun.which("resonate") : null;

if (!resonatePath) {
  throw new Error(
    "[start-resonate-dev] 'resonate' was not found on PATH. Install the Resonate CLI or use 'bun run dev' for the local SQLite runtime.",
  );
}

const child = spawn(process.execPath, ["scripts/start-resonate-local.mjs"], {
  cwd,
  env: {
    ...process.env,
    RECEIPT_SERVER_WATCH: process.env.RECEIPT_SERVER_WATCH ?? "api",
  },
  stdio: "inherit",
});

await new Promise((resolve, reject) => {
  child.on("exit", (code) => {
    if (code === 0) resolve(undefined);
    else reject(new Error(`start-resonate-dev exited with code ${code ?? "null"}`));
  });
  child.on("error", reject);
});
