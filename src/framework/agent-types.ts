import type { Hono } from "hono";

import type { LlmTextOptions } from "../adapters/openai.js";
import type { EnqueueJobInput, JsonlQueue } from "../adapters/jsonl-queue.js";
import type { Runtime } from "@receipt/core/runtime.js";
import type { JobCmd, JobEvent, JobState } from "../modules/job.js";
import type { SseHub } from "./sse-hub.js";

export type AgentRouteModule = {
  readonly id: string;
  readonly kind?: string;
  readonly paths?: Readonly<Record<string, string>>;
  readonly register: (app: Hono) => void;
};

export type AgentLoaderContext = {
  readonly dataDir: string;
  readonly sse: SseHub;
  readonly llmText: (opts: LlmTextOptions) => Promise<string>;
  readonly enqueueJob: (job: EnqueueJobInput) => Promise<void>;
  readonly queue: JsonlQueue;
  readonly jobRuntime: Runtime<JobCmd, JobEvent, JobState>;
  readonly runtimes: Readonly<Record<string, unknown>>;
  readonly prompts: Readonly<Record<string, unknown>>;
  readonly promptHashes: Readonly<Record<string, string>>;
  readonly promptPaths: Readonly<Record<string, string>>;
  readonly models: Readonly<Record<string, string>>;
  readonly helpers?: Readonly<Record<string, unknown>>;
};

export type AgentModuleFactory = (ctx: AgentLoaderContext) => AgentRouteModule;

export type AgentModule = {
  readonly default: AgentModuleFactory;
};
