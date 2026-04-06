import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMonitorCheckpoint, type MonitorJobContext } from "../../src/services/factory/monitor-job";

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
        action: { kind: "continue" as const },
      };
    },
  };

  const result = await runMonitorCheckpoint(ctx);
  expect(llmCalled).toBe(true);
  expect(result.assessment).toBe("progressing");
  expect(result.action.kind).toBe("continue");
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
      action: { kind: "abort" as const, reason: "No worker output detected." },
    }),
  };

  const result = await runMonitorCheckpoint(ctx);
  expect(result.assessment).toBe("stalled");
});
