import { LocalCodexExecutor } from "../adapters/codex-executor";
import {
  createMemoryTools,
  decideMemory,
  initialMemoryState,
  reduceMemory,
  type MemoryCmd,
  type MemoryEvent,
  type MemoryState,
  type MemoryTools,
} from "../adapters/memory-tools";
import { jsonBranchStore, jsonlStore } from "../adapters/jsonl";
import { jsonlQueue } from "../adapters/jsonl-queue";
import { embed } from "../adapters/openai";
import { createRuntime } from "@receipt/core/runtime";
import type { JobHandler } from "../engine/runtime/job-worker";
import type { SseHub } from "../framework/sse-hub";
import type { JobCmd, JobEvent, JobState } from "../modules/job";
import { FACTORY_CONTROL_AGENT_ID, FactoryService } from "./factory-service";
import { runFactoryCodexJob } from "../agents/factory-chat";

export type FactoryQueue = ReturnType<typeof jsonlQueue>;
export type FactoryJobRuntime = ReturnType<typeof createRuntime<JobCmd, JobEvent, JobState>>;

type FactoryServiceRuntimeOptions = {
  readonly dataDir: string;
  readonly queue: FactoryQueue;
  readonly jobRuntime: FactoryJobRuntime;
  readonly sse: SseHub;
  readonly repoRoot: string;
  readonly codexBin?: string;
  readonly memoryTools?: MemoryTools;
};

const isNoRetryError = (err: unknown): boolean => {
  if (!err || typeof err !== "object" || !("status" in err)) return false;
  const status = (err as { readonly status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
};

const createDefaultMemoryTools = (dataDir: string): MemoryTools => {
  const memoryRuntime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
    jsonlStore<MemoryEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideMemory,
    reduceMemory,
    initialMemoryState,
  );
  return createMemoryTools({
    dir: dataDir,
    runtime: memoryRuntime,
    embed: process.env.OPENAI_API_KEY ? embed : undefined,
  });
};

export const createFactoryServiceRuntime = (opts: FactoryServiceRuntimeOptions): {
  readonly service: FactoryService;
  readonly memoryTools: MemoryTools;
} => {
  const memoryTools = opts.memoryTools ?? createDefaultMemoryTools(opts.dataDir);

  const service = new FactoryService({
    dataDir: opts.dataDir,
    queue: opts.queue,
    jobRuntime: opts.jobRuntime,
    sse: opts.sse,
    codexExecutor: new LocalCodexExecutor({ bin: opts.codexBin }),
    memoryTools,
    repoRoot: opts.repoRoot,
  });

  return {
    service,
    memoryTools,
  };
};

export const createFactoryWorkerHandlers = (service: FactoryService): Record<typeof FACTORY_CONTROL_AGENT_ID | "codex", JobHandler> => ({
  [FACTORY_CONTROL_AGENT_ID]: async (job, ctx) => {
    await ctx.pullCommands(["abort"]);
    try {
      const result = await service.runObjectiveControl(job.payload as Record<string, unknown>);
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message,
        result: {
          ...(typeof job.payload.objectiveId === "string" ? { objectiveId: job.payload.objectiveId } : {}),
          status: "failed",
          message,
        },
        noRetry: isNoRetryError(err),
      };
    }
  },
  codex: async (job, ctx) => {
    try {
      const result = job.payload.kind === "factory.task.run"
        ? await service.runTask(job.payload, {
          shouldAbort: async () => {
            const aborts = await ctx.pullCommands(["abort"]);
            const latest = await service.queue.getJob(job.id);
            return aborts.length > 0 || latest?.abortRequested === true;
          },
          pollSignal: async () => {
            const latest = await service.queue.getJob(job.id);
            if (latest?.abortRequested === true) return { kind: "abort" };
            return undefined;
          },
          })
        : job.payload.kind === "factory.codex.run" || job.payload.kind === "codex.run"
          ? await (async () => {
            const payload = job.payload as Record<string, unknown>;
            const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
            if (!prompt) {
              throw new Error(job.payload.kind === "factory.codex.run" ? "factory codex prompt required" : "codex prompt required");
            }
            const timeoutMs = typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
              ? Math.max(30_000, Math.min(Math.floor(payload.timeoutMs), 900_000))
              : 180_000;
            return runFactoryCodexJob({
              dataDir: service.dataDir,
              repoRoot: service.git.repoRoot,
              jobId: job.id,
              prompt,
              timeoutMs,
              executor: service.codexExecutor,
              factoryService: service,
              payload,
              onProgress: async (update) => {
                await service.queue.progress(job.id, ctx.workerId, update);
              },
            }, {
              shouldAbort: async () => {
                const latest = await service.queue.getJob(job.id);
                return latest?.abortRequested === true;
              },
            });
          })()
        : job.payload.kind === "factory.integration.validate"
          ? await service.runIntegrationValidation(job.payload)
        : job.payload.kind === "factory.integration.publish"
          ? await service.runIntegrationPublish(job.payload, {
              shouldAbort: async () => {
                const aborts = await ctx.pullCommands(["abort"]);
                return aborts.length > 0 || job.abortRequested === true;
              },
            })
          : (() => {
            throw new Error(`unsupported codex payload kind: ${String(job.payload.kind ?? "unknown")}`);
          })();
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message,
        result: {
          ...(typeof job.payload.objectiveId === "string" ? { objectiveId: job.payload.objectiveId } : {}),
          status: "failed",
          message,
        },
        noRetry: isNoRetryError(err),
      };
    }
  },
});
