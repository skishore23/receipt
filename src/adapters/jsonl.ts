// ============================================================================
// JSONL Adapter — File-based persistence with hashed stream keys
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

import type { Branch, BranchStore, Chain, Receipt, Store } from "../core/types.js";
import { fold, receipt } from "../core/chain.js";
import {
  initial as initialBranchMeta,
  reduce as reduceBranchMeta,
  type BranchMetaEvent,
} from "../modules/branch-meta.js";

type StreamManifest = {
  readonly version: 1;
  readonly byStream: Record<string, string>;
  readonly byKey: Record<string, string>;
};

const STREAM_MANIFEST = "_streams.json";
const BRANCH_META_STREAM = "__meta/branches";
const BRANCH_META_EVENT = "branch.meta.upsert";

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

const fileExists = async (file: string): Promise<boolean> => {
  try {
    await fs.promises.access(file, fs.constants.F_OK);
    return true;
  } catch {
    return false;
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
  for await (const line of rl) {
    lineNo += 1;
    const raw = line.trim();
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Corrupt JSONL record at ${file}:${lineNo} (${message})`);
    }
  }
  return out;
};

const appendJsonl = async <B>(file: string, r: Receipt<B>): Promise<void> => {
  await fs.promises.appendFile(file, `${JSON.stringify(r)}\n`, "utf-8");
};

export type StreamLocator = {
  readonly fileFor: (stream: string) => Promise<string>;
  readonly keyFor: (stream: string) => Promise<string>;
  readonly existingKeyFor: (stream: string) => Promise<string | undefined>;
  readonly fileForExisting: (stream: string) => Promise<string | undefined>;
  readonly streamForKey: (key: string) => Promise<string | undefined>;
  readonly listStreams: (prefix?: string) => Promise<ReadonlyArray<string>>;
};

const serialQueues = new Map<string, Promise<void>>();

const withSerialQueue = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const prev = serialQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  serialQueues.set(key, next.then(() => undefined, () => undefined));
  return next;
};

export const createStreamLocator = (dir: string): StreamLocator => {
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, STREAM_MANIFEST);
  let loaded: StreamManifest | null = null;

  const emptyManifest = (): StreamManifest => ({
    version: 1,
    byStream: {},
    byKey: {},
  });

  const readManifestFromDisk = async (): Promise<StreamManifest> => {
    if (!await fileExists(manifestPath)) {
      return emptyManifest();
    }
    try {
      const raw = await fs.promises.readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<StreamManifest>;
      return {
        version: 1,
        byStream: parsed.byStream ?? {},
        byKey: parsed.byKey ?? {},
      };
    } catch {
      return emptyManifest();
    }
  };

  const readManifest = async (): Promise<StreamManifest> => {
    if (loaded) return loaded;
    loaded = await readManifestFromDisk();
    return loaded;
  };

  const refreshManifest = async (): Promise<StreamManifest> => {
    loaded = await readManifestFromDisk();
    return loaded;
  };

  const persistManifest = async (manifest: StreamManifest): Promise<void> => {
    const tempPath = `${manifestPath}.tmp`;
    const body = JSON.stringify(manifest, null, 2);
    await fs.promises.writeFile(tempPath, body, "utf-8");
    await fs.promises.rename(tempPath, manifestPath);
    loaded = manifest;
  };

  const ensureStreamKey = async (stream: string): Promise<string> => {
    const existing = (await readManifest()).byStream[stream];
    if (existing) return existing;

    return withSerialQueue(manifestPath, async () => {
      const manifest = await readManifestFromDisk();
      const found = manifest.byStream[stream];
      if (found) {
        loaded = manifest;
        return found;
      }

      const base = sha256(stream).slice(0, 24);
      let key = base;
      let i = 0;
      while (true) {
        const owner = manifest.byKey[key];
        if (!owner || owner === stream) break;
        i += 1;
        key = `${base}_${i}`;
      }

      const next: StreamManifest = {
        version: 1,
        byStream: { ...manifest.byStream, [stream]: key },
        byKey: { ...manifest.byKey, [key]: stream },
      };
      await persistManifest(next);
      return key;
    });
  };

  const keyFor = async (stream: string): Promise<string> => ensureStreamKey(stream);
  const existingKeyFor = async (stream: string): Promise<string | undefined> => {
    const manifest = await readManifest();
    if (manifest.byStream[stream]) return manifest.byStream[stream];
    return (await refreshManifest()).byStream[stream];
  };
  const fileFor = async (stream: string): Promise<string> =>
    path.join(dir, `${await ensureStreamKey(stream)}.jsonl`);
  const fileForExisting = async (stream: string): Promise<string | undefined> => {
    const key = await existingKeyFor(stream);
    return key ? path.join(dir, `${key}.jsonl`) : undefined;
  };
  const streamForKey = async (key: string): Promise<string | undefined> => {
    const manifest = await readManifest();
    if (manifest.byKey[key]) return manifest.byKey[key];
    return (await refreshManifest()).byKey[key];
  };
  const listStreams = async (prefix?: string): Promise<ReadonlyArray<string>> =>
    Object.keys((await refreshManifest()).byStream)
      .filter((stream) => (prefix ? stream.startsWith(prefix) : true))
      .sort((a, b) => a.localeCompare(b));

  return { fileFor, keyFor, existingKeyFor, fileForExisting, streamForKey, listStreams };
};

/** One .jsonl file per stream key under dir; stream names map via _streams.json */
export const jsonlStore = <B>(dir: string): Store<B> => {
  const locator = createStreamLocator(dir);
  const readExisting = async (stream: string): Promise<Chain<B>> => {
    const file = await locator.fileForExisting(stream);
    if (!file) return [];
    return readJsonl<B>(file);
  };
  const versionFor = async (stream: string): Promise<string | undefined> => {
    const file = await locator.fileForExisting(stream);
    if (!file) return undefined;
    try {
      const stat = await fs.promises.stat(file);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return undefined;
    }
  };
  const withAppendLock = <T>(file: string, op: () => Promise<T>): Promise<T> =>
    withSerialQueue(`append:${file}`, async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      return op();
    });
  return {
    append: async function append(r, expectedPrev) {
      const physicalPrev = arguments.length >= 2 ? expectedPrev : r.prev;
      const file = await locator.fileFor(r.stream);
      await withAppendLock(file, async () => {
        const chain = await readJsonl<B>(file);
        const head = chain.length > 0 ? chain[chain.length - 1] : undefined;
        if ((head?.hash ?? undefined) !== physicalPrev) {
          throw new Error(`Expected prev hash ${physicalPrev ?? "undefined"} but head is ${head?.hash ?? "undefined"}`);
        }
        await appendJsonl(file, r);
      });
    },
    read: readExisting,
    take: async (stream, n) => (await readExisting(stream)).slice(0, n),
    count: async (stream) => (await readExisting(stream)).length,
    head: async (stream) => {
      const chain = await readExisting(stream);
      return chain.length > 0 ? chain[chain.length - 1] : undefined;
    },
    version: versionFor,
    listStreams: locator.listStreams,
  };
};

/** Branch metadata is receipt-native in stream "__meta/branches". */
export const jsonBranchStore = (dir: string): BranchStore => {
  const store = jsonlStore<BranchMetaEvent>(dir);
  let queue = Promise.resolve();

  const load = async () => {
    const chain = await store.read(BRANCH_META_STREAM);
    return fold(chain, reduceBranchMeta, initialBranchMeta);
  };

  const save = async (branch: Branch): Promise<void> => {
    const op = async () => {
      const chain = await store.read(BRANCH_META_STREAM);
      const prev = chain.length > 0 ? chain[chain.length - 1].hash : undefined;
      const event: BranchMetaEvent = {
        type: BRANCH_META_EVENT,
        branch,
      };
      await store.append(receipt(BRANCH_META_STREAM, prev, event), prev);
    };
    const next = queue.then(op);
    queue = next.then(() => undefined, () => undefined);
    await next;
  };

  return {
    save,
    get: async (name) => (await load()).branches[name],
    list: async () => Object.values((await load()).branches).sort((a, b) => a.name.localeCompare(b.name)),
    children: async (parent) =>
      Object.values((await load()).branches)
        .filter((branch) => branch.parent === parent)
        .sort((a, b) => a.name.localeCompare(b.name)),
  };
};
