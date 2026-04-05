import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { jsonlQueue } from "../../src/adapters/jsonl-queue";
import { createRuntime } from "@receipt/core/runtime";
import { SseHub } from "../../src/framework/sse-hub";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";
import { FactoryService } from "../../src/services/factory-service";

const execFileAsync = promisify(execFile);

const createTempDir = (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], { cwd, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
};

const createSourceRepo = async (): Promise<string> => {
  const dir = await createTempDir("receipt-slots-src");
  await git(dir, ["init"]);
  await git(dir, ["config", "user.name", "Slot Test"]);
  await git(dir, ["config", "user.email", "slot@test.local"]);
  await fs.writeFile(path.join(dir, "README.md"), "# slot test\n", "utf-8");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-m", "initial"]);
  await git(dir, ["branch", "-M", "main"]);
  return dir;
};

const createJobRuntime = (dataDir: string) =>
  createRuntime<JobCmd, JobEvent, JobState>(
    jsonlStore<JobEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideJob,
    reduceJob,
    initialJob,
  );

const noopCodex = { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) };

const createService = (
  dataDir: string,
  repoRoot: string,
  opts?: {
    readonly repoSlotConcurrency?: number;
  },
) =>
  new FactoryService({
    dataDir,
    queue: jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" }),
    jobRuntime: createJobRuntime(dataDir),
    sse: new SseHub(),
    codexExecutor: noopCodex,
    repoRoot,
    repoSlotConcurrency: opts?.repoSlotConcurrency,
  });

const emitEvent = async (service: FactoryService, objectiveId: string, event: Record<string, unknown>): Promise<void> => {
  const internals = service as unknown as {
    emitObjective(objectiveId: string, event: unknown): Promise<void>;
  };
  await internals.emitObjective(objectiveId, event);
};

const runControl = async (service: FactoryService, objectiveId: string): Promise<void> => {
  await service.runObjectiveControl({ kind: "factory.objective.control", objectiveId, reason: "startup" });
};

// ---------------------------------------------------------------------------
// Slot release: every terminal status frees the slot for the next objective
// ---------------------------------------------------------------------------

test("slot release: completing an objective admits the next queued objective", async () => {
  const dataDir = await createTempDir("slots-complete");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const first = await service.createObjective({ title: "First", prompt: "hold slot", checks: ["true"] });
  const second = await service.createObjective({ title: "Second", prompt: "wait", checks: ["true"] });

  expect(first.scheduler.slotState).toBe("active");
  expect(second.scheduler.slotState).toBe("queued");

  await emitEvent(service, first.objectiveId, {
    type: "objective.completed", objectiveId: first.objectiveId,
    summary: "done", completedAt: Date.now(),
  });
  await service.reactObjective(first.objectiveId);

  const refreshedSecond = await service.getObjective(second.objectiveId);
  expect(refreshedSecond.scheduler.slotState).toBe("active");
}, 30_000);

test("slot release: canceling an objective admits the next queued objective", async () => {
  const dataDir = await createTempDir("slots-cancel");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const first = await service.createObjective({ title: "First", prompt: "hold slot", checks: ["true"] });
  const second = await service.createObjective({ title: "Second", prompt: "wait", checks: ["true"] });

  expect(first.scheduler.slotState).toBe("active");
  await service.cancelObjective(first.objectiveId, "test cancel");

  const refreshedSecond = await service.getObjective(second.objectiveId);
  expect(refreshedSecond.scheduler.slotState).toBe("active");
}, 30_000);

test("slot release: blocking an objective admits the next queued objective", async () => {
  const dataDir = await createTempDir("slots-block");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const first = await service.createObjective({ title: "First", prompt: "hold slot", checks: ["true"] });
  const second = await service.createObjective({ title: "Second", prompt: "wait", checks: ["true"] });

  await emitEvent(service, first.objectiveId, {
    type: "objective.blocked", objectiveId: first.objectiveId,
    reason: "test block", summary: "blocked", blockedAt: Date.now(),
  });
  await service.reactObjective(first.objectiveId);

  const refreshedSecond = await service.getObjective(second.objectiveId);
  expect(refreshedSecond.scheduler.slotState).toBe("active");
}, 30_000);

