import { expect, test } from "bun:test";

import {
  shouldQueueObjectiveAudit,
  shouldQueueObjectiveControlReconcile,
  shouldReconcileObjectiveFromJobChange,
} from "../../src/services/factory-job-gates";

type TestJobStatus = "canceled" | "completed" | "failed" | "leased" | "queued" | "running";

const makeJob = (input: {
  readonly agentId?: string;
  readonly createdAt?: number;
  readonly id: string;
  readonly objectiveId: string;
  readonly kind: "factory.objective.audit" | "factory.objective.control";
  readonly objectiveUpdatedAt?: number;
  readonly status: TestJobStatus;
  readonly updatedAt?: number;
}) => ({
  agentId: input.agentId ?? "factory-control",
  createdAt: input.createdAt ?? input.updatedAt ?? 0,
  id: input.id,
  payload: {
    kind: input.kind,
    objectiveId: input.objectiveId,
    ...(typeof input.objectiveUpdatedAt === "number"
      ? { objectiveUpdatedAt: input.objectiveUpdatedAt }
      : {}),
  },
  status: input.status,
  updatedAt: input.updatedAt ?? 0,
});

const makeRuntimeJob = (input: {
  readonly kind: "factory.task.monitor" | "factory.task.run" | "factory.integration.validate" | "factory.integration.publish";
  readonly lastError?: string;
  readonly objectiveId: string;
  readonly status: TestJobStatus;
}) => ({
  agentId: "codex",
  createdAt: 0,
  id: `${input.kind}:${input.objectiveId}:${input.status}`,
  payload: {
    kind: input.kind,
    objectiveId: input.objectiveId,
  },
  status: input.status,
  updatedAt: 0,
  lastError: input.lastError,
});

test("factory job gates: reconcile skips inactive objectives even when task failures arrive later", () => {
  const shouldQueue = shouldQueueObjectiveControlReconcile({
    controlAgentId: "factory-control",
    objectiveId: "objective_terminal",
    objectiveInactive: true,
    recentJobs: [
      makeJob({
        id: "job_control_old",
        kind: "factory.objective.control",
        objectiveId: "objective_terminal",
        status: "completed",
        updatedAt: 100,
      }),
    ],
    sourceUpdatedAt: 500,
  });

  expect(shouldQueue).toBe(false);
});

test("factory job gates: reconcile coalesces onto an already active control job", () => {
  const shouldQueue = shouldQueueObjectiveControlReconcile({
    controlAgentId: "factory-control",
    objectiveId: "objective_active",
    recentJobs: [
      makeJob({
        id: "job_control_running",
        kind: "factory.objective.control",
        objectiveId: "objective_active",
        status: "running",
        updatedAt: 400,
      }),
    ],
    sourceUpdatedAt: 500,
  });

  expect(shouldQueue).toBe(false);
});

test("factory job gates: reconcile queues a fresh control pass when the last one is stale", () => {
  const shouldQueue = shouldQueueObjectiveControlReconcile({
    controlAgentId: "factory-control",
    objectiveId: "objective_retry",
    recentJobs: [
      makeJob({
        id: "job_control_old",
        kind: "factory.objective.control",
        objectiveId: "objective_retry",
        status: "failed",
        updatedAt: 100,
      }),
    ],
    sourceUpdatedAt: 500,
  });

  expect(shouldQueue).toBe(true);
});

test("factory job gates: monitor failures trigger objective reconcile", () => {
  expect(shouldReconcileObjectiveFromJobChange(makeRuntimeJob({
    kind: "factory.task.monitor",
    objectiveId: "objective_monitor",
    status: "failed",
  }))).toBe(true);
});

test("factory job gates: integration failures trigger objective reconcile", () => {
  expect(shouldReconcileObjectiveFromJobChange(makeRuntimeJob({
    kind: "factory.integration.validate",
    objectiveId: "objective_validate",
    status: "failed",
  }))).toBe(true);

  expect(shouldReconcileObjectiveFromJobChange(makeRuntimeJob({
    kind: "factory.integration.publish",
    objectiveId: "objective_publish",
    status: "canceled",
  }))).toBe(true);
});

test("factory job gates: queued lease expiry on active stages still triggers objective reconcile", () => {
  expect(shouldReconcileObjectiveFromJobChange(makeRuntimeJob({
    kind: "factory.task.run",
    objectiveId: "objective_retry",
    status: "queued",
    lastError: "lease expired",
  }))).toBe(true);

  expect(shouldReconcileObjectiveFromJobChange(makeRuntimeJob({
    kind: "factory.integration.publish",
    objectiveId: "objective_retry_publish",
    status: "queued",
    lastError: "lease expired",
  }))).toBe(true);

  expect(shouldReconcileObjectiveFromJobChange(makeRuntimeJob({
    kind: "factory.task.run",
    objectiveId: "objective_retry",
    status: "running",
    lastError: "lease expired",
  }))).toBe(false);
});

test("factory job gates: audit waits for active audit jobs and only reruns for newer objective state", () => {
  expect(shouldQueueObjectiveAudit({
    controlAgentId: "factory-control",
    objectiveId: "objective_audit",
    objectiveUpdatedAt: 500,
    recentJobs: [
      makeJob({
        id: "job_audit_running",
        kind: "factory.objective.audit",
        objectiveId: "objective_audit",
        objectiveUpdatedAt: 450,
        status: "running",
        updatedAt: 480,
      }),
    ],
  })).toBe(false);

  expect(shouldQueueObjectiveAudit({
    controlAgentId: "factory-control",
    objectiveId: "objective_audit",
    objectiveUpdatedAt: 500,
    recentJobs: [
      makeJob({
        id: "job_audit_current",
        kind: "factory.objective.audit",
        objectiveId: "objective_audit",
        objectiveUpdatedAt: 500,
        status: "completed",
        updatedAt: 490,
      }),
    ],
  })).toBe(false);

  expect(shouldQueueObjectiveAudit({
    controlAgentId: "factory-control",
    objectiveId: "objective_audit",
    objectiveUpdatedAt: 500,
    recentJobs: [
      makeJob({
        id: "job_audit_old",
        kind: "factory.objective.audit",
        objectiveId: "objective_audit",
        objectiveUpdatedAt: 300,
        status: "completed",
        updatedAt: 350,
      }),
    ],
  })).toBe(true);
});
