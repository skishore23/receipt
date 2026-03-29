import { test, expect } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { createRuntime } from "@receipt/core/runtime";
import { receipt } from "@receipt/core/chain";

type CounterCmd = {
  readonly type: "counter.inc";
  readonly seq: number;
};

type CounterEvent = CounterCmd;

type CounterState = {
  readonly count: number;
};

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("smoke: single-stream concurrent writes preserve integrity", async () => {
  const dataDir = await createTempDir("receipt-smoke-integrity");

  try {
    const store = jsonlStore<CounterEvent>(dataDir);
    const branchStore = jsonBranchStore(dataDir);
    const runtime = createRuntime<CounterCmd, CounterEvent, CounterState>(
      store,
      branchStore,
      (cmd) => [cmd],
      (state) => ({ count: state.count + 1 }),
      { count: 0 }
    );

    const stream = "integrity";
    const writes = 200;

    await Promise.all(
      Array.from({ length: writes }, (_unused, seq) =>
        runtime.execute(stream, { type: "counter.inc", seq })
      )
    );

    const chain = await runtime.chain(stream);
    expect(chain.length).toBe(writes);

    const result = await runtime.verify(stream);
    expect(result.ok).toBe(true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 120_000);

test("smoke: reducer rejections do not append invalid receipts", async () => {
  const dataDir = await createTempDir("receipt-smoke-invalid-reducer");

  try {
    const store = jsonlStore<CounterEvent>(dataDir);
    const branchStore = jsonBranchStore(dataDir);
    const runtime = createRuntime<CounterCmd, CounterEvent, CounterState>(
      store,
      branchStore,
      (cmd) => [cmd],
      (state, event) => {
        if (event.seq === 2) {
          throw new Error("reject seq 2");
        }
        return { count: state.count + 1 };
      },
      { count: 0 }
    );

    await runtime.execute("integrity", { type: "counter.inc", seq: 1 });
    await expect(runtime.execute("integrity", { type: "counter.inc", seq: 2 })).rejects.toThrow("reject seq 2");

    const chain = await runtime.chain("integrity");
    const state = await runtime.state("integrity");

    expect(chain).toHaveLength(1);
    expect(chain[0]?.body.seq).toBe(1);
    expect(state.count).toBe(1);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("smoke: stream discovery reads known streams from SQLite metadata", async () => {
  const dataDir = await createTempDir("receipt-smoke-stream-discovery");

  try {
    const store = jsonlStore<CounterEvent>(dataDir);
    await store.append(receipt("factory/objectives/objective_alpha", undefined, { type: "counter.inc", seq: 1 }), undefined);
    await store.append(receipt("agents/factory-chat/generalist/chats/chat_01/objectives/objective_alpha/runs/run_01", undefined, { type: "counter.inc", seq: 2 }), undefined);
    const discovered = await store.listStreams?.();

    expect(discovered).toContain("factory/objectives/objective_alpha");
    expect(discovered).toContain("agents/factory-chat/generalist/chats/chat_01/objectives/objective_alpha/runs/run_01");
    expect(discovered).toHaveLength(2);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
