import { expect, test } from "bun:test";

import { validateTaskEvidence } from "../../src/services/factory/runtime/task-runner";

test("factory task runner evidence: empty structured evidence records do not block investigation handoff", () => {
  expect(validateTaskEvidence({
    objectiveId: "objective_demo",
    taskId: "task_01",
    reportIncludesEvidenceRecords: true,
    reportEvidenceRecords: [],
  })).toBeUndefined();
});

test("factory task runner evidence: generic evidence metrics do not require AWS inventory keys", () => {
  expect(validateTaskEvidence({
    objectiveId: "objective_demo",
    taskId: "task_01",
    reportIncludesEvidenceRecords: true,
    reportEvidenceRecords: [{
      objective_id: "objective_demo",
      task_id: "task_01",
      timestamp: 123,
      tool_name: "shell",
      command_or_api: "./slow-check.sh",
      inputs: { cwd: "/tmp/demo" },
      outputs: { stdout: "ok" },
      summary_metrics: { readme_lines: 3 },
    }],
  })).toBeUndefined();
});