test("slot release: failing an objective admits the next queued objective", async () => {
  const dataDir = await createTempDir("slots-fail");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const first = await service.createObjective({ title: "First", prompt: "hold slot", checks: ["true"] });
  const second = await service.createObjective({ title: "Second", prompt: "wait", checks: ["true"] });

  await emitEvent(service, first.objectiveId, {
    type: "objective.failed", objectiveId: first.objectiveId,
    reason: "test fail", failedAt: Date.now(),
  });
  await service.reactObjective(first.objectiveId);

  const refreshedSecond = await service.getObjective(second.objectiveId);
  expect(refreshedSecond.scheduler.slotState).toBe("active");
}, 30_000);

test("objective control: reconcile preserves the reconcile reason", async () => {
  const dataDir = await createTempDir("slots-reconcile");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const created = await service.createObjective({ title: "First", prompt: "hold slot", checks: ["true"] });
  const result = await service.runObjectiveControl({
    kind: "factory.objective.control",
    objectiveId: created.objectiveId,
    reason: "reconcile",
  });

  expect(result).toMatchObject({
    objectiveId: created.objectiveId,
    status: "completed",
    reason: "reconcile",
  });
}, 30_000);

test("slot release: promoting status releases the slot", async () => {
  const dataDir = await createTempDir("slots-promote-status");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const first = await service.createObjective({ title: "First", prompt: "hold slot", checks: ["true"] });
  const second = await service.createObjective({ title: "Second", prompt: "wait", checks: ["true"] });

  await emitEvent(service, first.objectiveId, {
    type: "integration.ready_to_promote", objectiveId: first.objectiveId,
    candidateId: "task_01_candidate_01", summary: "ready", readyAt: Date.now(),
  });

  const stateBeforeReact = await service.getObjectiveState(first.objectiveId);
  expect(stateBeforeReact.status).toBe("promoting");

  await service.reactObjective(first.objectiveId);

  const refreshedSecond = await service.getObjective(second.objectiveId);
  expect(refreshedSecond.scheduler.slotState).toBe("active");
}, 30_000);

test("slot release: integration-level promoted releases slot even when status is executing", async () => {
  const dataDir = await createTempDir("slots-integration-promote");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const first = await service.createObjective({ title: "First", prompt: "hold slot", checks: ["true"], startImmediately: true });
  const second = await service.createObjective({ title: "Second", prompt: "wait", checks: ["true"] });

  const stateAfterStartup = await service.getObjectiveState(first.objectiveId);
  expect(stateAfterStartup.status).toBe("executing");

  await emitEvent(service, first.objectiveId, {
    type: "integration.ready_to_promote", objectiveId: first.objectiveId,
    candidateId: "task_01_candidate_01", summary: "ready", readyAt: Date.now(),
  });

  const stateNow = await service.getObjectiveState(first.objectiveId);
  expect(stateNow.integration.status).toBe("ready_to_promote");

  await service.resumeObjectives();

  const refreshedSecond = await service.getObjective(second.objectiveId);
  expect(refreshedSecond.scheduler.slotState).toBe("active");
}, 30_000);

test("slot admission: investigation objectives do not block delivery admission", async () => {
  const dataDir = await createTempDir("slots-investigation-free");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const investigation = await service.createObjective({
    title: "Investigate AWS posture",
    prompt: "Inspect the current AWS account posture without promoting code.",
    objectiveMode: "investigation",
    checks: ["true"],
  });
  const delivery = await service.createObjective({
    title: "Delivery objective",
    prompt: "Implement a tracked repo change.",
    checks: ["true"],
  });

  expect(investigation.scheduler.slotState).toBe("active");
  expect(delivery.scheduler.slotState).toBe("active");
  expect(delivery.scheduler.queuePosition).toBeUndefined();
}, 30_000);

test("slot queueing: admitted investigation objectives do not count against delivery queue position", async () => {
  const dataDir = await createTempDir("slots-investigation-queue-order");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const firstDelivery = await service.createObjective({
    title: "First delivery objective",
    prompt: "Hold the repo slot with delivery work.",
    checks: ["true"],
  });
  const investigation = await service.createObjective({
    title: "Parallel investigation",
    prompt: "Inspect AWS usage while delivery is active.",
    objectiveMode: "investigation",
    checks: ["true"],
  });
  const secondDelivery = await service.createObjective({
    title: "Second delivery objective",
    prompt: "Wait only behind delivery work.",
    checks: ["true"],
  });

  expect(firstDelivery.scheduler.slotState).toBe("active");
  expect(investigation.scheduler.slotState).toBe("active");
  expect(secondDelivery.scheduler.slotState).toBe("queued");
  expect(secondDelivery.scheduler.queuePosition).toBe(1);
}, 30_000);

