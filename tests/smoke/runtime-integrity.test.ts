import { test, expect } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { createStreamLocator, jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
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

test("smoke: stream discovery repairs a truncated manifest from existing jsonl files", async () => {
  const dataDir = await createTempDir("receipt-smoke-manifest-repair");

  try {
    const store = jsonlStore<CounterEvent>(dataDir);
    await store.append(receipt("factory/objectives/objective_alpha", undefined, { type: "counter.inc", seq: 1 }), undefined);
    await store.append(receipt("agents/factory-chat/generalist/chats/chat_01/objectives/objective_alpha/runs/run_01", undefined, { type: "counter.inc", seq: 2 }), undefined);

    const manifestPath = path.join(dataDir, "_streams.json");
    const raw = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
      readonly byStream?: Record<string, string>;
      readonly byKey?: Record<string, string>;
    };
    const keptStream = "factory/objectives/objective_alpha";
    const keptKey = raw.byStream?.[keptStream];
    expect(keptKey).toBeTruthy();

    await fs.writeFile(manifestPath, JSON.stringify({
      version: 1,
      byStream: keptKey ? { [keptStream]: keptKey } : {},
      byKey: keptKey ? { [keptKey]: keptStream } : {},
    }, null, 2), "utf-8");

    const locator = createStreamLocator(dataDir);
    const repaired = await locator.listStreams();

    expect(repaired).toContain("factory/objectives/objective_alpha");
    expect(repaired).toContain("agents/factory-chat/generalist/chats/chat_01/objectives/objective_alpha/runs/run_01");

    const repairedManifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
      readonly byStream?: Record<string, string>;
    };
    expect(Object.keys(repairedManifest.byStream ?? {})).toHaveLength(2);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
