import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import { jsonlQueue } from "../../src/adapters/jsonl-queue.ts";
import { createRuntime } from "@receipt/core/runtime.js";
import { JobWorker } from "../../src/engine/runtime/job-worker.ts";
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
