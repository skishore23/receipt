// ============================================================================
// Writer Guild workflow - Planner-driven multi-agent writing
// ============================================================================

import type { Runtime } from "../core/runtime.js";
import type { WriterCmd, WriterEvent, WriterState } from "../modules/writer.js";
import { renderPrompt, type WriterPromptConfig } from "../prompts/writer.js";
import { clampNumber, parseFormNum, type AgentRunControl, createQueuedEmitter, type EmitFn, type RunLifecycle, type WorkflowSpec } from "../engine/runtime/workflow.js";
import { runReceiptPlanner, type CapabilitySpec, type PlanSpec } from "../engine/runtime/planner.js";
import { defineAgent, runDefinedAgent } from "../sdk/agent.js";
import { WRITER_WORKFLOW_ID, WRITER_WORKFLOW_VERSION, WRITER_TEAM, WRITER_EXAMPLES } from "./writer.constants.js";
import { writerBranchStream, writerRunStream } from "./writer.streams.js";
import { reduce as reduceWriter, initial as initialWriter } from "../modules/writer.js";

// ============================================================================
// Types
// ============================================================================

export type WriterRunConfig = {
  readonly maxParallel: number;
};

export type WriterRunControl = AgentRunControl;

export const WRITER_DEFAULT_CONFIG: WriterRunConfig = {
  maxParallel: 3,
};

export const normalizeWriterConfig = (input: Partial<WriterRunConfig>): WriterRunConfig => ({
  maxParallel: clampNumber(
    Number.isFinite(input.maxParallel ?? NaN) ? input.maxParallel! : WRITER_DEFAULT_CONFIG.maxParallel,
    1,
    6
  ),
});

export const parseWriterConfig = (form: Record<string, string>): WriterRunConfig =>
  normalizeWriterConfig({
    maxParallel: parseFormNum(form.parallel),
  });

type WriterWorkflowConfig = WriterRunConfig & {
  readonly problem: string;
};

type WriterWorkflowDeps = {
  readonly runtime: Runtime<WriterCmd, WriterEvent, WriterState>;
  readonly prompts: WriterPromptConfig;
  readonly llmText: (opts: { system?: string; user: string }) => Promise<string>;
  readonly model: string;
  readonly promptHash?: string;
  readonly promptPath?: string;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly emitIndex: (event: WriterEvent) => Promise<void>;
  readonly control?: WriterRunControl;
};

export type WriterRunInput = {
  readonly stream: string;
  readonly runId: string;
  readonly runStream?: string;
  readonly problem: string;
  readonly config: WriterRunConfig;
  readonly runtime: Runtime<WriterCmd, WriterEvent, WriterState>;
  readonly prompts: WriterPromptConfig;
  readonly llmText: (opts: { system?: string; user: string }) => Promise<string>;
  readonly model: string;
  readonly promptHash?: string;
  readonly promptPath?: string;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly broadcast?: () => void;
  readonly now?: () => number;
  readonly control?: WriterRunControl;
};

// ============================================================================
// Workflow spec
// ============================================================================

const WRITER_LIFECYCLE: RunLifecycle<WriterWorkflowDeps, WriterEvent, WriterState, WriterWorkflowConfig> = {
  reducer: reduceWriter,
  initial: initialWriter,
  init: (ctx, runId, config) => [
    { type: "problem.set", runId, problem: config.problem, agentId: "orchestrator" },
    {
      type: "run.configured",
      runId,
      agentId: "orchestrator",
      workflow: { id: WRITER_WORKFLOW_ID, version: WRITER_WORKFLOW_VERSION },
      config: { maxParallel: config.maxParallel },
      model: ctx.model,
      promptHash: ctx.promptHash,
      promptPath: ctx.promptPath,
    },
    { type: "run.status", runId, status: "running", agentId: "orchestrator" },
    { type: "state.patch", runId, stepId: "problem", patch: { problem: config.problem } },
  ],
  resume: (_ctx, runId, state, config) => {
    const events: WriterEvent[] = [];
    const problem = state.problem || config.problem;
    if (state.status !== "running" && state.status !== "completed") {
      events.push({ type: "run.status", runId, status: "running", agentId: "orchestrator", note: "resumed" });
    }
    if (problem && !state.planner.outputs.problem) {
      events.push({ type: "state.patch", runId, stepId: "problem", patch: { problem } });
    }
    return events;
  },
};

