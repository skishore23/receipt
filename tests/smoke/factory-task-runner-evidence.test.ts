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

test("factory task runner evidence: successful delivery requires proof, scriptsRun, and alignment", () => {
  expect(validateTaskEvidence({
    objectiveId: "objective_demo",
    taskId: "task_01",
    objectiveMode: "delivery",
    outcome: "approved",
    completion: {
      changed: ["README.md"],
      proof: [],
      remaining: [],
    },
    scriptsRun: [{ command: "bun run build", summary: "build", status: "ok" }],
    hasAlignment: true,
    reportIncludesEvidenceRecords: false,
  })).toContain("proof items");

  expect(validateTaskEvidence({
    objectiveId: "objective_demo",
    taskId: "task_01",
    objectiveMode: "delivery",
    outcome: "approved",
    completion: {
      changed: ["README.md"],
      proof: ["bun run build passed"],
      remaining: [],
    },
    scriptsRun: [],
    hasAlignment: true,
    reportIncludesEvidenceRecords: false,
  })).toContain("scriptsRun");

  expect(validateTaskEvidence({
    objectiveId: "objective_demo",
    taskId: "task_01",
    objectiveMode: "delivery",
    outcome: "approved",
    completion: {
      changed: ["README.md"],
      proof: ["bun run build passed"],
      remaining: [],
    },
    scriptsRun: [{ command: "bun run build", summary: "build", status: "ok" }],
    hasAlignment: false,
    reportIncludesEvidenceRecords: false,
  })).toContain("alignment");
});

test("factory task runner evidence: successful investigation can complete with proof plus scripts or a structured report", () => {
  expect(validateTaskEvidence({
    objectiveId: "objective_demo",
    taskId: "task_01",
    objectiveMode: "investigation",
    outcome: "approved",
    completion: {
      changed: ["Collected evidence"],
      proof: ["aws sts get-caller-identity"],
      remaining: [],
    },
    scriptsRun: [{ command: "aws sts get-caller-identity", summary: "identity", status: "ok" }],
    hasStructuredReport: false,
    reportIncludesEvidenceRecords: false,
  })).toBeUndefined();

  expect(validateTaskEvidence({
    objectiveId: "objective_demo",
    taskId: "task_01",
    objectiveMode: "investigation",
    outcome: "approved",
    completion: {
      changed: ["Collected evidence"],
      proof: ["aws sts get-caller-identity"],
      remaining: [],
    },
    scriptsRun: [],
    hasStructuredReport: true,
    reportIncludesEvidenceRecords: false,
  })).toBeUndefined();

  expect(validateTaskEvidence({
    objectiveId: "objective_demo",
    taskId: "task_01",
    objectiveMode: "investigation",
    outcome: "approved",
    completion: {
      changed: ["Collected evidence"],
      proof: ["artifact-backed claim"],
      remaining: [],
    },
    scriptsRun: [],
    hasStructuredReport: false,
    reportIncludesEvidenceRecords: false,
  })).toContain("investigation proof or scripts");
});

test("factory task runner evidence: infrastructure investigations can require scriptsRun and structured evidence", () => {
  expect(validateTaskEvidence({
    objectiveId: "objective_demo",
    taskId: "task_01",
    objectiveMode: "investigation",
    outcome: "approved",
    completion: {
      changed: ["Collected evidence"],
      proof: ["artifact-backed claim"],
      remaining: [],
    },
    scriptsRun: [],
    hasStructuredReport: true,
    reportIncludesEvidenceRecords: true,
    reportEvidenceRecords: [{
      objective_id: "objective_demo",
      task_id: "task_01",
      timestamp: 123,
      tool_name: "factory_helper_runner",
      command_or_api: "python3 skills/factory-helper-runtime/runner.py run helper",
      inputs: {},
      outputs: {},
      summary_metrics: {},
    }],
    requireInvestigationScriptsRun: true,
    requireStructuredEvidenceRecords: true,
  })).toContain("scriptsRun");

  expect(validateTaskEvidence({
    objectiveId: "objective_demo",
    taskId: "task_01",
    objectiveMode: "investigation",
    outcome: "approved",
    completion: {
      changed: ["Collected evidence"],
      proof: ["artifact-backed claim"],
      remaining: [],
    },
    scriptsRun: [{ command: "python3 skills/factory-helper-runtime/runner.py run helper", summary: "helper", status: "ok" }],
    hasStructuredReport: true,
    reportIncludesEvidenceRecords: false,
    reportEvidenceRecords: [],
    requireInvestigationScriptsRun: true,
    requireStructuredEvidenceRecords: true,
  })).toContain("structured evidence records");

  expect(validateTaskEvidence({
    objectiveId: "objective_demo",
    taskId: "task_01",
    objectiveMode: "investigation",
    outcome: "approved",
    completion: {
      changed: ["Collected evidence"],
      proof: ["artifact-backed claim"],
      remaining: [],
    },
    scriptsRun: [{ command: "python3 skills/factory-helper-runtime/runner.py run helper", summary: "helper", status: "ok" }],
    hasStructuredReport: true,
    reportIncludesEvidenceRecords: true,
    reportEvidenceRecords: [{
      objective_id: "objective_demo",
      task_id: "task_01",
      timestamp: 123,
      tool_name: "factory_helper_runner",
      command_or_api: "python3 skills/factory-helper-runtime/runner.py run helper",
      inputs: {},
      outputs: {},
      summary_metrics: {},
    }],
    requireInvestigationScriptsRun: true,
    requireStructuredEvidenceRecords: true,
  })).toBeUndefined();
});
