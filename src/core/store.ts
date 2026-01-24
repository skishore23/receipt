// ============================================================================
// Store — Persistence as a composable effect
// 
// The store is just a record of functions (not a class).
// Each operation could be traced with receipts.
// ============================================================================

import type { Receipt, Chain, Branch } from "./types.js";

// Store operations as a record of functions
export type Store<B> = {
  readonly append: (r: Receipt<B>) => Promise<void>;
  readonly read: (stream: string) => Promise<Chain<B>>;
  readonly take: (stream: string, n: number) => Promise<Chain<B>>;
  readonly count: (stream: string) => Promise<number>;
  readonly head: (stream: string) => Promise<Receipt<B> | undefined>;
};

// Branch metadata store
export type BranchStore = {
  readonly save: (b: Branch) => Promise<void>;
  readonly get: (name: string) => Promise<Branch | undefined>;
  readonly list: () => Promise<Branch[]>;
  readonly children: (parent: string) => Promise<Branch[]>;
};

// Create a store from read/write functions (adapter pattern)
export const createStore = <B>(
  readAll: (stream: string) => Promise<Chain<B>>,
  appendOne: (r: Receipt<B>) => Promise<void>
): Store<B> => ({
  append: appendOne,
  read: readAll,
  take: async (stream, n) => (await readAll(stream)).slice(0, n),
  count: async (stream) => (await readAll(stream)).length,
  head: async (stream) => {
    const chain = await readAll(stream);
    return chain.length > 0 ? chain[chain.length - 1] : undefined;
  },
});
