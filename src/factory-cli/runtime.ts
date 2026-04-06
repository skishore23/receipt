import fs from "node:fs";
import path from "node:path";

import { sqliteBranchStore, sqliteReceiptStore } from "../adapters/sqlite";
import { sqliteQueue } from "../adapters/sqlite-queue";
import { createRuntime } from "@receipt/core/runtime";
import { JobWorker } from "../engine/runtime/job-worker";
import { SseHub } from "../framework/sse-hub";
import {
  decide as decideJob,
  initial as initialJob,
  reduce as reduceJob,
  type JobCmd,
  type JobEvent,
  type JobState,
} from "../modules/job";
import {
  shouldQueueObjectiveControlReconcile,
  shouldReconcileObjectiveFromJobChange,
} from "../services/factory-job-gates";
import {
  createFactoryServiceRuntime,
  createFactoryWorkerHandlers,
} from "../services/factory-runtime";
import { FACTORY_CONTROL_AGENT_ID } from "../services/factory-service";
import type {
  FactoryService,
  FactoryTaskView,
} from "../services/factory-service";
import type { FactoryCliConfig } from "./config";
import {
  getReceiptDb,
  listChangesAfter,
  pollLatestChangeSeq,
} from "../db/client";

export type FactoryCliRuntime = {
  readonly config: FactoryCliConfig;
  readonly queue: ReturnType<typeof sqliteQueue>;
  readonly service: FactoryService;
  readonly worker: JobWorker;
  readonly subscribe: (listener: FactoryCliRuntimeListener) => () => void;
  readonly focusObjective: (objectiveId?: string) => Promise<void>;
  readonly trackTaskLogs: (
    objectiveId: string | undefined,
    tasks: ReadonlyArray<FactoryTaskView>,
  ) => void;
  readonly start: () => Promise<void>;
  readonly stop: () => void;
};

export type FactoryCliRuntimeEvent =
  | {
      readonly type: "queue_changed";
      readonly jobIds: ReadonlyArray<string>;
      readonly at: number;
    }
  | {
      readonly type: "objective_changed";
      readonly objectiveId: string;
      readonly at: number;
    }
  | {
      readonly type: "log_updated";
      readonly objectiveId: string;
      readonly taskId?: string;
      readonly stream: "stdout" | "stderr" | "last_message";
      readonly filePath: string;
      readonly at: number;
    }
  | {
      readonly type: "worker_error";
      readonly error: Error;
      readonly at: number;
    };

export type FactoryCliRuntimeListener = (event: FactoryCliRuntimeEvent) => void;

