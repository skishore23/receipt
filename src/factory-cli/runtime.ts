import { jsonBranchStore, jsonlStore } from "../adapters/jsonl.js";
import { jsonlQueue } from "../adapters/jsonl-queue.js";
import { createRuntime } from "../core/runtime.js";
import { JobWorker } from "../engine/runtime/job-worker.js";
import { SseHub } from "../framework/sse-hub.js";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../modules/job.js";
import { createFactoryServiceRuntime, createFactoryWorkerHandlers } from "../services/factory-runtime.js";
import type { FactoryService } from "../services/factory-service.js";
import type { FactoryCliConfig } from "./config.js";

export type FactoryCliRuntime = {
  readonly config: FactoryCliConfig;
  readonly queue: ReturnType<typeof jsonlQueue>;
  readonly service: FactoryService;
  readonly worker: JobWorker;
  readonly subscribe: (listener: FactoryCliRuntimeListener) => () => void;
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
    onJobChange: (jobIds) => {
      notify({
        type: "queue_changed",
        jobIds,
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
    orchestratorMode: config.orchestratorMode,
  });

  const worker = new JobWorker({
    queue,
    workerId: process.env.JOB_WORKER_ID ?? `factory_cli_${process.pid}`,
    pollMs: Math.max(50, Number(process.env.JOB_POLL_MS ?? 250)),
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
    start: async () => {
      await service.ensureBootstrap();
      worker.start();
      await service.resumeObjectives();
    },
    stop: () => {
      worker.stop();
    },
  };
};
