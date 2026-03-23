#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { createMemoryTools, decideMemory, initialMemoryState, reduceMemory, type MemoryCmd, type MemoryEvent, type MemoryState } from "./adapters/memory-tools";
import { jsonBranchStore, jsonlStore } from "./adapters/jsonl";
import { jsonlQueue } from "./adapters/jsonl-queue";
import type { Flags } from "./cli.types";
import { createRuntime } from "@receipt/core/runtime";
import { runAgentLoop } from "./engine/runtime/agent-loop";
import { handleFactoryCommand } from "./factory-cli/commands";
import { resolveFactoryRuntimeConfig } from "./factory-cli/config";
import { resolveBunRuntime } from "./lib/runtime-paths";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "./modules/job";

type ParsedArgs = {
  readonly command?: string;
  readonly args: ReadonlyArray<string>;
  readonly flags: Flags;
};

const ROOT = process.cwd();
const FACTORY_RUNTIME = await resolveFactoryRuntimeConfig(ROOT);
const DATA_DIR = FACTORY_RUNTIME.dataDir;
const isInteractiveTerminal = (): boolean =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY);

const printUsage = (): void => {
  console.log(`receipt <command> [args]

In this repo, prefer:
  bun run factory
  bun src/cli.ts factory

Commands:
  receipt new <agent-id> [--template basic|assistant-tool|human-loop|merge]
  receipt dev
  receipt run <agent-id> --problem <text> [--stream agents/<agentId>] [--run-id <runId>] [--max-iterations <n>] [--workspace <path>]
  receipt trace <run-id|stream>
  receipt replay <run-id|stream>
  receipt fork <run-id|stream> --at <index> [--name <branch-name>]
  receipt inspect <run-id|stream>
  receipt jobs [--status queued|leased|running|completed|failed|canceled] [--limit <n>]
  receipt abort <job-id> [--reason <text>]
  receipt memory <read|search|summarize|commit|diff> <scope> [options]
  receipt factory [init|run|create|compose|watch|inspect|replay|replay-chat|resume|react|promote|cancel|cleanup|archive|steer|follow-up|abort-job|codex-probe]`);
};

const parseArgs = (argv: ReadonlyArray<string>): ParsedArgs => {
  const normalized = [...argv];
  while (normalized[0] === "--") normalized.shift();
  const [command, ...rest] = normalized;
  const args: string[] = [];
  const flags: Record<string, string | boolean | ReadonlyArray<string>> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--") {
      args.push(...rest.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }

    const trimmed = token.slice(2);
    const eq = trimmed.indexOf("=");
    if (eq >= 0) {
      const key = trimmed.slice(0, eq);
      const value = trimmed.slice(eq + 1);
      const prior = flags[key];
      flags[key] = Array.isArray(prior)
        ? [...prior, value]
        : typeof prior === "string"
          ? [prior, value]
          : value;
      continue;
    }

    const key = trimmed;
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    const prior = flags[key];
    flags[key] = Array.isArray(prior)
      ? [...prior, next]
      : typeof prior === "string"
        ? [prior, next]
        : next;
    i += 1;
  }

  return { command, args, flags };
};

const asString = (flags: Flags, key: string): string | undefined => {
  const value = flags[key];
  if (Array.isArray(value)) return value.at(-1);
  return typeof value === "string" ? value : undefined;
};

const asIntegerFlag = (flags: Flags, ...keys: ReadonlyArray<string>): number | undefined => {
  for (const key of keys) {
    const raw = asString(flags, key);
    if (!raw) continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) continue;
    return Math.floor(parsed);
  }
  return undefined;
};

const getQueue = () => {
  const runtime = createRuntime<JobCmd, JobEvent, JobState>(
    jsonlStore<JobEvent>(DATA_DIR),
    jsonBranchStore(DATA_DIR),
    decideJob,
    reduceJob,
    initialJob
  );
  return jsonlQueue({ runtime, stream: "jobs" });
};

const getMemoryTools = () => {
  const runtime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
    jsonlStore<MemoryEvent>(DATA_DIR),
    jsonBranchStore(DATA_DIR),
    decideMemory,
    reduceMemory,
    initialMemoryState
  );
  return createMemoryTools({
    dir: DATA_DIR,
    runtime,
  });
};

