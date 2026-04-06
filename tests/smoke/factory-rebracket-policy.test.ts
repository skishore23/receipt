import { expect, test } from "bun:test";

import { initialFactoryState } from "../../src/modules/factory";
import { selectFactoryRebracketEffect } from "../../src/services/factory/rebracket-policy";
import type { FactoryObjectivePlannerFacts, FactoryPlannerEffect } from "../../src/services/factory/effects";

const createState = () => ({
  ...initialFactoryState,
  objectiveId: "objective_test",
  title: "Test objective",
  prompt: "Exercise rebracket scoring.",
  workflow: {
    ...initialFactoryState.workflow,
    objectiveId: "objective_test",
    taskIds: ["task_01", "task_02", "task_03"],
    tasksById: {
      task_01: {
        nodeId: "task_01",
        taskId: "task_01",
        taskKind: "planned" as const,
        title: "First task",
        prompt: "Do the first thing.",
        workerType: "codex" as const,
        status: "ready" as const,
        dependsOn: [],
        baseCommit: "abc123",
        skillBundlePaths: [],
        contextRefs: [],
        createdAt: 1,
      },
      task_02: {
        nodeId: "task_02",
        taskId: "task_02",
        taskKind: "planned" as const,
        title: "Second task",
        prompt: "Do the second thing.",
        workerType: "codex" as const,
        status: "ready" as const,
        dependsOn: [],
        baseCommit: "abc123",
        skillBundlePaths: [],
        contextRefs: [],
        createdAt: 2,
      },
      task_03: {
        nodeId: "task_03",
        taskId: "task_03",
        taskKind: "planned" as const,
        title: "Third task",
        prompt: "Do the third thing.",
        workerType: "codex" as const,
        status: "approved" as const,
        dependsOn: [],
        baseCommit: "abc123",
        skillBundlePaths: [],
        contextRefs: [],
        createdAt: 3,
      },
    },
  },
});

const createFacts = (): FactoryObjectivePlannerFacts => ({
  latestObjectiveOperatorNote: undefined,
  taskReworkBlocks: [],
  dispatchCapacity: 1,
  policyBlockedReason: undefined,
  readyToPromoteBlockedReason: undefined,
  hasInvestigationReports: false,
  investigationSynthesisSummary: undefined,
});

test("factory rebracket policy prefers dispatch candidates over later final actions", () => {
  const state = createState();
  const facts = createFacts();
  const effects: ReadonlyArray<FactoryPlannerEffect> = [
    { type: "objective.complete", summary: "Everything is already complete." },
    { type: "task.dispatch", taskId: "task_01" },
    { type: "integration.queue", candidateId: "task_03_candidate_01", taskId: "task_03" },
  ];

  const selected = selectFactoryRebracketEffect({ state, facts, effects });

  expect(selected).toBeTruthy();
  expect(selected?.actionId).toBe("dispatch_task_01");
  expect(selected?.reason).toBe("Dispatch ready task task_01.");
  expect(selected?.scored.find((entry) => entry.candidate.id === "dispatch_task_01")?.score.a_dispatch_priority).toBe(1);
  expect(selected?.scored.find((entry) => entry.candidate.id === "complete_objective")?.score.a_dispatch_priority).toBe(0);
});

test("factory rebracket policy preserves workflow order across multiple dispatch candidates", () => {
  const state = createState();
  const facts = createFacts();
  const effects: ReadonlyArray<FactoryPlannerEffect> = [
    { type: "task.dispatch", taskId: "task_02" },
    { type: "task.dispatch", taskId: "task_01" },
  ];

  const selected = selectFactoryRebracketEffect({ state, facts, effects });

  expect(selected).toBeTruthy();
  expect(selected?.actionId).toBe("dispatch_task_01");
  expect(selected?.reason).toBe("Dispatch ready task task_01.");
});
