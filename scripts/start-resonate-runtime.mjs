#!/usr/bin/env bun

import { spawn } from "node:child_process";

const bunBin = process.execPath;
const children = new Map();
let shuttingDown = false;

const parseCount = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const roles = [
  { role: "driver", count: 1 },
  { role: "worker-control", count: parseCount(process.env.CONTROL_WORKER_PROCESSES, 4) },
  { role: "worker-chat", count: parseCount(process.env.CHAT_WORKER_PROCESSES, 10) },
  { role: "worker-codex", count: parseCount(process.env.CODEX_WORKER_PROCESSES, 6) },
  { role: "api", count: 1 },
];

const stopChildren = (signal = "SIGTERM") => {
  shuttingDown = true;
  for (const child of children.values()) {
    if (child.exitCode === null && !child.killed) {
      child.kill(signal);
    }
  }
};

for (const { role, count } of roles) {
  for (let instance = 0; instance < count; instance += 1) {
    const key = `${role}:${instance + 1}`;
    const child = spawn(bunBin, ["src/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        JOB_BACKEND: "resonate",
        RECEIPT_PROCESS_ROLE: role,
        RECEIPT_PROCESS_INSTANCE: String(instance + 1),
      },
      stdio: "inherit",
    });
    children.set(key, child);
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      console.error(`[resonate-supervisor] ${key} exited (${signal ?? code ?? 0})`);
      stopChildren();
      process.exit(typeof code === "number" ? code : 1);
    });
  }
}

const shutdown = (signal) => {
  stopChildren(signal);
  setTimeout(() => {
    process.exit(0);
  }, 1000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await new Promise(() => {});
