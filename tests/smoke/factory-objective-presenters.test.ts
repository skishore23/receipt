import { expect, test } from "bun:test";

import type { QueueJob } from "../../src/adapters/jsonl-queue";
import type { FactoryEvent, FactoryState, FactoryTaskRecord } from "../../src/modules/factory";
import {
  buildBlockedExplanation,
  buildObjectiveActivity,
  buildObjectiveEvidenceCards,
  summarizeObjectiveReceipts,
} from "../../src/services/factory/objective-presenters";
import type { FactoryTaskView } from "../../src/services/factory-types";

test("factory objective presenters: summarized receipts skip control receipts and keep task refs", () => {
  const chain = [
    {
      body: { type: "run.started", runId: "run_demo", agentId: "codex", agentVersion: "1", runtimePolicyVersion: "policy" } as unknown as FactoryEvent,
      hash: "hash_control",
      ts: 1,
    },
    {
      body: { type: "task.blocked", objectiveId: "objective_demo", taskId: "task_01", reason: "blocked", blockedAt: 2 } as unknown as FactoryEvent,
      hash: "hash_task",
      ts: 2,
    },
  ];

  const receipts = summarizeObjectiveReceipts(chain, {
    summarizeReceipt: (event) => event.type,
    receiptTaskOrCandidateId: (event) => ("taskId" in event ? { taskId: event.taskId } : {}),
  });

  expect(receipts).toEqual([
    {
      type: "task.blocked",
      hash: "hash_task",
      ts: 2,
      summary: "task.blocked",
      taskId: "task_01",
      candidateId: undefined,
    },
  ]);
});

test("factory objective presenters: blocked explanation includes the matched receipt and waiting dependents", () => {
  const blockedTask = {
    taskId: "task_01",
    status: "blocked",
    dependsOn: [],
  } as FactoryTaskRecord;
  const waitingTask = {
    taskId: "task_02",
    status: "pending",
    dependsOn: ["task_01"],
  } as FactoryTaskRecord;
  const state = {
    blockedReason: "Needs operator input.",
    status: "blocked",
    integration: { status: "idle" },
    workflow: {
      taskIds: ["task_01", "task_02"],
      tasksById: {
        task_01: blockedTask,
        task_02: waitingTask,
      },
    },
  } as FactoryState;

  const explanation = buildBlockedExplanation(state, [
    {
      type: "task.blocked",
      hash: "hash_task",
      ts: 5,
      summary: "task_01 blocked: Needs operator input.",
      taskId: "task_01",
    },
  ]);

  expect(explanation).toEqual({
    summary: "task_01 blocked: Needs operator input. Waiting tasks: task_02 depends on task_01.",
    taskId: "task_01",
    candidateId: undefined,
    receiptType: "task.blocked",
    receiptHash: "hash_task",
  });
});

test("factory objective presenters: evidence cards and activity stay ordered by newest signals", () => {
  const receipts = [
    {
      type: "rebracket.applied",
      hash: "hash_decision",
      ts: 10,
      summary: "Dispatched task_01.",
      taskId: "task_01",
    },
    {
      type: "integration.promoted",
      hash: "hash_promotion",
      ts: 30,
      summary: "Promoted candidate.",
      candidateId: "task_01_candidate_01",
    },
  ];
  const tasks = [
    {
      taskId: "task_01",
      title: "Ship it",
      status: "approved",
      createdAt: 1,
      completedAt: 20,
      candidateId: "task_01_candidate_01",
    } as FactoryTaskView,
  ];
  const jobs = [
    {
      id: "job_demo",
      agentId: "codex",
      status: "running",
      updatedAt: 25,
      payload: { taskId: "task_01", candidateId: "task_01_candidate_01" },
    } as QueueJob,
  ];

  const evidence = buildObjectiveEvidenceCards(receipts);
  const activity = buildObjectiveActivity(tasks, jobs, receipts);

  expect(evidence.map((card) => card.kind)).toEqual(["decision", "promotion"]);
  expect(activity[0]?.kind).toBe("receipt");
  expect(activity[0]?.title).toBe("integration.promoted");
  expect(activity[1]?.kind).toBe("job");
  expect(activity[2]?.kind).toBe("task");
});
