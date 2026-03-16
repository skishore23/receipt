import fs from "node:fs";

import { LocalCodexExecutor } from "../adapters/codex-executor.js";
import {
  createMemoryTools,
  decideMemory,
  initialMemoryState,
  reduceMemory,
  type MemoryCmd,
  type MemoryEvent,
  type MemoryState,
  type MemoryTools,
} from "../adapters/memory-tools.js";
import { jsonBranchStore, jsonlStore } from "../adapters/jsonl.js";
import { jsonlQueue } from "../adapters/jsonl-queue.js";
import { embed, llmStructured } from "../adapters/openai.js";
import { createRuntime } from "../core/runtime.js";
import type { JobHandler } from "../engine/runtime/job-worker.js";
import type { SseHub } from "../framework/sse-hub.js";
import { siblingPath } from "../lib/runtime-paths.js";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../modules/job.js";
import { createOpenAiFactoryOrchestrator, createTestFactoryOrchestrator } from "./factory-orchestrator.js";
import { FactoryService } from "./factory-service.js";

export type FactoryQueue = ReturnType<typeof jsonlQueue>;
export type FactoryJobRuntime = ReturnType<typeof createRuntime<JobCmd, JobEvent, JobState>>;

type FactoryServiceRuntimeOptions = {
  readonly dataDir: string;
  readonly queue: FactoryQueue;
  readonly jobRuntime: FactoryJobRuntime;
  readonly sse: SseHub;
  readonly repoRoot: string;
  readonly codexBin?: string;
  readonly orchestratorMode?: "enabled" | "disabled";
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
  readonly orchestratorMode: "enabled" | "disabled";
} => {
  const memoryTools = opts.memoryTools ?? createDefaultMemoryTools(opts.dataDir);
  const orchestratorPromptPath = siblingPath(import.meta.url, "../prompts/factory/orchestrator.md");
  const orchestratorPrompt = fs.existsSync(orchestratorPromptPath)
    ? fs.readFileSync(orchestratorPromptPath, "utf-8")
    : "";
  const requestedMode = opts.orchestratorMode === "enabled" ? "enabled" : "disabled";
  const orchestrator = process.env.FACTORY_ORCHESTRATOR_TEST_MODE?.trim()
    ? createTestFactoryOrchestrator()
    : (requestedMode === "enabled" && process.env.OPENAI_API_KEY
      ? createOpenAiFactoryOrchestrator({
        llmStructured,
        systemPrompt: orchestratorPrompt,
      })
      : undefined);

  const service = new FactoryService({
    dataDir: opts.dataDir,
    queue: opts.queue,
    jobRuntime: opts.jobRuntime,
    sse: opts.sse,
    codexExecutor: new LocalCodexExecutor({ bin: opts.codexBin }),
    memoryTools,
    llmStructured: requestedMode === "enabled" && process.env.OPENAI_API_KEY ? llmStructured : undefined,
    orchestrator,
    orchestratorMode: orchestrator ? "enabled" : "disabled",
    repoRoot: opts.repoRoot,
  });

  return {
    service,
    memoryTools,
    orchestratorMode: orchestrator ? "enabled" : "disabled",
  };
};

export const createFactoryWorkerHandlers = (service: FactoryService): Record<"factory" | "codex", JobHandler> => ({
  factory: async (job, ctx) => {
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
    await ctx.pullCommands(["steer", "follow_up"]);
    try {
      const result = job.payload.kind === "factory.task.run"
        ? await service.runTask(job.payload, {
          shouldAbort: async () => {
            const aborts = await ctx.pullCommands(["abort"]);
            return aborts.length > 0 || job.abortRequested === true;
          },
        })
        : job.payload.kind === "factory.integration.validate"
          ? await service.runIntegrationValidation(job.payload)
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
