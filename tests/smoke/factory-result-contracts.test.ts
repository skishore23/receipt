import { expect, test } from "bun:test";

import {
  FACTORY_INVESTIGATION_TASK_RESULT_SCHEMA,
  FACTORY_INVESTIGATION_REPORT_SCHEMA,
  FACTORY_TASK_RESULT_SCHEMA,
  normalizeInvestigationReport,
  normalizeInvestigationSemanticResult,
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

test("factory result contracts: investigation reports preserve full conclusions", () => {
  const report = normalizeInvestigationReport({
    conclusion: [
      "Found five buckets.",
      "",
      "| Bucket | Created |",
      "| --- | --- |",
      "| cf-templates--1fzoen9o074n-us-east-1 | 2025-06-07T16:49:02+00:00 |",
      "| cf-templates--9aweqz1t8nk8-us-east-1 | 2024-09-26T12:40:17+00:00 |",
      "| cloudscore1 | 2024-11-04T19:00:58+00:00 |",
      "| cloudscoreradiusreport | 2024-11-19T18:39:27+00:00 |",
      "| lambdasam-3d3986c07d-us-east-1 | 2024-11-04T19:28:30+00:00 |",
    ].join("\n"),
    evidence: [],
    scriptsRun: [],
    disagreements: [],
    nextSteps: [],
  }, "fallback");
  expect(report.conclusion).toContain("| cloudscore1 | 2024-11-04T19:00:58+00:00 |");
  expect(report.conclusion).toContain("| lambdasam-3d3986c07d-us-east-1 | 2024-11-04T19:28:30+00:00 |");
  expect(report.conclusion).not.toContain("...");
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
    renderHint: "table",
    inlineBody: "| InstanceId | Name |\n|---|---|\n| i-123 | demo |",
  });
});

test("factory result contracts: presentation keeps full long inline bodies for the UI", () => {
  const longCell = "x".repeat(4300);
  const handoff = [
    "# Inventory",
    "",
    "| Bucket | Notes |",
    "| --- | --- |",
    `| demo-bucket | ${longCell} |`,
  ].join("\n");
  const presentation = normalizeTaskPresentationRecord({
    value: {
      kind: "inline",
      renderHint: "table",
      inlineBody: handoff,
      primaryArtifactLabels: [],
    },
    summary: "Listed buckets.",
    handoff,
    workerArtifacts: [],
  });
  expect(presentation.inlineBody).toContain(longCell);
  expect(presentation.inlineBody?.endsWith("...")).toBe(false);
});

test("factory result contracts: semantic investigation conclusions preserve full markdown tables", () => {
  const semantic = normalizeInvestigationSemanticResult({
    status: "answered",
    conclusion: [
      "Found five buckets.",
      "",
      "| Bucket | Created |",
      "| --- | --- |",
      "| cf-templates--1fzoen9o074n-us-east-1 | 2025-06-07T16:49:02+00:00 |",
      "| cf-templates--9aweqz1t8nk8-us-east-1 | 2024-09-26T12:40:17+00:00 |",
      "| cloudscore1 | 2024-11-04T19:00:58+00:00 |",
      "| cloudscoreradiusreport | 2024-11-19T18:39:27+00:00 |",
      "| lambdasam-3d3986c07d-us-east-1 | 2024-11-04T19:28:30+00:00 |",
    ].join("\n"),
    findings: [],
    uncertainties: [],
    nextAction: null,
  });
  expect(semantic?.conclusion).toContain("| cloudscore1 | 2024-11-04T19:00:58+00:00 |");
  expect(semantic?.conclusion).toContain("| lambdasam-3d3986c07d-us-east-1 | 2024-11-04T19:28:30+00:00 |");
  expect(semantic?.conclusion).not.toContain("...");
});

