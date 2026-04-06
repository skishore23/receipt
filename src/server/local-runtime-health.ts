import type { QueueJob } from "../adapters/sqlite-queue";
import {
  LIVE_JOB_STALE_AFTER_MS,
  isFactoryExecutionQueueJob,
  liveExecutionSnapshotForJobs,
} from "../services/factory/live-jobs";

export type LocalRuntimeWorkerRole = "chat" | "orchestration" | "codex";

export type LocalRuntimeWorkerState = {
  readonly role: LocalRuntimeWorkerRole;
  readonly workerId: string;
  readonly concurrency: number;
  readonly startedAt?: number;
  readonly lastTickAt?: number;
  readonly lastErrorAt?: number;
  readonly lastError?: string;
};

type LocalRuntimeCheck = {
  readonly ok: boolean;
  readonly summary: string;
  readonly detail?: string;
};

export type LocalRuntimeHealthSnapshot = {
  readonly ready: boolean;
  readonly degraded: boolean;
  readonly checks: {
    readonly http: LocalRuntimeCheck;
    readonly workers: LocalRuntimeCheck;
    readonly queueWatchdog: LocalRuntimeCheck;
    readonly resume: LocalRuntimeCheck;
  };
  readonly workers: {
    readonly expectedRoles: ReadonlyArray<LocalRuntimeWorkerRole>;
    readonly readyRoles: ReadonlyArray<LocalRuntimeWorkerRole>;
    readonly byRole: Readonly<Record<LocalRuntimeWorkerRole, {
      readonly workerId: string;
      readonly concurrency: number;
      readonly startedAt?: number;
      readonly lastTickAt?: number;
      readonly lastErrorAt?: number;
      readonly lastError?: string;
      readonly ready: boolean;
    }>>;
  };
  readonly stalledObjectives: number;
  readonly oldestQueuedMsByLane: Readonly<Record<"chat" | "collect" | "steer" | "follow_up", number | null>>;
  readonly lastResumeAt?: number;
  readonly lastResumeError?: string;
  readonly lastResumeErrorAt?: number;
  readonly watchdog: {
    readonly degraded: boolean;
    readonly warnings: ReadonlyArray<string>;
    readonly evaluatedAt: number;
  };
};

const laneAgeSeed = (): Record<"chat" | "collect" | "steer" | "follow_up", number | null> => ({
  chat: null,
  collect: null,
  steer: null,
  follow_up: null,
});

const localRuntimeWorkerRoleForJob = (job: Pick<QueueJob, "agentId" | "payload">): LocalRuntimeWorkerRole | undefined => {
  if (job.agentId === "codex") return "codex";
  if (job.agentId === "factory-control") return "orchestration";
  const kind = typeof job.payload.kind === "string" ? job.payload.kind : undefined;
  if (kind === "factory.run" || kind === "agent.run") return "chat";
  return undefined;
};

const workerFreshAt = (
  worker: LocalRuntimeWorkerState,
): number | undefined => worker.lastTickAt ?? worker.startedAt;

const workerReady = (
  worker: LocalRuntimeWorkerState,
  now: number,
  workerStaleAfterMs: number,
): boolean => {
  const freshAt = workerFreshAt(worker);
  if (typeof freshAt !== "number") return false;
  if (typeof worker.lastErrorAt === "number" && worker.lastErrorAt >= freshAt) return false;
  return now - freshAt < workerStaleAfterMs;
};

