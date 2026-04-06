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
import { sqliteBranchStore, sqliteReceiptStore } from "../../src/adapters/sqlite";
import { createRuntime } from "@receipt/core/runtime";
import { getReceiptDb } from "../../src/db/client";

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("memory tools: commit/read/search/summarize/diff", async () => {
  const dir = await mkTmp("receipt-memory");
  try {
    const runtime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
      sqliteReceiptStore<MemoryEvent>(dir),
      sqliteBranchStore(dir),
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

test("memory tools: semantic embeddings are stored in sqlite and reused", async () => {
  const dir = await mkTmp("receipt-memory-embeddings");
  let embedCalls = 0;
  const embed = async (texts: ReadonlyArray<string>): Promise<ReadonlyArray<ReadonlyArray<number>>> => {
    embedCalls += texts.length;
    return texts.map((text) => [text.length, text.includes("proof") ? 10 : 1]);
  };

  try {
    const runtime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
      sqliteReceiptStore<MemoryEvent>(dir),
      sqliteBranchStore(dir),
      decideMemory,
      reduceMemory,
      initialMemoryState,
    );
    const tools = createMemoryTools({ dir, runtime, embed });
    const entry = await tools.commit({
      scope: "theorem.run.semantic",
      text: "Proof search should stay indexed.",
    });

    const first = await tools.search({
      scope: "theorem.run.semantic",
      query: "proof",
      limit: 5,
    });
    expect(first.map((item) => item.id)).toContain(entry.id);

    const second = await tools.search({
      scope: "theorem.run.semantic",
      query: "proof",
      limit: 5,
    });
    expect(second.map((item) => item.id)).toContain(entry.id);
    expect(embedCalls).toBe(3);

    const db = getReceiptDb(dir);
    const row = db.read(() => db.sqlite.query(`
      SELECT scope, vector_json AS vectorJson
      FROM memory_embeddings
      WHERE entry_id = ?
    `).get(entry.id) as { readonly scope: string; readonly vectorJson: string } | null);
    expect(row?.scope).toBe("theorem.run.semantic");
    expect(row?.vectorJson).toContain("[");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
