import type { Resonate } from "@resonatehq/sdk";

import { createRuntime } from "@receipt/core/runtime";

import { sqliteBranchStore, sqliteReceiptStore } from "../../adapters/sqlite";
import { targetForGroup } from "../../adapters/resonate-config";
import { buildAgentView } from "./agent-loop";
import { loadDefinedAgentSpec } from "../../sdk/agent-spec-loader";

export const RESONATE_AGENT_ACTION_FUNCTION = "receipt.agent.action.execute";

type GenericEvent = {
  readonly type: string;
  readonly [key: string]: unknown;
};

type GenericCmd = {
  readonly type: "emit";
  readonly event: GenericEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export type RemoteActionResult = {
  readonly emitted: ReadonlyArray<{
    readonly type: string;
    readonly body: Record<string, unknown>;
  }>;
};

export type RemoteActionInvocation = {
  readonly agentId: string;
  readonly stream: string;
  readonly actionId: string;
  readonly deps?: Record<string, unknown>;
};

const createAgentRuntime = (dataDir: string) => createRuntime<GenericCmd, GenericEvent, { readonly ok: true }>(
  sqliteReceiptStore<GenericEvent>(dataDir),
  sqliteBranchStore(dataDir),
  (cmd) => [cmd.event],
  (state) => state,
  { ok: true },
);

export const runRemoteAgentAction = async (
  dataDir: string,
  input: RemoteActionInvocation,
): Promise<RemoteActionResult> => {
  const spec = await loadDefinedAgentSpec(input.agentId);
  if (!spec) {
    throw new Error(`agent spec '${input.agentId}' does not support remote execution`);
  }
  const runtime = createAgentRuntime(dataDir);
  const chain = await runtime.chain(input.stream);
  const view = buildAgentView(chain, spec as never);
  const action = spec.actions((input.deps ?? {}) as Record<string, unknown>).find((candidate) => candidate.id === input.actionId);
  if (!action) {
    throw new Error(`unknown action '${input.actionId}' for agent '${input.agentId}'`);
  }

  const emitted: Array<{ readonly type: string; readonly body: Record<string, unknown> }> = [];
  await action.run({
    ...(input.deps ?? {}),
    view,
    emit: async (type: string, body: unknown) => {
      emitted.push({
        type,
        body: (body && typeof body === "object" && !Array.isArray(body)
          ? body
          : {}) as Record<string, unknown>,
      });
    },
  });
  return { emitted };
};

export const registerResonateAgentActionWorker = (
  client: Resonate,
  dataDir: string,
): void => {
  client.register(RESONATE_AGENT_ACTION_FUNCTION, async (_ctx, input: RemoteActionInvocation) =>
    runRemoteAgentAction(dataDir, input), { version: 1 });
};

export const createResonateAgentActionAdapter = (
  client: Resonate,
  opts: {
    readonly dataDir: string;
    readonly defaultTargetGroup: string;
  },
): {
  readonly execute: (input: {
    readonly agentId: string;
    readonly stream: string;
    readonly actionId: string;
    readonly invocationId: string;
    readonly targetGroup?: string;
    readonly deps?: Record<string, unknown>;
  }) => Promise<RemoteActionResult>;
} => ({
  execute: async (input) => {
    const handle = await client.beginRpc<RemoteActionResult>(
      input.invocationId,
      RESONATE_AGENT_ACTION_FUNCTION,
      {
        agentId: input.agentId,
        stream: input.stream,
        actionId: input.actionId,
        deps: input.deps,
      } satisfies RemoteActionInvocation,
      client.options({
        target: targetForGroup(input.targetGroup?.trim() || opts.defaultTargetGroup),
        timeout: 120_000,
      }),
    );
    return handle.result();
  },
});