export const summarizeLocalRuntimeHealth = (input: {
  readonly jobs: ReadonlyArray<QueueJob>;
  readonly workers: ReadonlyArray<LocalRuntimeWorkerState>;
  readonly lastResumeAt?: number;
  readonly lastResumeError?: string;
  readonly lastResumeErrorAt?: number;
  readonly now?: number;
  readonly staleAfterMs?: number;
  readonly workerStaleAfterMs?: number;
}): LocalRuntimeHealthSnapshot => {
  const now = input.now ?? Date.now();
  const staleAfterMs = Math.max(1_000, input.staleAfterMs ?? LIVE_JOB_STALE_AFTER_MS);
  const workerStaleAfterMs = Math.max(1_000, input.workerStaleAfterMs ?? Math.max(20_000, Math.floor(staleAfterMs / 2)));
  const oldestQueuedMsByLane = laneAgeSeed();
  for (const job of input.jobs) {
    if (job.status !== "queued") continue;
    const ageMs = Math.max(0, now - (job.updatedAt ?? job.createdAt));
    oldestQueuedMsByLane[job.lane] = oldestQueuedMsByLane[job.lane] == null
      ? ageMs
      : Math.max(oldestQueuedMsByLane[job.lane]!, ageMs);
  }

  const expectedRoles: ReadonlyArray<LocalRuntimeWorkerRole> = ["chat", "orchestration", "codex"];
  const workerByRole = Object.fromEntries(
    expectedRoles.map((role) => {
      const worker = input.workers.find((entry) => entry.role === role) ?? {
        role,
        workerId: role,
        concurrency: 0,
      };
      const ready = workerReady(worker, now, workerStaleAfterMs);
      return [role, {
        workerId: worker.workerId,
        concurrency: worker.concurrency,
        startedAt: worker.startedAt,
        lastTickAt: worker.lastTickAt,
        lastErrorAt: worker.lastErrorAt,
        lastError: worker.lastError,
        ready,
      }];
    }),
  ) as Record<LocalRuntimeWorkerRole, {
    readonly workerId: string;
    readonly concurrency: number;
    readonly startedAt?: number;
    readonly lastTickAt?: number;
    readonly lastErrorAt?: number;
    readonly lastError?: string;
    readonly ready: boolean;
  }>;
  const readyRoles = expectedRoles.filter((role) => workerByRole[role].ready);

  const stalledObjectives = liveExecutionSnapshotForJobs(
    input.jobs.filter((job) => isFactoryExecutionQueueJob(job)),
    now,
    staleAfterMs,
  ).stalledObjectiveIds.size;

  const staleQueuedJobs = input.jobs
    .filter((job) => job.status === "queued")
    .filter((job) => {
      const role = localRuntimeWorkerRoleForJob(job);
      if (!role) return false;
      const ageMs = Math.max(0, now - (job.updatedAt ?? job.createdAt));
      return ageMs >= staleAfterMs && !workerByRole[role].ready;
    });

  const watchdogWarnings = staleQueuedJobs.map((job) => {
    const role = localRuntimeWorkerRoleForJob(job) ?? "unknown";
    const kind = typeof job.payload.kind === "string" ? job.payload.kind : "job";
    const ageSec = Math.floor(Math.max(0, now - (job.updatedAt ?? job.createdAt)) / 1_000);
    return `${job.id}: ${kind} has been queued for ${ageSec}s without a healthy ${role} worker`;
  });

  const workersOk = readyRoles.length === expectedRoles.length;
  const resumeOk = typeof input.lastResumeAt === "number"
    && (
      typeof input.lastResumeErrorAt !== "number"
      || input.lastResumeAt >= input.lastResumeErrorAt
    );
  const watchdogOk = watchdogWarnings.length === 0;

  return {
    ready: workersOk && resumeOk && watchdogOk,
    degraded: !watchdogOk,
    checks: {
      http: {
        ok: true,
        summary: "HTTP server responded to the health probe.",
      },
      workers: workersOk
        ? {
            ok: true,
            summary: `All local worker roles are healthy (${readyRoles.join(", ")}).`,
          }
        : {
            ok: false,
            summary: "One or more local worker roles have not started cleanly.",
            detail: expectedRoles
              .filter((role) => !workerByRole[role].ready)
              .map((role) => role)
              .join(", "),
          },
      queueWatchdog: watchdogOk
        ? {
            ok: true,
            summary: "No stale queued codex/control jobs were detected without a healthy worker.",
          }
        : {
            ok: false,
            summary: "Stale queued work was detected without a healthy eligible worker.",
            detail: watchdogWarnings.join(" | "),
          },
      resume: resumeOk
        ? {
            ok: true,
            summary: "Startup objective reconciliation completed successfully.",
          }
        : {
            ok: false,
            summary: "Startup objective reconciliation has not completed successfully yet.",
            detail: input.lastResumeError,
          },
    },
    workers: {
      expectedRoles,
      readyRoles,
      byRole: workerByRole,
    },
    stalledObjectives,
    oldestQueuedMsByLane,
    lastResumeAt: input.lastResumeAt,
    lastResumeError: input.lastResumeError,
    lastResumeErrorAt: input.lastResumeErrorAt,
    watchdog: {
      degraded: !watchdogOk,
      warnings: watchdogWarnings,
      evaluatedAt: now,
    },
  };
};
