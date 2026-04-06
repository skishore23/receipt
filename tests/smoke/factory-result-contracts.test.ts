import { expect, test } from "bun:test";

import {
  FACTORY_INVESTIGATION_REPORT_SCHEMA,
  normalizeInvestigationReport,
} from "../../src/services/factory/result-contracts";

test("factory result contracts: investigation evidence records use strict map entries for structured output", () => {
  expect(FACTORY_INVESTIGATION_REPORT_SCHEMA.required).toContain("evidenceRecords");
  const evidenceRecordItems = (
    FACTORY_INVESTIGATION_REPORT_SCHEMA.properties.evidenceRecords as {
      readonly items: {
        readonly properties: Record<string, unknown>;
      };
    }
  ).items;
  expect(evidenceRecordItems.properties.inputs).toEqual({
    type: "array",
    items: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: ["string", "number", "boolean", "null"] },
      },
      required: ["key", "value"],
      additionalProperties: false,
    },
  });
});

test("factory result contracts: investigation report normalizes evidence record maps from strict entries", () => {
  const report = normalizeInvestigationReport({
    conclusion: "done",
    evidence: [],
    evidenceRecords: [{
      objective_id: "objective_demo",
      task_id: "task_01",
      timestamp: 123,
      tool_name: "shell",
      command_or_api: "./slow-check.sh",
      inputs: [
        { key: "cwd", value: "/tmp/demo" },
        { key: "timeout_sec", value: 30 },
      ],
      outputs: [
        { key: "stdout", value: "slow-check:end" },
        { key: "success", value: true },
      ],
      summary_metrics: [
        { key: "regions_scanned", value: 1 },
        { key: "instance_inventory", value: 0 },
      ],
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

test("factory result contracts: investigation report still accepts legacy object evidence record maps", () => {
  const report = normalizeInvestigationReport({
    conclusion: "done",
    evidence: [],
    evidenceRecords: [{
      objective_id: "objective_demo",
      task_id: "task_01",
      timestamp: 123,
      tool_name: "shell",
      command_or_api: "./slow-check.sh",
      inputs: { cwd: "/tmp/demo" },
      outputs: { ok: true },
      summary_metrics: { regions_scanned: 1, instance_inventory: 0 },
    }],
    scriptsRun: [],
    disagreements: [],
    nextSteps: [],
  }, "fallback");
  expect(report.evidenceRecords?.[0]?.inputs).toEqual({ cwd: "/tmp/demo" });
  expect(report.evidenceRecords?.[0]?.outputs).toEqual({ ok: true });
  expect(report.evidenceRecords?.[0]?.summary_metrics).toEqual({
    regions_scanned: 1,
    instance_inventory: 0,
  });
});
