import type { QueueJob } from "../../adapters/sqlite-queue";
import type {
  FactoryCandidateRecord,
  FactoryObjectiveStatus,
  FactoryState,
  FactoryTaskRecord,
} from "../../modules/factory";
import { shouldReconcileObjectiveFromJobChange } from "../factory-job-gates";
import type {
  FactoryObjectiveDisplayState,
  FactoryObjectiveLiveJobAuthority,
  FactoryObjectivePhaseDetail,
  FactoryObjectiveStatusAuthority,
} from "../factory-types";

type ObjectiveStateSlice = Pick<
  FactoryState,
  "archivedAt" | "candidates" | "integration" | "scheduler" | "status" | "wait" | "workflow"
>;

export type FactoryObjectiveOperationalState = {
  readonly displayState: FactoryObjectiveDisplayState;
  readonly phaseDetail: FactoryObjectivePhaseDetail;
  readonly statusAuthority: FactoryObjectiveStatusAuthority;
  readonly hasAuthoritativeLiveJob: boolean;
};

type DeriveObjectiveOperationalStateInput = {
  readonly state: ObjectiveStateSlice;
  readonly taskCount: number;
  readonly executionStalled?: boolean;
  readonly objectiveJobs?: ReadonlyArray<QueueJob>;
};

const ACTIVE_JOB_STATUSES = new Set(["queued", "leased", "running"]);
const TERMINAL_OBJECTIVE_STATUSES = new Set<FactoryObjectiveStatus>(["completed", "failed", "canceled"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "canceled"]);

const activeIntegrationStatuses = new Set([
  "queued",
  "merging",
  "validating",
  "validated",
]);

const terminalPhaseForStatus = (
  status: FactoryObjectiveStatus,
): Extract<FactoryObjectivePhaseDetail, "completed" | "failed" | "canceled"> => {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return "failed";
  }
};

const terminalDisplayStateForStatus = (
  status: FactoryObjectiveStatus,
): Extract<FactoryObjectiveDisplayState, "Completed" | "Failed" | "Canceled"> => {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    default:
      return "Failed";
  }
};

const activeJobStatus = (status?: string): boolean =>
  typeof status === "string" && ACTIVE_JOB_STATUSES.has(status);

export const isTerminalQueueJobStatusValue = (status?: string): boolean =>
  typeof status === "string" && TERMINAL_JOB_STATUSES.has(status);

export const objectiveIdForQueueJob = (job: Pick<QueueJob, "payload">): string | undefined => {
  const objectiveId = typeof job.payload.objectiveId === "string" ? job.payload.objectiveId.trim() : "";
  return objectiveId.length > 0 ? objectiveId : undefined;
};

export const compareObjectiveScopedJobs = (left: QueueJob, right: QueueJob): number =>
  right.updatedAt - left.updatedAt
  || right.createdAt - left.createdAt
  || right.id.localeCompare(left.id);

export const groupObjectiveScopedJobs = (
  jobs: ReadonlyArray<QueueJob>,
): ReadonlyMap<string, ReadonlyArray<QueueJob>> => {
  const grouped = new Map<string, QueueJob[]>();
  for (const job of jobs) {
    const objectiveId = objectiveIdForQueueJob(job);
    if (!objectiveId) continue;
    const bucket = grouped.get(objectiveId) ?? [];
    bucket.push(job);
    grouped.set(objectiveId, bucket);
  }
  for (const [objectiveId, bucket] of grouped.entries()) {
    grouped.set(objectiveId, [...bucket].sort(compareObjectiveScopedJobs));
  }
  return grouped;
};

const taskEntries = (state: ObjectiveStateSlice): ReadonlyArray<FactoryTaskRecord> =>
  state.workflow.taskIds
    .map((taskId) => state.workflow.tasksById[taskId])
    .filter((task): task is FactoryTaskRecord => Boolean(task));

const candidateEntries = (state: ObjectiveStateSlice): ReadonlyArray<FactoryCandidateRecord> =>
  Object.values(state.candidates)
    .filter((candidate): candidate is FactoryCandidateRecord => Boolean(candidate));

