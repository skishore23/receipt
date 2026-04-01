import { createHash } from "node:crypto";
import path from "node:path";

import type { Hono } from "hono";

import { LocalCodexExecutor } from "../../../adapters/codex-executor";
import type { MemoryTools } from "../../../adapters/memory-tools";
import type { Runtime } from "@receipt/core/runtime";
import {
  html,
  makeEventId,
  json,
  optionalTrimmedString,
  readRecordBody,
  text,
} from "../../../framework/http";
import type { AgentLoaderContext, AgentRouteModule } from "../../../framework/agent-types";
import { agentRunStream } from "../../agent.streams";
import type { AgentCmd, AgentEvent, AgentState } from "../../../modules/agent";
import type { JobRecord } from "../../../modules/job";
import {
  factoryChatStream,
  factoryChatSessionStream,
  type FactoryChatProfile,
  discoverFactoryChatProfiles,
  resolveFactoryChatProfile,
} from "../../../services/factory-chat-profiles";
import {
  FactoryService,
  FactoryServiceError,
  type FactoryLiveOutputTargetKind,
} from "../../../services/factory-service";
import {
  buildFactoryWorkbenchShellSnapshot,
  factoryWorkbenchBlockIsland,
  factoryWorkbenchChatIsland,
  factoryWorkbenchHeaderIsland,
  factoryWorkbenchShell,
  factoryWorkbenchWorkspaceIsland,
} from "../../../views/factory/workbench/page";
import {
  toFactorySelectedObjectiveCard,
  toFactoryStateSelectedObjectiveCard,
} from "../../../views/factory/objective-presenters";
import { buildFactoryWorkbench } from "../../../views/factory-workbench";
import {
  type FactoryChatIslandModel,
  type FactoryChatItem,
  type FactoryChatObjectiveNav,
  type FactoryChatProfileNav,
  type FactoryChatShellModel,
  type FactoryChatJobNav,
  type FactoryInspectorPanel,
  type FactoryInspectorTab,
  type FactoryLiveRunCard,
  type FactorySelectedObjectiveCard,
  type FactoryNavModel,
  type FactoryInspectorModel,
  type FactoryInspectorTabsModel,
  type FactoryViewMode,
  type FactoryWorkbenchBlockModel,
  type FactoryWorkbenchDetailTab,
  type FactoryWorkbenchFilterKey,
  type FactoryWorkbenchFilterModel,
  type FactoryWorkbenchPageModel,
  type FactoryWorkbenchSectionModel,
  type FactoryWorkbenchStatModel,
  type FactoryWorkbenchWorkspaceModel,
} from "../../../views/factory-models";
import type { QueueJob } from "../../../adapters/jsonl-queue";
import { readObjectiveAnalysis } from "../../../factory-cli/analyze";
import {
  inferObjectiveProfileHint,
  parseComposerDraft,
} from "../../../factory-cli/composer";
import {
  sliceReceiptRecords,
  buildReceiptTimeline,
  type ReceiptFileInfo,
  type ReceiptRecord,
} from "../../../adapters/receipt-tools";
import {
  getReceiptDb,
  listReceiptStreams,
  readReceiptsByStream,
  countReceiptsInStream,
} from "../../../db/client";
import {
  receiptShell,
  receiptFoldsHtml,
  receiptRecordsHtml,
  receiptSideHtml,
} from "../../../views/receipt";
import { parseOrder, parseLimit, parseInspectorDepth } from "../../../framework/http";
import { buildChatItemsForRun } from "../chat-items";
import {
  groupFactoryChatConversationByRunId,
  projectFactoryChatContextFromReceipts,
  withFactoryChatContextImports,
  type FactoryChatContextImports,
  type FactoryChatContextMessage,
  type FactoryChatContextProjection,
} from "../chat-context";
import {
  buildChatLink,
  latestObjectiveIdFromJobs,
  latestObjectiveIdFromRunChains,
  normalizeKnownObjectiveId,
  resolveChatViewStream,
} from "../links";
import {
  buildActiveCodexCard,
  buildLiveChildCards,
  collectRunIds,
  collectRunLineageIds,
  jobMatchesRunIds,
  summarizeActiveRunCard,
  summarizePendingRunJob,
  summarizeJob,
} from "../live-jobs";
import {
  buildObjectiveNavCards,
  collectTerminalRunIds,
} from "../page-builders";
import { describeProfileMarkdown } from "../profile-markdown";
import { projectAgentRun } from "../run-projection";
import {
  asString,
  compareJobsByRecency,
  isActiveJobStatus,
  isRelevantShellJob,
  jobAnyRunId,
  jobObjectiveId,
  jobParentRunId,
  jobRunId,
  type AgentRunChain,
} from "../shared";
import {
  readChatContextProjection,
  readChatContextProjectionVersion,
  syncChangedChatContextProjections,
  syncChatContextProjectionStream,
} from "../../../db/projectors";
import {
  buildWorkbenchLink,
  navigationError,
  workbenchNavigationResponse,
} from "./navigation";
import { createFactoryRouteCache } from "./cache";
import { createFactoryRouteEvents } from "./events";
import {
  isTerminalObjectiveStatus,
  makeFactoryChatId,
  makeFactoryRunId,
  normalizeFocusKind,
  normalizedDefaultInspectorTab,
  normalizedWorkbenchDetailTab,
  normalizedWorkbenchInspectorTab,
  objectiveProfileIdForPrompt,
  requestedChatId,
  requestedFocusId,
  requestedFocusKind,
  requestedInspectorTab,
  requestedJobId,
  requestedObjectiveId,
  requestedProfileId,
  requestedRunId,
  requestedWorkbenchDetailTab,
  requestedWorkbenchFilter,
} from "./params";

type FactoryObjectiveListItem = Awaited<ReturnType<FactoryService["listObjectives"]>>[number];
type FactoryObjectiveDetailRecord = Awaited<ReturnType<FactoryService["getObjective"]>>;
type FactoryObjectiveStateRecord = Awaited<ReturnType<FactoryService["getObjectiveState"]>>;

