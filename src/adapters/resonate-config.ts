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
  const payloadTimeoutMs = typeof job.payload.timeoutMs === "number" && Number.isFinite(job.payload.timeoutMs)
    ? Math.floor(job.payload.timeoutMs)
    : undefined;
  const adaptiveLeaseMs = payloadTimeoutMs !== undefined
    ? Math.max(defaultLeaseMs, Math.min(Math.floor(payloadTimeoutMs * 1.5), 3_600_000))
    : defaultLeaseMs;
  if (job.agentId === "codex") {
    const buffered = payloadTimeoutMs !== undefined ? Math.max(adaptiveLeaseMs, payloadTimeoutMs + 300_000) : defaultCodexLeaseMs;
    return Math.max(defaultCodexLeaseMs, Math.min(buffered, 3_600_000));
  }
  return adaptiveLeaseMs;
};
