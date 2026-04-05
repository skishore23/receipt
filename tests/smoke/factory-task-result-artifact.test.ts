import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect } from "bun:test";

import { FACTORY_TASK_RESULT_SCHEMA } from "../../src/services/factory/result-contracts";
import { resolveFactoryTaskWorkerResult } from "../../src/services/factory/worker-results";

test("factory task result schema requires structuredEvidence for completed results", async () => {
  expect(FACTORY_TASK_RESULT_SCHEMA.required).toContain("structuredEvidence");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-task-result-"));
  const resultPath = path.join(tmpDir, "task.result.json");
  await fs.writeFile(resultPath, JSON.stringify({
    status: "completed",
    summary: "done",
    handoff: "done",
    artifacts: [],
    scriptsRun: [{
      command: "bun run build",
      summary: "passed",
      status: "ok",
    }],
    completion: {
      changed: [],
      proof: ["build passed"],
      remaining: [],
    },
    alignment: {
      verdict: "aligned",
      satisfied: ["Proof recorded"],
      missing: [],
      outOfScope: [],
      rationale: "Completed task included an explicit alignment block.",
    },
    nextAction: null,
  }), "utf-8");

  await expect(resolveFactoryTaskWorkerResult({
    lastMessagePath: resultPath,
    resultPath,
  }, {})).rejects.toThrow("completed factory task result missing structuredEvidence");
});
