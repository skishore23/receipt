import type { ZodTypeAny, infer as ZodInfer } from "zod";
import path from "node:path";

import {
  AGENT_DEFAULT_CONFIG,
  normalizeAgentConfig,
  runAgent,
  isStuckProgress,
  type AgentRunConfig,
  type AgentRunInput,
  type AgentRunResult,
} from "../../agent";
import type { JsonlQueue } from "../../../adapters/jsonl-queue";
import type { MemoryTools } from "../../../adapters/memory-tools";
import type { FactoryService } from "../../../services/factory-service";
import {
  factoryChatStream,
  factoryChatSessionStream,
  repoKeyForRoot,
  resolveFactoryChatProfile,
} from "../../../services/factory-chat-profiles";
import {
  renderFactoryChatContextImports,
  renderFactoryChatConversationTranscript,
  renderFactoryResponseStyleGuidance,
  withFactoryChatContextImports,
  type FactoryChatContextImports,
} from "../chat-context";
import {
  combineFinalizers,
  createLiveFactoryFinalizer,
  isActiveJobStatus,
} from "../../orchestration-utils";
import { createFactoryChatCapabilities } from "./tools";
import { buildFactoryChatContextImports, chatIdFromFactoryStream, loadProjectedChatContext, nextId, nextIterationBudget, objectiveMemoryScope, parseContinuationDepth, profileMemoryScope, repoMemoryScope } from "./input";
import { readSupervisorConfig } from "./supervisor";
import { buildFactorySituation } from "./status";
import { summarizeChildProgress, asString } from "./input";
import { codexJobSnapshot } from "./status";
import { listChildJobsForRun } from "./input";
import { analyzeFactoryChatTurn } from "./turn-analysis";
import {
  loadConversationProjection,
  renderSessionRecallSummary,
} from "../../../services/conversation-memory";

export { renderFactoryResponseStyleGuidance } from "../chat-context";
export { analyzeFactoryChatTurn } from "./turn-analysis";

export const FACTORY_CHAT_WORKFLOW_ID = "factory-chat-v1";
export const FACTORY_CHAT_WORKFLOW_VERSION = "1.0.0";

export type FactoryChatRunConfig = AgentRunConfig;

export const FACTORY_CHAT_DEFAULT_CONFIG: FactoryChatRunConfig = {
  ...AGENT_DEFAULT_CONFIG,
  maxIterations: 8,
  maxToolOutputChars: 6_000,
  memoryScope: "repos/factory/profiles/generalist",
};

export type FactoryChatRunInput = Omit<AgentRunInput, "config" | "prompts" | "llmStructured"> & {
  readonly config: FactoryChatRunConfig;
  readonly queue: JsonlQueue;
  readonly factoryService: FactoryService;
  readonly dataDir?: string;
  readonly repoRoot: string;
  readonly profileRoot?: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly llmStructured: <Schema extends ZodTypeAny>(opts: {
    readonly system?: string;
    readonly user: string;
    readonly schema: Schema;
    readonly schemaName: string;
  }) => Promise<{ readonly parsed: ZodInfer<Schema>; readonly raw: string }>;
  readonly profileId?: string;
  readonly continuationDepth?: number;
};

