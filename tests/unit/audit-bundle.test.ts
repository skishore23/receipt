import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect } from "bun:test";

import { buildAuditBundle, emitAuditBundle } from "../../src/services/factory/audit-reporting/audit-bundle";

test("blocked runs still emit a populated audit bundle", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "audit-bundle-"));
  const bundle = buildAuditBundle({
    objectiveId: "objective_123",
    taskId: "task_123",
    regions: [{ name: "workspace", path: "/tmp/workspace", summary: "Task execution workspace." }],
    commandsRun: [{ command: "bun run build", summary: "Validation completed.", status: "ok" }],
    findings: [{ title: "Check passed", summary: "Build succeeded.", detail: "stdout captured" }],
    timestamps: { startedAt: 1, completedAt: 2 },
    alignment: {
      verdict: "aligned",
      satisfied: ["Mandatory artifacts emitted."],
      missing: [],
      outOfScope: [],
      rationale: "The run reported an explicit audit bundle.",
    },
    proof: ["/tmp/workspace/.receipt/factory/task_123.stdout.log"],
  });

  const bundlePath = await emitAuditBundle(bundle, dir);
  const written = JSON.parse(await readFile(bundlePath, "utf-8"));

  expect(written.alignment_reported).toBe(true);
  expect(written.alignment.satisfied.length).toBeGreaterThan(0);
  expect(written.scripts_run.length).toBeGreaterThan(0);
  expect(written.structured_evidence.length).toBeGreaterThan(0);
  expect(written.proof.length).toBeGreaterThan(0);
});
