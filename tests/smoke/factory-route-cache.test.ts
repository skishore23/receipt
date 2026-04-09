import { expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Runtime } from "@receipt/core/runtime";

import { createFactoryRouteCache } from "../../src/agents/factory/route/cache";
import type { AgentLoaderContext } from "../../src/framework/agent-types";
import type { AgentCmd, AgentEvent, AgentState } from "../../src/modules/agent";
import type { FactoryService } from "../../src/services/factory-service";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const createContextStub = (): AgentLoaderContext =>
  ({
    queue: {
      snapshot: () => ({ version: 0 }),
      listJobs: async () => [],
    },
  }) as unknown as AgentLoaderContext;

const createServiceStub = (projectionVersionFresh: () => Promise<number>): FactoryService =>
  ({
    git: { repoRoot: ROOT },
    projectionVersionFresh,
  }) as unknown as FactoryService;

const createAgentRuntimeStub = (
  chain: (stream: string) => Promise<ReadonlyArray<unknown>>,
): Runtime<AgentCmd, AgentEvent, AgentState> =>
  ({
    chain,
  }) as unknown as Runtime<AgentCmd, AgentEvent, AgentState>;

test("factory route cache collapses concurrent objective version reads", async () => {
  let calls = 0;
  const cache = createFactoryRouteCache({
    ctx: createContextStub(),
    service: createServiceStub(async () => {
      calls += 1;
      return 17;
    }),
    profileRoot: ROOT,
    agentRuntime: createAgentRuntimeStub(async () => []),
  });

  const [first, second] = await Promise.all([
    cache.resolveObjectiveProjectionVersionCached(),
    cache.resolveObjectiveProjectionVersionCached(),
  ]);

  expect(first).toBe(17);
  expect(second).toBe(17);
  expect(calls).toBe(1);
});

test("factory route cache collapses concurrent session version reads", async () => {
  let chainCalls = 0;
  const cache = createFactoryRouteCache({
    ctx: createContextStub(),
    service: createServiceStub(async () => 0),
    profileRoot: ROOT,
    agentRuntime: createAgentRuntimeStub(async () => {
      chainCalls += 1;
      return [];
    }),
  });

  const [first, second] = await Promise.all([
    cache.resolveSessionStreamVersionCached({
      profileId: "generalist",
      chatId: "chat_demo",
    }),
    cache.resolveSessionStreamVersionCached({
      profileId: "generalist",
      chatId: "chat_demo",
    }),
  ]);

  expect(first).toBe("0:");
  expect(second).toBe("0:");
  expect(chainCalls).toBe(1);
});
