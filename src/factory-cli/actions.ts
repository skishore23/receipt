import type { QueueJob } from "../adapters/sqlite-queue";
import type { FactoryObjectiveMode, FactoryObjectivePolicy, FactoryObjectiveSeverity } from "../modules/factory";
import { FactoryServiceError, type FactoryObjectiveDetail, type FactoryLiveProjection } from "../services/factory-service";
import type { FactoryCliRuntime } from "./runtime";
import { prepareObjectiveCreation } from "./composer";

export type FactoryObjectiveMutationAction =
  | "create"
  | "compose"
  | "react"
  | "promote"
  | "cancel"
  | "cleanup"
  | "archive";

export type FactoryJobMutationAction = "abort" | "steer" | "follow_up";

export type FactoryObjectiveMutationResult = {
  readonly kind: "objective";
  readonly action: FactoryObjectiveMutationAction;
  readonly objectiveId: string;
  readonly objective: FactoryObjectiveDetail;
  readonly note?: string;
};

export type FactoryJobMutationResult = {
  readonly kind: "job";
  readonly action: FactoryJobMutationAction;
  readonly jobId: string;
  readonly job: QueueJob;
  readonly commandId: string;
};

export type FactoryMutationResult =
  | FactoryObjectiveMutationResult
  | FactoryJobMutationResult;

const activeJobStatus = (status?: string): boolean =>
  status === "queued" || status === "leased" || status === "running";

export const pickActiveObjectiveJob = (
  detail: FactoryObjectiveDetail | undefined,
  live: FactoryLiveProjection | undefined,
): QueueJob | undefined => {
  const fromLive = live?.recentJobs.find((job) => activeJobStatus(job.status));
  if (fromLive) return fromLive;
  const taskJobId = detail?.tasks.find((task) => activeJobStatus(task.jobStatus) && task.jobId)?.jobId;
  if (!taskJobId) return undefined;
  return live?.recentJobs.find((job) => job.id === taskJobId);
};

export const createObjectiveMutation = async (
  runtime: FactoryCliRuntime,
  input: {
    readonly prompt: string;
    readonly title?: string;
    readonly baseHash?: string;
    readonly objectiveMode?: FactoryObjectiveMode;
    readonly severity?: FactoryObjectiveSeverity;
    readonly checks?: ReadonlyArray<string>;
    readonly channel?: string;
    readonly policy?: FactoryObjectivePolicy;
    readonly profileId?: string;
  },
): Promise<FactoryObjectiveMutationResult> => {
  const prepared = prepareObjectiveCreation(input.prompt, {
    title: input.title,
    objectiveMode: input.objectiveMode,
  });
  const objective = await runtime.service.createObjective({
    title: prepared.title,
    prompt: prepared.prompt,
    baseHash: input.baseHash,
    objectiveMode: prepared.objectiveMode,
    severity: input.severity,
    checks: input.checks,
    channel: input.channel,
    policy: input.policy,
    profileId: input.profileId,
  });
  return {
    kind: "objective",
    action: "create",
    objectiveId: objective.objectiveId,
    objective,
  };
};

export const composeObjectiveMutation = async (
  runtime: FactoryCliRuntime,
  input: {
    readonly prompt: string;
    readonly objectiveId?: string;
    readonly title?: string;
    readonly baseHash?: string;
    readonly objectiveMode?: FactoryObjectiveMode;
    readonly severity?: FactoryObjectiveSeverity;
    readonly checks?: ReadonlyArray<string>;
    readonly channel?: string;
    readonly policy?: FactoryObjectivePolicy;
    readonly profileId?: string;
  },
): Promise<FactoryObjectiveMutationResult> => {
  const prepared = input.objectiveId
    ? undefined
    : prepareObjectiveCreation(input.prompt, {
        title: input.title,
        objectiveMode: input.objectiveMode,
      });
  const objective = await runtime.service.composeObjective({
    prompt: prepared?.prompt ?? input.prompt,
    objectiveId: input.objectiveId,
    title: prepared?.title ?? input.title,
    baseHash: input.baseHash,
    objectiveMode: prepared?.objectiveMode ?? input.objectiveMode,
    severity: input.severity,
    checks: input.checks,
    channel: input.channel,
    policy: input.policy,
    profileId: input.profileId,
  });
  return {
    kind: "objective",
    action: "compose",
    objectiveId: objective.objectiveId,
    objective,
    note: input.objectiveId ? input.prompt : undefined,
  };
};

