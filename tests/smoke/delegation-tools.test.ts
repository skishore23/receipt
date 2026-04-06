import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import { createDelegationTools } from "../../src/adapters/delegation";
import { sqliteReceiptStore } from "../../src/adapters/sqlite";
import { receipt } from "@receipt/core/chain";

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(`${os.tmpdir()}/${label}-`);

test("delegation tools: agent.inspect accepts a stream id and reads it from the sqlite-backed store", async () => {
  const dataDir = await createTempDir("receipt-delegation-inspect");
  const store = sqliteReceiptStore<Record<string, unknown>>(dataDir);
  const stream = "agents/factory/demo/generalist";

  await store.append(receipt(stream, undefined, {
    type: "response.finalized",
    runId: "run_01",
    agentId: "orchestrator",
    content: "Queued Codex. Ask for status while it runs.",
  }));

  const tools = createDelegationTools({
    enqueue: async () => ({ id: "job_unused" }),
    waitForJob: async () => ({ id: "job_unused", status: "completed" }),
    getJob: async () => ({ id: "job_unused", status: "completed" }),
    dataDir,
  });

  const result = await tools["agent.inspect"]({
    file: stream,
  });

  expect(result.summary).toContain(stream);
  expect(result.output).toContain("\"type\":\"response.finalized\"");
  expect(result.output).toContain("Queued Codex");
});

test("delegation tools: agent.inspect rejects non-stream references", async () => {
  const dataDir = await createTempDir("receipt-delegation-inspect-invalid");
  const tools = createDelegationTools({
    enqueue: async () => ({ id: "job_unused" }),
    waitForJob: async () => ({ id: "job_unused", status: "completed" }),
    getJob: async () => ({ id: "job_unused", status: "completed" }),
    dataDir,
  });

  await expect(tools["agent.inspect"]({
    file: "manual-reference",
  })).rejects.toThrow("must be a stream id");
});
