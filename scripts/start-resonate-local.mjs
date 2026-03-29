#!/usr/bin/env bun

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const cwd = process.cwd();
const resonateUrl = process.env.RESONATE_URL ?? "http://127.0.0.1:8001";
const resonateSqlitePath = process.env.RESONATE_SQLITE_PATH
  ?? path.join(cwd, ".receipt", "resonate", "resonate.db");
const resonatePath = typeof Bun.which === "function" ? Bun.which("resonate") : null;

let shuttingDown = false;
const children = new Map();

const stopChildren = (signal = "SIGTERM") => {
  shuttingDown = true;
  for (const child of children.values()) {
    if (child.exitCode === null && !child.killed) {
      child.kill(signal);
    }
  }
};

const waitForResonate = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${resonateUrl}/`);
      if (response.status > 0) return;
    } catch {
      // Resonate is still starting.
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Resonate failed to become ready at ${resonateUrl}`);
};

await fs.mkdir(path.dirname(resonateSqlitePath), { recursive: true });

if (!resonatePath) {
  throw new Error(
    "[resonate-local] 'resonate' was not found on PATH. Install the Resonate CLI or use 'bun run start' for the local SQLite runtime.",
  );
}

const resonate = spawn(resonatePath, ["serve", "--aio-store-sqlite-path", resonateSqlitePath], {
  cwd,
  env: process.env,
  stdio: "inherit",
});
children.set("resonate", resonate);

resonate.on("error", (error) => {
  console.error("[resonate-local] failed to launch resonate", error);
  stopChildren();
  process.exit(1);
});

resonate.on("exit", (code, signal) => {
  if (shuttingDown) return;
  console.error(`[resonate-local] resonate exited (${signal ?? code ?? 0})`);
  stopChildren();
  process.exit(typeof code === "number" ? code : 1);
});

await waitForResonate();

const runtime = spawn(process.execPath, ["scripts/start-resonate-runtime.mjs"], {
  cwd,
  env: process.env,
  stdio: "inherit",
});
children.set("runtime", runtime);

runtime.on("exit", (code, signal) => {
  if (shuttingDown) return;
  console.error(`[resonate-local] runtime exited (${signal ?? code ?? 0})`);
  stopChildren();
  process.exit(typeof code === "number" ? code : 1);
});

const shutdown = (signal) => {
  stopChildren(signal);
  setTimeout(() => {
    process.exit(0);
  }, 1_000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await new Promise(() => {});