export const reactObjectiveMutation = async (
  runtime: FactoryCliRuntime,
  input: {
    readonly objectiveId: string;
    readonly message?: string;
  },
): Promise<FactoryObjectiveMutationResult> => {
  const objective = await runtime.service.reactObjectiveWithNote(input.objectiveId, input.message);
  return {
    kind: "objective",
    action: "react",
    objectiveId: objective.objectiveId,
    objective,
    note: input.message,
  };
};

export const promoteObjectiveMutation = async (
  runtime: FactoryCliRuntime,
  objectiveId: string,
): Promise<FactoryObjectiveMutationResult> => {
  const objective = await runtime.service.promoteObjective(objectiveId);
  return {
    kind: "objective",
    action: "promote",
    objectiveId,
    objective,
  };
};

export const cancelObjectiveMutation = async (
  runtime: FactoryCliRuntime,
  input: {
    readonly objectiveId: string;
    readonly reason?: string;
  },
): Promise<FactoryObjectiveMutationResult> => {
  const objective = await runtime.service.cancelObjective(input.objectiveId, input.reason);
  return {
    kind: "objective",
    action: "cancel",
    objectiveId: input.objectiveId,
    objective,
  };
};

export const cleanupObjectiveMutation = async (
  runtime: FactoryCliRuntime,
  objectiveId: string,
): Promise<FactoryObjectiveMutationResult> => {
  const objective = await runtime.service.cleanupObjectiveWorkspaces(objectiveId);
  return {
    kind: "objective",
    action: "cleanup",
    objectiveId,
    objective,
  };
};

export const archiveObjectiveMutation = async (
  runtime: FactoryCliRuntime,
  objectiveId: string,
): Promise<FactoryObjectiveMutationResult> => {
  const objective = await runtime.service.archiveObjective(objectiveId);
  return {
    kind: "objective",
    action: "archive",
    objectiveId,
    objective,
  };
};

export const abortJobMutation = async (
  runtime: FactoryCliRuntime,
  input: {
    readonly jobId: string;
    readonly reason?: string;
  },
): Promise<FactoryJobMutationResult> => {
  const queued = await runtime.service.queueJobAbort(input.jobId, input.reason);
  return {
    kind: "job",
    action: "abort",
    jobId: input.jobId,
    job: queued.job,
    commandId: queued.command.id,
  };
};

export const steerJobMutation = async (
  runtime: FactoryCliRuntime,
  input: {
    readonly jobId: string;
    readonly message: string;
  },
): Promise<FactoryJobMutationResult> => {
  const queued = await runtime.service.queueJobSteer(input.jobId, input.message);
  return {
    kind: "job",
    action: "steer",
    jobId: input.jobId,
    job: queued.job,
    commandId: queued.command.id,
  };
};

export const followUpJobMutation = async (
  runtime: FactoryCliRuntime,
  input: {
    readonly jobId: string;
    readonly message: string;
  },
): Promise<FactoryJobMutationResult> => {
  const queued = await runtime.service.queueJobFollowUp(input.jobId, input.message);
  return {
    kind: "job",
    action: "follow_up",
    jobId: input.jobId,
    job: queued.job,
    commandId: queued.command.id,
  };
};

export const requireActiveObjectiveJob = (
  detail: FactoryObjectiveDetail | undefined,
  live: FactoryLiveProjection | undefined,
): QueueJob => {
  const job = pickActiveObjectiveJob(detail, live);
  if (job) return job;
  throw new FactoryServiceError(409, "selected objective has no active job to control");
};
