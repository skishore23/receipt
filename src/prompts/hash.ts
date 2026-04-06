// ============================================================================
// Prompt hashing (under the hood)
// ============================================================================

import { createHash } from "node:crypto";

const sortKeys = (x: unknown): unknown => {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(x as object).sort()) {
    out[k] = sortKeys((x as Record<string, unknown>)[k]);
  }
  return out;
};

export const stableStringify = (x: unknown): string => JSON.stringify(sortKeys(x));

export const hashPrompts = (prompts: unknown): string =>
  createHash("sha256")
    .update(stableStringify(prompts))
    .digest("hex");
