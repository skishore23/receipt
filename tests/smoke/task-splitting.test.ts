import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { jsonlQueue } from "../../src/adapters/jsonl-queue";
import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { createRuntime } from "@receipt/core/runtime";
import { SseHub } from "../../src/framework/sse-hub";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";
import { FactoryService } from "../../src/services/factory-service";

const execFileAsync = promisify(execFile);

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], { cwd, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
};

const createSourceRepo = async (): Promise<string> => {
  const repoDir = await createTempDir("receipt-task-splitting-source");
  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.name", "Task Splitting Test"]);
  await git(repoDir, ["config", "user.email", "task-splitting@example.com"]);
  await fs.writeFile(path.join(repoDir, "README.md"), "# task splitting test\n", "utf-8");
  await git(repoDir, ["add", "README.md"]);
  await git(repoDir, ["commit", "-m", "initial commit"]);
  await git(repoDir, ["branch", "-M", "main"]);
  return repoDir;
};

const createJobRuntime = (dataDir: string) =>
  createRuntime<JobCmd, JobEvent, JobState>(
    jsonlStore<JobEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideJob,
    reduceJob,
    initialJob,
  );

test("splitTask supersedes parent and creates subtasks with correct splitDepth", async () => {
  const dataDir = await createTempDir("receipt-task-splitting");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime: createJobRuntime(dataDir),
    sse: new SseHub(),
    codexExecutor: {
      run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    },
    repoRoot,
  });

  const objective = await service.createObjective({
    title: "Big refactoring task",
    prompt: "Refactor the entire auth system",
  });

  // Run startup to create initial task
  await service.runObjectiveControl({
    kind: "factory.objective.control",
    objectiveId: objective.objectiveId,
    reason: "startup",
  });

  const state = await service.getObjectiveState(objective.objectiveId);
  expect(state.workflow.taskIds.length).toBeGreaterThanOrEqual(1);
  const parentTaskId = state.workflow.taskIds[0];

  // Call splitTask
  await service.splitTask(objective.objectiveId, parentTaskId, [
    { title: "Refactor auth types", prompt: "Extract and refactor auth type definitions" },
    { title: "Refactor auth middleware", prompt: "Update auth middleware to use new types", dependsOn: ["0"] },
    { title: "Update auth tests", prompt: "Fix and extend auth tests", dependsOn: ["1"] },
  ]);

  const afterState = await service.getObjectiveState(objective.objectiveId);

  // Parent should be superseded
  const parentAfter = afterState.workflow.tasksById[parentTaskId];
  expect(parentAfter.status).toBe("superseded");

  // Should have 3 new tasks
  const newTasks = afterState.workflow.taskIds
    .map((id) => afterState.workflow.tasksById[id])
    .filter((t) => t.taskId !== parentTaskId);
  expect(newTasks.length).toBe(3);

  // All new tasks should have splitDepth = 1
  for (const task of newTasks) {
    expect(task.splitDepth).toBe(1);
    expect(task.sourceTaskId).toBe(parentTaskId);
  }

  // Second task should depend on first new task
  const secondTask = newTasks[1];
  expect(secondTask.dependsOn.length).toBe(1);
});

test("splitTask at depth 2 is the maximum", async () => {
  const dataDir = await createTempDir("receipt-task-splitting-depth");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime: createJobRuntime(dataDir),
    sse: new SseHub(),
    codexExecutor: {
      run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    },
    repoRoot,
  });

  const objective = await service.createObjective({
    title: "Deep split test",
    prompt: "Test deep splitting",
  });

  await service.runObjectiveControl({
    kind: "factory.objective.control",
    objectiveId: objective.objectiveId,
    reason: "startup",
  });

  const state = await service.getObjectiveState(objective.objectiveId);
  const parentTaskId = state.workflow.taskIds[0];

  // First split (depth 0 -> 1)
  await service.splitTask(objective.objectiveId, parentTaskId, [
    { title: "Sub A", prompt: "Do A" },
    { title: "Sub B", prompt: "Do B" },
  ]);

  const afterFirst = await service.getObjectiveState(objective.objectiveId);
  const firstSubTaskId = afterFirst.workflow.taskIds
    .map((id) => afterFirst.workflow.tasksById[id])
    .find((t) => (t.splitDepth ?? 0) === 1)!.taskId;

  // Second split (depth 1 -> 2)
  await service.splitTask(objective.objectiveId, firstSubTaskId, [
    { title: "Sub A.1", prompt: "Do A.1" },
    { title: "Sub A.2", prompt: "Do A.2" },
  ]);

  const afterSecond = await service.getObjectiveState(objective.objectiveId);
  const depth2Tasks = afterSecond.workflow.taskIds
    .map((id) => afterSecond.workflow.tasksById[id])
    .filter((t) => (t.splitDepth ?? 0) === 2);
  expect(depth2Tasks.length).toBe(2);

  // Third split (depth 2 -> 3) should throw
  const depth2TaskId = depth2Tasks[0].taskId;
  await expect(
    service.splitTask(objective.objectiveId, depth2TaskId, [
      { title: "Too deep A", prompt: "This should fail" },
      { title: "Too deep B", prompt: "This should fail" },
    ])
  ).rejects.toThrow(/maximum split depth/i);
});
