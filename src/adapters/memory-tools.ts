// ============================================================================
// Memory Tools - runtime-backed memory tool contracts
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Decide, Reducer } from "@receipt/core/types";
import type { Runtime } from "@receipt/core/runtime";
import { getReceiptDb } from "../db/client";
import { jsonParse, jsonParseOptional, jsonStringify, jsonStringifyOptional } from "../db/json";

export type MemoryEntry = {
  readonly id: string;
  readonly scope: string;
  readonly text: string;
  readonly tags?: ReadonlyArray<string>;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly ts: number;
};

export type MemoryAccessOperation = "read" | "search" | "summarize" | "diff" | "reindex";

export type MemoryAccessStrategy = "recent" | "keyword" | "semantic" | "time_window" | "reindex";

export type MemoryAccessRecord = {
  readonly id: string;
  readonly scope: string;
  readonly operation: MemoryAccessOperation;
  readonly strategy: MemoryAccessStrategy;
  readonly query?: string;
  readonly limit?: number;
  readonly maxChars?: number;
  readonly fromTs?: number;
  readonly toTs?: number;
  readonly resultCount: number;
  readonly resultIds?: ReadonlyArray<string>;
  readonly summaryChars?: number;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly ts: number;
};

export type MemoryEvent =
  | {
      readonly type: "memory.committed";
      readonly scope: string;
      readonly entry: MemoryEntry;
    }
  | {
      readonly type: "memory.accessed";
      readonly scope: string;
      readonly access: MemoryAccessRecord;
    };

