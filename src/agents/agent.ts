// ============================================================================
// Agent - think/act/observe loop for Receipt
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { z } from "zod";

import type { Chain } from "../core/types.js";
import type { Runtime } from "../core/runtime.js";
import { clampNumber, parseFormNum, type AgentRunControl, createQueuedEmitter, getLatestRunId } from "../engine/runtime/workflow.js";
import type { MemoryTools } from "../adapters/memory-tools.js";
import type { AgentCmd, AgentEvent, AgentState, AgentToolName } from "../modules/agent.js";
import type { FailureRecord } from "../modules/failure.js";
import { agentRunStream } from "./agent.streams.js";
import type { DelegationTools } from "../adapters/delegation.js";
import type { AgentPromptConfig } from "../prompts/agent.js";
import { renderPrompt } from "../prompts/agent.js";
import { buildAgentRunResult, type AgentRunResult } from "./agent.result.js";

export const AGENT_WORKFLOW_ID = "agent-v1";
export const AGENT_WORKFLOW_VERSION = "1.0.0";

export type AgentRunConfig = {
  readonly maxIterations: number;
  readonly maxToolOutputChars: number;
  readonly memoryScope: string;
  readonly workspace: string;
};

export const AGENT_DEFAULT_CONFIG: AgentRunConfig = {
  maxIterations: 10,
  maxToolOutputChars: 4_000,
  memoryScope: "agent",
  workspace: ".",
};

export const normalizeAgentConfig = (input: Partial<AgentRunConfig>): AgentRunConfig => ({
  maxIterations: clampNumber(
    Number.isFinite(input.maxIterations ?? Number.NaN) ? input.maxIterations! : AGENT_DEFAULT_CONFIG.maxIterations,
    1,
    40
  ),
  maxToolOutputChars: clampNumber(
    Number.isFinite(input.maxToolOutputChars ?? Number.NaN) ? input.maxToolOutputChars! : AGENT_DEFAULT_CONFIG.maxToolOutputChars,
    400,
    20_000
  ),
  memoryScope: typeof input.memoryScope === "string" && input.memoryScope.trim().length > 0
    ? input.memoryScope.trim()
    : AGENT_DEFAULT_CONFIG.memoryScope,
  workspace: typeof input.workspace === "string" && input.workspace.trim().length > 0
    ? input.workspace.trim()
    : AGENT_DEFAULT_CONFIG.workspace,
});

export const parseAgentConfig = (form: Record<string, string>): AgentRunConfig =>
  normalizeAgentConfig({
    maxIterations: parseFormNum(form.maxIterations),
    maxToolOutputChars: parseFormNum(form.maxToolOutputChars),
    memoryScope: form.memoryScope,
    workspace: form.workspace,
  });

export const getLatestAgentRunId = (chain: Chain<AgentEvent>): string | undefined =>
  getLatestRunId(chain, "problem.set");

export type { AgentRunResult } from "./agent.result.js";

export type AgentRunInput = {
  readonly stream: string;
  readonly runId: string;
  readonly runStream?: string;
  readonly problem: string;
  readonly config: AgentRunConfig;
  readonly runtime: Runtime<AgentCmd, AgentEvent, AgentState>;
  readonly prompts: AgentPromptConfig;
  readonly llmText: (opts: { system?: string; user: string }) => Promise<string>;
  readonly llmStructured: <Schema extends z.ZodTypeAny>(opts: {
    readonly system?: string;
    readonly user: string;
    readonly schema: Schema;
    readonly schemaName: string;
  }) => Promise<{ readonly parsed: z.infer<Schema>; readonly raw: string }>;
  readonly model: string;
  readonly promptHash?: string;
  readonly promptPath?: string;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly memoryTools: MemoryTools;
  readonly delegationTools: DelegationTools;
  readonly workspaceRoot: string;
  readonly broadcast?: () => void;
  readonly now?: () => number;
  readonly control?: AgentRunControl;
  readonly workflowId?: string;
  readonly workflowVersion?: string;
  readonly extraConfig?: Readonly<Record<string, unknown>>;
  readonly extraToolSpecs?: Readonly<Record<string, string>>;
  readonly extraTools?: Readonly<Record<string, AgentToolExecutor>>;
  readonly toolAllowlist?: ReadonlyArray<string>;
  readonly startupEvents?: ReadonlyArray<AgentEvent>;
  readonly finalizer?: AgentFinalizer;
  readonly onIterationBudgetExhausted?: AgentIterationBudgetHandler;
};

export type AgentToolResult = {
  readonly output: string;
  readonly summary: string;
  readonly events?: ReadonlyArray<AgentEvent>;
  readonly reports?: ReadonlyArray<Omit<Extract<AgentEvent, { type: "validation.report" }>, "type" | "runId" | "iteration" | "agentId">>;
};

