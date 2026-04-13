import type { QueueJob, SqliteQueue } from "../adapters/sqlite-queue";
import { JobWorker, type JobHandler } from "../engine/runtime/job-worker";
import {
  shouldQueueObjectiveControlReconcile,
  shouldReconcileObjectiveFromJobChange,
} from "./factory-job-gates";
import {
  FACTORY_CONTROL_AGENT_ID,
  type FactoryService,
} from "./factory-service";

export const parseFactoryRuntimeBooleanEnv = (
  value: string | undefined,
  fallback: boolean,
): boolean => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

export const parseFactoryRuntimeListEnv = (
  value: string | undefined,
  fallback: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const normalized = value?.trim();
  const values = (normalized ? normalized.split(",") : [...fallback])
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(values)];
};

export const scheduleFactoryObjectiveReconcileOnJobChange = async (input: {
  readonly job: QueueJob;
  readonly queue: SqliteQueue;
  readonly service: Pick<FactoryService, "getObjective" | "scheduleObjectiveControl">;
  readonly controlAgentId?: string;
}): Promise<boolean> => {
  const objectiveId =
    typeof input.job.payload.objectiveId === "string"
      && input.job.payload.objectiveId.trim().length > 0
      ? input.job.payload.objectiveId.trim()
      : undefined;
  if (!objectiveId || !shouldReconcileObjectiveFromJobChange(input.job)) {
    return false;
  }
  const [recentJobs, detail] = await Promise.all([
    input.queue.listJobs({ limit: 200 }),
    input.service.getObjective(objectiveId).catch(() => undefined),
  ]);
  const shouldQueue = shouldQueueObjectiveControlReconcile({
    controlAgentId: input.controlAgentId ?? FACTORY_CONTROL_AGENT_ID,
    objectiveId,
    recentJobs,
    sourceUpdatedAt: input.job.updatedAt,
    objectiveInactive:
      detail != null
      && ["blocked", "canceled", "completed", "failed"].includes(detail.status),
  });
  if (!shouldQueue) return false;
  await input.service.scheduleObjectiveControl(objectiveId, "reconcile");
  return true;
};

export const createFactoryLocalWorker = (input: {
  readonly queue: SqliteQueue;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly workerId: string;
  readonly idleResyncMs: number;
  readonly leaseMs: number;
  readonly concurrency: number;
  readonly leaseAgentIds?: ReadonlyArray<string>;
  readonly scope: string;
  readonly onTick?: () => void;
  readonly onError?: (error: Error) => void;
}): JobWorker =>
  new JobWorker({
    queue: input.queue,
    handlers: input.handlers,
    workerId: input.workerId,
    leaseAgentIds: input.leaseAgentIds ?? Object.keys(input.handlers),
    idleResyncMs: input.idleResyncMs,
    leaseMs: input.leaseMs,
    concurrency: input.concurrency,
    onTick: input.onTick,
    onError: input.onError,
    onLeaseRenewal: (event) => {
      console.error(
        JSON.stringify({
          type: "job.lease_renewed",
          scope: input.scope,
          ...event,
        }),
      );
    },
  });

export const startFactoryLocalRuntime = async (input: {
  readonly worker: JobWorker;
  readonly service: Pick<FactoryService, "resumeObjectives">;
  readonly onResumeSuccess?: () => void | Promise<void>;
  readonly onResumeError?: (error: Error) => void | Promise<void>;
}): Promise<void> => {
  input.worker.start();
  try {
    await input.service.resumeObjectives();
    await input.onResumeSuccess?.();
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    await input.onResumeError?.(normalized);
    throw normalized;
  }
};
