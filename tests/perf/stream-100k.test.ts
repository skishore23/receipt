import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { createRuntime } from "../../src/core/runtime.ts";
import { receipt } from "../../src/core/chain.ts";
import { createStreamLocator, jsonBranchStore } from "../../src/adapters/jsonl.ts";
import { jsonlIndexedStore } from "../../src/adapters/jsonl-indexed.ts";

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

type PerfEvent = { readonly type: "tick"; readonly seq: number };
type PerfCmd = {
  readonly type: "emit";
  readonly event: PerfEvent;
  readonly eventId: string;
};

const nowMs = (): number => performance.now();

test("perf: indexed store handles 100k receipts with bounded latencies", async () => {
  const dataDir = await createTempDir("receipt-perf-100k");
  try {
    const store = jsonlIndexedStore<PerfEvent>(dataDir);
    const locator = createStreamLocator(dataDir);
    const runtime = createRuntime<PerfCmd, PerfEvent, { readonly count: number }>(
      store,
      jsonBranchStore(dataDir),
      (cmd) => [cmd.event],
      (state) => ({ count: state.count + 1 }),
      { count: 0 }
    );

    const stream = "perf";
    const total = 100_000;
    const file = await locator.fileFor(stream);
    let prev: string | undefined;
    let output = "";
    for (let i = 0; i < total; i += 1) {
      const r = receipt(stream, prev, { type: "tick", seq: i }, Date.now() + i);
      output += `${JSON.stringify(r)}\n`;
      prev = r.hash;
    }
    await fs.writeFile(file, output, "utf-8");
    await store.count(stream); // warm index build before latency checks

    const headStart = nowMs();
    const head = await store.head(stream);
    const headMs = nowMs() - headStart;

    const countStart = nowMs();
    const count = await store.count(stream);
    const countMs = nowMs() - countStart;

    const stateStart = nowMs();
    const state = await runtime.state(stream);
    const stateMs = nowMs() - stateStart;

    expect(head).toBeTruthy();
    expect(count).toBe(total);
    expect(state.count).toBe(total);

    expect(headMs < 10).toBeTruthy();
    expect(countMs < 10).toBeTruthy();
    expect(stateMs < 2000).toBeTruthy();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 240_000);
