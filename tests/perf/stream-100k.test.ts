import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { createRuntime } from "@receipt/core/runtime";
import { receipt } from "@receipt/core/chain";
import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { getReceiptDb } from "../../src/db/client";

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

type PerfEvent = { readonly type: "tick"; readonly seq: number };
type PerfCmd = {
  readonly type: "emit";
  readonly event: PerfEvent;
  readonly eventId: string;
};

const nowMs = (): number => performance.now();

test("perf: sqlite receipt store replays 100k receipts without timing out", async () => {
  const dataDir = await createTempDir("receipt-perf-100k");
  try {
    const store = jsonlStore<PerfEvent>(dataDir);
    const runtime = createRuntime<PerfCmd, PerfEvent, { readonly count: number }>(
      store,
      jsonBranchStore(dataDir),
      (cmd) => [cmd.event],
      (state) => ({ count: state.count + 1 }),
      { count: 0 }
    );

    const stream = "perf";
    const total = 100_000;
    const db = getReceiptDb(dataDir);
    let prev: string | undefined;
    const startedAt = Date.now();
    const insert = db.sqlite.query(`
      INSERT INTO receipts (
        stream,
        stream_seq,
        receipt_id,
        ts,
        prev_hash,
        hash,
        event_type,
        body_json,
        hints_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertStream = db.sqlite.query(`
      INSERT INTO streams (name, head_hash, receipt_count, updated_at, last_ts)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        head_hash = excluded.head_hash,
        receipt_count = excluded.receipt_count,
        updated_at = excluded.updated_at,
        last_ts = excluded.last_ts
    `);
    const seed = db.sqlite.transaction(() => {
      for (let i = 0; i < total; i += 1) {
        const r = receipt(stream, prev, { type: "tick", seq: i }, startedAt + i);
        insert.run(
          stream,
          i + 1,
          r.id,
          r.ts,
          r.prev ?? null,
          r.hash,
          r.body.type,
          JSON.stringify(r.body),
          null,
        );
        prev = r.hash;
      }
      upsertStream.run(stream, prev ?? null, total, Date.now(), startedAt + total - 1);
    });
    seed();

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

    expect(headMs < 500).toBeTruthy();
    expect(countMs < 500).toBeTruthy();
    expect(stateMs < 2000).toBeTruthy();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 240_000);
