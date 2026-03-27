import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import type { ZodTypeAny } from "zod";

import type { DelegationTools } from "../adapters/delegation";
import type { MemoryTools } from "../adapters/memory-tools";
import {
  capabilityDefinition,
  capabilityDescriptions,
  capabilityInput,
  createCapabilitySpec,
  type AgentCapabilitySpec,
  type AgentToolResult,
} from "./capabilities-shared";

const clipText = (
  input: string,
  limit: number,
): { readonly text: string; readonly truncated: boolean } => {
  if (input.length <= limit) return { text: input, truncated: false };
  if (limit <= 3) return { text: input.slice(0, limit), truncated: true };
  return {
    text: `${input.slice(0, limit - 3)}...`,
    truncated: true,
  };
};

const resolveWorkspacePath = (root: string, rawPath: string): string => {
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, rawPath);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`path escapes workspace: ${rawPath}`);
  }
  return resolved;
};

const runShell = async (
  cmd: string,
  cwd: string,
  timeoutMs: number,
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

const parseLineNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : undefined;

const blockedBashCommand = (cmd: string): string | undefined => {
  const normalized = cmd.replace(/\s+/g, " ").trim();
  if (/\bgit\s+checkout\s+--(?:\s|$)/.test(normalized)) {
    return "bash command blocked: destructive git checkout -- is not allowed; use read/replace/write for file edits";
  }
  if (/\bgit\s+restore\b/.test(normalized)) {
    return "bash command blocked: destructive git restore is not allowed; use read/replace/write for file edits";
  }
  if (/\bgit\s+reset\s+--hard\b/.test(normalized)) {
    return "bash command blocked: destructive git reset --hard is not allowed";
  }
  if (/\bgit\s+clean\b/.test(normalized)) {
    return "bash command blocked: destructive git clean is not allowed";
  }
  return undefined;
};

const delegationInputSchemaForId = (id: string): ZodTypeAny =>
  id === "agent.delegate"
    ? capabilityInput.agentDelegate
    : id === "agent.status"
      ? capabilityInput.agentStatus
      : id === "agent.inspect"
        ? capabilityInput.agentInspect
        : capabilityInput.empty;

const delegationDescriptionForId = (id: string): string =>
  capabilityDescriptions[id as keyof typeof capabilityDescriptions] ?? "{} — Execute the delegated tool.";

export const agentDelegateCapability = capabilityDefinition({
  id: "agent.delegate",
  description: capabilityDescriptions["agent.delegate"],
  inputSchema: capabilityInput.agentDelegate,
});

export const agentStatusCapability = capabilityDefinition({
  id: "agent.status",
  description: capabilityDescriptions["agent.status"],
  inputSchema: capabilityInput.agentStatus,
});

export const agentInspectCapability = capabilityDefinition({
  id: "agent.inspect",
  description: capabilityDescriptions["agent.inspect"],
  inputSchema: capabilityInput.agentInspect,
});

export const createBuiltinAgentCapabilities = (opts: {
  readonly workspaceRoot: string;
  readonly defaultMemoryScope: string;
  readonly maxToolOutputChars: number;
  readonly memoryTools: MemoryTools;
  readonly delegationTools: DelegationTools;
  readonly memoryAuditMeta?: Readonly<Record<string, unknown>>;
}): ReadonlyArray<AgentCapabilitySpec> => {
  const workspaceRoot = path.resolve(opts.workspaceRoot);
  const defaultScope = opts.defaultMemoryScope;
  const maxChars = opts.maxToolOutputChars;
  const memory = opts.memoryTools;

  const normalizeScope = (input: { readonly scope?: string }): string =>
    typeof input.scope === "string" && input.scope.trim().length > 0 ? input.scope.trim() : defaultScope;

  const summarize = (value: unknown): AgentToolResult => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const clipped = clipText(text, maxChars);
    const summaryLine = clipped.text.split("\n")[0] ?? "";
    return {
      output: clipped.text,
      summary: clipped.truncated ? `${summaryLine} (truncated)` : summaryLine,
    };
  };

  return [
    createCapabilitySpec(
      capabilityDefinition({
        id: "ls",
        description: capabilityDescriptions.ls,
        inputSchema: capabilityInput.listDir,
      }),
      async (input) => {
        const rel = typeof input.path === "string" && input.path.trim().length > 0 ? input.path.trim() : ".";
        const abs = resolveWorkspacePath(workspaceRoot, rel);
        const entries = await fs.promises.readdir(abs, { withFileTypes: true });
        const listing = entries
          .slice(0, 500)
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .join("\n");
        return summarize(listing || "(empty directory)");
      },
    ),
    createCapabilitySpec(
      capabilityDefinition({
        id: "read",
        description: capabilityDescriptions.read,
        inputSchema: capabilityInput.readFile,
      }),
      async (input) => {
        const rawPath = typeof input.path === "string" ? input.path.trim() : "";
        if (!rawPath) throw new Error("read.path is required");
        const abs = resolveWorkspacePath(workspaceRoot, rawPath);
        const raw = await fs.promises.readFile(abs);
        if (raw.includes(0)) throw new Error("binary file not supported by read tool");
        const text = raw.toString("utf-8");
        const startLine = parseLineNumber(input.startLine) ?? parseLineNumber(input.start) ?? 1;
        const endLine = parseLineNumber(input.endLine) ?? parseLineNumber(input.end) ?? Number.MAX_SAFE_INTEGER;
        const normalizedEndLine = Math.max(startLine, endLine);
        const lines = text.split("\n");
        const sliced = lines.slice(startLine - 1, normalizedEndLine).join("\n");
        const localLimit = typeof input.maxChars === "number" && Number.isFinite(input.maxChars)
          ? Math.max(100, Math.min(Math.floor(input.maxChars), maxChars))
          : maxChars;
        return summarize(clipText(sliced, localLimit).text);
      },
    ),
    createCapabilitySpec(
      capabilityDefinition({
        id: "replace",
        description: capabilityDescriptions.replace,
        inputSchema: capabilityInput.replaceFile,
      }),
      async (input) => {
        const rawPath = typeof input.path === "string" ? input.path.trim() : "";
        const find = typeof input.find === "string" ? input.find : "";
        const replace = typeof input.replace === "string" ? input.replace : "";
        if (!rawPath) throw new Error("replace.path is required");
        if (!find) throw new Error("replace.find is required");
        const abs = resolveWorkspacePath(workspaceRoot, rawPath);
        const current = await fs.promises.readFile(abs, "utf-8");
        if (!current.includes(find)) {
          throw new Error(`replace.find not found in ${rawPath}`);
        }
        let count = 0;
        const next = input.all === true
          ? current.replaceAll(find, () => {
              count += 1;
              return replace;
            })
          : current.replace(find, () => {
              count += 1;
              return replace;
            });
        await fs.promises.writeFile(abs, next, "utf-8");
        return summarize(`replaced ${count} occurrence${count === 1 ? "" : "s"} in ${rawPath}`);
      },
    ),
    createCapabilitySpec(
      capabilityDefinition({
        id: "write",
        description: capabilityDescriptions.write,
        inputSchema: capabilityInput.writeFile,
      }),
      async (input) => {
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
    ),
    createCapabilitySpec(
      capabilityDefinition({
        id: "bash",
        description: capabilityDescriptions.bash,
        inputSchema: capabilityInput.bash,
      }),
      async (input) => {
        const cmd = typeof input.cmd === "string" ? input.cmd.trim() : "";
        if (!cmd) throw new Error("bash.cmd is required");
        const blocked = blockedBashCommand(cmd);
        if (blocked) throw new Error(blocked);
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
    ),
    createCapabilitySpec(
      capabilityDefinition({
        id: "grep",
        description: capabilityDescriptions.grep,
        inputSchema: capabilityInput.grep,
      }),
      async (input) => {
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
    ),
    createCapabilitySpec(
      capabilityDefinition({
        id: "memory.read",
        description: capabilityDescriptions["memory.read"],
        inputSchema: capabilityInput.memoryRead,
      }),
      async (input) => {
        const scope = normalizeScope(input);
        const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : undefined;
        const entries = await memory.read({
          scope,
          limit,
          audit: {
            ...(opts.memoryAuditMeta ?? {}),
            tool: "memory.read",
          },
        });
        return summarize(entries);
      },
    ),
    createCapabilitySpec(
      capabilityDefinition({
        id: "memory.search",
        description: capabilityDescriptions["memory.search"],
        inputSchema: capabilityInput.memorySearch,
      }),
      async (input) => {
        const scope = normalizeScope(input);
        const query = typeof input.query === "string" ? input.query : "";
        const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : undefined;
        const entries = await memory.search({
          scope,
          query,
          limit,
          audit: {
            ...(opts.memoryAuditMeta ?? {}),
            tool: "memory.search",
          },
        });
        return summarize(entries);
      },
    ),
    createCapabilitySpec(
      capabilityDefinition({
        id: "memory.summarize",
        description: capabilityDescriptions["memory.summarize"],
        inputSchema: capabilityInput.memorySummarize,
      }),
      async (input) => {
        const scope = normalizeScope(input);
        const query = typeof input.query === "string" ? input.query : undefined;
        const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : undefined;
        const localMaxChars = typeof input.maxChars === "number" && Number.isFinite(input.maxChars)
          ? input.maxChars
          : undefined;
        const summary = await memory.summarize({
          scope,
          query,
          limit,
          maxChars: localMaxChars,
          audit: {
            ...(opts.memoryAuditMeta ?? {}),
            tool: "memory.summarize",
          },
        });
        return summarize(summary);
      },
    ),
    createCapabilitySpec(
      capabilityDefinition({
        id: "memory.commit",
        description: capabilityDescriptions["memory.commit"],
        inputSchema: capabilityInput.memoryCommit,
      }),
      async (input) => {
        const scope = normalizeScope(input);
        const text = typeof input.text === "string" ? input.text : "";
        const tags = Array.isArray(input.tags)
          ? input.tags.filter((tag): tag is string => typeof tag === "string")
          : undefined;
        const entry = await memory.commit({
          scope,
          text,
          tags,
          meta: {
            ...(opts.memoryAuditMeta ?? {}),
            tool: "memory.commit",
          },
        });
        return summarize(entry);
      },
    ),
    createCapabilitySpec(
      capabilityDefinition({
        id: "memory.diff",
        description: capabilityDescriptions["memory.diff"],
        inputSchema: capabilityInput.memoryDiff,
      }),
      async (input) => {
        const scope = normalizeScope(input);
        const fromTs = typeof input.fromTs === "number" && Number.isFinite(input.fromTs)
          ? input.fromTs
          : Number.NaN;
        if (!Number.isFinite(fromTs)) throw new Error("memory.diff.fromTs is required");
        const toTs = typeof input.toTs === "number" && Number.isFinite(input.toTs) ? input.toTs : undefined;
        const entries = await memory.diff({
          scope,
          fromTs,
          toTs,
          audit: {
            ...(opts.memoryAuditMeta ?? {}),
            tool: "memory.diff",
          },
        });
        return summarize(entries);
      },
    ),
    ...Object.entries(opts.delegationTools).map(([id, execute]) => createCapabilitySpec(
      capabilityDefinition({
        id,
        description: delegationDescriptionForId(id),
        inputSchema: delegationInputSchemaForId(id),
      }),
      async (input) => execute(input as Record<string, unknown>),
    )),
    createCapabilitySpec(
      capabilityDefinition({
        id: "skill.read",
        description: capabilityDescriptions["skill.read"],
        inputSchema: capabilityInput.skillRead,
      }),
      async (input, context) => {
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (!name) throw new Error("skill.read.name is required");
        const description = context.registry.describe(name);
        if (!description) throw new Error(`unknown tool '${name}'`);
        return summarize(`${name}: ${description}`);
      },
    ),
  ];
};
