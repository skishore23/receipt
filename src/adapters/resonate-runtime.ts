import { Resonate } from "@resonatehq/sdk";

import type { JobBackend } from "./job-backend";
import type { QueueJob } from "./jsonl-queue";
import {
  RESONATE_DRIVER_FUNCTION,
  RESONATE_EXECUTE_FUNCTION,
  resolveDriverInvocationTimeoutMs,
  resolveDriverTarget,
  resolveExecutionLeaseMs,
  resolveExecutionWorkerId,
  resolveProcessRole,
  resolveResonatePid,
  resolveResonateRoleGroup,
  resolveResonateUrl,
  resolveWorkerTarget,
  type ReceiptProcessRole,
} from "./resonate-config";
import type { JobExecutionResult, JobHandler } from "../engine/runtime/job-worker";
import { emitAlignmentEvent, makeAlignmentPayload, type AlignmentReporter } from "../agent/reporting/alignment";

type DriverInvocationPayload = {
  readonly jobId: string;
};

type ResonateRoleWorkerOptions = {
  readonly queue: JobBackend;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly onError?: (error: Error) => void;
  readonly alignmentReporter?: AlignmentReporter;
};

const TERMINAL = new Set<QueueJob["status"]>(["completed", "failed", "canceled"]);

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

const summarizeResult = (job: QueueJob | undefined): Record<string, unknown> => ({
  jobId: job?.id,
  status: job?.status ?? "missing",
  result: job?.result,
  lastError: job?.lastError,
});

export const createResonateClient = (role: ReceiptProcessRole): Resonate =>
  Resonate.remote({
    url: resolveResonateUrl(),
    group: resolveResonateRoleGroup(role),
    pid: resolveResonatePid(role),
  });

type DriverStarterClient = Pick<Resonate, "beginRpc" | "options">;
type DriverDispatchOptions = {
  readonly dispatchKey?: string;
};

export const createResonateDriverStarter = (client: DriverStarterClient) =>
  async (job: QueueJob, opts?: DriverDispatchOptions): Promise<void> => {
    const dispatchKey = typeof opts?.dispatchKey === "string" && opts.dispatchKey.trim().length > 0
      ? opts.dispatchKey.trim()
      : job.id;
    await client.beginRpc(
      dispatchKey,
      RESONATE_DRIVER_FUNCTION,
      { jobId: job.id } satisfies DriverInvocationPayload,
      client.options({
        target: resolveDriverTarget(),
        timeout: resolveDriverInvocationTimeoutMs(job),
        tags: {
          agentId: job.agentId,
          lane: job.lane,
          jobId: job.id,
          kind: String(job.payload.kind ?? "unknown"),
        },
      }),
    );
  };

const executeJob = async (
  queue: JobBackend,
  handlers: Readonly<Record<string, JobHandler>>,
  jobId: string,
  alignmentReporter?: AlignmentReporter,
): Promise<JobExecutionResult> => {
  const job = await queue.getJob(jobId);
  if (!job) {
    return {
      ok: false,
      error: `job ${jobId} not found`,
      noRetry: true,
      result: { status: "failed", message: `job ${jobId} not found` },
    };
  }
  const handler = handlers[job.agentId];
  if (!handler) {
    return {
      ok: false,
      error: `No handler for agent '${job.agentId}'`,
      noRetry: true,
      result: { status: "failed", message: `No handler for agent '${job.agentId}'` },
    };
  }
  const workerId = resolveExecutionWorkerId(job);
  await emitAlignmentEvent({
    ...makeAlignmentPayload({
      jobId: job.id,
      objectiveId: typeof job.payload.objectiveId === "string" ? job.payload.objectiveId : undefined,
      taskId: typeof job.payload.taskId === "string" ? job.payload.taskId : undefined,
      decisionSummary: "job execution started",
      constraintsChecked: [`agent:${job.agentId}`, `lane:${job.lane}`],
      evidenceRefs: ["resonate.execute"],
    }),
    reporter: alignmentReporter,
  });
  try {
    return await handler(job, {
      workerId,
      pullCommands: async (types) => queue.consumeCommands(job.id, types),
      registerLeaseProcess: () => undefined,
      clearLeaseProcess: () => undefined,
    });
  } catch (err) {
    await emitAlignmentEvent({
      ...makeAlignmentPayload({
        jobId: job.id,
        objectiveId: typeof job.payload.objectiveId === "string" ? job.payload.objectiveId : undefined,
        taskId: typeof job.payload.taskId === "string" ? job.payload.taskId : undefined,
        decisionSummary: `job failed with exception: ${err instanceof Error ? err.message : String(err)}`,
        constraintsChecked: [`agent:${job.agentId}`, `lane:${job.lane}`],
        evidenceRefs: ["resonate.exception"],
      }),
      reporter: alignmentReporter,
    });
    throw err;
  }
};

