// ============================================================================
// Agent - think/act/observe loop for Receipt
// ============================================================================

import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { Chain } from "@receipt/core/types";
import type { Runtime } from "@receipt/core/runtime";
import { clampNumber, type AgentRunControl, createQueuedEmitter } from "../engine/runtime/workflow";
import type { MemoryTools } from "../adapters/memory-tools";
import type { AgentCmd, AgentEvent, AgentState } from "../modules/agent";
import type { FailureRecord } from "../modules/failure";
import { agentRunStream } from "./agent.streams";
import type { DelegationTools } from "../adapters/delegation";
import type { AgentPromptConfig } from "../prompts/agent";
import { renderPrompt } from "../prompts/agent";
import { buildAgentRunResult, type AgentRunResult } from "./agent.result";
import {
  AgentCapabilityRegistry,
  createBuiltinAgentCapabilities,
  type AgentCapabilitySpec,
} from "./capabilities";
import {
  loadConversationProjection,
  rememberUserPreferenceNotes,
  renderSessionRecallSummary,
} from "../services/conversation-memory";
import { repoKeyForRoot } from "../services/factory-chat-profiles";
import { runStructuredFunction } from "./structured-function";

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
    80
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



export type { AgentRunResult } from "./agent.result";

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
  readonly capabilities?: ReadonlyArray<AgentCapabilitySpec>;
  readonly toolAllowlist?: ReadonlyArray<string>;
  readonly promptContextBuilder?: (input: {
    readonly runId: string;
    readonly runStream: string;
    readonly iteration: number;
    readonly problem: string;
    readonly workspaceRoot: string;
    readonly transcript: string;
    readonly memorySummary: string;
  }) => Promise<Readonly<Record<string, string>> | undefined>;
  readonly startupEvents?: ReadonlyArray<AgentEvent>;
  readonly finalizer?: AgentFinalizer;
  readonly onIterationBudgetExhausted?: AgentIterationBudgetHandler;
  readonly onStructuredActionParsed?: (input: {
    readonly runId: string;
    readonly runStream: string;
    readonly iteration: number;
    readonly action: ParsedAction;
    readonly emit: (event: AgentEvent, index?: boolean) => Promise<void>;
  }) => Promise<void>;
};

export type AgentFinalizerResult = {
  readonly accept: boolean;
  readonly text?: string;
  readonly note?: string;
};