test("factory result contracts: semantic investigation fields preserve full visible text", () => {
  const semantic = normalizeInvestigationSemanticResult({
    status: "answered",
    conclusion: "Found five buckets.",
    findings: [{
      title: "S3 bucket inventory captured successfully without truncation in the visible finding title",
      summary: "This finding summary stays intact in the UI even when it is much longer than the old clipping boundary and includes enough detail to be visually obvious if clipping ever comes back.",
      confidence: "confirmed",
      evidenceRefLabels: ["S3 bucket inventory markdown label that should remain fully visible"],
    }],
    uncertainties: [
      "This uncertainty should remain fully visible in the UI instead of being cut off midway through the sentence by a hard clipping boundary.",
    ],
    nextAction: "Review the full rendered objective handoff in chat and in the workbench without any clipping applied to the visible next action text.",
  });
  expect(semantic?.findings[0]?.title).toContain("without truncation");
  expect(semantic?.findings[0]?.summary).toContain("much longer than the old clipping boundary");
  expect(semantic?.findings[0]?.evidenceRefLabels[0]).toContain("should remain fully visible");
  expect(semantic?.uncertainties[0]).toContain("instead of being cut off");
  expect(semantic?.nextAction).toContain("without any clipping applied");
  expect(semantic?.findings[0]?.summary).not.toContain("...");
});

test("factory result contracts: investigation handoff preserves table rendering when the handoff body is already tabular", () => {
  const presentation = normalizeTaskPresentationRecord({
    value: undefined,
    summary: "Listed instances.",
    handoff: [
      "I found 2 instances.",
      "",
      "| InstanceId | Name | State |",
      "| --- | --- | --- |",
      "| i-123 | demo | running |",
    ].join("\n"),
    workerArtifacts: [{
      label: "inventory-markdown",
      path: "/tmp/inventory.md",
      summary: "Markdown table artifact.",
    }, {
      label: "inventory-json",
      path: "/tmp/inventory.json",
      summary: "Structured inventory output.",
    }],
    report: {
      conclusion: "I found 2 instances.",
      evidence: [],
      scriptsRun: [],
      disagreements: [],
      nextSteps: [],
    },
  });
  expect(presentation).toEqual({
    kind: "investigation_report",
    renderHint: "table",
    inlineBody: [
      "I found 2 instances.",
      "",
      "| InstanceId | Name | State |",
      "| --- | --- | --- |",
      "| i-123 | demo | running |",
    ].join("\n"),
    primaryArtifactLabels: ["inventory-markdown", "inventory-json"],
  });
});

test("factory result contracts: markdown inventory artifacts infer table rendering even when the handoff is prose", () => {
  const presentation = normalizeTaskPresentationRecord({
    value: undefined,
    summary: "Found five buckets.",
    handoff: "Found five buckets and wrote the inventory artifact.",
    workerArtifacts: [{
      label: "S3 bucket inventory",
      path: "/tmp/aws_s3_bucket_inventory.json",
      summary: "Structured bucket inventory.",
    }, {
      label: "S3 bucket inventory markdown",
      path: "/tmp/aws_s3_bucket_inventory.md",
      summary: "Markdown table artifact for the bucket inventory.",
    }],
    report: {
      conclusion: "Found five buckets.",
      evidence: [],
      scriptsRun: [],
      disagreements: [],
      nextSteps: [],
    },
  });
  expect(presentation).toEqual({
    kind: "investigation_report",
    renderHint: "table",
    inlineBody: "Found five buckets and wrote the inventory artifact.",
    primaryArtifactLabels: ["S3 bucket inventory markdown", "S3 bucket inventory"],
  });
});

test("factory result contracts: stale report presentation yields to tabular artifacts", () => {
  const presentation = normalizeTaskPresentationRecord({
    value: {
      kind: "investigation_report",
      renderHint: "report",
      inlineBody: "Found five buckets and wrote the inventory artifact.",
      primaryArtifactLabels: ["S3 bucket inventory", "S3 bucket inventory markdown"],
    },
    summary: "Found five buckets.",
    handoff: "Found five buckets and wrote the inventory artifact.",
    workerArtifacts: [{
      label: "S3 bucket inventory",
      path: "/tmp/aws_s3_bucket_inventory.json",
      summary: "Structured bucket inventory.",
    }, {
      label: "S3 bucket inventory markdown",
      path: "/tmp/aws_s3_bucket_inventory.md",
      summary: "Markdown table artifact for the bucket inventory.",
    }],
    report: {
      conclusion: "Found five buckets.",
      evidence: [],
      scriptsRun: [],
      disagreements: [],
      nextSteps: [],
    },
  });
  expect(presentation).toEqual({
    kind: "investigation_report",
    renderHint: "table",
    inlineBody: "Found five buckets and wrote the inventory artifact.",
    primaryArtifactLabels: ["S3 bucket inventory markdown", "S3 bucket inventory"],
  });
});
