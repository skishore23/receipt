import { createHash } from "node:crypto";

import type { Receipt } from "@receipt/core/types";
import type { Runtime } from "@receipt/core/runtime";

import { makeEventId, optionalTrimmedString } from "../../framework/http";
import { agentRunStream } from "../agent.streams";
import type { AgentCmd, AgentEvent, AgentState } from "../../modules/agent";
import { factoryChatSessionStream } from "../../services/factory-chat-profiles";
import { renderObjectiveHandoffMessage } from "./chat-items";

export type ObjectiveHandoffView = {
  readonly objectiveId: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly updatedAt?: number;
  readonly summary?: string;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly blockedExplanation?: string | { readonly summary: string };
  readonly nextAction?: string;
  readonly latestDecision?: {
    readonly summary: string;
    readonly at: number;
  };
  readonly latestDecisionSummary?: string;
  readonly latestDecisionAt?: number;
  readonly latestHandoff?: {
    readonly status: "blocked" | "completed" | "failed" | "canceled";
    readonly summary: string;
    readonly renderedBody?: string;
    readonly output?: string;
    readonly blocker?: string;
    readonly nextAction?: string;
    readonly handoffKey: string;
    readonly sourceUpdatedAt: number;
  };
};

type ObjectiveHandoffPresence = {
  readonly problem: boolean;
  readonly binding: boolean;
  readonly handoff: boolean;
  readonly finalized: boolean;
  readonly status: boolean;
};

const hasCompleteObjectiveHandoff = (presence: ObjectiveHandoffPresence): boolean =>
  presence.problem
  && presence.binding
  && presence.handoff
  && presence.finalized
  && presence.status;

const objectiveHandoffStatus = (
  objective: Pick<ObjectiveHandoffView, "status" | "phase">,
): "blocked" | "completed" | "failed" | "canceled" | undefined => {
  const phase = optionalTrimmedString(objective.phase)?.toLowerCase();
  if (phase === "blocked" || phase === "completed" || phase === "failed" || phase === "canceled") return phase;
  const status = optionalTrimmedString(objective.status)?.toLowerCase();
  if (status === "blocked" || status === "completed" || status === "failed" || status === "canceled") return status;
  return undefined;
};

const objectiveBlockedExplanation = (
  objective: Pick<ObjectiveHandoffView, "blockedExplanation" | "blockedReason">,
): string | undefined => {
  const structured = objective.blockedExplanation;
  if (typeof structured === "string") return optionalTrimmedString(structured);
  return optionalTrimmedString(structured?.summary) ?? optionalTrimmedString(objective.blockedReason);
};

const isGenericCompletedNextAction = (value?: string): boolean => {
  const normalized = optionalTrimmedString(value)?.toLowerCase();
  return normalized === "investigation is complete." || normalized === "objective is complete.";
};

export const buildObjectiveHandoffPayload = (
  objective: ObjectiveHandoffView,
): Extract<AgentEvent, { readonly type: "objective.handoff" }> | undefined => {
  if (objective.latestHandoff) {
    return {
      type: "objective.handoff",
      runId: `run_objective_handoff_${objective.objectiveId}_${objective.latestHandoff.handoffKey}`,
      agentId: "orchestrator",
      objectiveId: objective.objectiveId,
      title: objective.title,
      status: objective.latestHandoff.status,
      summary: objective.latestHandoff.summary,
      ...(objective.latestHandoff.renderedBody ? { renderedBody: objective.latestHandoff.renderedBody } : {}),
      ...(objective.latestHandoff.output ? { output: objective.latestHandoff.output } : {}),
      ...(objective.latestHandoff.blocker ? { blocker: objective.latestHandoff.blocker } : {}),
      ...(objective.latestHandoff.nextAction ? { nextAction: objective.latestHandoff.nextAction } : {}),
      handoffKey: objective.latestHandoff.handoffKey,
      sourceUpdatedAt: objective.latestHandoff.sourceUpdatedAt,
    };
  }
  const status = objectiveHandoffStatus(objective);
  if (!status) return undefined;
  const summary = optionalTrimmedString(
    objective.summary
    ?? objective.latestSummary
    ?? objectiveBlockedExplanation(objective)
    ?? objective.latestDecision?.summary
    ?? objective.latestDecisionSummary
    ?? `${objective.title} is ${status}.`,
  ) ?? `${objective.title} is ${status}.`;
  const blocker = status === "blocked" ? objectiveBlockedExplanation(objective) : undefined;
  const nextAction = optionalTrimmedString(objective.nextAction);
  const effectiveNextAction = status === "completed" && isGenericCompletedNextAction(nextAction)
    ? undefined
    : nextAction;
  const sourceUpdatedAt = objective.latestDecision?.at
    ?? objective.latestDecisionAt
    ?? objective.updatedAt
    ?? 0;
  const handoffKey = createHash("sha1")
    .update(JSON.stringify({
      objectiveId: objective.objectiveId,
      status,
      summary,
      blocker,
      nextAction: effectiveNextAction,
      sourceUpdatedAt,
    }))
    .digest("hex")
    .slice(0, 16);
  return {
    type: "objective.handoff",
    runId: `run_objective_handoff_${objective.objectiveId}_${handoffKey}`,
    agentId: "orchestrator",
    objectiveId: objective.objectiveId,
    title: objective.title,
    status,
    summary,
    ...(blocker ? { blocker } : {}),
    ...(effectiveNextAction ? { nextAction: effectiveNextAction } : {}),
    handoffKey,
    sourceUpdatedAt,
  };
};