const runDriver = async (
  client: Resonate,
  queue: JobBackend,
  payload: DriverInvocationPayload,
  alignmentReporter?: AlignmentReporter,
): Promise<Record<string, unknown>> => {
  while (true) {
    const current = await queue.getJob(payload.jobId);
    if (!current) return { jobId: payload.jobId, status: "missing" };
    if (TERMINAL.has(current.status)) return summarizeResult(current);

    const workerTarget = resolveWorkerTarget(current);
    const workerId = resolveExecutionWorkerId(current);
    const leaseMs = resolveExecutionLeaseMs(current);

    if (current.abortRequested && current.status !== "canceled") {
      await emitAlignmentEvent({
        ...makeAlignmentPayload({
          jobId: current.id,
          objectiveId: typeof current.payload.objectiveId === "string" ? current.payload.objectiveId : undefined,
          taskId: typeof current.payload.taskId === "string" ? current.payload.taskId : undefined,
          decisionSummary: "job canceled before execution",
          constraintsChecked: [`agent:${current.agentId}`, `lane:${current.lane}`],
          evidenceRefs: ["driver.abort"],
        }),
        reporter: alignmentReporter,
      });
      await queue.cancel(current.id, "abort requested", workerId);
      const canceled = await queue.getJob(current.id);
      return summarizeResult(canceled);
    }

    const leased = current.status === "queued"
      ? await queue.leaseJob(current.id, workerId, leaseMs)
      : current;
    if (!leased) {
      throw new Error(`failed to lease job ${current.id}`);
    }
    if (TERMINAL.has(leased.status)) return summarizeResult(leased);

    await queue.heartbeat(leased.id, workerId, leaseMs);

    const attemptJob = await queue.getJob(leased.id) ?? leased;
    const attemptId = `${attemptJob.id}:attempt:${attemptJob.attempt}`;

    let result: JobExecutionResult;
    try {
      const handle = await client.beginRpc<JobExecutionResult>(
        attemptId,
        RESONATE_EXECUTE_FUNCTION,
        { jobId: attemptJob.id } satisfies DriverInvocationPayload,
        client.options({
          target: workerTarget,
          timeout: leaseMs,
          tags: {
            agentId: attemptJob.agentId,
            lane: attemptJob.lane,
            jobId: attemptJob.id,
            attempt: String(attemptJob.attempt),
          },
        }),
      );
      result = await handle.result();
    } catch (err) {
      result = {
        ok: false,
        error: toError(err).message,
      };
    }

    const latest = await queue.getJob(attemptJob.id);
    if (!latest) return { jobId: attemptJob.id, status: "missing" };
    if (TERMINAL.has(latest.status)) return summarizeResult(latest);

    if (latest.abortRequested) {
      await emitAlignmentEvent({
        ...makeAlignmentPayload({
          jobId: latest.id,
          objectiveId: typeof latest.payload.objectiveId === "string" ? latest.payload.objectiveId : undefined,
          taskId: typeof latest.payload.taskId === "string" ? latest.payload.taskId : undefined,
          decisionSummary: "job canceled after execution",
          constraintsChecked: [`agent:${latest.agentId}`, `lane:${latest.lane}`],
          evidenceRefs: ["driver.abort"],
        }),
        reporter: alignmentReporter,
      });
      await queue.cancel(latest.id, "abort requested", workerId);
    } else if (result.ok) {
      await emitAlignmentEvent({
        ...makeAlignmentPayload({
          jobId: latest.id,
          objectiveId: typeof latest.payload.objectiveId === "string" ? latest.payload.objectiveId : undefined,
          taskId: typeof latest.payload.taskId === "string" ? latest.payload.taskId : undefined,
          decisionSummary: "job completed successfully",
          constraintsChecked: [`agent:${latest.agentId}`, `lane:${latest.lane}`],
          evidenceRefs: ["driver.complete"],
        }),
        reporter: alignmentReporter,
      });
      await queue.complete(latest.id, workerId, result.result);
    } else {
      await emitAlignmentEvent({
        ...makeAlignmentPayload({
          jobId: latest.id,
          objectiveId: typeof latest.payload.objectiveId === "string" ? latest.payload.objectiveId : undefined,
          taskId: typeof latest.payload.taskId === "string" ? latest.payload.taskId : undefined,
          decisionSummary: "job failed",
          constraintsChecked: [`agent:${latest.agentId}`, `lane:${latest.lane}`],
          evidenceRefs: ["driver.fail"],
        }),
        reporter: alignmentReporter,
      });
      await queue.fail(latest.id, workerId, result.error ?? "job failed", result.noRetry, result.result);
    }

    const settled = await queue.getJob(attemptJob.id);
    if (!settled) return { jobId: attemptJob.id, status: "missing" };
    if (settled.status === "queued") continue;
    return summarizeResult(settled);
  }
};

export const createResonateRoleRuntime = (
  roleInput: string | undefined,
  opts: ResonateRoleWorkerOptions,
): {
  readonly role: ReceiptProcessRole;
  readonly client: Resonate;
  readonly start: () => Promise<void>;
  readonly stop: () => void;
} => {
  const role = resolveProcessRole(roleInput);
  const client = createResonateClient(role);
  const reportError = (error: unknown): void => {
    try {
      opts.onError?.(toError(error));
    } catch {
      // Reporting must not crash background roles.
    }
  };

  const start = async (): Promise<void> => {
    if (role === "driver") {
      client.register(RESONATE_DRIVER_FUNCTION, async (_ctx, payload: DriverInvocationPayload) => {
        return runDriver(client, opts.queue, payload, opts.alignmentReporter);
      }, { version: 1 });
      return;
    }

    if (role === "worker-chat" || role === "worker-control" || role === "worker-codex") {
      client.register(RESONATE_EXECUTE_FUNCTION, async (_ctx, payload: DriverInvocationPayload) => {
        try {
          return await executeJob(opts.queue, opts.handlers, payload.jobId, opts.alignmentReporter);
        } catch (err) {
          reportError(err);
          return {
            ok: false,
            error: toError(err).message,
          } satisfies JobExecutionResult;
        }
      }, { version: 1 });
    }
  };

  const stop = (): void => {
    client.stop();
  };

  return {
    role,
    client,
    start,
    stop,
  };
};
