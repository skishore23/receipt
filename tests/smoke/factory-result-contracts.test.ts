import { expect, test } from "bun:test";

import {
  FACTORY_INVESTIGATION_TASK_RESULT_SCHEMA,
  FACTORY_INVESTIGATION_REPORT_SCHEMA,
  FACTORY_TASK_RESULT_SCHEMA,
  normalizeInvestigationReport,
  normalizeTaskPresentationRecord,
} from "../../src/services/factory/result-contracts";

test("factory result contracts: investigation evidence records stay strict and nullable", () => {
  expect(FACTORY_INVESTIGATION_REPORT_SCHEMA.required).toContain("evidenceRecords");
  expect(FACTORY_INVESTIGATION_REPORT_SCHEMA.properties.evidenceRecords).toMatchObject({
    type: ["array", "null"],
  });
  const evidenceRecordItems = (
    FACTORY_INVESTIGATION_REPORT_SCHEMA.properties.evidenceRecords as {
      readonly items: {
        readonly properties: Record<string, unknown>;
      };
    }
  ).items;
  expect(evidenceRecordItems.properties.inputs).toEqual({
    type: "object",
    additionalProperties: { type: ["string", "number", "boolean", "null"] },
  });
});

test("factory result contracts: codex output schemas require handoff when the property is declared", () => {
  expect(FACTORY_TASK_RESULT_SCHEMA.required).toContain("handoff");
  expect(FACTORY_INVESTIGATION_TASK_RESULT_SCHEMA.required).toEqual([
    "status",
    "conclusion",
    "findings",
    "uncertainties",
    "nextAction",
  ]);
});

test("factory result contracts: investigation report normalizes strict object evidence records", () => {
  const report = normalizeInvestigationReport({
    conclusion: "done",
    evidence: [],
    evidenceRecords: [{
      objective_id: "objective_demo",
      task_id: "task_01",
      timestamp: 123,
      tool_name: "shell",
      command_or_api: "./slow-check.sh",
      inputs: { cwd: "/tmp/demo", timeout_sec: 30 },
      outputs: { stdout: "slow-check:end", success: true },
      summary_metrics: { regions_scanned: 1, instance_inventory: 0 },
    }],
    scriptsRun: [],
    disagreements: [],
    nextSteps: [],
  }, "fallback");
  expect(report.evidenceRecords).toEqual([{
    objective_id: "objective_demo",
    task_id: "task_01",
    timestamp: 123,
    tool_name: "shell",
    command_or_api: "./slow-check.sh",
    inputs: {
      cwd: "/tmp/demo",
      timeout_sec: 30,
    },
    outputs: {
      stdout: "slow-check:end",
      success: true,
    },
    summary_metrics: {
      regions_scanned: 1,
      instance_inventory: 0,
    },
  }]);
});

test("factory result contracts: investigation report rejects legacy array evidence record maps", () => {
  const report = normalizeInvestigationReport({
    conclusion: "done",
    evidence: [],
    evidenceRecords: [{
      objective_id: "objective_demo",
      task_id: "task_01",
      timestamp: 123,
      tool_name: "shell",
      command_or_api: "./slow-check.sh",
      inputs: [{ key: "cwd", value: "/tmp/demo" }],
      outputs: [{ key: "ok", value: true }],
      summary_metrics: [{ key: "regions_scanned", value: 1 }],
    }],
    scriptsRun: [],
    disagreements: [],
    nextSteps: [],
  }, "fallback");
  expect(report.evidenceRecords).toBeUndefined();
});

test("factory result contracts: normalizeTaskPresentationRecord accepts the new presentation payload", () => {
  const presentation = normalizeTaskPresentationRecord({
    value: {
      kind: "artifacts",
      renderHint: "table",
      inlineBody: null,
      primaryArtifactLabels: ["inventory-md", "inventory-json"],
    },
    summary: "Listed instances.",
    handoff: undefined,
    workerArtifacts: [],
  });
  expect(presentation).toEqual({
    kind: "artifacts",
    renderHint: "table",
    primaryArtifactLabels: ["inventory-md", "inventory-json"],
  });
});

test("factory result contracts: normalizeTaskPresentationRecord falls back to legacy handoff during migration", () => {
  const presentation = normalizeTaskPresentationRecord({
    value: undefined,
    summary: "Listed instances.",
    handoff: "| InstanceId | Name |\n|---|---|\n| i-123 | demo |",
    workerArtifacts: [],
  });
  expect(presentation).toEqual({
    kind: "inline",
    renderHint: "generic",
    inlineBody: "| InstanceId | Name |\n|---|---|\n| i-123 | demo |",
  });
});
