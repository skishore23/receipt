import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import { runAgentLoop } from "../../src/engine/runtime/agent-loop.ts";
import { action } from "../../src/sdk/actions.ts";
import { receipt } from "../../src/sdk/receipt.ts";
import { defineAgent } from "../../src/sdk/agent.ts";

type Event = {
  readonly type: string;
  readonly runId?: string;
  readonly prompt?: string;
  readonly output?: string;
  readonly actionIds?: ReadonlyArray<string>;
  readonly reason?: string;
};

type Cmd = {
  readonly type: "emit";
  readonly event: Event;
  readonly eventId: string;
};

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const mkRuntime = (dir: string) => createRuntime<Cmd, Event, { readonly ok: true }>(
  jsonlStore<Event>(dir),
  jsonBranchStore(dir),
  (cmd) => [cmd.event],
  (state) => state,
  { ok: true }
);

test("agent loop emits control receipts and deterministic selection", async () => {
  const dir = await mkTmp("receipt-agent-loop");
  try {
    const runtime = mkRuntime(dir);
    const stream = "agents/demo/runs/r1";

    await runtime.execute(stream, {
      type: "emit",
      eventId: "seed",
      event: { type: "prompt.received", runId: "r1", prompt: "hello" },
    });

    const spec = defineAgent({
      id: "demo",
      version: "1.0.0",
      receipts: {
        "prompt.received": receipt<{ prompt: string; runId: string }>(),
        "task.completed": receipt<{ output: string; runId: string }>(),
      },
      view: ({ on }) => ({
        prompt: on("prompt.received").last()?.prompt,
        done: on("task.completed").exists(),
      }),
      actions: () => [
        action("first", {
          when: ({ view }) => Boolean(view.prompt) && !view.done,
          run: async ({ view, emit }) => {
            emit("task.completed", { runId: "r1", output: view.prompt ?? "" });
          },
        }),
        action("second", {
          when: ({ view }) => Boolean(view.prompt) && !view.done,
          run: async () => {},
        }),
      ],
      goal: ({ view }) => view.done,
      maxConcurrency: 1,
    });

    await runAgentLoop({
      spec,
      runtime,
      stream,
      runId: "r1",
      deps: {},
      wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId }),
    });

    const chain = await runtime.chain(stream);
    const types = chain.map((r) => r.body.type);
    assert.equal(types.includes("run.started"), true);
    assert.equal(types.includes("action.selected"), true);
    assert.equal(types.includes("action.completed"), true);
    assert.equal(types.includes("goal.completed"), true);
    assert.equal(types.includes("run.completed"), true);

    const selected = chain
      .map((r) => r.body)
      .filter((e): e is Event & { actionIds: ReadonlyArray<string> } => e.type === "action.selected" && Array.isArray(e.actionIds));
    assert.equal(selected[0]?.actionIds?.[0], "first");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
