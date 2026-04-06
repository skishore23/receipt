import type { Runtime } from "@receipt/core/runtime";

import type { AgentCmd, AgentEvent, AgentState } from "../../modules/agent";
import type { QueueJob } from "../../adapters/sqlite-queue";

export type AgentRunChain = Awaited<ReturnType<Runtime<AgentCmd, AgentEvent, AgentState>["chain"]>>;

export const isActiveJobStatus = (status?: string): boolean =>
  status === "queued" || status === "leased" || status === "running";

export const isTerminalJobStatus = (status: string | undefined): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

export const LIVE_JOB_STALE_AFTER_MS = 90_000;

export const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export const jobProgressAt = (job: QueueJob | undefined): number | undefined => {
  const result = asObject(job?.result);
  return typeof result?.progressAt === "number" && Number.isFinite(result.progressAt)
    ? result.progressAt
    : undefined;
};

export const displayJobStatus = (job: QueueJob | undefined, now = Date.now()): string => {
  if (!job) return "unknown";
  if (isTerminalJobStatus(job.status)) return job.status;
  const progressAt = jobProgressAt(job);
  if (job.status === "running" && typeof progressAt === "number" && now - progressAt >= LIVE_JOB_STALE_AFTER_MS) {
    return "stalled";
  }
  if (job.status === "leased") return "running";
  return job.status;
};

export const displayJobUpdatedAt = (job: QueueJob | undefined): number | undefined =>
  jobProgressAt(job) ?? job?.updatedAt;

export const isDisplayActiveJob = (job: QueueJob | undefined, now = Date.now()): boolean => {
  const status = displayJobStatus(job, now);
  return status === "queued" || status === "running";
};

export const profileLabel = (profileId?: string): string => {
  const value = profileId?.trim();
  if (!value) return "Active profile";
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
};

export const normalizedWorkerId = (agentId: string | undefined): string =>
  agentId?.trim() || "unknown";

export const payloadRecord = (job: QueueJob | undefined): Record<string, unknown> =>
  asObject(job?.payload) ?? {};

export const jobObjectiveId = (job: QueueJob | undefined): string | undefined =>
  asString(payloadRecord(job).objectiveId) ?? asString(asObject(job?.result)?.objectiveId);

export const jobRunId = (job: QueueJob | undefined): string | undefined =>
  asString(payloadRecord(job).runId);

export const jobParentRunId = (job: QueueJob | undefined): string | undefined =>
  asString(payloadRecord(job).parentRunId);

export const jobAnyRunId = (job: QueueJob | undefined): string | undefined =>
  jobRunId(job) ?? jobParentRunId(job);

export const isDescendantStream = (value: string | undefined, stream: string): boolean => {
  const candidate = value?.trim();
  if (!candidate) return false;
  return candidate === stream || candidate.startsWith(`${stream}/sub/`);
};

export const isRelevantShellJob = (job: QueueJob, stream: string, objectiveId?: string): boolean => {
  const payloadObjectiveId = asString(job.payload.objectiveId);
  const payloadStream = asString(job.payload.stream);
  const parentStream = asString(job.payload.parentStream);
  return isDescendantStream(payloadStream, stream)
    || isDescendantStream(parentStream, stream)
    || (Boolean(objectiveId) && payloadObjectiveId === objectiveId);
};

export const compareJobsByRecency = (left: QueueJob, right: QueueJob): number =>
  right.updatedAt - left.updatedAt
  || right.createdAt - left.createdAt
  || right.id.localeCompare(left.id);

export const reverseFind = <T,>(items: ReadonlyArray<T>, predicate: (item: T) => boolean): T | undefined => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return item;
  }
  return undefined;
};

export const normalizeKnownObjectiveId = <T extends { readonly objectiveId: string }>(
  candidate: string | undefined,
  objectives: ReadonlyArray<T>,
): string | undefined => {
  const objectiveId = candidate?.trim();
  if (!objectiveId) return undefined;
  return objectives.some((objective) => objective.objectiveId === objectiveId)
    ? objectiveId
    : undefined;
};

export const normalizeFocusKind = (value: string | undefined): "task" | "job" | undefined =>
  value === "task" || value === "job" ? value : undefined;
