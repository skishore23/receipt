import { expect, test } from "bun:test";

import { createHeartbeat, parseHeartbeatSpecsFromEnv } from "../../src/adapters/heartbeat";

test("heartbeat config: parses env heartbeat specs with queue defaults", () => {
  const specs = parseHeartbeatSpecsFromEnv({
    HEARTBEAT_AGENT_INTERVAL_MS: "5000",
    HEARTBEAT_FACTORY_INTERVAL_MS: "12000",
    HEARTBEAT_CODEX_INTERVAL_MS: "999",
  });

  expect(specs).toEqual([
    {
      id: "heartbeat:agent",
      agentId: "agent",
      intervalMs: 5000,
      lane: "collect",
      sessionKey: "heartbeat:agent",
      singletonMode: "cancel",
      maxAttempts: 1,
      payload: { kind: "agent.heartbeat" },
    },
    {
      id: "heartbeat:factory",
      agentId: "factory",
      intervalMs: 12000,
      lane: "collect",
      sessionKey: "heartbeat:factory",
      singletonMode: "cancel",
      maxAttempts: 1,
      payload: { kind: "factory.heartbeat" },
    },
  ]);
});

test("heartbeat runtime: forwards schedule queue metadata to enqueue", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const heartbeat = createHeartbeat({
    id: "schedule:self-improve",
    agentId: "factory",
    intervalMs: 5,
    lane: "chat",
    sessionKey: "schedule:self-improve",
    singletonMode: "steer",
    maxAttempts: 2,
    payload: {
      kind: "factory.run",
      problem: "review recent memory",
    },
  }, {
    enqueue: async (opts) => {
      calls.push(opts);
      return { id: "job_demo" };
    },
  });

  heartbeat.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  heartbeat.stop();

  expect(calls.length).toBeGreaterThan(0);
  expect(calls[0]).toEqual({
    agentId: "factory",
    lane: "chat",
    sessionKey: "schedule:self-improve",
    singletonMode: "steer",
    maxAttempts: 2,
    payload: {
      kind: "factory.run",
      problem: "review recent memory",
    },
  });
});
