import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { receipt } from "@receipt/core/chain";
import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { jsonlQueue } from "../../src/adapters/jsonl-queue";
import { createRuntime } from "@receipt/core/runtime";
import { JobWorker } from "../../src/engine/runtime/job-worker";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 1_000,
  pollMs = 20,
): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};

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

test("jsonl queue: lane filters keep fast chat work separate from heavy jobs", async () => {
  const dir = await mkTmp("receipt-queue-lanes");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = jsonlQueue({ runtime, stream: "jobs" });

    const heavy = await queue.enqueue({
      agentId: "factory",
      lane: "collect",
      payload: { kind: "factory.task.run", runId: "r_heavy" },
      maxAttempts: 1,
    });
    const chat = await queue.enqueue({
      agentId: "factory",
      lane: "chat",
      payload: { kind: "factory.run", runId: "r_chat" },
      maxAttempts: 1,
    });

    const chatLease = await queue.leaseNext({
      workerId: "w_chat",
      leaseMs: 5_000,
      agentId: "factory",
      lanes: ["chat"],
    });
    expect(chatLease?.id).toBe(chat.id);

    const heavyLease = await queue.leaseNext({
      workerId: "w_heavy",
      leaseMs: 5_000,
      agentId: "factory",
      lanes: ["collect"],
    });
    expect(heavyLease?.id).toBe(heavy.id);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: leaseJob leases a specific queued job without scanning order", async () => {
  const dir = await mkTmp("receipt-queue-lease-job");
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
      payload: { kind: "writer.run", runId: "r_first" },
      maxAttempts: 1,
    });
    const second = await queue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r_second" },
      maxAttempts: 1,
    });

    const leased = await queue.leaseJob(second.id, "worker_specific", 5_000);
    expect(leased?.id).toBe(second.id);
    expect(leased?.attempt).toBe(1);

    const untouched = await queue.getJob(first.id);
    expect(untouched?.status).toBe("queued");
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

