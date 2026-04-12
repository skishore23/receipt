import path from "node:path";
import fs from "node:fs/promises";

import {
  createLocalDurableBackend,
  createResonateDurableBackend,
  type ActivitySnapshot,
  type DurableBackend,
  type SignalEnvelope,
  type WorkflowSnapshot,
} from "@receipt/durable";

import type { JobBackend } from "../adapters/job-backend";
import type {
  EnqueueJobInput,
  QueueCommandInput,
  QueueCommandRecord,
  QueueJob,
} from "../adapters/sqlite-queue";
import { resolveReceiptDbPath } from "../db/client";

const DURABLE_QUEUE_COMMANDS = new Set(["steer", "follow_up", "abort"]);
const ACTIVE_JOB_STATUSES = new Set(["queued", "leased", "running"]);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export const objectiveControlWorkflowKey = (objectiveId: string): string =>
  `factory/objective/${objectiveId}/control`;

export const runWorkflowKey = (stream: string, runId: string): string =>
  `factory/run/${encodeURIComponent(stream)}/${runId}`;

export const codexControlWorkflowKey = (jobId: string): string =>
  `factory/codex/${jobId}/control`;

export const codexActivityKey = (jobId: string): string =>
  `factory/codex/${jobId}`;

export const createAppDurableBackend = (input: {
  readonly dataDir: string;
  readonly mode: "local" | "resonate";
  readonly workflowDispatch?: {
    readonly client?: Parameters<typeof createResonateDurableBackend>[0]["client"];
    readonly target?: string;
  };
}): DurableBackend => {
  const local = createLocalDurableBackend({
    dbPath: resolveReceiptDbPath(input.dataDir),
  });
  if (input.mode !== "resonate") return local;
  return createResonateDurableBackend({
    local,
    client: input.workflowDispatch?.client,
    workflowTarget: input.workflowDispatch?.target,
  });
};

const workflowKeyForPayload = (
  payload: Readonly<Record<string, unknown>>,
  jobId?: string,
): string | undefined => {
  const kind = asString(payload.kind);
  if (kind === "factory.objective.control") {
    const objectiveId = asString(payload.objectiveId);
    return objectiveId ? objectiveControlWorkflowKey(objectiveId) : undefined;
  }
  if (kind === "agent.run" || kind === "factory.run") {
    const stream = asString(payload.stream);
    const runId = asString(payload.runId);
    return stream && runId ? runWorkflowKey(stream, runId) : undefined;
  }
  if (
    jobId &&
    (kind === "factory.task.run" || kind === "factory.codex.run" || kind === "codex.run")
  ) {
    return codexControlWorkflowKey(jobId);
  }
  return undefined;
};

export const workflowKeyForJob = (job: Pick<QueueJob, "id" | "payload">): string | undefined =>
  workflowKeyForPayload(job.payload, job.id);

export const workflowKeyForEnqueueInput = (
  input: EnqueueJobInput,
  createdJobId?: string,
): string | undefined => workflowKeyForPayload(input.payload, createdJobId ?? input.jobId);

export const activityKeyForJob = (job: Pick<QueueJob, "id" | "payload">): string | undefined => {
  const kind = asString(job.payload.kind);
  if (
    kind === "factory.task.run" ||
    kind === "factory.codex.run" ||
    kind === "codex.run"
  ) {
    return codexActivityKey(job.id);
  }
  return undefined;
};

const commandLane = (
  signal: string,
): QueueCommandRecord["lane"] => (signal === "follow_up" ? "follow_up" : "steer");

const signalToQueueCommand = (signal: SignalEnvelope): QueueCommandRecord => ({
  id: signal.id,
  command: signal.signal === "abort" ? "abort" : signal.signal === "follow_up" ? "follow_up" : "steer",
  lane: commandLane(signal.signal),
  payload: signal.payload,
  by: signal.by,
  createdAt: signal.createdAt,
  consumedAt: signal.consumedAt,
});

const overlayWorkflowSignals = async (
  durable: DurableBackend,
  job: QueueJob | undefined,
): Promise<QueueJob | undefined> => {
  if (!job) return undefined;
  const workflowKey = workflowKeyForJob(job);
  if (!workflowKey) return job;
  const signals = await durable.listWorkflowSignals(workflowKey);
  return {
    ...job,
    payload: { ...job.payload },
    result: job.result ? { ...job.result } : undefined,
    commands: signals.map(signalToQueueCommand),
  };
};

const durableWorkflowInputForJob = (
  job: QueueJob,
): Record<string, unknown> => ({
  jobId: job.id,
  agentId: job.agentId,
  lane: job.lane,
  sessionKey: job.sessionKey,
  kind: job.payload.kind,
  payload: { ...job.payload },
});

export const startDurableWorkflowForJob = async (
  durable: DurableBackend,
  job: QueueJob,
): Promise<WorkflowSnapshot | undefined> => {
  const key = workflowKeyForJob(job);
  if (!key) return undefined;
  return durable.startOrResumeWorkflow({
    key,
    input: durableWorkflowInputForJob(job),
    metadata: {
      jobId: job.id,
      kind: job.payload.kind,
    },
  });
};

export const markDurableJobRunning = async (
  durable: DurableBackend,
  job: QueueJob,
): Promise<WorkflowSnapshot | undefined> => {
  const key = workflowKeyForJob(job);
  if (!key) return undefined;
  await startDurableWorkflowForJob(durable, job);
  return durable.setWorkflowStatus({
    key,
    status: "running",
    metadata: {
      jobId: job.id,
      kind: job.payload.kind,
    },
  });
};

