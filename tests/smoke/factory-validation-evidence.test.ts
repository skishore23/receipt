import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runFactoryChecks } from "../../src/services/factory/check-runner";
import { renderDeliveryResultText } from "../../src/services/factory/result-contracts";

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("factory validation evidence: passing validation writes structured evidence", async () => {
  const workspacePath = await createTempDir("receipt-validation-pass");
  const results = await runFactoryChecks({
    commands: ["printf 'validation ok\\n'"],
    workspacePath,
    dataDir: workspacePath,
    repoRoot: process.cwd(),
    worktreesDir: workspacePath,
  });
  expect(results).toHaveLength(1);
  const evidencePath = path.join(workspacePath, ".receipt", "factory", "validation_evidence.json");
  const evidence = JSON.parse(await fs.readFile(evidencePath, "utf-8")) as {
    readonly results: ReadonlyArray<{ readonly ok: boolean; readonly command: string; readonly assertions: ReadonlyArray<string> }>;
  };
  expect(evidence.results).toHaveLength(1);
  expect(evidence.results[0]?.ok).toBe(true);
  expect(evidence.results[0]?.command).toBe("printf 'validation ok\\n'");
  expect(evidence.results[0]?.assertions).toContain("check passed");
});

test("factory validation evidence: failing validation still writes structured evidence", async () => {
  const workspacePath = await createTempDir("receipt-validation-fail");
  const results = await runFactoryChecks({
    commands: ["false"],
    workspacePath,
    dataDir: workspacePath,
    repoRoot: process.cwd(),
    worktreesDir: workspacePath,
  });
  expect(results).toHaveLength(1);
  expect(results[0]?.ok).toBe(false);
  const evidencePath = path.join(workspacePath, ".receipt", "factory", "validation_evidence.json");
  const evidence = JSON.parse(await fs.readFile(evidencePath, "utf-8")) as {
    readonly results: ReadonlyArray<{ readonly ok: boolean; readonly command: string; readonly assertions: ReadonlyArray<string> }>;
  };
  expect(evidence.results).toHaveLength(1);
  expect(evidence.results[0]?.ok).toBe(false);
  expect(evidence.results[0]?.command).toBe("false");
  expect(evidence.results[0]?.assertions).toContain("check failed");
});

test("factory final report references validation evidence artifact", () => {
  const rendered = renderDeliveryResultText({
    summary: "Done.",
    handoff: "Handing off.",
    scriptsRun: [],
    completion: { changed: [], proof: [], remaining: [] },
    alignment: {
      verdict: "aligned",
      satisfied: ["Requested work completed."],
      missing: [],
      outOfScope: [],
      rationale: "Aligned.",
    },
    validationEvidence: {
      artifact: "/tmp/validation_evidence.json",
      results: [{
        command: "bun run build",
        exitCode: 0,
        ok: true,
        assertions: ["check passed", "exit code 0"],
      }],
    },
  });
  expect(rendered).toContain("Validation Evidence");
  expect(rendered).toContain("/tmp/validation_evidence.json");
  expect(rendered).toContain("bun run build");
});
