import type { AgentState } from "../modules/agent.js";
import type { FailureRecord } from "../modules/failure.js";

const withoutUpdatedAt = (failure: AgentState["failure"] | undefined): FailureRecord | undefined => {
  if (!failure) return undefined;
  const { updatedAt: _updatedAt, ...rest } = failure;
  return {
    ...rest,
    evidence: rest.evidence ? { ...rest.evidence } : undefined,
  };
};

export type AgentRunResult = {
  readonly runId: string;
  readonly stream: string;
  readonly runStream: string;
  readonly status: AgentState["status"];
  readonly note?: string;
  readonly finalResponse?: string;
  readonly failure?: FailureRecord;
};

export const buildAgentRunResult = (opts: {
  readonly runId: string;
  readonly stream: string;
  readonly runStream: string;
  readonly state: AgentState;
}): AgentRunResult => ({
  runId: opts.runId,
  stream: opts.stream,
  runStream: opts.runStream,
  status: opts.state.status,
  note: opts.state.statusNote,
  finalResponse: opts.state.finalResponse,
  failure: withoutUpdatedAt(opts.state.failure),
});
