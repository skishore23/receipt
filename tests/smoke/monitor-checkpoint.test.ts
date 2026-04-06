import { test, expect } from "bun:test";
import { buildMonitorCheckpointPrompt, MonitorCheckpointResultSchema } from "../../src/services/factory/monitor-checkpoint";

test("buildMonitorCheckpointPrompt returns a system and user prompt", () => {
  const result = buildMonitorCheckpointPrompt({
    taskPrompt: "Refactor the auth module to use JWT tokens",
    stdoutTail: "Editing src/auth/jwt.ts...\nRunning tests...\n3 passed, 0 failed",
    stderrTail: "",
    elapsedMs: 1_800_000,
    checkpoint: 1,
  });
  expect(result.system).toContain("progress");
  expect(result.user).toContain("Refactor the auth module");
  expect(result.user).toContain("30.0 minutes");
});

test("MonitorCheckpointResultSchema validates continue action", () => {
  const input = {
    assessment: "progressing",
    reasoning: "Worker is making steady progress on the refactoring task.",
    action: { kind: "continue" },
  };
  const parsed = MonitorCheckpointResultSchema.parse(input);
  expect(parsed.assessment).toBe("progressing");
  expect(parsed.action.kind).toBe("continue");
});

test("MonitorCheckpointResultSchema validates split action with subtasks", () => {
  const input = {
    assessment: "stalled",
    reasoning: "Worker is stuck trying to handle too many files at once.",
    action: {
      kind: "split",
      subtasks: [
        { title: "Refactor auth types", prompt: "Extract JWT types into src/auth/types.ts" },
        { title: "Refactor auth middleware", prompt: "Update middleware to use new types", dependsOn: ["0"] },
      ],
    },
  };
  const parsed = MonitorCheckpointResultSchema.parse(input);
  expect(parsed.action.kind).toBe("split");
  if (parsed.action.kind === "split") {
    expect(parsed.action.subtasks).toHaveLength(2);
    expect(parsed.action.subtasks[1].dependsOn).toEqual(["0"]);
  }
});

test("MonitorCheckpointResultSchema validates steer action", () => {
  const input = {
    assessment: "off_track",
    reasoning: "Worker started refactoring unrelated code.",
    action: { kind: "steer", guidance: "Focus only on the auth module, do not touch the user module." },
  };
  const parsed = MonitorCheckpointResultSchema.parse(input);
  expect(parsed.action.kind).toBe("steer");
});

test("MonitorCheckpointResultSchema validates abort action", () => {
  const input = {
    assessment: "failing",
    reasoning: "Worker is in an error loop with no progress.",
    action: { kind: "abort", reason: "Persistent compilation errors with no recovery attempts." },
  };
  const parsed = MonitorCheckpointResultSchema.parse(input);
  expect(parsed.action.kind).toBe("abort");
});
