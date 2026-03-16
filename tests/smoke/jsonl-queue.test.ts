import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
    expect(jobChain.length > 0).toBe(true);

    const lease1 = await queue.leaseNext({ workerId: "w1", leaseMs: 5_000 });
    expect(lease1).toBeTruthy();
    expect(lease1?.id).toBe(job.id);
    expect(lease1?.attempt).toBe(1);

    const duplicate = await queue.leaseNext({ workerId: "w2", leaseMs: 5_000 });
    expect(duplicate).toBe(undefined);

    await queue.fail(job.id, "w1", "transient");
    const afterFail = await queue.getJob(job.id);
    expect(afterFail?.status).toBe("queued");

    const lease2 = await queue.leaseNext({ workerId: "w2", leaseMs: 5_000 });
    expect(lease2).toBeTruthy();
    expect(lease2?.attempt).toBe(2);

    await queue.complete(job.id, "w2", { ok: true });
    const settled = await queue.waitForJob(job.id, 1_000, 25);
    expect(settled?.status).toBe("completed");
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
    expect(steer).toBeTruthy();
    expect(steer?.lane).toBe("steer");

    const follow = await queue.queueCommand({
      jobId: job.id,
      command: "follow_up",
      payload: { note: "tighten proof" },
    });
    expect(follow).toBeTruthy();
    expect(follow?.lane).toBe("follow_up");

    const commands = await queue.consumeCommands(job.id, ["steer", "follow_up"]);
    expect(commands.length).toBe(2);

    const abort = await queue.queueCommand({ jobId: job.id, command: "abort" });
    expect(abort).toBeTruthy();
    const canceled = await queue.getJob(job.id);
    expect(canceled?.status).toBe("canceled");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: failed jobs retain terminal result metadata", async () => {
  const dir = await mkTmp("receipt-queue-failed-result");
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
      agentId: "axiom-guild",
      payload: { kind: "axiom-guild.run", runId: "r_failed" },
      maxAttempts: 1,
    });

    await queue.leaseNext({ workerId: "w1", leaseMs: 5_000 });
    await queue.fail(job.id, "w1", "final verify failed", true, {
      runId: "r_failed",
      status: "failed",
      followUpJobId: "job_retry_1",
      followUpRunId: "run_retry_1",
      failureClass: "axle_verify_failed",
      failure: {
        stage: "verification",
        failureClass: "axle_verify_failed",
        message: "Final verification failed.",
        retryable: true,
      },
    });

    const failed = await queue.getJob(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.result?.followUpJobId).toBe("job_retry_1");
    expect(failed?.result?.followUpRunId).toBe("run_retry_1");
    expect(failed?.result?.failureClass).toBe("axle_verify_failed");
    expect((failed?.result?.failure as Record<string, unknown> | undefined)?.failureClass).toBe("axle_verify_failed");
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
    expect(first.status).toBe("queued");

    const second = await queue.enqueue({
      agentId: "writer",
      sessionKey: "chat:1",
      singletonMode: "cancel",
      payload: { msg: "second" },
    });
    expect(second.status).toBe("queued");
    const firstAfter = await queue.getJob(first.id);
    expect(firstAfter?.status).toBe("canceled");

    const third = await queue.enqueue({
      agentId: "writer",
      sessionKey: "chat:2",
      singletonMode: "cancel",
      payload: { msg: "third" },
    });
    expect(third.status).toBe("queued");

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
    expect(steered.id).toBe(steerTarget.id);
    const commands = await queue.consumeCommands(steerTarget.id, ["steer"]);
    expect(commands.length).toBe(1);
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
    expect(fromAuthoritative).toBe(undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
