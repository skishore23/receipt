import fs from "node:fs";
import path from "node:path";

import { createRuntime } from "@receipt/core/runtime";

import { sqliteBranchStore, sqliteReceiptStore } from "../adapters/sqlite";
import { createResonateClient } from "../adapters/resonate-runtime";
import type { Flags } from "../cli.types";
import { renderReceiptDstAuditText, runReceiptDstAudit } from "./dst";
import { runAgentLoop } from "../engine/runtime/agent-loop";
import { createResonateAgentActionAdapter } from "../engine/runtime/resonate-agent-actions";
import { handleFactoryCommand } from "../factory-cli/commands";
import { detectGitRoot } from "../factory-cli/config";
import type { JobState } from "../modules/job";
import {
  commitUserPreference,
  globalUserPreferenceScope,
  listUserPreferenceEntries,
  removeUserPreferenceEntry,
  repoUserPreferenceScope,
} from "../services/conversation-memory";
import { repoKeyForRoot } from "../services/factory-chat-profiles";
import { readSessionHistory, searchSessionHistory } from "../services/session-history";
import {
  asIntegerFlag,
  asString,
  parseJsonFlag,
  parseNumberFlag,
  printUsage,
  type ParsedArgs,
} from "./shared";
import {
  DATA_DIR,
  JOB_BACKEND,
  ROOT,
  defaultResonateTargetGroup,
  ensureResonateDispatchReady,
  getJobBackend,
  getMemoryRuntime,
  getMemoryTools,
  loadAgentDefault,
  looksLikeDefineAgentSpec,
  readChain,
  resolveStream,
  spawnDevServer,
} from "./runtime";

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
      sqliteReceiptStore<Event>(DATA_DIR),
      sqliteBranchStore(DATA_DIR),
      (cmd) => [cmd.event],
      (state) => state,
      { ok: true },
    );

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

    const remoteActions = JOB_BACKEND === "resonate"
      ? createResonateAgentActionAdapter(createResonateClient("api"), {
        dataDir: DATA_DIR,
        defaultTargetGroup: defaultResonateTargetGroup,
      })
      : undefined;

    await runAgentLoop({
      spec: loadedDefault as unknown as Parameters<typeof runAgentLoop>[0]["spec"],
      runtime,
      stream: runStream,
      runId,
      deps: {},
      remoteActionDeps: {},
      remoteActions,
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

  const queue = getJobBackend();
  await ensureResonateDispatchReady();
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

const commandDst = async (args: ReadonlyArray<string>, flags: Flags): Promise<void> => {
  const prefix = args[0] ?? asString(flags, "prefix");
  const asJson = flags.json === true || flags.json === "true";
  const limit = asIntegerFlag(flags, "limit");
  const strict = flags.strict === true || flags.strict === "true";
  const includeContext = flags.context === true || flags.context === "true";
  const report = await runReceiptDstAudit(DATA_DIR, {
    prefix,
    includeContext,
    repoRoot: ROOT,
  });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReceiptDstAuditText(report, { limit }));
  }

  const hasReceiptFailures = report.integrityFailures > 0 || report.replayFailures > 0 || report.deterministicFailures > 0;
  const hasContextFailures = report.context
    ? report.context.integrityFailures > 0
      || report.context.replayFailures > 0
      || report.context.deterministicFailures > 0
    : false;
  if (strict && (hasReceiptFailures || hasContextFailures)) {
    throw new Error("DST audit found receipt issues");
  }
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
    sqliteReceiptStore<AnyEvent>(DATA_DIR),
    sqliteBranchStore(DATA_DIR),
    (cmd) => [cmd.event],
    (state) => state,
    { ok: true },
  );

  await runtime.fork(stream, Math.floor(at), branchName);
  console.log(JSON.stringify({ ok: true, stream, at: Math.floor(at), branch: branchName }, null, 2));
};

