import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveFactoryTaskWorkerResult } from "../../src/services/factory/worker-results";

test("factory worker results: result.json wins over last-message for the final structured task result", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-worker-results-"));
  const resultPath = path.join(root, "task.result.json");
  const lastMessagePath = path.join(root, "task.last-message.md");

  await fs.writeFile(lastMessagePath, JSON.stringify({
    summary: "stale summary",
    presentation: {
      kind: "inline",
      renderHint: "generic",
      inlineBody: "stale body",
      primaryArtifactLabels: null,
    },
  }), "utf-8");
  await fs.writeFile(resultPath, JSON.stringify({
    summary: "fresh summary",
    presentation: {
      kind: "inline",
      renderHint: "generic",
      inlineBody: "fresh body",
      primaryArtifactLabels: null,
    },
  }), "utf-8");

  const resolved = await resolveFactoryTaskWorkerResult({
    resultPath,
    lastMessagePath,
  }, {});

  expect(resolved.summary).toBe("fresh summary");
  expect(resolved.presentation).toEqual({
    kind: "inline",
    renderHint: "generic",
    inlineBody: "fresh body",
    primaryArtifactLabels: null,
  });
});
