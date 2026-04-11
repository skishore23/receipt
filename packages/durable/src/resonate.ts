import type { Resonate } from "@resonatehq/sdk";

import type { DurableBackend } from "./contract";

type ResonateDurableBackendOptions = {
  readonly local: DurableBackend;
  readonly client?: Pick<Resonate, "beginRpc" | "options">;
  readonly workflowTarget?: string;
};

export const createResonateDurableBackend = (
  opts: ResonateDurableBackendOptions,
): DurableBackend => {
  const dispatchWorkflow = async (
    key: string,
    phase: "start" | "signal",
  ): Promise<void> => {
    if (!opts.client || !opts.workflowTarget) return;
    try {
      await opts.client.beginRpc(
        `${key}:${phase}`,
        "durable.workflow.dispatch",
        { key, phase },
        opts.client.options({
          target: opts.workflowTarget,
          timeout: 30_000,
          tags: {
            durableKey: key,
            phase,
          },
        }),
      );
    } catch {
      // The SQLite-backed durable state remains authoritative even when dispatch fails.
    }
  };

  return {
    ...opts.local,
    startOrResumeWorkflow: async (input) => {
      const snapshot = await opts.local.startOrResumeWorkflow(input);
      await dispatchWorkflow(input.key, "start");
      return snapshot;
    },
    signalWorkflow: async (input) => {
      const signal = await opts.local.signalWorkflow(input);
      await dispatchWorkflow(input.key, "signal");
      return signal;
    },
  };
};
