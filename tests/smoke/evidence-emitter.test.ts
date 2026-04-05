import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { buildEvidenceRecord, writeEvidenceArtifacts } from "../../src/evidence/emitter";

const tempDir = async (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), "receipt-evidence-"));

test("evidence emitter writes success, failure, and no-op artifacts", async () => {
  const root = await tempDir();
  const success = await writeEvidenceArtifacts({
    workspacePath: root,
    checkResults: [{ command: "bun run build", ok: true, exitCode: 0, stdout: "ok", stderr: "", startedAt: 1, finishedAt: 2 }],
  });
  const failure = await writeEvidenceArtifacts({
    workspacePath: path.join(root, "failure"),
    checkResults: [{ command: "bun run build", ok: false, exitCode: 1, stdout: "", stderr: "boom", startedAt: 3, finishedAt: 4 }],
  });
  const noop = await writeEvidenceArtifacts({
    workspacePath: path.join(root, "noop"),
    checkResults: [],
  });
  await expect(fs.readFile(success.evidencePath, "utf-8")).resolves.toContain("\"verdict\": \"passed\"");
  await expect(fs.readFile(failure.executionSignalsPath, "utf-8")).resolves.toContain("\"status\": \"error\"");
  await expect(fs.readFile(noop.evidencePath, "utf-8")).resolves.toContain("\"verdict\": \"not_run\"");
});

test("evidence emitter keeps ordered commands and artifact paths", () => {
  const record = buildEvidenceRecord({
    checkResults: [{ command: "cmd", ok: true, exitCode: 0, stdout: "x", stderr: "y", startedAt: 1, finishedAt: 2 }],
    artifactPaths: ["/tmp/a", "/tmp/a", "/tmp/b"],
  });
  expect(record.orderedCommands[0]?.command).toBe("cmd");
  expect(record.artifactPaths).toEqual(["/tmp/a", "/tmp/b"]);
});