const WRITER_WORKFLOW: WorkflowSpec<WriterWorkflowDeps, WriterWorkflowConfig, WriterEvent, WriterState> = {
  id: WRITER_WORKFLOW_ID,
  version: WRITER_WORKFLOW_VERSION,
  lifecycle: WRITER_LIFECYCLE,
  run: async (ctx, config) => {
    const { runtime, prompts, llmText: llmRaw, apiReady, apiNote, control } = ctx;
    const { maxParallel } = config;
    let problemText = (ctx.resume ? (ctx.state?.problem || config.problem) : (config.problem || ctx.state?.problem || "")).trim();
    const runId = ctx.runId;

    const stepBranchEmitters = new Map<string, EmitFn<WriterEvent>>();
    let plannerStepIds: Set<string> | null = null;

    const ensureStepBranch = async (stepId: string, agentId?: string) => {
      if (!plannerStepIds || !plannerStepIds.has(stepId)) return;
      if (stepBranchEmitters.has(stepId)) return;

      const branchName = writerBranchStream(ctx.stream, stepId);
      const existing = await runtime.branch(branchName);
      if (!existing) {
        const forkPoint = (await runtime.chain(ctx.stream)).length;
        await runtime.fork(ctx.stream, forkPoint, branchName);
      }

      const emitBranch = createQueuedEmitter({
        runtime,
        stream: branchName,
        wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as WriterCmd),
        onError: (err) => console.error(`writer branch emit failed (${agentId ?? stepId})`, err),
      });

      stepBranchEmitters.set(stepId, emitBranch);
    };

    const emit = async (event: WriterEvent) => {
      const stepId = "stepId" in event ? event.stepId : undefined;
      if (stepId) {
        await ensureStepBranch(stepId, "agentId" in event ? event.agentId : undefined);
      }
      await ctx.emit(event);
      if (stepId) {
        const emitBranch = stepBranchEmitters.get(stepId);
        if (emitBranch) await emitBranch(event);
      }
    };

    const isContextOverflow = (err: unknown): boolean => {
      const message = err instanceof Error ? err.message : String(err);
      return /context|token|maximum context|input too large|prompt too long/i.test(message);
    };

    const softTrim = (text: string, headChars: number, tailChars: number): string => {
      if (text.length <= headChars + tailChars + 16) return text;
      return `${text.slice(0, headChars)}\n\n[... trimmed ...]\n\n${text.slice(-tailChars)}`;
    };

    const compactPrompt = (text: string, targetChars: number): string => {
      if (text.length <= targetChars) return text;
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      const head = lines.slice(0, 20).join("\n");
      const tail = lines.slice(-12).join("\n");
      const merged = `${head}\n\n[... compacted context ...]\n\n${tail}`.trim();
      if (merged.length <= targetChars) return merged;
      return softTrim(merged, Math.floor(targetChars * 0.6), Math.floor(targetChars * 0.3));
    };

    const applyContextPolicy = async (stage: string, user: string, agentId?: string, stepId?: string): Promise<string> => {
      const HARD_THRESHOLD = 45_000;
      const SOFT_THRESHOLD = 10_000;
      const COMPACT_THRESHOLD = 16_000;
      let next = user;
      if (next.length > HARD_THRESHOLD) {
        const before = next.length;
        next = "[Context pruned due to size. Produce concise output.]";
        await emit({
          type: "context.pruned",
          runId,
          agentId,
          stepId,
          stage,
          mode: "hard",
          before,
          after: next.length,
          note: "hard clear applied",
        });
      } else if (next.length > SOFT_THRESHOLD) {
        const before = next.length;
        next = softTrim(next, 3_500, 2_800);
        await emit({
          type: "context.pruned",
          runId,
          agentId,
          stepId,
          stage,
          mode: "soft",
          before,
          after: next.length,
          note: "soft trim applied",
        });
      }
      if (next.length > COMPACT_THRESHOLD) {
        const before = next.length;
        next = compactPrompt(next, 8_000);
        await emit({
          type: "context.compacted",
          runId,
          agentId,
          stepId,
          stage,
          reason: "threshold",
          before,
          after: next.length,
          note: "pre-call compaction",
        });
      }
      return next;
    };

    const callLlm = async (opts: {
      readonly system?: string;
      readonly user: string;
      readonly stage: string;
      readonly agentId?: string;
      readonly stepId?: string;
    }): Promise<string> => {
      if (await checkAbort(`${opts.stage}.before_llm`)) {
        throw new Error(`canceled at ${opts.stage}.before_llm`);
      }
      const pruned = await applyContextPolicy(opts.stage, opts.user, opts.agentId, opts.stepId);
      try {
        const out = await llmRaw({ system: opts.system, user: pruned });
        if (await checkAbort(`${opts.stage}.after_llm`)) {
          throw new Error(`canceled at ${opts.stage}.after_llm`);
        }
        return out;
      } catch (err) {
        if (!isContextOverflow(err)) throw err;
        const compacted = compactPrompt(pruned, 6_000);
        await emit({
          type: "context.compacted",
          runId,
          agentId: opts.agentId,
          stepId: opts.stepId,
          stage: opts.stage,
          reason: "overflow",
          before: pruned.length,
          after: compacted.length,
          note: "retry after overflow",
        });
        await emit({
          type: "overflow.recovered",
          runId,
          agentId: opts.agentId,
          stepId: opts.stepId,
          stage: opts.stage,
          note: "recovered by compacting prompt and retrying once",
        });
        const out = await llmRaw({ system: opts.system, user: compacted });
        if (await checkAbort(`${opts.stage}.after_overflow_retry`)) {
          throw new Error(`canceled at ${opts.stage}.after_overflow_retry`);
        }
        return out;
      }
    };

    const applyControlCommands = async (): Promise<void> => {
      if (!control?.pullCommands) return;
      const commands = await control.pullCommands();
      for (const command of commands) {
        const payload = command.payload ?? {};
        if (typeof payload.problem === "string" && payload.problem.trim().length > 0) {
          problemText = payload.problem.trim();
          await emit({
            type: "state.patch",
            runId,
            stepId: "problem",
            patch: { problem: problemText },
          });
          continue;
        }
        if (typeof payload.note === "string" && payload.note.trim().length > 0) {
          problemText = `${problemText}\n\nFollow-up:\n${payload.note}`.trim();
          await emit({
            type: "state.patch",
            runId,
            stepId: "problem",
            patch: { problem: problemText },
          });
        }
      }
    };

    const checkAbort = async (stage: string): Promise<boolean> => {
      if (!control?.checkAbort) return false;
      const aborted = await control.checkAbort();
      if (!aborted) return false;
      await emit({
        type: "run.status",
        runId,
        status: "failed",
        agentId: "orchestrator",
        note: `canceled at ${stage}`,
      });
      return true;
    };

    if (!apiReady) {
      await emit({
        type: "run.status",
        runId,
        status: "failed",
        agentId: "orchestrator",
        note: apiNote ?? "OPENAI_API_KEY not set",
      });
      await emit({
        type: "solution.finalized",
        runId,
        agentId: "orchestrator",
        content: apiNote ?? "OPENAI_API_KEY not set",
        confidence: 0,
      });
      return;
    }

    await applyControlCommands();
    if (await checkAbort("bootstrap")) return;

    type PromptContextEvent = Extract<WriterEvent, { type: "prompt.context" }>;
    const emitPromptContext = async (payload: Omit<PromptContextEvent, "type" | "runId">) => {
      await emit({ type: "prompt.context", runId, ...payload });
    };
    const asText = (value: unknown, fallback = ""): string => {
      if (typeof value === "string") return value;
      if (value === undefined || value === null) return fallback;
      return String(value);
    };

    const capabilities: CapabilitySpec<typeof ctx>[] = [
      {
        id: "research.a",
        agentId: "researcher_a",
        needs: ["problem"],
        provides: ["research.a"],
        run: async (_ctx, state) => {
          const user = renderPrompt(prompts.user.research ?? "", { problem: asText(state.problem, problemText) });
          await emitPromptContext({
            agentId: "researcher_a",
            stepId: "research.a",
            title: "Research A prompt",
            content: user,
          });
          const text = await callLlm({
            system: prompts.system.researcher_a ?? "",
            user,
            stage: "research",
            agentId: "researcher_a",
            stepId: "research.a",
          });
          return { "research.a": text.trim() || "No research output." };
        },
      },
      {
        id: "research.b",
        agentId: "researcher_b",
        needs: ["problem"],
        provides: ["research.b"],
        run: async (_ctx, state) => {
          const user = renderPrompt(prompts.user.research ?? "", { problem: asText(state.problem, problemText) });
          await emitPromptContext({
            agentId: "researcher_b",
            stepId: "research.b",
            title: "Research B prompt",
            content: user,
          });
          const text = await callLlm({
            system: prompts.system.researcher_b ?? "",
            user,
            stage: "research",
            agentId: "researcher_b",
            stepId: "research.b",
          });
          return { "research.b": text.trim() || "No research output." };
        },
      },
      {
        id: "research.c",
        agentId: "researcher_c",
        needs: ["problem"],
        provides: ["research.c"],
        run: async (_ctx, state) => {
          const user = renderPrompt(prompts.user.research ?? "", { problem: asText(state.problem, problemText) });
          await emitPromptContext({
            agentId: "researcher_c",
            stepId: "research.c",
            title: "Research C prompt",
            content: user,
          });
          const text = await callLlm({
            system: prompts.system.researcher_c ?? "",
            user,
            stage: "research",
            agentId: "researcher_c",
            stepId: "research.c",
          });
          return { "research.c": text.trim() || "No research output." };
        },
      },
      {
        id: "outline",
        agentId: "architect",
        needs: ["problem", "research.a", "research.b", "research.c"],
        provides: ["outline"],
        run: async (_ctx, state) => {
          const research = [state["research.a"], state["research.b"], state["research.c"]]
            .map((value) => asText(value))
            .filter((value) => value.length > 0)
            .join("\n\n");
          const user = renderPrompt(prompts.user.outline ?? "", {
            problem: asText(state.problem, problemText),
            research,
          });
          await emitPromptContext({
            agentId: "architect",
            stepId: "outline",
            title: "Outline prompt",
            content: user,
          });
          const text = await callLlm({
            system: prompts.system.architect ?? "",
            user,
            stage: "outline",
            agentId: "architect",
            stepId: "outline",
          });
          return { outline: text.trim() || "No outline produced." };
        },
      },
      {
        id: "draft",
        agentId: "drafter",
        needs: ["outline"],
        provides: ["draft"],
        run: async (_ctx, state) => {
          const research = [state["research.a"], state["research.b"], state["research.c"]]
            .map((value) => asText(value))
            .filter((value) => value.length > 0)
            .join("\n\n");
          const user = renderPrompt(prompts.user.draft ?? "", {
            problem: asText(state.problem, problemText),
            outline: asText(state.outline),
            research,
          });
          await emitPromptContext({
            agentId: "drafter",
            stepId: "draft",
            title: "Draft prompt",
            content: user,
          });
          const text = await callLlm({
            system: prompts.system.drafter ?? "",
            user,
            stage: "draft",
            agentId: "drafter",
            stepId: "draft",
          });
          return { draft: text.trim() || "No draft produced." };
        },
      },
      {
        id: "critique.logic",
        agentId: "critic_logic",
        needs: ["draft"],
        provides: ["critique.logic"],
        run: async (_ctx, state) => {
          const user = renderPrompt(prompts.user.critique_logic ?? "", { draft: asText(state.draft) });
          await emitPromptContext({
            agentId: "critic_logic",
            stepId: "critique.logic",
            title: "Logic critique prompt",
            content: user,
          });
          const text = await callLlm({
            system: prompts.system.critic_logic ?? "",
            user,
            stage: "critic",
            agentId: "critic_logic",
            stepId: "critique.logic",
          });
          return { "critique.logic": text.trim() || "No critique." };
        },
      },
      {
        id: "critique.style",
        agentId: "critic_style",
        needs: ["draft"],
        provides: ["critique.style"],
        run: async (_ctx, state) => {
          const user = renderPrompt(prompts.user.critique_style ?? "", { draft: asText(state.draft) });
          await emitPromptContext({
            agentId: "critic_style",
            stepId: "critique.style",
            title: "Style critique prompt",
            content: user,
          });
          const text = await callLlm({
            system: prompts.system.critic_style ?? "",
            user,
            stage: "critic",
            agentId: "critic_style",
            stepId: "critique.style",
          });
          return { "critique.style": text.trim() || "No critique." };
        },
      },
      {
        id: "revise",
        agentId: "editor",
        needs: ["draft", "critique.logic", "critique.style"],
        provides: ["revision"],
        run: async (_ctx, state) => {
          const user = renderPrompt(prompts.user.revise ?? "", {
            draft: asText(state.draft),
            critique_logic: asText(state["critique.logic"]),
            critique_style: asText(state["critique.style"]),
          });
          await emitPromptContext({
            agentId: "editor",
            stepId: "revise",
            title: "Revision prompt",
            content: user,
          });
          const text = await callLlm({
            system: prompts.system.editor ?? "",
            user,
            stage: "edit",
            agentId: "editor",
            stepId: "edit",
          });
          return { revision: text.trim() || "No revision produced." };
        },
      },
      {
        id: "final",
        agentId: "synthesizer",
        needs: ["revision"],
        provides: ["final"],
        run: async (_ctx, state) => {
          const user = renderPrompt(prompts.user.final ?? "", { revision: asText(state.revision) });
          await emitPromptContext({
            agentId: "synthesizer",
            stepId: "final",
            title: "Final prompt",
            content: user,
          });
          const text = await callLlm({
            system: prompts.system.synthesizer ?? "",
            user,
            stage: "synthesize",
            agentId: "synthesizer",
            stepId: "synthesize",
          });
          return { final: text.trim() || "No final output." };
        },
      },
    ];

    plannerStepIds = new Set(capabilities.map((cap) => cap.id));

    const state = ctx.state ?? initialWriter;

    const plan: PlanSpec<typeof ctx> = {
      id: WRITER_WORKFLOW_ID,
      version: WRITER_WORKFLOW_VERSION,
      capabilities,
      goal: (outputs) => ({
        done: outputs["final"] !== undefined,
        blocked: outputs["final"] === undefined ? "final output not yet produced" : undefined,
      }),
    };

    const plannerState = await runReceiptPlanner({
      runId,
      ctx,
      emit,
      plan,
      initial: state.planner,
      maxParallel,
      defaultTimeoutMs: Number(process.env.PLANNER_STEP_TIMEOUT_MS ?? 90000),
      retryFailed: Boolean(ctx.resume),
    });
    if (await checkAbort("planner")) return;

    if (plannerState.status === "failed") {
      await emit({
        type: "run.status",
        runId,
        status: "failed",
        agentId: "orchestrator",
        note: plannerState.failureNote ?? "Planner failed.",
      });
      return;
    }

    const final = plannerState.outputs.final ?? "";
    if (!final.trim()) {
      await emit({
        type: "run.status",
        runId,
        status: "failed",
        agentId: "orchestrator",
        note: "Planner completed without final output",
      });
      return;
    }

    await emit({
      type: "solution.finalized",
      runId,
      agentId: "synthesizer",
      content: final,
      confidence: 0.7,
    });
    await emit({ type: "run.status", runId, status: "completed", agentId: "orchestrator" });
  },
};

