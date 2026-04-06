import type { ReceiptProcessRole } from "../adapters/resonate-config";
import { resolveProcessRole } from "../adapters/resonate-config";
import {
  resolveFactoryRuntimeConfig,
  type FactoryRuntimeConfig,
} from "../factory-cli/config";
import {
  deriveServerRuntimeFlags,
  type ServerJobBackend,
} from "./http-topology";

export type ReceiptServerConfig = {
  readonly port: number;
  readonly factoryRuntime: FactoryRuntimeConfig;
  readonly workspaceRoot: string;
  readonly dataDir: string;
  readonly jobBackend: ServerJobBackend;
  readonly startupSettleMs: number;
  readonly processRole: ReceiptProcessRole;
  readonly shouldServeHttp: boolean;
  readonly shouldRunHeartbeats: boolean;
  readonly agentModel: string;
  readonly factoryChatModel: string;
  readonly jobStream: string;
  readonly jobWorkerId: string;
  readonly chatJobConcurrency: number;
  readonly orchestrationJobConcurrency: number;
  readonly codexJobConcurrency: number;
  readonly jobIdleResyncMs: number;
  readonly jobLeaseMs: number;
  readonly codexJobLeaseMs: number;
  readonly subJobWaitMs: number;
  readonly subJobPollMs: number;
  readonly subJobJoinWaitMs: number;
  readonly factoryAutoFixEnabled: boolean;
  readonly factoryAutoFixSourceChannels: ReadonlyArray<string>;
  readonly localRuntimeStaleJobMs: number;
  readonly localRuntimeWorkerStaleMs: number;
  readonly localRuntimeWatchdogMs: number;
};

const parseWorkerConcurrency = (
  value: string | undefined,
  fallback: number,
): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
};

const clampIntegerEnv = (
  value: string | undefined,
  fallback: number,
  bounds?: { readonly min?: number; readonly max?: number },
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  const lowerBound = bounds?.min ?? Number.NEGATIVE_INFINITY;
  const upperBound = bounds?.max ?? Number.POSITIVE_INFINITY;
  return Math.max(lowerBound, Math.min(floored, upperBound));
};

const parseBooleanEnv = (
  value: string | undefined,
  fallback: boolean,
): boolean => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const parseListEnv = (
  value: string | undefined,
  fallback: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const normalized = value?.trim();
  const values = (normalized ? normalized.split(",") : [...fallback])
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(values)];
};

export const resolveServerConfig = async (
  cwd: string,
): Promise<ReceiptServerConfig> => {
  const factoryRuntime = await resolveFactoryRuntimeConfig(cwd);
  const jobBackend: ServerJobBackend =
    process.env.JOB_BACKEND === "resonate" ? "resonate" : "local";
  const startupSettleDefault = jobBackend === "resonate" ? 1_000 : 0;
  const startupSettleMs = clampIntegerEnv(
    process.env.RESONATE_STARTUP_SETTLE_MS,
    startupSettleDefault,
    { min: 0 },
  );
  const requestedProcessRole = process.env.RECEIPT_PROCESS_ROLE?.trim();
  const processRole =
    jobBackend === "resonate" && !requestedProcessRole
      ? "api"
      : resolveProcessRole(requestedProcessRole);
  const runtimeFlags = deriveServerRuntimeFlags(jobBackend, processRole);
  const localRuntimeStaleJobMs = clampIntegerEnv(
    process.env.RECEIPT_LOCAL_RUNTIME_STALE_JOB_MS,
    90_000,
    { min: 5_000 },
  );
  const localRuntimeWorkerStaleMs = clampIntegerEnv(
    process.env.RECEIPT_LOCAL_RUNTIME_WORKER_STALE_MS,
    Math.max(20_000, Math.floor(localRuntimeStaleJobMs / 2)),
    { min: 5_000 },
  );
  return {
    port: Number(process.env.PORT ?? 8787),
    factoryRuntime,
    workspaceRoot: factoryRuntime.repoRoot,
    dataDir: factoryRuntime.dataDir,
    jobBackend,
    startupSettleMs,
    processRole,
    shouldServeHttp: runtimeFlags.shouldServeHttp,
    shouldRunHeartbeats: runtimeFlags.shouldRunHeartbeats,
    agentModel: process.env.OPENAI_MODEL ?? "gpt-5.2",
    factoryChatModel:
      process.env.RECEIPT_FACTORY_CHAT_MODEL?.trim() ||
      process.env.OPENAI_MODEL ||
      "gpt-5.4-mini",
    jobStream: "jobs",
    jobWorkerId: process.env.JOB_WORKER_ID ?? `worker_${process.pid}`,
    chatJobConcurrency: parseWorkerConcurrency(
      process.env.CHAT_JOB_CONCURRENCY,
      50,
    ),
    orchestrationJobConcurrency: parseWorkerConcurrency(
      process.env.ORCHESTRATION_JOB_CONCURRENCY,
      20,
    ),
    codexJobConcurrency: parseWorkerConcurrency(
      process.env.CODEX_JOB_CONCURRENCY,
      30,
    ),
    jobIdleResyncMs: clampIntegerEnv(process.env.JOB_IDLE_RESYNC_MS, 5_000, {
      min: 1_000,
    }),
    jobLeaseMs: clampIntegerEnv(process.env.JOB_LEASE_MS, 300_000, {
      min: 1_000,
    }),
    codexJobLeaseMs: clampIntegerEnv(process.env.CODEX_JOB_LEASE_MS, 900_000, {
      min: 1_000,
    }),
    subJobWaitMs: clampIntegerEnv(process.env.SUBJOB_WAIT_MS, 1_500, {
      min: 0,
      max: 30_000,
    }),
    subJobPollMs: clampIntegerEnv(process.env.SUBJOB_WAIT_POLL_MS, 250, {
      min: 20,
      max: 2_000,
    }),
    subJobJoinWaitMs: clampIntegerEnv(
      process.env.SUBJOB_JOIN_WAIT_MS,
      180_000,
      { min: 0, max: 600_000 },
    ),
    factoryAutoFixEnabled: parseBooleanEnv(
      process.env.RECEIPT_FACTORY_AUTO_FIX_ENABLED,
      true,
    ),
    factoryAutoFixSourceChannels: parseListEnv(
      process.env.RECEIPT_FACTORY_AUTO_FIX_SOURCE_CHANNELS,
      ["trial"],
    ),
    localRuntimeStaleJobMs,
    localRuntimeWorkerStaleMs,
    localRuntimeWatchdogMs: clampIntegerEnv(
      process.env.RECEIPT_LOCAL_RUNTIME_WATCHDOG_MS,
      15_000,
      { min: 1_000, max: 300_000 },
    ),
  };
};