const looksLikeDefineAgentSpec = (value: unknown): value is {
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

const loadAgentDefault = async (agentId: string): Promise<unknown | undefined> => {
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

const resolveStream = async (runOrStream: string): Promise<string> => {
  if (runOrStream.includes("/")) return runOrStream;
  const manifest = await streamManifest();
  const direct = Object.keys(manifest).find((stream) => stream === runOrStream);
  if (direct) return direct;
  const suffix = `/runs/${runOrStream}`;
  const runStream = Object.keys(manifest).find((stream) => stream.endsWith(suffix));
  if (runStream) return runStream;
  throw new Error(`Unable to resolve run/stream '${runOrStream}'`);
};

const readChain = async (stream: string): Promise<ReadonlyArray<{ readonly ts: number; readonly body: Record<string, unknown> }>> => {
  const store = jsonlStore<Record<string, unknown>>(DATA_DIR);
  const chain = await store.read(stream);
  return chain.map((receipt) => ({ ts: receipt.ts, body: receipt.body }));
};

const commandNew = async (id: string, template: string): Promise<void> => {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`Invalid agent id '${id}'. Use kebab-case.`);
  }
  const target = path.join(ROOT, "src", "agents", `${id}.agent.ts`);
  if (fs.existsSync(target)) {
    throw new Error(`Agent file already exists: ${target}`);
  }

  const receiptDecl = template === "merge"
    ? `
  receipts: {
    "task.requested": receipt<{ prompt: string }>(),
    "candidate.generated": receipt<{ text: string; source: string }>(),
    "draft.finalized": receipt<{ text: string }>(),
  },`
    : `
  receipts: {
    "task.requested": receipt<{ prompt: string }>(),
    "task.completed": receipt<{ output: string }>(),
  },`;

  const actionBody = template === "human-loop"
    ? `human("approve", {
      when: ({ view }) => Boolean((view as { draft?: string }).draft),
      run: async ({ emit }) => {
        emit("task.completed", { output: "approved" });
      },
    })`
    : template === "assistant-tool"
      ? `assistant("draft", {
      when: ({ view }) => Boolean((view as { prompt?: string }).prompt),
      run: async ({ view, emit }) => {
        const prompt = (view as { prompt?: string }).prompt ?? "";
        emit("task.completed", { output: ` + "`Draft: ${prompt}`" + ` });
      },
    })`
      : `action("complete", {
      when: ({ view }) => Boolean((view as { prompt?: string }).prompt),
      run: async ({ view, emit }) => {
        const prompt = (view as { prompt?: string }).prompt ?? "";
        emit("task.completed", { output: prompt });
      },
    })`;

  const body = `import { defineAgent, receipt, action, assistant, human } from "../sdk/index";

export default defineAgent({
  id: "${id}",
  version: "1.0.0",${receiptDecl}

  view: ({ on }) => ({
    prompt: on("task.requested").last()?.prompt,
    done: on("task.completed").exists(),
  }),

  actions: () => [
    ${actionBody}
  ],

  goal: ({ view }) => Boolean((view as { done?: boolean }).done),
});
`;

  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, body, "utf-8");
  console.log(`created ${path.relative(ROOT, target)}`);
};

const commandDev = async (): Promise<void> => {
  const child = spawn(resolveBunRuntime(), ["--watch", "src/server.ts"], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });

  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`receipt dev exited with code ${code ?? "null"}`));
    });
    child.on("error", reject);
  });
};

