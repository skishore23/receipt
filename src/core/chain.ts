// ============================================================================
// Chain Operations — Pure functions over the receipt chain
// 
// These are the fundamental operations. Everything composes from here.
// ============================================================================

import { createHash } from "node:crypto";
import type { Receipt, Chain, Hash, Reducer, View } from "./types.js";

// ============================================================================
// Hashing (content-addressable)
// ============================================================================

const sha256 = (s: string): Hash => createHash("sha256").update(s).digest("hex");

// Recursively sort object keys for deterministic JSON
const sortKeys = (x: unknown): unknown => {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(x as object).sort()) {
    sorted[k] = sortKeys((x as Record<string, unknown>)[k]);
  }
  return sorted;
};

const canonicalize = (x: unknown): string => JSON.stringify(sortKeys(x));

// Hints are non-authoritative, not included in hash
export const computeHash = <B>(r: Omit<Receipt<B>, "hash">): Hash =>
  sha256(canonicalize({ 
    id: r.id, 
    ts: r.ts, 
    stream: r.stream, 
    prev: r.prev ?? null, 
    body: r.body,
  }));

// ============================================================================
// Receipt Construction
// ============================================================================

const makeId = (ts: number): string => `${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const receipt = <B>(stream: string, prev: Hash | undefined, body: B, ts = Date.now()): Receipt<B> => {
  const id = makeId(ts);
  const base = { id, ts, stream, prev, body };
  return { ...base, hash: computeHash(base) };
};

// ============================================================================
// Chain Operations (pure)
// ============================================================================

// Empty chain
export const empty = <B>(): Chain<B> => [];

// Append a body to the chain, returns new chain + new receipt
export const append = <B>(chain: Chain<B>, stream: string, body: B): [Chain<B>, Receipt<B>] => {
  const prev = chain.length > 0 ? chain[chain.length - 1].hash : undefined;
  const r = receipt(stream, prev, body);
  return [[...chain, r], r];
};

// Take first n receipts (time travel)
export const take = <B>(chain: Chain<B>, n: number): Chain<B> => chain.slice(0, n);

// Get the head (last receipt)
export const head = <B>(chain: Chain<B>): Receipt<B> | undefined => chain[chain.length - 1];

// ============================================================================
// Fold (catamorphism) — derive state from chain
// ============================================================================

export const fold = <S, B>(chain: Chain<B>, reducer: Reducer<S, B>, initial: S): S => {
  let state = initial;
  for (const r of chain) {
    state = reducer(state, r.body, r.ts);
  }
  return state;
};

// ============================================================================
// Verification — check chain integrity
// ============================================================================

export type VerifyResult =
  | { ok: true; count: number; head?: Hash }
  | { ok: false; at: number; reason: string };

export const verify = <B>(chain: Chain<B>): VerifyResult => {
  let prev: Hash | undefined;
  for (let i = 0; i < chain.length; i++) {
    const r = chain[i];
    if (r.prev !== prev) return { ok: false, at: i, reason: "broken prev" };
    if (r.hash !== computeHash(r)) return { ok: false, at: i, reason: "hash mismatch" };
    prev = r.hash;
  }
  return { ok: true, count: chain.length, head: prev };
};

// ============================================================================
// View Combinators — compose views
// ============================================================================

// Map over view output
export const mapView = <B, O, O2>(view: View<B, O>, f: (o: O) => O2): View<B, O2> =>
  (chain) => f(view(chain));

// Compose views (run both, combine outputs)
export const combineViews = <B, O1, O2>(v1: View<B, O1>, v2: View<B, O2>): View<B, [O1, O2]> =>
  (chain) => [v1(chain), v2(chain)];

// Create a view from a reducer (state is a view)
export const stateView = <S, B>(reducer: Reducer<S, B>, initial: S): View<B, S> =>
  (chain) => fold(chain, reducer, initial);
