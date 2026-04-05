import { randomUUID } from "node:crypto";

import type { QueueJob } from "./jsonl-queue";

export type ReceiptProcessRole =
  | "all"
  | "api"
  | "driver"
  | "worker-chat"
  | "worker-control"
  | "worker-codex";

export const RESONATE_DRIVER_FUNCTION = "receipt.job.driver";
export const RESONATE_EXECUTE_FUNCTION = "receipt.job.execute";

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const readJobLeaseHint = (job: QueueJob): number | undefined => {
  const hints = [job.payload.leaseTtlMs, job.payload.leaseMs, job.payload.timeoutMs];
  for (const value of hints) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return undefined;
};

export const resolveProcessRole = (value: string | undefined): ReceiptProcessRole => {
  switch (value) {
    case "api":
    case "driver":
    case "worker-chat":
    case "worker-control":
    case "worker-codex":
      return value;
    default:
      return "all";
  }
};

export const resolveResonateUrl = (): string =>
  process.env.RESONATE_URL?.trim() || "http://127.0.0.1:8001";

export const resolveResonateGroups = (): {
  readonly api: string;
  readonly driver: string;
  readonly chat: string;
  readonly control: string;
  readonly codex: string;
} => ({
  api: process.env.RESONATE_GROUP_API?.trim() || "receipt-api",
  driver: process.env.RESONATE_GROUP_DRIVER?.trim() || "receipt-driver",
  chat: process.env.RESONATE_GROUP_CHAT?.trim() || "receipt-chat",
  control: process.env.RESONATE_GROUP_CONTROL?.trim() || "receipt-control",
  codex: process.env.RESONATE_GROUP_CODEX?.trim() || "receipt-codex",
});

export const targetForGroup = (group: string): string =>
  `poll://any@${group}`;

export const resolveResonateRoleGroup = (role: ReceiptProcessRole): string => {
  const groups = resolveResonateGroups();
  switch (role) {
    case "api":
      return groups.api;
    case "driver":
      return groups.driver;
    case "worker-chat":
      return groups.chat;
    case "worker-control":
      return groups.control;
    case "worker-codex":
      return groups.codex;
    default:
      return groups.api;
  }
};

export const resolveResonatePid = (role: ReceiptProcessRole): string =>
  `${role}:${process.env.RECEIPT_PROCESS_INSTANCE ?? "1"}:${process.pid}:${randomUUID().slice(0, 8)}`;

export const resolveDriverTarget = (): string =>
  targetForGroup(resolveResonateGroups().driver);

export const resolveWorkerTarget = (job: QueueJob): string => {
  const groups = resolveResonateGroups();
  if (job.agentId === "codex" || String(job.payload.kind ?? "").startsWith("factory.integration.")) {
    return targetForGroup(groups.codex);
  }
  if (job.agentId === "factory-control") {
    return targetForGroup(groups.control);
  }
  return targetForGroup(groups.chat);
};

export const resolveExecutionWorkerId = (job: QueueJob): string =>
  `resonate:${resolveWorkerTarget(job).replace("poll://any@", "")}`;

export const resolveDriverInvocationTimeoutMs = (job: QueueJob): number =>
  Math.max(resolveExecutionLeaseMs(job) + 60_000, 120_000);

export const resolveExecutionLeaseMs = (job: QueueJob): number => {
  const defaultLeaseMs = parsePositiveInt(process.env.JOB_LEASE_MS, 300_000);
  const defaultCodexLeaseMs = parsePositiveInt(process.env.CODEX_JOB_LEASE_MS, 900_000);
  const defaultWorkerLeaseMs = parsePositiveInt(process.env.JOB_WORKER_LEASE_MS, defaultLeaseMs);
  const p95LeaseMs = parsePositiveInt(process.env[`JOB_P95_LEASE_MS_${job.agentId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`], 0);
  const leaseHint = readJobLeaseHint(job);
  const payloadTimeoutMs = typeof job.payload.timeoutMs === "number" && Number.isFinite(job.payload.timeoutMs)
    ? Math.floor(job.payload.timeoutMs)
    : undefined;
  if (job.agentId === "codex") {
    const buffered = payloadTimeoutMs !== undefined ? payloadTimeoutMs + 300_000 : defaultCodexLeaseMs;
    return Math.max(defaultCodexLeaseMs, p95LeaseMs, leaseHint ?? 0, Math.min(buffered, 3_600_000));
  }
  return Math.max(defaultLeaseMs, defaultWorkerLeaseMs, p95LeaseMs, leaseHint ?? 0);
};
