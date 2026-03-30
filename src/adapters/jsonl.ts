import type { Branch, BranchStore, Chain, Receipt, Store } from "@receipt/core/types";
import { receipt } from "@receipt/core/chain";

import { getReceiptDb, listStreamsByPrefix } from "../db/client";
import { jsonParse, jsonParseOptional, jsonStringify, jsonStringifyOptional } from "../db/json";
import type { BranchMetaEvent } from "../modules/branch-meta";

const BRANCH_META_STREAM = "__meta/branches";
const BRANCH_META_EVENT = "branch.meta.upsert";

const asEventType = (body: unknown): string => {
  if (body && typeof body === "object" && !Array.isArray(body) && typeof (body as { readonly type?: unknown }).type === "string") {
    return (body as { readonly type: string }).type;
  }
  return "receipt";
};

const rowToReceipt = <B>(row: {
  readonly receipt_id: string;
  readonly ts: number;
  readonly stream: string;
  readonly prev_hash: string | null;
  readonly body_json: string;
  readonly hash: string;
  readonly hints_json: string | null;
}): Receipt<B> => ({
  id: row.receipt_id,
  ts: Number(row.ts),
  stream: row.stream,
  prev: row.prev_hash ?? undefined,
  body: jsonParse<B>(row.body_json, {} as B),
  hash: row.hash,
  hints: jsonParseOptional<Record<string, unknown>>(row.hints_json),
});

export const jsonlStore = <B>(dir: string): Store<B> => {
  const db = getReceiptDb(dir);

  const readRows = (stream: string, limit?: number): Chain<B> => {
    const query = limit === undefined
      ? db.sqlite.query(`
          SELECT receipt_id, ts, stream, prev_hash, body_json, hash, hints_json
          FROM receipts
          WHERE stream = ?
          ORDER BY stream_seq ASC
        `)
      : db.sqlite.query(`
          SELECT receipt_id, ts, stream, prev_hash, body_json, hash, hints_json
          FROM receipts
          WHERE stream = ?
          ORDER BY stream_seq ASC
          LIMIT ?
        `);
    const rows = (limit === undefined ? query.all(stream) : query.all(stream, limit)) as Array<{
      readonly receipt_id: string;
      readonly ts: number;
      readonly stream: string;
      readonly prev_hash: string | null;
      readonly body_json: string;
      readonly hash: string;
      readonly hints_json: string | null;
    }>;
    return rows.map((row) => rowToReceipt<B>(row));
  };

  return {
    append: async function append(r, expectedPrev) {
      const physicalPrev = expectedPrev ?? r.prev;
      const eventType = asEventType(r.body);
      const tx = db.sqlite.transaction(() => {
        const current = db.sqlite.query(`
          SELECT head_hash, receipt_count
          FROM streams
          WHERE name = ?
        `).get(r.stream) as { readonly head_hash: string | null; readonly receipt_count: number } | null;
        const headHash = current?.head_hash ?? undefined;
        if (headHash !== physicalPrev) {
          throw new Error(`Expected prev hash ${physicalPrev ?? "undefined"} but head is ${headHash ?? "undefined"}`);
        }
        const nextStreamSeq = Number(current?.receipt_count ?? 0) + 1;
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
          r.stream,
          nextStreamSeq,
          r.id,
          r.ts,
          r.prev ?? null,
          r.hash,
          eventType,
          jsonStringify(r.body),
          jsonStringifyOptional(r.hints),
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
          r.stream,
          r.hash,
          nextStreamSeq,
          Date.now(),
          r.ts,
        );
        if (r.stream === BRANCH_META_STREAM && eventType === BRANCH_META_EVENT) {
          const event = r.body as BranchMetaEvent;
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
        `).run(globalSeqRow.id, r.stream, eventType, Date.now());
      });
      tx();
    },

    read: async (stream) => readRows(stream),

    take: async (stream, n) => readRows(stream, Math.max(0, n)),

    count: async (stream) => {
      const row = db.sqlite.query(`
        SELECT receipt_count
        FROM streams
        WHERE name = ?
      `).get(stream) as { readonly receipt_count: number } | null;
      return Number(row?.receipt_count ?? 0);
    },

    head: async (stream) => {
      const row = db.sqlite.query(`
        SELECT receipt_id, ts, stream, prev_hash, body_json, hash, hints_json
        FROM receipts
        WHERE stream = ?
        ORDER BY stream_seq DESC
        LIMIT 1
      `).get(stream) as {
        readonly receipt_id: string;
        readonly ts: number;
        readonly stream: string;
        readonly prev_hash: string | null;
        readonly body_json: string;
        readonly hash: string;
        readonly hints_json: string | null;
      } | null;
      return row ? rowToReceipt<B>(row) : undefined;
    },

    version: async (stream) => {
      const row = db.sqlite.query(`
        SELECT receipt_count, head_hash
        FROM streams
        WHERE name = ?
      `).get(stream) as { readonly receipt_count: number; readonly head_hash: string | null } | null;
      return row ? `${Number(row.receipt_count)}:${row.head_hash ?? ""}` : undefined;
    },

    listStreams: async (prefix) => listStreamsByPrefix(db, prefix),
  };
};

export const jsonBranchStore = (dir: string): BranchStore => {
  const store = jsonlStore<BranchMetaEvent>(dir);
  const db = getReceiptDb(dir);
  let queue = Promise.resolve();

  const save = async (branch: Branch): Promise<void> => {
    const next = queue.then(async () => {
      const prev = (await store.head(BRANCH_META_STREAM))?.hash;
      await store.append(receipt(BRANCH_META_STREAM, prev, {
        type: BRANCH_META_EVENT,
        branch,
      }), prev);
    });
    queue = next.then(() => undefined, () => undefined);
    await next;
  };

  return {
    save,
    get: async (name) => {
      const row = db.sqlite.query(`
        SELECT name, parent, fork_at, created_at
        FROM branches
        WHERE name = ?
      `).get(name) as {
        readonly name: string;
        readonly parent: string | null;
        readonly fork_at: number | null;
        readonly created_at: number;
      } | null;
      return row
        ? {
            name: row.name,
            parent: row.parent ?? undefined,
            forkAt: row.fork_at ?? undefined,
            createdAt: Number(row.created_at),
          }
        : undefined;
    },
    list: async () => {
      const rows = db.sqlite.query(`
        SELECT name, parent, fork_at, created_at
        FROM branches
        ORDER BY name ASC
      `).all() as Array<{
        readonly name: string;
        readonly parent: string | null;
        readonly fork_at: number | null;
        readonly created_at: number;
      }>;
      return rows.map((row) => ({
        name: row.name,
        parent: row.parent ?? undefined,
        forkAt: row.fork_at ?? undefined,
        createdAt: Number(row.created_at),
      }));
    },
    children: async (parent) => {
      const rows = db.sqlite.query(`
        SELECT name, parent, fork_at, created_at
        FROM branches
        WHERE parent = ?
        ORDER BY name ASC
      `).all(parent) as Array<{
        readonly name: string;
        readonly parent: string | null;
        readonly fork_at: number | null;
        readonly created_at: number;
      }>;
      return rows.map((row) => ({
        name: row.name,
        parent: row.parent ?? undefined,
        forkAt: row.fork_at ?? undefined,
        createdAt: Number(row.created_at),
      }));
    },
  };
};