const hasAwaitingReview = (state: ObjectiveStateSlice): boolean =>
  state.integration.status === "ready_to_promote"
  || taskEntries(state).some((task) => task.status === "reviewing")
  || candidateEntries(state).some((candidate) => candidate.status === "awaiting_review");

const jobKind = (job: Pick<QueueJob, "payload">): string =>
  typeof job.payload.kind === "string" ? job.payload.kind.trim() : "";

const nonAuditLiveJobs = (jobs: ReadonlyArray<QueueJob>): ReadonlyArray<QueueJob> =>
  jobs.filter((job) => activeJobStatus(job.status) && jobKind(job) !== "factory.objective.audit");

const taskOrMonitorIsAuthoritativeDuringIntegration = (state: ObjectiveStateSlice): boolean =>
  state.status === "integrating" && activeIntegrationStatuses.has(state.integration.status);

export const classifyObjectiveLiveJobAuthority = (
  state: ObjectiveStateSlice,
  job: QueueJob,
): FactoryObjectiveLiveJobAuthority => {
  if (!activeJobStatus(job.status)) return "non_authoritative";
  const kind = jobKind(job);
  if (kind === "factory.objective.audit") return "non_authoritative";
  if (state.archivedAt || TERMINAL_OBJECTIVE_STATUSES.has(state.status)) return "cleanup";
  if (kind === "factory.objective.control") return "reconcile";
  if (kind === "factory.integration.publish") {
    return state.status === "promoting" || state.integration.status === "promoting"
      ? "authoritative"
      : "non_authoritative";
  }
  if (kind === "factory.integration.validate") {
    return state.status === "integrating" || activeIntegrationStatuses.has(state.integration.status)
      ? "authoritative"
      : "non_authoritative";
  }
  if (kind === "factory.task.run" || kind === "factory.task.monitor") {
    return taskOrMonitorIsAuthoritativeDuringIntegration(state) ? "authoritative" : "non_authoritative";
  }
  return "non_authoritative";
};

const inferredExecutionPhase = (
  state: ObjectiveStateSlice,
  authoritativeJobs: ReadonlyArray<QueueJob>,
): Extract<FactoryObjectivePhaseDetail, "collecting_evidence" | "evidence_ready" | "synthesizing" | "integrating" | "promoting"> => {
  if (authoritativeJobs.some((job) => jobKind(job) === "factory.integration.publish")) return "promoting";
  if (
    authoritativeJobs.some((job) => jobKind(job) === "factory.integration.validate")
    || state.status === "integrating"
    || state.integration.status === "validating"
    || state.integration.status === "validated"
  ) {
    return "integrating";
  }
  if (state.status === "promoting" || state.integration.status === "promoting") return "promoting";
  const activeTaskPhases = taskEntries(state)
    .filter((task) => state.workflow.activeTaskIds.includes(task.taskId))
    .map((task) => task.executionPhase ?? "collecting_evidence");
  if (activeTaskPhases.includes("synthesizing")) return "synthesizing";
  if (activeTaskPhases.includes("evidence_ready")) return "evidence_ready";
  return "collecting_evidence";
};

const shouldSurfaceStalled = (
  state: ObjectiveStateSlice,
  objectiveJobs: ReadonlyArray<QueueJob>,
  executionStalled: boolean,
): boolean => {
  if (executionStalled) return true;
  if (state.status === "planning" && state.scheduler.slotState === "queued") return false;
  if (state.status === "blocked" || state.archivedAt || TERMINAL_OBJECTIVE_STATUSES.has(state.status)) return false;
  if (objectiveJobs.some((job) =>
    activeJobStatus(job.status) && classifyObjectiveLiveJobAuthority(state, job) === "authoritative")) {
    return false;
  }
  return objectiveJobs.some((job) => shouldReconcileObjectiveFromJobChange(job))
    && !objectiveJobs.some((job) =>
      activeJobStatus(job.status) && jobKind(job) === "factory.objective.control");
};