const isTerminalObjectiveStatus = (status: unknown): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const FACTORY_CHAT_LOOP_TEMPLATE = [
  "Goal:",
  "{{problem}}",
  "",
  "Iteration: {{iteration}} / {{maxIterations}}",
  "Workspace: {{workspace}}",
  "",
  "Recent conversation:",
  "{{transcript}}",
  "",
  "Current situation:",
  "{{situation}}",
  "",
  "Imported context:",
  "{{context_imports}}",
  "",
  "Memory summary:",
  "{{memory}}",
  "",
  "Response style:",
  "{{response_style}}",
  "",
  "User preferences:",
  "{{user_preferences}}",
  "",
  "Session recall:",
  "{{session_recall}}",
  "",
  "Available tools (one per step):",
  "{{available_tools}}",
  "",
  "Tool specs:",
  "{{tool_help}}",
  "",
  "Orchestration rules:",
  "- Profiles are orchestration-only. Do not claim this chat edited code directly.",
  "- Treat chat sessions as their own conversational context. Only use objective or runtime state when it is explicitly imported or bound.",
  "- When the selected objective is blocked, first explain the handoff in plain language: what the objective established, what is still missing, and whether the next step belongs in Chat or in tracked objective work.",
  "- Use `codex.run` only for lightweight read-only inspection or evidence-gathering in the current repo.",
  "- If a Codex probe is already queued or running for this chat context, reuse it instead of spawning another one.",
  "- Use `factory.dispatch` for any code-changing delivery work, any substantive infrastructure investigation, or when the next step should run in an objective worktree.",
  "- If a completed objective already contains the answer in `factory.status`, `factory.receipts`, or `factory.output`, answer directly only when the answer is historical, meta, or clearly not freshness-sensitive.",
  "- If the answer depends on current cloud/account/runtime state and checked-in helpers are available in the current situation or `factory.status`, rerun the best matching helper first via `codex.run` or `factory.dispatch` instead of finalizing from saved results alone.",
  "- If the answer depends on current cloud/account/runtime state and you only have saved evidence, prefer a fresh probe over presenting old results as current.",
  "- When a thread is already bound to an objective, treat follow-up work as a continuation by default. Use `factory.dispatch` with `{\"action\":\"react\",\"note\":\"...\"}` unless the user explicitly wants a separate objective.",
  "- If the bound objective is blocked, completed, canceled, or failed and the user wants fresh work, still use `action:\"react\"` with a `note` or `prompt`; the runtime will create a follow-up objective and rebind the thread.",
  "- Use `action:\"create\"` only when you intentionally want unrelated or explicitly separate work.",
  "- Before `react`, `promote`, `cancel`, or duplicate dispatch, ground the decision in the current situation, receipts, or live output.",
  "- Use delegation only for bounded sidecar work with a clear owner and stop condition. Keep the main chat responsible for the final answer.",
  "- When child work is already active, prefer `codex.status`, `factory.status`, or `factory.output` with `waitForChangeMs` so you wait for real progress instead of tight polling.",
  "- When `factory.output` reports `active: true`, treat log-tail command failures as provisional telemetry. Do not conclude the work failed until the task, job, or objective itself reaches a terminal failed/blocked state or receipts record that outcome.",
  "- If `factory.output` already resolved one active child, keep that same focus and add `waitForChangeMs` before switching tools. Use `factory.receipts` for reconciled history or terminal explanations, not as a substitute for live waiting.",
  "- Once a child has produced a concrete artifact, result JSON, or terminal summary that answers the question, inspect that evidence and finalize instead of issuing more wait loops.",
  "- Do not try to steer an in-flight child. If the current attempt is wrong, inspect it, abort it, and react the objective with a clearer note.",
  "- If investigation reports disagree or reconciliation is pending, do not finalize yet. Inspect status/receipts and wait for the objective to align or block.",
  "- Match tool input keys exactly to the documented schema. For example, `codex.run` accepts `{\"prompt\": string, \"timeoutMs\"?: number}`.",
  "- For `factory.dispatch`, use only `action`, `objectiveId`, `prompt`, `note`, `title`, `objectiveMode`, `severity`, `checks`, `channel`, and `reason`.",
  "",
  "For final answers to the user:",
  "- write plain language, not raw JSON",
  "- keep it concise and operator-facing",
  "- mention objective, run, and job only when needed for debugging or inspection",
  "- follow the active profile's voice, but do not let older transcript or memory phrasing override it",
  "- for conversational or meta turns, prefer short natural prose instead of sections",
  "- choose the structure that best fits the question instead of defaulting to a template",
  "- if data or evidence matters, present it clearly in markdown instead of raw JSON",
  "- use headings only when they add real signal",
  "- do not emit headings like Conclusion, Evidence, Disagreements, Scripts Run, Artifacts, What you did well, or Next Steps unless they add real signal for this specific answer or the user explicitly asked for that structure",
  "- never compress lists into a single paragraph such as `1) a 2) b 3) c`",
  "- prefer bold lead-ins such as `**Smallest unblock:**` before a short list instead of plain label lines ending with `:`",
  "- if code changes are needed, route them through Factory objective work instead of claiming this chat changed code directly",
  "- if the user states or strongly implies reusable preferences or defaults for future turns, include concise normalized notes in the optional `memory.preferenceNotes` array",
  "- `memory.preferenceNotes` can capture any durable preference: formatting, tone, depth, workflow, assumptions, or tool behavior; do not limit it to a fixed taxonomy",
  "- do not put one-off task facts or transient status updates into `memory.preferenceNotes`",
  "",
  "Respond with JSON only, no markdown. Always include every field in the action object:",
  "{",
  "  \"thought\": \"short reasoning\",",
  "  \"action\": {",
  "    \"type\": \"tool\" | \"final\",",
  "    \"name\": \"tool name when type=tool, otherwise null\",",
  "    \"input\": \"JSON object string for tool args\",",
  "    \"text\": \"final answer when type=final, otherwise null\"",
  "  },",
  "  \"memory\": {",
  "    \"preferenceNotes\": [\"optional reusable user preference note\"]",
  "  }",
  "}",
  "",
  "For final actions, set \"name\": null and \"input\": \"{}\".",
  "For tool actions, set \"text\": null.",
  "The input field must always be a JSON object encoded as a string.",
  "If there are no reusable preference notes, omit `memory` entirely.",
].join("\n");

