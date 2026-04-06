import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRuntime } from "@receipt/core/runtime";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { jsonlQueue } from "../../src/adapters/jsonl-queue";
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

const createJobRuntime = (dataDir: string) =>
  createRuntime<JobCmd, JobEvent, JobState>(
    jsonlStore<JobEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideJob,
    reduceJob,
    initialJob,
  );

test("jsonl queue bootstrap refresh does not replay historical jobs through onJobChange", async () => {
  const dataDir = await createTempDir("receipt-jsonl-queue-bootstrap");
  const seedQueue = jsonlQueue({
    runtime: createJobRuntime(dataDir),
    stream: "jobs",
  });

  const queuedChat = await seedQueue.enqueue({
    agentId: "factory",
    lane: "chat",
    maxAttempts: 1,
    payload: {
      kind: "factory.run",
      stream: "agents/factory/test",
      runId: "run_seed_chat",
      problem: "seed queued chat",
    },
  });

  const completedControl = await seedQueue.enqueue({
    agentId: "factory-control",
    lane: "collect",
    maxAttempts: 1,
    payload: {
      kind: "factory.objective.control",
      objectiveId: "objective_seed",
      reason: "startup",
    },
  });
  await seedQueue.leaseJob(completedControl.id, "seed-worker", 30_000);
  await seedQueue.complete(completedControl.id, "seed-worker", {
    status: "completed",
  });

  const observed: string[] = [];
  const refreshedQueue = jsonlQueue({
    runtime: createJobRuntime(dataDir),
    stream: "jobs",
    watchDir: dataDir,
    expireLeasesOnRefresh: true,
    onJobChange: async (jobs) => {
      observed.push(...jobs.map((job) => `${job.id}:${job.status}`));
    },
  });

  await refreshedQueue.refresh();
  expect(observed).toEqual([]);

  const leased = await refreshedQueue.leaseNext({
    workerId: "worker-chat",
    leaseMs: 30_000,
    agentIds: ["factory"],
    lanes: ["chat"],
  });

  expect(leased?.id).toBe(queuedChat.id);
  expect(observed).toEqual([`${queuedChat.id}:leased`]);
});