export const deriveObjectiveOperationalState = (
  input: DeriveObjectiveOperationalStateInput,
): FactoryObjectiveOperationalState => {
  const objectiveJobs = [...(input.objectiveJobs ?? [])].sort(compareObjectiveScopedJobs);
  const liveJobs = nonAuditLiveJobs(objectiveJobs);
  const authoritativeJobs = liveJobs.filter((job) => classifyObjectiveLiveJobAuthority(input.state, job) === "authoritative");
  const reconcileJobs = liveJobs.filter((job) => classifyObjectiveLiveJobAuthority(input.state, job) === "reconcile");
  const cleanupJobs = liveJobs.filter((job) => classifyObjectiveLiveJobAuthority(input.state, job) === "cleanup");
  const hasAuthoritativeLiveJob = authoritativeJobs.length > 0;

  if (input.state.archivedAt) {
    return {
      displayState: "Archived",
      phaseDetail: cleanupJobs.length > 0 ? "cleaning_up" : "archived",
      statusAuthority: cleanupJobs.length > 0 ? "cleanup" : "objective",
      hasAuthoritativeLiveJob,
    };
  }

  if (TERMINAL_OBJECTIVE_STATUSES.has(input.state.status)) {
    return {
      displayState: terminalDisplayStateForStatus(input.state.status),
      phaseDetail: cleanupJobs.length > 0 ? "cleaning_up" : terminalPhaseForStatus(input.state.status),
      statusAuthority: cleanupJobs.length > 0 ? "cleanup" : "objective",
      hasAuthoritativeLiveJob,
    };
  }

  if (input.state.status === "blocked") {
    return {
      displayState: "Blocked",
      phaseDetail: "blocked",
      statusAuthority: "objective",
      hasAuthoritativeLiveJob,
    };
  }

  if (shouldSurfaceStalled(input.state, objectiveJobs, input.executionStalled === true)) {
    return {
      displayState: "Stalled",
      phaseDetail: "stalled",
      statusAuthority: "objective",
      hasAuthoritativeLiveJob,
    };
  }

  if (hasAwaitingReview(input.state)) {
    return {
      displayState: "Awaiting Review",
      phaseDetail: "awaiting_review",
      statusAuthority: "objective",
      hasAuthoritativeLiveJob,
    };
  }

  if (input.state.scheduler.slotState === "queued") {
    return {
      displayState: "Queued",
      phaseDetail: "waiting_for_slot",
      statusAuthority: "objective",
      hasAuthoritativeLiveJob,
    };
  }

  if (input.state.wait?.kind === "control_reconcile") {
    return {
      displayState: "Running",
      phaseDetail: "waiting_for_control",
      statusAuthority: "objective",
      hasAuthoritativeLiveJob,
    };
  }

  if (input.state.wait?.kind === "synthesis_dispatch") {
    return {
      displayState: "Running",
      phaseDetail: "waiting_for_synthesis",
      statusAuthority: "objective",
      hasAuthoritativeLiveJob,
    };
  }

  if (input.state.wait?.kind === "promotion") {
    return {
      displayState: "Running",
      phaseDetail: "waiting_for_promotion",
      statusAuthority: "objective",
      hasAuthoritativeLiveJob,
    };
  }

  if (input.state.status === "planning" && input.taskCount === 0) {
    return {
      displayState: "Draft",
      phaseDetail: "draft",
      statusAuthority: "objective",
      hasAuthoritativeLiveJob,
    };
  }

  if (reconcileJobs.length > 0) {
    return {
      displayState: "Running",
      phaseDetail: "waiting_for_control",
      statusAuthority: "reconcile",
      hasAuthoritativeLiveJob,
    };
  }

  if (input.state.status === "planning") {
    return {
      displayState: input.taskCount === 0 ? "Draft" : "Running",
      phaseDetail: input.taskCount === 0 ? "draft" : "collecting_evidence",
      statusAuthority: "objective",
      hasAuthoritativeLiveJob,
    };
  }

  return {
    displayState: "Running",
    phaseDetail:
      input.state.status === "promoting" ? "promoting"
      : input.state.status === "integrating" ? "integrating"
      : input.state.status === "synthesizing" ? "synthesizing"
      : input.state.status === "evidence_ready" ? "evidence_ready"
      : inferredExecutionPhase(input.state, authoritativeJobs),
    statusAuthority: "objective",
    hasAuthoritativeLiveJob,
  };
};