const collectPresence = (
  chain: ReadonlyArray<Receipt<AgentEvent>>,
  streamType: "session" | "run",
  handoff: Extract<AgentEvent, { readonly type: "objective.handoff" }>,
  chatId: string,
  latestSessionHandoff: AgentEvent | undefined,
): ObjectiveHandoffPresence => ({
  problem: chain.some((receipt) =>
    receipt.body.type === "problem.set"
    && receipt.body.runId === handoff.runId,
  ),
  binding: chain.some((receipt) =>
    receipt.body.type === "thread.bound"
    && receipt.body.runId === handoff.runId
    && receipt.body.objectiveId === handoff.objectiveId
    && receipt.body.chatId === chatId,
  ),
  handoff: streamType === "session"
    ? latestSessionHandoff?.type === "objective.handoff"
      && latestSessionHandoff.handoffKey === handoff.handoffKey
    : chain.some((receipt) =>
      receipt.body.type === "objective.handoff"
      && receipt.body.handoffKey === handoff.handoffKey,
    ),
  finalized: chain.some((receipt) =>
    receipt.body.type === "response.finalized"
    && receipt.body.runId === handoff.runId,
  ),
  status: chain.some((receipt) =>
    receipt.body.type === "run.status"
    && receipt.body.runId === handoff.runId
    && receipt.body.status === "completed",
  ),
});

const buildMissingEvents = (
  presence: ObjectiveHandoffPresence,
  handoff: Extract<AgentEvent, { readonly type: "objective.handoff" }>,
  chatId: string,
  renderedBody: string,
): ReadonlyArray<AgentEvent> => {
  const problemEvent: Extract<AgentEvent, { readonly type: "problem.set" }> = {
    type: "problem.set",
    runId: handoff.runId,
    agentId: "orchestrator",
    problem: `Objective handoff for ${handoff.title}`,
  };
  const threadBoundEvent: Extract<AgentEvent, { readonly type: "thread.bound" }> = {
    type: "thread.bound",
    runId: handoff.runId,
    agentId: "orchestrator",
    objectiveId: handoff.objectiveId,
    chatId,
    reason: "dispatch_update",
  };
  const finalEvent: Extract<AgentEvent, { readonly type: "response.finalized" }> = {
    type: "response.finalized",
    runId: handoff.runId,
    agentId: "orchestrator",
    content: renderedBody,
  };
  const statusEvent: Extract<AgentEvent, { readonly type: "run.status" }> = {
    type: "run.status",
    runId: handoff.runId,
    agentId: "orchestrator",
    status: "completed",
    note: `objective ${handoff.status} handoff`,
  };
  return [
    ...(!presence.problem ? [problemEvent] : []),
    ...(!presence.binding ? [threadBoundEvent] : []),
    ...(!presence.handoff ? [handoff] : []),
    ...(!presence.finalized ? [finalEvent] : []),
    ...(!presence.status ? [statusEvent] : []),
  ];
};

