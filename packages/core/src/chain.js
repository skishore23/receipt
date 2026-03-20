// ============================================================================
// Chain Operations — Pure functions over the receipt chain
// 
// These are the fundamental operations. Everything composes from here.
// ============================================================================
import { createHash } from "node:crypto";
// ============================================================================
// Hashing (content-addressable)
// ============================================================================
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
// Recursively sort object keys for deterministic JSON
const sortKeys = (x) => {
    if (x === null || typeof x !== "object")
        return x;
    if (Array.isArray(x))
        return x.map(sortKeys);
    const sorted = {};
    for (const k of Object.keys(x).sort()) {
        sorted[k] = sortKeys(x[k]);
    }
    return sorted;
};
const canonicalize = (x) => JSON.stringify(sortKeys(x));
// Hints are non-authoritative, not included in hash
export const computeHash = (r) => sha256(canonicalize({
    id: r.id,
    ts: r.ts,
    stream: r.stream,
    prev: r.prev ?? null,
    body: r.body,
}));
// ============================================================================
// Receipt Construction
// ============================================================================
const makeId = (ts) => `${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export const receipt = (stream, prev, body, ts = Date.now(), hints) => {
    const id = makeId(ts);
    const base = { id, ts, stream, prev, body };
    return { ...base, hash: computeHash(base), hints };
};
// ============================================================================
// Fold (catamorphism) — derive state from chain
// ============================================================================
export const fold = (chain, reducer, initial) => {
    let state = initial;
    for (const r of chain) {
        state = reducer(state, r.body, r.ts);
    }
    return state;
};
export const verify = (chain) => {
    let prev;
    for (let i = 0; i < chain.length; i++) {
        const r = chain[i];
        if (r.prev !== prev)
            return { ok: false, at: i, reason: "broken prev" };
        if (r.hash !== computeHash(r))
            return { ok: false, at: i, reason: "hash mismatch" };
        prev = r.hash;
    }
    return { ok: true, count: chain.length, head: prev };
};
