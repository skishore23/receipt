import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateImprovementProposal } from "../../src/engine/runtime/improvement-harness.ts";

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("improvement harness passes proposal context to validation commands", async () => {
  const dir = await mkTmp("receipt-improvement-harness");
  const output = path.join(dir, "captured.json");
  const originalCmd = process.env.IMPROVEMENT_VALIDATE_CMD;

  process.env.IMPROVEMENT_VALIDATE_CMD = [
    "node",
    "-e",
    JSON.stringify(
      `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ artifactType: process.env.IMPROVEMENT_ARTIFACT_TYPE, target: process.env.IMPROVEMENT_TARGET, patch: process.env.IMPROVEMENT_PATCH }))`
    ),
  ].join(" ");

  try {
    const patch = JSON.stringify({ system: "patched", user: { loop: "loop" } });
    const result = await evaluateImprovementProposal({
      artifactType: "prompt_patch",
      target: "prompts/axiom.prompts.json",
      patch,
      cwd: dir,
    });

    assert.equal(result.status, "passed");
    const captured = JSON.parse(await fs.readFile(output, "utf-8")) as Record<string, string>;
    assert.equal(captured.artifactType, "prompt_patch");
    assert.equal(captured.target, "prompts/axiom.prompts.json");
    assert.equal(captured.patch, patch);
  } finally {
    if (originalCmd === undefined) delete process.env.IMPROVEMENT_VALIDATE_CMD;
    else process.env.IMPROVEMENT_VALIDATE_CMD = originalCmd;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
