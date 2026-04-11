import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildEvidenceBundle,
  investigationEvidenceBundlePath,
  readInvestigationEvidenceBundle,
  writeAlignmentMarkdown,
  writeInvestigationEvidenceBundle,
} from "../../src/services/factory-evidence-bundle";

test("builds a minimally populated evidence bundle", async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-evidence-"));
  const artifactPath = path.join(dir, "stdout.log");
  await fs.writeFile(artifactPath, "artifact output", "utf-8");
  const bundle = await buildEvidenceBundle({
    objectiveId: "objective_1",
    taskId: "task_1",
    candidateId: "candidate_1",
    planSummary: "deliver evidence bundle",
    alignment: {
      verdict: "aligned",
      satisfied: ["bundle emitted"],
      missing: [],
      outOfScope: [],
      rationale: "bundle is present",
    },
    completion: {
      changed: ["src/services/factory-evidence-bundle.ts"],
      proof: ["tests/smoke/evidence-bundle.test.ts"],
      remaining: [],
    },
    scriptsRun: [{ command: "bun run build", summary: "build ok", status: "ok" }],
    artifactPaths: [{ label: "stdout", path: artifactPath }],
    links: ["https://example.com/evidence"],
    createdAt: 1,
    updatedAt: 2,
  });
  expect(bundle.scripts_run).toHaveLength(1);
  expect(bundle.artifacts[0]?.summary).toContain("artifact output");
  expect(bundle.timestamps.created_at).toBe(1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("writes alignment markdown", async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-align-"));
  const alignmentPath = await writeAlignmentMarkdown({
    rootDir: dir,
    goal: "emit evidence",
    constraints: ["keep scope tight"],
    definitionOfDone: ["bundle exists"],
    assumptions: ["command logs may be absent"],
  });
  const text = await fs.readFile(alignmentPath, "utf-8");
  expect(text).toContain("# Alignment");
  expect(text).toContain("emit evidence");
  await fs.rm(dir, { recursive: true, force: true });
});

test("writes and reads a canonical investigation evidence bundle", async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-investigation-evidence-"));
  const resultPath = path.join(dir, "task_01.result.json");
  const artifactPath = path.join(dir, "helper.json");
  await fs.writeFile(artifactPath, "{\"ok\":true}\n", "utf-8");
  const bundlePath = investigationEvidenceBundlePath(resultPath);

  await writeInvestigationEvidenceBundle({
    bundlePath,
    objectiveId: "objective_1",
    taskId: "task_1",
    candidateId: "candidate_1",
    report: {
      conclusion: "done",
      evidence: [],
      evidenceRecords: [{
        objective_id: "objective_1",
        task_id: "task_1",
        timestamp: 123,
        tool_name: "factory_helper_runner",
        command_or_api: "python3 runner.py run helper",
        inputs: { helper_id: "demo" },
        outputs: { status: "ok" },
        summary_metrics: { resources: 1 },
      }],
      scriptsRun: [{ command: "python3 runner.py run helper", summary: "helper", status: "ok" }],
      disagreements: [],
      nextSteps: [],
    },
    artifactPaths: [{ label: "helper output", path: artifactPath }],
    createdAt: 1,
    updatedAt: 2,
  });

  const bundle = await readInvestigationEvidenceBundle(bundlePath);
  expect(bundle.evidence_records).toHaveLength(1);
  expect(bundle.scripts_run).toHaveLength(1);
  expect(bundle.artifacts[0]?.summary).toContain("\"ok\":true");
  await fs.rm(dir, { recursive: true, force: true });
});
