import type { QueueJob } from "../../adapters/sqlite-queue";

type QueueJobSummaryOptions = {
  readonly preferNoteBeforeMessage?: boolean;
  readonly preferTerminalSummary?: boolean;
  readonly clipTaskAt?: number;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asStringList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];

const clip = (value: string, max = 220): string =>
  value.length <= max ? value : `${value.slice(0, max - 3)}...`;

const queueJobTaskLabel = (job: QueueJob, max = 220): string => {
  const task = asString(job.payload.task)
    ?? asString(job.payload.prompt)
    ?? asString(job.payload.problem)
    ?? asString(job.payload.kind)
    ?? `${job.agentId} job`;
  return clip(task, max);
};

const queueJobResultSummary = (
  result: Record<string, unknown> | undefined,
  failure: Record<string, unknown> | undefined,
  preferNoteBeforeMessage: boolean,
): string | undefined => {
  const message = asString(result?.message);
  const note = asString(result?.note);
  const orderedTail = preferNoteBeforeMessage ? [note, message] : [message, note];
  return asString(result?.summary)
    ?? asString(result?.finalResponse)
    ?? orderedTail[0]
    ?? orderedTail[1]
    ?? asString(failure?.message);
};

export const summarizeFactoryQueueJob = (
  job: QueueJob,
  options: QueueJobSummaryOptions = {},
): string => {
  const result = asRecord(job.result);
  const failure = asRecord(result?.failure);
  const terminalSummary = options.preferTerminalSummary === false
    ? undefined
    : job.status === "failed"
      ? job.lastError ?? asString(failure?.message)
      : job.status === "canceled"
        ? job.canceledReason ?? asString(result?.note)
        : undefined;
  return terminalSummary
    ?? queueJobResultSummary(result, failure, options.preferNoteBeforeMessage === true)
    ?? job.lastError
    ?? asString((job.payload as Record<string, unknown>).problem)
    ?? asString((job.payload as Record<string, unknown>).task)
    ?? asString((job.payload as Record<string, unknown>).kind)
    ?? queueJobTaskLabel(job, options.clipTaskAt);
};

export const buildFactoryQueueJobSnapshot = (job: QueueJob): Record<string, unknown> => {
  const result = asRecord(job.result);
  return {
    jobId: job.id,
    status: job.status,
    worker: asString(result?.worker) ?? job.agentId,
    agentId: job.agentId,
    summary: summarizeFactoryQueueJob(job, {
      preferNoteBeforeMessage: true,
      preferTerminalSummary: true,
      clipTaskAt: 220,
    }),
    task: queueJobTaskLabel(job, 220),
    runId: asString(result?.runId) ?? asString(job.payload.runId),
    stream: asString(result?.stream) ?? asString(job.payload.stream),
    parentRunId: asString(job.payload.parentRunId),
    parentStream: asString(job.payload.parentStream),
    lastMessage: asString(result?.lastMessage),
    stdoutTail: asString(result?.stdoutTail),
    stderrTail: asString(result?.stderrTail),
    progressAt: typeof result?.progressAt === "number" ? result.progressAt : undefined,
    latestEventType: asString(result?.latestEventType),
    latestEventText: asString(result?.latestEventText),
    changedFiles: asStringList(result?.changedFiles),
    note: asString(result?.note),
  };
};