test("jsonl queue: cold getJob does not require scanning the full job manifest", async () => {
  const dir = await mkTmp("receipt-queue-cold-get-job");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = jsonlQueue({ runtime, stream: "jobs" });

    const created = await queue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r_direct" },
      maxAttempts: 1,
    });

    if (!runtime.listStreams) {
      throw new Error("expected runtime.listStreams to exist for this regression");
    }
    const originalListStreams = runtime.listStreams.bind(runtime);
    runtime.listStreams = (async (prefix?: string) => {
      if (prefix === "jobs/") {
        throw new Error("cold getJob should not scan jobs/");
      }
      return originalListStreams(prefix);
    }) as typeof runtime.listStreams;

    const loaded = await queue.getJob(created.id);
    expect(loaded?.id).toBe(created.id);
    expect(loaded?.status).toBe("queued");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: cold targeted job mutations do not require scanning the full job manifest", async () => {
  const dir = await mkTmp("receipt-queue-cold-targeted-job-op");
  try {
    const runtimeA = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queueA = jsonlQueue({ runtime: runtimeA, stream: "jobs" });
    const created = await queueA.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r_targeted_ops" },
      maxAttempts: 1,
    });

    const runtimeB = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queueB = jsonlQueue({ runtime: runtimeB, stream: "jobs" });

    if (!runtimeB.listStreams) {
      throw new Error("expected runtime.listStreams to exist for this regression");
    }
    const originalListStreams = runtimeB.listStreams.bind(runtimeB);
    runtimeB.listStreams = (async (prefix?: string) => {
      if (prefix === "jobs/") {
        throw new Error("cold targeted job mutations should not scan jobs/");
      }
      return originalListStreams(prefix);
    }) as typeof runtimeB.listStreams;

    const leased = await queueB.leaseJob(created.id, "worker_targeted", 5_000);
    expect(leased?.id).toBe(created.id);
    expect(leased?.status).toBe("leased");

    const heartbeated = await queueB.heartbeat(created.id, "worker_targeted", 5_000);
    expect(heartbeated?.status).toBe("running");

    const completed = await queueB.complete(created.id, "worker_targeted", { ok: true });
    expect(completed?.status).toBe("completed");

    const settled = await queueA.getJob(created.id);
    expect(settled?.status).toBe("completed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: cold enqueue without singleton scans does not require the full job manifest", async () => {
  const dir = await mkTmp("receipt-queue-cold-enqueue");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = jsonlQueue({ runtime, stream: "jobs" });

    await queue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r_seed" },
      maxAttempts: 1,
    });

    if (!runtime.listStreams) {
      throw new Error("expected runtime.listStreams to exist for this regression");
    }
    const originalListStreams = runtime.listStreams.bind(runtime);
    runtime.listStreams = (async (prefix?: string) => {
      if (prefix === "jobs/") {
        throw new Error("cold enqueue without singleton scans should not scan jobs/");
      }
      return originalListStreams(prefix);
    }) as typeof runtime.listStreams;

    const created = await queue.enqueue({
      jobId: "job_direct_enqueue",
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r_direct_enqueue" },
      maxAttempts: 1,
    });

    expect(created.id).toBe("job_direct_enqueue");
    expect(created.status).toBe("queued");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: cross-process stale heartbeat does not append after external completion", async () => {
  const dir = await mkTmp("receipt-queue-stale-heartbeat");
  try {
    const runtimeA = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const runtimeB = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queueA = jsonlQueue({ runtime: runtimeA, stream: "jobs" });
    const queueB = jsonlQueue({ runtime: runtimeB, stream: "jobs" });

    const job = await queueA.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r_stale_heartbeat" },
      maxAttempts: 1,
    });

    await queueA.leaseNext({ workerId: "w1", leaseMs: 5_000 });
    await queueB.complete(job.id, "w1", { ok: true });
    const afterComplete = await runtimeA.chain(`jobs/${job.id}`);

    const settled = await queueA.heartbeat(job.id, "w1", 5_000);
    const finalChain = await runtimeA.chain(`jobs/${job.id}`);
    const finalState = await runtimeA.state(`jobs/${job.id}`);

    expect(settled?.status).toBe("completed");
    expect(finalChain).toHaveLength(afterComplete.length);
    expect(finalChain.at(-1)?.body.type).toBe("job.completed");
    expect(finalState.jobs[job.id]?.status).toBe("completed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: replay tolerates late heartbeat receipts after completion", async () => {
  const dir = await mkTmp("receipt-queue-late-heartbeat-replay");
  try {
    const store = jsonlStore<JobEvent>(dir);
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      store,
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = jsonlQueue({ runtime, stream: "jobs" });
    const stream = "jobs/job_replay_late_heartbeat";

    const enqueued = receipt(stream, undefined, {
      type: "job.enqueued",
      jobId: "job_replay_late_heartbeat",
      agentId: "writer",
      lane: "collect",
      payload: { kind: "writer.run", runId: "r_replay" },
      maxAttempts: 1,
    });
    await store.append(enqueued);

    const leased = receipt(stream, enqueued.hash, {
      type: "job.leased",
      jobId: "job_replay_late_heartbeat",
      workerId: "w1",
      leaseMs: 5_000,
      attempt: 1,
    });
    await store.append(leased);

    const completed = receipt(stream, leased.hash, {
      type: "job.completed",
      jobId: "job_replay_late_heartbeat",
      workerId: "w1",
      result: { ok: true },
    });
    await store.append(completed);

    const lateHeartbeat = receipt(stream, completed.hash, {
      type: "job.heartbeat",
      jobId: "job_replay_late_heartbeat",
      workerId: "w1",
      leaseMs: 5_000,
    });
    await store.append(lateHeartbeat);

    const state = await runtime.state(stream);
    const job = await queue.getJob("job_replay_late_heartbeat");

    expect(state.jobs.job_replay_late_heartbeat?.status).toBe("completed");
    expect(job?.status).toBe("completed");
    expect(job?.result?.ok).toBe(true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: onJobChange receives the current job snapshot without deadlocking enqueue", async () => {
  const dir = await mkTmp("receipt-queue-on-change");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );

    let observedJobId: string | undefined;
    const queue = jsonlQueue({
      runtime,
      stream: "jobs",
      onJobChange: async (jobs) => {
        observedJobId = jobs[0]?.id;
        expect(jobs[0]?.status).toBe("queued");
      },
    });

    const created = await queue.enqueue({
      agentId: "factory",
      payload: { kind: "factory.run", runId: "r_on_change" },
      maxAttempts: 1,
    });

    expect(created.status).toBe("queued");
    expect(observedJobId).toBe(created.id);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: listJobs remains readable while onJobChange is still awaiting", async () => {
  const dir = await mkTmp("receipt-queue-read-while-callback");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob,
    );

    let releaseCallback: (() => void) | undefined;
    const callbackEntered = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    let unblockCallback: (() => void) | undefined;
    const callbackBlocker = new Promise<void>((resolve) => {
      unblockCallback = resolve;
    });

    const queue = jsonlQueue({
      runtime,
      stream: "jobs",
      onJobChange: async () => {
        releaseCallback?.();
        await callbackBlocker;
      },
    });

    const enqueuePromise = queue.enqueue({
      agentId: "factory",
      payload: { kind: "factory.run", runId: "r_read_while_callback" },
      maxAttempts: 1,
    });

    await callbackEntered;
    const listed = await queue.listJobs({ limit: 5 });
    expect(listed[0]?.status).toBe("queued");
    expect(listed[0]?.agentId).toBe("factory");

    unblockCallback?.();
    const created = await enqueuePromise;
    expect(created.status).toBe("queued");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: list and lease derive from authoritative jobs/<jobId> streams", async () => {
  const dir = await mkTmp("receipt-queue-authoritative-list");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = jsonlQueue({ runtime, stream: "jobs" });

    await runtime.execute("jobs/job_direct", {
      type: "emit",
      eventId: "direct-enqueue",
      event: {
        type: "job.enqueued",
        jobId: "job_direct",
        agentId: "writer",
        lane: "collect",
        payload: { kind: "writer.run", runId: "r_direct" },
        maxAttempts: 1,
      },
    });

    const listed = await queue.listJobs();
    expect(listed.some((job) => job.id === "job_direct")).toBe(true);

    const leased = await queue.leaseNext({ workerId: "worker", leaseMs: 5_000 });
    expect(leased?.id).toBe("job_direct");
    expect((await queue.getJob("job_direct"))?.status).toBe("leased");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: enqueue wakes an idle worker without relying on a short poll interval", async () => {
  const dir = await mkTmp("receipt-queue-worker-wakeup");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob,
    );
    const queue = jsonlQueue({ runtime, stream: "jobs" });
    const handled: string[] = [];
    let workerError: Error | undefined;

    const worker = new JobWorker({
      queue,
      workerId: "worker_push",
      idleResyncMs: 20_000,
      leaseMs: 5_000,
      concurrency: 1,
      handlers: {
        writer: async (job) => {
          handled.push(job.id);
          return { ok: true, result: { ok: true } };
        },
      },
      onError: (error) => {
        workerError = error;
      },
    });

    worker.start();
    const job = await queue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r_worker_push" },
      maxAttempts: 1,
    });
    const settled = await queue.waitForJob(job.id, 2_000);
    worker.stop();

    expect(workerError).toBeUndefined();
    expect(handled).toEqual([job.id]);
    expect(settled?.status).toBe("completed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: waitForWork performs at most one refresh per idle timeout window", async () => {
  const dir = await mkTmp("receipt-queue-idle-refresh");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob,
    );
    let listStreamsCalls = 0;
    const baseListStreams = runtime.listStreams.bind(runtime);
    (runtime as typeof runtime & {
      listStreams: (prefix?: string) => Promise<ReadonlyArray<string>>;
    }).listStreams = async (prefix?: string) => {
      listStreamsCalls += 1;
      return baseListStreams(prefix);
    };

    const queue = jsonlQueue({ runtime, stream: "jobs" });
    const startedAt = Date.now();
    const snapshot = await queue.waitForWork({ timeoutMs: 650 });

    expect(snapshot.queued).toBe(0);
    expect(snapshot.version).toBeGreaterThanOrEqual(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(600);
    expect(listStreamsCalls).toBe(1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: refresh reaps expired leases even when no new lease is requested", async () => {
  const dir = await mkTmp("receipt-queue-refresh-expired-lease");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob,
    );
    const queue = jsonlQueue({ runtime, stream: "jobs" });

    const retryable = await queue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r_retryable_expiry" },
      maxAttempts: 2,
    });
    await queue.leaseNext({ workerId: "w_retry", leaseMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await queue.refresh();
    const requeued = await queue.getJob(retryable.id);

    expect(requeued?.status).toBe("queued");
    expect(requeued?.lastError).toBe("lease expired");
    await queue.cancel(retryable.id, "test cleanup");

    const terminal = await queue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r_terminal_expiry" },
      maxAttempts: 1,
    });
    await queue.leaseNext({ workerId: "w_terminal", leaseMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await queue.refresh();
    const failed = await queue.getJob(terminal.id);

    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toBe("lease expired");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: refresh can stay read-only when lease expiry is owned elsewhere", async () => {
  const dir = await mkTmp("receipt-queue-refresh-read-only");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob,
    );
    const queue = jsonlQueue({
      runtime,
      stream: "jobs",
      expireLeasesOnRefresh: false,
    });

    const job = await queue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r_refresh_read_only" },
      maxAttempts: 2,
    });
    await queue.leaseNext({ workerId: "w_read_only", leaseMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const before = await runtime.chain(`jobs/${job.id}`);
    await queue.refresh();
    const after = await runtime.chain(`jobs/${job.id}`);
    const current = await queue.getJob(job.id);

    expect(after).toHaveLength(before.length);
    expect(current?.status).toBe("leased");
    expect(current?.lastError).toBe(undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test.skip("jsonl queue: cross-queue enqueue wakes a worker watching the shared data dir (removed: single-process)", () => {});

test("jsonl queue: worker wakes for a child queued by an active parent before the parent finishes", async () => {
  const dir = await mkTmp("receipt-queue-parent-child-wakeup");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob,
    );
    const queue = jsonlQueue({ runtime, stream: "jobs" });
    const handled: string[] = [];
    const workerErrors: string[] = [];
    let childJobId = "";
    let resolveChildCreated: ((jobId: string) => void) | undefined;
    const childCreated = new Promise<string>((resolve) => {
      resolveChildCreated = resolve;
    });
    let resolveChildRan: (() => void) | undefined;
    const childRan = new Promise<void>((resolve) => {
      resolveChildRan = resolve;
    });

    const worker = new JobWorker({
      queue,
      workerId: "worker_parent_child",
      idleResyncMs: 20_000,
      leaseMs: 5_000,
      concurrency: 2,
      handlers: {
        writer: async (job) => {
          handled.push(job.id);
          if (job.payload.kind === "writer.parent") {
            const child = await queue.enqueue({
              agentId: "writer",
              payload: { kind: "writer.child", runId: "r_child" },
              maxAttempts: 1,
            });
            childJobId = child.id;
            resolveChildCreated?.(child.id);
            const childCompleted = await Promise.race([
              childRan.then(() => true),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
            ]);
            return childCompleted
              ? { ok: true, result: { ok: true, childJobId: child.id } }
              : { ok: false, error: "child job did not run before parent finished" };
          }
          resolveChildRan?.();
          return { ok: true, result: { ok: true } };
        },
      },
      onError: (error) => {
        workerErrors.push(error.message);
      },
    });

    worker.start();
    const parent = await queue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.parent", runId: "r_parent" },
      maxAttempts: 1,
    });
    const createdChildId = await Promise.race([
      childCreated,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("child job was never enqueued")), 1_000)),
    ]);
    const [parentSettled, childSettled] = await Promise.all([
      queue.waitForJob(parent.id, 2_000),
      queue.waitForJob(createdChildId, 2_000),
    ]);
    worker.stop();

    expect(workerErrors).toEqual([]);
    expect(childJobId).toBe(createdChildId);
    expect(handled).toContain(parent.id);
    expect(handled).toContain(createdChildId);
    expect(parentSettled?.status).toBe("completed");
    expect(childSettled?.status).toBe("completed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("job worker: does not busy-spin on queued work it cannot lease", async () => {
  const dir = await mkTmp("receipt-queue-unmatched-worker");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob,
    );
    const queue = jsonlQueue({ runtime, stream: "jobs" });
    await queue.enqueue({
      agentId: "codex",
      payload: { kind: "factory.codex.run", runId: "r_unmatched" },
      maxAttempts: 1,
    });

    let ticks = 0;
    const worker = new JobWorker({
      queue,
      workerId: "worker_writer_only",
      leaseAgentIds: ["writer"],
      idleResyncMs: 500,
      leaseMs: 5_000,
      concurrency: 1,
      handlers: {
        writer: async () => ({ ok: true }),
      },
      onTick: () => {
        ticks += 1;
      },
    });

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    worker.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ticks).toBeLessThan(20);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: worker keeps leasing later jobs after an unexpected heartbeat error", async () => {
  const dir = await mkTmp("receipt-queue-worker-recover");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob,
    );
    const baseQueue = jsonlQueue({ runtime, stream: "jobs" });
    let failHeartbeatForJobId: string | undefined;
    const queue: typeof baseQueue = {
      ...baseQueue,
      heartbeat: async (jobId, workerId, leaseMs) => {
        if (jobId === failHeartbeatForJobId) {
          failHeartbeatForJobId = undefined;
          throw new Error("simulated heartbeat failure");
        }
        return baseQueue.heartbeat(jobId, workerId, leaseMs);
      },
    };
    const handled: string[] = [];
    const workerErrors: string[] = [];

    const worker = new JobWorker({
      queue,
      workerId: "worker_resilient",
      idleResyncMs: 20_000,
      leaseMs: 5_000,
      concurrency: 1,
      handlers: {
        writer: async (job) => {
          handled.push(job.id);
          return { ok: true, result: { ok: true } };
        },
      },
      onError: (error) => {
        workerErrors.push(error.message);
      },
    });

    const first = await baseQueue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r_worker_fail_1" },
      maxAttempts: 1,
    });
    failHeartbeatForJobId = first.id;
    const second = await baseQueue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r_worker_fail_2" },
      maxAttempts: 1,
    });

    worker.start();
    const secondSettled = await baseQueue.waitForJob(second.id, 2_000);
    worker.stop();
    await waitFor(() => workerErrors.includes("simulated heartbeat failure"));

    expect(workerErrors).toContain("simulated heartbeat failure");
    expect(handled).toContain(second.id);
    expect(secondSettled?.status).toBe("completed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: scoped workers prevent parent and control jobs from starving a codex child", async () => {
  const dir = await mkTmp("receipt-queue-scoped-workers");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob,
    );
    const queue = jsonlQueue({ runtime, stream: "jobs" });
    const handled: string[] = [];
    const workerErrors: string[] = [];
    let resolveCodexRan: (() => void) | undefined;
    const codexRan = new Promise<void>((resolve) => {
      resolveCodexRan = resolve;
    });

    const generalWorker = new JobWorker({
      queue,
      workerId: "worker_general",
      leaseAgentIds: ["agent"],
      idleResyncMs: 20_000,
      leaseMs: 5_000,
      concurrency: 1,
      handlers: {
        agent: async () => {
          const controlJob = await queue.enqueue({
            agentId: "factory-control",
            payload: { kind: "factory.objective.control", runId: "r_control" },
            maxAttempts: 1,
          });
          handled.push(`agent:${controlJob.id}`);
          const completed = await Promise.race([
            codexRan.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
          ]);
          return completed
            ? { ok: true, result: { controlJobId: controlJob.id } }
            : { ok: false, error: "codex child never ran" };
        },
      },
      onError: (error) => {
        workerErrors.push(`general:${error.message}`);
      },
    });

    const controlWorker = new JobWorker({
      queue,
      workerId: "worker_factory_control",
      leaseAgentIds: ["factory-control"],
      idleResyncMs: 20_000,
      leaseMs: 5_000,
      concurrency: 1,
      handlers: {
        "factory-control": async (job) => {
          handled.push(`factory-control:${job.id}`);
          const codexJob = await queue.enqueue({
            agentId: "codex",
            payload: { kind: "codex.run", runId: "r_codex" },
            maxAttempts: 1,
          });
          const completed = await Promise.race([
            codexRan.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
          ]);
          return completed
            ? { ok: true, result: { codexJobId: codexJob.id } }
            : { ok: false, error: "queued codex child was starved" };
        },
      },
      onError: (error) => {
        workerErrors.push(`control:${error.message}`);
      },
    });

    const codexWorker = new JobWorker({
      queue,
      workerId: "worker_codex",
      leaseAgentIds: ["codex"],
      idleResyncMs: 20_000,
      leaseMs: 5_000,
      concurrency: 1,
      handlers: {
        codex: async (job) => {
          handled.push(`codex:${job.id}`);
          resolveCodexRan?.();
          return { ok: true, result: { ok: true } };
        },
      },
      onError: (error) => {
        workerErrors.push(`codex:${error.message}`);
      },
    });

    generalWorker.start();
    controlWorker.start();
    codexWorker.start();

    const parentJob = await queue.enqueue({
      agentId: "agent",
      payload: { kind: "agent.run", runId: "r_agent" },
      maxAttempts: 1,
    });

    const codexCompleted = await Promise.race([
      codexRan.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    const jobs = await queue.listJobs({ limit: 10 });
    const codexJob = jobs.find((job) => job.agentId === "codex");
    const codexSettled = codexJob
      ? await queue.waitForJob(codexJob.id, 2_000)
      : undefined;
    const parentSettled = await queue.waitForJob(parentJob.id, 2_000);

    generalWorker.stop();
    controlWorker.stop();
    codexWorker.stop();

    expect(workerErrors).toEqual([]);
    expect(codexCompleted).toBe(true);
    expect(codexSettled?.status).toBe("completed");
    expect(parentSettled?.status).toBe("completed");
    expect(handled.some((entry) => entry.startsWith("agent:"))).toBe(true);
    expect(handled.some((entry) => entry.startsWith("factory-control:"))).toBe(true);
    expect(handled.some((entry) => entry.startsWith("codex:"))).toBe(true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Performance optimization tests
// ============================================================================

test("jsonl queue: heartbeat updates lease without full projection sync", async () => {
  const dir = await mkTmp("receipt-queue-hb-fast");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = jsonlQueue({ runtime, stream: "jobs", watchDir: dir });
    const job = await queue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r1" },
      maxAttempts: 1,
    });
    const leased = await queue.leaseNext({ workerId: "w1", leaseMs: 10_000 });
    expect(leased?.id).toBe(job.id);
    expect(leased?.status).toBe("leased");

    const before = await queue.getJob(job.id);
    expect(before?.leaseUntil).toBeDefined();
    const hb = await queue.heartbeat(job.id, "w1", 30_000);
    expect(hb).toBeTruthy();
    expect(hb!.status).toBe("running");
    expect(hb!.leaseUntil).toBeGreaterThan(before!.leaseUntil!);

    await queue.complete(job.id, "w1", { ok: true });
    const settled = await queue.getJob(job.id);
    expect(settled?.status).toBe("completed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: leaseNext with agent/lane filters skips non-matching index entries", async () => {
  const dir = await mkTmp("receipt-queue-lease-filter");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = jsonlQueue({ runtime, stream: "jobs" });

    const agents = ["alpha", "beta", "gamma", "delta", "target"];
    const jobs = [];
    for (const agentId of agents) {
      jobs.push(await queue.enqueue({
        agentId,
        lane: agentId === "target" ? "chat" : "collect",
        payload: { kind: `${agentId}.run` },
        maxAttempts: 1,
      }));
    }

    const leased = await queue.leaseNext({
      workerId: "w1",
      leaseMs: 5_000,
      agentIds: ["target"],
      lanes: ["chat"],
    });
    expect(leased).toBeTruthy();
    expect(leased!.agentId).toBe("target");

    const others = await queue.listJobs({ status: "queued" });
    expect(others.length).toBe(4);
    for (const other of others) {
      expect(other.agentId).not.toBe("target");
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: handleExpiredLeases only processes leased/running jobs", async () => {
  const dir = await mkTmp("receipt-queue-expire-opt");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = jsonlQueue({
      runtime,
      stream: "jobs",
      expireLeasesOnRefresh: true,
    });

    const completedJob = await queue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "q1" },
      maxAttempts: 2,
    });
    const toExpire = await queue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "q2" },
      maxAttempts: 2,
    });

    const leased = await queue.leaseNext({ workerId: "w1", leaseMs: 1_000 });
    expect(leased?.id).toBe(completedJob.id);

    const leased2 = await queue.leaseNext({ workerId: "w2", leaseMs: 1_000 });
    expect(leased2?.id).toBe(toExpire.id);

    await queue.complete(completedJob.id, "w1", { ok: true });
    const completed = await queue.getJob(completedJob.id);
    expect(completed?.status).toBe("completed");

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await queue.refresh();

    const expired = await queue.getJob(toExpire.id);
    expect(expired?.status).toBe("queued");

    const stillCompleted = await queue.getJob(completedJob.id);
    expect(stillCompleted?.status).toBe("completed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("jsonl queue: refreshAllJobs skips reloading terminal jobs from disk", async () => {
  const dir = await mkTmp("receipt-queue-refresh-skip");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(dir),
      jsonBranchStore(dir),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = jsonlQueue({
      runtime,
      stream: "jobs",
      expireLeasesOnRefresh: true,
      fullRefreshWindowMs: 0,
    });

    const completedJob = await queue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "done" },
      maxAttempts: 1,
    });
    const leased = await queue.leaseNext({ workerId: "w1", leaseMs: 5_000 });
    expect(leased?.id).toBe(completedJob.id);
    await queue.complete(completedJob.id, "w1", { result: "done" });

    const activeJob = await queue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "active" },
      maxAttempts: 1,
    });

    const snap1 = await queue.refresh();
    expect(snap1.completed).toBe(1);
    expect(snap1.queued).toBe(1);

    const snap2 = await queue.refresh();
    expect(snap2.completed).toBe(1);
    expect(snap2.queued).toBe(1);

    const settled = await queue.getJob(completedJob.id);
    expect(settled?.status).toBe("completed");

    const active = await queue.getJob(activeJob.id);
    expect(active?.status).toBe("queued");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
