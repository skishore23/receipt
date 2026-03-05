// ============================================================================
// Receipt Inspector - prompt-driven analysis
// ============================================================================

import type { Runtime } from "../core/runtime.js";
import type {
  InspectorCmd,
  InspectorEvent,
  InspectorMode,
  InspectorState,
  InspectorTimelineBucket,
} from "../modules/inspector.js";
import { reduce as reduceInspector, initial as initialInspector } from "../modules/inspector.js";
import type { ReceiptRecord } from "../adapters/receipt-tools.js";
import { renderPrompt, type InspectorPromptConfig } from "../prompts/inspector.js";
import type { RunLifecycle, WorkflowSpec } from "../engine/runtime/workflow.js";
import { defineAgent, runDefinedAgent } from "../sdk/agent.js";

// ============================================================================
// Types
// ============================================================================

export type ReceiptTooling = {
  readonly readFile: (dir: string, name: string) => Promise<ReceiptRecord[]>;
  readonly sliceRecords: (records: ReadonlyArray<ReceiptRecord>, order: "asc" | "desc", limit: number) => ReceiptRecord[];
  readonly buildContext: (records: ReadonlyArray<ReceiptRecord>, maxChars: number) => string;
  readonly buildTimeline: (records: ReadonlyArray<ReceiptRecord>, depth: number) => Array<{ label: string; count: number }>;
};

export type InspectorRunInput = {
  readonly stream: string;
  readonly runId: string;
  readonly groupId?: string;
  readonly agentId?: string;
  readonly agentName?: string;
  readonly source: { readonly kind: "file"; readonly name: string };
  readonly dataDir: string;
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly question: string;
  readonly mode: InspectorMode;
  readonly depth: number;
  readonly runtime: Runtime<InspectorCmd, InspectorEvent, InspectorState>;
  readonly prompts: InspectorPromptConfig;
  readonly llmText: (opts: { system?: string; user: string }) => Promise<string>;
  readonly model: string;
  readonly promptHash?: string;
  readonly promptPath?: string;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly tools: ReceiptTooling;
  readonly broadcast?: () => void;
};

// ============================================================================
// Workflow
// ============================================================================

type InspectorWorkflowConfig = {
  readonly groupId?: string;
  readonly agentId?: string;
  readonly agentName?: string;
  readonly source: { readonly kind: "file"; readonly name: string };
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly question: string;
  readonly mode: InspectorMode;
  readonly depth: number;
};

type InspectorWorkflowDeps = {
  readonly runtime: Runtime<InspectorCmd, InspectorEvent, InspectorState>;
  readonly prompts: InspectorPromptConfig;
  readonly llmText: (opts: { system?: string; user: string }) => Promise<string>;
  readonly model: string;
  readonly promptHash?: string;
  readonly promptPath?: string;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly tools: ReceiptTooling;
  readonly dataDir: string;
  readonly broadcast?: () => void;
};

const INSPECTOR_LIFECYCLE: RunLifecycle<InspectorWorkflowDeps, InspectorEvent, InspectorState, InspectorWorkflowConfig> = {
  reducer: reduceInspector,
  initial: initialInspector,
  init: (ctx, runId) => [
    {
      type: "run.configured",
      runId,
      model: ctx.model,
      promptHash: ctx.promptHash,
      promptPath: ctx.promptPath,
    },
  ],
};

