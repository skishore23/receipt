import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRuntime } from "../../src/core/runtime.ts";
import { jsonBranchStore, jsonlStore, createStreamLocator } from "../../src/adapters/jsonl.ts";
import { validatePlan } from "../../src/engine/runtime/plan-validate.ts";
import type { PlanSpec } from "../../src/engine/runtime/planner.ts";
import { reduce as reduceBranchMeta, initial as initialBranchMeta } from "../../src/modules/branch-meta.ts";
import { fold } from "../../src/core/chain.ts";

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("runtime: plan validation rejects cycles and duplicate providers", () => {
  const plan: PlanSpec<{}> = {
    id: "demo",
    version: "1",
    goal: (outputs) => ({
      done: outputs["final"] !== undefined,
      blocked: outputs["final"] === undefined ? "final output not yet produced" : undefined,
    }),
    capabilities: [
      {
        id: "a",
        agentId: "agent-a",
        needs: ["b.out"],
        provides: ["a.out"],
        run: async () => ({ "a.out": "ok" }),
      },
      {
        id: "b",
        agentId: "agent-b",
        needs: ["a.out"],
        provides: ["b.out"],
        run: async () => ({ "b.out": "ok" }),
      },
      {
        id: "dup",
        agentId: "agent-dup",
        needs: [],
        provides: ["a.out"],
        run: async () => ({ "a.out": "dup" }),
      },
    ],
  };

  const result = validatePlan(plan);
  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toMatch(/provided by both/i);
  expect(result.errors.join("\n")).toMatch(/dependency cycle/i);
});

test("runtime: emit eventId is idempotent and expectedPrev is enforced", async () => {
  const dataDir = await createTempDir("receipt-runtime-idempotent");
  try {
    type Event = { readonly type: "note"; readonly runId: string; readonly text: string };
    type Cmd = {
      readonly type: "emit";
      readonly event: Event;
      readonly eventId: string;
      readonly expectedPrev?: string;
    };

    const runtime = createRuntime<Cmd, Event, { count: number }>(
      jsonlStore<Event>(dataDir),
      jsonBranchStore(dataDir),
      (cmd) => [cmd.event],
      (state) => ({ count: state.count + 1 }),
      { count: 0 }
    );

    await runtime.execute("demo", {
      type: "emit",
      event: { type: "note", runId: "r1", text: "hello" },
      eventId: "evt-1",
    });
    await runtime.execute("demo", {
      type: "emit",
      event: { type: "note", runId: "r1", text: "hello duplicate" },
      eventId: "evt-1",
    });

    const chain = await runtime.chain("demo");
    expect(chain.length).toBe(1);

    expect(
      runtime.execute("demo", {
        type: "emit",
        event: { type: "note", runId: "r1", text: "bad prev" },
        eventId: "evt-2",
        expectedPrev: "not-the-head",
      }),
    ).rejects.toThrow(/Expected prev hash/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("runtime: branch metadata is reconstructible from receipts only", async () => {
  const dataDir = await createTempDir("receipt-runtime-branches");
  try {
    type Cmd = { readonly type: "inc"; readonly seq: number };
    type Event = Cmd;
    const runtime = createRuntime<Cmd, Event, { count: number }>(
      jsonlStore<Event>(dataDir),
      jsonBranchStore(dataDir),
      (cmd) => [cmd],
      (state) => ({ count: state.count + 1 }),
      { count: 0 }
    );

    await runtime.execute("root", { type: "inc", seq: 1 });
    await runtime.execute("root", { type: "inc", seq: 2 });
    await runtime.fork("root", 2, "root/branches/a");
    await runtime.fork("root/branches/a", 2, "root/branches/a/branches/b");

    const listed = await runtime.branches();
    expect(listed.some((b) => b.name === "root/branches/a")).toBeTruthy();
    expect(listed.some((b) => b.name === "root/branches/a/branches/b")).toBeTruthy();

    const branchMetaStore = jsonlStore<{ type: "branch.meta.upsert"; branch: { name: string } }>(dataDir);
    const metaChain = await branchMetaStore.read("__meta/branches");
    const reconstructed = fold(metaChain, reduceBranchMeta, initialBranchMeta);
    expect(reconstructed.branches["root/branches/a"]).toBeTruthy();
    expect(reconstructed.branches["root/branches/a/branches/b"]).toBeTruthy();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("runtime: corrupted jsonl line fails explicitly", async () => {
  const dataDir = await createTempDir("receipt-runtime-corrupt");
  try {
    const stream = "corrupt";
    const store = jsonlStore<{ readonly type: "ok" }>(dataDir);
    const runtime = createRuntime<{ readonly type: "ok" }, { readonly type: "ok" }, { readonly ok: number }>(
      store,
      jsonBranchStore(dataDir),
      (cmd) => [cmd],
      (state) => ({ ok: state.ok + 1 }),
      { ok: 0 }
    );

    await runtime.execute(stream, { type: "ok" });
    const locator = createStreamLocator(dataDir);
    const file = await locator.fileFor(stream);
    await fs.appendFile(file, "{bad json line}\n", "utf-8");

    expect(store.read(stream)).rejects.toThrow(/Corrupt JSONL record/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
