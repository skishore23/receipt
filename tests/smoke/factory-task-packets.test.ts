import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FactoryState, FactoryTaskRecord } from "../../src/modules/factory";
import {
  buildTaskFilePaths,
  buildTaskMemoryScopes,
  listTaskArtifactActivity,
  summarizeTaskArtifactActivity,
} from "../../src/services/factory/task-packets";

const tempDir = (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("factory task packets: task file paths stay under the packet directory", () => {
  const files = buildTaskFilePaths("/tmp/factory-workspace", "task_01");

  expect(files.manifestPath).toBe("/tmp/factory-workspace/.receipt/factory/task_01.manifest.json");
  expect(files.contextPackPath).toBe("/tmp/factory-workspace/.receipt/factory/task_01.context-pack.json");
  expect(files.memoryScriptPath).toBe("/tmp/factory-workspace/.receipt/factory/task_01.memory.cjs");
});

test("factory task packets: memory scopes use the effective task prompt override", () => {
  const state = {
    objectiveId: "objective_demo",
    title: "Refactor packet helpers",
  } as FactoryState;
  const task = {
    taskId: "task_01",
    title: "Extract packet helpers",
    prompt: "old prompt",
    workerType: "codex",
  } as FactoryTaskRecord;

  const scopes = buildTaskMemoryScopes(state, task, "task_01_candidate_01", "effective prompt");

  expect(scopes.map((scope) => scope.key)).toEqual([
    "agent",
    "repo",
    "objective",
    "task",
    "candidate",
    "integration",
  ]);
  expect(scopes[0]?.defaultQuery).toBe("Refactor packet helpers\nExtract packet helpers\neffective prompt");
  expect(scopes[4]?.scope).toBe("factory/objectives/objective_demo/candidates/task_01_candidate_01");
});

test("factory task packets: artifact activity ignores known files and summarizes extras", async () => {
  const workspacePath = await tempDir("receipt-factory-task-packets");
  const files = buildTaskFilePaths(workspacePath, "task_01");
  const packetDir = path.dirname(files.manifestPath);
  await fs.mkdir(packetDir, { recursive: true });

  await fs.writeFile(files.manifestPath, "{}", "utf-8");
  await fs.writeFile(files.resultPath, "{}", "utf-8");
  await fs.writeFile(path.join(packetDir, "task_01.notes.txt"), "notes", "utf-8");
  await fs.writeFile(path.join(packetDir, "task_01.evidence.json"), "{\"ok\":true}", "utf-8");
  await fs.writeFile(path.join(packetDir, "task_02.evidence.json"), "{\"skip\":true}", "utf-8");

  const newer = new Date("2024-01-01T00:00:02.000Z");
  const older = new Date("2024-01-01T00:00:01.000Z");
  await fs.utimes(path.join(packetDir, "task_01.notes.txt"), newer, newer);
  await fs.utimes(path.join(packetDir, "task_01.evidence.json"), older, older);

  const activity = await listTaskArtifactActivity(
    workspacePath,
    "task_01",
    (resultPath) => path.join(path.dirname(resultPath), "schema.json"),
  );

  expect(activity.map((artifact) => artifact.label)).toEqual([
    "task_01.notes.txt",
    "task_01.evidence.json",
  ]);
  expect(summarizeTaskArtifactActivity(activity)).toBe("Recent task artifacts: task_01.notes.txt, task_01.evidence.json.");
});
