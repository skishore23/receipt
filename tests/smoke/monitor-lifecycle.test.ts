import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMonitorCheckpoint, type MonitorJobContext } from "../../src/services/factory/monitor-job";
import { MonitorCheckpointResultSchema } from "../../src/services/factory/monitor-checkpoint";

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("monitor checkpoint with progressing worker returns continue", async () => {
  const dir = await createTempDir("monitor-lifecycle-progress");
  const stdoutPath = path.join(dir, "stdout.log");
  const stderrPath = path.join(dir, "stderr.log");
  await fs.writeFile(stdoutPath, [
    "Analyzing codebase structure...",
    "Found 12 files to refactor",
    "Editing src/auth/types.ts - extracting interfaces",
    "Editing src/auth/middleware.ts - updating imports",
    "Running: bun test src/auth/",
    "6 tests passed, 0 failed",
  ].join("\n"), "utf-8");
  await fs.writeFile(stderrPath, "", "utf-8");

  const result = await runMonitorCheckpoint({
    stdoutPath,
    stderrPath,
    taskPrompt: "Refactor the auth module to use TypeScript interfaces",
    elapsedMs: 1_800_000,
    checkpoint: 1,
    evaluateLlm: async () => ({
      assessment: "progressing",
      reasoning: "Worker has edited 2 files and all tests pass.",
      action: { kind: "continue" },
    }),
  });

  expect(result.assessment).toBe("progressing");
  expect(result.action.kind).toBe("continue");
});

test("monitor checkpoint with stalled worker returns split", async () => {
  const dir = await createTempDir("monitor-lifecycle-stall");
  const stdoutPath = path.join(dir, "stdout.log");
  const stderrPath = path.join(dir, "stderr.log");
  await fs.writeFile(stdoutPath, [
    "Analyzing codebase...",
    "Error: Cannot find module 'src/auth/types'",
    "Retrying...",
    "Error: Cannot find module 'src/auth/types'",
    "Retrying...",
    "Error: Cannot find module 'src/auth/types'",
  ].join("\n"), "utf-8");
  await fs.writeFile(stderrPath, "Error: Cannot find module 'src/auth/types'", "utf-8");

  const result = await runMonitorCheckpoint({
    stdoutPath,
    stderrPath,
    taskPrompt: "Refactor the entire auth, user, and billing modules",
    elapsedMs: 3_600_000,
    checkpoint: 2,
    evaluateLlm: async () => ({
      assessment: "stalled",
      reasoning: "Worker is in an error loop. Task scope is too broad.",
      action: {
        kind: "split",
        subtasks: [
          { title: "Refactor auth module", prompt: "Refactor only src/auth/" },
          { title: "Refactor user module", prompt: "Refactor only src/user/", dependsOn: ["0"] },
          { title: "Refactor billing module", prompt: "Refactor only src/billing/", dependsOn: ["1"] },
        ],
      },
    }),
  });

  expect(result.assessment).toBe("stalled");
  expect(result.action.kind).toBe("split");
  if (result.action.kind === "split") {
    expect(result.action.subtasks).toHaveLength(3);
  }
});

test("monitor checkpoint with off-track worker returns steer", async () => {
  const dir = await createTempDir("monitor-lifecycle-offtrack");
  const stdoutPath = path.join(dir, "stdout.log");
  const stderrPath = path.join(dir, "stderr.log");
  await fs.writeFile(stdoutPath, [
    "Editing src/database/connection.ts...",
    "Adding connection pooling...",
    "Editing src/database/migrations.ts...",
  ].join("\n"), "utf-8");
  await fs.writeFile(stderrPath, "", "utf-8");

  const result = await runMonitorCheckpoint({
    stdoutPath,
    stderrPath,
    taskPrompt: "Fix the login button CSS on the homepage",
    elapsedMs: 1_800_000,
    checkpoint: 1,
    evaluateLlm: async () => ({
      assessment: "off_track",
      reasoning: "Worker is editing database files instead of fixing CSS.",
      action: {
        kind: "steer",
        guidance: "Stop editing database files. Focus only on the login button CSS in src/components/LoginButton.tsx.",
      },
    }),
  });

  expect(result.assessment).toBe("off_track");
  expect(result.action.kind).toBe("steer");
});

test("monitor checkpoint with failing worker returns abort", async () => {
  const dir = await createTempDir("monitor-lifecycle-abort");
  const stdoutPath = path.join(dir, "stdout.log");
  const stderrPath = path.join(dir, "stderr.log");
  await fs.writeFile(stdoutPath, "", "utf-8");
  await fs.writeFile(stderrPath, "FATAL: out of memory\nSegmentation fault", "utf-8");

  const result = await runMonitorCheckpoint({
    stdoutPath,
    stderrPath,
    taskPrompt: "Optimize memory usage",
    elapsedMs: 5_400_000,
    checkpoint: 3,
    evaluateLlm: async () => ({
      assessment: "failing",
      reasoning: "Worker process is crashing with OOM errors.",
      action: { kind: "abort", reason: "Persistent OOM crashes, needs human investigation." },
    }),
  });

  expect(result.assessment).toBe("failing");
  expect(result.action.kind).toBe("abort");
});

test("MonitorCheckpointResultSchema rejects invalid assessment", () => {
  expect(() => MonitorCheckpointResultSchema.parse({
    assessment: "unknown_status",
    reasoning: "test",
    action: { kind: "continue" },
  })).toThrow();
});

test("MonitorCheckpointResultSchema rejects split with fewer than 2 subtasks", () => {
  expect(() => MonitorCheckpointResultSchema.parse({
    assessment: "stalled",
    reasoning: "test",
    action: {
      kind: "split",
      subtasks: [{ title: "Only one", prompt: "Not enough" }],
    },
  })).toThrow();
});

test("MonitorCheckpointResultSchema rejects split with more than 5 subtasks", () => {
  expect(() => MonitorCheckpointResultSchema.parse({
    assessment: "stalled",
    reasoning: "test",
    action: {
      kind: "split",
      subtasks: Array.from({ length: 6 }, (_, i) => ({ title: `Task ${i}`, prompt: `Do ${i}` })),
    },
  })).toThrow();
});

test("monitor checkpoint passes truncated logs to LLM", async () => {
  const dir = await createTempDir("monitor-lifecycle-truncation");
  const stdoutPath = path.join(dir, "stdout.log");
  const stderrPath = path.join(dir, "stderr.log");
  // Write more than 2000 chars
  const longOutput = "x".repeat(5000);
  await fs.writeFile(stdoutPath, longOutput, "utf-8");
  await fs.writeFile(stderrPath, "", "utf-8");

  let receivedPrompt: { system: string; user: string } | undefined;
  await runMonitorCheckpoint({
    stdoutPath,
    stderrPath,
    taskPrompt: "Some task",
    elapsedMs: 1_800_000,
    checkpoint: 1,
    evaluateLlm: async (prompt) => {
      receivedPrompt = prompt;
      return {
        assessment: "progressing",
        reasoning: "OK",
        action: { kind: "continue" },
      };
    },
  });

  expect(receivedPrompt).toBeTruthy();
  // The stdout in the prompt should be truncated to ~2000 chars
  const stdoutSection = receivedPrompt!.user.split("## Recent stderr")[0];
  expect(stdoutSection.length).toBeLessThan(3000); // prompt text + 2000 chars max
});