type FactoryCliRuntimeOptions = {
  readonly onWorkerError?: (error: Error) => void;
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

export const createFactoryCliRuntime = (
  config: FactoryCliConfig,
  opts: FactoryCliRuntimeOptions = {},
): FactoryCliRuntime => {
  const sse = new SseHub();
  const watchers = new Map<string, fs.FSWatcher>();
  const listeners = new Set<FactoryCliRuntimeListener>();
  let receiptPoller: ReturnType<typeof setInterval> | undefined;
  let focusedObjectiveId: string | undefined;
  const notify = (event: FactoryCliRuntimeEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures must not break the worker/runtime.
      }
    }
  };
  const closeWatcher = (key: string): void => {
    const watcher = watchers.get(key);
    if (!watcher) return;
    watcher.close();
    watchers.delete(key);
  };
  const watchPath = (
    key: string,
    filePath: string,
    onChange: () => void,
  ): void => {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    closeWatcher(key);
    try {
      const watcher = fs.watch(dir, (_eventType, filename) => {
        if (filename && String(filename) !== base) return;
        onChange();
      });
      watchers.set(key, watcher);
    } catch {
      // Best-effort runtime watching only.
    }
  };
  const jobRuntime = createRuntime<JobCmd, JobEvent, JobState>(
    sqliteReceiptStore<JobEvent>(config.dataDir),
    sqliteBranchStore(config.dataDir),
    decideJob,
    reduceJob,
    initialJob,
  );
  let serviceRef: FactoryService | undefined;
  const queue = sqliteQueue({
    runtime: jobRuntime,
    stream: "jobs",
    watchDir: config.dataDir,
    onJobChange: async (jobs) => {
      notify({
        type: "queue_changed",
        jobIds: jobs.map((job) => job.id),
        at: Date.now(),
      });

      for (const job of jobs) {
        const objectiveId =
          typeof job.payload.objectiveId === "string" &&
          job.payload.objectiveId.trim().length > 0
            ? job.payload.objectiveId.trim()
            : undefined;
        if (!objectiveId || !shouldReconcileObjectiveFromJobChange(job))
          continue;
        const [recentJobs, detail] = await Promise.all([
          queue.listJobs({ limit: 200 }),
          serviceRef?.getObjective(objectiveId).catch(() => undefined) ??
            Promise.resolve(undefined),
        ]);
        const shouldQueue = shouldQueueObjectiveControlReconcile({
          controlAgentId: FACTORY_CONTROL_AGENT_ID,
          objectiveId,
          recentJobs,
          sourceUpdatedAt: job.updatedAt,
          objectiveInactive:
            detail != null &&
            ["blocked", "canceled", "completed", "failed"].includes(
              detail.status,
            ),
        });
        if (!shouldQueue) continue;
        queue
          .enqueue({
            agentId: FACTORY_CONTROL_AGENT_ID,
            lane: "collect",
            sessionKey: `factory:objective:${objectiveId}`,
            singletonMode: "steer",
            maxAttempts: 1,
            payload: {
              kind: "factory.objective.control",
              objectiveId,
              reason: "reconcile",
            },
          })
          .catch(() => undefined);
      }
    },
  });
  const { service } = createFactoryServiceRuntime({
    dataDir: config.dataDir,
    queue,
    jobRuntime,
    sse,
    repoRoot: config.repoRoot,
    codexBin: config.codexBin,
    repoSlotConcurrency: config.repoSlotConcurrency,
  });
  serviceRef = service;

  const handlers = createFactoryWorkerHandlers(service, {
    auditAutoFixEnabled: parseBooleanEnv(
      process.env.RECEIPT_FACTORY_AUTO_FIX_ENABLED,
      true,
    ),
    auditAutoFixSourceChannels: parseListEnv(
      process.env.RECEIPT_FACTORY_AUTO_FIX_SOURCE_CHANNELS,
      ["trial"],
    ),
  });
  const worker = new JobWorker({
    queue,
    workerId: process.env.JOB_WORKER_ID ?? `factory_cli_${process.pid}`,
    idleResyncMs: Math.max(
      1_000,
      Number(
        process.env.JOB_IDLE_RESYNC_MS ?? process.env.JOB_POLL_MS ?? 5_000,
      ),
    ),
    leaseMs: Math.max(5_000, Number(process.env.JOB_LEASE_MS ?? 30_000)),
    concurrency: Math.max(1, Number(process.env.JOB_CONCURRENCY ?? 12)),
    leaseAgentIds: Object.keys(handlers),
    handlers,
    onError: (error) => {
      notify({
        type: "worker_error",
        error,
        at: Date.now(),
      });
      opts.onWorkerError?.(error);
    },
  });
  const objectiveWatchKey = "objective_stream";
  const focusObjective = async (objectiveId?: string): Promise<void> => {
    closeWatcher(objectiveWatchKey);
    focusedObjectiveId = objectiveId;
  };
  const trackTaskLogs = (
    objectiveId: string | undefined,
    tasks: ReadonlyArray<FactoryTaskView>,
  ): void => {
    for (const key of [...watchers.keys()]) {
      if (key.startsWith("log:")) closeWatcher(key);
    }
    if (!objectiveId) return;
    const activeTasks = tasks.filter(
      (task) =>
        task.status === "running" ||
        task.status === "reviewing" ||
        task.jobStatus === "running" ||
        task.jobStatus === "leased",
    );
    for (const task of activeTasks) {
      const streams = [
        ["stdout", task.stdoutPath],
        ["stderr", task.stderrPath],
        ["last_message", task.lastMessagePath],
      ] as const;
      for (const [stream, filePath] of streams) {
        if (!filePath) continue;
        const key = `log:${task.taskId}:${stream}`;
        watchPath(key, filePath, () => {
          notify({
            type: "log_updated",
            objectiveId,
            taskId: task.taskId,
            stream,
            filePath,
            at: Date.now(),
          });
        });
      }
    }
  };

  return {
    config,
    queue,
    service,
    worker,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    focusObjective,
    trackTaskLogs,
    start: async () => {
      await service.ensureBootstrap();
      const db = getReceiptDb(config.dataDir);
      let lastSeq = pollLatestChangeSeq(db);
      receiptPoller = setInterval(() => {
        try {
          const changes = listChangesAfter(db, lastSeq);
          if (changes.length === 0) return;
          lastSeq = changes[changes.length - 1]!.seq;
          for (const change of changes) {
            if (!focusedObjectiveId) continue;
            if (change.stream === `factory/objectives/${focusedObjectiveId}`) {
              notify({
                type: "objective_changed",
                objectiveId: focusedObjectiveId,
                at: change.changedAt,
              });
            }
          }
        } catch {
          // Best-effort runtime watching only.
        }
      }, 500);
      receiptPoller.unref();
      worker.start();
      await service.resumeObjectives();
    },
    stop: () => {
      worker.stop();
      if (receiptPoller) clearInterval(receiptPoller);
      for (const key of [...watchers.keys()]) {
        closeWatcher(key);
      }
    },
  };
};
