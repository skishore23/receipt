import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
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

const createLockHolderScript = (): string => `
  import { Database } from "bun:sqlite";

  const dbPath = process.env.DB_PATH;
  const holdMs = Number(process.env.HOLD_MS ?? "350");
  if (!dbPath) {
    console.error("missing DB_PATH");
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("BEGIN IMMEDIATE;");
  console.log("LOCKED");
  setTimeout(() => {
    try {
      db.exec("COMMIT;");
      db.close();
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    }
  }, holdMs);
`;

const holdWriterLock = async (
  dbPath: string,
  holdMs = 350,
): Promise<ReturnType<typeof spawn>> => {
  const child = spawn(process.execPath, ["-e", createLockHolderScript()], {
    env: {
      ...process.env,
      DB_PATH: dbPath,
      HOLD_MS: String(holdMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");

  let stdout = "";
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    const onStdout = (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("LOCKED")) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: string) => {
      stderr += chunk;
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`lock-holder exited before taking the writer lock (code ${code ?? "null"}): ${stderr.trim()}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
    child.on("error", onError);
  });

  return child;
};

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

test("durable activity: heartbeat and checkpoint preserve in-flight state before completion", async () => {
  const dir = await mkTmp("receipt-durable-checkpoint");
  try {
    const backend = createLocalDurableBackend({
      dbPath: path.join(dir, "receipt.db"),
    });
    const activity = await backend.runDurableActivity({
      key: codexActivityKey("job_codex_checkpoint"),
      input: { jobId: "job_codex_checkpoint" },
      run: async (controller) => {
        await controller?.heartbeat({ phase: "running" });
        await controller?.checkpoint(
          {
            evidenceStatePath: "/tmp/task_01.evidence-state.json",
            evidenceCount: 2,
          },
          {
            phase: "collecting_evidence",
          },
        );
        return { status: "completed", summary: "checkpointed" };
      },
    });

    expect(activity.snapshot.status).toBe("completed");
    expect(activity.snapshot.lastHeartbeatAt).toBeDefined();
    expect(activity.snapshot.checkpointRevision).toBe(1);
    expect(activity.snapshot.checkpointOutput?.evidenceCount).toBe(2);
    expect(activity.snapshot.checkpointMetadata?.phase).toBe("collecting_evidence");
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

test("durable backend: workflow status updates survive a transient writer lock", async () => {
  const dir = await mkTmp("receipt-durable-lock-retry");
  let lockHolder: ReturnType<typeof spawn> | undefined;
  try {
    const dbPath = path.join(dir, "receipt.db");
    const backend = createLocalDurableBackend({
      dbPath,
      busyTimeoutMs: 1,
    });
    const started = await backend.startOrResumeWorkflow({
      key: "factory/objective/objective_lock/control",
      input: { objectiveId: "objective_lock", reason: "startup" },
    });

    lockHolder = await holdWriterLock(dbPath);
    await expect(backend.setWorkflowStatus({
      key: started.key,
      status: "running",
      metadata: { phase: "resume" },
    })).resolves.toMatchObject({
      key: started.key,
      status: "running",
      metadata: { phase: "resume" },
    });

    const [code] = await once(lockHolder, "exit");
    expect(code).toBe(0);
  } finally {
    if (lockHolder?.exitCode === null) {
      lockHolder.kill("SIGKILL");
      await once(lockHolder, "exit").catch(() => undefined);
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
