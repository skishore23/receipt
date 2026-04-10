import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorCheckpointIntervalMs, monitorDetectEvidence, runMonitorCheckpoint, type MonitorJobContext } from "../../src/services/factory/monitor-job";

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("runMonitorCheckpoint reads logs and returns assessment", async () => {
  const taskDir = await createTempDir("monitor-test");
  const stdoutPath = path.join(taskDir, "task_1.stdout.log");
  const stderrPath = path.join(taskDir, "task_1.stderr.log");
  await fs.writeFile(stdoutPath, "Editing src/auth.ts...\nAdded JWT validation\nTests passing\n", "utf-8");
  await fs.writeFile(stderrPath, "", "utf-8");

  let llmCalled = false;
  const ctx: MonitorJobContext = {
    stdoutPath,
    stderrPath,
    taskPrompt: "Add JWT auth to the API",
    elapsedMs: 1_800_000,
    checkpoint: 1,
    evaluateLlm: async (prompt) => {
      llmCalled = true;
      expect(prompt.system).toContain("progress");
      return {
        assessment: "progressing" as const,
        reasoning: "Worker is actively editing auth files.",
        recommendation: { kind: "continue" as const },
      };
    },
  };

  const result = await runMonitorCheckpoint(ctx);
  expect(llmCalled).toBe(true);
  expect(result.assessment).toBe("progressing");
  expect(result.recommendation.kind).toBe("continue");
});

test("runMonitorCheckpoint handles missing log files gracefully", async () => {
  const taskDir = await createTempDir("monitor-test-missing");
  const ctx: MonitorJobContext = {
    stdoutPath: path.join(taskDir, "nonexistent.stdout.log"),
    stderrPath: path.join(taskDir, "nonexistent.stderr.log"),
    taskPrompt: "Some task",
    elapsedMs: 1_800_000,
    checkpoint: 1,
    evaluateLlm: async () => ({
      assessment: "stalled" as const,
      reasoning: "No output at all.",
      recommendation: { kind: "recommend_abort" as const, reason: "No worker output detected." },
    }),
  };

  const result = await runMonitorCheckpoint(ctx);
  expect(result.assessment).toBe("stalled");
});

test("monitorCheckpointIntervalMs returns shorter interval for high severity", () => {
  expect(monitorCheckpointIntervalMs("delivery", 1)).toBe(90_000);
  expect(monitorCheckpointIntervalMs("investigation", 1)).toBe(90_000);
  expect(monitorCheckpointIntervalMs("investigation", 0)).toBe(90_000);
});

test("monitorCheckpointIntervalMs returns investigation interval for investigation mode", () => {
  expect(monitorCheckpointIntervalMs("investigation", 2)).toBe(2 * 60 * 1_000);
  expect(monitorCheckpointIntervalMs("investigation", 3)).toBe(2 * 60 * 1_000);
});

test("monitorCheckpointIntervalMs returns delivery interval for delivery mode", () => {
  expect(monitorCheckpointIntervalMs("delivery", 2)).toBe(10 * 60 * 1_000);
  expect(monitorCheckpointIntervalMs("delivery", 5)).toBe(10 * 60 * 1_000);
});

test("monitorDetectEvidence returns false for missing directory", async () => {
  const result = await monitorDetectEvidence("/tmp/does-not-exist-" + Date.now());
  expect(result).toBe(false);
});

test("monitorDetectEvidence returns false for empty directory", async () => {
  const dir = await createTempDir("monitor-evidence-empty");
  try {
    expect(await monitorDetectEvidence(dir)).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("monitorDetectEvidence returns true when json evidence exists", async () => {
  const dir = await createTempDir("monitor-evidence-json");
  try {
    await fs.writeFile(path.join(dir, "inventory.json"), "{}", "utf-8");
    expect(await monitorDetectEvidence(dir)).toBe(true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("monitorDetectEvidence returns true when markdown evidence exists", async () => {
  const dir = await createTempDir("monitor-evidence-md");
  try {
    await fs.writeFile(path.join(dir, "report.md"), "# Report", "utf-8");
    expect(await monitorDetectEvidence(dir)).toBe(true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("monitorDetectEvidence ignores non-evidence files", async () => {
  const dir = await createTempDir("monitor-evidence-other");
  try {
    await fs.writeFile(path.join(dir, "scratch.txt"), "notes", "utf-8");
    await fs.writeFile(path.join(dir, "debug.log"), "log output", "utf-8");
    expect(await monitorDetectEvidence(dir)).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
