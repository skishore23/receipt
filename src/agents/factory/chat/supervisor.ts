import { clampWaitMs } from "../../orchestration-utils";
import type { SqliteQueue } from "../../../adapters/sqlite-queue";

export type FactorySupervisorConfig = {
  readonly steerAfterMs?: number;
  readonly abortAfterMs?: number;
};

export const readSupervisorConfig = (value: unknown): FactorySupervisorConfig => {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).supervisor as Record<string, unknown> | undefined
    : undefined;
  if (!record) return {};
  return {
    steerAfterMs: clampWaitMs(record.steerAfterMs),
    abortAfterMs: clampWaitMs(record.abortAfterMs),
  };
};

export const queueSupervisorCommandOnce = async (input: {
  readonly queue: SqliteQueue;
  readonly jobId: string;
  readonly command: "steer" | "follow_up" | "abort";
  readonly payload: Record<string, unknown>;
}): Promise<boolean> => {
  const job = await input.queue.getJob(input.jobId);
  if (!job) return false;
  if (job.commands.some((command) => command.command === input.command)) return false;
  const queued = await input.queue.queueCommand({
    jobId: input.jobId,
    command: input.command,
    payload: input.payload,
    by: "factory.chat",
  });
  return Boolean(queued);
};

export const isSupervisorStallSummary = (value: string): boolean =>
  /no progress yet|still waiting|stalled|waiting|canceled|failed|blocked/i.test(value);
