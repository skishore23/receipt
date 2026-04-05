import { expect, test } from "bun:test";

import {
  ensureTaskEvidenceEnvelope,
  normalizeExecutionSignal,
} from "../../src/services/factory/result-contracts";
import { initialFactoryState, reduceFactory } from "../../src/modules/factory";

test("factory evidence contract: execution signal defaults remain explicit when no scripts ran", () => {
  expect(normalizeExecutionSignal(undefined)).toEqual({
    missingScriptsRun: false,
    scriptsAttempted: [],
  });
});

test("factory evidence contract: completion is blocked when no evidence artifacts or structured results exist", () => {
  expect(() => ensureTaskEvidenceEnvelope({
    objectiveId: "objective_1",
    taskId: "task_1",
    candidateId: "candidate_1",
    evidence: {
      objectiveId: "objective_1",
      taskId: "task_1",
      candidateId: "candidate_1",
      timestamp: 1,
      inputs: {},
      actions: [],
      artifacts: [],
      results: {},
      checks: [],
      errors: [],
    },
  })).toThrow("factory task task_1 cannot complete without evidence artifacts or structured results");
});

test("factory evidence contract: alignment events are accepted by the factory reducer", () => {
  const state = initialFactoryState({
    objectiveId: "objective_1",
    title: "Objective",
    prompt: "Prompt",
    channel: "factory",
    baseHash: "base",
    objectiveMode: "delivery",
    severity: 1,
    checks: [],
    profile: {
      rootProfileId: "generalist",
      rootProfileLabel: "Tech Lead",
      resolvedProfileHash: "hash",
      promptHash: "prompt",
      promptPath: "profiles/generalist/PROFILE.md",
      selectedSkills: [],
      objectivePolicy: {
        allowedWorkerTypes: ["codex"],
        defaultWorkerType: "codex",
        defaultTaskExecutionMode: "worktree",
        defaultValidationMode: "repo_profile",
        defaultObjectiveMode: "delivery",
        defaultSeverity: 1,
        maxParallelChildren: 1,
        allowObjectiveCreation: true,
      },
    },
    policy: {},
    createdAt: 1,
  });

  const next = reduceFactory(state, {
    type: "task.alignment",
    objectiveId: "objective_1",
    taskId: "task_1",
    candidateId: "candidate_1",
    alignment: {
      status: "aligned",
      rationale: "structured evidence recorded",
      evidenceRefs: ["result.json"],
    },
    recordedAt: 2,
  });

  expect(next.updatedAt).toBe(2);
});