const commandRun = async (agentId: string, flags: Flags): Promise<void> => {
  const problem = asString(flags, "problem") ?? asString(flags, "prompt") ?? "";
  if (!problem) throw new Error("--problem is required");
  const runId = asString(flags, "run-id") ?? `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const stream = asString(flags, "stream") ?? `agents/${agentId}`;
  const runStream = asString(flags, "run-stream") ?? `${stream}/runs/${runId}`;

  const loadedDefault = await loadAgentDefault(agentId);
  if (looksLikeDefineAgentSpec(loadedDefault)) {
    type Event = Record<string, unknown> & { readonly type: string };
    type Cmd = {
      readonly type: "emit";
      readonly event: Event;
      readonly eventId: string;
      readonly expectedPrev?: string;
    };

    const runtime = createRuntime<Cmd, Event, { readonly ok: true }>(
      jsonlStore<Event>(DATA_DIR),
      jsonBranchStore(DATA_DIR),
      (cmd) => [cmd.event],
      (state) => state,
      { ok: true }
    );

    const runStream = `${stream}/runs/${runId}`;
    const receipts = Object.keys(loadedDefault.receipts);
    if (receipts.includes("task.requested")) {
      await runtime.execute(runStream, {
        type: "emit",
        eventId: `seed:${runId}`,
        event: { type: "task.requested", prompt: problem },
      });
    } else if (receipts.includes("prompt.received")) {
      await runtime.execute(runStream, {
        type: "emit",
        eventId: `seed:${runId}`,
        event: { type: "prompt.received", prompt: problem },
      });
    }

    await runAgentLoop({
      spec: loadedDefault as unknown as Parameters<typeof runAgentLoop>[0]["spec"],
      runtime,
      stream: runStream,
      runId,
      deps: {},
      wrap: (event, meta) => ({
        type: "emit",
        event,
        eventId: meta.eventId,
        expectedPrev: meta.expectedPrev,
      } as Cmd),
    });

    console.log(JSON.stringify({ ok: true, mode: "inline", runId, stream, runStream }, null, 2));
    return;
  }

  const queue = getQueue();
  const config: Record<string, string | number> = {};
  const maxIterations = asIntegerFlag(flags, "max-iterations", "maxIterations");
  const maxToolOutputChars = asIntegerFlag(flags, "max-tool-output-chars", "maxToolOutputChars");
  const memoryScope = asString(flags, "memory-scope") ?? asString(flags, "memoryScope");
  const workspace = asString(flags, "workspace");
  if (maxIterations !== undefined) config.maxIterations = maxIterations;
  if (maxToolOutputChars !== undefined) config.maxToolOutputChars = maxToolOutputChars;
  if (memoryScope) config.memoryScope = memoryScope;
  if (workspace) config.workspace = workspace;
  const job = await queue.enqueue({
    agentId,
    lane: "collect",
    sessionKey: `${agentId}:${stream}`,
    singletonMode: "cancel",
    maxAttempts: 2,
    payload: {
      kind: `${agentId}.run`,
      stream,
      runId,
      runStream,
      problem,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    },
  });

  console.log(JSON.stringify({ ok: true, mode: "queued", jobId: job.id, runId, stream, runStream }, null, 2));
};

const commandTrace = async (runOrStream: string): Promise<void> => {
  const stream = await resolveStream(runOrStream);
  const chain = await readChain(stream);
  chain.forEach((receipt, idx) => {
    const body = receipt.body;
    const type = typeof body.type === "string" ? body.type : "unknown";
    console.log(`${idx.toString().padStart(4, " ")}  ${new Date(receipt.ts).toISOString()}  ${type}`);
  });
};

const commandReplay = async (runOrStream: string): Promise<void> => {
  const stream = await resolveStream(runOrStream);
  const chain = await readChain(stream);
  console.log(JSON.stringify({ stream, receipts: chain.map((r) => r.body) }, null, 2));
};

const commandInspect = async (runOrStream: string): Promise<void> => {
  const stream = await resolveStream(runOrStream);
  const chain = await readChain(stream);
  console.log(JSON.stringify({ stream, count: chain.length, head: chain[chain.length - 1]?.body ?? null }, null, 2));
};

const commandFork = async (runOrStream: string, flags: Flags): Promise<void> => {
  const atRaw = asString(flags, "at");
  if (!atRaw) throw new Error("--at is required");
  const at = Number(atRaw);
  if (!Number.isFinite(at) || at < 0) throw new Error("--at must be a non-negative number");

  const stream = await resolveStream(runOrStream);
  const branchName = asString(flags, "name") ?? `${stream}/branches/fork_${Date.now().toString(36)}_${Math.floor(at)}`;

  type AnyEvent = Record<string, unknown>;
  type AnyCmd = {
    readonly type: "emit";
    readonly event: AnyEvent;
    readonly eventId: string;
    readonly expectedPrev?: string;
  };

  const runtime = createRuntime<AnyCmd, AnyEvent, { readonly ok: true }>(
    jsonlStore<AnyEvent>(DATA_DIR),
    jsonBranchStore(DATA_DIR),
    (cmd) => [cmd.event],
    (state) => state,
    { ok: true }
  );

  await runtime.fork(stream, Math.floor(at), branchName);
  console.log(JSON.stringify({ ok: true, stream, at: Math.floor(at), branch: branchName }, null, 2));
};

const commandJobs = async (flags: Flags): Promise<void> => {
  const queue = getQueue();
  const status = asString(flags, "status");
  const limitRaw = asString(flags, "limit");
  const limit = limitRaw ? Number(limitRaw) : 50;
  const jobs = await queue.listJobs({
    status: status as JobState["jobs"][string]["status"] | undefined,
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 500)) : 50,
  });
  console.log(JSON.stringify({ jobs }, null, 2));
};

const commandAbort = async (jobId: string, flags: Flags): Promise<void> => {
  const reason = asString(flags, "reason") ?? "abort requested";
  const queue = getQueue();
  const queued = await queue.queueCommand({
    jobId,
    command: "abort",
    payload: { reason },
    by: "receipt-cli",
  });

  if (!queued) {
    throw new Error(`job not found: ${jobId}`);
  }

  console.log(JSON.stringify({ ok: true, jobId, commandId: queued.id }, null, 2));
};

const parseNumberFlag = (flags: Flags, key: string): number | undefined => {
  const raw = asString(flags, key);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number`);
  return parsed;
};

