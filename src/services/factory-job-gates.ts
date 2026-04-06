import type { QueueJob } from "../adapters/jsonl-queue";

type ObjectiveJobKind = "factory.objective.audit" | "factory.objective.control";
type ObjectiveReconcileSignalKind =
  | "factory.task.monitor"
  | "factory.task.run"
  | "factory.integration.validate"
  | "factory.integration.publish";

type ObjectiveQueueGateJob = Pick<
  QueueJob,
  "agentId" | "createdAt" | "id" | "payload" | "status" | "updatedAt"
>;

type ObjectiveQueueGateInput = {
  readonly controlAgentId: string;
  readonly objectiveId: string;
  readonly recentJobs: ReadonlyArray<ObjectiveQueueGateJob>;
};

const isMatchingObjectiveJob = (
  job: ObjectiveQueueGateJob,
  kind: ObjectiveJobKind,
  controlAgentId: string,
  objectiveId: string,
): boolean =>
  job.agentId === controlAgentId
  && job.payload.kind === kind
  && job.payload.objectiveId === objectiveId;

const compareRecentJobs = (left: ObjectiveQueueGateJob, right: ObjectiveQueueGateJob): number =>
  right.updatedAt - left.updatedAt
  || right.createdAt - left.createdAt
  || right.id.localeCompare(left.id);

const latestObjectiveJob = (
  input: ObjectiveQueueGateInput & { readonly kind: ObjectiveJobKind },
): ObjectiveQueueGateJob | undefined =>
  input.recentJobs
    .filter((job) =>
      isMatchingObjectiveJob(job, input.kind, input.controlAgentId, input.objectiveId))
    .sort(compareRecentJobs)[0];

const isActiveJobStatus = (status: QueueJob["status"]): boolean =>
  status === "queued" || status === "leased" || status === "running";

const LEASE_EXPIRED_RE = /\blease expired\b/i;

const isObjectiveReconcileSignalKind = (value: unknown): value is ObjectiveReconcileSignalKind =>
  value === "factory.task.run"
  || value === "factory.task.monitor"
  || value === "factory.integration.validate"
  || value === "factory.integration.publish";

export const shouldReconcileObjectiveFromJobChange = (
  job: Pick<QueueJob, "lastError" | "payload" | "status">,
): boolean => {
  const kind = typeof job.payload.kind === "string" ? job.payload.kind.trim() : "";
  if (!isObjectiveReconcileSignalKind(kind)) return false;
  if (job.status === "failed" || job.status === "canceled") return true;
  return job.status === "queued"
    && LEASE_EXPIRED_RE.test(job.lastError ?? "");
};

export const shouldQueueObjectiveControlReconcile = (
  input: ObjectiveQueueGateInput & {
    readonly objectiveInactive?: boolean;
    readonly sourceUpdatedAt: number;
  },
): boolean => {
  if (input.objectiveInactive) return false;
  const latest = latestObjectiveJob({ ...input, kind: "factory.objective.control" });
  if (!latest) return true;
  if (isActiveJobStatus(latest.status)) return false;
  return latest.updatedAt < input.sourceUpdatedAt;
};

export const shouldQueueObjectiveAudit = (
  input: ObjectiveQueueGateInput & {
    readonly objectiveUpdatedAt: number;
  },
): boolean => {
  const latest = latestObjectiveJob({ ...input, kind: "factory.objective.audit" });
  if (!latest) return true;
  if (isActiveJobStatus(latest.status)) return false;
  const latestObjectiveUpdatedAt = typeof latest.payload.objectiveUpdatedAt === "number" && Number.isFinite(latest.payload.objectiveUpdatedAt)
    ? latest.payload.objectiveUpdatedAt
    : 0;
  return latestObjectiveUpdatedAt < input.objectiveUpdatedAt;
};
