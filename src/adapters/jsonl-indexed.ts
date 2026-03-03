// ============================================================================
// JSONL Indexed Store - sidecar indexes for faster head/count
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import type { Chain, Receipt, Store } from "../core/types.js";
import { createStreamLocator } from "./jsonl.js";

export type IndexedStoreOptions = {
  readonly checkpointEvery?: number;
  readonly rebuildIndexOnMismatch?: boolean;
};

type StreamIndex = {
  readonly key: string;
  readonly count: number;
  readonly offsets: number[];
  readonly headHash?: string;
  readonly size: number;
};

const fileExists = async (file: string): Promise<boolean> => {
  try {
    await fs.promises.access(file, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const parseJsonLine = <B>(line: string, file: string, lineNo: number): Receipt<B> => {
  try {
    return JSON.parse(line) as Receipt<B>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Corrupt JSONL record at ${file}:${lineNo} (${message})`);
  }
};

const readJsonl = async <B>(file: string): Promise<Chain<B>> => {
  if (!await fileExists(file)) return [];
  const out: Receipt<B>[] = [];
  const rl = createInterface({
    input: fs.createReadStream(file, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (const raw of rl) {
    lineNo += 1;
    const line = raw.trim();
    if (!line) continue;
    out.push(parseJsonLine<B>(line, file, lineNo));
  }
  return out;
};

const buildIndexFromFile = async <B>(file: string, key: string): Promise<StreamIndex> => {
  if (!await fileExists(file)) {
    return { key, count: 0, offsets: [], size: 0 };
  }
  const raw = await fs.promises.readFile(file, "utf-8");
  let offset = 0;
  let lineNo = 0;
  const offsets: number[] = [];
  let headHash: string | undefined;

  for (const rawLine of raw.split("\n")) {
    lineNo += 1;
    const line = rawLine.trim();
    const lineSize = Buffer.byteLength(rawLine, "utf-8") + 1;
    if (line) {
      offsets.push(offset);
      const parsed = parseJsonLine<B>(line, file, lineNo);
      headHash = parsed.hash;
    }
    offset += lineSize;
  }

  return {
    key,
    count: offsets.length,
    offsets,
    headHash,
    size: Buffer.byteLength(raw, "utf-8"),
  };
};

const readLastReceipt = async <B>(file: string, offset: number): Promise<Receipt<B> | undefined> => {
  if (!await fileExists(file)) return undefined;
  const fd = await fs.promises.open(file, "r");
  try {
    const stat = await fd.stat();
    const length = Math.max(0, stat.size - offset);
    if (length === 0) return undefined;
    const buf = Buffer.alloc(length);
    await fd.read(buf, 0, length, offset);
    const tail = buf.toString("utf-8").trim();
    if (!tail) return undefined;
    const line = tail.split("\n").filter(Boolean).pop();
    if (!line) return undefined;
    return JSON.parse(line) as Receipt<B>;
  } finally {
    await fd.close();
  }
};

export const jsonlIndexedStore = <B>(dir: string, options: IndexedStoreOptions = {}): Store<B> => {
  fs.mkdirSync(dir, { recursive: true });
  const locator = createStreamLocator(dir);
  const indexDir = path.join(dir, "_index");
  fs.mkdirSync(indexDir, { recursive: true });
  const cache = new Map<string, StreamIndex>();
  const dirty = new Map<string, number>();
  const rebuildOnMismatch = options.rebuildIndexOnMismatch ?? true;
  const flushEvery = 1000;

  const indexPath = (key: string): string => path.join(indexDir, `${key}.idx.json`);

  const loadIndex = async (stream: string): Promise<StreamIndex> => {
    const key = await locator.keyFor(stream);
    const cached = cache.get(key);
    if (cached) return cached;

    const file = await locator.fileFor(stream);
    const stat = await fs.promises.stat(file).catch(() => null);

    const idxFile = indexPath(key);
    if (await fileExists(idxFile)) {
      try {
        const raw = await fs.promises.readFile(idxFile, "utf-8");
        const parsed = JSON.parse(raw) as StreamIndex;
        if (!stat || parsed.size === stat.size) {
          cache.set(key, parsed);
          return parsed;
        }
      } catch {
        // rebuild below
      }
    }

    if (!rebuildOnMismatch && stat) {
      throw new Error(`Index mismatch for ${stream}`);
    }

    const rebuilt = await buildIndexFromFile<B>(file, key);
    cache.set(key, rebuilt);
    await fs.promises.writeFile(idxFile, JSON.stringify(rebuilt), "utf-8");
    return rebuilt;
  };

  const persistIndex = async (index: StreamIndex, force = false): Promise<void> => {
    cache.set(index.key, index);
    const pending = (dirty.get(index.key) ?? 0) + 1;
    if (!force && pending < flushEvery) {
      dirty.set(index.key, pending);
      return;
    }
    dirty.delete(index.key);
    await fs.promises.writeFile(indexPath(index.key), JSON.stringify(index), "utf-8");
  };

  return {
    append: async (r) => {
      const key = await locator.keyFor(r.stream);
      const file = await locator.fileFor(r.stream);
      const before = await fs.promises.stat(file).catch(() => ({ size: 0 }));
      const line = `${JSON.stringify(r)}\n`;
      await fs.promises.appendFile(file, line, "utf-8");
      const current = await loadIndex(r.stream);
      const offsets = current.offsets;
      offsets.push(before.size);
      const next: StreamIndex = {
        key,
        count: current.count + 1,
        offsets,
        headHash: r.hash,
        size: before.size + Buffer.byteLength(line, "utf-8"),
      };
      await persistIndex(next);
    },
    read: async (stream) => readJsonl<B>(await locator.fileFor(stream)),
    take: async (stream, n) => (await readJsonl<B>(await locator.fileFor(stream))).slice(0, n),
    count: async (stream) => (await loadIndex(stream)).count,
    head: async (stream) => {
      const index = await loadIndex(stream);
      if (index.count === 0) return undefined;
      const file = await locator.fileFor(stream);
      const offset = index.offsets[index.offsets.length - 1];
      return readLastReceipt<B>(file, offset);
    },
  };
};
