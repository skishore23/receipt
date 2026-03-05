// ============================================================================
// Agent - think/act/observe loop for Receipt
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import type { Chain } from "../core/types.js";
import type { Runtime } from "../core/runtime.js";
import { clampNumber, parseFormNum, type AgentRunControl, createQueuedEmitter, getLatestRunId } from "../engine/runtime/workflow.js";
import type { MemoryTools } from "../adapters/memory-tools.js";
import type { AgentCmd, AgentEvent, AgentState, AgentToolName } from "../modules/agent.js";
import { agentRunStream } from "./agent.streams.js";
import type { DelegationTools } from "../adapters/delegation.js";
import type { AgentPromptConfig } from "../prompts/agent.js";
import { renderPrompt } from "../prompts/agent.js";

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

export type AgentRunInput = {
  readonly stream: string;
  readonly runId: string;
  readonly runStream?: string;
  readonly problem: string;
  readonly config: AgentRunConfig;
  readonly runtime: Runtime<AgentCmd, AgentEvent, AgentState>;
  readonly prompts: AgentPromptConfig;
  readonly llmText: (opts: { system?: string; user: string }) => Promise<string>;
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
};

type ToolResult = {
  readonly output: string;
  readonly summary: string;
};

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

const extractJsonObject = (text: string): string | undefined => {
  const direct = text.trim();
  if (direct.startsWith("{") && direct.endsWith("}")) return direct;

  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1]
    ?? text.match(/```\s*([\s\S]*?)```/)?.[1];
  if (fenced) return fenced.trim();

  let start = text.indexOf("{");
  while (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    start = text.indexOf("{", start + 1);
  }
  return undefined;
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
      default:
        break;
    }
  }
  if (lines.length <= limit) return lines;
  return lines.slice(lines.length - limit);
};