const emitMissingEvents = async (
  runtime: Runtime<AgentCmd, AgentEvent, AgentState>,
  stream: string,
  events: ReadonlyArray<AgentEvent>,
): Promise<void> => {
  for (const event of events) {
    await runtime.execute(stream, {
      type: "emit",
      eventId: makeEventId(stream),
      event,
    });
  }
};

export const writeObjectiveHandoffToSession = async (input: {
  readonly agentRuntime: Runtime<AgentCmd, AgentEvent, AgentState>;
  readonly repoRoot: string;
  readonly profileId: string;
  readonly chatId: string;
  readonly objective: ObjectiveHandoffView;
}): Promise<void> => {
  const handoff = buildObjectiveHandoffPayload(input.objective);
  if (!handoff) return;
  const renderedHandoff = renderObjectiveHandoffMessage(handoff);
  const sessionStream = factoryChatSessionStream(input.repoRoot, input.profileId, input.chatId);
  const sessionChain = await input.agentRuntime.chain(sessionStream);
  const latestSessionHandoff = [...sessionChain].reverse().find((receipt) =>
    receipt.body.type === "objective.handoff"
    && receipt.body.objectiveId === handoff.objectiveId,
  )?.body;
  const runStream = agentRunStream(sessionStream, handoff.runId);
  const runChain = await input.agentRuntime.chain(runStream);
  const runPresence = collectPresence(runChain, "run", handoff, input.chatId, latestSessionHandoff);
  const sessionPresence = collectPresence(sessionChain, "session", handoff, input.chatId, latestSessionHandoff);
  if (hasCompleteObjectiveHandoff(sessionPresence) && hasCompleteObjectiveHandoff(runPresence)) return;
  const runEvents = buildMissingEvents(runPresence, handoff, input.chatId, renderedHandoff.body);
  const sessionEvents = buildMissingEvents(sessionPresence, handoff, input.chatId, renderedHandoff.body);
  if (runEvents.length > 0) await emitMissingEvents(input.agentRuntime, runStream, runEvents);
  if (sessionEvents.length > 0) await emitMissingEvents(input.agentRuntime, sessionStream, sessionEvents);
};

export const makeDispatchRunId = (objectiveId: string): string =>
  `run_objective_dispatch_${objectiveId}`;

export const writeObjectiveDispatchToSession = async (input: {
  readonly agentRuntime: Runtime<AgentCmd, AgentEvent, AgentState>;
  readonly repoRoot: string;
  readonly profileId: string;
  readonly chatId: string;
  readonly objectiveId: string;
  readonly title: string;
  readonly prompt: string;
}): Promise<string> => {
  const runId = makeDispatchRunId(input.objectiveId);
  const sessionStream = factoryChatSessionStream(input.repoRoot, input.profileId, input.chatId);
  const runStream = agentRunStream(sessionStream, runId);
  const sessionChain = await input.agentRuntime.chain(sessionStream);
  const alreadyDispatched = sessionChain.some((receipt) =>
    receipt.body.type === "thread.bound"
    && receipt.body.runId === runId
    && receipt.body.objectiveId === input.objectiveId,
  );
  if (alreadyDispatched) return runId;
  const events: ReadonlyArray<AgentEvent> = [
    {
      type: "problem.set",
      runId,
      agentId: "orchestrator",
      problem: input.prompt,
    },
    {
      type: "thread.bound",
      runId,
      agentId: "orchestrator",
      objectiveId: input.objectiveId,
      chatId: input.chatId,
      reason: "dispatch_create",
    },
    {
      type: "response.finalized",
      runId,
      agentId: "orchestrator",
      content: `I started **${input.title}** as a tracked objective. It can keep running in the background while we continue the conversation here.`,
    },
    {
      type: "run.status",
      runId,
      agentId: "orchestrator",
      status: "completed",
      note: "objective dispatched from composer",
    },
  ];
  for (const event of events) {
    await input.agentRuntime.execute(runStream, {
      type: "emit",
      eventId: makeEventId(runStream),
      event,
    });
    await input.agentRuntime.execute(sessionStream, {
      type: "emit",
      eventId: makeEventId(sessionStream),
      event,
    });
  }
  return runId;
};
