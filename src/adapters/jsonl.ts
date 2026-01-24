// ============================================================================
// JSONL Adapter — File-based persistence
// ============================================================================

import fs from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import type { Receipt, Chain, Branch } from "../core/types.js";
import { createStore, type Store, type BranchStore } from "../core/store.js";

const safeName = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, "_");

const readJsonl = async <B>(file: string): Promise<Chain<B>> => {
  if (!fs.existsSync(file)) return [];
  
  const out: Receipt<B>[] = [];
  const rl = createInterface({
    input: fs.createReadStream(file, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  
  for await (const line of rl) {
    if (line.trim()) out.push(JSON.parse(line));
  }
  return out;
};

const appendJsonl = async <B>(file: string, r: Receipt<B>): Promise<void> => {
  await fs.promises.appendFile(file, JSON.stringify(r) + "\n", "utf-8");
};

export const jsonlStore = <B>(dir: string): Store<B> => {
  fs.mkdirSync(dir, { recursive: true });
  
  const fileFor = (stream: string) => path.join(dir, `${safeName(stream)}.jsonl`);
  
  return createStore<B>(
    (stream) => readJsonl(fileFor(stream)),
    (r) => appendJsonl(fileFor(r.stream), r)
  );
};

// Branch metadata store (JSON file)
export const jsonBranchStore = (dir: string): BranchStore => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "_branches.json");

  const readAll = async (): Promise<Branch[]> => {
    if (!fs.existsSync(file)) return [];
    const data = await fs.promises.readFile(file, "utf-8");
    return JSON.parse(data);
  };

  const writeAll = async (branches: Branch[]): Promise<void> => {
    await fs.promises.writeFile(file, JSON.stringify(branches, null, 2), "utf-8");
  };

  return {
    save: async (b) => {
      const all = await readAll();
      const idx = all.findIndex((x) => x.name === b.name);
      if (idx >= 0) all[idx] = b;
      else all.push(b);
      await writeAll(all);
    },
    get: async (name) => (await readAll()).find((b) => b.name === name),
    list: readAll,
    children: async (parent) => (await readAll()).filter((b) => b.parent === parent),
  };
};
