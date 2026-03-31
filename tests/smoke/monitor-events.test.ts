import { test, expect } from "bun:test";
import { reduceFactory } from "../../src/modules/factory/reducer";
import type { FactoryState } from "../../src/modules/factory/types";
import type { FactoryEvent } from "../../src/modules/factory/events";

const makeMinimalState = (): FactoryState => ({
  objectiveId: "obj_1",
  title: "test",
  prompt: "test",
  channel: "test",
  baseHash: "abc123",
  objectiveMode: "delivery",
  severity: 1,
  checks: [],
  checksSource: "default",
  profile: {
    rootProfileId: "default",
    rootProfileLabel: "Default",
    resolvedProfileHash: "hash",
    promptHash: "phash",
    promptPath: "/tmp/prompt",
    selectedSkills: [],
    objectivePolicy: {
      allowedWorkerTypes: ["codex"],
      defaultWorkerType: "codex",
      defaultTaskExecutionMode: "worktree",
      defaultValidationMode: "none",
      defaultObjectiveMode: "delivery",
      defaultSeverity: 1,
      maxParallelChildren: 10,
      allowObjectiveCreation: false,
    },
  },
  policy: {
    concurrency: { maxActiveTasks: 20 },
    budgets: { maxTaskRuns: 50, maxCandidatePassesPerTask: 4, maxObjectiveMinutes: 120 },
    throttles: { maxDispatchesPerReact: 10 },
    promotion: { autoPromote: false },
  },
  status: "executing",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  taskRunsUsed: 0,
  candidatePassesByTask: {},
  consecutiveFailuresByTask: {},
  candidates: {},
  candidateOrder: [],
  workflow: {
    objectiveId: "obj_1",
    status: "active",
    activeTaskIds: ["task_1"],
    taskIds: ["task_1"],
    tasksById: {
      task_1: {
        nodeId: "task_1",
        taskId: "task_1",
        taskKind: "planned",
        title: "Big task",
        prompt: "Do something big",
        workerType: "codex",
        dependsOn: [],
        status: "running",
        baseCommit: "abc123",
        skillBundlePaths: [],
        contextRefs: [],
        artifactRefs: {},
        createdAt: Date.now(),
      },
    },
    updatedAt: Date.now(),
  },
  integration: {
    status: "idle",
    queuedCandidateIds: [],
    validationResults: [],
    updatedAt: Date.now(),
  },
  scheduler: {},
  investigation: { reports: {}, reportOrder: [] },
});

test("monitor.checkpoint event is reduced without error", () => {
  const state = makeMinimalState();
  const event: FactoryEvent = {
    type: "monitor.checkpoint",
    objectiveId: "obj_1",
    taskId: "task_1",
    jobId: "job_monitor_1",
    checkpoint: 1,
    assessment: "progressing",
    reasoning: "Worker is actively editing files",
    action: { kind: "continue" },
    evaluatedAt: Date.now(),
  };
  const next = reduceFactory(state, event);
  expect(next.updatedAt).toBeGreaterThanOrEqual(event.evaluatedAt);
});

test("monitor.intervention event is reduced without error", () => {
  const state = makeMinimalState();
  const event: FactoryEvent = {
    type: "monitor.intervention",
    objectiveId: "obj_1",
    taskId: "task_1",
    jobId: "job_monitor_1",
    interventionKind: "split",
    detail: "Task is too large, splitting into 3 subtasks",
    interventionAt: Date.now(),
  };
  const next = reduceFactory(state, event);
  expect(next.updatedAt).toBeGreaterThanOrEqual(event.interventionAt);
});

test("task.added with splitDepth preserves the field", () => {
  const state = makeMinimalState();
  const event: FactoryEvent = {
    type: "task.added",
    objectiveId: "obj_1",
    task: {
      nodeId: "task_2",
      taskId: "task_2",
      taskKind: "planned",
      title: "Subtask 1",
      prompt: "Do part 1",
      workerType: "codex",
      dependsOn: [],
      status: "pending",
      baseCommit: "abc123",
      splitDepth: 1,
      sourceTaskId: "task_1",
      skillBundlePaths: [],
      contextRefs: [],
      artifactRefs: {},
      createdAt: Date.now(),
    },
    createdAt: Date.now(),
  };
  const next = reduceFactory(state, event);
  expect(next.workflow.tasksById.task_2.splitDepth).toBe(1);
});