export const createDurableQueueBackend = (
  base: JobBackend,
  durable: DurableBackend,
): JobBackend => {
  const queueCommand = async (
    input: QueueCommandInput,
  ): Promise<QueueCommandRecord | undefined> => {
    const existing = await base.getJob(input.jobId);
    if (!existing) return undefined;
    const workflowKey = workflowKeyForJob(existing);
    if (!workflowKey || !DURABLE_QUEUE_COMMANDS.has(input.command)) {
      return base.queueCommand(input);
    }
    if (input.command === "abort") {
      const signal = await durable.signalWorkflow({
        key: workflowKey,
        signal: "abort",
        payload: asRecord(input.payload),
        by: input.by,
      });
      return signalToQueueCommand(signal);
    }
    const signal = await durable.signalWorkflow({
      key: workflowKey,
      signal: input.command,
      payload: asRecord(input.payload),
      by: input.by,
    });
    return signalToQueueCommand(signal);
  };

  return {
    enqueue: async (input) => {
      const created = await base.enqueue(input);
      await startDurableWorkflowForJob(durable, created);
      return created;
    },
    leaseNext: (opts) => base.leaseNext(opts),
    leaseJob: (jobId, workerId, leaseMs) => base.leaseJob(jobId, workerId, leaseMs),
    heartbeat: async (jobId, workerId, leaseMs) => {
      const beat = await base.heartbeat(jobId, workerId, leaseMs);
      const activityKey = beat ? activityKeyForJob(beat) : undefined;
      if (activityKey) {
        await durable.heartbeatActivity({
          key: activityKey,
          metadata: {
            jobId,
            workerId,
            leaseMs,
          },
        }).catch(() => undefined);
      }
      return beat;
    },
    progress: async (jobId, workerId, result) => {
      const progressed = await base.progress(jobId, workerId, result);
      const activityKey = progressed ? activityKeyForJob(progressed) : undefined;
      if (activityKey) {
        await durable.heartbeatActivity({
          key: activityKey,
          metadata: {
            jobId,
            workerId,
            result: asRecord(result) ?? undefined,
          },
        }).catch(() => undefined);
      }
      return progressed;
    },
    complete: async (jobId, workerId, result) => {
      const completed = await base.complete(jobId, workerId, result);
      const workflowKey = completed ? workflowKeyForJob(completed) : undefined;
      if (workflowKey) {
        await durable.setWorkflowStatus({
          key: workflowKey,
          status: "completed",
          output: asRecord(result),
        });
      }
      return completed;
    },
    fail: async (jobId, workerId, error, noRetry, result) => {
      const failed = await base.fail(jobId, workerId, error, noRetry, result);
      const workflowKey = failed ? workflowKeyForJob(failed) : undefined;
      if (workflowKey) {
        await durable.setWorkflowStatus({
          key: workflowKey,
          status: "failed",
          output: asRecord(result),
          error,
        });
      }
      return failed;
    },
    cancel: async (jobId, reason, by) => {
      const canceled = await base.cancel(jobId, reason, by);
      const workflowKey = canceled ? workflowKeyForJob(canceled) : undefined;
      if (workflowKey) {
        await durable.cancelWorkflow(workflowKey, reason);
      }
      return canceled;
    },
    queueCommand,
    consumeCommands: async (jobId, filter) => {
      const existing = await base.getJob(jobId);
      const workflowKey = existing ? workflowKeyForJob(existing) : undefined;
      if (!workflowKey) return base.consumeCommands(jobId, filter);
      const signals = await durable.consumeWorkflowSignals({
        key: workflowKey,
        signals: filter,
      });
      return signals.map(signalToQueueCommand);
    },
    getJob: async (jobId) => overlayWorkflowSignals(durable, await base.getJob(jobId)),
    listJobs: async (opts) => {
      const jobs = await base.listJobs(opts);
      return Promise.all(jobs.map((job) => overlayWorkflowSignals(durable, job) as Promise<QueueJob>));
    },
    waitForJob: async (jobId, timeoutMs, pollMs) =>
      overlayWorkflowSignals(durable, await base.waitForJob(jobId, timeoutMs, pollMs)),
    waitForWork: (opts) => base.waitForWork(opts),
    notifyWorkAvailable: () => base.notifyWorkAvailable(),
    snapshot: () => base.snapshot(),
    refresh: () => base.refresh(),
  };
};

export const recoverPersistedJsonResult = async (
  resultPath: string | undefined,
): Promise<Record<string, unknown> | undefined> => {
  const resolved = asString(resultPath);
  if (!resolved) return undefined;
  try {
    const raw = await fs.readFile(path.resolve(resolved), "utf-8");
    const parsed = JSON.parse(raw);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
};

export const listPendingObjectiveControlWorkflowIds = async (
  durable: DurableBackend,
): Promise<ReadonlyArray<{
  readonly objectiveId: string;
  readonly workflow: WorkflowSnapshot;
}>> => {
  const workflows = await durable.listWorkflows({
    prefix: "factory/objective/",
    statuses: ["pending", "running"],
  });
  return workflows.flatMap((workflow) => {
    const match = workflow.key.match(/^factory\/objective\/([^/]+)\/control$/);
    if (!match?.[1]) return [];
    return [{
      objectiveId: decodeURIComponent(match[1]),
      workflow,
    }];
  });
};

export const hasActiveJobForWorkflow = async (
  queue: Pick<JobBackend, "listJobs">,
  workflowKey: string,
): Promise<boolean> => {
  const jobs = await queue.listJobs({ limit: 2000 });
  return jobs.some((job) => {
    if (!ACTIVE_JOB_STATUSES.has(job.status)) return false;
    return workflowKeyForJob(job) === workflowKey;
  });
};

export const latestActivitySnapshot = async (
  durable: DurableBackend,
  jobId: string,
): Promise<ActivitySnapshot | undefined> => durable.getActivity(codexActivityKey(jobId));