export type AgentIterationBudgetContinuation = {
  readonly finalText: string;
  readonly note?: string;
  readonly events?: ReadonlyArray<AgentEvent>;
  readonly nextRunId?: string;
  readonly nextJobId?: string;
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

export type AgentRunProgress = {
  readonly iterationsUsed: number;
  readonly toolCallsSucceeded: number;
  readonly toolCallsFailed: number;
  readonly distinctToolsUsed: number;
};

export const isStuckProgress = (progress: AgentRunProgress): boolean =>
  progress.toolCallsSucceeded === 0
  || (progress.toolCallsFailed > 0 && progress.toolCallsFailed >= progress.toolCallsSucceeded * 3);

export type AgentIterationBudgetHandler = (input: {
  readonly runId: string;
  readonly runStream: string;
  readonly problem: string;
  readonly config: AgentRunConfig;
  readonly runtime: Runtime<AgentCmd, AgentEvent, AgentState>;
  readonly now: () => number;
  readonly progress: AgentRunProgress;
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

const parseTimeoutMs = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const asTrimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const resolveStructuredDecisionTimeoutMs = (extraConfig?: Readonly<Record<string, unknown>>): number => {
  const configured = parseTimeoutMs(extraConfig?.structuredTimeoutMs)
    ?? parseTimeoutMs(process.env.RECEIPT_STRUCTURED_TIMEOUT_MS)
    ?? parseTimeoutMs(process.env.OPENAI_STRUCTURED_TIMEOUT_MS)
    ?? parseTimeoutMs(process.env.OPENAI_TIMEOUT_MS)
    ?? 60_000;
  return clampNumber(configured, 100, 300_000);
};

const withTimeout = async <T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> =>
  await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

type ParsedAction =
  | {
      readonly thought: string;
      readonly actionType: "final";
      readonly text: string;
      readonly preferenceNotes?: ReadonlyArray<string>;
    }
  | {
      readonly thought: string;
      readonly actionType: "tool";
      readonly name: string;
      readonly input: Record<string, unknown>;
      readonly preferenceNotes?: ReadonlyArray<string>;
    };

const structuredAgentActionSchema = z.object({
  thought: z.string(),
  action: z.object({
    type: z.enum(["tool", "final"]),
    name: z.string().nullable(),
    input: z.string(),
    text: z.string().nullable(),
  }).strict(),
  memory: z.object({
    preferenceNotes: z.array(z.string()).max(6).optional(),
  }).strict().optional(),
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
  const preferenceNotes = value.memory?.preferenceNotes
    ?.map((item) => item.trim())
    .filter((item, index, items) => item.length > 0 && items.indexOf(item) === index)
    .slice(0, 6);
  if (value.action.type === "final") {
    const text = value.action.text?.trim();
    if (!text) throw new Error("Model final action missing text");
    return {
      thought,
      actionType: "final",
      text,
      ...(preferenceNotes && preferenceNotes.length > 0 ? { preferenceNotes } : {}),
    };
  }
  const name = value.action.name?.trim();
  if (!name) throw new Error("Model tool action missing name");
  return {
    thought,
    actionType: "tool",
    name,
    input: normalizeStructuredInput((value.action as { input: unknown }).input),
    ...(preferenceNotes && preferenceNotes.length > 0 ? { preferenceNotes } : {}),
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

export const runAgent = async (input: AgentRunInput): Promise<AgentRunResult> => {
  const now = input.now ?? Date.now;
  const baseStream = input.stream;
  const runStream = input.runStream ?? agentRunStream(baseStream, input.runId);
  const model = input.model;
  const prompts = input.prompts;
  const control = input.control;
  const workflowId = input.workflowId ?? AGENT_WORKFLOW_ID;
  const workflowVersion = input.workflowVersion ?? AGENT_WORKFLOW_VERSION;
  const resolvedWorkspaceRoot = path.resolve(
    path.isAbsolute(input.config.workspace)
      ? input.config.workspace
      : path.join(input.workspaceRoot, input.config.workspace)
  );
  const repoKey = asTrimmedString(input.extraConfig?.repoKey)
    ?? (asTrimmedString(input.extraConfig?.repoRoot) ? repoKeyForRoot(asTrimmedString(input.extraConfig?.repoRoot)!) : undefined);
  const profileId = asTrimmedString(input.extraConfig?.profileId);
  const sessionStream = asTrimmedString(input.extraConfig?.stream)
    ?? (baseStream.includes("/sessions/") ? baseStream : undefined);
  const dataDir = asTrimmedString(input.extraConfig?.dataDir);
  const memoryAuditBase = {
    actor: "agent",
    runId: input.runId,
    stream: runStream,
    workflowId,
    workspace: resolvedWorkspaceRoot,
  } as const;
  const structuredDecisionTimeoutMs = resolveStructuredDecisionTimeoutMs(input.extraConfig);
  const capabilityRegistry = new AgentCapabilityRegistry({
    capabilities: [
      ...createBuiltinAgentCapabilities({
        workspaceRoot: resolvedWorkspaceRoot,
        defaultMemoryScope: input.config.memoryScope,
        maxToolOutputChars: input.config.maxToolOutputChars,
        memoryTools: input.memoryTools,
        delegationTools: input.delegationTools,
        memoryAuditMeta: memoryAuditBase,
        sessionHistoryDataDir: dataDir,
        sessionHistoryContext: {
          repoKey,
          profileId,
          sessionStream,
        },
      }),
      ...(input.capabilities ?? []),
    ],
    allowlist: input.toolAllowlist,
  });
  const availableTools = capabilityRegistry.ids();
  const toolHelp = capabilityRegistry.renderToolHelp();

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
        meta: {
          ...memoryAuditBase,
          reason: "pre-compaction",
        },
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
      let invokeCount = 0;
      const invoke = async (promptUser: string) => {
        invokeCount += 1;
        const result = await withTimeout(
          input.llmStructured({
            system: prompts.system,
            user: promptUser,
            schema: structuredAgentActionSchema,
            schemaName: "agent_action",
          }),
          structuredDecisionTimeoutMs,
          `structured model call (iteration ${iteration})`,
        );
        const stage = invokeCount === 1
          ? `iteration-${iteration}.after_llm`
          : `iteration-${iteration}.after_llm_retry_${invokeCount}`;
        if (await checkAbort(stage)) {
          throw new Error(`canceled at ${stage}`);
        }
        return {
          parsed: normalizeStructuredAction(result.parsed),
          raw: result.raw,
        };
      };

      const result = await runStructuredFunction({
        invoke,
        user: promptText,
        isRepairableError: isStructuredInputParseError,
        repairUser: (currentPrompt) => [
          currentPrompt,
          "",
          "Correction: for tool actions, set action.input to a valid JSON object encoded as a string. Do not wrap it in prose or markdown.",
        ].join("\n"),
        isCompactionError: isContextOverflow,
        compactUser: async (currentPrompt) => {
          const compacted = compactPrompt(currentPrompt, 8_000);
          await emit({
            type: "context.compacted",
            runId: input.runId,
            iteration,
            agentId: "orchestrator",
            reason: "overflow",
            before: currentPrompt.length,
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
          return compacted;
        },
      });
      return result;
    };

    let toolCallsSucceeded = 0;
    let toolCallsFailed = 0;
    const toolsUsed = new Set<string>();

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
        audit: {
          ...memoryAuditBase,
          reason: "iteration-context",
          iteration,
        },
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
      const conversationProjection = await loadConversationProjection({
        memoryTools: input.memoryTools,
        repoKey,
        profileId,
        sessionStream,
        dataDir,
        query: problem,
        runId: input.runId,
        iteration,
        actor: profileId ? "factory-chat" : "agent",
      });
      const sessionRecall = renderSessionRecallSummary(conversationProjection.sessionRecall);
      const promptVars = await input.promptContextBuilder?.({
        runId: input.runId,
        runStream,
        iteration,
        problem,
        workspaceRoot: resolvedWorkspaceRoot,
        transcript: transcriptText || "(no prior steps)",
        memorySummary: memorySummary.summary || "(empty)",
      });
      const prompt = renderPrompt(prompts.user.loop, {
        problem,
        iteration: String(iteration),
        maxIterations: String(maxIterations),
        workspace: resolvedWorkspaceRoot,
        transcript: transcriptText || "(no prior steps)",
        memory: memorySummary.summary || "(empty)",
        user_preferences: conversationProjection.userPreferences || "(none)",
        session_recall: sessionRecall || "(none)",
        available_tools: availableTools.join(", "),
        tool_help: toolHelp || "(no tools available)",
        ...(promptVars ?? {}),
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

      await input.onStructuredActionParsed?.({
        runId: input.runId,
        runStream,
        iteration,
        action: parsed,
        emit,
      });
      if (parsed.preferenceNotes && parsed.preferenceNotes.length > 0) {
        await rememberUserPreferenceNotes({
          memoryTools: input.memoryTools,
          preferenceNotes: parsed.preferenceNotes,
          repoKey,
          runId: input.runId,
          actor: profileId ? "factory-chat" : "agent",
          sessionStream,
        });
      }

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
          meta: { ...memoryAuditBase, ts: now() },
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

      if (!capabilityRegistry.get(parsed.name)) {
        toolCallsFailed += 1;
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
        const result = await capabilityRegistry.execute(parsed.name, parsed.input);
        toolCallsSucceeded += 1;
        toolsUsed.add(parsed.name);
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
        if (result.pauseBudget === true) {
          maxIterations += 1;
        }
      } catch (err) {
        toolCallsFailed += 1;
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
      const runProgress: AgentRunProgress = {
        iterationsUsed: maxIterations,
        toolCallsSucceeded,
        toolCallsFailed,
        distinctToolsUsed: toolsUsed.size,
      };
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
        progress: runProgress,
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
          meta: { ...memoryAuditBase, ts: now(), continued: true },
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
        content: "Stopped after hitting max iterations.",
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