test("slot admission: configured repo slot concurrency admits multiple delivery objectives in parallel", async () => {
  const dataDir = await createTempDir("slots-parallel-delivery");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot, { repoSlotConcurrency: 3 });

  const first = await service.createObjective({ title: "First", prompt: "parallel 1", checks: ["true"] });
  const second = await service.createObjective({ title: "Second", prompt: "parallel 2", checks: ["true"] });
  const third = await service.createObjective({ title: "Third", prompt: "parallel 3", checks: ["true"] });
  const fourth = await service.createObjective({ title: "Fourth", prompt: "parallel 4", checks: ["true"] });

  expect(first.scheduler.slotState).toBe("active");
  expect(second.scheduler.slotState).toBe("active");
  expect(third.scheduler.slotState).toBe("active");
  expect(fourth.scheduler.slotState).toBe("queued");
  expect(fourth.scheduler.queuePosition).toBe(1);

  await emitEvent(service, first.objectiveId, {
    type: "objective.completed",
    objectiveId: first.objectiveId,
    summary: "done",
    completedAt: Date.now(),
  });
  await service.reactObjective(first.objectiveId);

  const admittedFourth = await service.getObjective(fourth.objectiveId);
  expect(admittedFourth.scheduler.slotState).toBe("active");
  expect(admittedFourth.scheduler.queuePosition).toBeUndefined();
}, 30_000);

// ---------------------------------------------------------------------------
// Queue ordering: FIFO is preserved at any scale
// ---------------------------------------------------------------------------

test("queue ordering: 10 objectives maintain strict FIFO queue positions", async () => {
  const dataDir = await createTempDir("slots-fifo-10");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const objectives = [];
  for (let i = 0; i < 10; i++) {
    objectives.push(
      await service.createObjective({ title: `Obj-${i}`, prompt: `task ${i}`, checks: ["true"] }),
    );
  }

  expect(objectives[0].scheduler.slotState).toBe("active");
  for (let i = 1; i < 10; i++) {
    expect(objectives[i].scheduler.slotState).toBe("queued");
    expect(objectives[i].scheduler.queuePosition).toBe(i);
    expect(objectives[i].phase).toBe("waiting_for_slot");
  }
}, 30_000);

test("queue ordering: 50 objectives queue and first holds the slot", async () => {
  const dataDir = await createTempDir("slots-fifo-50");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const ids: string[] = [];
  for (let i = 0; i < 50; i++) {
    const obj = await service.createObjective({ title: `Obj-${i}`, prompt: `task ${i}`, checks: ["true"] });
    ids.push(obj.objectiveId);
  }

  const first = await service.getObjective(ids[0]);
  expect(first.scheduler.slotState).toBe("active");

  const last = await service.getObjective(ids[49]);
  expect(last.scheduler.slotState).toBe("queued");
  expect(last.scheduler.queuePosition).toBe(49);
  expect(last.phase).toBe("waiting_for_slot");
}, 60_000);

test("queue ordering: 100 objectives queue with correct FIFO and slot passes forward on cancel", async () => {
  const dataDir = await createTempDir("slots-fifo-100");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const ids: string[] = [];
  for (let i = 0; i < 100; i++) {
    const obj = await service.createObjective({ title: `Obj-${i}`, prompt: `task ${i}`, checks: ["true"] });
    ids.push(obj.objectiveId);
  }

  const first = await service.getObjective(ids[0]);
  expect(first.scheduler.slotState).toBe("active");

  for (let i = 1; i < 100; i++) {
    const obj = await service.getObjective(ids[i]);
    expect(obj.scheduler.slotState).toBe("queued");
  }

  await service.cancelObjective(ids[0], "done");
  const second = await service.getObjective(ids[1]);
  expect(second.scheduler.slotState).toBe("active");

  const third = await service.getObjective(ids[2]);
  expect(third.scheduler.slotState).toBe("queued");
  expect(third.scheduler.queuePosition).toBe(1);
}, 120_000);

