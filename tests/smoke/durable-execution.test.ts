import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRuntime } from "@receipt/core/runtime";
import {
  createLocalDurableBackend,
  createResonateDurableBackend,
} from "@receipt/durable";

import { sqliteBranchStore, sqliteReceiptStore } from "../../src/adapters/sqlite";
import { sqliteQueue } from "../../src/adapters/sqlite-queue";
import {
  codexActivityKey,
  createDurableQueueBackend,
  runWorkflowKey,
} from "../../src/lib/durable-execution";
import {
  decide as decideJob,
  initial as initialJob,
  reduce as reduceJob,
  type JobCmd,
  type JobEvent,
  type JobState,
} from "../../src/modules/job";

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const createQueue = (dir: string) => {
  const runtime = createRuntime<JobCmd, JobEvent, JobState>(
    sqliteReceiptStore<JobEvent>(dir),
    sqliteBranchStore(dir),
    decideJob,
    reduceJob,
    initialJob,
  );
  return sqliteQueue({ runtime, stream: "jobs" });
};

test("durable backend: repeated workflow start reuses the same logical execution and durable signals stay ordered", async () => {
  const dir = await mkTmp("receipt-durable-workflow");
  try {
    const backend = createLocalDurableBackend({
      dbPath: path.join(dir, "receipt.db"),
    });

    const first = await backend.startOrResumeWorkflow({
      key: "factory/objective/objective_1/control",
      input: { objectiveId: "objective_1", reason: "startup" },
    });
    const second = await backend.startOrResumeWorkflow({
      key: "factory/objective/objective_1/control",
      input: { objectiveId: "objective_1", reason: "reconcile" },
    });

    expect(second.key).toBe(first.key);
    expect(second.revision).toBe(first.revision);

    await backend.signalWorkflow({
      key: first.key,
      signal: "steer",
      payload: { message: "Use the helper first." },
    });
    await backend.signalWorkflow({
      key: first.key,
      signal: "follow_up",
      payload: { note: "Then rerun the audit." },
    });

    const signals = await backend.consumeWorkflowSignals({
      key: first.key,
      signals: ["steer", "follow_up"],
    });
    expect(signals.map((signal) => signal.signal)).toEqual([
      "steer",
      "follow_up",
    ]);

    const waited = await backend.waitForWorkflowChange({
      key: first.key,
      sinceRevision: first.revision,
      timeoutMs: 500,
      pollMs: 25,
    });
    expect(waited?.revision).toBeGreaterThan(first.revision);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("durable backend: resonate wrapper preserves local durable semantics", async () => {
  const dir = await mkTmp("receipt-durable-resonate");
  try {
    const local = createLocalDurableBackend({
      dbPath: path.join(dir, "receipt.db"),
    });
    const backend = createResonateDurableBackend({ local });
    const created = await backend.startOrResumeWorkflow({
      key: "factory/objective/objective_2/control",
      input: { objectiveId: "objective_2", reason: "startup" },
    });
    const signaled = await backend.signalWorkflow({
      key: created.key,
      signal: "follow_up",
      payload: { note: "Continue the objective in place." },
    });
    expect(signaled.workflowKey).toBe(created.key);
    const listed = await backend.listWorkflowSignals(created.key);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.signal).toBe("follow_up");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("durable activity: persisted terminal result is recovered instead of rerunning", async () => {
  const dir = await mkTmp("receipt-durable-activity");
  try {
    const backend = createLocalDurableBackend({
      dbPath: path.join(dir, "receipt.db"),
    });
    const resultPath = path.join(dir, "result.json");
    await fs.writeFile(
      resultPath,
      JSON.stringify({ status: "completed", summary: "Recovered from disk." }),
      "utf-8",
    );

    let executed = 0;
    const activity = await backend.runDurableActivity({
      key: codexActivityKey("job_codex_1"),
      input: { jobId: "job_codex_1" },
      recover: async () =>
        JSON.parse(await fs.readFile(resultPath, "utf-8")) as Record<string, unknown>,
      run: async () => {
        executed += 1;
        return { status: "completed", summary: "Executed live." };
      },
    });

    expect(executed).toBe(0);
    expect(activity.result.summary).toBe("Recovered from disk.");
    expect(activity.snapshot.status).toBe("completed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("durable queue wrapper: steer and follow-up are exposed through the queue interface from durable signals", async () => {
  const dir = await mkTmp("receipt-durable-queue");
  try {
    const base = createQueue(dir);
    const durable = createLocalDurableBackend({
      dbPath: path.join(dir, "receipt.db"),
    });
    const queue = createDurableQueueBackend(base, durable);

    const job = await queue.enqueue({
      agentId: "factory",
      lane: "chat",
      payload: {
        kind: "factory.run",
        stream: "agents/factory",
        runId: "run_durable",
        problem: "Investigate the service startup path.",
      },
      maxAttempts: 1,
    });

    const workflow = await durable.getWorkflow(
      runWorkflowKey("agents/factory", "run_durable"),
    );
    expect(workflow?.input?.jobId).toBe(job.id);

    await queue.queueCommand({
      jobId: job.id,
      command: "steer",
      payload: { message: "Stay in the runtime service." },
    });
    await queue.queueCommand({
      jobId: job.id,
      command: "follow_up",
      payload: { note: "Then verify the resume path." },
    });

    const observed = await queue.getJob(job.id);
    expect(observed?.commands.map((command) => command.command)).toEqual([
      "steer",
      "follow_up",
    ]);

    const consumed = await queue.consumeCommands(job.id, [
      "steer",
      "follow_up",
    ]);
    expect(consumed.map((command) => command.command)).toEqual([
      "steer",
      "follow_up",
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