export type MemoryCmd = {
  readonly type: "emit";
  readonly event: MemoryEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export type MemoryState = {
  readonly entries: ReadonlyArray<MemoryEntry>;
  readonly accesses: ReadonlyArray<MemoryAccessRecord>;
};

export const initialMemoryState: MemoryState = { entries: [], accesses: [] };

export const decideMemory: Decide<MemoryCmd, MemoryEvent> = (cmd) => [cmd.event];

const insertNewestFirst = <T extends { readonly ts: number }>(
  item: T,
  items: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  const next = [...items];
  const index = next.findIndex((candidate) => item.ts >= candidate.ts);
  if (index === -1) next.push(item);
  else next.splice(index, 0, item);
  return next;
};

export const reduceMemory: Reducer<MemoryState, MemoryEvent> = (state, event) => {
  if (event.type === "memory.committed") {
    return {
      ...state,
      entries: insertNewestFirst(event.entry, state.entries),
    };
  }
  if (event.type === "memory.accessed") {
    return {
      ...state,
      accesses: insertNewestFirst(event.access, state.accesses),
    };
  }
  throw new Error(`unknown memory event: ${(event as { type?: string }).type ?? "unknown"}`);
};

export type MemoryAuditMeta = Readonly<Record<string, unknown>>;

export type MemoryReadInput = {
  readonly scope: string;
  readonly limit?: number;
  readonly audit?: MemoryAuditMeta;
};

export type MemorySearchInput = {
  readonly scope: string;
  readonly query: string;
  readonly limit?: number;
  readonly audit?: MemoryAuditMeta;
};

export type MemorySummarizeInput = {
  readonly scope: string;
  readonly query?: string;
  readonly limit?: number;
  readonly maxChars?: number;
  readonly audit?: MemoryAuditMeta;
};

export type MemoryCommitInput = {
  readonly scope: string;
  readonly text: string;
  readonly tags?: ReadonlyArray<string>;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly audit?: MemoryAuditMeta;
};

export type MemoryDiffInput = {
  readonly scope: string;
  readonly fromTs: number;
  readonly toTs?: number;
  readonly audit?: MemoryAuditMeta;
};

export type EmbedFn = (texts: ReadonlyArray<string>) => Promise<ReadonlyArray<ReadonlyArray<number>>>;

export type MemoryTools = {
  readonly read: (input: MemoryReadInput) => Promise<ReadonlyArray<MemoryEntry>>;
  readonly search: (input: MemorySearchInput) => Promise<ReadonlyArray<MemoryEntry>>;
  readonly summarize: (input: MemorySummarizeInput) => Promise<{ summary: string; entries: ReadonlyArray<MemoryEntry> }>;
  readonly commit: (input: MemoryCommitInput) => Promise<MemoryEntry>;
  readonly diff: (input: MemoryDiffInput) => Promise<ReadonlyArray<MemoryEntry>>;
  readonly reindex: (scope: string) => Promise<number>;
};

type EmbeddingCache = Record<string, ReadonlyArray<number>>;

const safeScope = (scope: string): string =>
  (scope || "default").toLowerCase().replace(/[^a-z0-9_.-/]/g, "_");

const scopeToEmbeddingsFile = (root: string, scope: string): string =>
  path.join(root, `${safeScope(scope).replace(/[\\/]/g, "__")}.embeddings.json`);

const loadEmbeddingCache = async (file: string): Promise<EmbeddingCache> => {
  const exists = await fs.promises.access(file, fs.constants.F_OK).then(() => true).catch(() => false);
  if (!exists) return {};
  const raw = await fs.promises.readFile(file, "utf-8");
  try {
    return JSON.parse(raw) as EmbeddingCache;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid embedding cache ${file}: ${message}`);
  }
};

const saveEmbeddingCache = async (file: string, cache: EmbeddingCache): Promise<void> => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(cache), "utf-8");
};

const cosine = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
};

const ensureEmbeddings = async (
  entries: ReadonlyArray<MemoryEntry>,
  cache: EmbeddingCache,
  embedFn: EmbedFn
): Promise<EmbeddingCache> => {
  const missing = entries.filter((entry) => !(entry.id in cache));
  if (missing.length === 0) return cache;
  const vectors = await embedFn(missing.map((entry) => entry.text));
  const updated = { ...cache };
  for (let idx = 0; idx < missing.length; idx += 1) {
    updated[missing[idx].id] = vectors[idx];
  }
  return updated;
};

const summarizeText = (entries: ReadonlyArray<MemoryEntry>, maxChars: number): string => {
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => {
    const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
    return `- ${entry.text}${tags}`;
  });
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;
  if (maxChars <= 3) return joined.slice(0, maxChars);
  return `${joined.slice(0, maxChars - 3)}...`;
};

const hasQuery = (entry: MemoryEntry, queryTerms: ReadonlyArray<string>): boolean => {
  if (queryTerms.length === 0) return true;
  const haystack = `${entry.text} ${entry.tags?.join(" ") ?? ""}`.toLowerCase();
  return queryTerms.every((term) => haystack.includes(term));
};

const nextMemoryId = (prefix: "mem" | "memacc", now: () => number): string =>
  `${prefix}_${now().toString(36)}_${randomUUID().slice(0, 6)}`;

const nextEventId = (now: () => number): string =>
  `memory_${now().toString(36)}_${randomUUID().slice(0, 6)}`;

const cappedResultIds = (entries: ReadonlyArray<MemoryEntry>, limit = 20): ReadonlyArray<string> =>
  entries.slice(0, limit).map((entry) => entry.id);

export type MemoryToolsDeps = {
  readonly dir: string;
  readonly runtime: Runtime<MemoryCmd, MemoryEvent, MemoryState>;
  readonly streamForScope?: (scope: string) => string;
  readonly embed?: EmbedFn;
  readonly now?: () => number;
};

export const createMemoryTools = (deps: MemoryToolsDeps): MemoryTools => {
  const root = path.join(deps.dir, "memory");
  const db = getReceiptDb(deps.dir);
  const embedFn = deps.embed;
  const now = deps.now ?? Date.now;
  const streamForScope = deps.streamForScope ?? ((scope: string) => `memory/${safeScope(scope)}`);

  const readEntries = async (scope: string): Promise<ReadonlyArray<MemoryEntry>> =>
    (db.sqlite.query(`
      SELECT entry_id, scope, text, tags_json, meta_json, ts
      FROM memory_entries
      WHERE scope = ?
      ORDER BY ts DESC
    `).all(scope) as Array<{
      readonly entry_id: string;
      readonly scope: string;
      readonly text: string;
      readonly tags_json: string | null;
      readonly meta_json: string | null;
      readonly ts: number;
    }>).map((row) => ({
      id: row.entry_id,
      scope: row.scope,
      text: row.text,
      tags: jsonParseOptional<ReadonlyArray<string>>(row.tags_json),
      meta: jsonParseOptional<Readonly<Record<string, unknown>>>(row.meta_json),
      ts: Number(row.ts),
    }));

  const semanticSearch = async (scope: string, query: string, limit: number): Promise<ReadonlyArray<MemoryEntry>> => {
    if (!embedFn) throw new Error("semantic search requires embed dependency");
    const entries = await readEntries(scope);
    if (entries.length === 0) return [];
    const embFile = scopeToEmbeddingsFile(root, scope);
    const cache = await loadEmbeddingCache(embFile);
    const updated = await ensureEmbeddings(entries, cache, embedFn);
    if (updated !== cache) await saveEmbeddingCache(embFile, updated);
    const [queryVec] = await embedFn([query]);
    return entries
      .filter((entry) => entry.id in updated)
      .map((entry) => ({ entry, score: cosine(queryVec, updated[entry.id]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.entry);
  };

  const keywordSearch = async (scope: string, query: string, limit: number): Promise<ReadonlyArray<MemoryEntry>> => {
    const terms = query.toLowerCase().split(/\s+/).map((part) => part.trim()).filter(Boolean);
    return (await readEntries(scope)).filter((entry) => hasQuery(entry, terms)).slice(0, limit);
  };

  const emitAccess = async (scope: string, access: Omit<MemoryAccessRecord, "id" | "scope" | "ts">): Promise<void> => {
    const eventScope = scope;
    const record: MemoryAccessRecord = {
      id: nextMemoryId("memacc", now),
      scope: eventScope,
      ts: now(),
      ...access,
    };
    await deps.runtime.execute(streamForScope(eventScope), {
      type: "emit",
      eventId: nextEventId(now),
      event: {
        type: "memory.accessed",
        scope: eventScope,
        access: record,
      },
    });
    db.sqlite.query(`
      INSERT INTO memory_accesses (
        access_id,
        scope,
        operation,
        strategy,
        query,
        "limit",
        max_chars,
        from_ts,
        to_ts,
        result_count,
        result_ids_json,
        summary_chars,
        meta_json,
        ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.scope,
      record.operation,
      record.strategy,
      record.query ?? null,
      record.limit ?? null,
      record.maxChars ?? null,
      record.fromTs ?? null,
      record.toTs ?? null,
      record.resultCount,
      jsonStringifyOptional(record.resultIds),
      record.summaryChars ?? null,
      jsonStringifyOptional(record.meta),
      record.ts,
    );
  };

  return {
    read: async (input) => {
      const limit = Math.max(1, Math.min(input.limit ?? 20, 500));
      const entries = (await readEntries(input.scope)).slice(0, limit);
      await emitAccess(input.scope, {
        operation: "read",
        strategy: "recent",
        limit,
        resultCount: entries.length,
        resultIds: cappedResultIds(entries),
        meta: input.audit,
      });
      return entries;
    },

    search: async (input) => {
      const limit = Math.max(1, Math.min(input.limit ?? 20, 500));
      const entries = await (embedFn
        ? semanticSearch(input.scope, input.query, limit)
        : keywordSearch(input.scope, input.query, limit));
      await emitAccess(input.scope, {
        operation: "search",
        strategy: embedFn ? "semantic" : "keyword",
        query: input.query,
        limit,
        resultCount: entries.length,
        resultIds: cappedResultIds(entries),
        meta: input.audit,
      });
      return entries;
    },

    summarize: async (input) => {
      const maxChars = Math.max(100, Math.min(input.maxChars ?? 2_400, 12_000));
      const limit = Math.max(1, Math.min(input.limit ?? 20, 500));
      const entries = input.query
        ? await (embedFn
          ? semanticSearch(input.scope, input.query, limit)
          : keywordSearch(input.scope, input.query, limit))
        : (await readEntries(input.scope)).slice(0, limit);
      const summary = summarizeText(entries, maxChars);
      await emitAccess(input.scope, {
        operation: "summarize",
        strategy: input.query ? (embedFn ? "semantic" : "keyword") : "recent",
        query: input.query,
        limit,
        maxChars,
        resultCount: entries.length,
        resultIds: cappedResultIds(entries),
        summaryChars: summary.length,
        meta: input.audit,
      });
      return {
        summary,
        entries,
      };
    },

    commit: async (input) => {
      const text = input.text.trim();
      if (!text) throw new Error("memory.commit requires non-empty text");
      const entry: MemoryEntry = {
        id: nextMemoryId("mem", now),
        scope: input.scope,
        text,
        tags: input.tags?.filter((tag) => typeof tag === "string" && tag.trim().length > 0),
        meta: input.meta,
        ts: now(),
      };
      await deps.runtime.execute(streamForScope(input.scope), {
        type: "emit",
        eventId: nextEventId(now),
        event: {
          type: "memory.committed",
          scope: input.scope,
          entry,
        },
      });
      db.sqlite.query(`
        INSERT INTO memory_entries (entry_id, scope, text, tags_json, meta_json, ts)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET
          scope = excluded.scope,
          text = excluded.text,
          tags_json = excluded.tags_json,
          meta_json = excluded.meta_json,
          ts = excluded.ts
      `).run(
        entry.id,
        entry.scope,
        entry.text,
        jsonStringifyOptional(entry.tags),
        jsonStringifyOptional(entry.meta),
        entry.ts,
      );

      if (embedFn) {
        const embFile = scopeToEmbeddingsFile(root, input.scope);
        const cache = await loadEmbeddingCache(embFile);
        const [vector] = await embedFn([text]);
        await saveEmbeddingCache(embFile, { ...cache, [entry.id]: vector });
      }

      return entry;
    },

    diff: async (input) => {
      const toTs = input.toTs ?? now();
      const entries = (await readEntries(input.scope))
        .filter((entry) => entry.ts >= input.fromTs && entry.ts <= toTs);
      await emitAccess(input.scope, {
        operation: "diff",
        strategy: "time_window",
        fromTs: input.fromTs,
        toTs,
        resultCount: entries.length,
        resultIds: cappedResultIds(entries),
        meta: input.audit,
      });
      return entries;
    },

    reindex: async (scope) => {
      if (!embedFn) throw new Error("reindex requires embed dependency");
      const entries = await readEntries(scope);
      if (entries.length === 0) return 0;
      const vectors = await embedFn(entries.map((entry) => entry.text));
      const cache: EmbeddingCache = {};
      for (let idx = 0; idx < entries.length; idx += 1) {
        cache[entries[idx].id] = vectors[idx];
      }
      await saveEmbeddingCache(scopeToEmbeddingsFile(root, scope), cache);
      await emitAccess(scope, {
        operation: "reindex",
        strategy: "reindex",
        resultCount: entries.length,
        resultIds: cappedResultIds(entries),
      });
      return entries.length;
    },
  };
};