// ---------------------------------------------------------------------------
// Cascading slot admission: slot passes through a chain of objectives
// ---------------------------------------------------------------------------

test("cascading admission: slot passes through 5 objectives as each completes", async () => {
  const dataDir = await createTempDir("slots-cascade-5");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const obj = await service.createObjective({ title: `Cascade-${i}`, prompt: `cascade ${i}`, checks: ["true"] });
    ids.push(obj.objectiveId);
  }

  for (let i = 0; i < 4; i++) {
    const active = await service.getObjective(ids[i]);
    expect(active.scheduler.slotState).toBe("active");

    await emitEvent(service, ids[i], {
      type: "objective.completed", objectiveId: ids[i],
      summary: `completed ${i}`, completedAt: Date.now(),
    });
    await service.reactObjective(ids[i]);

    const next = await service.getObjective(ids[i + 1]);
    expect(next.scheduler.slotState).toBe("active");
  }

  const last = await service.getObjective(ids[4]);
  expect(last.scheduler.slotState).toBe("active");
}, 30_000);

test("cascading admission: slot passes through mixed cancel/block/complete transitions", async () => {
  const dataDir = await createTempDir("slots-cascade-mixed");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const obj = await service.createObjective({ title: `Mixed-${i}`, prompt: `mixed ${i}`, checks: ["true"] });
    ids.push(obj.objectiveId);
  }

  // 0: cancel
  await service.cancelObjective(ids[0], "cancel test");
  expect((await service.getObjective(ids[1])).scheduler.slotState).toBe("active");

  // 1: block
  await emitEvent(service, ids[1], {
    type: "objective.blocked", objectiveId: ids[1],
    reason: "blocked", summary: "blocked", blockedAt: Date.now(),
  });
  await service.reactObjective(ids[1]);
  expect((await service.getObjective(ids[2])).scheduler.slotState).toBe("active");

  // 2: fail
  await emitEvent(service, ids[2], {
    type: "objective.failed", objectiveId: ids[2],
    reason: "failed", failedAt: Date.now(),
  });
  await service.reactObjective(ids[2]);
  expect((await service.getObjective(ids[3])).scheduler.slotState).toBe("active");

  // 3: complete
  await emitEvent(service, ids[3], {
    type: "objective.completed", objectiveId: ids[3],
    summary: "done", completedAt: Date.now(),
  });
  await service.reactObjective(ids[3]);
  expect((await service.getObjective(ids[4])).scheduler.slotState).toBe("active");

  // 4: promote
  await emitEvent(service, ids[4], {
    type: "integration.ready_to_promote", objectiveId: ids[4],
    candidateId: "cand_01", summary: "ready", readyAt: Date.now(),
  });
  await service.reactObjective(ids[4]);
  expect((await service.getObjective(ids[5])).scheduler.slotState).toBe("active");
}, 30_000);

// ---------------------------------------------------------------------------
// Resume: slot rebalancing on startup
// ---------------------------------------------------------------------------

test("resume: rebalanceObjectiveSlots admits next queued after restart", async () => {
  const dataDir = await createTempDir("slots-resume");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const first = await service.createObjective({ title: "First", prompt: "hold", checks: ["true"] });
  const second = await service.createObjective({ title: "Second", prompt: "wait", checks: ["true"] });
  expect(second.scheduler.slotState).toBe("queued");

  await emitEvent(service, first.objectiveId, {
    type: "objective.completed", objectiveId: first.objectiveId,
    summary: "done", completedAt: Date.now(),
  });

  // Simulate restart
  await service.resumeObjectives();

  const refreshed = await service.getObjective(second.objectiveId);
  expect(refreshed.scheduler.slotState).toBe("active");
}, 30_000);

// ---------------------------------------------------------------------------
// Edge cases: empty queue, single objective, all terminal
// ---------------------------------------------------------------------------

test("edge case: single objective gets the active slot immediately", async () => {
  const dataDir = await createTempDir("slots-single");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const only = await service.createObjective({ title: "Only", prompt: "sole", checks: ["true"] });
  expect(only.scheduler.slotState).toBe("active");
  expect(only.phase).not.toBe("waiting_for_slot");
}, 30_000);

