import { expect, test } from "bun:test";

import type { QueueJob } from "../../src/adapters/jsonl-queue";
import {
  initialFactoryState,
  normalizeFactoryState,
  type FactoryState,
} from "../../src/modules/factory";
import { deriveObjectiveOperationalState } from "../../src/services/factory/objective-status";

const makeState = (overrides: Partial<FactoryState> = {}): FactoryState => normalizeFactoryState({
  ...initialFactoryState,
  objectiveId: "objective_demo",
  title: "Demo objective",
  prompt: "Implement the objective.",
  status: "executing",
  scheduler: {
    ...initialFactoryState.scheduler,
    slotState: "active",
  },
  workflow: {
    ...initialFactoryState.workflow,
    objectiveId: "objective_demo",
    taskIds: ["task_01"],
    tasksById: {
      task_01: {
        nodeId: "task_01",
        taskId: "task_01",
        taskKind: "planned",
        title: "Demo task",
        prompt: "Implement the task.",
        workerType: "codex",
        baseCommit: "base1234",
        dependsOn: [],
        status: "running",
        skillBundlePaths: [],
        contextRefs: [],
        artifactRefs: {},
        createdAt: 1,
      },
    },
  },
  ...overrides,
} as FactoryState);

const makeJob = (
  kind: string,
  overrides: Partial<QueueJob> = {},
): QueueJob => ({
  id: `job_${kind.replace(/[^a-z0-9]+/gi, "_")}`,
  agentId: kind === "factory.objective.control" ? "factory-control" : "codex",
  lane: "collect",
  sessionKey: "factory:objective:objective_demo",
  singletonMode: "allow",
  status: "running",
  attempt: 1,
  maxAttempts: 1,
  createdAt: 1,
  updatedAt: 2,
  payload: {
    kind,
    objectiveId: "objective_demo",
    taskId: "task_01",
    candidateId: "candidate_01",
    reason: kind === "factory.objective.control" ? "reconcile" : undefined,
  },
  commands: [],
  ...overrides,
}) as QueueJob;

test("factory objective status: queued planning objectives stay queued without live execution", () => {
  const state = makeState({
    status: "planning",
    scheduler: {
      ...initialFactoryState.scheduler,
      slotState: "queued",
      queuePosition: 12,
    },
  });

  expect(deriveObjectiveOperationalState({
    state,
    taskCount: 1,
    objectiveJobs: [],
  })).toEqual({
    displayState: "Queued",
    phaseDetail: "queued",
    statusAuthority: "objective",
    hasAuthoritativeLiveJob: false,
  });
});

test("factory objective status: task execution stays running with executing phase detail", () => {
  expect(deriveObjectiveOperationalState({
    state: makeState({
      status: "executing",
    }),
    taskCount: 1,
    objectiveJobs: [makeJob("factory.task.run")],
  })).toEqual({
    displayState: "Running",
    phaseDetail: "executing",
    statusAuthority: "live_execution",
    hasAuthoritativeLiveJob: true,
  });
});

test("factory objective status: integration validation stays running with integrating phase detail", () => {
  expect(deriveObjectiveOperationalState({
    state: makeState({
      status: "integrating",
      integration: {
        ...initialFactoryState.integration,
        status: "validating",
      },
    }),
    taskCount: 1,
    objectiveJobs: [makeJob("factory.integration.validate")],
  })).toEqual({
    displayState: "Running",
    phaseDetail: "integrating",
    statusAuthority: "live_execution",
    hasAuthoritativeLiveJob: true,
  });
});

test("factory objective status: publish execution stays running with promoting phase detail", () => {
  expect(deriveObjectiveOperationalState({
    state: makeState({
      status: "promoting",
      integration: {
        ...initialFactoryState.integration,
        status: "promoting",
      },
    }),
    taskCount: 1,
    objectiveJobs: [makeJob("factory.integration.publish", { status: "leased" })],
  })).toEqual({
    displayState: "Running",
    phaseDetail: "promoting",
    statusAuthority: "live_execution",
    hasAuthoritativeLiveJob: true,
  });
});

test("factory objective status: control-only recovery shows reconciling instead of normal execution", () => {
  expect(deriveObjectiveOperationalState({
    state: makeState({
      status: "promoting",
      integration: {
        ...initialFactoryState.integration,
        status: "promoting",
      },
    }),
    taskCount: 1,
    objectiveJobs: [
      makeJob("factory.integration.publish", {
        status: "failed",
        lastError: "lease expired",
      }),
      makeJob("factory.objective.control"),
    ],
  })).toEqual({
    displayState: "Running",
    phaseDetail: "reconciling",
    statusAuthority: "reconcile",
    hasAuthoritativeLiveJob: false,
  });
});

test("factory objective status: reconcile-worthy publish failures without a live controller surface as stalled", () => {
  expect(deriveObjectiveOperationalState({
    state: makeState({
      status: "promoting",
      integration: {
        ...initialFactoryState.integration,
        status: "promoting",
      },
    }),
    taskCount: 1,
    objectiveJobs: [makeJob("factory.integration.publish", {
      status: "failed",
      lastError: "lease expired",
    })],
  })).toEqual({
    displayState: "Stalled",
    phaseDetail: "stalled",
    statusAuthority: "objective",
    hasAuthoritativeLiveJob: false,
  });
});

test("factory objective status: canceled monitor recovery does not override an active task run", () => {
  expect(deriveObjectiveOperationalState({
    state: makeState({
      status: "executing",
    }),
    taskCount: 1,
    objectiveJobs: [
      makeJob("factory.task.run", {
        status: "running",
      }),
      makeJob("factory.task.monitor", {
        id: "job_factory_task_monitor_recovered",
        status: "canceled",
        canceledReason: "stale active objective job reconciled during startup recovery",
      }),
    ],
  })).toEqual({
    displayState: "Running",
    phaseDetail: "executing",
    statusAuthority: "live_execution",
    hasAuthoritativeLiveJob: true,
  });
});

test("factory objective status: terminal objectives with lingering non-audit jobs show cleanup detail", () => {
  expect(deriveObjectiveOperationalState({
    state: makeState({
      status: "completed",
    }),
    taskCount: 1,
    objectiveJobs: [makeJob("factory.integration.publish")],
  })).toEqual({
    displayState: "Completed",
    phaseDetail: "cleaning_up",
    statusAuthority: "cleanup",
    hasAuthoritativeLiveJob: false,
  });
});

test("factory objective status: audit jobs never make a terminal objective look active", () => {
  expect(deriveObjectiveOperationalState({
    state: makeState({
      status: "completed",
    }),
    taskCount: 1,
    objectiveJobs: [makeJob("factory.objective.audit")],
  })).toEqual({
    displayState: "Completed",
    phaseDetail: "completed",
    statusAuthority: "objective",
    hasAuthoritativeLiveJob: false,
  });
});