export type AgentToolExecutor = (input: Record<string, unknown>) => Promise<AgentToolResult>;

export type AgentFinalizerResult = {
  readonly accept: boolean;
  readonly text?: string;
  readonly note?: string;
};

export type AgentIterationBudgetContinuation = {
  readonly finalText: string;
  readonly note?: string;
  readonly events?: ReadonlyArray<AgentEvent>;
};

export type AgentFinalizer = (input: {
  readonly runId: string;
  readonly runStream: string;
  readonly iteration: number;
  readonly text: string;
  readonly problem: string;
  readonly workspaceRoot: string;
  readonly emit: (event: AgentEvent, index?: boolean) => Promise<void>;
  readonly runtime: Runtime<AgentCmd, AgentEvent, AgentState>;
  readonly now: () => number;
}) => Promise<AgentFinalizerResult>;

export type AgentIterationBudgetHandler = (input: {
  readonly runId: string;
  readonly runStream: string;
  readonly problem: string;
  readonly config: AgentRunConfig;
  readonly runtime: Runtime<AgentCmd, AgentEvent, AgentState>;
  readonly now: () => number;
}) => Promise<AgentIterationBudgetContinuation | undefined>;

const truncateText = (input: string, limit: number): { readonly text: string; readonly truncated: boolean } => {
  if (input.length <= limit) return { text: input, truncated: false };
  if (limit <= 3) return { text: input.slice(0, limit), truncated: true };
  return {
    text: `${input.slice(0, limit - 3)}...`,
    truncated: true,
  };
};

const softTrim = (text: string, headChars: number, tailChars: number): string => {
  if (text.length <= headChars + tailChars + 16) return text;
  return `${text.slice(0, headChars)}\n\n[... trimmed ...]\n\n${text.slice(-tailChars)}`;
};

const compactPrompt = (text: string, targetChars: number): string => {
  if (text.length <= targetChars) return text;
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const head = lines.slice(0, 28).join("\n");
  const tail = lines.slice(-18).join("\n");
  const merged = `${head}\n\n[... compacted context ...]\n\n${tail}`.trim();
  if (merged.length <= targetChars) return merged;
  return softTrim(merged, Math.floor(targetChars * 0.6), Math.floor(targetChars * 0.3));
};

const isContextOverflow = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  return /context|token|maximum context|input too large|prompt too long/i.test(message);
};

const resolveWorkspacePath = (root: string, rawPath: string): string => {
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, rawPath);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`path escapes workspace: ${rawPath}`);
  }
  return resolved;
};

type ParsedAction =
  | {
      readonly thought: string;
      readonly actionType: "final";
      readonly text: string;
    }
  | {
      readonly thought: string;
      readonly actionType: "tool";
      readonly name: string;
      readonly input: Record<string, unknown>;
    };

const structuredAgentActionSchema = z.object({
  thought: z.string(),
  action: z.object({
    type: z.enum(["tool", "final"]),
    name: z.string().nullable(),
    input: z.string(),
    text: z.string().nullable(),
  }).strict(),
}).strict();

type StructuredAgentAction = z.infer<typeof structuredAgentActionSchema>;

const normalizeStructuredInput = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") {
    throw new Error("Model tool action input must be a JSON object or JSON object string");
  }
  const trimmed = raw.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Model tool action input is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model tool action input must decode to a JSON object");
  }
  return parsed as Record<string, unknown>;
};

const normalizeStructuredAction = (value: StructuredAgentAction): ParsedAction => {
  const thought = value.thought.trim() || "No thought provided.";
  if (value.action.type === "final") {
    const text = value.action.text?.trim();
    if (!text) throw new Error("Model final action missing text");
    return {
      thought,
      actionType: "final",
      text,
    };
  }
  const name = value.action.name?.trim();
  if (!name) throw new Error("Model tool action missing name");
  return {
    thought,
    actionType: "tool",
    name,
    input: normalizeStructuredInput((value.action as { input: unknown }).input),
  };
};

const isStructuredInputParseError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  return [
    "Model tool action input must be a JSON object or JSON object string",
    "Model tool action input is not valid JSON",
    "Model tool action input must decode to a JSON object",
  ].includes(message);
};

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
};

const deriveTranscriptLines = (chain: Chain<AgentEvent>, limit: number): ReadonlyArray<string> => {
  const lines: string[] = [];
  for (const receipt of chain) {
    const event = receipt.body;
    switch (event.type) {
      case "thought.logged":
        lines.push(`Thought: ${event.content}`);
        break;
      case "action.planned":
        if (event.actionType === "tool") {
          lines.push(`Action: ${event.name ?? "unknown"} ${safeJson(event.input ?? {})}`);
        }
        break;
      case "tool.observed":
        lines.push(`Observation:\n${event.output}`);
        break;
      case "tool.called":
        if (event.error) {
          lines.push(`Tool ${event.tool} failed: ${event.error}`);
        }
        break;
      case "validation.report":
        lines.push(`Validation ${event.gate}: ${event.ok ? "passed" : "failed"}${event.target ? ` (${event.target})` : ""} - ${event.summary}`);
        break;
      default:
        break;
    }
  }
  if (lines.length <= limit) return lines;
  return lines.slice(lines.length - limit);
};

