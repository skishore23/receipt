// ============================================================================
// Memory Tools - runtime-backed memory tool contracts
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Decide, Reducer } from "@receipt/core/types.js";
import type { Runtime } from "@receipt/core/runtime.js";

export type MemoryEntry = {
  readonly id: string;
  readonly scope: string;
  readonly text: string;
  readonly tags?: ReadonlyArray<string>;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly ts: number;
};

export type MemoryEvent = {
  readonly type: "memory.committed";
  readonly scope: string;
  readonly entry: MemoryEntry;
};

export type MemoryCmd = {
  readonly type: "emit";
  readonly event: MemoryEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export type MemoryState = {
  readonly entries: ReadonlyArray<MemoryEntry>;
};

export const initialMemoryState: MemoryState = { entries: [] };

export const decideMemory: Decide<MemoryCmd, MemoryEvent> = (cmd) => [cmd.event];

export const reduceMemory: Reducer<MemoryState, MemoryEvent> = (state, event) => {
  if (event.type !== "memory.committed") {
    throw new Error(`unknown memory event: ${(event as { type?: string }).type ?? "unknown"}`);
  }
  return {
    entries: [event.entry, ...state.entries]
      .sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id)),
  };
};

export type MemoryReadInput = {
  readonly scope: string;
  readonly limit?: number;
};

export type MemorySearchInput = {
  readonly scope: string;
  readonly query: string;
  readonly limit?: number;
};

export type MemorySummarizeInput = {
  readonly scope: string;
  readonly query?: string;
  readonly limit?: number;
  readonly maxChars?: number;
};

export type MemoryCommitInput = {
  readonly scope: string;
  readonly text: string;
  readonly tags?: ReadonlyArray<string>;
  readonly meta?: Readonly<Record<string, unknown>>;
};

export type MemoryDiffInput = {
  readonly scope: string;
  readonly fromTs: number;
  readonly toTs?: number;
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

export type MemoryToolsDeps = {
  readonly dir: string;
  readonly runtime: Runtime<MemoryCmd, MemoryEvent, MemoryState>;
  readonly streamForScope?: (scope: string) => string;
  readonly embed?: EmbedFn;
  readonly now?: () => number;
};

export const createMemoryTools = (deps: MemoryToolsDeps): MemoryTools => {
  const root = path.join(deps.dir, "memory");
  const embedFn = deps.embed;
  const now = deps.now ?? Date.now;
  const streamForScope = deps.streamForScope ?? ((scope: string) => `memory/${safeScope(scope)}`);

  const readEntries = async (scope: string): Promise<ReadonlyArray<MemoryEntry>> =>
    (await deps.runtime.state(streamForScope(scope))).entries;

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

  return {
    read: async (input) => {
      const limit = Math.max(1, Math.min(input.limit ?? 20, 500));
      return (await readEntries(input.scope)).slice(0, limit);
    },

    search: async (input) => {
      const limit = Math.max(1, Math.min(input.limit ?? 20, 500));
      return embedFn
        ? semanticSearch(input.scope, input.query, limit)
        : keywordSearch(input.scope, input.query, limit);
    },

    summarize: async (input) => {
      const maxChars = Math.max(100, Math.min(input.maxChars ?? 2_400, 12_000));
      const limit = Math.max(1, Math.min(input.limit ?? 20, 500));
      const entries = input.query
        ? await (embedFn
          ? semanticSearch(input.scope, input.query, limit)
          : keywordSearch(input.scope, input.query, limit))
        : (await readEntries(input.scope)).slice(0, limit);
      return {
        summary: summarizeText(entries, maxChars),
        entries,
      };
    },

    commit: async (input) => {
      const text = input.text.trim();
      if (!text) throw new Error("memory.commit requires non-empty text");
      const entry: MemoryEntry = {
        id: `mem_${now().toString(36)}_${randomUUID().slice(0, 6)}`,
        scope: input.scope,
        text,
        tags: input.tags?.filter((tag) => typeof tag === "string" && tag.trim().length > 0),
        meta: input.meta,
        ts: now(),
      };
      await deps.runtime.execute(streamForScope(input.scope), {
        type: "emit",
        eventId: `memory_${now().toString(36)}_${randomUUID().slice(0, 6)}`,
        event: {
          type: "memory.committed",
          scope: input.scope,
          entry,
        },
      });

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
      return (await readEntries(input.scope))
        .filter((entry) => entry.ts >= input.fromTs && entry.ts <= toTs);
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
      return entries.length;
    },
  };
};

