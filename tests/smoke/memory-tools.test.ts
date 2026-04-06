import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createMemoryTools,
  decideMemory,
  initialMemoryState,
  reduceMemory,
  type MemoryCmd,
  type MemoryEvent,
  type MemoryState,
} from "../../src/adapters/memory-tools";
import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { createRuntime } from "@receipt/core/runtime";

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("memory tools: commit/read/search/summarize/diff", async () => {
  const dir = await mkTmp("receipt-memory");
  try {
    const runtime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
      jsonlStore<MemoryEvent>(dir),
      jsonBranchStore(dir),
      decideMemory,
      reduceMemory,
      initialMemoryState
    );
    const tools = createMemoryTools({ dir, runtime });
    const first = await tools.commit({
      scope: "theorem.run.demo",
      text: "Need stronger induction hypothesis.",
      tags: ["proof", "gap"],
    });
    await tools.commit({
      scope: "theorem.run.demo",
      text: "Verifier flagged missing base case.",
      tags: ["verifier"],
    });

    const read = await tools.read({ scope: "theorem.run.demo", limit: 10 });
    expect(read.length).toBe(2);

    const search = await tools.search({
      scope: "theorem.run.demo",
      query: "base case",
      limit: 5,
    });
    expect(search.length).toBe(1);
    expect(search[0]?.text ?? "").toMatch(/base case/i);

    const summary = await tools.summarize({
      scope: "theorem.run.demo",
      query: "proof",
      limit: 5,
      maxChars: 500,
    });
    expect(summary.summary).toMatch(/induction/i);

    const diff = await tools.diff({
      scope: "theorem.run.demo",
      fromTs: first.ts,
      toTs: Date.now(),
      audit: { actor: "test", command: "diff" },
    });
    expect(diff.length).toBe(2);

    const state = await runtime.state("memory/theorem.run.demo");
    expect(state.accesses.length).toBe(4);
    expect(state.accesses.map((access) => access.operation)).toEqual([
      "diff",
      "summarize",
      "search",
      "read",
    ]);

    const chain = await runtime.chain("memory/theorem.run.demo");
    expect(chain.map((receipt) => receipt.body.type)).toEqual([
      "memory.committed",
      "memory.committed",
      "memory.accessed",
      "memory.accessed",
      "memory.accessed",
      "memory.accessed",
    ]);
    const latestAccess = chain.at(-1)?.body;
    expect(latestAccess && typeof latestAccess === "object" && "type" in latestAccess ? latestAccess.type : "").toBe("memory.accessed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