const compactRawModelOutput = (raw: string): string =>
  raw.trim().replace(/\s+/g, " ").slice(0, 800);

class TerminalAgentFailure extends Error {
  readonly failure: FailureRecord;

  constructor(failure: FailureRecord) {
    super(failure.message);
    this.name = "TerminalAgentFailure";
    this.failure = failure;
  }
}

const runShell = async (
  cmd: string,
  cwd: string,
  timeoutMs: number
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd,
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, Math.max(500, timeoutMs));

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });

const BASE_TOOL_SPECS: Readonly<Record<string, string>> = {
  ls: '{"path"?: string} — List directory contents. Defaults to workspace root.',
  read: '{"path": string, "startLine"?: number, "endLine"?: number, "maxChars"?: number} — Read file contents with optional line range.',
  write: '{"path": string, "content": string, "append"?: boolean} — Write or append to a file.',
  bash: '{"cmd": string, "timeoutMs"?: number} — Execute a shell command (default timeout 20s, max 120s).',
  grep: '{"pattern": string, "path"?: string, "maxMatches"?: number} — Search files using ripgrep.',
  "memory.read": '{"scope"?: string, "limit"?: number} — Read recent memory entries for a scope.',
  "memory.search": '{"scope"?: string, "query": string, "limit"?: number} — Semantic search over memory entries by meaning.',
  "memory.summarize": '{"scope"?: string, "query"?: string, "limit"?: number, "maxChars"?: number} — Summarize memory entries, optionally filtered by query.',
  "memory.commit": '{"scope"?: string, "text": string, "tags"?: string[]} — Persist a new memory entry.',
  "memory.diff": '{"scope"?: string, "fromTs": number, "toTs"?: number} — List memory entries within a timestamp range.',
  "agent.delegate": '{"agentId": string, "task": string, "config"?: object, "timeoutMs"?: number} — Delegate a sub-task to a specialized agent (theorem, writer, agent, axiom, inspector). Blocks until complete or timeout.',
  "agent.status": '{"jobId": string} — Check status and result of a previously delegated job.',
  "agent.inspect": '{"file": string, "maxChars"?: number} — Read another agent\'s event history by bare .jsonl filename or by stream id such as agents/factory/<repoKey>/<profileId>.',
  "skill.read": '{"name": string} — Get the full parameter spec for any tool by name.',
};

