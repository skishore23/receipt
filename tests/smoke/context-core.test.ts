import { test, expect } from "bun:test";

import { buildRankedContext } from "../../src/lib/memory.ts";
import { buildMemorySlice } from "../../src/agents/theorem.memory.ts";
import type { TheoremEvent } from "../../src/modules/theorem.ts";
import type { Chain } from "../../src/core/types.ts";

test("memory utils: ranked context keeps pinned entries and top scored items", () => {
  const items = [
    { id: "a", ts: 1, score: 0.1, text: "alpha" },
    { id: "b", ts: 2, score: 2.0, text: "beta" },
    { id: "c", ts: 3, score: 1.5, text: "gamma" },
  ];

  const result = buildRankedContext({
    items,
    score: (item) => item.score,
    ts: (item) => item.ts,
    line: (item) => item.text,
    maxChars: 100,
    maxItems: 2,
    pinned: [items[0]],
    key: (item) => item.id,
  });

  expect(result.items.map((item) => item.id)).toEqual(["a", "b"]);
  expect(result.truncated).toBe(false);
});

test("memory utils: context compaction truncates over budget", () => {
  const items = [
    { id: "x", ts: 1, score: 1, text: "1234567890" },
    { id: "y", ts: 2, score: 0, text: "abcdefghij" },
  ];

  const result = buildRankedContext({
    items,
    score: (item) => item.score,
    ts: (item) => item.ts,
    line: (item) => item.text,
    maxChars: 8,
    maxItems: 2,
  });

  expect(result.truncated).toBe(true);
  expect(result.text.length <= 8).toBeTruthy();
});

const mkReceipt = (body: TheoremEvent, ts: number): Chain<TheoremEvent>[number] => ({
  id: `id_${ts}`,
  ts,
  stream: "theorem/runs/r1",
  body,
  hash: `hash_${ts}`,
});

test("theorem memory: bracket-aware focus prefers target-adjacent summary", () => {
  const runId = "r1";
  const chain: Chain<TheoremEvent> = [
    mkReceipt({
      type: "attempt.proposed",
      runId,
      claimId: "attempt_r1_a",
      agentId: "explorer_a",
      content: "Attempt A",
    }, 1),
    mkReceipt({
      type: "attempt.proposed",
      runId,
      claimId: "attempt_r1_c",
      agentId: "explorer_c",
      content: "Attempt C",
    }, 2),
    mkReceipt({
      type: "summary.made",
      runId,
      claimId: "merge_r1_a",
      agentId: "synthesizer",
      bracket: "(A o B)",
      content: "Summary A path",
      uses: ["attempt_r1_a"],
    }, 3),
    mkReceipt({
      type: "summary.made",
      runId,
      claimId: "merge_r1_c",
      agentId: "synthesizer",
      bracket: "(C o D)",
      content: "Summary C path",
      uses: ["attempt_r1_c"],
    }, 4),
  ];

  const slice = buildMemorySlice(chain, {
    phase: "patch",
    window: 20,
    maxChars: 40,
    targetClaimId: "attempt_r1_a",
    bracket: "(((A o B) o C) o D)",
  });

  expect(slice.text).toMatch(/Summary A path/);
  expect(slice.text).not.toMatch(/Summary C path/);
});
