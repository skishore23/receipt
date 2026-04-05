import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { buildEvidenceBundle, writeAlignmentMarkdown } from "../../src/services/factory-evidence-bundle";

test("builds a minimally populated evidence bundle", async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-evidence-"));
  const commandsPath = path.join(dir, "commands_run.jsonl");
  const artifactPath = path.join(dir, "stdout.log");
  await fs.writeFile(commandsPath, JSON.stringify({ command: "bun run build", summary: "build ok", status: "ok" }) + "\n", "utf-8");
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
    commandsRunPath: commandsPath,
    artifactPaths: [{ label: "stdout", path: artifactPath }],
    links: ["https://example.com/evidence"],
    createdAt: 1,
    updatedAt: 2,
  });
  expect(bundle.commands_run).toHaveLength(1);
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