const createFactoryRoute = (ctx: AgentLoaderContext): AgentRouteModule => {
  const helpers = ctx.helpers ?? {};
  const service = (helpers.factoryService as FactoryService | undefined) ?? new FactoryService({
    dataDir: ctx.dataDir,
    queue: ctx.queue,
    jobRuntime: ctx.jobRuntime,
    sse: ctx.sse,
    codexExecutor: new LocalCodexExecutor(),
    memoryTools: helpers.memoryTools as MemoryTools | undefined,
  });
  const agentRuntime = ctx.runtimes.agent as Runtime<AgentCmd, AgentEvent, AgentState>;
  const profileRoot = path.resolve(typeof helpers.profileRoot === "string" ? helpers.profileRoot : process.cwd());
  const chatProjectionDataDir = typeof (service as { readonly dataDir?: unknown }).dataDir === "string"
    ? (service as { readonly dataDir: string }).dataDir
    : undefined;
  const routeCache = createFactoryRouteCache({
    ctx,
    service,
    profileRoot,
    agentRuntime,
    chatProjectionDataDir,
  });
  const {
    loadRecentJobs,
    loadFactoryProfiles,
    resolveObjectiveProjectionVersion,
    resolveSessionStreamVersion,
    loadChatContextProjectionForSession,
    withProjectionCache,
    projectionCacheTtlMs,
    chatShellCache,
  } = routeCache;

  const wrap = async <T>(
    fn: () => Promise<T>,
    render: (value: T) => Response,
  ): Promise<Response> => {
    try {
      return render(await fn());
    } catch (err) {
      if (err instanceof FactoryServiceError) return text(err.status, err.message);
      const message = err instanceof Error ? err.message : "factory server error";
      console.error(err);
      return text(500, message);
    }
  };

const resolveWatchedObjectiveId = async (value: string | undefined): Promise<string | undefined> => {
    if (!value) return undefined;
    const objectives = await service.listObjectives();
    const exact = objectives.find((objective) => objective.objectiveId === value);
    if (exact) return exact.objectiveId;
    const prefix = objectives.find((objective) => objective.objectiveId.startsWith(value));
    return prefix?.objectiveId;
  };

  const resolveComposerJob = async (
    objectiveId: string | undefined,
    preferredJobId: string | undefined,
  ): Promise<QueueJob> => {
    if (preferredJobId) {
      const preferred = await ctx.queue.getJob(preferredJobId);
      if (preferred) return preferred;
    }
    if (!objectiveId) throw new FactoryServiceError(409, "Select an objective before sending job commands.");
    const jobs = (await loadRecentJobs(160))
      .filter((job) => jobObjectiveId(job) === objectiveId)
      .sort((left, right) => {
        const leftActive = isActiveJobStatus(left.status) ? 1 : 0;
        const rightActive = isActiveJobStatus(right.status) ? 1 : 0;
        return rightActive - leftActive
          || right.updatedAt - left.updatedAt
          || right.createdAt - left.createdAt
          || right.id.localeCompare(left.id);
      });
    const active = jobs.find((job) => isActiveJobStatus(job.status));
    if (active) return active;
    const detail = await service.getObjective(objectiveId);
    const taskJobId = detail.tasks.find((task) => isActiveJobStatus(task.jobStatus) && task.jobId)?.jobId;
    if (taskJobId) {
      const queued = await ctx.queue.getJob(taskJobId);
      if (queued) return queued;
    }
    throw new FactoryServiceError(409, "Selected objective has no active job to control.");
  };

  const sidebarCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<{ readonly nav: FactoryNavModel; readonly selectedObjective?: FactorySelectedObjectiveCard }>;
  }>();
  const inspectorTabsCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<FactoryInspectorTabsModel>;
  }>();
  const inspectorPanelCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<FactoryInspectorModel>;
  }>();
  const workbenchPageCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<FactoryWorkbenchPageModel>;
  }>();

  const latestRuntimeImportSummary = (input: {
    readonly workbench?: FactoryChatIslandModel["workbench"];
    readonly objectiveId?: string;
    readonly activeCodex?: FactoryInspectorModel["activeCodex"];
    readonly liveChildren?: FactoryInspectorModel["liveChildren"];
  }): FactoryChatContextImports["runtime"] => {
    const focus = input.workbench?.focus;
    if (focus) {
      return {
        summary: focus.summary || `${focus.title} is ${focus.status}.`,
        importedBecause: "requested",
        objectiveId: input.objectiveId,
        focusKind: focus.focusKind,
        focusId: focus.focusId,
        active: focus.active === true || focus.status === "running" || focus.status === "queued",
      };
    }
    if (input.activeCodex) {
      return {
        summary: input.activeCodex.latestNote ?? input.activeCodex.summary,
        importedBecause: "requested",
        objectiveId: input.objectiveId,
        focusKind: "job",
        focusId: input.activeCodex.jobId,
        active: input.activeCodex.running,
      };
    }
    const liveChild = input.liveChildren?.[0];
    if (!liveChild) return undefined;
    return {
      summary: liveChild.latestNote ?? liveChild.summary,
      importedBecause: "requested",
      focusKind: "job",
      focusId: liveChild.jobId,
      active: liveChild.running,
    };
  };

  const withChatContextViewImports = (
    chatContext: FactoryChatContextProjection | undefined,
    input: {
      readonly selectedObjective?: FactorySelectedObjectiveCard;
      readonly workbench?: FactoryChatIslandModel["workbench"];
      readonly activeCodex?: FactoryInspectorModel["activeCodex"];
      readonly liveChildren?: FactoryInspectorModel["liveChildren"];
    },
  ): FactoryChatContextProjection | undefined => {
    if (!chatContext) return undefined;
    const imports: FactoryChatContextImports = {
      ...(input.selectedObjective ? {
        objective: {
          objectiveId: input.selectedObjective.objectiveId,
          title: input.selectedObjective.title,
          status: input.selectedObjective.status,
          phase: input.selectedObjective.phase,
          summary: input.selectedObjective.blockedReason
            ?? input.selectedObjective.nextAction
            ?? input.selectedObjective.latestDecisionSummary
            ?? input.selectedObjective.summary
            ?? `${input.selectedObjective.title} is ${input.selectedObjective.status}.`,
          importedBecause: "requested" as const,
        },
      } : {}),
      ...((() => latestRuntimeImportSummary({
        workbench: input.workbench,
        objectiveId: input.selectedObjective?.objectiveId,
        activeCodex: input.activeCodex,
        liveChildren: input.liveChildren,
      }))() ? {
        runtime: latestRuntimeImportSummary({
          workbench: input.workbench,
          objectiveId: input.selectedObjective?.objectiveId,
          activeCodex: input.activeCodex,
          liveChildren: input.liveChildren,
        }),
      } : {}),
    };
    return withFactoryChatContextImports(chatContext, imports);
  };

  const objectiveIdFromRunChain = (chain: AgentRunChain): string | undefined => {
    const projection = projectAgentRun(chain);
    return projection.state.thread?.objectiveId
      ?? asString(projection.state.config?.extra?.objectiveId)
      ?? latestObjectiveIdFromRunChains([chain]);
  };

  const scopeRunTimelineToObjective = (input: {
    readonly objectiveId?: string;
    readonly runIds: ReadonlyArray<string>;
    readonly runChains: ReadonlyArray<AgentRunChain>;
    readonly jobs?: ReadonlyArray<QueueJob>;
  }): {
    readonly runIds: ReadonlyArray<string>;
    readonly runChains: ReadonlyArray<AgentRunChain>;
  } => {
    const objectiveId = input.objectiveId?.trim();
    if (!objectiveId) return {
        runIds: input.runIds,
        runChains: input.runChains,
      };
    const objectiveRunIds = new Set<string>(
      (input.jobs ?? [])
        .flatMap((job) => jobObjectiveId(job) === objectiveId
          ? [jobRunId(job), jobParentRunId(job), jobAnyRunId(job)]
          : [])
        .filter((runId): runId is string => typeof runId === "string" && runId.trim().length > 0),
    );
    const scoped = input.runIds.flatMap((runId, index) => {
      const chain = input.runChains[index];
      if (!chain) return [];
      const runObjectiveId = objectiveIdFromRunChain(chain);
      if (runObjectiveId && runObjectiveId !== objectiveId) return [];
      if (!runObjectiveId && !objectiveRunIds.has(runId)) return [];
      return [{ runId, chain }] as const;
    });
    return {
      runIds: scoped.map((entry) => entry.runId),
      runChains: scoped.map((entry) => entry.chain),
    };
  };

  type ObjectiveHandoffView = {
    readonly objectiveId: string;
    readonly title: string;
    readonly status: string;
    readonly phase: string;
    readonly updatedAt?: number;
    readonly summary?: string;
    readonly latestSummary?: string;
    readonly blockedReason?: string;
    readonly blockedExplanation?: string | { readonly summary: string };
    readonly nextAction?: string;
    readonly latestDecision?: {
      readonly summary: string;
      readonly at: number;
    };
    readonly latestDecisionSummary?: string;
    readonly latestDecisionAt?: number;
    readonly latestHandoff?: {
      readonly status: "blocked" | "completed" | "failed" | "canceled";
      readonly summary: string;
      readonly output?: string;
      readonly blocker?: string;
      readonly nextAction?: string;
      readonly handoffKey: string;
      readonly sourceUpdatedAt: number;
    };
  };

  const objectiveHandoffStatus = (
    objective: Pick<ObjectiveHandoffView, "status" | "phase">,
  ): "blocked" | "completed" | "failed" | "canceled" | undefined => {
    const phase = optionalTrimmedString(objective.phase)?.toLowerCase();
    if (phase === "blocked" || phase === "completed" || phase === "failed" || phase === "canceled") return phase;
    const status = optionalTrimmedString(objective.status)?.toLowerCase();
    if (status === "blocked" || status === "completed" || status === "failed" || status === "canceled") return status;
    return undefined;
  };

  const objectiveBlockedExplanation = (
    objective: Pick<ObjectiveHandoffView, "blockedExplanation" | "blockedReason">,
  ): string | undefined => {
    const structured = objective.blockedExplanation;
    if (typeof structured === "string") return optionalTrimmedString(structured);
    return optionalTrimmedString(structured?.summary) ?? optionalTrimmedString(objective.blockedReason);
  };

  const isGenericCompletedNextAction = (value?: string): boolean => {
    const normalized = optionalTrimmedString(value)?.toLowerCase();
    return normalized === "investigation is complete." || normalized === "objective is complete.";
  };

  const buildObjectiveHandoffPayload = (
    objective: ObjectiveHandoffView,
  ): Extract<AgentEvent, { readonly type: "objective.handoff" }> | undefined => {
    if (objective.latestHandoff) {
      return {
        type: "objective.handoff",
        runId: `run_objective_handoff_${objective.objectiveId}_${objective.latestHandoff.handoffKey}`,
        agentId: "orchestrator",
        objectiveId: objective.objectiveId,
        title: objective.title,
        status: objective.latestHandoff.status,
        summary: objective.latestHandoff.summary,
        ...(objective.latestHandoff.output ? { output: objective.latestHandoff.output } : {}),
        ...(objective.latestHandoff.blocker ? { blocker: objective.latestHandoff.blocker } : {}),
        ...(objective.latestHandoff.nextAction ? { nextAction: objective.latestHandoff.nextAction } : {}),
        handoffKey: objective.latestHandoff.handoffKey,
        sourceUpdatedAt: objective.latestHandoff.sourceUpdatedAt,
      };
    }
    const status = objectiveHandoffStatus(objective);
    if (!status) return undefined;
    const summary = optionalTrimmedString(
      objective.summary
      ?? objective.latestSummary
      ?? objectiveBlockedExplanation(objective)
      ?? objective.latestDecision?.summary
      ?? objective.latestDecisionSummary
      ?? `${objective.title} is ${status}.`,
    ) ?? `${objective.title} is ${status}.`;
    const blocker = status === "blocked" ? objectiveBlockedExplanation(objective) : undefined;
    const nextAction = optionalTrimmedString(objective.nextAction);
    const effectiveNextAction = status === "completed" && isGenericCompletedNextAction(nextAction)
      ? undefined
      : nextAction;
    const sourceUpdatedAt = objective.latestDecision?.at
      ?? objective.latestDecisionAt
      ?? objective.updatedAt
      ?? 0;
    const handoffKey = createHash("sha1")
      .update(JSON.stringify({
        objectiveId: objective.objectiveId,
        status,
        summary,
        blocker,
        nextAction: effectiveNextAction,
        sourceUpdatedAt,
      }))
      .digest("hex")
      .slice(0, 16);
    return {
      type: "objective.handoff",
      runId: `run_objective_handoff_${objective.objectiveId}_${handoffKey}`,
      agentId: "orchestrator",
      objectiveId: objective.objectiveId,
      title: objective.title,
      status,
      summary,
      ...(blocker ? { blocker } : {}),
      ...(effectiveNextAction ? { nextAction: effectiveNextAction } : {}),
      handoffKey,
      sourceUpdatedAt,
    };
  };

  const ensureObjectiveHandoffInSession = async (input: {
    readonly profileId: string;
    readonly chatId?: string;
    readonly objective?: ObjectiveHandoffView;
  }): Promise<void> => {
    if (!input.chatId || !input.objective) return;
    const handoff = buildObjectiveHandoffPayload(input.objective);
    if (!handoff) return;
    const sessionStream = factoryChatSessionStream(service.git.repoRoot, input.profileId, input.chatId);
    const sessionChain = await agentRuntime.chain(sessionStream);
    const latestSessionHandoff = [...sessionChain].reverse().find((receipt) =>
      receipt.body.type === "objective.handoff"
      && receipt.body.objectiveId === handoff.objectiveId,
    )?.body;
    const sessionHasHandoff = latestSessionHandoff?.type === "objective.handoff"
      && latestSessionHandoff.handoffKey === handoff.handoffKey;
    const runStream = agentRunStream(sessionStream, handoff.runId);
    const runChain = await agentRuntime.chain(runStream);
    const runHasHandoff = runChain.some((receipt) =>
      receipt.body.type === "objective.handoff"
      && receipt.body.handoffKey === handoff.handoffKey
    );
    if (sessionHasHandoff && runHasHandoff) return;
    const events: ReadonlyArray<AgentEvent> = [
      {
        type: "problem.set",
        runId: handoff.runId,
        agentId: "orchestrator",
        problem: `Objective handoff for ${handoff.title}`,
      },
      {
        type: "thread.bound",
        runId: handoff.runId,
        agentId: "orchestrator",
        objectiveId: handoff.objectiveId,
        chatId: input.chatId,
        reason: "dispatch_update",
      },
      handoff,
      {
        type: "run.status",
        runId: handoff.runId,
        agentId: "orchestrator",
        status: "completed",
        note: `objective ${handoff.status} handoff`,
      },
    ];
    if (!runHasHandoff) {
      for (const event of events) {
        await agentRuntime.execute(runStream, {
          type: "emit",
          eventId: makeEventId(runStream),
          event,
        });
      }
    }
    if (!sessionHasHandoff) {
      for (const event of events) {
        await agentRuntime.execute(sessionStream, {
          type: "emit",
          eventId: makeEventId(sessionStream),
          event,
        });
      }
    }
  };

  const queueJobFromRecord = (job: JobRecord): QueueJob => ({
    id: job.id,
    agentId: job.agentId,
    lane: job.lane,
    sessionKey: job.sessionKey,
    singletonMode: job.singletonMode,
    payload: { ...job.payload },
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    leaseOwner: job.workerId,
    leaseUntil: job.leaseUntil,
    lastError: job.lastError,
    result: job.result ? { ...job.result } : undefined,
    canceledReason: job.canceledReason,
    abortRequested: job.abortRequested,
    commands: job.commands.map((command) => ({
      ...command,
      payload: command.payload ? { ...command.payload } : undefined,
    })),
  });

  const collectExplicitObjectiveJobs = async (
    detail: Awaited<ReturnType<FactoryService["getObjective"]>> | undefined,
    selectedJobId?: string,
  ): Promise<{
    readonly jobs: ReadonlyArray<QueueJob>;
    readonly selectedJob?: QueueJob;
  }> => {
    const jobsById = new Map<string, QueueJob>();
    for (const task of detail?.tasks ?? []) {
      if (!task.job) continue;
      jobsById.set(task.job.id, queueJobFromRecord(task.job));
    }
    let selectedJob = selectedJobId ? jobsById.get(selectedJobId) : undefined;
    if (!selectedJob && selectedJobId) {
      selectedJob = await ctx.queue.getJob(selectedJobId);
    }
    const jobs = [...jobsById.values()].sort(compareJobsByRecency);
    return {
      jobs,
      selectedJob,
    };
  };

  const buildWorkbenchSessionRuntime = async (input: {
    readonly repoRoot: string;
    readonly profileId: string;
    readonly profileLabel: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly seedJobs?: ReadonlyArray<QueueJob>;
    readonly mode?: FactoryViewMode;
  }): Promise<{
    readonly stream?: string;
    readonly scopedJobs: ReadonlyArray<QueueJob>;
    readonly runIds: ReadonlyArray<string>;
    readonly runChains: ReadonlyArray<AgentRunChain>;
    readonly activeRunId?: string;
    readonly activeRun?: FactoryLiveRunCard;
    readonly activeCodex?: FactoryInspectorModel["activeCodex"];
    readonly liveChildren: ReadonlyArray<NonNullable<FactoryInspectorModel["liveChildren"]>[number]>;
  }> => {
    if (!input.chatId) {
      const scopedJobs = [...(input.seedJobs ?? [])].sort(compareJobsByRecency).slice(0, 24);
      return {
        scopedJobs,
        runIds: [],
        runChains: [],
        activeRunId: undefined,
        activeRun: undefined,
        activeCodex: buildActiveCodexCard(scopedJobs),
        liveChildren: [],
      };
    }
    const stream = factoryChatSessionStream(input.repoRoot, input.profileId, input.chatId);
    const indexChain = await agentRuntime.chain(stream);
    const runIds = collectRunIds(indexChain);
    const recentJobs = runIds.length > 0 ? await loadRecentJobs(80) : [];
    const jobsById = new Map<string, QueueJob>();
    for (const job of input.seedJobs ?? []) jobsById.set(job.id, job);
    for (const job of recentJobs) jobsById.set(job.id, job);
    const scopedJobs = [...jobsById.values()]
      .filter((job) =>
        asString(job.payload.chatId) === input.chatId
        || isRelevantShellJob(job, stream, input.objectiveId))
      .sort(compareJobsByRecency)
      .slice(0, 24);
    const collectedRunChains = await Promise.all(
      runIds.map((runId) => agentRuntime.chain(agentRunStream(stream, runId))),
    );
    const scopedRunTimeline = scopeRunTimelineToObjective({
      objectiveId: input.objectiveId,
      runIds,
      runChains: collectedRunChains,
      jobs: scopedJobs,
    });
    const scopedRunIds = scopedRunTimeline.runIds;
    const runChains = scopedRunTimeline.runChains;
    const runChainsById = new Map(scopedRunIds.map((runId, index) => [runId, runChains[index]!] as const));
    const activeRunId = scopedRunIds.at(-1);
    const activeRunLineageIds = activeRunId
      ? collectRunLineageIds([activeRunId], runChainsById, scopedJobs)
      : new Set<string>();
    const activeRunJobs = activeRunLineageIds.size > 0
      ? scopedJobs.filter((job) => jobMatchesRunIds(job, activeRunLineageIds))
      : scopedJobs.filter((job) => jobMatchesRunIds(job, new Set([activeRunId].filter(Boolean) as string[])));
    const activeRunIndex = activeRunId ? scopedRunIds.indexOf(activeRunId) : -1;
    const activeRun = activeRunIndex >= 0
      ? summarizeActiveRunCard({
          mode: input.mode,
          runId: activeRunId!,
          runChain: runChains[activeRunIndex]!,
          relatedJobs: activeRunJobs,
          profileLabel: input.profileLabel,
          profileId: input.profileId,
          chatId: input.chatId,
          objectiveId: input.objectiveId,
        })
      : undefined;
    return {
      stream,
      scopedJobs,
      runIds: scopedRunIds,
      runChains,
      activeRunId,
      activeRun,
      activeCodex: buildActiveCodexCard(scopedJobs),
      liveChildren: buildLiveChildCards(scopedJobs, stream, input.objectiveId),
    };
  };

  const mergeExplicitObjectiveIntoCards = (
    objectives: ReadonlyArray<FactoryObjectiveListItem>,
    detail: FactoryObjectiveDetailRecord | undefined,
  ): ReadonlyArray<FactoryObjectiveListItem> => {
    if (!detail || objectives.some((objective) => objective.objectiveId === detail.objectiveId)) return objectives;
    return [detail, ...objectives];
  };

  const loadExplicitObjectiveContext = async (input: {
    readonly profileId?: string;
    readonly objectiveId: string;
    readonly selectedJobId?: string;
  }): Promise<{
    readonly objectiveId: string;
    readonly resolvedProfile: FactoryChatProfile;
    readonly effectiveProfile: FactoryChatProfile;
    readonly profiles: ReadonlyArray<FactoryChatProfile>;
    readonly objectives: ReadonlyArray<FactoryObjectiveListItem>;
    readonly state?: FactoryObjectiveStateRecord;
    readonly detail?: FactoryObjectiveDetailRecord;
    readonly selectedObjective?: FactorySelectedObjectiveCard;
    readonly recentJobs: ReadonlyArray<QueueJob>;
    readonly selectedJob?: QueueJob;
  }> => {
    await service.ensureBootstrap();
    const repoRoot = service.git.repoRoot;
    const [resolved, profiles, state, detail, objectives] = await Promise.all([
      resolveFactoryChatProfile({
        repoRoot,
        profileRoot,
        requestedId: input.profileId,
      }),
      loadFactoryProfiles(),
      service.getObjectiveState(input.objectiveId).catch(() => undefined),
      service.getObjective(input.objectiveId).catch((err) => {
        if (err instanceof FactoryServiceError && err.status === 404) return undefined;
        throw err;
      }),
      service.listObjectives(),
    ]);
    const effectiveProfileId = detail?.profile.rootProfileId ?? state?.profile.rootProfileId;
    const effectiveProfile = profiles.find((profile) => profile.id === effectiveProfileId) ?? resolved.root;
    const { jobs: objectiveJobs, selectedJob } = await collectExplicitObjectiveJobs(detail, input.selectedJobId);
    const recentJobs = selectedJob && !objectiveJobs.some((job) => job.id === selectedJob.id)
      ? [selectedJob, ...objectiveJobs]
      : objectiveJobs;
    return {
      objectiveId: input.objectiveId,
      resolvedProfile: resolved.root,
      effectiveProfile,
      profiles,
      objectives: mergeExplicitObjectiveIntoCards(objectives, detail),
      state,
      detail,
      selectedObjective: detail
        ? toFactorySelectedObjectiveCard(detail)
        : state
          ? toFactoryStateSelectedObjectiveCard(state)
          : undefined,
      recentJobs,
      selectedJob,
    };
  };

  const matchesObjectiveProfile = (
    objective: Pick<FactoryObjectiveListItem, "profile"> | Pick<FactorySelectedObjectiveCard, "profileId"> | undefined,
    profileId: string | undefined,
  ): boolean => {
    if (!objective || !profileId) return false;
    const objectiveProfileId = "profile" in objective
      ? objective.profile.rootProfileId
      : objective.profileId;
    return objectiveProfileId === profileId;
  };

  const filterObjectivesByProfile = (
    objectives: ReadonlyArray<FactoryObjectiveListItem>,
    profileId: string,
  ): ReadonlyArray<FactoryObjectiveListItem> =>
    objectives.filter((objective) => objective.profile.rootProfileId === profileId);

  const resolveSessionObjectiveId = async (input: {
    readonly repoRoot: string;
    readonly profileId: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly selectedJob?: QueueJob;
    readonly jobs: ReadonlyArray<QueueJob>;
    readonly liveObjectives?: ReadonlyArray<{ readonly objectiveId: string }>;
    readonly allowExplicitFallback?: boolean;
  }): Promise<string | undefined> => {
    const liveObjectives = input.liveObjectives ?? [];
    const requestedObjectiveId = normalizeKnownObjectiveId(input.objectiveId, liveObjectives);
    if (requestedObjectiveId) return requestedObjectiveId;
    const explicitObjectiveId = input.objectiveId?.trim();
    if (input.allowExplicitFallback && explicitObjectiveId) return explicitObjectiveId;
    const selectedJobObjectiveId = normalizeKnownObjectiveId(jobObjectiveId(input.selectedJob), liveObjectives);
    if (selectedJobObjectiveId) return selectedJobObjectiveId;
    if (!selectedJobObjectiveId && input.allowExplicitFallback) {
      const explicitSelectedJobObjectiveId = jobObjectiveId(input.selectedJob);
      if (explicitSelectedJobObjectiveId) return explicitSelectedJobObjectiveId;
    }
    if (!input.chatId) return undefined;
    const stream = factoryChatSessionStream(input.repoRoot, input.profileId, input.chatId);
    const projected = await loadChatContextProjectionForSession({ sessionStream: stream });
    const projectedObjectiveId = normalizeKnownObjectiveId(projected?.bindings.objectiveId, liveObjectives);
    if (projectedObjectiveId) return projectedObjectiveId;
    if (!projectedObjectiveId && input.allowExplicitFallback && projected?.bindings.objectiveId) {
      return projected.bindings.objectiveId;
    }
    const indexChain = await agentRuntime.chain(stream);
    const runIds = collectRunIds(indexChain);
    const runChains = await Promise.all(runIds.map((runId) => agentRuntime.chain(agentRunStream(stream, runId))));
    const discoveredObjectiveId = latestObjectiveIdFromRunChains(runChains)
      ?? latestObjectiveIdFromJobs(input.jobs, stream, input.chatId);
    return normalizeKnownObjectiveId(
      discoveredObjectiveId,
      liveObjectives,
    ) ?? (
      input.allowExplicitFallback
        ? discoveredObjectiveId
        : undefined
    );
  };

  const routeEvents = createFactoryRouteEvents({
    ctx,
    service,
    profileRoot,
    loadRecentJobs,
    resolveSessionObjectiveId,
  });
  const {
    resolveChatEventSubscriptions,
    subscribeChatEventStream,
  } = routeEvents;

  const buildChatShellModel = async (input: {
    readonly mode?: FactoryViewMode;
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly showAll?: boolean;
  }): Promise<FactoryChatShellModel> => {
    await service.ensureBootstrap();
    const explicitObjectiveId = input.objectiveId?.trim();
    const repoRoot = service.git.repoRoot;
    const [resolved, profiles] = await Promise.all([
      resolveFactoryChatProfile({
        repoRoot,
        profileRoot,
        requestedId: input.profileId,
      }),
      loadFactoryProfiles(),
    ]);
    let objectivesPromise: Promise<Awaited<ReturnType<FactoryService["listObjectives"]>>> | undefined;
    const loadObjectives = (): Promise<Awaited<ReturnType<FactoryService["listObjectives"]>>> => {
      objectivesPromise ??= service.listObjectives({ profileId: resolved.root.id });
      return objectivesPromise;
    };
    let initialSessionStream: string | undefined;
    let initialIndexChain: Awaited<ReturnType<typeof agentRuntime.chain>> = [];
    let initialChatContext: FactoryChatContextProjection | undefined;
    let jobs: ReadonlyArray<QueueJob> = [];
    let chatMatchesExplicitObjective = false;

    if (!explicitObjectiveId && (input.jobId || input.runId)) {
      jobs = await loadRecentJobs();
    } else if (input.chatId) {
      initialSessionStream = factoryChatSessionStream(repoRoot, resolved.root.id, input.chatId);
      initialIndexChain = await agentRuntime.chain(initialSessionStream);
      initialChatContext = await loadChatContextProjectionForSession({
        sessionStream: initialSessionStream,
        fallbackChain: initialIndexChain,
      });
      const initialRunIds = collectRunIds(initialIndexChain);
      if (initialRunIds.length > 0) {
        jobs = await loadRecentJobs();
        if (explicitObjectiveId) {
          const discoveredObjectiveId = initialChatContext?.bindings.objectiveId
            ?? latestObjectiveIdFromRunChains(await Promise.all(
              initialRunIds.map((runId) => agentRuntime.chain(agentRunStream(initialSessionStream!, runId))),
            ))
            ?? latestObjectiveIdFromJobs(jobs, initialSessionStream, input.chatId);
          chatMatchesExplicitObjective = discoveredObjectiveId === explicitObjectiveId;
        }
      }
    }

    if (explicitObjectiveId && (!input.chatId || !chatMatchesExplicitObjective)) {
      const {
        resolvedProfile,
        effectiveProfile,
        profiles,
        objectives,
        state,
        detail,
        selectedObjective,
        recentJobs: relevantObjectiveJobs,
        selectedJob,
      } = await loadExplicitObjectiveContext({
        profileId: input.profileId,
        objectiveId: explicitObjectiveId,
        selectedJobId: input.jobId,
      });
      if (!state && !detail) {
        return buildMissingExplicitThreadShellModel({
          mode: input.mode,
          resolvedProfile,
          profiles,
          objectives,
          objectiveId: explicitObjectiveId,
          runId: input.runId,
          jobId: input.jobId,
          panel: input.panel,
          focusKind: input.focusKind,
          focusId: input.focusId,
          showAll: input.showAll,
        });
      }
      const activeProfileOverview = describeProfileMarkdown(effectiveProfile);
      const jobsById = new Map(relevantObjectiveJobs.map((job) => [job.id, job] as const));
      await ensureObjectiveHandoffInSession({
        profileId: effectiveProfile.id,
        chatId: input.chatId,
        objective: selectedObjective,
      });
      const sessionChatContext = input.chatId
        ? withChatContextViewImports(
            await loadChatContextProjectionForSession({
              sessionStream: factoryChatSessionStream(repoRoot, effectiveProfile.id, input.chatId),
              fallbackChain: initialSessionStream === factoryChatSessionStream(repoRoot, effectiveProfile.id, input.chatId)
                ? initialIndexChain
                : await agentRuntime.chain(factoryChatSessionStream(repoRoot, effectiveProfile.id, input.chatId)),
            }),
            {
              selectedObjective,
              workbench: undefined,
              activeCodex: undefined,
              liveChildren: undefined,
            },
          )
        : undefined;
      const stream = resolveChatViewStream({
        repoRoot,
        profileId: effectiveProfile.id,
        objectiveId: explicitObjectiveId,
        job: selectedJob,
      });
      const indexChain = stream ? await agentRuntime.chain(stream) : [];
      const allRunIds = collectRunIds(indexChain);
      const requestedRunIndex = input.runId ? allRunIds.indexOf(input.runId) : -1;
      const runIds = requestedRunIndex >= 0 ? allRunIds.slice(requestedRunIndex) : allRunIds;
      const conversationByRunId = groupFactoryChatConversationByRunId(sessionChatContext?.conversation);
      const runChains = await Promise.all(runIds.map((runId) => stream ? agentRuntime.chain(agentRunStream(stream, runId)) : Promise.resolve([])));
      const chatItems = runChains.flatMap((runChain, index) => buildChatItemsForRun(
        runIds[index]!,
        runChain,
        jobsById,
        { conversation: conversationByRunId.get(runIds[index]!) },
      ));
      const activeRunId = runIds.at(-1) ?? input.runId;
      const initialWorkbench = detail
        ? buildFactoryWorkbench({
            detail,
            recentJobs: relevantObjectiveJobs,
            requestedFocusKind: input.focusKind,
            requestedFocusId: input.focusId,
          })
        : undefined;
      const liveOutput = detail && initialWorkbench?.focus
        ? await service.getObjectiveLiveOutput(
            explicitObjectiveId,
            initialWorkbench.focus.focusKind,
            initialWorkbench.focus.focusId,
          ).catch(() => undefined)
        : undefined;
      const workbench = detail
        ? buildFactoryWorkbench({
            detail,
            recentJobs: relevantObjectiveJobs,
            requestedFocusKind: initialWorkbench?.focus?.focusKind ?? input.focusKind,
            requestedFocusId: initialWorkbench?.focus?.focusId ?? input.focusId,
            liveOutput,
          })
        : undefined;
      const resolvedFocusKind = workbench?.focus?.focusKind ?? input.focusKind;
      const resolvedFocusId = workbench?.focus?.focusId ?? input.focusId;
      const inspectorPanel = input.panel ?? (workbench?.hasActiveExecution ? "live" : "overview");
      const relevantJobs = relevantObjectiveJobs
        .slice(0, 12)
        .map((job) => ({
          jobId: job.id,
          agentId: job.agentId,
          status: job.status,
          summary: summarizeJob(job),
          runId: jobAnyRunId(job),
          objectiveId: jobObjectiveId(job),
          updatedAt: job.updatedAt,
          selected: job.id === input.jobId,
          link: buildChatLink({
            mode: input.mode,
            profileId: effectiveProfile.id,
            objectiveId: explicitObjectiveId,
            runId: jobAnyRunId(job),
            jobId: job.id,
            panel: inspectorPanel,
            inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
            focusKind: "job",
            focusId: job.id,
          }),
        } satisfies FactoryChatJobNav));
      const scopedObjectives = filterObjectivesByProfile(objectives, effectiveProfile.id);
      const profileNav = buildProfileNav({
        profiles,
        selectedProfileId: effectiveProfile.id,
        mode: input.mode,
        objectiveId: explicitObjectiveId,
        runId: activeRunId,
        jobId: input.jobId,
        panel: inspectorPanel,
        inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
        focusKind: resolvedFocusKind,
        focusId: resolvedFocusId,
        objectiveProfileId: selectedObjective?.profileId,
      });
      const objectiveNav: ReadonlyArray<FactoryChatObjectiveNav> = buildObjectiveNavCards(
        scopedObjectives,
        explicitObjectiveId,
        { includeArchivedSelectedOnly: true },
      );
      const activeCodex = buildActiveCodexCard(relevantObjectiveJobs);
      const liveChildren = stream
        ? buildLiveChildCards(relevantObjectiveJobs, stream, explicitObjectiveId)
        : [];
      const hydratedChatContext = withChatContextViewImports(sessionChatContext, {
        selectedObjective,
        workbench,
        activeCodex,
        liveChildren,
      });
      const activeRunIndex = activeRunId ? runIds.indexOf(activeRunId) : -1;
      const activeRun = activeRunIndex >= 0
        ? summarizeActiveRunCard({
            mode: input.mode,
            runId: activeRunId!,
            runChain: runChains[activeRunIndex]!,
            relatedJobs: relevantObjectiveJobs,
            profileLabel: effectiveProfile.label,
            profileId: effectiveProfile.id,
            objectiveId: explicitObjectiveId,
          })
        : selectedJob
          ? summarizePendingRunJob(selectedJob, effectiveProfile.label, input.mode)
          : undefined;
      const chatModel: FactoryChatIslandModel = {
        mode: input.mode,
        activeProfileId: effectiveProfile.id,
        activeProfileLabel: effectiveProfile.label,
        objectiveId: explicitObjectiveId,
        runId: activeRunId,
        knownRunIds: runIds,
        terminalRunIds: collectTerminalRunIds(runIds, runChains),
        jobId: input.jobId,
        panel: inspectorPanel,
        inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
        focusKind: resolvedFocusKind,
        focusId: resolvedFocusId,
        activeProfilePrimaryRole: activeProfileOverview.primaryRole,
        activeProfileRoles: activeProfileOverview.roles,
        activeProfileResponsibilities: activeProfileOverview.responsibilities,
        activeProfileSummary: activeProfileOverview.summary,
        activeProfileSoulSummary: activeProfileOverview.soulSummary,
        activeProfileProfileSummary: activeProfileOverview.profileSummary,
        activeProfileSections: activeProfileOverview.sections,
        selectedThread: selectedObjective,
        jobs: relevantJobs,
        activeCodex,
        liveChildren,
        activeRun,
        workbench,
        chatContext: hydratedChatContext,
        items: chatItems,
      };
      const navModel: FactoryNavModel = {
        mode: input.mode,
        activeProfileId: effectiveProfile.id,
        activeProfileLabel: effectiveProfile.label,
        panel: inspectorPanel,
        inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
        profiles: profileNav,
        objectives: objectiveNav,
        showAll: input.showAll,
      };
      const inspectorModel: FactoryInspectorModel = {
        mode: input.mode,
        panel: inspectorPanel,
        inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
        activeProfileId: effectiveProfile.id,
        activeProfileLabel: effectiveProfile.label,
        activeProfilePrimaryRole: activeProfileOverview.primaryRole,
        activeProfileSummary: activeProfileOverview.summary,
        activeProfileSoulSummary: activeProfileOverview.soulSummary,
        activeProfileProfileSummary: activeProfileOverview.profileSummary,
        activeProfileResponsibilities: activeProfileOverview.responsibilities,
        activeProfileSections: activeProfileOverview.sections,
        objectiveId: explicitObjectiveId,
        runId: activeRunId,
        jobId: input.jobId,
        focusKind: resolvedFocusKind,
        focusId: resolvedFocusId,
        selectedObjective,
        activeCodex,
        liveChildren,
        activeRun,
        workbench,
        chatContext: hydratedChatContext,
        jobs: relevantJobs,
        tasks: detail?.tasks,
      };
      return {
        mode: input.mode,
        activeProfileId: effectiveProfile.id,
        activeProfileLabel: effectiveProfile.label,
        objectiveId: explicitObjectiveId,
        runId: activeRunId,
        jobId: input.jobId,
        panel: inspectorPanel,
        inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
        focusKind: resolvedFocusKind,
        focusId: resolvedFocusId,
        chat: chatModel,
        nav: navModel,
        inspector: inspectorModel,
        };
      }

    if (input.chatId && !input.runId && !input.jobId && initialIndexChain.length === 0) {
      return buildUnselectedThreadShellModel({
        mode: input.mode,
        resolvedProfile: resolved.root,
        profiles,
        chatId: input.chatId,
        panel: input.panel,
        inspectorTab: input.inspectorTab,
        focusKind: input.focusKind,
        focusId: input.focusId,
        showAll: input.showAll,
      });
    }

    const objectives = await loadObjectives();
    const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
    const selectedJob = input.jobId ? jobsById.get(input.jobId) : undefined;
    const liveObjectives = objectives.filter((objective) => !objective.archivedAt);
    const resolvedObjectiveId = await resolveSessionObjectiveId({
      repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: input.objectiveId,
      selectedJob,
      jobs,
      liveObjectives,
      allowExplicitFallback: true,
    });
    const stream = resolveChatViewStream({
      repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      job: selectedJob,
    });
    const selectedObjective = resolvedObjectiveId
      ? await service.getObjective(resolvedObjectiveId).catch(err => {
          if (err instanceof FactoryServiceError && err.status === 404) return undefined;
          throw err;
        })
      : undefined;
    await ensureObjectiveHandoffInSession({
      profileId: resolved.root.id,
      chatId: input.chatId,
      objective: selectedObjective,
    });
    const indexChain = stream
      ? stream === initialSessionStream
        ? initialIndexChain
        : await agentRuntime.chain(stream)
      : [];
    const sessionChatContext = input.chatId && initialSessionStream
      ? await loadChatContextProjectionForSession({
          sessionStream: initialSessionStream,
          fallbackChain: indexChain,
        })
      : undefined;

    const allRunIds = collectRunIds(indexChain);
    const requestedRunIndex = input.runId ? allRunIds.indexOf(input.runId) : -1;
    const requestedRunIds = requestedRunIndex >= 0 ? allRunIds.slice(requestedRunIndex) : allRunIds;
    const collectedRunChains = await Promise.all(
      requestedRunIds.map((runId) => stream ? agentRuntime.chain(agentRunStream(stream, runId)) : Promise.resolve([])),
    );
    const scopedRunTimeline = scopeRunTimelineToObjective({
      objectiveId: resolvedObjectiveId,
      runIds: requestedRunIds,
      runChains: collectedRunChains,
      jobs,
    });
    const runIds = scopedRunTimeline.runIds;
    const runChains = scopedRunTimeline.runChains;
    const activeRunId = runIds.at(-1);
    const runChainsById = new Map(runIds.map((runId, index) => [runId, runChains[index]!] as const));
    const conversationByRunId = groupFactoryChatConversationByRunId(sessionChatContext?.conversation);
    const chatItems = runChains.flatMap((runChain, index) => buildChatItemsForRun(
      runIds[index]!,
      runChain,
      jobsById,
      { conversation: conversationByRunId.get(runIds[index]!) },
    ));
    const activeProfileOverview = describeProfileMarkdown(resolved.root);
    const baseQueueJobs = stream
      ? jobs.filter((job) => isRelevantShellJob(job, stream, resolvedObjectiveId))
      : [];
    const selectedRunIds = collectRunLineageIds(
      [
        input.runId,
        selectedJob ? jobRunId(selectedJob) : undefined,
        selectedJob ? jobParentRunId(selectedJob) : undefined,
      ],
      runChainsById,
      baseQueueJobs,
    );
    const relevantQueueJobs = selectedRunIds.size > 0 || input.jobId
      ? baseQueueJobs.filter((job) =>
          job.id === input.jobId
          || jobMatchesRunIds(job, selectedRunIds)
        )
      : baseQueueJobs;
    if (selectedJob && !relevantQueueJobs.some((job) => job.id === selectedJob.id)) {
      relevantQueueJobs.unshift(selectedJob);
    }
    const activeRunLineageIds = activeRunId
      ? collectRunLineageIds([activeRunId], runChainsById, relevantQueueJobs)
      : new Set<string>();
    const activeRunJobs = activeRunLineageIds.size > 0
      ? relevantQueueJobs.filter((job) => jobMatchesRunIds(job, activeRunLineageIds))
      : relevantQueueJobs.filter((job) => jobMatchesRunIds(job, new Set([activeRunId].filter(Boolean) as string[])));
    const activeCodex = buildActiveCodexCard(relevantQueueJobs);
    const liveChildren = stream
      ? buildLiveChildCards(relevantQueueJobs, stream, resolvedObjectiveId)
      : [];
    const activeRunIndex = activeRunId ? runIds.indexOf(activeRunId) : -1;
    const activeRun = activeRunIndex >= 0
      ? summarizeActiveRunCard({
          mode: input.mode,
          runId: activeRunId!,
          runChain: runChains[activeRunIndex]!,
          relatedJobs: activeRunJobs,
          profileLabel: resolved.root.label,
          profileId: resolved.root.id,
          chatId: input.chatId,
          objectiveId: resolvedObjectiveId,
        })
      : selectedJob
          ? summarizePendingRunJob(selectedJob, resolved.root.label, input.mode)
          : undefined;
    const relevantJobs = relevantQueueJobs
      .slice(0, 12)
      .map((job) => ({
        jobId: job.id,
        agentId: job.agentId,
        status: job.status,
        summary: summarizeJob(job),
        runId: jobAnyRunId(job),
        objectiveId: jobObjectiveId(job),
        updatedAt: job.updatedAt,
        selected: job.id === input.jobId,
        link: buildChatLink({
          mode: input.mode,
          profileId: resolved.root.id,
          chatId: input.chatId,
          objectiveId: jobObjectiveId(job),
          runId: jobAnyRunId(job),
          jobId: job.id,
          panel: input.panel,
          focusKind: "job",
          focusId: job.id,
        }),
      } satisfies FactoryChatJobNav));
    const selectedObjectiveCard: FactorySelectedObjectiveCard | undefined = selectedObjective
      ? toFactorySelectedObjectiveCard(selectedObjective)
      : undefined;
    const initialWorkbench = buildFactoryWorkbench({
      detail: selectedObjective,
      recentJobs: relevantQueueJobs,
      requestedFocusKind: input.focusKind,
      requestedFocusId: input.focusId,
    });
    const liveOutput = selectedObjective && initialWorkbench?.focus
      ? await service.getObjectiveLiveOutput(
          selectedObjective.objectiveId,
          initialWorkbench.focus.focusKind,
          initialWorkbench.focus.focusId,
        ).catch(() => undefined)
      : undefined;
    const workbench = buildFactoryWorkbench({
      detail: selectedObjective,
      recentJobs: relevantQueueJobs,
      requestedFocusKind: initialWorkbench?.focus?.focusKind ?? input.focusKind,
      requestedFocusId: initialWorkbench?.focus?.focusId ?? input.focusId,
      liveOutput,
    });
    const inspectorPanel = input.panel ?? (workbench?.hasActiveExecution ? "live" : "overview");
    const resolvedFocusKind = workbench?.focus?.focusKind;
    const resolvedFocusId = workbench?.focus?.focusId;
    const hydratedChatContext = withChatContextViewImports(sessionChatContext, {
      selectedObjective: selectedObjectiveCard,
      workbench,
      activeCodex,
      liveChildren,
    });
    const profileNav = buildProfileNav({
      profiles,
      selectedProfileId: resolved.root.id,
      mode: input.mode,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      runId: activeRunId,
      jobId: input.jobId,
      panel: inspectorPanel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      focusKind: resolvedFocusKind,
      focusId: resolvedFocusId,
      objectiveProfileId: selectedObjectiveCard?.profileId,
    });
    const objectiveNav: ReadonlyArray<FactoryChatObjectiveNav> = buildObjectiveNavCards(
      objectives,
      resolvedObjectiveId,
      { includeArchivedSelectedOnly: true },
    );

    const chatModel: FactoryChatIslandModel = {
      mode: input.mode,
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      runId: activeRunId,
      knownRunIds: runIds,
      terminalRunIds: collectTerminalRunIds(runIds, runChains),
      jobId: input.jobId,
      panel: inspectorPanel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      focusKind: resolvedFocusKind,
      focusId: resolvedFocusId,
      activeProfilePrimaryRole: activeProfileOverview.primaryRole,
      activeProfileRoles: activeProfileOverview.roles,
      activeProfileResponsibilities: activeProfileOverview.responsibilities,
      activeProfileSummary: activeProfileOverview.summary,
      activeProfileSoulSummary: activeProfileOverview.soulSummary,
      activeProfileProfileSummary: activeProfileOverview.profileSummary,
      activeProfileSections: activeProfileOverview.sections,
      activeProfileTools: resolved.toolAllowlist,
      selectedThread: selectedObjectiveCard,
      jobs: relevantJobs,
      activeCodex,
      liveChildren,
      activeRun,
      workbench,
      chatContext: hydratedChatContext,
      items: chatItems,
    };
    const navModel: FactoryNavModel = {
      mode: input.mode,
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      chatId: input.chatId,
      panel: inspectorPanel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      profiles: profileNav,
      objectives: objectiveNav,
      showAll: input.showAll,
    };
    const inspectorModel: FactoryInspectorModel = {
      mode: input.mode,
      panel: inspectorPanel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      activeProfilePrimaryRole: activeProfileOverview.primaryRole,
      activeProfileSummary: activeProfileOverview.summary,
      activeProfileSoulSummary: activeProfileOverview.soulSummary,
      activeProfileProfileSummary: activeProfileOverview.profileSummary,
      activeProfileResponsibilities: activeProfileOverview.responsibilities,
      activeProfileSections: activeProfileOverview.sections,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      runId: activeRunId,
      jobId: input.jobId,
      focusKind: resolvedFocusKind,
      focusId: resolvedFocusId,
      selectedObjective: selectedObjectiveCard,
      activeCodex,
      liveChildren,
      activeRun,
      workbench,
      chatContext: hydratedChatContext,
      jobs: relevantJobs,
      tasks: selectedObjective?.tasks,
      analysis: inspectorPanel === "analysis" && resolvedObjectiveId
        ? await readObjectiveAnalysis(service.dataDir, resolvedObjectiveId).catch(() => undefined)
        : undefined,
    };
    return {
      mode: input.mode,
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      runId: activeRunId,
      jobId: input.jobId,
      panel: inspectorPanel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      focusKind: resolvedFocusKind,
      focusId: resolvedFocusId,
      chat: chatModel,
      nav: navModel,
      inspector: inspectorModel,
    };
  };

  const buildSidebarModel = async (input: {
    readonly mode?: FactoryViewMode;
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly showAll?: boolean;
  }): Promise<{ readonly nav: FactoryNavModel; readonly selectedObjective?: FactorySelectedObjectiveCard }> => {
    await service.ensureBootstrap();
    const repoRoot = service.git.repoRoot;
    const explicitObjectiveId = input.objectiveId?.trim();
    if (explicitObjectiveId) {
      const explicitContext = await loadExplicitObjectiveContext({
        profileId: input.profileId,
        objectiveId: explicitObjectiveId,
        selectedJobId: input.jobId,
      });
      const scopedObjectives = filterObjectivesByProfile(
        explicitContext.objectives,
        explicitContext.effectiveProfile.id,
      );
      return {
        nav: {
          mode: input.mode,
          activeProfileId: explicitContext.effectiveProfile.id,
          activeProfileLabel: explicitContext.effectiveProfile.label,
          panel: input.panel,
          inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
          profiles: buildProfileNav({
            profiles: explicitContext.profiles,
            selectedProfileId: explicitContext.effectiveProfile.id,
            mode: input.mode,
            chatId: input.chatId,
            objectiveId: explicitObjectiveId,
            runId: input.runId,
            jobId: input.jobId,
            panel: input.panel,
            inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
            objectiveProfileId: explicitContext.selectedObjective?.profileId,
          }),
          objectives: buildObjectiveNavCards(
            scopedObjectives,
            explicitObjectiveId,
            { includeArchivedSelectedOnly: true },
          ),
          showAll: input.showAll,
        },
        selectedObjective: explicitContext.selectedObjective,
      };
    }
    const resolved = await resolveFactoryChatProfile({
      repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const profilesPromise = loadFactoryProfiles();
    let jobs: ReadonlyArray<QueueJob> = [];
    if (!explicitObjectiveId && (input.jobId || input.runId)) {
      jobs = await loadRecentJobs();
    } else if (input.chatId) {
      const initialSessionStream = factoryChatSessionStream(repoRoot, resolved.root.id, input.chatId);
      const indexChain = await agentRuntime.chain(initialSessionStream);
      if (collectRunIds(indexChain).length > 0) {
        jobs = await loadRecentJobs();
      }
    }
    const profiles = await profilesPromise;
    const objectives = await service.listObjectives({ profileId: resolved.root.id });
    const liveObjectives = objectives.filter((objective) => !objective.archivedAt);
    const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
    const selectedJob = input.jobId ? jobsById.get(input.jobId) : undefined;
    const resolvedObjectiveId = explicitObjectiveId ?? await resolveSessionObjectiveId({
      repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: input.objectiveId,
      selectedJob,
      jobs,
      liveObjectives,
      allowExplicitFallback: true,
    });
    const stream = !explicitObjectiveId
      ? resolveChatViewStream({
          repoRoot,
          profileId: resolved.root.id,
          chatId: input.chatId,
          objectiveId: resolvedObjectiveId,
          job: selectedJob,
        })
      : undefined;
    const scopedJobs = !explicitObjectiveId && stream
      ? jobs.filter((job) => isRelevantShellJob(job, stream, resolvedObjectiveId))
      : [];
    if (selectedJob && !scopedJobs.some((job) => job.id === selectedJob.id)) {
      scopedJobs.unshift(selectedJob);
    }
    const selectedObjective = objectives.find((objective) => objective.objectiveId === resolvedObjectiveId);
    const selectedObjectiveCard = selectedObjective ? toFactorySelectedObjectiveCard(selectedObjective) : undefined;
    const profileNav = buildProfileNav({
      profiles,
      selectedProfileId: resolved.root.id,
      mode: input.mode,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      runId: input.runId,
      jobId: input.jobId,
      panel: input.panel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      objectiveProfileId: selectedObjectiveCard?.profileId,
    });
    const objectiveNav: ReadonlyArray<FactoryChatObjectiveNav> = buildObjectiveNavCards(
      objectives,
      resolvedObjectiveId,
      { includeArchivedSelectedOnly: true },
    );
    return {
      nav: {
        mode: input.mode,
        activeProfileId: resolved.root.id,
        activeProfileLabel: resolved.root.label,
        chatId: input.chatId,
        panel: input.panel,
        inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
        profiles: profileNav,
        objectives: objectiveNav,
        showAll: input.showAll,
      },
      selectedObjective: selectedObjectiveCard,
    };
  };

  const buildMissingInspectorModel = (input: {
    readonly mode?: FactoryViewMode;
    readonly activeProfileId: string;
    readonly activeProfileLabel?: string;
    readonly activeProfilePrimaryRole?: string;
    readonly activeProfileSummary?: string;
    readonly activeProfileSoulSummary?: string;
    readonly activeProfileProfileSummary?: string;
    readonly activeProfileResponsibilities?: ReadonlyArray<string>;
    readonly activeProfileSections?: ReturnType<typeof describeProfileMarkdown>["sections"];
    readonly objectiveId: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
  }): FactoryInspectorModel => ({
    mode: input.mode,
    panel: input.panel ?? "overview",
    inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
    activeProfileId: input.activeProfileId,
    activeProfileLabel: input.activeProfileLabel,
    activeProfilePrimaryRole: input.activeProfilePrimaryRole,
    activeProfileSummary: input.activeProfileSummary,
    activeProfileSoulSummary: input.activeProfileSoulSummary,
    activeProfileProfileSummary: input.activeProfileProfileSummary,
    activeProfileResponsibilities: input.activeProfileResponsibilities,
    activeProfileSections: input.activeProfileSections,
    objectiveId: input.objectiveId,
    runId: input.runId,
    jobId: input.jobId,
    focusKind: input.focusKind,
    focusId: input.focusId,
    activeCodex: undefined,
    liveChildren: [],
    activeRun: undefined,
    workbench: undefined,
    jobs: [],
    objectiveMissing: true,
  });

  const buildProfileNav = (
    input: {
      readonly profiles: ReadonlyArray<FactoryChatProfile>;
      readonly selectedProfileId: string;
      readonly mode?: FactoryViewMode;
      readonly chatId?: string;
      readonly objectiveId?: string;
      readonly runId?: string;
      readonly jobId?: string;
      readonly panel?: FactoryInspectorPanel;
      readonly inspectorTab?: FactoryInspectorTab;
      readonly focusKind?: "task" | "job";
      readonly focusId?: string;
      readonly objectiveProfileId?: string;
    },
  ): ReadonlyArray<FactoryChatProfileNav> => input.profiles.map((profile) => {
    const overview = describeProfileMarkdown(profile);
    const preserveSelection = input.objectiveId && input.objectiveProfileId === profile.id;
    return {
      id: profile.id,
      label: profile.label,
      href: buildChatLink({
        mode: input.mode,
        profileId: profile.id,
        chatId: input.chatId,
        objectiveId: preserveSelection ? input.objectiveId : undefined,
        runId: preserveSelection ? input.runId : undefined,
        jobId: preserveSelection ? input.jobId : undefined,
        panel: preserveSelection ? input.panel : undefined,
        inspectorTab: preserveSelection ? input.inspectorTab : undefined,
        focusKind: preserveSelection ? input.focusKind : undefined,
        focusId: preserveSelection ? input.focusId : undefined,
      }),
      summary: overview.summary,
      selected: profile.id === input.selectedProfileId,
    } satisfies FactoryChatProfileNav;
  });

  const buildUnselectedInspectorModel = (input: {
    readonly mode?: FactoryViewMode;
    readonly activeProfileId: string;
    readonly activeProfileLabel?: string;
    readonly activeProfilePrimaryRole?: string;
    readonly activeProfileSummary?: string;
    readonly activeProfileSoulSummary?: string;
    readonly activeProfileProfileSummary?: string;
    readonly activeProfileResponsibilities?: ReadonlyArray<string>;
    readonly activeProfileSections?: ReturnType<typeof describeProfileMarkdown>["sections"];
    readonly chatId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
  }): FactoryInspectorModel => ({
    mode: input.mode,
    panel: input.panel ?? "overview",
    inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
    activeProfileId: input.activeProfileId,
    activeProfileLabel: input.activeProfileLabel,
    activeProfilePrimaryRole: input.activeProfilePrimaryRole,
    activeProfileSummary: input.activeProfileSummary,
    activeProfileSoulSummary: input.activeProfileSoulSummary,
    activeProfileProfileSummary: input.activeProfileProfileSummary,
    activeProfileResponsibilities: input.activeProfileResponsibilities,
    activeProfileSections: input.activeProfileSections,
    chatId: input.chatId,
    runId: input.runId,
    jobId: input.jobId,
    focusKind: input.focusKind,
    focusId: input.focusId,
    activeCodex: undefined,
    liveChildren: [],
    activeRun: undefined,
    workbench: undefined,
    jobs: [],
  });

  const buildUnselectedThreadShellModel = (input: {
    readonly mode?: FactoryViewMode;
    readonly resolvedProfile: FactoryChatProfile;
    readonly profiles: ReadonlyArray<FactoryChatProfile>;
    readonly chatId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly showAll?: boolean;
  }): FactoryChatShellModel => {
    const activeProfileOverview = describeProfileMarkdown(input.resolvedProfile);
    const inspectorPanel = input.panel ?? "overview";
    const profileNav = buildProfileNav({
      profiles: input.profiles,
      selectedProfileId: input.resolvedProfile.id,
      mode: input.mode,
      chatId: input.chatId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      focusKind: input.focusKind,
      focusId: input.focusId,
    });
    const chatModel: FactoryChatIslandModel = {
      mode: input.mode,
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      chatId: input.chatId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      focusKind: input.focusKind,
      focusId: input.focusId,
      activeProfilePrimaryRole: activeProfileOverview.primaryRole,
      activeProfileRoles: activeProfileOverview.roles,
      activeProfileResponsibilities: activeProfileOverview.responsibilities,
      activeProfileSummary: activeProfileOverview.summary,
      activeProfileSoulSummary: activeProfileOverview.soulSummary,
      activeProfileProfileSummary: activeProfileOverview.profileSummary,
      activeProfileSections: activeProfileOverview.sections,
      items: [],
    };
    const navModel: FactoryNavModel = {
      mode: input.mode,
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      chatId: input.chatId,
      panel: inspectorPanel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      profiles: profileNav,
      objectives: [],
      showAll: input.showAll,
    };
    const inspectorModel = buildUnselectedInspectorModel({
      mode: input.mode,
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      activeProfilePrimaryRole: activeProfileOverview.primaryRole,
      activeProfileSummary: activeProfileOverview.summary,
      activeProfileSoulSummary: activeProfileOverview.soulSummary,
      activeProfileProfileSummary: activeProfileOverview.profileSummary,
      activeProfileResponsibilities: activeProfileOverview.responsibilities,
      activeProfileSections: activeProfileOverview.sections,
      chatId: input.chatId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      focusKind: input.focusKind,
      focusId: input.focusId,
    });
    return {
      mode: input.mode,
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      chatId: input.chatId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      focusKind: input.focusKind,
      focusId: input.focusId,
      chat: chatModel,
      nav: navModel,
      inspector: inspectorModel,
    };
  };

  const buildMissingExplicitThreadShellModel = (input: {
    readonly mode?: FactoryViewMode;
    readonly resolvedProfile: FactoryChatProfile;
    readonly profiles: ReadonlyArray<FactoryChatProfile>;
    readonly objectives: Awaited<ReturnType<FactoryService["listObjectives"]>>;
    readonly objectiveId: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly showAll?: boolean;
  }): FactoryChatShellModel => {
    const activeProfileOverview = describeProfileMarkdown(input.resolvedProfile);
    const inspectorPanel = input.panel ?? "overview";
    const profileNav = buildProfileNav({
      profiles: input.profiles,
      selectedProfileId: input.resolvedProfile.id,
      mode: input.mode,
      objectiveId: input.objectiveId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      focusKind: input.focusKind,
      focusId: input.focusId,
    });
    const chatModel: FactoryChatIslandModel = {
      mode: input.mode,
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      objectiveId: input.objectiveId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      focusKind: input.focusKind,
      focusId: input.focusId,
      activeProfilePrimaryRole: activeProfileOverview.primaryRole,
      activeProfileRoles: activeProfileOverview.roles,
      activeProfileResponsibilities: activeProfileOverview.responsibilities,
      activeProfileSummary: activeProfileOverview.summary,
      activeProfileSoulSummary: activeProfileOverview.soulSummary,
      activeProfileProfileSummary: activeProfileOverview.profileSummary,
      activeProfileSections: activeProfileOverview.sections,
      items: [{
        key: `missing-objective-${input.objectiveId}`,
        kind: "system",
        title: "Objective not found",
        body: `The current thread URL points to Factory data that no longer exists.\n\nThread: ${input.objectiveId}`,
        meta: "warning",
      }],
    };
    const navModel: FactoryNavModel = {
      mode: input.mode,
        activeProfileId: input.resolvedProfile.id,
        activeProfileLabel: input.resolvedProfile.label,
        panel: inspectorPanel,
        inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
        profiles: profileNav,
        objectives: buildObjectiveNavCards(
          filterObjectivesByProfile(input.objectives, input.resolvedProfile.id),
          input.objectiveId,
          { includeArchivedSelectedOnly: true },
        ),
      showAll: input.showAll,
    };
    const inspectorModel = buildMissingInspectorModel({
      mode: input.mode,
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      activeProfilePrimaryRole: activeProfileOverview.primaryRole,
      activeProfileSummary: activeProfileOverview.summary,
      activeProfileSoulSummary: activeProfileOverview.soulSummary,
      activeProfileProfileSummary: activeProfileOverview.profileSummary,
      activeProfileResponsibilities: activeProfileOverview.responsibilities,
      activeProfileSections: activeProfileOverview.sections,
      objectiveId: input.objectiveId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      focusKind: input.focusKind,
      focusId: input.focusId,
    });
    return {
      mode: input.mode,
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      objectiveId: input.objectiveId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      focusKind: input.focusKind,
      focusId: input.focusId,
      chat: chatModel,
      nav: navModel,
      inspector: inspectorModel,
    };
  };

  const buildExplicitInspectorModel = async (input: {
    readonly mode?: FactoryViewMode;
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
  }): Promise<FactoryInspectorModel> => {
    await service.ensureBootstrap();
    const objectiveId = input.objectiveId.trim();
    const panel = input.panel ?? "overview";
    const repoRoot = service.git.repoRoot;
    const explicitContext = await loadExplicitObjectiveContext({
      profileId: input.profileId,
      objectiveId,
      selectedJobId: input.jobId,
    });
    const {
      effectiveProfile,
      state: maybeState,
      detail,
      selectedObjective,
      recentJobs,
      selectedJob,
    } = explicitContext;
    const sessionStream = input.chatId
      ? factoryChatSessionStream(repoRoot, effectiveProfile.id, input.chatId)
      : undefined;
    const explicitChatContext = sessionStream
      ? await loadChatContextProjectionForSession({
          sessionStream,
          fallbackChain: await agentRuntime.chain(sessionStream),
        })
      : undefined;

    if (!selectedObjective && (panel === "overview" || panel === "receipts")) {
      return buildMissingInspectorModel({
        mode: input.mode,
        activeProfileId: effectiveProfile.id,
        objectiveId,
        runId: input.runId,
        jobId: input.jobId,
        panel,
        inspectorTab: input.inspectorTab,
        focusKind: input.focusKind,
        focusId: input.focusId,
      });
    }

    if (panel === "overview") {
      return {
        mode: input.mode,
        panel,
        inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
        activeProfileId: effectiveProfile.id,
        objectiveId,
        runId: input.runId,
        jobId: input.jobId,
        focusKind: input.focusKind,
        focusId: input.focusId,
        selectedObjective,
        activeCodex: buildActiveCodexCard(recentJobs),
        liveChildren: [],
        activeRun: undefined,
        workbench: undefined,
        chatContext: withChatContextViewImports(explicitChatContext, {
          selectedObjective,
          workbench: undefined,
          activeCodex: undefined,
          liveChildren: [],
        }),
        jobs: [],
        tasks: undefined,
        debugInfo: maybeState,
      };
    }

    if (panel === "receipts") {
      return {
        mode: input.mode,
        panel,
        inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
        activeProfileId: effectiveProfile.id,
        objectiveId,
        runId: input.runId,
        jobId: input.jobId,
        focusKind: input.focusKind,
        focusId: input.focusId,
        selectedObjective,
        activeCodex: undefined,
        liveChildren: [],
        activeRun: undefined,
        workbench: undefined,
        chatContext: withChatContextViewImports(explicitChatContext, {
          selectedObjective,
          workbench: undefined,
          activeCodex: undefined,
          liveChildren: [],
        }),
        jobs: [],
        tasks: undefined,
        receipts: await service.listObjectiveReceipts(objectiveId, 100).catch(() => undefined),
      };
    }

    if (!detail) {
      return buildMissingInspectorModel({
        mode: input.mode,
        activeProfileId: effectiveProfile.id,
        objectiveId,
        runId: input.runId,
        jobId: input.jobId,
        panel,
        focusKind: input.focusKind,
        focusId: input.focusId,
      });
    }
    const relevantJobs = recentJobs
      .slice(0, 12)
      .map((job) => ({
        jobId: job.id,
        agentId: job.agentId,
        status: job.status,
        summary: summarizeJob(job),
        runId: jobAnyRunId(job),
        objectiveId: jobObjectiveId(job),
        updatedAt: job.updatedAt,
        selected: job.id === input.jobId,
        link: buildChatLink({
          mode: input.mode,
          profileId: effectiveProfile.id,
          objectiveId,
          runId: jobAnyRunId(job),
          jobId: job.id,
          panel,
          focusKind: "job",
          focusId: job.id,
        }),
      } satisfies FactoryChatJobNav));
    const initialWorkbench = buildFactoryWorkbench({
      detail,
      recentJobs,
      requestedFocusKind: input.focusKind,
      requestedFocusId: input.focusId,
    });
    const liveOutput = initialWorkbench?.focus
      ? await service.getObjectiveLiveOutput(
          objectiveId,
          initialWorkbench.focus.focusKind,
          initialWorkbench.focus.focusId,
        ).catch(() => undefined)
      : undefined;
    const workbench = buildFactoryWorkbench({
      detail,
      recentJobs,
      requestedFocusKind: initialWorkbench?.focus?.focusKind ?? input.focusKind,
      requestedFocusId: initialWorkbench?.focus?.focusId ?? input.focusId,
      liveOutput,
    });
    const activeCodex = buildActiveCodexCard(recentJobs);
    const explicitHydratedChatContext = withChatContextViewImports(explicitChatContext, {
      selectedObjective,
      workbench,
      activeCodex,
      liveChildren: [],
    });
      return {
        mode: input.mode,
        panel,
        inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
        activeProfileId: effectiveProfile.id,
        objectiveId,
        runId: input.runId,
      jobId: input.jobId,
      focusKind: workbench?.focus?.focusKind,
      focusId: workbench?.focus?.focusId,
      selectedObjective,
      activeCodex,
      liveChildren: [],
      activeRun: undefined,
      workbench,
      chatContext: explicitHydratedChatContext,
      jobs: relevantJobs,
      tasks: detail.tasks,
      analysis: panel === "analysis"
        ? await readObjectiveAnalysis(service.dataDir, objectiveId).catch(() => undefined)
        : undefined,
    };
  };

  const buildInspectorTabsModel = async (input: {
    readonly mode?: FactoryViewMode;
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly focusKind?: string;
    readonly focusId?: string;
  }): Promise<FactoryInspectorTabsModel> => {
    await service.ensureBootstrap();
    const explicitObjectiveId = input.objectiveId?.trim();
    if (explicitObjectiveId) {
      const explicitContext = await loadExplicitObjectiveContext({
        profileId: input.profileId,
        objectiveId: explicitObjectiveId,
        selectedJobId: input.jobId,
      });
      return {
        mode: input.mode,
        panel: input.panel ?? "overview",
        inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
        activeProfileId: explicitContext.effectiveProfile.id,
        objectiveId: explicitObjectiveId,
        runId: input.runId,
        jobId: input.jobId,
        focusKind: normalizeFocusKind(input.focusKind),
        focusId: input.focusId,
      };
    }
    const repoRoot = service.git.repoRoot;
    const resolved = await resolveFactoryChatProfile({
      repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const jobs = explicitObjectiveId
      ? []
      : await loadRecentJobs();
    const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
    const selectedJob = input.jobId ? jobsById.get(input.jobId) : undefined;
    const resolvedObjectiveId = explicitObjectiveId ?? await resolveSessionObjectiveId({
      repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: input.objectiveId,
      selectedJob,
      jobs,
      allowExplicitFallback: true,
    });
    return {
      mode: input.mode,
      panel: input.panel ?? "overview",
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      activeProfileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      runId: input.runId,
      jobId: input.jobId,
      focusKind: normalizeFocusKind(input.focusKind),
      focusId: input.focusId,
    };
  };

  const buildInspectorModel = async (input: {
    readonly mode?: FactoryViewMode;
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
  }): Promise<FactoryInspectorModel> => {
    const explicitObjectiveId = input.objectiveId?.trim();
    if (explicitObjectiveId) {
      return buildExplicitInspectorModel({
        mode: input.mode,
        profileId: input.profileId,
        objectiveId: explicitObjectiveId,
        runId: input.runId,
        jobId: input.jobId,
        panel: input.panel,
        inspectorTab: input.inspectorTab,
        focusKind: input.focusKind,
        focusId: input.focusId,
      });
    }
    await service.ensureBootstrap();
    const repoRoot = service.git.repoRoot;
    const resolved = await resolveFactoryChatProfile({
      repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const jobs = await loadRecentJobs();
    const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
    const selectedJob = input.jobId ? jobsById.get(input.jobId) : undefined;
    const resolvedObjectiveId = await resolveSessionObjectiveId({
      repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: input.objectiveId,
      selectedJob,
      jobs,
      allowExplicitFallback: true,
    });
    const stream = resolveChatViewStream({
      repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      job: selectedJob,
    });
    const indexChain = stream ? await agentRuntime.chain(stream) : [];
    const sessionChatContext = input.chatId
      ? await loadChatContextProjectionForSession({
          sessionStream: factoryChatSessionStream(repoRoot, resolved.root.id, input.chatId),
          fallbackChain: indexChain,
        })
      : undefined;
    const allRunIds = collectRunIds(indexChain);
    const requestedRunIndex = input.runId ? allRunIds.indexOf(input.runId) : -1;
    const requestedRunIds = requestedRunIndex >= 0 ? allRunIds.slice(requestedRunIndex) : allRunIds;
    const collectedRunChains = await Promise.all(
      requestedRunIds.map((runId) => stream ? agentRuntime.chain(agentRunStream(stream, runId)) : Promise.resolve([])),
    );
    const scopedRunTimeline = scopeRunTimelineToObjective({
      objectiveId: resolvedObjectiveId,
      runIds: requestedRunIds,
      runChains: collectedRunChains,
      jobs,
    });
    const runIds = scopedRunTimeline.runIds;
    const runChains = scopedRunTimeline.runChains;
    const activeRunId = runIds.at(-1);
    const runChainsById = new Map(runIds.map((runId, index) => [runId, runChains[index]!] as const));
    const selectedObjective = resolvedObjectiveId
      ? await service.getObjective(resolvedObjectiveId).catch((err) => {
          if (err instanceof FactoryServiceError && err.status === 404) return undefined;
          throw err;
        })
      : undefined;
    const baseQueueJobs = stream
      ? jobs.filter((job) => isRelevantShellJob(job, stream, resolvedObjectiveId))
      : [];
    const selectedRunIds = collectRunLineageIds(
      [
        input.runId,
        selectedJob ? jobRunId(selectedJob) : undefined,
        selectedJob ? jobParentRunId(selectedJob) : undefined,
      ],
      runChainsById,
      baseQueueJobs,
    );
    const relevantQueueJobs = selectedRunIds.size > 0 || input.jobId
      ? baseQueueJobs.filter((job) =>
          job.id === input.jobId
          || jobMatchesRunIds(job, selectedRunIds)
        )
      : baseQueueJobs;
    if (selectedJob && !relevantQueueJobs.some((job) => job.id === selectedJob.id)) {
      relevantQueueJobs.unshift(selectedJob);
    }
    const activeRunLineageIds = activeRunId
      ? collectRunLineageIds([activeRunId], runChainsById, relevantQueueJobs)
      : new Set<string>();
    const activeRunJobs = activeRunLineageIds.size > 0
      ? relevantQueueJobs.filter((job) => jobMatchesRunIds(job, activeRunLineageIds))
      : relevantQueueJobs.filter((job) => jobMatchesRunIds(job, new Set([activeRunId].filter(Boolean) as string[])));
    const activeCodex = buildActiveCodexCard(relevantQueueJobs);
    const liveChildren = stream
      ? buildLiveChildCards(relevantQueueJobs, stream, resolvedObjectiveId)
      : [];
    const activeRunIndex = activeRunId ? runIds.indexOf(activeRunId) : -1;
    const activeRun = activeRunIndex >= 0
      ? summarizeActiveRunCard({
          mode: input.mode,
          runId: activeRunId!,
          runChain: runChains[activeRunIndex]!,
          relatedJobs: activeRunJobs,
          profileLabel: resolved.root.label,
          profileId: resolved.root.id,
          chatId: input.chatId,
          objectiveId: resolvedObjectiveId,
        })
      : selectedJob
          ? summarizePendingRunJob(selectedJob, resolved.root.label, input.mode)
          : undefined;
    const relevantJobs = relevantQueueJobs
      .slice(0, 12)
      .map((job) => ({
        jobId: job.id,
        agentId: job.agentId,
        status: job.status,
        summary: summarizeJob(job),
        runId: jobAnyRunId(job),
        objectiveId: jobObjectiveId(job),
        updatedAt: job.updatedAt,
        selected: job.id === input.jobId,
        link: buildChatLink({
          mode: input.mode,
          profileId: resolved.root.id,
          chatId: input.chatId,
          objectiveId: jobObjectiveId(job),
          runId: jobAnyRunId(job),
          jobId: job.id,
          panel: input.panel,
          focusKind: "job",
          focusId: job.id,
        }),
      } satisfies FactoryChatJobNav));
    const initialWorkbench = buildFactoryWorkbench({
      detail: selectedObjective,
      recentJobs: relevantQueueJobs,
      requestedFocusKind: input.focusKind,
      requestedFocusId: input.focusId,
    });
    const liveOutput = selectedObjective && initialWorkbench?.focus
      ? await service.getObjectiveLiveOutput(
          selectedObjective.objectiveId,
          initialWorkbench.focus.focusKind,
          initialWorkbench.focus.focusId,
        ).catch(() => undefined)
      : undefined;
    const workbench = buildFactoryWorkbench({
      detail: selectedObjective,
      recentJobs: relevantQueueJobs,
      requestedFocusKind: initialWorkbench?.focus?.focusKind ?? input.focusKind,
      requestedFocusId: initialWorkbench?.focus?.focusId ?? input.focusId,
      liveOutput,
    });
    const panel = input.panel ?? (workbench?.hasActiveExecution ? "live" : "overview");
    const hydratedChatContext = withChatContextViewImports(sessionChatContext, {
      selectedObjective: selectedObjective ? toFactorySelectedObjectiveCard(selectedObjective) : undefined,
      workbench,
      activeCodex,
      liveChildren,
    });
    return {
      mode: input.mode,
      panel,
      inspectorTab: normalizedDefaultInspectorTab(input.inspectorTab),
      activeProfileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      runId: activeRunId,
      jobId: input.jobId,
      focusKind: workbench?.focus?.focusKind,
      focusId: workbench?.focus?.focusId,
      selectedObjective: selectedObjective ? toFactorySelectedObjectiveCard(selectedObjective) : undefined,
      activeCodex,
      liveChildren,
      activeRun,
      workbench,
      chatContext: hydratedChatContext,
      jobs: relevantJobs,
      tasks: selectedObjective?.tasks,
    };
  };

  const buildChatShellModelCached = async (input: {
    readonly mode?: FactoryViewMode;
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly showAll?: boolean;
  }): Promise<FactoryChatShellModel> => {
    const sessionVersion = await resolveSessionStreamVersion({
      profileId: input.profileId,
      chatId: input.chatId,
    });
    const objectiveVersion = await resolveObjectiveProjectionVersion();
    return withProjectionCache(
      chatShellCache,
      JSON.stringify({
        input,
        queueVersion: ctx.queue.snapshot?.().version ?? 0,
        objectiveVersion,
        sessionVersion,
      }),
      () => buildChatShellModel(input),
    );
  };

  const buildSidebarModelCached = async (input: {
    readonly mode?: FactoryViewMode;
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly showAll?: boolean;
  }): Promise<{ readonly nav: FactoryNavModel; readonly selectedObjective?: FactorySelectedObjectiveCard }> => {
    const sessionVersion = await resolveSessionStreamVersion({
      profileId: input.profileId,
      chatId: input.chatId,
    });
    const objectiveVersion = await resolveObjectiveProjectionVersion();
    return withProjectionCache(
      sidebarCache,
      JSON.stringify({
        input,
        queueVersion: ctx.queue.snapshot?.().version ?? 0,
        objectiveVersion,
        sessionVersion,
      }),
      () => buildSidebarModel(input),
    );
  };

  const buildInspectorTabsModelCached = async (input: {
    readonly mode?: FactoryViewMode;
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly focusKind?: string;
    readonly focusId?: string;
  }): Promise<FactoryInspectorTabsModel> => {
    const sessionVersion = await resolveSessionStreamVersion({
      profileId: input.profileId,
      chatId: input.chatId,
    });
    const objectiveVersion = await resolveObjectiveProjectionVersion();
    return withProjectionCache(
      inspectorTabsCache,
      JSON.stringify({
        input,
        queueVersion: ctx.queue.snapshot?.().version ?? 0,
        objectiveVersion,
        sessionVersion,
      }),
      () => buildInspectorTabsModel(input),
    );
  };

  const buildInspectorModelCached = async (input: {
    readonly mode?: FactoryViewMode;
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
  }): Promise<FactoryInspectorModel> => {
    const sessionVersion = await resolveSessionStreamVersion({
      profileId: input.profileId,
      chatId: input.chatId,
    });
    const objectiveVersion = await resolveObjectiveProjectionVersion();
    return withProjectionCache(
      inspectorPanelCache,
      JSON.stringify({
        input,
        queueVersion: ctx.queue.snapshot?.().version ?? 0,
        objectiveVersion,
        sessionVersion,
      }),
      () => buildInspectorModel(input),
    );
  };

  const dedupeObjectiveCards = (
    cards: ReadonlyArray<FactoryChatObjectiveNav>,
  ): ReadonlyArray<FactoryChatObjectiveNav> => {
    const seen = new Set<string>();
    return cards.filter((card) => {
      if (!card.objectiveId || seen.has(card.objectiveId)) return false;
      seen.add(card.objectiveId);
      return true;
    });
  };

  const selectedObjectiveNavCard = (
    objective: FactorySelectedObjectiveCard,
  ): FactoryChatObjectiveNav => ({
    objectiveId: objective.objectiveId,
    profileId: objective.profileId,
    profileLabel: objective.profileLabel,
    title: objective.title,
    status: objective.status,
    phase: objective.phase,
    displayState: objective.displayState,
    blockedReason: objective.blockedReason,
    blockedExplanation: objective.blockedExplanation,
    summary: objective.bottomLine ?? objective.summary ?? objective.nextAction,
    updatedAt: objective.updatedAt,
    selected: true,
    slotState: objective.slotState,
    activeTaskCount: objective.activeTaskCount,
    readyTaskCount: objective.readyTaskCount,
    taskCount: objective.taskCount,
    integrationStatus: objective.integrationStatus,
    tokensUsed: objective.tokensUsed,
  });

  const workbenchFilterCount = (
    board: Awaited<ReturnType<FactoryService["buildBoardProjection"]>>,
    filter: FactoryWorkbenchFilterKey,
  ): number => {
    switch (filter) {
      case "objective.running":
        return board.sections.active.length;
      case "objective.needs_attention":
        return board.sections.needs_attention.length;
      case "objective.queued":
        return board.sections.queued.length;
      case "objective.completed":
        return board.sections.completed.length;
      default:
        return board.objectives.length;
    }
  };

  const workbenchFilterMatchesSection = (
    filter: FactoryWorkbenchFilterKey,
    section: "needs_attention" | "active" | "queued" | "completed",
  ): boolean => {
    switch (filter) {
      case "objective.running":
        return section === "active";
      case "objective.needs_attention":
        return section === "needs_attention";
      case "objective.queued":
        return section === "queued";
      case "objective.completed":
        return section === "completed";
    }
  };

  const workbenchFilterModels = (
    board: Awaited<ReturnType<FactoryService["buildBoardProjection"]>>,
    selected: FactoryWorkbenchFilterKey,
  ): ReadonlyArray<FactoryWorkbenchFilterModel> => [
    { key: "objective.running", label: "In Progress", count: workbenchFilterCount(board, "objective.running"), selected: selected === "objective.running" },
    { key: "objective.needs_attention", label: "Blocked", count: workbenchFilterCount(board, "objective.needs_attention"), selected: selected === "objective.needs_attention" },
    { key: "objective.queued", label: "Queued", count: workbenchFilterCount(board, "objective.queued"), selected: selected === "objective.queued" },
    { key: "objective.completed", label: "Completed", count: workbenchFilterCount(board, "objective.completed"), selected: selected === "objective.completed" },
  ];

  const preferredWorkbenchSelectedObjectiveId = (
    board: Awaited<ReturnType<FactoryService["buildBoardProjection"]>>,
    filter: FactoryWorkbenchFilterKey,
    preferredId?: string,
  ): string | undefined => {
    if (preferredId && board.objectives.some((objective) => objective.objectiveId === preferredId)) return preferredId;
    return undefined;
  };

  const buildWorkbenchStats = (input: {
    readonly board: Awaited<ReturnType<FactoryService["buildBoardProjection"]>>;
    readonly selectedObjective?: FactorySelectedObjectiveCard;
    readonly filter: FactoryWorkbenchFilterKey;
  }): ReadonlyArray<FactoryWorkbenchStatModel> => {
    const objective = input.selectedObjective;
    if (objective) {
      const activeTaskCount = objective.activeTaskCount ?? 0;
      const readyTaskCount = objective.readyTaskCount ?? 0;
      const taskCount = objective.taskCount ?? activeTaskCount + readyTaskCount;
      const sessions = objective.evidenceStats?.find((stat) => stat.key === "sessions")?.value
        ?? String(activeTaskCount + readyTaskCount);
      const tasks = objective.evidenceStats?.find((stat) => stat.key === "tasks")?.value
        ?? `${activeTaskCount}/${taskCount}`;
      const evidence = objective.evidenceStats?.find((stat) => stat.key === "evidence")?.value
        ?? objective.evidenceStats?.find((stat) => stat.key === "artifacts")?.value
        ?? "0";
      const blockers = objective.evidenceStats?.find((stat) => stat.key === "blockers")?.value
        ?? (objective.blockedReason ? "1" : "0");
      return [
        {
          key: "tasks",
          label: "Tasks",
          value: tasks,
        },
        {
          key: "sessions",
          label: "Sessions",
          value: sessions,
        },
        {
          key: "evidence",
          label: "Evidence",
          value: evidence,
        },
        {
          key: "blockers",
          label: "Blockers",
          value: blockers,
        },
      ];
    }
    const filteredCount = workbenchFilterCount(input.board, input.filter);
    return [
      {
        key: "scope",
        label: "Visible",
        value: `${filteredCount} objective${filteredCount === 1 ? "" : "s"}`,
      },
      {
        key: "running",
        label: "In Progress",
        value: `${input.board.sections.active.length}`,
      },
      {
        key: "attention",
        label: "Blocked",
        value: `${input.board.sections.needs_attention.length}`,
      },
      {
        key: "tasks",
        label: "Selected Tasks",
        value: "0/0",
      },
    ];
  };

  const buildWorkbenchBlocks = (input: {
    readonly board: Awaited<ReturnType<FactoryService["buildBoardProjection"]>>;
    readonly selectedObjective?: FactorySelectedObjectiveCard;
    readonly blockedObjectives: ReadonlyArray<FactoryChatObjectiveNav>;
    readonly runningObjectives: ReadonlyArray<FactoryChatObjectiveNav>;
    readonly queuedObjectives: ReadonlyArray<FactoryChatObjectiveNav>;
    readonly pastObjectives: ReadonlyArray<FactoryChatObjectiveNav>;
    readonly activeRun?: FactoryLiveRunCard;
    readonly workbench?: FactoryChatIslandModel["workbench"];
    readonly detailTab: FactoryWorkbenchDetailTab;
    readonly filter: FactoryWorkbenchFilterKey;
  }): ReadonlyArray<FactoryWorkbenchBlockModel> => {
    const executionEscalationHint = (status?: string): string | undefined => {
      switch (status) {
        case "blocked":
          return "Execution escalated back to Chat. Use /react in the composer to continue this objective, or plain text in Chat to summarize the current evidence.";
        case "failed":
          return "Execution failed and escalated back to Chat. Use /react to run the next attempt, or plain text in Chat to review the failure before deciding.";
        case "stalled":
          return "Execution looks stalled and has escalated back to Chat. Use /abort-job or /react in the composer, or plain text in Chat to decide the next step.";
        default:
          return undefined;
      }
    };
    const focus = input.workbench?.focus;
    const selectedObjective = input.selectedObjective;
    const objectiveTerminal = Boolean(selectedObjective && isTerminalObjectiveStatus(selectedObjective.status));
    const staleFocusSummary = objectiveTerminal || Boolean(selectedObjective?.blockedReason);
    const objectiveFallbackSummary = selectedObjective?.blockedReason
      ?? selectedObjective?.blockedExplanation
      ?? selectedObjective?.summary
      ?? selectedObjective?.nextAction;
    const escalationHint = executionEscalationHint(focus?.status);
    const activityItems = (input.workbench?.activity ?? []).slice(0, 8).map((entry) => ({
      key: `${entry.kind}:${entry.at}:${entry.title}`,
      kind: entry.kind,
      title: entry.title,
      summary: entry.summary,
      meta: entry.meta,
      at: entry.at,
    }));
    const summarySection: FactoryWorkbenchSectionModel = {
      key: "summary",
      title: "Selected Objective",
      shape: "summary",
      empty: !selectedObjective,
      eyebrow: selectedObjective?.displayState ? `State: ${selectedObjective.displayState}` : undefined,
      headline: selectedObjective?.title ?? "No objective selected.",
      message: selectedObjective
        ? selectedObjective.bottomLine
          ?? selectedObjective.summary
          ?? selectedObjective.nextAction
          ?? "Review the selected objective, its lifecycle, and the latest evidence."
        : "Use chat to create a new objective or select one from the queue below.",
      tokenCount: typeof selectedObjective?.tokensUsed === "number"
        ? selectedObjective.tokensUsed.toLocaleString()
        : undefined,
      stats: buildWorkbenchStats({
        board: input.board,
        selectedObjective,
        filter: input.filter,
      }),
      objective: selectedObjective,
      currentRun: input.activeRun,
      focus: focus
        ? {
            title: focus.title,
            summary: focus.summary ?? focus.lastMessage ?? focus.stdoutTail ?? "Waiting for live output.",
            status: focus.status,
            active: focus.active,
            jobId: focus.jobId,
            taskId: focus.taskId,
            candidateId: focus.candidateId,
            lastMessage: focus.lastMessage,
            stdoutTail: focus.stdoutTail,
            stderrTail: focus.stderrTail,
          }
        : undefined,
      latestDecisionSummary: selectedObjective?.latestDecisionSummary,
      latestDecisionAt: selectedObjective?.latestDecisionAt,
      activityCount: selectedObjective?.timelineGroups?.reduce((sum, group) => sum + group.items.length, 0) ?? activityItems.length,
      activityItems,
    };
    const showBlocked = input.filter === "objective.needs_attention";
    const showRunning = input.filter === "objective.running";
    const showQueued = input.filter === "objective.queued";
    const showCompleted = input.filter === "objective.completed";

    const objectiveSections: FactoryWorkbenchSectionModel[] = [
      ...(showBlocked ? [{
        key: "blocked",
        title: "Blocked",
        shape: "objective-list" as const,
        count: input.blockedObjectives.length,
        emptyMessage: input.filter === "objective.needs_attention"
          ? "No blocked objectives match the current filter."
          : "Blocked objectives will appear here when work needs intervention.",
        items: input.blockedObjectives,
      }] : []),
      ...(showRunning ? [{
        key: "running",
        title: "In Progress",
        shape: "objective-list" as const,
        count: input.runningObjectives.length,
        emptyMessage: input.filter === "objective.running"
          ? "No in-progress objectives match the current filter."
          : "Objectives with active execution will appear here.",
        items: input.runningObjectives,
      }] : []),
      ...(showQueued ? [{
        key: "queued",
        title: "Queued",
        shape: "objective-list" as const,
        count: input.queuedObjectives.length,
        emptyMessage: input.filter === "objective.queued"
          ? "No queued objectives match the current filter."
          : "Queued objectives waiting for execution will appear here.",
        items: input.queuedObjectives,
      }] : []),
    ];
    const selectedObjectiveSection = selectedObjective && ![
      ...input.blockedObjectives,
      ...input.runningObjectives,
      ...input.queuedObjectives,
      ...input.pastObjectives,
    ].some((objective) => objective.objectiveId === selectedObjective.objectiveId)
      ? {
          key: "selected",
          title: "Current selection",
          shape: "objective-list" as const,
          count: 1,
          emptyMessage: "The selected objective will stay visible here when the current filter hides it.",
          items: [selectedObjectiveNavCard(selectedObjective)],
        }
      : undefined;
    const objectiveBlockSections = objectiveSections;
    const activitySection: FactoryWorkbenchSectionModel = {
      key: "activity",
      title: focus || input.activeRun ? "Execution Log" : "Timeline",
      shape: "activity-list",
      count: selectedObjective?.timelineGroups?.reduce((sum, group) => sum + group.items.length, 0) ?? activityItems.length,
      emptyMessage: "Outcome, work performed, and raw receipts will appear here when the objective records evidence.",
      items: activityItems,
      timelineGroups: selectedObjective?.timelineGroups,
      callout: escalationHint,
      focus: focus
        ? {
            title: focus.title,
            summary: staleFocusSummary
              ? objectiveFallbackSummary ?? focus.summary ?? focus.lastMessage ?? "Objective state changed."
              : focus.summary ?? focus.lastMessage ?? focus.stdoutTail ?? "Waiting for live output.",
            status: focus.status,
            active: focus.active,
            jobId: focus.jobId,
            taskId: focus.taskId,
            candidateId: focus.candidateId,
            lastMessage: focus.lastMessage,
            stdoutTail: focus.stdoutTail,
            stderrTail: focus.stderrTail,
          }
        : undefined,
      run: input.activeRun,
    };
    const prioritizeActivity = Boolean(
      input.activeRun
      || focus?.active
      || focus?.status === "running"
      || focus?.status === "queued",
    );

    const blocks: FactoryWorkbenchBlockModel[] = [];

    const hasActivity = (selectedObjective?.timelineGroups?.length ?? 0) > 0 || focus || input.activeRun || activityItems.length > 0;
    if (hasActivity && prioritizeActivity) {
      blocks.push({
        key: "activity",
        layout: "full",
        sections: [activitySection],
      });
    }

    blocks.push({
      key: "summary",
      layout: "full",
      sections: [summarySection],
    });

    if (hasActivity && !prioritizeActivity) {
      blocks.push({
        key: "activity",
        layout: "full",
        sections: [activitySection],
      });
    }

    if (selectedObjectiveSection) {
      blocks.push({
        key: "selected-overflow",
        layout: "full",
        sections: [selectedObjectiveSection],
      });
    }

    if (objectiveBlockSections.length > 0) {
      blocks.push({
        key: "objectives",
        layout: "full",
        sections: objectiveBlockSections,
      });
    }

    if (showCompleted) {
      blocks.push({
        key: "history",
        layout: "full",
        sections: [{
          key: "completed",
          title: "Completed",
          shape: "objective-list",
          count: input.pastObjectives.length,
          emptyMessage: input.filter === "objective.completed"
            ? "No completed objectives match the current filter."
            : "Completed objectives and recent history will appear here.",
          items: input.pastObjectives,
        }],
      });
    }

    return blocks;
  };

  const buildWorkbenchWorkspaceModel = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly detailTab?: FactoryWorkbenchDetailTab;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly filter: FactoryWorkbenchFilterKey;
  }): Promise<FactoryWorkbenchWorkspaceModel> => {
    await service.ensureBootstrap();
    const repoRoot = service.git.repoRoot;
    const requestedObjectiveId = input.objectiveId?.trim();
    const [resolved, profiles, detail] = await Promise.all([
      resolveFactoryChatProfile({
        repoRoot,
        profileRoot,
        requestedId: input.profileId,
      }),
      loadFactoryProfiles(),
      requestedObjectiveId
        ? service.getObjective(requestedObjectiveId).catch((err) => {
            if (err instanceof FactoryServiceError && err.status === 404) return undefined;
            throw err;
          })
        : Promise.resolve(undefined),
    ]);
    const effectiveProfileId = detail?.profile.rootProfileId ?? resolved.root.id;
    const effectiveProfile = profiles.find((profile) => profile.id === effectiveProfileId) ?? resolved.root;
    const board = await service.buildBoardProjection({
      selectedObjectiveId: requestedObjectiveId,
      profileId: effectiveProfileId,
    });
    const resolvedObjectiveId = detail?.objectiveId
      ?? preferredWorkbenchSelectedObjectiveId(board, input.filter, requestedObjectiveId)
      ?? requestedObjectiveId;
    const selectedBoardObjective = resolvedObjectiveId
      ? board.objectives.find((objective) => objective.objectiveId === resolvedObjectiveId)
      : undefined;
    const selectedObjective = detail
      ? toFactorySelectedObjectiveCard(detail)
      : selectedBoardObjective
        ? toFactorySelectedObjectiveCard(selectedBoardObjective)
        : undefined;
    const { jobs: recentJobs } = detail
      ? await collectExplicitObjectiveJobs(
          detail,
          input.focusKind === "job" ? input.focusId : undefined,
        )
      : { jobs: [] as ReadonlyArray<QueueJob> };
    const initialWorkbench = buildFactoryWorkbench({
      detail,
      recentJobs,
      requestedFocusKind: input.focusKind,
      requestedFocusId: input.focusId,
    });
    const liveOutput = detail && initialWorkbench?.focus
      ? await service.getObjectiveLiveOutput(
          detail.objectiveId,
          initialWorkbench.focus.focusKind,
          initialWorkbench.focus.focusId,
        ).catch(() => undefined)
      : undefined;
    const workbench = buildFactoryWorkbench({
      detail,
      recentJobs,
      requestedFocusKind: initialWorkbench?.focus?.focusKind ?? input.focusKind,
      requestedFocusId: initialWorkbench?.focus?.focusId ?? input.focusId,
      liveOutput,
    });
    const sessionRuntime = await buildWorkbenchSessionRuntime({
      repoRoot,
      profileId: effectiveProfile.id,
      profileLabel: effectiveProfile.label,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      seedJobs: recentJobs,
    });
    const activeCodex = sessionRuntime.activeCodex ?? (recentJobs.length > 0 ? buildActiveCodexCard(recentJobs) : undefined);
    const filters = workbenchFilterModels(board, input.filter);
    const blockedObjectives = dedupeObjectiveCards(
      workbenchFilterMatchesSection(input.filter, "needs_attention")
        ? buildObjectiveNavCards(board.sections.needs_attention, resolvedObjectiveId)
        : [],
    ).slice(0, 10);
    const runningObjectives = dedupeObjectiveCards(
      workbenchFilterMatchesSection(input.filter, "active")
        ? buildObjectiveNavCards(board.sections.active, resolvedObjectiveId)
        : [],
    ).slice(0, 10);
    const queuedObjectives = dedupeObjectiveCards(
      workbenchFilterMatchesSection(input.filter, "queued")
        ? buildObjectiveNavCards(board.sections.queued, resolvedObjectiveId)
        : [],
    ).slice(0, 10);
    const activeObjectives = dedupeObjectiveCards([
      ...blockedObjectives,
      ...runningObjectives,
      ...queuedObjectives,
    ]).slice(0, 10);
    const pastObjectives = dedupeObjectiveCards(
      workbenchFilterMatchesSection(input.filter, "completed")
        ? buildObjectiveNavCards(board.sections.completed, resolvedObjectiveId)
        : [],
    ).slice(0, 10);
    const hasActiveExecution = Boolean(
      sessionRuntime.activeRun
      || workbench?.focus?.active
      || workbench?.focus?.status === "running"
      || workbench?.focus?.status === "queued",
    );
    const detailTab = input.detailTab === "review" || input.detailTab === "queue" || input.detailTab === "action"
      ? input.detailTab
      : hasActiveExecution
        ? "review"
        : normalizedWorkbenchDetailTab(input.detailTab, Boolean(selectedObjective));
    return {
      activeProfileId: effectiveProfile.id,
      activeProfileLabel: effectiveProfile.label,
      objectiveId: resolvedObjectiveId,
      inspectorTab: normalizedWorkbenchInspectorTab(input.inspectorTab),
      detailTab,
      focusKind: workbench?.focus?.focusKind,
      focusId: workbench?.focus?.focusId,
      filter: input.filter,
      filters,
      selectedObjective,
      activeCodex,
      liveChildren: sessionRuntime.liveChildren,
      activeRun: sessionRuntime.activeRun,
      workbench,
      board,
      activeObjectives,
      pastObjectives,
      blocks: buildWorkbenchBlocks({
        board,
        selectedObjective,
        blockedObjectives,
        runningObjectives,
        queuedObjectives,
        pastObjectives,
        activeRun: sessionRuntime.activeRun,
        workbench,
        detailTab,
        filter: input.filter,
      }),
    };
  };

  const buildWorkbenchChatModel = async (input: {
    readonly profileId: string;
    readonly chatId: string;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly selectedObjectiveId?: string;
  }): Promise<FactoryChatIslandModel> => {
    await service.ensureBootstrap();
    const repoRoot = service.git.repoRoot;
    const resolved = await resolveFactoryChatProfile({
      repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const activeProfileOverview = describeProfileMarkdown(resolved.root);
    const runtime = await buildWorkbenchSessionRuntime({
      repoRoot,
      profileId: resolved.root.id,
      profileLabel: resolved.root.label,
      chatId: input.chatId,
      objectiveId: input.selectedObjectiveId,
    });
    const jobsById = new Map(runtime.scopedJobs.map((job) => [job.id, job] as const));
    const discoveredObjectiveId = latestObjectiveIdFromRunChains(runtime.runChains)
      ?? (runtime.stream
        ? latestObjectiveIdFromJobs(runtime.scopedJobs, runtime.stream, input.chatId)
        : undefined);
    return {
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      chatId: input.chatId,
      objectiveId: input.selectedObjectiveId,
      runId: runtime.activeRunId,
      knownRunIds: runtime.runIds,
      terminalRunIds: collectTerminalRunIds(runtime.runIds, runtime.runChains),
      inspectorTab: normalizedWorkbenchInspectorTab(input.inspectorTab),
      activeProfilePrimaryRole: activeProfileOverview.primaryRole,
      activeProfileRoles: activeProfileOverview.roles,
      activeProfileResponsibilities: activeProfileOverview.responsibilities,
      activeProfileSummary: activeProfileOverview.summary,
      activeProfileSoulSummary: activeProfileOverview.soulSummary,
      activeProfileProfileSummary: activeProfileOverview.profileSummary,
      activeProfileSections: activeProfileOverview.sections,
      activeProfileTools: resolved.toolAllowlist,
      activeCodex: runtime.activeCodex,
      liveChildren: runtime.liveChildren,
      activeRun: runtime.activeRun,
      jobs: [],
      items: runtime.runChains.flatMap((runChain, index) => buildChatItemsForRun(runtime.runIds[index]!, runChain, jobsById)),
    };
  };

  const buildWorkbenchPageModel = async (input: {
    readonly profileId?: string;
    readonly chatId: string;
    readonly objectiveId?: string;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly detailTab?: FactoryWorkbenchDetailTab;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly filter: FactoryWorkbenchFilterKey;
  }): Promise<FactoryWorkbenchPageModel> => {
    const workspace = await buildWorkbenchWorkspaceModel({
      profileId: input.profileId,
      chatId: input.chatId,
      objectiveId: input.objectiveId,
      inspectorTab: input.inspectorTab,
      detailTab: input.detailTab,
      focusKind: input.focusKind,
      focusId: input.focusId,
      filter: input.filter,
    });
    await ensureObjectiveHandoffInSession({
      profileId: workspace.activeProfileId,
      chatId: input.chatId,
      objective: workspace.selectedObjective,
    });
    const [baseChat, inspector, profiles] = await Promise.all([
      buildWorkbenchChatModel({
        profileId: workspace.activeProfileId,
        chatId: input.chatId,
        inspectorTab: input.inspectorTab,
        selectedObjectiveId: workspace.objectiveId,
      }),
      buildInspectorModelCached({
        mode: "default",
        profileId: workspace.activeProfileId,
        chatId: input.chatId,
        objectiveId: workspace.objectiveId,
        inspectorTab: normalizedWorkbenchInspectorTab(input.inspectorTab),
        focusKind: workspace.focusKind,
        focusId: workspace.focusId,
      }),
      loadFactoryProfiles(),
    ]);
    const chat: FactoryChatIslandModel = {
      ...baseChat,
      objectiveId: workspace.objectiveId ?? baseChat.objectiveId,
      inspectorTab: normalizedWorkbenchInspectorTab(input.inspectorTab),
      selectedThread: workspace.selectedObjective ?? baseChat.selectedThread,
      activeCodex: workspace.activeCodex ?? baseChat.activeCodex,
      liveChildren: workspace.liveChildren ?? baseChat.liveChildren,
      activeRun: workspace.activeRun ?? baseChat.activeRun,
      workbench: workspace.workbench ?? baseChat.workbench,
    };
    return {
      activeProfileId: workspace.activeProfileId,
      activeProfileLabel: workspace.activeProfileLabel,
      chatId: input.chatId,
      objectiveId: workspace.objectiveId,
      inspectorTab: normalizedWorkbenchInspectorTab(input.inspectorTab),
      detailTab: workspace.detailTab,
      focusKind: workspace.focusKind,
      focusId: workspace.focusId,
      filter: workspace.filter,
      profiles: profiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        href: buildWorkbenchLink({
          profileId: profile.id,
          chatId: input.chatId,
          objectiveId: workspace.selectedObjective?.profileId === profile.id ? workspace.objectiveId : undefined,
          inspectorTab: workspace.selectedObjective?.profileId === profile.id
            ? normalizedWorkbenchInspectorTab(input.inspectorTab)
            : undefined,
          detailTab: workspace.detailTab,
          focusKind: workspace.selectedObjective?.profileId === profile.id ? workspace.focusKind : undefined,
          focusId: workspace.selectedObjective?.profileId === profile.id ? workspace.focusId : undefined,
          filter: workspace.filter,
        }),
        summary: describeProfileMarkdown(profile).summary,
        selected: profile.id === workspace.activeProfileId,
      })),
      workspace,
      chat,
      inspector,
    };
  };

  const buildWorkbenchPageModelCached = async (input: {
    readonly profileId?: string;
    readonly chatId: string;
    readonly objectiveId?: string;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly detailTab?: FactoryWorkbenchDetailTab;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly filter: FactoryWorkbenchFilterKey;
  }): Promise<FactoryWorkbenchPageModel> => {
    const sessionVersion = await resolveSessionStreamVersion({
      profileId: input.profileId,
      chatId: input.chatId,
    });
    const objectiveVersion = await resolveObjectiveProjectionVersion();
    return withProjectionCache(
      workbenchPageCache,
      JSON.stringify({
        input,
        queueVersion: ctx.queue.snapshot?.().version ?? 0,
        objectiveVersion,
        sessionVersion,
      }),
      () => buildWorkbenchPageModel(input),
    );
  };

  const hydrateInspectorPanel = async (model: FactoryInspectorModel): Promise<FactoryInspectorModel> => {
    const objectiveId = model.objectiveId ?? model.selectedObjective?.objectiveId;
    const panel = model.panel;
    let analysis: FactoryInspectorModel["analysis"];
    let receipts: FactoryInspectorModel["receipts"];
    let tasks: FactoryInspectorModel["tasks"];

    if (objectiveId) {
      if (panel === "analysis" && !model.analysis) {
        analysis = await readObjectiveAnalysis(service.dataDir, objectiveId).catch(() => undefined);
      } else if (panel === "receipts" && !model.receipts) {
        try {
          receipts = await service.listObjectiveReceipts(objectiveId, 100);
        } catch {
          // Ignore if not initialized
        }
      } else if (panel === "execution") {
        tasks = model.tasks;
        if (!tasks) {
          try {
            const detail = await service.getObjective(objectiveId);
            tasks = detail.tasks;
          } catch {
            // Ignore if not initialized
          }
        }
      }
    }

    return {
      ...model,
      panel,
      analysis: analysis ?? model.analysis,
      receipts: receipts ?? model.receipts,
      tasks: tasks ?? model.tasks,
    };
  };

  return {
    id: "factory",
    kind: "factory",
    paths: {
      shell: "/factory",
      state: "/factory/api/objectives",
      events: "/factory/events",
    },
    register: (app: Hono) => {
      app.get("/factory/control", async (c) => {
        const url = new URL(c.req.raw.url);
        const location = `/factory${url.search}`;
        return new Response(null, {
          status: 303,
          headers: {
            Location: location,
            "Cache-Control": "no-store",
          },
        });
      });

      app.get("/factory/workbench", async (c) => wrap(
        async () => {
          const requestedProfile = requestedProfileId(c.req.raw) ?? "generalist";
          const requestedChat = requestedChatId(c.req.raw) ?? makeFactoryChatId();
          const requestedObjective = requestedObjectiveId(c.req.raw);
          const requestedInspector = normalizedWorkbenchInspectorTab(requestedInspectorTab(c.req.raw));
          const requestedDetail = normalizedWorkbenchDetailTab(
            requestedWorkbenchDetailTab(c.req.raw),
            Boolean(requestedObjective),
          );
          const requestedFocusKindValue = normalizeFocusKind(requestedFocusKind(c.req.raw));
          const requestedFocusIdValue = requestedFocusId(c.req.raw);
          const requestedFilter = requestedWorkbenchFilter(c.req.raw);
          const model = await buildWorkbenchPageModelCached({
            profileId: requestedProfile,
            chatId: requestedChat,
            objectiveId: requestedObjective,
            inspectorTab: requestedInspector,
            detailTab: requestedDetail,
            focusKind: requestedFocusKindValue,
            focusId: requestedFocusIdValue,
            filter: requestedFilter,
          });
          return {
            redirect: buildWorkbenchLink({
              profileId: model.activeProfileId,
              chatId: requestedChat,
              objectiveId: model.objectiveId ?? requestedObjective,
              inspectorTab: model.inspectorTab,
              detailTab: model.detailTab,
              filter: model.filter,
              focusKind: model.focusKind,
              focusId: model.focusId,
            }),
          };
        },
        (result) => new Response(null, {
          status: 303,
          headers: {
            Location: result.redirect,
            "Cache-Control": "no-store",
          },
        })
      ));

      app.post("/factory/compose", async (c) => {
        const req = c.req.raw;
        try {
          const body = await readRecordBody(req, (message) => new FactoryServiceError(400, message));
          const prompt = optionalTrimmedString(body.prompt);
          if (!prompt) return navigationError(req, 400, "Enter a chat message or slash command.");

          const profileId = requestedProfileId(req) ?? "generalist";
          const chatId = requestedChatId(req) ?? makeFactoryChatId();
          const objectiveId = requestedObjectiveId(req);
          const inspectorTab = normalizedWorkbenchInspectorTab(requestedInspectorTab(req));
          const detailTab = normalizedWorkbenchDetailTab(requestedWorkbenchDetailTab(req), Boolean(objectiveId));
          const focusKind = normalizeFocusKind(requestedFocusKind(req));
          const focusId = requestedFocusId(req);
          const filter = requestedWorkbenchFilter(req);
          const resolved = await resolveFactoryChatProfile({
            repoRoot: service.git.repoRoot,
            profileRoot,
            requestedId: profileId,
          });

          if (prompt.startsWith("/")) {
            const parsed = parseComposerDraft(prompt, objectiveId);
            if (!parsed.ok) return navigationError(req, 400, parsed.error);
            const command = parsed.command;
            switch (command.type) {
              case "help":
                return workbenchNavigationResponse(req, buildWorkbenchLink({
                  profileId,
                  chatId,
                  objectiveId,
                  inspectorTab,
                  detailTab,
                  filter,
                  focusKind,
                  focusId,
                }), {
                  chatId,
                  objectiveId,
                  focusKind,
                  focusId,
                });
              case "watch": {
                const nextObjectiveId = await resolveWatchedObjectiveId(command.objectiveId ?? objectiveId);
                if (!nextObjectiveId) {
                  return navigationError(req, 404, command.objectiveId
                    ? `Objective '${command.objectiveId}' was not found.`
                    : "Select an objective or provide one to /watch.");
                }
                return workbenchNavigationResponse(req, buildWorkbenchLink({
                  profileId,
                  chatId,
                  objectiveId: nextObjectiveId,
                  inspectorTab,
                  detailTab: "action",
                  filter,
                }), {
                  chatId,
                  objectiveId: nextObjectiveId,
                });
              }
              case "new": {
                const targetProfileId = objectiveProfileIdForPrompt({
                  prompt: command.prompt,
                  resolvedProfile: resolved.root,
                  profiles: await loadFactoryProfiles(),
                });
                const created = await service.createObjective({
                  title: command.title ?? "Factory objective",
                  prompt: command.prompt,
                  objectiveMode: command.objectiveMode,
                  profileId: targetProfileId,
                  startImmediately: true,
                });
                ctx.sse.publish("factory", created.objectiveId);
                return workbenchNavigationResponse(req, buildWorkbenchLink({
                  profileId,
                  chatId,
                  objectiveId: created.objectiveId,
                  inspectorTab,
                  detailTab: "action",
                  filter,
                }), {
                  chatId,
                  objectiveId: created.objectiveId,
                });
              }
              case "react": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before reacting to it.");
                const detail = await service.reactObjectiveWithNote(objectiveId, command.message);
                ctx.sse.publish("factory", detail.objectiveId);
                return workbenchNavigationResponse(req, buildWorkbenchLink({
                  profileId,
                  chatId,
                  objectiveId: detail.objectiveId,
                  inspectorTab,
                  detailTab,
                  filter,
                }), {
                  chatId,
                  objectiveId: detail.objectiveId,
                });
              }
              case "promote": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before promoting it.");
                const detail = await service.promoteObjective(objectiveId);
                ctx.sse.publish("factory", detail.objectiveId);
                return workbenchNavigationResponse(req, buildWorkbenchLink({
                  profileId,
                  chatId,
                  objectiveId: detail.objectiveId,
                  inspectorTab,
                  detailTab,
                  filter,
                }), {
                  chatId,
                  objectiveId: detail.objectiveId,
                });
              }
              case "cancel": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before canceling it.");
                const detail = await service.cancelObjective(objectiveId, command.reason ?? "canceled from workbench");
                ctx.sse.publish("factory", detail.objectiveId);
                return workbenchNavigationResponse(req, buildWorkbenchLink({
                  profileId,
                  chatId,
                  objectiveId: detail.objectiveId,
                  inspectorTab,
                  detailTab,
                  filter,
                }), {
                  chatId,
                  objectiveId: detail.objectiveId,
                });
              }
              case "cleanup": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before cleaning workspaces.");
                const detail = await service.cleanupObjectiveWorkspaces(objectiveId);
                ctx.sse.publish("factory", detail.objectiveId);
                return workbenchNavigationResponse(req, buildWorkbenchLink({
                  profileId,
                  chatId,
                  objectiveId: detail.objectiveId,
                  inspectorTab,
                  detailTab,
                  filter,
                }), {
                  chatId,
                  objectiveId: detail.objectiveId,
                });
              }
              case "archive": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before archiving it.");
                const detail = await service.archiveObjective(objectiveId);
                ctx.sse.publish("factory", detail.objectiveId);
                return workbenchNavigationResponse(req, buildWorkbenchLink({
                  profileId,
                  chatId,
                  objectiveId: detail.objectiveId,
                  inspectorTab,
                  detailTab,
                  filter,
                }), {
                  chatId,
                  objectiveId: detail.objectiveId,
                });
              }
              case "abort-job": {
                const job = await resolveComposerJob(objectiveId, optionalTrimmedString(body.currentJobId) ?? requestedJobId(req));
                const queued = await service.queueJobAbort(
                  job.id,
                  command.reason ?? "abort requested from workbench",
                  "factory.workbench",
                );
                return workbenchNavigationResponse(req, buildWorkbenchLink({
                  profileId,
                  chatId,
                  objectiveId: jobObjectiveId(queued.job) ?? objectiveId,
                  inspectorTab,
                  detailTab,
                  filter,
                  focusKind: "job",
                  focusId: queued.job.id,
                }), {
                  chatId,
                  objectiveId: jobObjectiveId(queued.job) ?? objectiveId,
                  focusKind: "job",
                  focusId: queued.job.id,
                });
              }
            }
          }

          const stream = factoryChatSessionStream(service.git.repoRoot, resolved.root.id, chatId);
          const runId = makeFactoryRunId();
          const created = await ctx.queue.enqueue({
            agentId: "factory",
            lane: "chat",
            sessionKey: `factory-chat:${stream}`,
            singletonMode: "steer",
            maxAttempts: 1,
            payload: {
              kind: "factory.run",
              stream,
              runId,
              problem: prompt,
              profileId: resolved.root.id,
              chatId,
              ...(objectiveId ? { objectiveId } : {}),
            },
          });
          ctx.sse.publish("jobs", created.id);
          return workbenchNavigationResponse(req, buildWorkbenchLink({
            profileId,
            chatId,
            objectiveId,
            inspectorTab,
            detailTab,
            filter,
            focusKind,
            focusId,
          }), {
            chatId,
            objectiveId,
            focusKind,
            focusId,
            live: {
              profileId,
              chatId,
              objectiveId,
              runId,
              jobId: created.id,
            },
          });
        } catch (err) {
          if (err instanceof FactoryServiceError) return navigationError(req, err.status, err.message);
          const message = err instanceof Error ? err.message : "factory server error";
          console.error(err);
          return navigationError(req, 500, message);
        }
      });

      app.get("/factory/events", async (c) => wrap(
        async () => {
          return resolveChatEventSubscriptions({
            profileId: requestedProfileId(c.req.raw) ?? "generalist",
            chatId: requestedChatId(c.req.raw),
            objectiveId: requestedObjectiveId(c.req.raw),
            runId: requestedRunId(c.req.raw),
            jobId: requestedJobId(c.req.raw),
          });
        },
        (body) => subscribeChatEventStream(body, c.req.raw.signal)
      ));

      app.get("/factory/chat/events", async (c) => wrap(
        async () => resolveChatEventSubscriptions({
          profileId: requestedProfileId(c.req.raw) ?? "generalist",
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
        }),
        (body) => subscribeChatEventStream(body, c.req.raw.signal)
      ));

      app.get("/factory/background/events", async (c) => wrap(
        async () => {
          const chatId = requestedChatId(c.req.raw) ?? makeFactoryChatId();
          const inspectorTab = normalizedWorkbenchInspectorTab(requestedInspectorTab(c.req.raw));
          const model = await buildWorkbenchPageModelCached({
            profileId: requestedProfileId(c.req.raw) ?? "generalist",
            chatId,
            objectiveId: requestedObjectiveId(c.req.raw),
            inspectorTab,
            detailTab: requestedWorkbenchDetailTab(c.req.raw),
            focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
            focusId: requestedFocusId(c.req.raw),
            filter: requestedWorkbenchFilter(c.req.raw),
          });
          return {
            profileId: model.activeProfileId,
            objectiveId: model.objectiveId,
          };
        },
        (body) => ctx.sse.subscribeMany([
          { topic: "profile-board" as const, stream: body.profileId },
          ...(body.objectiveId ? [{ topic: "objective-runtime" as const, stream: body.objectiveId }] : []),
        ], c.req.raw.signal)
      ));

      app.get("/factory/island/workbench/header", async (c) => wrap(
        async () => buildWorkbenchPageModelCached({
          profileId: requestedProfileId(c.req.raw) ?? "generalist",
          chatId: requestedChatId(c.req.raw) ?? makeFactoryChatId(),
          objectiveId: requestedObjectiveId(c.req.raw),
          inspectorTab: normalizedWorkbenchInspectorTab(requestedInspectorTab(c.req.raw)),
          detailTab: requestedWorkbenchDetailTab(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
          filter: requestedWorkbenchFilter(c.req.raw),
        }),
        (model) => html(factoryWorkbenchHeaderIsland(model))
      ));

      app.get("/factory/island/workbench/block", async (c) => wrap(
        async () => {
          const model = await buildWorkbenchPageModelCached({
            profileId: requestedProfileId(c.req.raw) ?? "generalist",
            chatId: requestedChatId(c.req.raw) ?? makeFactoryChatId(),
            objectiveId: requestedObjectiveId(c.req.raw),
            inspectorTab: normalizedWorkbenchInspectorTab(requestedInspectorTab(c.req.raw)),
            detailTab: requestedWorkbenchDetailTab(c.req.raw),
            focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
            focusId: requestedFocusId(c.req.raw),
            filter: requestedWorkbenchFilter(c.req.raw),
          });
          const blockKey = optionalTrimmedString(c.req.query("block"));
          return {
            model,
            blockKey,
          };
        },
        ({ model, blockKey }) => html(factoryWorkbenchBlockIsland(model.workspace, {
          profileId: model.activeProfileId,
          chatId: model.chatId,
          objectiveId: model.objectiveId,
          inspectorTab: model.inspectorTab,
          detailTab: model.detailTab,
          focusKind: model.focusKind,
          focusId: model.focusId,
          filter: model.filter,
        }, blockKey ?? "summary"))
      ));

      app.get("/factory/island/workbench", async (c) => wrap(
        async () => buildWorkbenchPageModelCached({
          profileId: requestedProfileId(c.req.raw) ?? "generalist",
          chatId: requestedChatId(c.req.raw) ?? makeFactoryChatId(),
          objectiveId: requestedObjectiveId(c.req.raw),
          inspectorTab: normalizedWorkbenchInspectorTab(requestedInspectorTab(c.req.raw)),
          detailTab: requestedWorkbenchDetailTab(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
          filter: requestedWorkbenchFilter(c.req.raw),
        }),
        (model) => html(factoryWorkbenchWorkspaceIsland(model.workspace, {
          profileId: model.activeProfileId,
          chatId: model.chatId,
          objectiveId: model.objectiveId,
          inspectorTab: model.inspectorTab,
          detailTab: model.detailTab,
          focusKind: model.focusKind,
          focusId: model.focusId,
          filter: model.filter,
        }))
      ));

      app.get("/factory/island/chat", async (c) => wrap(
        async () => buildWorkbenchPageModelCached({
          profileId: requestedProfileId(c.req.raw) ?? "generalist",
          chatId: requestedChatId(c.req.raw) ?? makeFactoryChatId(),
          objectiveId: requestedObjectiveId(c.req.raw),
          inspectorTab: normalizedWorkbenchInspectorTab(requestedInspectorTab(c.req.raw)),
          detailTab: requestedWorkbenchDetailTab(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
          filter: requestedWorkbenchFilter(c.req.raw),
        }),
        (model) => html(factoryWorkbenchChatIsland(model.chat, {
          profileId: model.activeProfileId,
          chatId: model.chatId,
          objectiveId: model.objectiveId,
          inspectorTab: model.inspectorTab,
          detailTab: model.detailTab,
          focusKind: model.focusKind,
          focusId: model.focusId,
          filter: model.filter,
        }))
      ));

      app.get("/factory/api/workbench-shell", async (c) => wrap(
        async () => {
          const requestedProfile = requestedProfileId(c.req.raw) ?? "generalist";
          const requestedChat = requestedChatId(c.req.raw) ?? makeFactoryChatId();
          const requestedObjective = requestedObjectiveId(c.req.raw);
          const requestedInspector = normalizedWorkbenchInspectorTab(requestedInspectorTab(c.req.raw));
          const requestedDetail = normalizedWorkbenchDetailTab(
            requestedWorkbenchDetailTab(c.req.raw),
            Boolean(requestedObjective),
          );
          const requestedFocusKindValue = normalizeFocusKind(requestedFocusKind(c.req.raw));
          const requestedFocusIdValue = requestedFocusId(c.req.raw);
          const requestedFilter = requestedWorkbenchFilter(c.req.raw);
          const model = await buildWorkbenchPageModelCached({
            profileId: requestedProfile,
            chatId: requestedChat,
            objectiveId: requestedObjective,
            inspectorTab: requestedInspector,
            detailTab: requestedDetail,
            focusKind: requestedFocusKindValue,
            focusId: requestedFocusIdValue,
            filter: requestedFilter,
          });
          const shouldRedirectForProfile = (
            requestedProfileId(c.req.raw) !== undefined
            || Boolean(requestedObjective)
          ) && requestedProfile !== model.activeProfileId;
          const shouldRedirectForObjective = Boolean(requestedObjective) && requestedObjective !== model.objectiveId;
          const shouldRedirectForFocus = (
            requestedFocusKindValue !== undefined
            || requestedFocusIdValue !== undefined
          ) && (
            requestedFocusKindValue !== model.focusKind
            || requestedFocusIdValue !== model.focusId
          );
          const shouldRedirectForInspector = requestedInspector !== model.inspectorTab;
          const shouldRedirectForDetail = requestedDetail !== model.detailTab;
          const shouldRedirectForFilter = requestedFilter !== model.filter;
          const snapshot = buildFactoryWorkbenchShellSnapshot(model);
          return {
            snapshot: (
              shouldRedirectForProfile
              || shouldRedirectForObjective
              || shouldRedirectForInspector
              || shouldRedirectForDetail
              || shouldRedirectForFocus
              || shouldRedirectForFilter
            )
              ? {
                  ...snapshot,
                  location: buildWorkbenchLink({
                    profileId: model.activeProfileId,
                    chatId: requestedChat,
                    objectiveId: model.objectiveId,
                    inspectorTab: model.inspectorTab,
                    detailTab: model.detailTab,
                    focusKind: model.focusKind,
                    focusId: model.focusId,
                    filter: model.filter,
                  }),
                }
              : snapshot,
          };
        },
        (result) => json(200, result.snapshot)
      ));

      app.get("/factory", async (c) => wrap(
        async () => {
          const requestedProfile = requestedProfileId(c.req.raw) ?? "generalist";
          const explicitChat = requestedChatId(c.req.raw);
          const requestedChat = explicitChat ?? makeFactoryChatId();
          const requestedObjective = requestedObjectiveId(c.req.raw);
          const requestedInspector = normalizedWorkbenchInspectorTab(requestedInspectorTab(c.req.raw));
          const requestedDetail = normalizedWorkbenchDetailTab(
            requestedWorkbenchDetailTab(c.req.raw),
            Boolean(requestedObjective),
          );
          const requestedFocusKindValue = normalizeFocusKind(requestedFocusKind(c.req.raw));
          const requestedFocusIdValue = requestedFocusId(c.req.raw);
          const requestedFilter = requestedWorkbenchFilter(c.req.raw);
          const model = await buildWorkbenchPageModelCached({
            profileId: requestedProfile,
            chatId: requestedChat,
            objectiveId: requestedObjective,
            inspectorTab: requestedInspector,
            detailTab: requestedDetail,
            focusKind: requestedFocusKindValue,
            focusId: requestedFocusIdValue,
            filter: requestedFilter,
          });
          const shouldRedirectForProfile = (
            requestedProfileId(c.req.raw) !== undefined
            || Boolean(requestedObjective)
          ) && requestedProfile !== model.activeProfileId;
          const shouldRedirectForObjective = Boolean(requestedObjective) && requestedObjective !== model.objectiveId;
          const shouldRedirectForFocus = (
            requestedFocusKindValue !== undefined
            || requestedFocusIdValue !== undefined
          ) && (
            requestedFocusKindValue !== model.focusKind
            || requestedFocusIdValue !== model.focusId
          );
          const shouldRedirectForInspector = requestedInspector !== model.inspectorTab;
          const shouldRedirectForDetail = requestedDetail !== model.detailTab;
          const shouldRedirectForFilter = requestedFilter !== model.filter;
          if (
            shouldRedirectForProfile
            || shouldRedirectForObjective
            || shouldRedirectForInspector
            || shouldRedirectForDetail
            || shouldRedirectForFocus
            || shouldRedirectForFilter
          ) {
            return {
              redirect: buildWorkbenchLink({
                profileId: model.activeProfileId,
                chatId: requestedChat,
                objectiveId: model.objectiveId,
                inspectorTab: model.inspectorTab,
                detailTab: model.detailTab,
                focusKind: model.focusKind,
                focusId: model.focusId,
                filter: model.filter,
              }),
            };
          }
          return {
            model,
          };
        },
        (result) => "redirect" in result
          ? new Response(null, {
              status: 303,
              headers: {
                Location: result.redirect ?? "/factory",
                "Cache-Control": "no-store",
              },
            })
          : html(factoryWorkbenchShell(result.model))
      ));

      app.get("/factory/new-chat", async (c) => wrap(
        async () => buildWorkbenchLink({
          profileId: requestedProfileId(c.req.raw) ?? "generalist",
          chatId: makeFactoryChatId(),
          inspectorTab: "chat",
          detailTab: requestedWorkbenchDetailTab(c.req.raw) ?? "queue",
          filter: requestedWorkbenchFilter(c.req.raw),
        }),
        (location) => new Response(null, {
          status: 303,
          headers: {
            Location: location,
            "Cache-Control": "no-store",
          },
        })
      ));

      app.get("/factory/api/live-output", async (c) => wrap(
        async () => {
          const objectiveId = requestedObjectiveId(c.req.raw);
          const focusKind = requestedFocusKind(c.req.raw);
          const focusId = requestedFocusId(c.req.raw);
          return {
            liveOutput: objectiveId && focusId && (focusKind === "task" || focusKind === "job")
              ? await service.getObjectiveLiveOutput(objectiveId, focusKind as FactoryLiveOutputTargetKind, focusId)
              : undefined,
          };
        },
        (body) => json(200, body)
      ));

      app.get("/factory/api/objectives", async (c) => wrap(
        async () => ({
          objectives: await service.listObjectives(),
          board: await service.buildBoardProjection(optionalTrimmedString(c.req.query("objective"))),
        }),
        (body) => json(200, body)
      ));

      app.get("/factory/api/objectives/:id", async (c) => wrap(
        async () => ({ objective: await service.getObjective(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.get("/factory/api/objectives/:id/debug", async (c) => wrap(
        async () => ({ debug: await service.getObjectiveDebug(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.get("/factory/api/objectives/:id/receipts", async (c) => wrap(
        async () => ({
          receipts: await service.listObjectiveReceipts(
            c.req.param("id"),
            Number.parseInt(c.req.query("limit") ?? "40", 10),
          ),
        }),
        (body) => json(200, body)
      ));

      // ── Receipt browser routes ──────────────────────────────────────
      const receiptDataDir = ctx.dataDir;
      const receiptSse = ctx.sse;
      const receiptDb = getReceiptDb(receiptDataDir);

      const dbStreamsToFileInfo = (streams: ReadonlyArray<{ name: string; receiptCount: number; updatedAt: number }>): ReceiptFileInfo[] =>
        streams.map((s) => ({ name: s.name, size: s.receiptCount, mtime: s.updatedAt }));

      const dbReceiptsToRecords = (rows: ReadonlyArray<{ globalSeq: number; streamSeq: number; ts: number; hash: string; eventType: string; bodyJson: string }>): ReceiptRecord[] =>
        rows.map((row) => {
          const envelope = { stream: "", seq: row.streamSeq, ts: row.ts, hash: row.hash, body: JSON.parse(row.bodyJson) };
          const raw = JSON.stringify(envelope);
          return { raw, data: envelope };
        });

      app.get("/receipt", async (c) => {
        const file = c.req.query("file") ?? "";
        const order = parseOrder(c.req.query("order"));
        const limit = parseLimit(c.req.query("limit"));
        const depth = parseInspectorDepth(c.req.query("depth"));
        const files = dbStreamsToFileInfo(listReceiptStreams(receiptDb));
        const selected = files.find((f) => f.name === file)?.name ?? files[0]?.name;
        return html(receiptShell({ selected, limit, order, depth }));
      });

      app.get("/receipt/island/folds", async (c) => {
        const selected = c.req.query("selected") ?? "";
        const order = parseOrder(c.req.query("order"));
        const limit = parseLimit(c.req.query("limit"));
        const depth = parseInspectorDepth(c.req.query("depth"));
        const files = dbStreamsToFileInfo(listReceiptStreams(receiptDb));
        return html(receiptFoldsHtml(files, selected, order, limit, depth));
      });

      app.get("/receipt/island/records", async (c) => {
        const file = c.req.query("file") ?? "";
        if (!file) return html(receiptRecordsHtml({ selected: undefined, records: [], order: "desc", limit: 200, total: 0 }));
        const order = parseOrder(c.req.query("order"));
        const limit = parseLimit(c.req.query("limit"));
        const rows = readReceiptsByStream(receiptDb, file, { order, limit });
        if (rows.length === 0) return html(`<div class="empty">Stream not found.</div>`);
        const records = dbReceiptsToRecords(rows);
        const total = countReceiptsInStream(receiptDb, file);
        return html(receiptRecordsHtml({ selected: file, records, order, limit, total }));
      });

      app.get("/receipt/island/side", async (c) => {
        const file = c.req.query("file") ?? "";
        const order = parseOrder(c.req.query("order"));
        const limit = parseLimit(c.req.query("limit"));
        const depth = parseInspectorDepth(c.req.query("depth"));
        if (!file) {
          return html(receiptSideHtml({ selected: undefined, order, limit, depth, total: 0, shown: 0 }));
        }
        const total = countReceiptsInStream(receiptDb, file);
        if (total === 0) {
          return html(receiptSideHtml({ selected: file, order, limit, depth, total: 0, shown: 0 }));
        }
        const rows = readReceiptsByStream(receiptDb, file, { order, limit });
        const records = dbReceiptsToRecords(rows);
        const allRecords = order === "desc" || rows.length < total
          ? dbReceiptsToRecords(readReceiptsByStream(receiptDb, file, { order: "asc", limit: total }))
          : records;
        const timeline = buildReceiptTimeline(allRecords, depth);
        return html(receiptSideHtml({
          selected: file,
          order,
          limit,
          depth,
          total,
          shown: records.length,
          timeline,
        }));
      });

      app.get("/receipt/stream", async (c) => receiptSse.subscribe("receipt", undefined, c.req.raw.signal));
    },
  };
};

export default createFactoryRoute;
