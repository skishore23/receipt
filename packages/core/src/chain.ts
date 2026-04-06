// ============================================================================
// Chain Operations — Pure functions over the receipt chain
// 
// These are the fundamental operations. Everything composes from here.
// ============================================================================

import { createHash } from "node:crypto";
import type { Receipt, Chain, Reducer } from "./types";

// ============================================================================
// Hashing (content-addressable)
// ============================================================================

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

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
export const computeHash = <B>(r: Omit<Receipt<B>, "hash">): string =>
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

export const receipt = <B>(
  stream: string,
  prev: string | undefined,
  body: B,
  ts = Date.now(),
  hints?: Record<string, unknown>
): Receipt<B> => {
  const id = makeId(ts);
  const base = { id, ts, stream, prev, body };
  return { ...base, hash: computeHash(base), hints };
};

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

type VerifyResult =
  | { ok: true; count: number; head?: string }
  | { ok: false; at: number; reason: string };

export const verify = <B>(chain: Chain<B>): VerifyResult => {
  let prev: string | undefined;
  for (let i = 0; i < chain.length; i++) {
    const r = chain[i];
    if (r.prev !== prev) return { ok: false, at: i, reason: "broken prev" };
    if (r.hash !== computeHash(r)) return { ok: false, at: i, reason: "hash mismatch" };
    prev = r.hash;
  }
  return { ok: true, count: chain.length, head: prev };
};
