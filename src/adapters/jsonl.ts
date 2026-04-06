import type { Branch, BranchStore, Chain, Receipt, Store } from "@receipt/core/types";
import { receipt } from "@receipt/core/chain";
import { asc, desc, eq } from "drizzle-orm";

import { getReceiptDb, listStreamsByPrefix } from "../db/client";
import { jsonParse, jsonParseOptional, jsonStringify, jsonStringifyOptional } from "../db/json";
import * as schema from "../db/schema";
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
  readonly receiptId: string;
  readonly ts: number;
  readonly stream: string;
  readonly prevHash: string | null;
  readonly bodyJson: string;
  readonly hash: string;
  readonly hintsJson: string | null;
}): Receipt<B> => ({
  id: row.receiptId,
  ts: Number(row.ts),
  stream: row.stream,
  prev: row.prevHash ?? undefined,
  body: jsonParse<B>(row.bodyJson, {} as B),
  hash: row.hash,
  hints: jsonParseOptional<Record<string, unknown>>(row.hintsJson),
});

const rowToBranch = (row: {
  readonly name: string;
  readonly parent: string | null;
  readonly forkAt: number | null;
  readonly createdAt: number;
}): Branch => ({
  name: row.name,
  parent: row.parent ?? undefined,
  forkAt: row.forkAt ?? undefined,
  createdAt: Number(row.createdAt),
});

export const jsonlStore = <B>(dir: string): Store<B> => {
  const db = getReceiptDb(dir);

  const readRows = (stream: string, limit?: number): Chain<B> => {
    const base = db.orm.select({
      receiptId: schema.receipts.receiptId,
      ts: schema.receipts.ts,
      stream: schema.receipts.stream,
      prevHash: schema.receipts.prevHash,
      bodyJson: schema.receipts.bodyJson,
      hash: schema.receipts.hash,
      hintsJson: schema.receipts.hintsJson,
    })
      .from(schema.receipts)
      .where(eq(schema.receipts.stream, stream))
      .orderBy(asc(schema.receipts.streamSeq));
    const rows = db.read(() => (limit === undefined ? base.all() : base.limit(limit).all()));
    return rows.map((row) => rowToReceipt<B>(row));
  };

  return {
    append: async function append(r, expectedPrev) {
      const physicalPrev = expectedPrev ?? r.prev;
      const eventType = asEventType(r.body);
      db.transaction((tx) => {
        const current = tx.select({
          headHash: schema.streams.headHash,
          receiptCount: schema.streams.receiptCount,
        })
          .from(schema.streams)
          .where(eq(schema.streams.name, r.stream))
          .get();
        const headHash = current?.headHash ?? undefined;
        if (headHash !== physicalPrev) {
          throw new Error(`Expected prev hash ${physicalPrev ?? "undefined"} but head is ${headHash ?? "undefined"}`);
        }
        const nextStreamSeq = Number(current?.receiptCount ?? 0) + 1;
        const globalSeqRow = tx.insert(schema.receipts)
          .values({
            stream: r.stream,
            streamSeq: nextStreamSeq,
            receiptId: r.id,
            ts: r.ts,
            prevHash: r.prev ?? null,
            hash: r.hash,
            eventType,
            bodyJson: jsonStringify(r.body),
            hintsJson: jsonStringifyOptional(r.hints),
          })
          .returning({ id: schema.receipts.globalSeq })
          .get();
        const updatedAt = Date.now();
        tx.insert(schema.streams)
          .values({
            name: r.stream,
            headHash: r.hash,
            receiptCount: nextStreamSeq,
            updatedAt,
            lastTs: r.ts,
          })
          .onConflictDoUpdate({
            target: schema.streams.name,
            set: {
              headHash: r.hash,
              receiptCount: nextStreamSeq,
              updatedAt,
              lastTs: r.ts,
            },
          })
          .run();
        if (r.stream === BRANCH_META_STREAM && eventType === BRANCH_META_EVENT) {
          const event = r.body as BranchMetaEvent;
          tx.insert(schema.branches)
            .values({
              name: event.branch.name,
              parent: event.branch.parent ?? null,
              forkAt: event.branch.forkAt ?? null,
              createdAt: event.branch.createdAt,
            })
            .onConflictDoUpdate({
              target: schema.branches.name,
              set: {
                parent: event.branch.parent ?? null,
                forkAt: event.branch.forkAt ?? null,
                createdAt: event.branch.createdAt,
              },
            })
            .run();
        }
        tx.insert(schema.changeLog)
          .values({
            globalSeq: globalSeqRow.id,
            stream: r.stream,
            eventType,
            changedAt: Date.now(),
          })
          .run();
      });
    },

    read: async (stream) => readRows(stream),

    take: async (stream, n) => readRows(stream, Math.max(0, n)),

    count: async (stream) => {
      const row = db.read(() => db.orm.select({
        receiptCount: schema.streams.receiptCount,
      })
        .from(schema.streams)
        .where(eq(schema.streams.name, stream))
        .get());
      return Number(row?.receiptCount ?? 0);
    },

    head: async (stream) => {
      const row = db.read(() => db.orm.select({
        receiptId: schema.receipts.receiptId,
        ts: schema.receipts.ts,
        stream: schema.receipts.stream,
        prevHash: schema.receipts.prevHash,
        bodyJson: schema.receipts.bodyJson,
        hash: schema.receipts.hash,
        hintsJson: schema.receipts.hintsJson,
      })
        .from(schema.receipts)
        .where(eq(schema.receipts.stream, stream))
        .orderBy(desc(schema.receipts.streamSeq))
        .limit(1)
        .get());
      return row ? rowToReceipt<B>(row) : undefined;
    },

    version: async (stream) => {
      const row = db.read(() => db.orm.select({
        receiptCount: schema.streams.receiptCount,
        headHash: schema.streams.headHash,
      })
        .from(schema.streams)
        .where(eq(schema.streams.name, stream))
        .get());
      return row ? `${Number(row.receiptCount)}:${row.headHash ?? ""}` : undefined;
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
      const row = db.read(() => db.orm.select({
        name: schema.branches.name,
        parent: schema.branches.parent,
        forkAt: schema.branches.forkAt,
        createdAt: schema.branches.createdAt,
      })
        .from(schema.branches)
        .where(eq(schema.branches.name, name))
        .get());
      return row ? rowToBranch(row) : undefined;
    },
    list: async () => {
      const rows = db.read(() => db.orm.select({
        name: schema.branches.name,
        parent: schema.branches.parent,
        forkAt: schema.branches.forkAt,
        createdAt: schema.branches.createdAt,
      })
        .from(schema.branches)
        .orderBy(asc(schema.branches.name))
        .all());
      return rows.map((row) => rowToBranch(row));
    },
    children: async (parent) => {
      const rows = db.read(() => db.orm.select({
        name: schema.branches.name,
        parent: schema.branches.parent,
        forkAt: schema.branches.forkAt,
        createdAt: schema.branches.createdAt,
      })
        .from(schema.branches)
        .where(eq(schema.branches.parent, parent))
        .orderBy(asc(schema.branches.name))
        .all());
      return rows.map((row) => rowToBranch(row));
    },
  };
};