const commandMemory = async (args: ReadonlyArray<string>, flags: Flags): Promise<void> => {
  const subcommand = args[0];
  const scope = args[1];
  if (!subcommand) throw new Error("memory subcommand is required");
  if (!scope) throw new Error("memory scope is required");
  const memoryTools = getMemoryTools();

  switch (subcommand) {
    case "read": {
      const limit = parseNumberFlag(flags, "limit");
      const entries = await memoryTools.read({ scope, limit });
      console.log(JSON.stringify({ entries }, null, 2));
      return;
    }
    case "search": {
      const query = asString(flags, "query") ?? args.slice(2).join(" ").trim();
      if (!query) throw new Error("memory search requires --query or trailing query text");
      const limit = parseNumberFlag(flags, "limit");
      const entries = await memoryTools.search({ scope, query, limit });
      console.log(JSON.stringify({ entries }, null, 2));
      return;
    }
    case "summarize": {
      const query = asString(flags, "query") ?? (args.length > 2 ? args.slice(2).join(" ").trim() : undefined);
      const limit = parseNumberFlag(flags, "limit");
      const maxChars = parseNumberFlag(flags, "max-chars");
      const result = await memoryTools.summarize({ scope, query, limit, maxChars });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "commit": {
      const text = asString(flags, "text") ?? args.slice(2).join(" ").trim();
      if (!text) throw new Error("memory commit requires --text or trailing text");
      const tags = (asString(flags, "tags") ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      const entry = await memoryTools.commit({
        scope,
        text,
        tags: tags.length ? tags : undefined,
      });
      console.log(JSON.stringify({ entry }, null, 2));
      return;
    }
    case "diff": {
      const fromTs = parseNumberFlag(flags, "from-ts");
      if (fromTs === undefined) throw new Error("memory diff requires --from-ts");
      const toTs = parseNumberFlag(flags, "to-ts");
      const entries = await memoryTools.diff({ scope, fromTs, toTs });
      console.log(JSON.stringify({ entries }, null, 2));
      return;
    }
    default:
      throw new Error(`Unknown memory subcommand '${subcommand}'`);
  }
};

const main = async (): Promise<void> => {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.command;

  if (!command) {
    if (isInteractiveTerminal()) {
      await handleFactoryCommand(ROOT, [], {});
      return;
    }
    printUsage();
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  switch (command) {
    case "new": {
      const id = parsed.args[0];
      if (!id) throw new Error("agent id is required");
      const template = asString(parsed.flags, "template") ?? "basic";
      await commandNew(id, template);
      return;
    }
    case "dev":
      await commandDev();
      return;
    case "run": {
      const agentId = parsed.args[0];
      if (!agentId) throw new Error("agent id is required");
      await commandRun(agentId, parsed.flags);
      return;
    }
    case "trace": {
      const runOrStream = parsed.args[0];
      if (!runOrStream) throw new Error("run-id or stream is required");
      await commandTrace(runOrStream);
      return;
    }
    case "replay": {
      const runOrStream = parsed.args[0];
      if (!runOrStream) throw new Error("run-id or stream is required");
      await commandReplay(runOrStream);
      return;
    }
    case "fork": {
      const runOrStream = parsed.args[0];
      if (!runOrStream) throw new Error("run-id or stream is required");
      await commandFork(runOrStream, parsed.flags);
      return;
    }
    case "inspect": {
      const runOrStream = parsed.args[0];
      if (!runOrStream) throw new Error("run-id or stream is required");
      await commandInspect(runOrStream);
      return;
    }
    case "jobs":
      await commandJobs(parsed.flags);
      return;
    case "abort": {
      const jobId = parsed.args[0];
      if (!jobId) throw new Error("job id is required");
      await commandAbort(jobId, parsed.flags);
      return;
    }
    case "memory":
      await commandMemory(parsed.args, parsed.flags);
      return;
    case "factory":
      await handleFactoryCommand(process.cwd(), parsed.args, parsed.flags);
      return;
    default:
      throw new Error(`Unknown command '${command}'`);
  }
};

const exitCli = (): void => {
  if (process.env.RECEIPT_CLI_NO_FORCE_EXIT === "1") return;
  const code = process.exitCode ?? 0;
  process.stdout.write("", () => {
    process.stderr.write("", () => {
      process.exit(code);
    });
  });
};

main()
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`error: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    exitCli();
  });