const WRITER_RECEIPT_RUNTIME = defineAgent<
  WriterCmd,
  WriterWorkflowDeps,
  WriterEvent,
  WriterState,
  WriterWorkflowConfig
>({
  id: WRITER_WORKFLOW_ID,
  version: WRITER_WORKFLOW_VERSION,
  reducer: reduceWriter,
  initial: initialWriter,
  lifecycle: {
    init: WRITER_LIFECYCLE.init,
    resume: WRITER_LIFECYCLE.resume,
    shouldIndex: WRITER_LIFECYCLE.shouldIndex,
  },
  run: WRITER_WORKFLOW.run,
});

// ============================================================================
// Public run entry
// ============================================================================

export const runWriterGuild = async (input: WriterRunInput): Promise<void> => {
  const now = input.now ?? Date.now;
  const baseStream = input.stream;
  const runStream = input.runStream ?? writerRunStream(baseStream, input.runId);

  const emitRun = createQueuedEmitter({
    runtime: input.runtime,
    stream: runStream,
    wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as WriterCmd),
    onEmit: () => input.broadcast?.(),
    onError: (err) => console.error("writer emit failed", err),
  });
  const emitIndex = createQueuedEmitter({
    runtime: input.runtime,
    stream: baseStream,
    wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as WriterCmd),
    onError: (err) => console.error("writer index emit failed", err),
  });

  try {
    await runDefinedAgent({
      spec: WRITER_RECEIPT_RUNTIME,
      ctx: {
        stream: runStream,
        runId: input.runId,
        emit: emitRun,
        now,
        runtime: input.runtime,
        prompts: input.prompts,
        llmText: input.llmText,
        model: input.model,
        promptHash: input.promptHash,
        promptPath: input.promptPath,
        apiReady: input.apiReady,
        apiNote: input.apiNote,
        emitIndex,
        control: input.control,
      },
      config: { ...input.config, problem: input.problem },
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    const failureEvent: WriterEvent = {
      type: "run.status",
      runId: input.runId,
      status: "failed",
      agentId: "orchestrator",
      note: message,
    };
    await emitRun(failureEvent);
    await emitIndex(failureEvent);
  }
};

// ============================================================================
// Re-exports for server/views
// ============================================================================

export {
  WRITER_WORKFLOW_ID,
  WRITER_WORKFLOW_VERSION,
  WRITER_TEAM,
  WRITER_EXAMPLES,
};
