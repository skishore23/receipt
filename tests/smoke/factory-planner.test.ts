import { expect, test } from "bun:test";

import {
  DEFAULT_FACTORY_OBJECTIVE_POLICY,
  DEFAULT_FACTORY_OBJECTIVE_PROFILE,
  initialFactoryState,
  reduceFactory,
  type FactoryEvent,
} from "../../src/modules/factory";
import { planObjectiveReact, planTaskResult } from "../../src/services/factory/planner";

const applyEvents = (events: ReadonlyArray<FactoryEvent>) =>
  events.reduce(reduceFactory, initialFactoryState);

test("factory planner: approved dirty delivery stays on the normal review path", () => {
  const effects = planTaskResult({
    taskId: "task_01",
    candidateId: "task_01_candidate_01",
    outcome: "approved",
    workspaceDirty: true,
    hasFailedCheck: false,
    candidate: {
      headCommit: "abc1234",
      summary: "Implemented the delivery change.",
      handoff: "Ready for review.",
      completion: {
        changed: ["Implemented the delivery change."],
        proof: ["bun run build passed."],
        remaining: [],
      },
      checkResults: [],
      artifactRefs: {},
      producedAt: 5,
    },
    review: {
      status: "approved",
      summary: "Implemented the delivery change.",
      handoff: "Ready for review.",
      reviewedAt: 5,
    },
  });

  expect(effects.map((effect) => effect.type)).toEqual([
    "candidate.produce",
    "task.review.request",
    "candidate.review",
  ]);
});

test("factory planner: approved clean delivery emits an explicit noop completion", () => {
  const effects = planTaskResult({
    taskId: "task_01",
    candidateId: "task_01_candidate_01",
    outcome: "approved",
    workspaceDirty: false,
    hasFailedCheck: false,
    candidate: {
      headCommit: "abc1234",
      summary: "Validation passed with the existing repository state.",
      handoff: "No repository diff was required.",
      completion: {
        changed: ["Confirmed the existing state already matches the objective."],
        proof: ["git status --short stayed clean."],
        remaining: [],
      },
      checkResults: [],
      artifactRefs: {},
      producedAt: 7,
    },
    review: {
      status: "approved",
      summary: "Validation passed with the existing repository state.",
      handoff: "No repository diff was required.",
      reviewedAt: 7,
    },
  });

  expect(effects.map((effect) => effect.type)).toEqual([
    "candidate.produce",
    "task.review.request",
    "candidate.review",
    "task.noop_complete",
  ]);
});

test("factory planner: blocked and delivery-partial outcomes stay blocked-only", () => {
  const blocked = planTaskResult({
    taskId: "task_01",
    candidateId: "task_01_candidate_01",
    outcome: "blocked",
    workspaceDirty: false,
    hasFailedCheck: false,
    blockedReason: "Need operator guidance before proceeding.",
    candidate: {
      headCommit: "abc1234",
      summary: "Blocked.",
      handoff: "Need operator guidance before proceeding.",
      completion: {
        changed: [],
        proof: [],
        remaining: ["Clarify the missing requirement."],
      },
      checkResults: [],
      artifactRefs: {},
      producedAt: 9,
    },
    review: {
      status: "changes_requested",
      summary: "Blocked.",
      handoff: "Need operator guidance before proceeding.",
      reviewedAt: 9,
    },
  });
  const partial = planTaskResult({
    taskId: "task_01",
    candidateId: "task_01_candidate_01",
    outcome: "partial",
    workspaceDirty: false,
    hasFailedCheck: false,
    blockedReason: "The delivery task only gathered partial evidence.",
    candidate: {
      headCommit: "abc1234",
      summary: "Partial.",
      handoff: "The delivery task only gathered partial evidence.",
      completion: {
        changed: [],
        proof: [],
        remaining: ["Complete the missing implementation."],
      },
      checkResults: [],
      artifactRefs: {},
      producedAt: 10,
    },
    review: {
      status: "changes_requested",
      summary: "Partial.",
      handoff: "The delivery task only gathered partial evidence.",
      reviewedAt: 10,
    },
  });

  expect(blocked.map((effect) => effect.type)).toEqual(["task.block"]);
  expect(partial.map((effect) => effect.type)).toEqual(["task.block"]);
});

test("factory planner: capped rework is blocked immediately after review", () => {
  const effects = planTaskResult({
    taskId: "task_01",
    candidateId: "task_01_candidate_01",
    outcome: "changes_requested",
    workspaceDirty: true,
    hasFailedCheck: false,
    reworkBlockedReason: "Policy blocked: task_01 exhausted maxCandidatePassesPerTask (1/1).",
    candidate: {
      headCommit: "abc1234",
      summary: "Another pass is required.",
      handoff: "Run another pass.",
      completion: {
        changed: [],
        proof: ["Worker reported follow-up work."],
        remaining: ["Run another pass."],
      },
      checkResults: [],
      artifactRefs: {},
      producedAt: 11,
    },
    review: {
      status: "changes_requested",
      summary: "Another pass is required.",
      handoff: "Run another pass.",
      reviewedAt: 11,
    },
  });

  expect(effects.map((effect) => effect.type)).toEqual([
    "candidate.produce",
    "task.review.request",
    "candidate.review",
    "task.block",
  ]);
});

test("factory planner: latest operator note already present does not queue a duplicate follow-up task", () => {
  const state = applyEvents([{
    type: "objective.created",
    objectiveId: "objective_follow_up",
    title: "Follow-up objective",
    prompt: "Implement the requested delivery change.",
    channel: "results",
    baseHash: "abc1234",
    objectiveMode: "delivery",
    severity: 1,
    checks: [],
    checksSource: "default",
    profile: DEFAULT_FACTORY_OBJECTIVE_PROFILE,
    policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
    createdAt: 1,
  }, {
    type: "task.added",
    objectiveId: "objective_follow_up",
    createdAt: 2,
    task: {
      nodeId: "task_01",
      taskId: "task_01",
      taskKind: "planned",
      title: "Implement the requested delivery change",
      prompt: [
        "Implement the requested delivery change.",
        "",
        "Operator follow-up for this attempt:",
        "Use the CLI-first path.",
      ].join("\n"),
      workerType: "codex",
      baseCommit: "abc1234",
      dependsOn: [],
      status: "pending",
      skillBundlePaths: [],
      contextRefs: [],
      artifactRefs: {},
      createdAt: 2,
    },
  }]);

  const effects = planObjectiveReact({
    state,
    facts: {
      latestObjectiveOperatorNote: "Use the CLI-first path.",
      taskReworkBlocks: [],
      dispatchCapacity: 1,
      hasInvestigationReports: false,
    },
  });

  expect(effects.some((effect) => effect.type === "objective.queue_follow_up_task")).toBe(false);
});
