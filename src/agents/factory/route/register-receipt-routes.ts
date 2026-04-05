import type { Hono } from "hono";

import type { AgentLoaderContext } from "../../../framework/agent-types";
import { html, parseInspectorDepth, parseLimit, parseOrder } from "../../../framework/http";
import {
  countReceiptsInStream,
  getReceiptDb,
  listReceiptStreams,
  readReceiptsByStream,
} from "../../../db/client";
import {
  buildReceiptTimeline,
  type ReceiptFileInfo,
  type ReceiptRecord,
} from "../../../adapters/receipt-tools";
import {
  receiptFoldsHtml,
  receiptRecordsHtml,
  receiptShell,
  receiptSideHtml,
} from "../../../views/receipt";

export const registerReceiptRoutes = (input: {
  readonly app: Hono;
  readonly ctx: AgentLoaderContext;
}) => {
  const { app, ctx } = input;
  const receiptDb = getReceiptDb(ctx.dataDir);

  const dbStreamsToFileInfo = (streams: ReadonlyArray<{ name: string; receiptCount: number; updatedAt: number }>): ReceiptFileInfo[] =>
    streams.map((stream) => ({
      name: stream.name,
      size: stream.receiptCount,
      mtime: stream.updatedAt,
    }));

  const dbReceiptsToRecords = (
    rows: ReadonlyArray<{
      globalSeq: number;
      streamSeq: number;
      ts: number;
      hash: string;
      eventType: string;
      bodyJson: string;
    }>,
  ): ReceiptRecord[] => rows.map((row) => {
    const envelope = {
      stream: "",
      seq: row.streamSeq,
      ts: row.ts,
      hash: row.hash,
      body: JSON.parse(row.bodyJson),
    };
    return {
      raw: JSON.stringify(envelope),
      data: envelope,
    };
  });

  app.get("/receipt", async (c) => {
    const file = c.req.query("file") ?? "";
    const order = parseOrder(c.req.query("order"));
    const limit = parseLimit(c.req.query("limit"));
    const depth = parseInspectorDepth(c.req.query("depth"));
    const files = dbStreamsToFileInfo(listReceiptStreams(receiptDb));
    const selected = files.find((entry) => entry.name === file)?.name ?? files[0]?.name;
    return html(receiptShell({ selected, limit, order, depth }));
  });

  app.get("/receipt/island/folds", async (c) => {
    const selected = c.req.query("selected") ?? "";
    const order = parseOrder(c.req.query("order"));
    const limit = parseLimit(c.req.query("limit"));
    const depth = parseInspectorDepth(c.req.query("depth"));
    return html(receiptFoldsHtml(
      dbStreamsToFileInfo(listReceiptStreams(receiptDb)),
      selected,
      order,
      limit,
      depth,
    ));
  });

  app.get("/receipt/island/records", async (c) => {
    const file = c.req.query("file") ?? "";
    if (!file) return html(receiptRecordsHtml({ selected: undefined, records: [], order: "desc", limit: 200, total: 0 }));
    const order = parseOrder(c.req.query("order"));
    const limit = parseLimit(c.req.query("limit"));
    const rows = readReceiptsByStream(receiptDb, file, { order, limit });
    if (rows.length === 0) return html(`<div class="empty">Stream not found.</div>`);
    return html(receiptRecordsHtml({
      selected: file,
      records: dbReceiptsToRecords(rows),
      order,
      limit,
      total: countReceiptsInStream(receiptDb, file),
    }));
  });

  app.get("/receipt/island/side", async (c) => {
    const file = c.req.query("file") ?? "";
    const order = parseOrder(c.req.query("order"));
    const limit = parseLimit(c.req.query("limit"));
    const depth = parseInspectorDepth(c.req.query("depth"));
    if (!file) {
      return html(receiptSideHtml({ selected: undefined, order, limit, depth, total: 0, shown: 0 }));
    }
    const total = countReceiptsInStream(receiptDb, file);
    if (total === 0) {
      return html(receiptSideHtml({ selected: file, order, limit, depth, total: 0, shown: 0 }));
    }
    const rows = readReceiptsByStream(receiptDb, file, { order, limit });
    const records = dbReceiptsToRecords(rows);
    const allRecords = order === "desc" || rows.length < total
      ? dbReceiptsToRecords(readReceiptsByStream(receiptDb, file, { order: "asc", limit: total }))
      : records;
    return html(receiptSideHtml({
      selected: file,
      order,
      limit,
      depth,
      total,
      shown: records.length,
      timeline: buildReceiptTimeline(allRecords, depth),
    }));
  });

  app.get("/receipt/stream", async (c) => ctx.sse.subscribe("receipt", undefined, c.req.raw.signal));
};
