import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRuntime } from "@receipt/core/runtime";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { type JobBackend } from "../../src/adapters/job-backend";
import { jsonlQueue } from "../../src/adapters/jsonl-queue";
import { resonateJobBackend } from "../../src/adapters/resonate-job-backend";
import { createResonateDriverStarter } from "../../src/adapters/resonate-runtime";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const makeBackend = async (dir: string): Promise<JobBackend> => {
  const runtime = createRuntime<JobCmd, JobEvent, JobState>(
    jsonlStore<JobEvent>(dir),
    jsonBranchStore(dir),
    decideJob,
    reduceJob,
    initialJob,
  );
  return jsonlQueue({ runtime, stream: "jobs" });
};

test("resonate job backend: dispatches newly enqueued jobs", async () => {
  const dir = await mkTmp("receipt-resonate-backend-dispatch");
  try {
    const base = await makeBackend(dir);
    const dispatched: string[] = [];
    const backend = resonateJobBackend({
      base,
      startDriver: async (job) => {
        dispatched.push(job.id);
      },
    });

    const created = await backend.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r_dispatch" },
      maxAttempts: 1,
    });

    expect(dispatched).toEqual([created.id]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resonate job backend: skips driver dispatch when steer singleton reuses an active job", async () => {
  const dir = await mkTmp("receipt-resonate-backend-steer");
  try {
    const base = await makeBackend(dir);
    const dispatched: string[] = [];
    const backend = resonateJobBackend({
      base,
      startDriver: async (job) => {
        dispatched.push(job.id);
      },
    });

    const first = await backend.enqueue({
      agentId: "writer",
      sessionKey: "chat:1",
      singletonMode: "allow",
      payload: { kind: "writer.run", runId: "r_first" },
      maxAttempts: 1,
    });
    const second = await backend.enqueue({
      agentId: "writer",
      sessionKey: "chat:1",
      singletonMode: "steer",
      payload: { kind: "writer.run", runId: "r_second" },
      maxAttempts: 1,
    });

    expect(second.id).toBe(first.id);
    expect(dispatched).toEqual([first.id]);
    const commands = await backend.consumeCommands(first.id, ["steer"]);
    expect(commands).toHaveLength(1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resonate driver starter: submits the driver as a targeted durable rpc", async () => {
  const beginRpcCalls: Array<{
    readonly id: string;
    readonly name: string;
    readonly payload: Record<string, unknown>;
    readonly options: Record<string, unknown>;
  }> = [];
  const client = {
    beginRpc: async (id: string, name: string, payload: Record<string, unknown>, options: Record<string, unknown>) => {
      beginRpcCalls.push({ id, name, payload, options });
      return {
        id,
        result: async () => undefined,
        done: async () => true,
      };
    },
    options: (opts?: Record<string, unknown>) => opts ?? {},
  };
  const startDriver = createResonateDriverStarter(client);

  await startDriver({
    id: "job_driver_1",
    agentId: "writer",
    lane: "collect",
    payload: { kind: "writer.run" },
    status: "queued",
    attempt: 0,
    maxAttempts: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    commands: [],
  });

  expect(beginRpcCalls).toHaveLength(1);
  expect(beginRpcCalls[0]?.id).toBe("job_driver_1");
  expect(beginRpcCalls[0]?.name).toBe("receipt.job.driver");
  expect(beginRpcCalls[0]?.payload.jobId).toBe("job_driver_1");
});
