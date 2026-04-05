import { expect, test } from "bun:test";

import {
  ensureTaskEvidenceEnvelope,
  normalizeExecutionSignal,
} from "../../src/services/factory/result-contracts";

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