const createTools = (opts: {
  readonly workspaceRoot: string;
  readonly defaultMemoryScope: string;
  readonly maxToolOutputChars: number;
  readonly memoryTools: MemoryTools;
  readonly delegationTools: DelegationTools;
  readonly extraToolSpecs?: Readonly<Record<string, string>>;
  readonly extraTools?: Readonly<Record<string, AgentToolExecutor>>;
  readonly toolAllowlist?: ReadonlyArray<string>;
}): { readonly toolSpecs: Readonly<Record<string, string>>; readonly tools: Readonly<Record<string, AgentToolExecutor>> } => {
  const workspaceRoot = path.resolve(opts.workspaceRoot);
  const defaultScope = opts.defaultMemoryScope;
  const maxChars = opts.maxToolOutputChars;
  const memory = opts.memoryTools;
  const toolSpecs = {
    ...BASE_TOOL_SPECS,
    ...(opts.extraToolSpecs ?? {}),
  } as const;

  const normalizeScope = (input: Record<string, unknown>): string => {
    if (typeof input.scope === "string" && input.scope.trim().length > 0) return input.scope.trim();
    return defaultScope;
  };

  const summarize = (value: unknown): AgentToolResult => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const clipped = truncateText(text, maxChars);
    const summaryLine = clipped.text.split("\n")[0] ?? "";
    return {
      output: clipped.text,
      summary: clipped.truncated ? `${summaryLine} (truncated)` : summaryLine,
    };
  };

  const builtins: Record<string, AgentToolExecutor> = {
    ls: async (input) => {
      const rel = typeof input.path === "string" && input.path.trim().length > 0 ? input.path.trim() : ".";
      const abs = resolveWorkspacePath(workspaceRoot, rel);
      const entries = await fs.promises.readdir(abs, { withFileTypes: true });
      const listing = entries
        .slice(0, 500)
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .join("\n");
      return summarize(listing || "(empty directory)");
    },

    read: async (input) => {
      const rawPath = typeof input.path === "string" ? input.path.trim() : "";
      if (!rawPath) throw new Error("read.path is required");
      const abs = resolveWorkspacePath(workspaceRoot, rawPath);
      const raw = await fs.promises.readFile(abs);
      if (raw.includes(0)) throw new Error("binary file not supported by read tool");
      const text = raw.toString("utf-8");
      const startLine = typeof input.startLine === "number" && Number.isFinite(input.startLine)
        ? Math.max(1, Math.floor(input.startLine))
        : 1;
      const endLine = typeof input.endLine === "number" && Number.isFinite(input.endLine)
        ? Math.max(startLine, Math.floor(input.endLine))
        : Number.MAX_SAFE_INTEGER;
      const lines = text.split("\n");
      const sliced = lines.slice(startLine - 1, endLine).join("\n");
      const localLimit = typeof input.maxChars === "number" && Number.isFinite(input.maxChars)
        ? Math.max(100, Math.min(Math.floor(input.maxChars), maxChars))
        : maxChars;
      return summarize(truncateText(sliced, localLimit).text);
    },

    write: async (input) => {
      const rawPath = typeof input.path === "string" ? input.path.trim() : "";
      const content = typeof input.content === "string" ? input.content : "";
      if (!rawPath) throw new Error("write.path is required");
      const abs = resolveWorkspacePath(workspaceRoot, rawPath);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      if (input.append === true) {
        await fs.promises.appendFile(abs, content, "utf-8");
      } else {
        await fs.promises.writeFile(abs, content, "utf-8");
      }
      return summarize(`wrote ${content.length} chars to ${rawPath}`);
    },

    bash: async (input) => {
      const cmd = typeof input.cmd === "string" ? input.cmd.trim() : "";
      if (!cmd) throw new Error("bash.cmd is required");
      const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
        ? Math.max(500, Math.min(Math.floor(input.timeoutMs), 120_000))
        : 20_000;
      const result = await runShell(cmd, workspaceRoot, timeoutMs);
      const merged = [
        `exit: ${result.code ?? "null"} signal: ${result.signal ?? "none"}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
      ].filter(Boolean).join("\n\n");
      return summarize(merged);
    },

    grep: async (input) => {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      if (!pattern.trim()) throw new Error("grep.pattern is required");
      const rel = typeof input.path === "string" && input.path.trim().length > 0 ? input.path.trim() : ".";
      const abs = resolveWorkspacePath(workspaceRoot, rel);
      const maxMatches = typeof input.maxMatches === "number" && Number.isFinite(input.maxMatches)
        ? Math.max(1, Math.min(Math.floor(input.maxMatches), 200))
        : 50;
      const command = `rg -n --hidden --max-count ${maxMatches} ${JSON.stringify(pattern)} ${JSON.stringify(abs)}`;
      const result = await runShell(command, workspaceRoot, 20_000);
      const merged = [
        `exit: ${result.code ?? "null"} signal: ${result.signal ?? "none"}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
      ].filter(Boolean).join("\n\n");
      return summarize(merged);
    },

    "memory.read": async (input) => {
      const scope = normalizeScope(input);
      const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : undefined;
      const entries = await memory.read({ scope, limit });
      return summarize(entries);
    },

    "memory.search": async (input) => {
      const scope = normalizeScope(input);
      const query = typeof input.query === "string" ? input.query : "";
      const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : undefined;
      const entries = await memory.search({ scope, query, limit });
      return summarize(entries);
    },

    "memory.summarize": async (input) => {
      const scope = normalizeScope(input);
      const query = typeof input.query === "string" ? input.query : undefined;
      const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : undefined;
      const localMaxChars = typeof input.maxChars === "number" && Number.isFinite(input.maxChars)
        ? input.maxChars
        : undefined;
      const summary = await memory.summarize({ scope, query, limit, maxChars: localMaxChars });
      return summarize(summary);
    },

    "memory.commit": async (input) => {
      const scope = normalizeScope(input);
      const text = typeof input.text === "string" ? input.text : "";
      const tags = Array.isArray(input.tags)
        ? input.tags.filter((tag): tag is string => typeof tag === "string")
        : undefined;
      const entry = await memory.commit({ scope, text, tags });
      return summarize(entry);
    },

    "memory.diff": async (input) => {
      const scope = normalizeScope(input);
      const fromTs = typeof input.fromTs === "number" && Number.isFinite(input.fromTs)
        ? input.fromTs
        : Number.NaN;
      if (!Number.isFinite(fromTs)) throw new Error("memory.diff.fromTs is required");
      const toTs = typeof input.toTs === "number" && Number.isFinite(input.toTs) ? input.toTs : undefined;
      const entries = await memory.diff({ scope, fromTs, toTs });
      return summarize(entries);
    },

    "skill.read": async (input) => {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name) throw new Error("skill.read.name is required");
      const spec = toolSpecs[name];
      if (!spec) throw new Error(`unknown tool '${name}'`);
      return summarize(`${name}: ${spec}`);
    },

    ...opts.delegationTools,
  };

  const mergedTools = {
    ...builtins,
    ...(opts.extraTools ?? {}),
  } as Readonly<Record<string, AgentToolExecutor>>;
  const allow = opts.toolAllowlist?.length ? new Set(opts.toolAllowlist) : undefined;
  if (!allow) {
    return {
      toolSpecs,
      tools: mergedTools,
    };
  }
  const filteredToolSpecs = Object.fromEntries(Object.entries(toolSpecs).filter(([name]) => allow.has(name)));
  const filteredTools = Object.fromEntries(Object.entries(mergedTools).filter(([name]) => allow.has(name)));
  return {
    toolSpecs: filteredToolSpecs,
    tools: filteredTools as Readonly<Record<string, AgentToolExecutor>>,
  };
};

