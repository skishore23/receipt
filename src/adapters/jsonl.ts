// ============================================================================
// JSONL Adapter — File-based persistence with hashed stream keys
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

import type { Branch, BranchStore, Chain, Receipt, Store } from "@receipt/core/types";
import { fold, receipt } from "@receipt/core/chain";
import {
  initial as initialBranchMeta,
  reduce as reduceBranchMeta,
  type BranchMetaEvent,
} from "../modules/branch-meta";

type StreamManifest = {
  readonly version: 1;
  readonly byStream: Record<string, string>;
  readonly byKey: Record<string, string>;
};

const STREAM_MANIFEST = "_streams.json";
const STREAM_MANIFEST_LOCK_SUFFIX = ".lock";
const BRANCH_META_STREAM = "__meta/branches";
const BRANCH_META_EVENT = "branch.meta.upsert";
const STREAM_MANIFEST_LOCK_STALE_MS = 30_000;
const STREAM_MANIFEST_LOCK_RETRY_MS = 25;

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

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const streamManifestEquals = (left: StreamManifest, right: StreamManifest): boolean => {
  const leftStreams = Object.keys(left.byStream);
  const rightStreams = Object.keys(right.byStream);
  const leftKeys = Object.keys(left.byKey);
  const rightKeys = Object.keys(right.byKey);
  if (leftStreams.length !== rightStreams.length || leftKeys.length !== rightKeys.length) return false;
  return leftStreams.every((stream) => right.byStream[stream] === left.byStream[stream])
    && leftKeys.every((key) => right.byKey[key] === left.byKey[key]);
};

const firstStreamInJsonl = async (file: string): Promise<string | undefined> => {
  if (!await fileExists(file)) return undefined;
  const rl = createInterface({
    input: fs.createReadStream(file, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const raw = line.trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { readonly stream?: unknown };
      return typeof parsed.stream === "string" && parsed.stream.trim()
        ? parsed.stream.trim()
        : undefined;
    }
  } catch {
    return undefined;
  } finally {
    rl.close();
  }
  return undefined;
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
  const manifestLockPath = `${manifestPath}${STREAM_MANIFEST_LOCK_SUFFIX}`;
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

  const persistManifestUnlocked = async (manifest: StreamManifest): Promise<void> => {
    const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    const body = JSON.stringify(manifest, null, 2);
    try {
      await fs.promises.writeFile(tempPath, body, "utf-8");
      await fs.promises.rename(tempPath, manifestPath);
      loaded = manifest;
    } finally {
      await fs.promises.unlink(tempPath).catch(() => undefined);
    }
  };

  const withManifestLock = async <T>(fn: () => Promise<T>): Promise<T> =>
    withSerialQueue(manifestLockPath, async () => {
      while (true) {
        let handle: fs.promises.FileHandle | undefined;
        try {
          handle = await fs.promises.open(manifestLockPath, "wx");
          await handle.writeFile(String(process.pid), "utf-8").catch(() => undefined);
          try {
            return await fn();
          } finally {
            await handle.close().catch(() => undefined);
            await fs.promises.unlink(manifestLockPath).catch(() => undefined);
          }
        } catch (err) {
          await handle?.close().catch(() => undefined);
          const code = err && typeof err === "object" && "code" in err ? String((err as { readonly code?: unknown }).code) : undefined;
          if (code !== "EEXIST") throw err;
          const stat = await fs.promises.stat(manifestLockPath).catch(() => undefined);
          if (stat && Date.now() - stat.mtimeMs > STREAM_MANIFEST_LOCK_STALE_MS) {
            await fs.promises.unlink(manifestLockPath).catch(() => undefined);
            continue;
          }
          await sleep(STREAM_MANIFEST_LOCK_RETRY_MS);
        }
      }
    });

  const repairManifest = async (manifest: StreamManifest): Promise<StreamManifest> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    const presentKeys = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name.replace(/\.jsonl$/u, ""));
    const presentKeySet = new Set(presentKeys);

    const byStream: Record<string, string> = {};
    const byKey: Record<string, string> = {};
    let dirty = false;

    for (const [stream, key] of Object.entries(manifest.byStream)) {
      if (!presentKeySet.has(key)) {
        dirty = true;
        continue;
      }
      if (manifest.byKey[key] !== stream) dirty = true;
      byStream[stream] = key;
      byKey[key] = stream;
    }

    if (!dirty && presentKeys.length === Object.keys(byKey).length) {
      return manifest;
    }

    for (const key of presentKeys) {
      if (byKey[key]) continue;
      const stream = await firstStreamInJsonl(path.join(dir, `${key}.jsonl`));
      if (!stream) continue;
      if (byStream[stream] && byStream[stream] !== key) {
        dirty = true;
        continue;
      }
      if (manifest.byKey[key] !== stream || manifest.byStream[stream] !== key) dirty = true;
      byStream[stream] = key;
      byKey[key] = stream;
    }

    return dirty
      ? {
          version: 1,
          byStream,
          byKey,
        }
      : manifest;
  };

  const refreshManifestWithRepair = async (): Promise<StreamManifest> => {
    const disk = await readManifestFromDisk();
    const repaired = await repairManifest(disk);
    if (streamManifestEquals(disk, repaired)) {
      loaded = repaired;
      return repaired;
    }
    return withManifestLock(async () => {
      const latest = await readManifestFromDisk();
      const repairedLatest = await repairManifest(latest);
      if (!streamManifestEquals(latest, repairedLatest)) {
        await persistManifestUnlocked(repairedLatest);
      } else {
        loaded = repairedLatest;
      }
      return repairedLatest;
    });
  };

  const ensureStreamKey = async (stream: string): Promise<string> => {
    const existing = (await readManifest()).byStream[stream];
    if (existing) return existing;

    return withManifestLock(async () => {
      const manifest = await repairManifest(await readManifestFromDisk());
      const found = manifest.byStream[stream];
      if (found) {
        if (!streamManifestEquals(await readManifestFromDisk(), manifest)) {
          await persistManifestUnlocked(manifest);
        } else {
          loaded = manifest;
        }
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
      await persistManifestUnlocked(next);
      return key;
    });
  };

  const keyFor = async (stream: string): Promise<string> => ensureStreamKey(stream);
  const existingKeyFor = async (stream: string): Promise<string | undefined> => {
    const manifest = await readManifest();
    if (manifest.byStream[stream]) return manifest.byStream[stream];
    return (await refreshManifestWithRepair()).byStream[stream];
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
    return (await refreshManifestWithRepair()).byKey[key];
  };
  const listStreams = async (prefix?: string): Promise<ReadonlyArray<string>> =>
    Object.keys((await refreshManifestWithRepair()).byStream)
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
