import { test, expect } from "bun:test";
import { buildMonitorCheckpointPrompt, MonitorCheckpointResultSchema, parseMonitorRecommendation } from "../../src/services/factory/monitor-checkpoint";

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

test("buildMonitorCheckpointPrompt includes proportionality rules for investigation mode", () => {
  const result = buildMonitorCheckpointPrompt({
    taskPrompt: "List EC2 containers",
    stdoutTail: "Creating helper script...",
    stderrTail: "",
    elapsedMs: 120_000,
    checkpoint: 1,
    objectiveMode: "investigation",
  });
  expect(result.system).toContain("Investigation-Mode Rules");
  expect(result.system).toContain("Proportionality");
  expect(result.system).toContain("building new scripts");
  expect(result.system).toContain("off_track");
  expect(result.user).toContain("mode: investigation");
});

test("buildMonitorCheckpointPrompt includes evidence steering when evidence is present", () => {
  const result = buildMonitorCheckpointPrompt({
    taskPrompt: "List EC2 containers",
    stdoutTail: "Running git status...",
    stderrTail: "",
    elapsedMs: 180_000,
    checkpoint: 2,
    objectiveMode: "investigation",
    evidencePresent: true,
  });
  expect(result.user).toContain("Evidence Status");
  expect(result.user).toContain("Evidence artifacts are PRESENT");
  expect(result.user).toContain("You may inspect the local evidence files already present under .receipt/factory/evidence");
  expect(result.user).toContain("Produce your final structured JSON result immediately using that evidence");
});

test("buildMonitorCheckpointPrompt includes the current execution phase", () => {
  const result = buildMonitorCheckpointPrompt({
    taskPrompt: "List ECS services",
    stdoutTail: "Evidence already captured.",
    stderrTail: "",
    elapsedMs: 240_000,
    checkpoint: 3,
    objectiveMode: "investigation",
    evidencePresent: true,
    taskExecutionPhase: "synthesizing",
  });
  expect(result.user).toContain("execution phase: synthesizing");
  expect(result.system).toContain("do not recommend another redirect");
});

test("buildMonitorCheckpointPrompt omits investigation rules for delivery mode", () => {
  const result = buildMonitorCheckpointPrompt({
    taskPrompt: "Implement feature X",
    stdoutTail: "Editing files...",
    stderrTail: "",
    elapsedMs: 600_000,
    checkpoint: 1,
    objectiveMode: "delivery",
  });
  expect(result.system).not.toContain("Investigation-Mode Rules");
  expect(result.user).toContain("mode: delivery");
});

test("MonitorCheckpointResultSchema validates continue recommendation", () => {
  const input = {
    assessment: "progressing",
    reasoning: "Worker is making steady progress on the refactoring task.",
    recommendation: { kind: "continue", guidance: null, subtasks: null, reason: null },
  };
  const parsed = MonitorCheckpointResultSchema.parse(input);
  expect(parsed.assessment).toBe("progressing");
  const recommendation = parseMonitorRecommendation(parsed.recommendation);
  expect(recommendation.kind).toBe("continue");
});

test("MonitorCheckpointResultSchema validates split recommendation with subtasks", () => {
  const input = {
    assessment: "stalled",
    reasoning: "Worker is stuck trying to handle too many files at once.",
    recommendation: {
      kind: "recommend_split",
      subtasks: [
        { title: "Refactor auth types", prompt: "Extract JWT types into src/auth/types.ts", dependsOn: null },
        { title: "Refactor auth middleware", prompt: "Update middleware to use new types", dependsOn: ["0"] },
      ],
      guidance: null,
      reason: null,
    },
  };
  const parsed = MonitorCheckpointResultSchema.parse(input);
  const recommendation = parseMonitorRecommendation(parsed.recommendation);
  expect(recommendation.kind).toBe("recommend_split");
  if (recommendation.kind === "recommend_split") {
    expect(recommendation.subtasks).toHaveLength(2);
    expect(recommendation.subtasks[1].dependsOn).toEqual(["0"]);
  }
});

test("MonitorCheckpointResultSchema validates steer recommendation", () => {
  const input = {
    assessment: "off_track",
    reasoning: "Worker started refactoring unrelated code.",
    recommendation: {
      kind: "recommend_steer",
      guidance: "Focus only on the auth module, do not touch the user module.",
      subtasks: null,
      reason: null,
    },
  };
  const parsed = MonitorCheckpointResultSchema.parse(input);
  const recommendation = parseMonitorRecommendation(parsed.recommendation);
  expect(recommendation.kind).toBe("recommend_steer");
});

test("MonitorCheckpointResultSchema validates abort recommendation", () => {
  const input = {
    assessment: "failing",
    reasoning: "Worker is in an error loop with no progress.",
    recommendation: {
      kind: "recommend_abort",
      guidance: null,
      subtasks: null,
      reason: "Persistent compilation errors with no recovery attempts.",
    },
  };
  const parsed = MonitorCheckpointResultSchema.parse(input);
  const recommendation = parseMonitorRecommendation(parsed.recommendation);
  expect(recommendation.kind).toBe("recommend_abort");
});

test("MonitorCheckpointResultSchema accepts nullable non-applicable fields for Responses API compatibility", () => {
  const input = {
    assessment: "off_track",
    reasoning: "Worker gathered enough evidence but did not finalize.",
    recommendation: {
      kind: "recommend_enter_synthesizing",
      guidance: null,
      subtasks: null,
      reason: null,
    },
  };
  const parsed = MonitorCheckpointResultSchema.parse(input);
  expect(parsed.recommendation.guidance).toBeNull();
  expect(parsed.recommendation.subtasks).toBeNull();
  expect(parsed.recommendation.reason).toBeNull();
});
