import fs from "node:fs";
import path from "node:path";

import { createStreamLocator, jsonBranchStore, jsonlStore } from "../adapters/jsonl.js";
import { jsonlQueue } from "../adapters/jsonl-queue.js";
import { createRuntime } from "@receipt/core/runtime.js";
import { JobWorker } from "../engine/runtime/job-worker.js";
import { SseHub } from "../framework/sse-hub.js";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../modules/job.js";
import { createFactoryServiceRuntime, createFactoryWorkerHandlers } from "../services/factory-runtime.js";
import type { FactoryService, FactoryTaskView } from "../services/factory-service.js";
import type { FactoryCliConfig } from "./config.js";

export type FactoryCliRuntime = {
  readonly config: FactoryCliConfig;
  readonly queue: ReturnType<typeof jsonlQueue>;
  readonly service: FactoryService;
  readonly worker: JobWorker;
  readonly subscribe: (listener: FactoryCliRuntimeListener) => () => void;
  readonly focusObjective: (objectiveId?: string) => Promise<void>;
  readonly trackTaskLogs: (objectiveId: string | undefined, tasks: ReadonlyArray<FactoryTaskView>) => void;
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

export const createFactoryCliRuntime = (
  config: FactoryCliConfig,
  opts: FactoryCliRuntimeOptions = {},
): FactoryCliRuntime => {
  const sse = new SseHub();
  const watchers = new Map<string, fs.FSWatcher>();
  const listeners = new Set<FactoryCliRuntimeListener>();
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
  const watchPath = (key: string, filePath: string, onChange: () => void): void => {
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
    jsonlStore<JobEvent>(config.dataDir),
    jsonBranchStore(config.dataDir),
    decideJob,
    reduceJob,
    initialJob,
  );
  const queue = jsonlQueue({
    runtime: jobRuntime,
    stream: "jobs",
    watchDir: config.dataDir,
    onJobChange: (jobs) => {
      notify({
        type: "queue_changed",
        jobIds: jobs.map((job) => job.id),
        at: Date.now(),
      });
    },
  });
  const { service } = createFactoryServiceRuntime({
    dataDir: config.dataDir,
    queue,
    jobRuntime,
    sse,
    repoRoot: config.repoRoot,
    codexBin: config.codexBin,
  });

  const worker = new JobWorker({
    queue,
    workerId: process.env.JOB_WORKER_ID ?? `factory_cli_${process.pid}`,
    idleResyncMs: Math.max(1_000, Number(process.env.JOB_IDLE_RESYNC_MS ?? process.env.JOB_POLL_MS ?? 5_000)),
    leaseMs: Math.max(5_000, Number(process.env.JOB_LEASE_MS ?? 30_000)),
    concurrency: Math.max(1, Number(process.env.JOB_CONCURRENCY ?? 2)),
    handlers: createFactoryWorkerHandlers(service),
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
    if (!objectiveId) return;
    const locator = createStreamLocator(config.dataDir);
    const streamFile = await locator.fileForExisting(`factory/objectives/${objectiveId}`);
    if (!streamFile) return;
    watchPath(objectiveWatchKey, streamFile, () => {
      notify({
        type: "objective_changed",
        objectiveId,
        at: Date.now(),
      });
    });
  };
  const trackTaskLogs = (objectiveId: string | undefined, tasks: ReadonlyArray<FactoryTaskView>): void => {
    for (const key of [...watchers.keys()]) {
      if (key.startsWith("log:")) closeWatcher(key);
    }
    if (!objectiveId) return;
    const activeTasks = tasks.filter((task) =>
      task.status === "running"
      || task.status === "reviewing"
      || task.jobStatus === "running"
      || task.jobStatus === "leased",
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
      worker.start();
      await service.resumeObjectives();
    },
    stop: () => {
      worker.stop();
      for (const key of [...watchers.keys()]) {
        closeWatcher(key);
      }
    },
  };
};
