import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import { jsonlQueue } from "../../src/adapters/jsonl-queue.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job.ts";

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("jsonl queue: lease/retry/wait lifecycle", async () => {
  const dir = await mkTmp("receipt-queue");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = jsonlQueue({ runtime, stream: "jobs" });
    const job = await queue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r1" },
      maxAttempts: 2,
    });
    const jobChain = await runtime.chain(`jobs/${job.id}`);
    assert.equal(jobChain.length > 0, true, "per-job stream should contain lifecycle receipts");

    const lease1 = await queue.leaseNext({ workerId: "w1", leaseMs: 5_000 });
    assert.ok(lease1, "expected first lease");
    assert.equal(lease1?.id, job.id);
    assert.equal(lease1?.attempt, 1);

    const duplicate = await queue.leaseNext({ workerId: "w2", leaseMs: 5_000 });
    assert.equal(duplicate, undefined, "should not double-lease same queued item");

    await queue.fail(job.id, "w1", "transient");
    const afterFail = await queue.getJob(job.id);
    assert.equal(afterFail?.status, "queued");

    const lease2 = await queue.leaseNext({ workerId: "w2", leaseMs: 5_000 });
    assert.ok(lease2, "expected retry lease");
    assert.equal(lease2?.attempt, 2);

    await queue.complete(job.id, "w2", { ok: true });
    const settled = await queue.waitForJob(job.id, 1_000, 25);
    assert.equal(settled?.status, "completed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: steer/follow-up/abort command lanes", async () => {
  const dir = await mkTmp("receipt-queue-cmd");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = jsonlQueue({ runtime, stream: "jobs" });
    const job = await queue.enqueue({
      agentId: "theorem",
      payload: { kind: "theorem.run", runId: "r2" },
      maxAttempts: 1,
    });

    const steer = await queue.queueCommand({
      jobId: job.id,
      command: "steer",
      payload: { config: { rounds: 1 } },
    });
    assert.ok(steer);
    assert.equal(steer?.lane, "steer");

    const follow = await queue.queueCommand({
      jobId: job.id,
      command: "follow_up",
      payload: { note: "tighten proof" },
    });
    assert.ok(follow);
    assert.equal(follow?.lane, "follow_up");

    const commands = await queue.consumeCommands(job.id, ["steer", "follow_up"]);
    assert.equal(commands.length, 2);

    const abort = await queue.queueCommand({ jobId: job.id, command: "abort" });
    assert.ok(abort);
    const canceled = await queue.getJob(job.id);
    assert.equal(canceled?.status, "canceled");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: session singleton cancel and steer modes", async () => {
  const dir = await mkTmp("receipt-queue-singleton");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = jsonlQueue({ runtime, stream: "jobs" });

    const first = await queue.enqueue({
      agentId: "writer",
      sessionKey: "chat:1",
      singletonMode: "cancel",
      payload: { msg: "first" },
    });
    assert.equal(first.status, "queued");

    const second = await queue.enqueue({
      agentId: "writer",
      sessionKey: "chat:1",
      singletonMode: "cancel",
      payload: { msg: "second" },
    });
    assert.equal(second.status, "queued");
    const firstAfter = await queue.getJob(first.id);
    assert.equal(firstAfter?.status, "canceled");

    const third = await queue.enqueue({
      agentId: "writer",
      sessionKey: "chat:2",
      singletonMode: "cancel",
      payload: { msg: "third" },
    });
    assert.equal(third.status, "queued");

    const steerTarget = await queue.enqueue({
      agentId: "writer",
      sessionKey: "chat:3",
      singletonMode: "cancel",
      payload: { msg: "base" },
    });
    const steered = await queue.enqueue({
      agentId: "writer",
      sessionKey: "chat:3",
      singletonMode: "steer",
      payload: { note: "new message" },
    });
    assert.equal(steered.id, steerTarget.id);
    const commands = await queue.consumeCommands(steerTarget.id, ["steer"]);
    assert.equal(commands.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: getJob reads authoritative jobs/<jobId> stream", async () => {
  const dir = await mkTmp("receipt-queue-authoritative");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = jsonlQueue({ runtime, stream: "jobs" });

    await runtime.execute("jobs", {
      type: "emit",
      eventId: "legacy-index-only",
      event: {
        type: "job.enqueued",
        jobId: "legacy_only",
        agentId: "writer",
        lane: "collect",
        payload: { kind: "writer.run" },
        maxAttempts: 1,
      },
    });

    const fromAuthoritative = await queue.getJob("legacy_only");
    assert.equal(fromAuthoritative, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
