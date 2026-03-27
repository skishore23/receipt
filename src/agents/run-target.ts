import type { AgentCmd, AgentEvent } from "../modules/agent";
import { agentRunStream } from "./agent.streams";

type AgentRunReceipt = {
  readonly body: AgentEvent;
};

type AgentRunTargetRuntime = {
  readonly chain: (stream: string) => Promise<ReadonlyArray<AgentRunReceipt>>;
  readonly execute: (stream: string, cmd: AgentCmd) => Promise<ReadonlyArray<AgentEvent>>;
};

export type AgentRunTarget = {
  readonly runId: string;
  readonly jobId?: string;
  readonly continued: boolean;
  readonly depth: number;
};

const DEFAULT_CONTINUATION_DEPTH_LIMIT = 32;

const latestContinuation = (
  chain: ReadonlyArray<AgentRunReceipt>,
): Extract<AgentEvent, { readonly type: "run.continued" }> | undefined => {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const receipt = chain[index];
    if (receipt?.body.type === "run.continued") return receipt.body;
  }
  return undefined;
};

export const resolveContinuedRunTarget = async (input: {
  readonly runtime: Pick<AgentRunTargetRuntime, "chain">;
  readonly baseStream: string;
  readonly parentRunId: string;
  readonly maxDepth?: number;
}): Promise<AgentRunTarget> => {
  const visited = new Set<string>([input.parentRunId]);
  const maxDepth = Math.max(1, input.maxDepth ?? DEFAULT_CONTINUATION_DEPTH_LIMIT);
  let currentRunId = input.parentRunId;
  let currentJobId: string | undefined;
  let depth = 0;

  while (depth < maxDepth) {
    const chain = await input.runtime.chain(agentRunStream(input.baseStream, currentRunId)).catch(() => []);
    const continuation = latestContinuation(chain);
    if (!continuation) break;
    if (visited.has(continuation.nextRunId)) break;
    currentRunId = continuation.nextRunId;
    currentJobId = continuation.nextJobId;
    visited.add(currentRunId);
    depth += 1;
  }

  return {
    runId: currentRunId,
    jobId: currentJobId,
    continued: depth > 0,
    depth,
  };
};

export const emitToContinuedRun = async (input: {
  readonly runtime: AgentRunTargetRuntime;
  readonly baseStream: string;
  readonly parentRunId: string;
  readonly eventIdForStream: (stream: string) => string;
  readonly eventForRun: (runId: string) => AgentEvent;
}): Promise<AgentRunTarget> => {
  const target = await resolveContinuedRunTarget({
    runtime: input.runtime,
    baseStream: input.baseStream,
    parentRunId: input.parentRunId,
  });
  const stream = agentRunStream(input.baseStream, target.runId);
  await input.runtime.execute(stream, {
    type: "emit",
    eventId: input.eventIdForStream(stream),
    event: input.eventForRun(target.runId),
  });
  return target;
};
