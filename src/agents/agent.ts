// ============================================================================
// Agent framework surface - specs + registry
// ============================================================================

import type { EmitFn } from "./workflow.js";

export type AgentRunContext<Deps, Event> = Deps & {
  readonly stream: string;
  readonly runId: string;
  readonly emit: EmitFn<Event>;
  readonly now: () => number;
};

export type AgentSpec<Deps, Config, Event> = {
  readonly id: string;
  readonly version: string;
  readonly run: (ctx: AgentRunContext<Deps, Event>, config: Config) => Promise<void>;
  readonly examples?: ReadonlyArray<{ id: string; label: string; prompt: string }>;
};

export type AgentRegistry<Deps = unknown, Config = unknown, Event = unknown> = {
  readonly register: (spec: AgentSpec<Deps, Config, Event>) => AgentRegistry<Deps, Config, Event>;
  readonly get: (id: string) => AgentSpec<Deps, Config, Event> | undefined;
  readonly list: () => AgentSpec<Deps, Config, Event>[];
};

export const createAgentRegistry = <Deps = unknown, Config = unknown, Event = unknown>(): AgentRegistry<Deps, Config, Event> => {
  const specs = new Map<string, AgentSpec<Deps, Config, Event>>();
  return {
    register: (spec) => {
      specs.set(spec.id, spec);
      return createAgentRegistryFrom(specs);
    },
    get: (id) => specs.get(id),
    list: () => Array.from(specs.values()),
  };
};

const createAgentRegistryFrom = <Deps, Config, Event>(
  specs: Map<string, AgentSpec<Deps, Config, Event>>
): AgentRegistry<Deps, Config, Event> => ({
  register: (spec) => {
    specs.set(spec.id, spec);
    return createAgentRegistryFrom(specs);
  },
  get: (id) => specs.get(id),
  list: () => Array.from(specs.values()),
});
