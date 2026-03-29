import { factoryChatSessionStream, factoryChatStream } from "../../services/factory-chat-profiles";
import type { FactoryChatItem, FactoryInspectorPanel, FactoryInspectorTab, FactoryViewMode } from "../../views/factory-models";
import type { QueueJob } from "../../adapters/jsonl-queue";

import { tryParseJson } from "./formatters";
import {
  asObject,
  asString,
  compareJobsByRecency,
  isRelevantShellJob,
  jobObjectiveId,
  normalizeKnownObjectiveId,
  type AgentRunChain,
} from "./shared";

export const buildChatLink = (input: {
  readonly mode?: FactoryViewMode;
  readonly profileId?: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly panel?: FactoryInspectorPanel;
  readonly inspectorTab?: FactoryInspectorTab;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
}): string => {
  const params = new URLSearchParams();
  if (input.mode === "mission-control") params.set("mode", input.mode);
  if (input.profileId) params.set("profile", input.profileId);
  if (input.chatId) params.set("chat", input.chatId);
  if (input.objectiveId) params.set("thread", input.objectiveId);
  if (input.runId) params.set("run", input.runId);
  if (input.jobId) params.set("job", input.jobId);
  if (input.panel) params.set("panel", input.panel);
  if (input.inspectorTab) params.set("inspectorTab", input.inspectorTab);
  if (input.focusKind && input.focusId) {
    params.set("focusKind", input.focusKind);
    params.set("focusId", input.focusId);
  }
  const query = params.toString();
  return `/factory${query ? `?${query}` : ""}`;
};

export const resolveChatViewStream = (input: {
  readonly repoRoot: string;
  readonly profileId: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly job?: QueueJob;
}): string | undefined =>
  input.chatId
    ? factoryChatSessionStream(input.repoRoot, input.profileId, input.chatId)
    : input.objectiveId
      ? factoryChatStream(input.repoRoot, input.profileId, input.objectiveId)
      : asString(input.job?.payload.parentStream)
        ?? asString(input.job?.payload.stream);

export const latestObjectiveIdFromRunChains = (
  runChains: ReadonlyArray<AgentRunChain>,
): string | undefined => {
  for (let chainIndex = runChains.length - 1; chainIndex >= 0; chainIndex -= 1) {
    const chain = runChains[chainIndex] ?? [];
    for (let receiptIndex = chain.length - 1; receiptIndex >= 0; receiptIndex -= 1) {
      const event = chain[receiptIndex]?.body;
      if (!event) continue;
      if (event.type === "thread.bound") {
        const objectiveId = asString(event.objectiveId);
        if (objectiveId) return objectiveId;
        continue;
      }
      if (event.type === "tool.observed") {
        const output = typeof event.output === "string" ? tryParseJson(event.output) : asObject(event.output);
        const objectiveId = asString(output?.objectiveId);
        if (objectiveId) return objectiveId;
        continue;
      }
      if (event.type === "tool.called") {
        const input = typeof event.input === "string" ? tryParseJson(event.input) : asObject(event.input);
        const objectiveId = asString(input?.objectiveId);
        if (objectiveId) return objectiveId;
      }
    }
  }
  return undefined;
};

export const latestObjectiveIdFromJobs = (
  jobs: ReadonlyArray<QueueJob>,
  stream: string,
  chatId?: string,
): string | undefined =>
  [...jobs]
    .filter((job) =>
      (chatId && asString(job.payload.chatId) === chatId)
      || isRelevantShellJob(job, stream)
    )
    .sort(compareJobsByRecency)
    .map((job) => jobObjectiveId(job))
    .find((objectiveId): objectiveId is string => typeof objectiveId === "string" && objectiveId.trim().length > 0);

const objectiveIdFromChatItem = (item: FactoryChatItem): string | undefined =>
  item.kind === "objective_event"
    ? item.objectiveId
    : item.kind === "work"
      ? item.card.objectiveId
      : undefined;

export const collectScopedObjectiveIds = (input: {
  readonly requestedObjectiveId?: string;
  readonly resolvedObjectiveId?: string;
  readonly chatId?: string;
  readonly items: ReadonlyArray<FactoryChatItem>;
  readonly jobs: ReadonlyArray<QueueJob>;
}): ReadonlyArray<string> => {
  const requestedObjectiveId = input.requestedObjectiveId?.trim();
  if (requestedObjectiveId) {
    return [input.resolvedObjectiveId ?? requestedObjectiveId];
  }
  if (!input.chatId) {
    return input.resolvedObjectiveId ? [input.resolvedObjectiveId] : [];
  }
  return [...new Set([
    ...(input.resolvedObjectiveId ? [input.resolvedObjectiveId] : []),
    ...input.items
      .map((item) => objectiveIdFromChatItem(item))
      .filter((objectiveId): objectiveId is string => typeof objectiveId === "string" && objectiveId.trim().length > 0),
    ...input.jobs
      .map((job) => jobObjectiveId(job))
      .filter((objectiveId): objectiveId is string => typeof objectiveId === "string" && objectiveId.trim().length > 0),
  ])];
};

export { normalizeKnownObjectiveId };