const INSPECTOR_WORKFLOW: WorkflowSpec<InspectorWorkflowDeps, InspectorWorkflowConfig, InspectorEvent, InspectorState> = {
  id: "receipt-inspector",
  version: "0.2",
  lifecycle: INSPECTOR_LIFECYCLE,
  run: async (ctx, config) => {
    const {
      prompts,
      llmText,
      apiReady,
      apiNote,
      tools,
      dataDir,
    } = ctx;
    const { groupId, agentId, agentName, source, order, limit, question, mode, depth } = config;
    const runId = ctx.runId;

    const emit = async (event: InspectorEvent) => {
      await ctx.emit(event);
    };

    const withMeta = <T extends InspectorEvent>(event: T): T => ({
      ...event,
      groupId,
      agentId,
      agentName,
    });

    const callTool = async <T>(
      name: string,
      input: Record<string, unknown>,
      fn: () => Promise<T>,
      summarize?: (result: T) => string
    ): Promise<T> => {
      const started = Date.now();
      try {
        const result = await fn();
        const summary = summarize ? summarize(result) : undefined;
        await emit(withMeta({
          type: "tool.called",
          runId,
          tool: name,
          input,
          summary,
          durationMs: Date.now() - started,
        }));
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await emit(withMeta({
          type: "tool.called",
          runId,
          tool: name,
          input,
          summary: "failed",
          durationMs: Date.now() - started,
          error,
        }));
        throw err;
      }
    };

    if (!apiReady) {
      await emit(withMeta({
        type: "run.status",
        runId,
        status: "failed",
        note: apiNote ?? "OPENAI_API_KEY not set",
      }));
      await emit(withMeta({
        type: "analysis.set",
        runId,
        content: apiNote ?? "OPENAI_API_KEY not set",
      }));
      return;
    }

    await emit(withMeta({ type: "run.status", runId, status: "running" }));

    let records: ReceiptRecord[] = [];
    let slice: ReceiptRecord[] = [];
    let context = "";
    let timeline: InspectorTimelineBucket[] = [];

    try {
      records = await callTool(
        "memory.read",
        { file: source.name },
        () => tools.readFile(dataDir, source.name),
        (result) => `records:${result.length}`
      );
      slice = await callTool(
        "memory.search",
        { order, limit },
        () => Promise.resolve(tools.sliceRecords(records, order, limit)),
        (result) => `slice:${result.length}`
      );
      context = await callTool(
        "memory.summarize",
        { maxChars: 12000 },
        () => Promise.resolve(tools.buildContext(slice, 12000)),
        (result) => `chars:${result.length}`
      );
      timeline = await callTool(
        "memory.diff",
        { depth },
        () => Promise.resolve(tools.buildTimeline(records, depth)),
        (result) => `buckets:${result.length}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await emit(withMeta({
        type: "run.status",
        runId,
        status: "failed",
        note: message,
      }));
      await emit(withMeta({
        type: "analysis.set",
        runId,
        content: message,
      }));
      return;
    }

    await emit(withMeta({
      type: "context.set",
      runId,
      source,
      order,
      limit,
      total: records.length,
      shown: slice.length,
    }));

    await emit(withMeta({
      type: "question.set",
      runId,
      mode,
      depth,
      question,
    }));

    await emit(withMeta({
      type: "timeline.set",
      runId,
      depth,
      buckets: timeline,
    }));

    const template = prompts.modes[mode] ?? prompts.modes.qa ?? "";
    const user = renderPrompt(template, {
      question,
      context,
      depth: String(depth),
    });

    const content = await llmText({ system: prompts.system, user });

    await emit(withMeta({
      type: "analysis.set",
      runId,
      content: content.trim() || "No analysis generated.",
    }));
    await emit(withMeta({ type: "run.status", runId, status: "completed" }));
  },
};

const INSPECTOR_RECEIPT_RUNTIME = defineAgent<
  InspectorCmd,
  InspectorWorkflowDeps,
  InspectorEvent,
  InspectorState,
  InspectorWorkflowConfig
>({
  id: INSPECTOR_WORKFLOW.id,
  version: INSPECTOR_WORKFLOW.version,
  reducer: reduceInspector,
  initial: initialInspector,
  lifecycle: {
    init: INSPECTOR_LIFECYCLE.init,
    resume: INSPECTOR_LIFECYCLE.resume,
    shouldIndex: INSPECTOR_LIFECYCLE.shouldIndex,
  },
  run: INSPECTOR_WORKFLOW.run,
});

// ============================================================================
// Runner
// ============================================================================

export const runReceiptInspector = async (input: InspectorRunInput): Promise<void> => {
  const {
    stream,
    runId,
    groupId,
    agentId,
    agentName,
    source,
    dataDir,
    order,
    limit,
    question,
    mode,
    depth,
    runtime,
    prompts,
    llmText,
    model,
    promptHash,
    promptPath,
    apiReady,
    apiNote,
    tools,
    broadcast,
  } = input;

  const emit = async (event: InspectorEvent) => {
    const eventId = `${stream}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    await runtime.execute(stream, { type: "emit", event, eventId });
    if (broadcast) broadcast();
  };

  await runDefinedAgent({
    spec: INSPECTOR_RECEIPT_RUNTIME,
    ctx: {
      stream,
      runId,
      emit,
      now: Date.now,
      runtime,
      prompts,
      llmText,
      model,
      promptHash,
      promptPath,
      apiReady,
      apiNote,
      tools,
      dataDir,
      broadcast,
    },
    config: { groupId, agentId, agentName, source, order, limit, question, mode, depth },
  });
};
