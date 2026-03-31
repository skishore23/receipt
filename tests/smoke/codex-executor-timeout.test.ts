import { test, expect } from "bun:test";
import { LocalCodexExecutor } from "../../src/adapters/codex-executor";

test("default timeout is 30 minutes (1_800_000ms)", () => {
  const executor = new LocalCodexExecutor();
  const timeoutMs = (executor as unknown as { timeoutMs: number }).timeoutMs;
  expect(timeoutMs).toBe(1_800_000);
});