const resolveObjectiveIdFromSessionChain = async (
  runtime: FactoryChatRunInput["runtime"],
  sessionStream: string,
): Promise<string | undefined> => {
  const chain = await runtime.chain(sessionStream);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const event = chain[i]?.body;
    if (event?.type === "thread.bound") {
      const objectiveId = asString(event.objectiveId);
      if (objectiveId) return objectiveId;
    }
  }
  return undefined;
};

export const normalizeFactoryChatConfig = (input: Partial<FactoryChatRunConfig>): FactoryChatRunConfig =>
  normalizeAgentConfig({
    ...FACTORY_CHAT_DEFAULT_CONFIG,
    ...input,
  });

export const runFactoryChat = async (input: FactoryChatRunInput): Promise<AgentRunResult> => {
  const repoRoot = path.resolve(input.repoRoot);
  const profileRoot = path.resolve(input.profileRoot ?? repoRoot);
  const continuationDepth = parseContinuationDepth(input.continuationDepth);
  const resolvedChatId = input.chatId ?? chatIdFromFactoryStream(input.stream);
  const resolvedProfile = await resolveFactoryChatProfile({
    repoRoot,
    profileRoot,
    requestedId: input.profileId,
    problem: input.problem,
  });
  const repoKey = repoKeyForRoot(repoRoot);
  const resolvedStream = resolvedChatId
    ? factoryChatSessionStream(repoRoot, resolvedProfile.root.id, resolvedChatId)
    : asString(input.stream) ?? factoryChatStream(repoRoot, resolvedProfile.root.id, input.objectiveId);
  const rebracketedObjectiveId = !input.objectiveId && resolvedChatId
    ? await resolveObjectiveIdFromSessionChain(input.runtime, resolvedStream)
    : undefined;
  let currentObjectiveId = input.objectiveId ?? rebracketedObjectiveId;
  const getCurrentObjectiveId = (): string | undefined => currentObjectiveId;
  const setCurrentObjectiveId = (objectiveId: string | undefined): void => {
    currentObjectiveId = objectiveId;
  };
  const effectiveObjectiveId = input.objectiveId ?? rebracketedObjectiveId;
  const resolvedMemoryScope = input.config.memoryScope === FACTORY_CHAT_DEFAULT_CONFIG.memoryScope
    ? (effectiveObjectiveId
      ? objectiveMemoryScope(repoKey, resolvedProfile.root.id, effectiveObjectiveId)
      : profileMemoryScope(repoKey, resolvedProfile.root.id))
    : input.config.memoryScope;
  const factoryLiveWaitState = { surfaced: false };
  const supervisorConfig = readSupervisorConfig(input.extraConfig);
  const turnAnalysisCache = new Map<string, Promise<{
    readonly responseStyle: "conversational" | "work";
    readonly includeBoundObjectiveContext: boolean;
  }>>();
  const analyzeTurn = (problem: string): Promise<{
    readonly responseStyle: "conversational" | "work";
    readonly includeBoundObjectiveContext: boolean;
  }> => {
    const key = problem.replace(/\s+/g, " ").trim();
    const cached = turnAnalysisCache.get(key);
    if (cached) return cached;
    const created = analyzeFactoryChatTurn({
      llmText: input.llmText,
      apiReady: input.apiReady,
      problem: key,
    });
    turnAnalysisCache.set(key, created);
    return created;
  };
  const discoveryBudget = resolvedProfile.orchestration.discoveryBudget;
  let discoveryUsed = 0;
  const consumeDiscoveryBudget = (): void => {
    if (discoveryBudget === undefined) return;
    discoveryUsed += 1;
    if (discoveryUsed > discoveryBudget) {
      throw new Error("Profile discovery budget exhausted");
    }
  };
  const capabilities = createFactoryChatCapabilities({
    queue: input.queue,
    runId: input.runId,
    stream: resolvedStream,
    repoRoot,
    repoKey,
    profileRoot,
    problem: input.problem,
    chatId: resolvedChatId,
    continuationDepth,
    currentJobId: input.control?.jobId,
    dataDir: input.dataDir,
    memoryTools: input.memoryTools,
    profile: resolvedProfile,
    factoryService: input.factoryService,
    getCurrentObjectiveId,
    setCurrentObjectiveId,
    consumeDiscoveryBudget,
    liveWaitState: factoryLiveWaitState,
    supervisorConfig,
  });
  const onIterationBudgetExhausted: NonNullable<AgentRunInput["onIterationBudgetExhausted"]> = async ({ runId, problem, config, progress }) => {
    if (isStuckProgress(progress)) return undefined;
    const objectiveId = getCurrentObjectiveId();
    if (objectiveId) {
      const objective = await input.factoryService.getObjective(objectiveId).catch(() => undefined);
      if (objective && !isTerminalObjectiveStatus(objective.status) && !objective.archivedAt && objective.status !== "blocked") {
        return undefined;
      }
    }
    const nextMaxIterations = nextIterationBudget(config.maxIterations);
    if (nextMaxIterations === undefined) return undefined;
    const nextRunId = nextId("run");
    const nextConfig = normalizeFactoryChatConfig({
      ...input.config,
      maxIterations: nextMaxIterations,
      memoryScope: input.config.memoryScope,
    });
    const created = await input.queue.enqueue({
      agentId: "factory",
      lane: "chat",
      sessionKey: `factory-chat:${resolvedStream}`,
      singletonMode: "allow",
      maxAttempts: 1,
      payload: {
        kind: "factory.run",
        stream: resolvedStream,
        runId: nextRunId,
        problem,
        profileId: resolvedProfile.root.id,
        ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
        ...(objectiveId ? { objectiveId } : {}),
        config: nextConfig,
        continuationDepth: continuationDepth + 1,
      },
    });
    const summary = `Reached the current ${config.maxIterations}-step slice. Continuing automatically in this project chat as ${nextRunId} with a ${nextMaxIterations}-step budget.`;
    return {
      finalText: `${summary}\n\nLive updates will keep appearing here.`,
      note: `continued automatically as ${nextRunId}`,
      events: [{
        type: "run.continued",
        runId,
        agentId: "orchestrator",
        nextRunId,
        nextJobId: created.id,
        profileId: resolvedProfile.root.id,
        objectiveId,
        previousMaxIterations: config.maxIterations,
        nextMaxIterations,
        continuationDepth: continuationDepth + 1,
        summary,
      }],
    };
  };
  return await runAgent({
    ...input,
    config: {
      ...input.config,
      memoryScope: resolvedMemoryScope,
    },
    prompts: {
      system: resolvedProfile.systemPrompt,
      user: { loop: FACTORY_CHAT_LOOP_TEMPLATE },
    },
    promptHash: resolvedProfile.promptHash,
    promptPath: resolvedProfile.promptPath,
    workflowId: FACTORY_CHAT_WORKFLOW_ID,
    workflowVersion: FACTORY_CHAT_WORKFLOW_VERSION,
    toolAllowlist: resolvedProfile.toolAllowlist,
    startupEvents: [
      {
        type: "profile.selected",
        runId: input.runId,
        agentId: "orchestrator",
        profileId: resolvedProfile.root.id,
        reason: resolvedProfile.selectionReason,
      },
      ...(effectiveObjectiveId
        ? [{
            type: "thread.bound" as const,
            runId: input.runId,
            agentId: "orchestrator",
            objectiveId: effectiveObjectiveId,
            ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
            reason: rebracketedObjectiveId ? "rebracketed" as const : "startup" as const,
          }]
        : []),
      {
        type: "profile.resolved",
        runId: input.runId,
        agentId: "orchestrator",
        rootProfileId: resolvedProfile.root.id,
        importedProfileIds: resolvedProfile.imports.map((profile) => profile.id),
        profilePaths: resolvedProfile.profilePaths,
        fileHashes: resolvedProfile.fileHashes,
        resolvedHash: resolvedProfile.resolvedHash,
      },
    ],
    extraConfig: {
      ...(input.extraConfig ?? {}),
      repoRoot,
      profileRoot,
      repoKey,
      repoMemoryScope: repoMemoryScope(repoKey),
      profileMemoryScope: resolvedMemoryScope,
      profileId: resolvedProfile.root.id,
      objectiveId: effectiveObjectiveId,
      resolvedProfileHash: resolvedProfile.resolvedHash,
      stream: resolvedStream,
    },
    promptContextBuilder: async (promptInput) => {
      const projectedContext = await loadProjectedChatContext({
        dataDir: input.dataDir,
        sessionStream: resolvedStream,
      });
      const turnAnalysis = await analyzeTurn(promptInput.problem);
      const lightweightConversation = turnAnalysis.includeBoundObjectiveContext === false;
      const imports = await buildFactoryChatContextImports({
        memoryTools: input.memoryTools,
        repoKey,
        profileId: resolvedProfile.root.id,
        primaryScope: resolvedMemoryScope,
        primarySummary: promptInput.memorySummary,
        query: promptInput.problem,
        runId: input.runId,
        iteration: promptInput.iteration,
        objectiveId: getCurrentObjectiveId(),
        queue: input.queue,
        stream: resolvedStream,
        factoryService: input.factoryService,
        includeBoundObjectiveContext: !lightweightConversation,
      });
      const explicitImports: FactoryChatContextImports = {
        ...(imports.profileMemorySummary ? { profileMemorySummary: imports.profileMemorySummary } : {}),
        ...(imports.objective ? { objective: imports.objective } : {}),
        ...(imports.runtime ? { runtime: imports.runtime } : {}),
      };
      const conversationProjection = await loadConversationProjection({
        memoryTools: input.memoryTools,
        repoKey,
        profileId: resolvedProfile.root.id,
        sessionStream: resolvedStream,
        dataDir: input.dataDir,
        query: promptInput.problem,
        runId: input.runId,
        iteration: promptInput.iteration,
        actor: "factory-chat",
      });
      const chatContext = projectedContext
        ? withFactoryChatContextImports(projectedContext, explicitImports)
        : undefined;
      return {
        transcript: chatContext
          ? renderFactoryChatConversationTranscript(chatContext.conversation)
          : promptInput.transcript,
        context_imports: renderFactoryChatContextImports(explicitImports),
        memory: explicitImports.profileMemorySummary ?? "(empty)",
        response_style: renderFactoryResponseStyleGuidance(
          projectedContext?.style.responseStyle ?? turnAnalysis.responseStyle,
        ),
        user_preferences: conversationProjection.userPreferences ?? "(none)",
        session_recall: renderSessionRecallSummary(conversationProjection.sessionRecall) ?? "(none)",
        situation: await buildFactorySituation({
          queue: input.queue,
          runId: input.runId,
          stream: resolvedStream,
          profile: resolvedProfile,
          getCurrentObjectiveId,
          factoryService: input.factoryService,
          dataDir: input.dataDir,
          detailLevel: lightweightConversation ? "light" : "full",
        }),
      };
    },
    capabilities,
    onIterationBudgetExhausted,
    finalizer: combineFinalizers(
      createLiveFactoryFinalizer({
        factoryService: input.factoryService,
        getCurrentObjectiveId,
        liveWaitState: factoryLiveWaitState,
        finalWhileChildRunning: resolvedProfile.orchestration.finalWhileChildRunning,
        describeActiveChild: async () => {
          const activeChildren = (await listChildJobsForRun(input.queue, input.runId))
            .filter((job) => isActiveJobStatus(job.status))
            .sort((left, right) => right.updatedAt - left.updatedAt);
          const activeChild = activeChildren[0];
          if (!activeChild) return undefined;
          const snapshot = await codexJobSnapshot(activeChild, input.dataDir);
          return {
            jobId: activeChild.id,
            detail: summarizeChildProgress({
              lastMessage: asString(snapshot.lastMessage),
              stderrTail: asString(snapshot.stderrTail),
              stdoutTail: asString(snapshot.stdoutTail),
            }),
          };
        },
      }),
      input.finalizer,
    ),
  });
};
