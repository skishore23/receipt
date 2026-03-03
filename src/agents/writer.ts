// ============================================================================
// Writer Guild workflow - Planner-driven multi-agent writing
// ============================================================================

import type { Runtime } from "../core/runtime.js";
import type { WriterCmd, WriterEvent, WriterState } from "../modules/writer.js";
import { renderPrompt, type WriterPromptConfig } from "../prompts/writer.js";
import { createQueuedEmitter, type EmitFn, type RunLifecycle, type WorkflowSpec } from "../engine/runtime/workflow.js";
import { runReceiptPlanner, type CapabilitySpec, type PlanSpec } from "../engine/runtime/planner.js";
import { defineReceiptAgent, runReceiptAgent } from "../engine/runtime/receipt-runtime.js";
import { WRITER_WORKFLOW_ID, WRITER_WORKFLOW_VERSION, WRITER_TEAM, WRITER_EXAMPLES } from "./writer.constants.js";
import { writerBranchStream, writerRunStream } from "./writer.streams.js";
import { reduce as reduceWriter, initial as initialWriter } from "../modules/writer.js";

// ============================================================================
// Types
// ============================================================================

export type WriterRunConfig = {
  readonly maxParallel: number;
};

export const WRITER_DEFAULT_CONFIG: WriterRunConfig = {
  maxParallel: 3,
};

const clampNumber = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const normalizeWriterConfig = (input: Partial<WriterRunConfig>): WriterRunConfig => ({
  maxParallel: clampNumber(
    Number.isFinite(input.maxParallel ?? NaN) ? input.maxParallel! : WRITER_DEFAULT_CONFIG.maxParallel,
    1,
    6
  ),
});

export const parseWriterConfig = (form: Record<string, string>): WriterRunConfig => {
  const parseNum = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  };

  return normalizeWriterConfig({
    maxParallel: parseNum(form.parallel),
  });
};

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
    const { runtime, prompts, llmText, apiReady, apiNote } = ctx;
    const { maxParallel } = config;
    const problemText = (ctx.resume ? (ctx.state?.problem || config.problem) : (config.problem || ctx.state?.problem || "")).trim();
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
          const text = await llmText({ system: prompts.system.researcher_a ?? "", user });
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
          const text = await llmText({ system: prompts.system.researcher_b ?? "", user });
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
          const text = await llmText({ system: prompts.system.researcher_c ?? "", user });
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
          const text = await llmText({ system: prompts.system.architect ?? "", user });
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
          const text = await llmText({ system: prompts.system.drafter ?? "", user });
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
          const text = await llmText({ system: prompts.system.critic_logic ?? "", user });
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
          const text = await llmText({ system: prompts.system.critic_style ?? "", user });
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
          const text = await llmText({ system: prompts.system.editor ?? "", user });
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
          const text = await llmText({ system: prompts.system.synthesizer ?? "", user });
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
      goals: ["final"],
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

const WRITER_RECEIPT_RUNTIME = defineReceiptAgent<
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
    await runReceiptAgent({
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