export const runAgent = async (input: AgentRunInput): Promise<AgentRunResult> => {
  const now = input.now ?? Date.now;
  const baseStream = input.stream;
  const runStream = input.runStream ?? agentRunStream(baseStream, input.runId);
  const model = input.model;
  const prompts = input.prompts;
  const control = input.control;
  const resolvedWorkspaceRoot = path.resolve(
    path.isAbsolute(input.config.workspace)
      ? input.config.workspace
      : path.join(input.workspaceRoot, input.config.workspace)
  );
  const { tools, toolSpecs } = createTools({
    workspaceRoot: resolvedWorkspaceRoot,
    defaultMemoryScope: input.config.memoryScope,
    maxToolOutputChars: input.config.maxToolOutputChars,
    memoryTools: input.memoryTools,
    delegationTools: input.delegationTools,
    extraToolSpecs: input.extraToolSpecs,
    extraTools: input.extraTools,
    toolAllowlist: input.toolAllowlist,
  });
  const workflowId = input.workflowId ?? AGENT_WORKFLOW_ID;
  const workflowVersion = input.workflowVersion ?? AGENT_WORKFLOW_VERSION;
  const availableTools = Object.keys(toolSpecs).sort();
  const toolHelp = availableTools.map((name) => `- ${name}: ${toolSpecs[name]}`).join("\n");

  const emitRun = createQueuedEmitter({
    runtime: input.runtime,
    stream: runStream,
    wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as AgentCmd),
    onEmit: () => input.broadcast?.(),
    onError: (err) => console.error("agent emit failed", err),
  });
  const emitIndex = createQueuedEmitter({
    runtime: input.runtime,
    stream: baseStream,
    wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as AgentCmd),
    onError: (err) => console.error("agent index emit failed", err),
  });

  const emit = async (event: AgentEvent, index = false): Promise<void> => {
    await emitRun(event);
    if (index) await emitIndex(event);
  };

  const emitFailure = async (failure: FailureRecord, index = true): Promise<void> => {
    await emit({
      type: "failure.report",
      runId: input.runId,
      agentId: "orchestrator",
      failure,
    }, index);
  };

  const finalizeResult = async (): Promise<AgentRunResult> => {
    const state = await input.runtime.state(runStream);
    return buildAgentRunResult({
      runId: input.runId,
      stream: baseStream,
      runStream,
      state,
    });
  };

  const checkAbort = async (stage: string): Promise<boolean> => {
    if (!control?.checkAbort) return false;
    const aborted = await control.checkAbort();
    if (!aborted) return false;
    await emitFailure({
      stage: "runtime",
      failureClass: "canceled",
      message: `canceled at ${stage}`,
      retryable: true,
    });
    await emit({
      type: "run.status",
      runId: input.runId,
      status: "failed",
      agentId: "orchestrator",
      note: `canceled at ${stage}`,
    }, true);
    return true;
  };

  try {
    let problem = input.problem.trim();
    let maxIterations = input.config.maxIterations;
    let memoryScope = input.config.memoryScope;
    let finalized = false;

    if (!fs.existsSync(resolvedWorkspaceRoot)) {
      await emitFailure({
        stage: "runtime",
        failureClass: "workspace_missing",
        message: `workspace does not exist: ${resolvedWorkspaceRoot}`,
        retryable: false,
      });
      await emit({
        type: "run.status",
        runId: input.runId,
        status: "failed",
        agentId: "orchestrator",
        note: `workspace does not exist: ${resolvedWorkspaceRoot}`,
      }, true);
      return finalizeResult();
    }

    await emit({
      type: "problem.set",
      runId: input.runId,
      problem,
      agentId: "orchestrator",
    }, true);
    await emit({
      type: "run.configured",
      runId: input.runId,
      agentId: "orchestrator",
      workflow: { id: workflowId, version: workflowVersion },
      config: {
        maxIterations: input.config.maxIterations,
        maxToolOutputChars: input.config.maxToolOutputChars,
        memoryScope: input.config.memoryScope,
        workspace: input.config.workspace,
        extra: input.extraConfig,
      },
      model,
      promptHash: input.promptHash,
      promptPath: input.promptPath,
    }, true);
    for (const event of input.startupEvents ?? []) {
      await emit(event, true);
    }

    if (!input.apiReady) {
      await emitFailure({
        stage: "runtime",
        failureClass: "api_unavailable",
        message: input.apiNote ?? "OPENAI_API_KEY not set",
        retryable: false,
      });
      await emit({
        type: "run.status",
        runId: input.runId,
        status: "failed",
        agentId: "orchestrator",
        note: input.apiNote ?? "OPENAI_API_KEY not set",
      }, true);
      return finalizeResult();
    }

    await emit({
      type: "run.status",
      runId: input.runId,
      status: "running",
      agentId: "orchestrator",
    }, true);

    const applyControlCommands = async (): Promise<void> => {
      if (!control?.pullCommands) return;
      const commands = await control.pullCommands();
      for (const command of commands) {
        const payload = command.payload ?? {};
        if (typeof payload.problem === "string" && payload.problem.trim().length > 0) {
          problem = payload.problem.trim();
          await emit({
            type: "problem.set",
            runId: input.runId,
            agentId: "orchestrator",
            problem,
          }, true);
        }
        if (typeof payload.note === "string" && payload.note.trim().length > 0) {
          problem = `${problem}\n\nFollow-up:\n${payload.note.trim()}`.trim();
          await emit({
            type: "problem.set",
            runId: input.runId,
            agentId: "orchestrator",
            problem,
          }, true);
        }
        if (typeof payload.config === "object" && payload.config) {
          const config = normalizeAgentConfig(payload.config as Partial<AgentRunConfig>);
          maxIterations = config.maxIterations;
          memoryScope = config.memoryScope;
          await emit({
            type: "config.updated",
            runId: input.runId,
            agentId: "orchestrator",
            config: {
              maxIterations,
              memoryScope,
            },
          }, true);
        }
      }
    };

    let lastFlushedIteration = 0;

    const flushMemoryBeforeCompaction = async (iteration: number): Promise<void> => {
      if (iteration <= lastFlushedIteration) return;
      lastFlushedIteration = iteration;
      const chain = await input.runtime.chain(runStream);
      const recentTranscript = deriveTranscriptLines(chain, 4).join("\n---\n");
      if (!recentTranscript.trim()) return;
      const flushText = `[auto-flush iteration=${iteration}] ${recentTranscript}`;
      await input.memoryTools.commit({
        scope: memoryScope,
        text: flushText,
        tags: ["auto-flush", "pre-compaction"],
      });
      await emit({
        type: "memory.flushed",
        runId: input.runId,
        iteration,
        agentId: "orchestrator",
        scope: memoryScope,
        chars: flushText.length,
      });
    };

    const applyContextPolicy = async (iteration: number, promptText: string): Promise<string> => {
      const HARD_THRESHOLD = 50_000;
      const SOFT_THRESHOLD = 14_000;
      const COMPACT_THRESHOLD = 20_000;
      let next = promptText;
      if (next.length > HARD_THRESHOLD) {
        const before = next.length;
        next = "[Context pruned due to size. Continue with concise steps.]";
        await emit({
          type: "context.pruned",
          runId: input.runId,
          iteration,
          agentId: "orchestrator",
          mode: "hard",
          before,
          after: next.length,
          note: "hard clear applied",
        });
      } else if (next.length > SOFT_THRESHOLD) {
        const before = next.length;
        next = softTrim(next, 5_000, 3_500);
        await emit({
          type: "context.pruned",
          runId: input.runId,
          iteration,
          agentId: "orchestrator",
          mode: "soft",
          before,
          after: next.length,
          note: "soft trim applied",
        });
      }

      if (next.length > COMPACT_THRESHOLD) {
        await flushMemoryBeforeCompaction(iteration);
        const before = next.length;
        next = compactPrompt(next, 11_000);
        await emit({
          type: "context.compacted",
          runId: input.runId,
          iteration,
          agentId: "orchestrator",
          reason: "threshold",
          before,
          after: next.length,
          note: "pre-call compaction",
        });
      }
      return next;
    };

    const llmStructuredCall = async (
      iteration: number,
      user: string
    ): Promise<{ readonly parsed: ParsedAction; readonly raw: string }> => {
      if (await checkAbort(`iteration-${iteration}.before_llm`)) {
        throw new Error(`canceled at iteration-${iteration}.before_llm`);
      }
      const promptText = await applyContextPolicy(iteration, user);
      const invoke = (promptUser: string) => input.llmStructured({
        system: prompts.system,
        user: promptUser,
        schema: structuredAgentActionSchema,
        schemaName: "agent_action",
      });

      const parseResult = (result: { readonly parsed: StructuredAgentAction; readonly raw: string }) => ({
        parsed: normalizeStructuredAction(result.parsed),
        raw: result.raw,
      });

      try {
        const result = await invoke(promptText);
        if (await checkAbort(`iteration-${iteration}.after_llm`)) {
          throw new Error(`canceled at iteration-${iteration}.after_llm`);
        }
        return parseResult(result);
      } catch (err) {
        if (isStructuredInputParseError(err)) {
          const repairedPrompt = [
            promptText,
            "",
            "Correction: for tool actions, set action.input to a valid JSON object encoded as a string. Do not wrap it in prose or markdown.",
          ].join("\n");
          const repaired = await invoke(repairedPrompt);
          if (await checkAbort(`iteration-${iteration}.after_json_retry`)) {
            throw new Error(`canceled at iteration-${iteration}.after_json_retry`);
          }
          return parseResult(repaired);
        }
        if (!isContextOverflow(err)) throw err;
        const compacted = compactPrompt(promptText, 8_000);
        await emit({
          type: "context.compacted",
          runId: input.runId,
          iteration,
          agentId: "orchestrator",
          reason: "overflow",
          before: promptText.length,
          after: compacted.length,
          note: "retry after overflow",
        });
        await emit({
          type: "overflow.recovered",
          runId: input.runId,
          iteration,
          agentId: "orchestrator",
          note: "recovered by compacting prompt and retrying once",
        });
        const result = await invoke(compacted);
        if (await checkAbort(`iteration-${iteration}.after_overflow_retry`)) {
          throw new Error(`canceled at iteration-${iteration}.after_overflow_retry`);
        }
        return parseResult(result);
      }
    };

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      await applyControlCommands();
      if (await checkAbort(`iteration-${iteration}.start`)) return finalizeResult();

      await emit({
        type: "iteration.started",
        runId: input.runId,
        iteration,
        agentId: "orchestrator",
      });

      const memorySummary = await input.memoryTools.summarize({
        scope: memoryScope,
        query: problem,
        limit: 8,
        maxChars: 1_600,
      });
      await emit({
        type: "memory.slice",
        runId: input.runId,
        iteration,
        agentId: "orchestrator",
        scope: memoryScope,
        query: problem,
        chars: memorySummary.summary.length,
        itemCount: memorySummary.entries.length,
        truncated: memorySummary.summary.length >= 1_600,
      });

      const chain = await input.runtime.chain(runStream);
      const transcriptText = deriveTranscriptLines(chain, 12).join("\n\n");
      const prompt = renderPrompt(prompts.user.loop, {
        problem,
        iteration: String(iteration),
        maxIterations: String(maxIterations),
        workspace: resolvedWorkspaceRoot,
        transcript: transcriptText || "(no prior steps)",
        memory: memorySummary.summary || "(empty)",
        available_tools: availableTools.join(", "),
        tool_help: toolHelp || "(no tools available)",
      });

      let raw = "";
      let parsed: ParsedAction | undefined;
      let parseError = "";
      try {
        const structured = await llmStructuredCall(iteration, prompt);
        raw = structured.raw;
        parsed = structured.parsed;
        await emit({
          type: "validation.report",
          runId: input.runId,
          iteration,
          agentId: "orchestrator",
          gate: "model_json",
          ok: true,
          summary: "native structured action parsed",
        });
      } catch (err) {
        parseError = err instanceof Error ? err.message : String(err);
        await emit({
          type: "validation.report",
          runId: input.runId,
          iteration,
          agentId: "orchestrator",
          gate: "model_json",
          ok: false,
          summary: `native structured action failed: ${parseError}`,
        });
      }
      if (!parsed) {
        throw new TerminalAgentFailure({
          stage: "model_json",
          failureClass: "model_json_parse",
          message: parseError || "Failed to parse model structured output",
          details: compactRawModelOutput(raw),
          retryable: true,
          iteration,
        });
      }

      await emit({
        type: "thought.logged",
        runId: input.runId,
        iteration,
        agentId: "orchestrator",
        content: parsed.thought,
      });

      if (parsed.actionType === "final") {
        await emit({
          type: "action.planned",
          runId: input.runId,
          iteration,
          agentId: "orchestrator",
          actionType: "final",
        });

        let finalText = parsed.text.trim() || "Completed.";
        if (input.finalizer) {
          const result = await input.finalizer({
            runId: input.runId,
            runStream,
            iteration,
            text: finalText,
            problem,
            workspaceRoot: resolvedWorkspaceRoot,
            emit,
            runtime: input.runtime,
            now,
          });
          if (result.text?.trim()) {
            finalText = result.text.trim();
          }
          if (!result.accept) {
            await emit({
              type: "validation.report",
              runId: input.runId,
              iteration,
              agentId: "orchestrator",
              gate: "finalizer",
              ok: false,
              summary: result.note?.trim() || "finalization rejected",
            });
            continue;
          }
        }

        await emit({
          type: "response.finalized",
          runId: input.runId,
          agentId: "orchestrator",
          content: finalText,
        }, true);
        await emit({
          type: "run.status",
          runId: input.runId,
          status: "completed",
          agentId: "orchestrator",
        }, true);
        await input.memoryTools.commit({
          scope: memoryScope,
          text: `run ${input.runId} completed: ${truncateText(finalText, 800).text}`,
          tags: ["agent", "final"],
          meta: { runId: input.runId, ts: now() },
        });
        finalized = true;
        break;
      }

      await emit({
        type: "action.planned",
        runId: input.runId,
        iteration,
        agentId: "orchestrator",
        actionType: "tool",
        name: parsed.name,
        input: parsed.input,
      });

      const knownTool = parsed.name as AgentToolName;
      const executor = tools[knownTool];
      if (!executor) {
        const message = `unknown tool '${parsed.name}'`;
        await emit({
          type: "tool.called",
          runId: input.runId,
          iteration,
          agentId: "orchestrator",
          tool: parsed.name,
          input: parsed.input,
          summary: "failed",
          error: message,
        });
        continue;
      }

      const started = now();
      try {
        const result = await executor(parsed.input);
        await emit({
          type: "tool.called",
          runId: input.runId,
          iteration,
          agentId: "orchestrator",
          tool: parsed.name,
          input: parsed.input,
          summary: result.summary,
          durationMs: now() - started,
        });
        const clipped = truncateText(result.output, input.config.maxToolOutputChars);
        await emit({
          type: "tool.observed",
          runId: input.runId,
          iteration,
          agentId: "orchestrator",
          tool: parsed.name,
          output: clipped.text,
          truncated: clipped.truncated,
        });
        for (const event of result.events ?? []) {
          await emit(event, true);
        }
        for (const report of result.reports ?? []) {
          await emit({
            type: "validation.report",
            runId: input.runId,
            iteration,
            agentId: "orchestrator",
            ...report,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await emit({
          type: "tool.called",
          runId: input.runId,
          iteration,
          agentId: "orchestrator",
          tool: parsed.name,
          input: parsed.input,
          summary: "failed",
          durationMs: now() - started,
          error: message,
        });
      }
    }

    if (!finalized) {
      const continuation = await input.onIterationBudgetExhausted?.({
        runId: input.runId,
        runStream,
        problem,
        config: {
          maxIterations,
          maxToolOutputChars: input.config.maxToolOutputChars,
          memoryScope,
          workspace: input.config.workspace,
        },
        runtime: input.runtime,
        now,
      });
      if (continuation) {
        for (const event of continuation.events ?? []) {
          await emit(event, true);
        }
        const finalText = continuation.finalText.trim() || `Reached the current ${maxIterations}-step slice.`;
        await emit({
          type: "response.finalized",
          runId: input.runId,
          agentId: "orchestrator",
          content: finalText,
        }, true);
        await emit({
          type: "run.status",
          runId: input.runId,
          status: "completed",
          agentId: "orchestrator",
          note: continuation.note?.trim() || `slice completed after ${maxIterations} iterations`,
        }, true);
        await input.memoryTools.commit({
          scope: memoryScope,
          text: `run ${input.runId} continued: ${truncateText(finalText, 800).text}`,
          tags: ["agent", "final", "continued"],
          meta: { runId: input.runId, ts: now(), continued: true },
        });
        finalized = true;
      }
    }

    if (!finalized) {
      await emitFailure({
        stage: "budget",
        failureClass: "iteration_budget_exhausted",
        message: `iteration budget exhausted (${maxIterations})`,
        retryable: true,
      }, true);
      await emit({
        type: "run.status",
        runId: input.runId,
        status: "failed",
        agentId: "orchestrator",
        note: `iteration budget exhausted (${maxIterations})`,
      }, true);
      await emit({
        type: "response.finalized",
        runId: input.runId,
        agentId: "orchestrator",
        content: "Stopped after hitting max iterations. Use steer/follow-up to continue.",
      }, true);
    }
  } catch (err) {
    if (!(err instanceof TerminalAgentFailure)) {
      console.error(err);
    }
    const failure: FailureRecord = err instanceof TerminalAgentFailure
      ? err.failure
      : {
          stage: "runtime",
          failureClass: "runtime_error",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        };
    await emitFailure(failure, true);
    await emit({
      type: "run.status",
      runId: input.runId,
      status: "failed",
      agentId: "orchestrator",
      note: failure.message,
    }, true);
  }
  return finalizeResult();
};