const commandJobsList = async (flags: Flags): Promise<void> => {
  const queue = getJobBackend();
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
  const queue = getJobBackend();
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

const commandJobsEnqueue = async (args: ReadonlyArray<string>, flags: Flags): Promise<void> => {
  const agentId = args[0];
  if (!agentId) throw new Error("agent id is required");
  const queue = getJobBackend();
  const payload = parseJsonFlag(flags, "payload-json") ?? {};
  const laneRaw = asString(flags, "lane");
  const lane = laneRaw === "chat" || laneRaw === "collect" || laneRaw === "steer" || laneRaw === "follow_up"
    ? laneRaw
    : undefined;
  const singletonModeRaw = asString(flags, "singleton-mode");
  const singletonMode = singletonModeRaw === "allow" || singletonModeRaw === "cancel" || singletonModeRaw === "steer"
    ? singletonModeRaw
    : undefined;
  const maxAttempts = parseNumberFlag(flags, "max-attempts");
  const job = await queue.enqueue({
    agentId,
    payload,
    ...(lane ? { lane } : {}),
    ...(singletonMode ? { singletonMode } : {}),
    ...(typeof maxAttempts === "number" ? { maxAttempts } : {}),
    ...(asString(flags, "job-id") ? { jobId: asString(flags, "job-id") } : {}),
    ...(asString(flags, "session-key") ? { sessionKey: asString(flags, "session-key") } : {}),
  });
  console.log(JSON.stringify({ ok: true, job }, null, 2));
};

const commandJobsWait = async (args: ReadonlyArray<string>, flags: Flags): Promise<void> => {
  const jobId = args[0];
  if (!jobId) throw new Error("job id is required");
  const queue = getJobBackend();
  const timeoutMs = parseNumberFlag(flags, "timeout-ms");
  const job = await queue.waitForJob(jobId, timeoutMs ?? 15_000, 200);
  if (!job) throw new Error(`job not found: ${jobId}`);
  console.log(JSON.stringify({ job }, null, 2));
};

const commandJobsCommand = async (
  args: ReadonlyArray<string>,
  flags: Flags,
  command: "steer" | "follow_up" | "abort",
): Promise<void> => {
  const jobId = args[0];
  if (!jobId) throw new Error("job id is required");
  if (command === "abort") {
    await commandAbort(jobId, flags);
    return;
  }
  const queue = getJobBackend();
  const payload = parseJsonFlag(flags, "payload-json") ?? {};
  const queued = await queue.queueCommand({
    jobId,
    command,
    payload,
    by: "receipt-cli",
  });
  if (!queued) throw new Error(`job not found: ${jobId}`);
  console.log(JSON.stringify({ ok: true, jobId, commandId: queued.id }, null, 2));
};

const commandJobs = async (args: ReadonlyArray<string>, flags: Flags): Promise<void> => {
  const subcommand = args[0];
  switch (subcommand) {
    case undefined:
    case "list":
      await commandJobsList(flags);
      return;
    case "enqueue":
      await commandJobsEnqueue(args.slice(1), flags);
      return;
    case "wait":
      await commandJobsWait(args.slice(1), flags);
      return;
    case "steer":
      await commandJobsCommand(args.slice(1), flags, "steer");
      return;
    case "follow-up":
      await commandJobsCommand(args.slice(1), flags, "follow_up");
      return;
    case "abort":
      await commandJobsCommand(args.slice(1), flags, "abort");
      return;
    default:
      throw new Error(`Unknown jobs subcommand '${subcommand}'`);
  }
};

const resolveCliRepoKey = async (flags: Flags): Promise<string | undefined> => {
  const candidate = asString(flags, "repo-root") ?? await detectGitRoot(ROOT);
  return candidate ? repoKeyForRoot(path.resolve(candidate)) : undefined;
};

const commandMemoryPrefs = async (args: ReadonlyArray<string>, flags: Flags): Promise<void> => {
  const subcommand = args[0] ?? "list";
  const memoryTools = getMemoryTools();
  const memoryRuntime = getMemoryRuntime();
  const scopeMode = (asString(flags, "scope") ?? "layered").trim().toLowerCase();
  const repoKey = scopeMode === "global" ? undefined : await resolveCliRepoKey(flags);
  const scopes = scopeMode === "repo"
    ? [repoKey ? repoUserPreferenceScope(repoKey) : undefined].filter((scope): scope is string => Boolean(scope))
    : scopeMode === "global"
      ? [globalUserPreferenceScope()]
      : [
          repoKey ? repoUserPreferenceScope(repoKey) : undefined,
          globalUserPreferenceScope(),
        ].filter((scope): scope is string => Boolean(scope));

  switch (subcommand) {
    case "list": {
      const entries = scopeMode === "layered"
        ? await listUserPreferenceEntries({
            memoryTools,
            repoKey,
            runId: "cli_memory_prefs_list",
            actor: "cli",
            scopeMode: "layered",
          })
        : (await Promise.all(scopes.map((scope) => memoryTools.read({
            scope,
            limit: 50,
            audit: { actor: "cli", command: "memory.prefs.list" },
          })))).flat();
      console.log(JSON.stringify({ scopes, entries }, null, 2));
      return;
    }
    case "add": {
      const text = asString(flags, "text") ?? args.slice(1).join(" ").trim();
      if (!text) throw new Error("memory prefs add requires --text or trailing text");
      const entry = await commitUserPreference({
        memoryTools,
        text,
        repoKey: scopeMode === "global" ? undefined : repoKey,
        source: "explicit_user",
        runId: "cli_memory_prefs_add",
        actor: "cli",
      });
      console.log(JSON.stringify({ entry }, null, 2));
      return;
    }
    case "remove": {
      const entryId = args[1]?.trim();
      if (!entryId) throw new Error("memory prefs remove requires an entry id");
      const entries = (await Promise.all(scopes.map((scope) => memoryTools.read({
        scope,
        limit: 100,
        audit: { actor: "cli", command: "memory.prefs.remove" },
      })))).flat();
      const target = entries.find((entry) => entry.id === entryId);
      if (!target) throw new Error(`Unknown preference entry '${entryId}'`);
      const removed = await removeUserPreferenceEntry({
        dir: DATA_DIR,
        runtime: memoryRuntime,
        entryId,
        scope: target.scope,
      });
      console.log(JSON.stringify({ removed, entryId, scope: target.scope }, null, 2));
      return;
    }
    default:
      throw new Error(`Unknown memory prefs subcommand '${subcommand}'`);
  }
};

const commandMemory = async (args: ReadonlyArray<string>, flags: Flags): Promise<void> => {
  const subcommand = args[0];
  if (!subcommand) throw new Error("memory subcommand is required");
  if (subcommand === "prefs") {
    await commandMemoryPrefs(args.slice(1), flags);
    return;
  }
  const scope = args[1];
  if (!scope) throw new Error("memory scope is required");
  const memoryTools = getMemoryTools();

  switch (subcommand) {
    case "read": {
      const limit = parseNumberFlag(flags, "limit");
      const entries = await memoryTools.read({
        scope,
        limit,
        audit: { actor: "cli", command: "memory.read" },
      });
      console.log(JSON.stringify({ entries }, null, 2));
      return;
    }
    case "search": {
      const query = asString(flags, "query") ?? args.slice(2).join(" ").trim();
      if (!query) throw new Error("memory search requires --query or trailing query text");
      const limit = parseNumberFlag(flags, "limit");
      const entries = await memoryTools.search({
        scope,
        query,
        limit,
        audit: { actor: "cli", command: "memory.search" },
      });
      console.log(JSON.stringify({ entries }, null, 2));
      return;
    }
    case "summarize": {
      const query = asString(flags, "query") ?? (args.length > 2 ? args.slice(2).join(" ").trim() : undefined);
      const limit = parseNumberFlag(flags, "limit");
      const maxChars = parseNumberFlag(flags, "max-chars");
      const result = await memoryTools.summarize({
        scope,
        query,
        limit,
        maxChars,
        audit: { actor: "cli", command: "memory.summarize" },
      });
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
      const entries = await memoryTools.diff({
        scope,
        fromTs,
        toTs,
        audit: { actor: "cli", command: "memory.diff" },
      });
      console.log(JSON.stringify({ entries }, null, 2));
      return;
    }
    default:
      throw new Error(`Unknown memory subcommand '${subcommand}'`);
  }
};

const commandSessions = async (args: ReadonlyArray<string>, flags: Flags): Promise<void> => {
  const subcommand = args[0];
  if (!subcommand) throw new Error("sessions subcommand is required");
  switch (subcommand) {
    case "search": {
      const query = asString(flags, "query") ?? args.slice(1).join(" ").trim();
      if (!query) throw new Error("sessions search requires --query or trailing query text");
      const limit = parseNumberFlag(flags, "limit");
      const repoKey = asString(flags, "repo-key");
      const profileId = asString(flags, "profile");
      const sessionStream = asString(flags, "session-stream");
      const results = await searchSessionHistory({
        dataDir: DATA_DIR,
        query,
        repoKey,
        profileId,
        sessionStream,
        limit,
      });
      console.log(JSON.stringify({ results }, null, 2));
      return;
    }
    case "read": {
      const target = args[1]?.trim();
      if (!target) throw new Error("sessions read requires a chat id or session stream");
      const limit = parseNumberFlag(flags, "limit");
      const messages = await readSessionHistory({
        dataDir: DATA_DIR,
        ...(target.includes("/sessions/") ? { sessionStream: target } : { chatId: target }),
        limit,
      });
      console.log(JSON.stringify({ messages }, null, 2));
      return;
    }
    default:
      throw new Error(`Unknown sessions subcommand '${subcommand}'`);
  }
};

const isHelpToken = (value: string | undefined): boolean =>
  value === "help" || value === "--help" || value === "-h";

const hasHelpFlag = (flags: Flags): boolean =>
  flags.help === true || flags.help === "true";

export const runCliCommand = async (parsed: ParsedArgs): Promise<void> => {
  if (parsed.command !== "factory" && (hasHelpFlag(parsed.flags) || isHelpToken(parsed.args[0]))) {
    printUsage();
    return;
  }

  switch (parsed.command) {
    case "new": {
      const id = parsed.args[0];
      if (!id) throw new Error("agent id is required");
      const template = asString(parsed.flags, "template") ?? "basic";
      await commandNew(id, template);
      return;
    }
    case "dev":
      await spawnDevServer();
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
    case "dst":
    case "simulate":
      await commandDst(parsed.args, parsed.flags);
      return;
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
      await commandJobs(parsed.args, parsed.flags);
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
    case "sessions":
      await commandSessions(parsed.args, parsed.flags);
      return;
    case "factory":
      await handleFactoryCommand(process.cwd(), parsed.args, parsed.flags);
      return;
    default:
      throw new Error(`Unknown command '${parsed.command}'`);
  }
};