const parseModelAction = (raw: string): ParsedAction => {
  const candidate = extractJsonObject(raw);
  if (!candidate) {
    throw new Error("Model returned unstructured output");
  }

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const thought = typeof parsed.thought === "string"
      ? parsed.thought.trim()
      : "No thought provided.";
    const action = typeof parsed.action === "object" && parsed.action
      ? parsed.action as Record<string, unknown>
      : {};
    const actionType = action.type === "tool" || action.type === "final" ? action.type : undefined;
    if (!actionType) {
      throw new Error("Model action.type must be 'tool' or 'final'");
    }
    if (actionType === "final") {
      const text = typeof action.text === "string"
        ? action.text
        : typeof parsed.final === "string"
          ? parsed.final
          : undefined;
      if (!text || !text.trim()) {
        throw new Error("Model final action missing text");
      }
      return {
        thought,
        actionType: "final",
        text: text.trim(),
      };
    }
    const name = typeof action.name === "string" ? action.name.trim() : "";
    const input = typeof action.input === "object" && action.input && !Array.isArray(action.input)
      ? action.input as Record<string, unknown>
      : {};
    if (!name) throw new Error("Model tool action missing name");
    return {
      thought,
      actionType: "tool",
      name,
      input,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse model JSON output: ${message}`);
  }
};

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

const TOOL_SPECS: Record<AgentToolName, string> = {
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
  "agent.delegate": '{"agentId": string, "task": string, "config"?: object, "timeoutMs"?: number} — Delegate a sub-task to a specialized agent (theorem, writer, agent, inspector). Blocks until complete or timeout.',
  "agent.status": '{"jobId": string} — Check status and result of a previously delegated job.',
  "agent.inspect": '{"file": string, "maxChars"?: number} — Read a receipt chain file to inspect another agent\'s event history.',
  "skill.read": '{"name": string} — Get the full parameter spec for any tool by name.',
};

const createTools = (opts: {
  readonly workspaceRoot: string;
  readonly defaultMemoryScope: string;
  readonly maxToolOutputChars: number;
  readonly memoryTools: MemoryTools;
  readonly delegationTools: DelegationTools;
}): Record<AgentToolName, (input: Record<string, unknown>) => Promise<ToolResult>> => {
  const workspaceRoot = path.resolve(opts.workspaceRoot);
  const defaultScope = opts.defaultMemoryScope;
  const maxChars = opts.maxToolOutputChars;
  const memory = opts.memoryTools;

  const normalizeScope = (input: Record<string, unknown>): string => {
    if (typeof input.scope === "string" && input.scope.trim().length > 0) return input.scope.trim();
    return defaultScope;
  };

  const summarize = (value: unknown): ToolResult => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const clipped = truncateText(text, maxChars);
    const summaryLine = clipped.text.split("\n")[0] ?? "";
    return {
      output: clipped.text,
      summary: clipped.truncated ? `${summaryLine} (truncated)` : summaryLine,
    };
  };

  return {
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
      const spec = TOOL_SPECS[name as AgentToolName];
      if (!spec) throw new Error(`unknown tool '${name}'`);
      return summarize(`${name}: ${spec}`);
    },

    ...opts.delegationTools,
  };
};

export const runAgent = async (input: AgentRunInput): Promise<void> => {
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
  const tools = createTools({
    workspaceRoot: resolvedWorkspaceRoot,
    defaultMemoryScope: input.config.memoryScope,
    maxToolOutputChars: input.config.maxToolOutputChars,
    memoryTools: input.memoryTools,
    delegationTools: input.delegationTools,
  });

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

  const checkAbort = async (stage: string): Promise<boolean> => {
    if (!control?.checkAbort) return false;
    const aborted = await control.checkAbort();
    if (!aborted) return false;
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
      await emit({
        type: "run.status",
        runId: input.runId,
        status: "failed",
        agentId: "orchestrator",
        note: `workspace does not exist: ${resolvedWorkspaceRoot}`,
      }, true);
      return;
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
      workflow: { id: AGENT_WORKFLOW_ID, version: AGENT_WORKFLOW_VERSION },
      config: {
        maxIterations: input.config.maxIterations,
        maxToolOutputChars: input.config.maxToolOutputChars,
        memoryScope: input.config.memoryScope,
        workspace: input.config.workspace,
      },
      model,
      promptHash: input.promptHash,
      promptPath: input.promptPath,
    }, true);

    if (!input.apiReady) {
      await emit({
        type: "run.status",
        runId: input.runId,
        status: "failed",
        agentId: "orchestrator",
        note: input.apiNote ?? "OPENAI_API_KEY not set",
      }, true);
      return;
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

    const llmCall = async (iteration: number, user: string): Promise<string> => {
      if (await checkAbort(`iteration-${iteration}.before_llm`)) {
        throw new Error(`canceled at iteration-${iteration}.before_llm`);
      }
      const promptText = await applyContextPolicy(iteration, user);
      try {
        const out = await input.llmText({ system: prompts.system, user: promptText });
        if (await checkAbort(`iteration-${iteration}.after_llm`)) {
          throw new Error(`canceled at iteration-${iteration}.after_llm`);
        }
        return out;
      } catch (err) {
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
        const out = await input.llmText({ system: prompts.system, user: compacted });
        if (await checkAbort(`iteration-${iteration}.after_overflow_retry`)) {
          throw new Error(`canceled at iteration-${iteration}.after_overflow_retry`);
        }
        return out;
      }
    };

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      await applyControlCommands();
      if (await checkAbort(`iteration-${iteration}.start`)) return;

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
      });

      const raw = await llmCall(iteration, prompt);
      const parsed = parseModelAction(raw);

      await emit({
        type: "thought.logged",
        runId: input.runId,
        iteration,
        agentId: "orchestrator",
        content: parsed.thought,
      });

      if (parsed.actionType === "final") {
        const finalText = parsed.text.trim() || "Completed.";
        await emit({
          type: "action.planned",
          runId: input.runId,
          iteration,
          agentId: "orchestrator",
          actionType: "final",
        });
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
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    await emit({
      type: "run.status",
      runId: input.runId,
      status: "failed",
      agentId: "orchestrator",
      note: message,
    }, true);
  }
};
