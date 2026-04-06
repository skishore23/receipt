import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { createRuntime } from "@receipt/core/runtime";
import { runAgentLoop } from "../../src/engine/runtime/agent-loop";
import { action, assistant, tool } from "../../src/sdk/actions";
import { receipt } from "../../src/sdk/receipt";
import { defineAgent } from "../../src/sdk/agent";

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
    expect(types.includes("run.started")).toBe(true);
    expect(types.includes("action.selected")).toBe(true);
    expect(types.includes("action.completed")).toBe(true);
    expect(types.includes("goal.completed")).toBe(true);
    expect(types.includes("run.completed")).toBe(true);

    const selected = chain
      .map((r) => r.body)
      .filter((e): e is Event & { actionIds: ReadonlyArray<string> } => e.type === "action.selected" && Array.isArray(e.actionIds));
    expect(selected[0]?.actionIds?.[0]).toBe("first");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("agent loop prioritizes assistant-like work before tools when concurrency is capped", async () => {
  const dir = await mkTmp("receipt-agent-loop-priority");
  try {
    const runtime = mkRuntime(dir);
    const stream = "agents/demo/runs/r_priority";

    await runtime.execute(stream, {
      type: "emit",
      eventId: "seed",
      event: { type: "prompt.received", runId: "r_priority", prompt: "hello" },
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
        tool("toolish", {
          when: ({ view }) => Boolean(view.prompt) && !view.done,
          run: async () => {},
        }),
        assistant("assistantish", {
          when: ({ view }) => Boolean(view.prompt) && !view.done,
          run: async ({ emit }) => {
            emit("task.completed", { runId: "r_priority", output: "assistant" });
          },
        }),
      ],
      goal: ({ view }) => view.done,
      maxConcurrency: 1,
    });

    await runAgentLoop({
      spec,
      runtime,
      stream,
      runId: "r_priority",
      deps: {},
      wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId }),
    });

    const chain = await runtime.chain(stream);
    const selected = chain
      .map((r) => r.body)
      .find((e): e is Event & { actionIds: ReadonlyArray<string> } => e.type === "action.selected" && Array.isArray(e.actionIds));
    expect(selected?.actionIds?.[0]).toBe("assistantish");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("agent loop buffers remote action emissions and flushes them in parent order", async () => {
  const dir = await mkTmp("receipt-agent-loop-remote");
  try {
    const runtime = mkRuntime(dir);
    const stream = "agents/demo/runs/r_remote";

    await runtime.execute(stream, {
      type: "emit",
      eventId: "seed",
      event: { type: "prompt.received", runId: "r_remote", prompt: "hello" },
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
        action("remote-first", {
          when: ({ view }) => Boolean(view.prompt) && !view.done,
          execution: "remote",
          targetGroup: "receipt-chat",
          run: async () => {},
        }),
        action("remote-second", {
          when: ({ view }) => Boolean(view.prompt) && !view.done,
          execution: "remote",
          targetGroup: "receipt-chat",
          run: async () => {},
        }),
      ],
      goal: ({ view }) => view.done,
      maxConcurrency: 2,
    });

    const invocations: string[] = [];
    await runAgentLoop({
      spec,
      runtime,
      stream,
      runId: "r_remote",
      deps: {},
      remoteActionDeps: {},
      remoteActions: {
        execute: async (input) => {
          invocations.push(`${input.actionId}@${input.targetGroup}`);
          const delay = input.actionId === "remote-first" ? 20 : 0;
          await new Promise((resolve) => setTimeout(resolve, delay));
          return {
            emitted: input.actionId === "remote-first"
              ? [{ type: "task.completed", body: { runId: "r_remote", output: "first" } }]
              : [],
          };
        },
      },
      wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId }),
    });

    const chain = await runtime.chain(stream);
    const completed = chain.filter((receipt) => receipt.body.type === "action.completed").map((receipt) => (receipt.body as { actionId?: string }).actionId);
    const outputs = chain.filter((receipt) => receipt.body.type === "task.completed").map((receipt) => (receipt.body as { output?: string }).output);

    expect(invocations).toEqual(["remote-first@receipt-chat", "remote-second@receipt-chat"]);
    expect(outputs).toEqual(["first"]);
    expect(completed).toEqual(["remote-first", "remote-second"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