test("edge case: completing all objectives leaves no active slot", async () => {
  const dataDir = await createTempDir("slots-all-done");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const obj = await service.createObjective({ title: `Done-${i}`, prompt: `done ${i}`, checks: ["true"] });
    ids.push(obj.objectiveId);
  }

  for (const id of ids) {
    await emitEvent(service, id, {
      type: "objective.completed", objectiveId: id,
      summary: "done", completedAt: Date.now(),
    });
    await service.reactObjective(id);
  }

  for (const id of ids) {
    const obj = await service.getObjective(id);
    expect(obj.status).toBe("completed");
  }
}, 30_000);

test("edge case: archiving the only active objective with queued successors admits the next", async () => {
  const dataDir = await createTempDir("slots-archive-only");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const first = await service.createObjective({ title: "Archive me", prompt: "archive", checks: ["true"] });
  const second = await service.createObjective({ title: "I inherit", prompt: "inherit", checks: ["true"] });
  const third = await service.createObjective({ title: "I wait", prompt: "wait", checks: ["true"] });

  await service.archiveObjective(first.objectiveId);

  const refreshedSecond = await service.getObjective(second.objectiveId);
  expect(refreshedSecond.scheduler.slotState).toBe("active");

  const refreshedThird = await service.getObjective(third.objectiveId);
  expect(refreshedThird.scheduler.slotState).toBe("queued");
  expect(refreshedThird.scheduler.queuePosition).toBe(1);
}, 30_000);

// ---------------------------------------------------------------------------
// Stress: high-volume sequential slot cascading
// ---------------------------------------------------------------------------

test("stress: 20 objectives cascade through the slot via sequential cancels", async () => {
  const dataDir = await createTempDir("slots-stress-20");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    const obj = await service.createObjective({ title: `Stress-${i}`, prompt: `stress ${i}`, checks: ["true"] });
    ids.push(obj.objectiveId);
  }

  for (let i = 0; i < 19; i++) {
    const active = await service.getObjective(ids[i]);
    expect(active.scheduler.slotState).toBe("active");

    await service.cancelObjective(ids[i], `cancel ${i}`);

    const next = await service.getObjective(ids[i + 1]);
    expect(next.scheduler.slotState).toBe("active");
  }

  const last = await service.getObjective(ids[19]);
  expect(last.scheduler.slotState).toBe("active");
  expect(last.status).not.toBe("canceled");
}, 60_000);

// ---------------------------------------------------------------------------
// Queue position invariant: positions always reflect live queue state
// ---------------------------------------------------------------------------

test("queue positions: positions recalculate after slot release", async () => {
  const dataDir = await createTempDir("slots-positions");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const obj = await service.createObjective({ title: `Pos-${i}`, prompt: `pos ${i}`, checks: ["true"] });
    ids.push(obj.objectiveId);
  }

  // positions: [active, 1, 2, 3, 4]
  expect((await service.getObjective(ids[1])).scheduler.queuePosition).toBe(1);
  expect((await service.getObjective(ids[4])).scheduler.queuePosition).toBe(4);

  await service.cancelObjective(ids[0], "free slot");

  // after: [active(was 1), 1(was 2), 2(was 3), 3(was 4)]
  expect((await service.getObjective(ids[1])).scheduler.slotState).toBe("active");
  expect((await service.getObjective(ids[2])).scheduler.queuePosition).toBe(1);
  expect((await service.getObjective(ids[3])).scheduler.queuePosition).toBe(2);
  expect((await service.getObjective(ids[4])).scheduler.queuePosition).toBe(3);
}, 30_000);

// ---------------------------------------------------------------------------
// Idempotency: multiple rebalances don't duplicate admissions
// ---------------------------------------------------------------------------

test("idempotency: calling rebalance repeatedly yields the same active slot", async () => {
  const dataDir = await createTempDir("slots-idempotent");
  const repoRoot = await createSourceRepo();
  const service = createService(dataDir, repoRoot);

  const first = await service.createObjective({ title: "First", prompt: "hold", checks: ["true"] });
  const second = await service.createObjective({ title: "Second", prompt: "wait", checks: ["true"] });

  // Multiple resumes should not change anything
  await service.resumeObjectives();
  await service.resumeObjectives();
  await service.resumeObjectives();

  expect((await service.getObjective(first.objectiveId)).scheduler.slotState).toBe("active");
  expect((await service.getObjective(second.objectiveId)).scheduler.slotState).toBe("queued");
}, 30_000);
