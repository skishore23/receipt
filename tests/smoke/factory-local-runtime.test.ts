import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRuntime } from "@receipt/core/runtime";

import { sqliteBranchStore, sqliteReceiptStore } from "../../src/adapters/sqlite";
import { sqliteQueue } from "../../src/adapters/sqlite-queue";
import {
  createFactoryLocalWorker,
  startFactoryLocalRuntime,
} from "../../src/services/factory-local-runtime";
import {
  decide as decideJob,
  initial as initialJob,
  reduce as reduceJob,
  type JobCmd,
  type JobEvent,
  type JobState,
} from "../../src/modules/job";

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("factory local runtime: shared worker services factory-control and codex jobs with one worker id", async () => {
  const dataDir = await createTempDir("receipt-factory-local-runtime");
  const jobRuntime = createRuntime<JobCmd, JobEvent, JobState>(
    sqliteReceiptStore<JobEvent>(dataDir),
    sqliteBranchStore(dataDir),
    decideJob,
    reduceJob,
    initialJob,
  );
  const queue = sqliteQueue({
    runtime: jobRuntime,
    stream: "jobs",
  });
  const seenWorkerIds: string[] = [];
  const handlers = {
    "factory-control": async (_job, ctx) => {
      seenWorkerIds.push(`control:${ctx.workerId}`);
      return { ok: true, result: { status: "completed" } };
    },
    "factory-monitor": async (_job, ctx) => {
      seenWorkerIds.push(`monitor:${ctx.workerId}`);
      return { ok: true, result: { status: "completed" } };
    },
    codex: async (_job, ctx) => {
      seenWorkerIds.push(`codex:${ctx.workerId}`);
      return { ok: true, result: { status: "completed" } };
    },
  } as const;
  const worker = createFactoryLocalWorker({
    queue,
    handlers,
    workerId: "worker:factory",
    idleResyncMs: 1_000,
    leaseMs: 30_000,
    concurrency: 2,
    scope: "test",
  });
  let resumeCalls = 0;

  try {
    await startFactoryLocalRuntime({
      worker,
      service: {
        resumeObjectives: async () => {
          resumeCalls += 1;
        },
      },
    });

    const [controlJob, codexJob] = await Promise.all([
      queue.enqueue({
        agentId: "factory-control",
        lane: "collect",
        payload: {
          kind: "factory.objective.control",
          objectiveId: "objective_demo",
          reason: "startup",
        },
        maxAttempts: 1,
      }),
      queue.enqueue({
        agentId: "codex",
        lane: "collect",
        payload: {
          kind: "factory.task.run",
          objectiveId: "objective_demo",
          taskId: "task_01",
          candidateId: "task_01_candidate_01",
        },
        maxAttempts: 1,
      }),
    ]);

    const completed = await Promise.all([
      queue.waitForJob(controlJob.id, 5_000, 50),
      queue.waitForJob(codexJob.id, 5_000, 50),
    ]);

    expect(resumeCalls).toBe(1);
    expect(completed[0]?.status).toBe("completed");
    expect(completed[1]?.status).toBe("completed");
    expect(seenWorkerIds.sort()).toEqual([
      "codex:worker:factory",
      "control:worker:factory",
    ]);
  } finally {
    worker.stop();
  }
}, 15_000);
