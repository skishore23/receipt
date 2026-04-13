import { expect, test } from "bun:test";

import type { QueueJob } from "../../src/adapters/sqlite-queue";
import { summarizeLocalRuntimeHealth, type LocalRuntimeWorkerState } from "../../src/server/local-runtime-health";

const makeJob = (input: Partial<QueueJob> & Pick<QueueJob, "id" | "agentId" | "lane" | "payload" | "status" | "attempt" | "maxAttempts" | "createdAt" | "updatedAt" | "commands">): QueueJob => ({
  ...input,
  sessionKey: input.sessionKey,
  singletonMode: input.singletonMode,
  result: input.result,
  leaseOwner: input.leaseOwner,
  leaseUntil: input.leaseUntil,
  lastError: input.lastError,
  canceledReason: input.canceledReason,
  abortRequested: input.abortRequested ?? false,
});

const healthyWorkers = (now: number): ReadonlyArray<LocalRuntimeWorkerState> => ([
  { role: "chat", workerId: "worker:chat", concurrency: 10, startedAt: now - 5_000, lastTickAt: now - 500 },
  { role: "agent", workerId: "worker:agent", concurrency: 4, startedAt: now - 5_000, lastTickAt: now - 500 },
  { role: "factory", workerId: "worker:factory", concurrency: 10, startedAt: now - 5_000, lastTickAt: now - 500 },
]);

test("local runtime health: ready snapshot reports workers, queue age, and no degradation", () => {
  const now = 1_000_000;
  const summary = summarizeLocalRuntimeHealth({
    now,
    jobs: [
      makeJob({
        id: "job_task",
        agentId: "codex",
        lane: "collect",
        payload: { kind: "factory.task.run", objectiveId: "objective_demo" },
        status: "queued",
        attempt: 0,
        maxAttempts: 2,
        createdAt: now - 10_000,
        updatedAt: now - 5_000,
        commands: [],
      }),
    ],
    workers: healthyWorkers(now),
    lastResumeAt: now - 1_000,
    staleAfterMs: 90_000,
    workerStaleAfterMs: 30_000,
  });

  expect(summary.ready).toBe(true);
  expect(summary.degraded).toBe(false);
  expect(summary.checks.workers.ok).toBe(true);
  expect(summary.checks.queueWatchdog.ok).toBe(true);
  expect(summary.oldestQueuedMsByLane.collect).toBe(5_000);
  expect(summary.stalledObjectives).toBe(0);
  expect(summary.workers.readyRoles).toEqual(["chat", "agent", "factory"]);
});

test("local runtime health: stale queued factory work without a healthy factory worker is degraded", () => {
  const now = 2_000_000;
  const summary = summarizeLocalRuntimeHealth({
    now,
    jobs: [
      makeJob({
        id: "job_stale_codex",
        agentId: "codex",
        lane: "collect",
        payload: { kind: "factory.task.run", objectiveId: "objective_stalled" },
        status: "queued",
        attempt: 0,
        maxAttempts: 2,
        createdAt: now - 200_000,
        updatedAt: now - 150_000,
        commands: [],
      }),
    ],
    workers: [
      { role: "chat", workerId: "worker:chat", concurrency: 10, startedAt: now - 5_000, lastTickAt: now - 500 },
      { role: "agent", workerId: "worker:agent", concurrency: 4, startedAt: now - 5_000, lastTickAt: now - 500 },
      { role: "factory", workerId: "worker:factory", concurrency: 10, startedAt: now - 200_000, lastTickAt: now - 150_000 },
    ],
    lastResumeAt: now - 1_000,
    staleAfterMs: 90_000,
    workerStaleAfterMs: 30_000,
  });

  expect(summary.ready).toBe(false);
  expect(summary.degraded).toBe(true);
  expect(summary.checks.workers.ok).toBe(false);
  expect(summary.checks.queueWatchdog.ok).toBe(false);
  expect(summary.stalledObjectives).toBe(1);
  expect(summary.watchdog.warnings[0]).toContain("job_stale_codex");
  expect(summary.watchdog.warnings[0]).toContain("factory");
});
