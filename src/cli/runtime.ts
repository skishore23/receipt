import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { createRuntime } from "@receipt/core/runtime";

import { createMemoryTools, decideMemory, initialMemoryState, reduceMemory, type MemoryCmd, type MemoryEvent, type MemoryState } from "../adapters/memory-tools";
import { embed } from "../adapters/openai";
import type { JobBackend } from "../adapters/job-backend";
import { jsonBranchStore, jsonlStore } from "../adapters/jsonl";
import { jsonlQueue } from "../adapters/jsonl-queue";
import { resonateJobBackend } from "../adapters/resonate-job-backend";
import { resolveResonateGroups, resolveResonateUrl } from "../adapters/resonate-config";
import { createResonateClient, createResonateDriverStarter } from "../adapters/resonate-runtime";
import { resolveFactoryRuntimeConfig } from "../factory-cli/config";
import { resolveBunRuntime } from "../lib/runtime-paths";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../modules/job";

export const ROOT = process.cwd();
export const FACTORY_RUNTIME = await resolveFactoryRuntimeConfig(ROOT);
export const DATA_DIR = FACTORY_RUNTIME.dataDir;
export const JOB_BACKEND = process.env.JOB_BACKEND === "jsonl" ? "jsonl" : "resonate";

export const getJsonlQueue = () => {
  const runtime = createRuntime<JobCmd, JobEvent, JobState>(
    jsonlStore<JobEvent>(DATA_DIR),
    jsonBranchStore(DATA_DIR),
    decideJob,
    reduceJob,
    initialJob,
  );
  return jsonlQueue({ runtime, stream: "jobs" });
};

export const getJobBackend = (): JobBackend => {
  const base = getJsonlQueue();
  if (JOB_BACKEND !== "resonate") return base;
  const client = createResonateClient("api");
  return resonateJobBackend({
    base,
    startDriver: createResonateDriverStarter(client),
  });
};

export const getMemoryTools = () => {
  const runtime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
    jsonlStore<MemoryEvent>(DATA_DIR),
    jsonBranchStore(DATA_DIR),
    decideMemory,
    reduceMemory,
    initialMemoryState,
  );
  return createMemoryTools({
    dir: DATA_DIR,
    runtime,
    embed: process.env.OPENAI_API_KEY?.trim() ? embed : undefined,
  });
};

export const looksLikeDefineAgentSpec = (value: unknown): value is {
  readonly id: string;
  readonly version: string;
  readonly receipts: Record<string, unknown>;
  readonly view: (helpers: unknown) => unknown;
  readonly actions: (deps: Record<string, unknown>) => ReadonlyArray<{
    readonly id: string;
    readonly kind: "action" | "assistant" | "tool" | "human";
    readonly when?: (ctx: { readonly view: unknown }) => boolean;
    readonly run: (ctx: Record<string, unknown>) => Promise<void> | void;
    readonly watch?: ReadonlyArray<string>;
    readonly exclusive?: boolean;
    readonly maxConcurrency?: number;
  }>;
  readonly goal: (ctx: { readonly view: unknown }) => boolean;
  readonly maxIterations?: number;
  readonly maxConcurrency?: number;
} => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.version === "string"
    && typeof candidate.view === "function"
    && typeof candidate.actions === "function"
    && typeof candidate.goal === "function"
    && Boolean(candidate.receipts)
    && typeof candidate.receipts === "object";
};

export const loadAgentDefault = async (agentId: string): Promise<unknown | undefined> => {
  const srcFile = path.join(ROOT, "src", "agents", `${agentId}.agent.ts`);
  if (fs.existsSync(srcFile)) {
    const mod = await import(pathToFileURL(srcFile).href);
    return mod.default;
  }
  return undefined;
};

const streamManifest = async (): Promise<Readonly<Record<string, string>>> => {
  const file = path.join(DATA_DIR, "_streams.json");
  if (!fs.existsSync(file)) return {};
  const raw = await fs.promises.readFile(file, "utf-8");
  const parsed = JSON.parse(raw) as { byStream?: Record<string, string> };
  return parsed.byStream ?? {};
};

export const resolveStream = async (runOrStream: string): Promise<string> => {
  if (runOrStream.includes("/")) return runOrStream;
  const manifest = await streamManifest();
  const direct = Object.keys(manifest).find((stream) => stream === runOrStream);
  if (direct) return direct;
  const suffix = `/runs/${runOrStream}`;
  const runStream = Object.keys(manifest).find((stream) => stream.endsWith(suffix));
  if (runStream) return runStream;
  throw new Error(`Unable to resolve run/stream '${runOrStream}'`);
};

export const readChain = async (stream: string): Promise<ReadonlyArray<{ readonly ts: number; readonly body: Record<string, unknown> }>> => {
  const store = jsonlStore<Record<string, unknown>>(DATA_DIR);
  const chain = await store.read(stream);
  return chain.map((receipt) => ({ ts: receipt.ts, body: receipt.body }));
};

export const spawnDevServer = async (): Promise<void> => {
  const child = spawn(
    resolveBunRuntime(),
    JOB_BACKEND === "jsonl" ? ["--watch", "src/server.ts"] : ["scripts/start-resonate-dev.mjs"],
    {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit",
    },
  );

  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`receipt dev exited with code ${code ?? "null"}`));
    });
    child.on("error", reject);
  });
};

export const defaultResonateTargetGroup = resolveResonateGroups().chat;

export const ensureResonateDispatchReady = async (): Promise<void> => {
  if (JOB_BACKEND !== "resonate") return;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 1_200);
  try {
    await fetch(resolveResonateUrl(), {
      method: "GET",
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`resonate dispatch unavailable: ${message}`);
  } finally {
    clearTimeout(timer);
  }
};
