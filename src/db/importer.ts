import type { Receipt } from "@receipt/core/types";

import { clearReceiptDb, getReceiptDb, hasLegacyJsonlData } from "./client";
import { jsonStringify, jsonStringifyOptional } from "./json";
import { rebuildMemoryProjection, syncChangedChatContextProjections, syncChangedJobProjections, syncChangedObjectiveProjections } from "./projectors";
import { createStreamLocator, jsonlStore as legacyJsonlStore } from "../adapters/legacy-jsonl";
import { jsonBranchStore, jsonlStore } from "../adapters/jsonl";
import { createRuntime } from "@receipt/core/runtime";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../modules/job";
import { decideFactory, reduceFactory } from "../modules/factory/reducer";
import { initialFactoryState } from "../modules/factory/defaults";
import type { FactoryCmd, FactoryEvent } from "../modules/factory/events";
import type { FactoryState } from "../modules/factory/types";

const branchMetaEventType = "branch.meta.upsert";

const insertImportedReceipt = (db: ReturnType<typeof getReceiptDb>, receipt: Receipt<unknown>, streamSeq: number): void => {
  const eventType = receipt.body && typeof receipt.body === "object" && !Array.isArray(receipt.body) && typeof (receipt.body as { readonly type?: unknown }).type === "string"
    ? (receipt.body as { readonly type: string }).type
    : "receipt";
  db.sqlite.query(`
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
  `).run(
    receipt.stream,
    streamSeq,
    receipt.id,
    receipt.ts,
    receipt.prev ?? null,
    receipt.hash,
    eventType,
    jsonStringify(receipt.body),
    jsonStringifyOptional(receipt.hints),
  );
  const globalSeqRow = db.sqlite.query("SELECT last_insert_rowid() AS id").get() as { readonly id: number };
  db.sqlite.query(`
    INSERT INTO streams (name, head_hash, receipt_count, updated_at, last_ts)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      head_hash = excluded.head_hash,
      receipt_count = excluded.receipt_count,
      updated_at = excluded.updated_at,
      last_ts = excluded.last_ts
  `).run(
    receipt.stream,
    receipt.hash,
    streamSeq,
    Date.now(),
    receipt.ts,
  );
  if (receipt.stream === "__meta/branches" && eventType === branchMetaEventType) {
    const event = receipt.body as { readonly branch: { readonly name: string; readonly parent?: string; readonly forkAt?: number; readonly createdAt: number } };
    db.sqlite.query(`
      INSERT INTO branches (name, parent, fork_at, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        parent = excluded.parent,
        fork_at = excluded.fork_at,
        created_at = excluded.created_at
    `).run(
      event.branch.name,
      event.branch.parent ?? null,
      event.branch.forkAt ?? null,
      event.branch.createdAt,
    );
  }
  db.sqlite.query(`
    INSERT INTO change_log (global_seq, stream, event_type, changed_at)
    VALUES (?, ?, ?, ?)
  `).run(globalSeqRow.id, receipt.stream, eventType, Date.now());
};

export const importLegacyJsonlToSqlite = async (input: {
  readonly dataDir: string;
  readonly dbPath?: string;
  readonly forceRebuild?: boolean;
}): Promise<{
  readonly importedStreams: number;
  readonly importedReceipts: number;
  readonly dbPath: string;
}> => {
  if (!hasLegacyJsonlData(input.dataDir)) {
    throw new Error(`no legacy JSONL receipts found under ${input.dataDir}`);
  }
  const db = getReceiptDb(input.dataDir, {
    dbPath: input.dbPath,
    allowLegacyImportHint: true,
  });
  const existingCount = db.sqlite.query("SELECT COUNT(*) AS count FROM receipts").get() as { readonly count: number };
  if (Number(existingCount.count) > 0 && !input.forceRebuild) {
    throw new Error(`SQLite database ${db.path} already contains receipts. Use --force-rebuild to replace it.`);
  }
  if (input.forceRebuild) {
    clearReceiptDb(db);
  }

  const locator = createStreamLocator(input.dataDir);
  const store = legacyJsonlStore<unknown>(input.dataDir);
  const streams = await locator.listStreams();
  let importedReceipts = 0;
  for (const stream of streams) {
    const chain = await store.read(stream);
    const tx = db.sqlite.transaction(() => {
      let streamSeq = 0;
      for (const receipt of chain) {
        streamSeq += 1;
        insertImportedReceipt(db, receipt, streamSeq);
        importedReceipts += 1;
      }
    });
    tx();
  }

  const previousDbPath = process.env.RECEIPT_DB_PATH;
  if (input.dbPath?.trim()) process.env.RECEIPT_DB_PATH = db.path;
  try {
    const jobRuntime = createRuntime<JobCmd, JobEvent, JobState>(
      jsonlStore<JobEvent>(input.dataDir),
      jsonBranchStore(input.dataDir),
      decideJob,
      reduceJob,
      initialJob,
    );
    await syncChangedJobProjections(input.dataDir, jobRuntime);

    const factoryRuntime = createRuntime<FactoryCmd, FactoryEvent, FactoryState>(
      jsonlStore<FactoryEvent>(input.dataDir),
      jsonBranchStore(input.dataDir),
      decideFactory,
      reduceFactory,
      initialFactoryState,
    );
    await syncChangedObjectiveProjections(input.dataDir, factoryRuntime);
    await syncChangedChatContextProjections(input.dataDir);
    await rebuildMemoryProjection(input.dataDir);
  } finally {
    if (input.dbPath?.trim()) {
      if (previousDbPath === undefined) delete process.env.RECEIPT_DB_PATH;
      else process.env.RECEIPT_DB_PATH = previousDbPath;
    }
  }

  return {
    importedStreams: streams.length,
    importedReceipts,
    dbPath: db.path,
  };
};
