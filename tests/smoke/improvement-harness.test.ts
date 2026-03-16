import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

    expect(result.status).toBe("passed");
    const captured = JSON.parse(await fs.readFile(output, "utf-8")) as Record<string, string>;
    expect(captured.artifactType).toBe("prompt_patch");
    expect(captured.target).toBe("prompts/axiom.prompts.json");
    expect(captured.patch).toBe(patch);
  } finally {
    if (originalCmd === undefined) delete process.env.IMPROVEMENT_VALIDATE_CMD;
    else process.env.IMPROVEMENT_VALIDATE_CMD = originalCmd;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
