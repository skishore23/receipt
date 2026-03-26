import { fold } from "@receipt/core/chain";

import { initial as initialAgent, reduce as reduceAgent, type AgentEvent, type AgentState } from "../../modules/agent";

import type { AgentRunChain } from "./shared";

export type AgentRunProjection = {
  readonly state: AgentState;
  readonly firstTs?: number;
  readonly problem?: Extract<AgentEvent, { readonly type: "problem.set" }>;
  readonly final?: Extract<AgentEvent, { readonly type: "response.finalized" }>;
};

const projectionCache = new WeakMap<AgentRunChain, AgentRunProjection>();

export const projectAgentRun = (chain: AgentRunChain): AgentRunProjection => {
  const cached = projectionCache.get(chain);
  if (cached) return cached;

  const state = fold(chain, reduceAgent, initialAgent);
  const projection: AgentRunProjection = {
    state,
    firstTs: chain[0]?.ts,
    problem: chain.find((receipt) => receipt.body.type === "problem.set")?.body as AgentRunProjection["problem"],
    final: [...chain].reverse().find((receipt) => receipt.body.type === "response.finalized")?.body as AgentRunProjection["final"],
  };
  projectionCache.set(chain, projection);
  return projection;
};
