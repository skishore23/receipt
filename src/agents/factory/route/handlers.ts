import path from "node:path";

import type { Hono } from "hono";

import { LocalCodexExecutor } from "../../../adapters/codex-executor";
import type { MemoryTools } from "../../../adapters/memory-tools";
import type { Runtime } from "@receipt/core/runtime";
import {
  text,
} from "../../../framework/http";
import type { AgentLoaderContext, AgentRouteModule } from "../../../framework/agent-types";
import { agentRunStream } from "../../agent.streams";
import type { AgentCmd, AgentEvent, AgentState } from "../../../modules/agent";
import {
  factoryChatSessionStream,
  assertFactoryProfileCreateModeAllowed,
  assertFactoryProfileDispatchActionAllowed,
  factoryChatResolvedProfileActionSubject,
  type FactoryChatProfileObjectiveMode,
} from "../../../services/factory-chat-profiles";
import {
  FactoryService,
  FactoryServiceError,
} from "../../../services/factory-service";
import {
  toFactorySelectedObjectiveCard,
} from "../../../views/factory/objective-presenters";
import { buildFactoryWorkbench } from "../../../views/factory-workbench";
import type { FactoryWorkbenchHeaderIslandModel } from "../../../views/factory/workbench/page";
import {
  type FactoryChatIslandModel,
  type FactoryChatObjectiveNav,
  type FactoryInspectorTab,
  type FactoryLiveRunCard,
  type FactorySelectedObjectiveCard,
  type FactoryWorkbenchBlockModel,
  type FactoryWorkbenchDetailTab,
  type FactoryWorkbenchFilterKey,
  type FactoryWorkbenchFilterModel,
  type FactoryWorkbenchPageModel,
  type FactoryWorkbenchSectionModel,
  type FactoryWorkbenchStatModel,
  type WorkbenchVersionEnvelope,
  type FactoryWorkbenchWorkspaceModel,
} from "../../../views/factory-models";
import type { QueueJob } from "../../../adapters/sqlite-queue";
import type { FactoryObjectiveDetail } from "../../../services/factory-types";
import { buildChatItemsForRun, buildChatItemsFromConversation } from "../chat-items";
import {
} from "../chat-context";
import {
  buildChatLink,
  latestObjectiveIdFromJobs,
  latestObjectiveIdFromRunChains,
  normalizeKnownObjectiveId,
} from "../links";
import {
  buildActiveCodexCard,
  buildLiveChildCards,
  collectRunIds,
} from "../live-jobs";
import {
  buildObjectiveNavCards,
  collectTerminalRunIds,
} from "../page-builders";
import { describeProfileMarkdown } from "../profile-markdown";
import { projectAgentRun } from "../run-projection";
import {
  asString,
  isActiveJobStatus,
  jobAnyRunId,
  jobObjectiveId,
  jobParentRunId,
  jobRunId,
  type AgentRunChain,
} from "../shared";
import {
  buildWorkbenchLink,
} from "./navigation";
import { getReceiptDb } from "../../../db/client";
import { syncChangedChatContextProjections } from "../../../db/projectors";
import { createFactoryRouteCache } from "./cache";
import { createFactoryRouteEvents } from "./events";
import { registerFactoryApiRoutes } from "./register-factory-api-routes";
import { registerFactoryPreviewRoutes } from "./register-factory-preview-routes";
import { registerFactoryLinearUiRoutes } from "./register-factory-ui-routes-linear";
import { registerFactoryUiRoutes } from "./register-factory-ui-routes";
import { registerReceiptRoutes } from "./register-receipt-routes";
import { registerRuntimeRoutes } from "./register-runtime-routes";
import { createRuntimeDashboardLoader } from "./runtime-dashboard";
import { createFactoryRouteSessionRuntime } from "./session-runtime";
import type { FactoryDispatchAction } from "../dispatch";
import {
  isTerminalObjectiveStatus,
  normalizedWorkbenchDetailTab,
  normalizedWorkbenchInspectorTab,
} from "./params";
import {
  readWorkbenchRequest,
  type FactoryWorkbenchRequestState,
} from "./workbench-request";

const createFactoryRoute = (ctx: AgentLoaderContext): AgentRouteModule => {
  const helpers = ctx.helpers ?? {};
  const memoryTools = helpers.memoryTools as MemoryTools | undefined;
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
    resolveFactoryChatProfileCached,
    resolveObjectiveProjectionVersionCached,
    resolveSessionStreamVersionCached,
    loadChatContextProjectionForSession,
    withProjectionCache,
  } = routeCache;

  type WorkbenchServerTiming = {
    readonly measure: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  };

  type WorkbenchResolvedVersions = {
    readonly sessionVersion?: string;
    readonly objectiveVersion: number;
    readonly queueVersion: number;
  };

  type ObjectiveChatBinding = {
    readonly objectiveId: string;
    readonly chatId: string;
    readonly profileId: string;
  };

  const readObjectiveChatBindings = async (
    objectiveIds: ReadonlyArray<string>,
    profileId?: string,
  ): Promise<ReadonlyMap<string, ObjectiveChatBinding>> => {
    const normalizedObjectiveIds = [...new Set(
      objectiveIds
        .map((value) => value.trim())
        .filter(Boolean),
    )];
    if (!chatProjectionDataDir || normalizedObjectiveIds.length === 0) return new Map();
    await syncChangedChatContextProjections(chatProjectionDataDir).catch(() => undefined);
    const db = getReceiptDb(chatProjectionDataDir);
    const normalizedProfileId = profileId?.trim();
    const placeholders = normalizedObjectiveIds.map(() => "?").join(", ");
    const rows = db.read(() => db.sqlite.query(`
      SELECT
        bound_objective_id AS objectiveId,
        chat_id AS chatId,
        profile_id AS profileId,
        updated_at AS updatedAt
      FROM chat_context_projection
      WHERE bound_objective_id IN (${placeholders})
        ${normalizedProfileId ? "AND profile_id = ?" : ""}
      ORDER BY updated_at DESC, stream DESC
    `).all(
      ...normalizedObjectiveIds,
      ...(normalizedProfileId ? [normalizedProfileId] : []),
    ) as ReadonlyArray<{
      readonly objectiveId?: string;
      readonly chatId?: string;
      readonly profileId?: string;
      readonly updatedAt?: number;
    }>);
    const bindings = new Map<string, ObjectiveChatBinding>();
    for (const row of rows) {
      const objectiveId = row.objectiveId?.trim();
      const chatId = row.chatId?.trim();
      const resolvedProfileId = row.profileId?.trim();
      if (!objectiveId || !chatId || !resolvedProfileId || bindings.has(objectiveId)) continue;
      bindings.set(objectiveId, {
        objectiveId,
        chatId,
        profileId: resolvedProfileId,
      });
    }
    return bindings;
  };

  const resolveObjectiveChatBinding = async (
    objectiveId: string,
    profileId?: string,
  ): Promise<ObjectiveChatBinding | undefined> => {
    const bindings = await readObjectiveChatBindings([objectiveId], profileId);
    return bindings.get(objectiveId);
  };

  type WorkbenchRequestContext = {
    readonly request: FactoryWorkbenchRequestState;
    readonly versions: WorkbenchResolvedVersions;
  };

  type WorkbenchRequestBoardModel = {
    readonly request: FactoryWorkbenchRequestState;
    readonly envelope: WorkbenchVersionEnvelope;
    readonly header: FactoryWorkbenchHeaderIslandModel;
    readonly workspace: FactoryWorkbenchWorkspaceModel;
  };

  type WorkbenchRequestFocusModel = {
    readonly request: FactoryWorkbenchRequestState;
    readonly envelope: WorkbenchVersionEnvelope;
    readonly workspace: FactoryWorkbenchWorkspaceModel;
  };

  type WorkbenchRequestChatBodyModel = {
    readonly request: FactoryWorkbenchRequestState;
    readonly envelope: WorkbenchVersionEnvelope;
    readonly workspace: FactoryWorkbenchWorkspaceModel;
    readonly chat: FactoryChatIslandModel;
  };

  const buildWorkbenchVersionEnvelope = (
    request: FactoryWorkbenchRequestState,
    versions: WorkbenchResolvedVersions,
  ): WorkbenchVersionEnvelope => ({
    routeKey: buildWorkbenchLink({
      profileId: request.profileId,
      chatId: request.chatId,
      objectiveId: request.objectiveId,
      inspectorTab: request.inspectorTab,
      detailTab: request.detailTab,
      page: request.page,
      focusKind: request.focusKind,
      focusId: request.focusId,
      filter: request.filter,
      basePath: request.shellBase,
    }),
    profileId: request.profileId,
    chatId: request.chatId,
    objectiveId: request.objectiveId,
    boardVersion: `${versions.objectiveVersion}:${versions.queueVersion}:${request.profileId}:${request.filter}:${request.page}`,
    focusVersion: `${versions.objectiveVersion}:${versions.queueVersion}:${request.objectiveId ?? ""}:${request.detailTab}:${request.focusKind ?? ""}:${request.focusId ?? ""}`,
    chatVersion: `${versions.sessionVersion ?? "0:"}:${versions.objectiveVersion}:${request.chatId}:${request.objectiveId ?? ""}:${request.inspectorTab ?? "overview"}`,
  });

  const buildWorkbenchHeaderModel = (input: {
    readonly request: FactoryWorkbenchRequestState;
    readonly workspace: FactoryWorkbenchWorkspaceModel;
    readonly profiles: Awaited<ReturnType<typeof loadFactoryProfiles>>;
  }): FactoryWorkbenchHeaderIslandModel => {
    const activeProfile = input.profiles.find((profile) => profile.id === input.workspace.activeProfileId);
    const activeProfileOverview = !input.workspace.selectedObjective && activeProfile
      ? describeProfileMarkdown(activeProfile)
      : undefined;
    const currentRole = activeProfileOverview?.primaryRole
      ?? activeProfileOverview?.roles?.[0]
      ?? activeProfileOverview?.summary;
    const currentPresence = (() => {
      const summary = activeProfileOverview?.summary?.trim();
      const role = currentRole?.trim();
      return summary && summary !== role ? summary : undefined;
    })();
    return {
      activeProfileId: input.workspace.activeProfileId,
      activeProfileLabel: input.workspace.activeProfileLabel,
      profiles: input.profiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        href: buildWorkbenchLink({
          profileId: profile.id,
          chatId: input.request.chatId,
          objectiveId: input.workspace.selectedObjective?.profileId === profile.id ? input.workspace.objectiveId : undefined,
          inspectorTab: input.workspace.selectedObjective?.profileId === profile.id
            ? normalizedWorkbenchInspectorTab(input.request.inspectorTab)
            : undefined,
          detailTab: input.workspace.detailTab,
          page: input.workspace.page,
          focusKind: input.workspace.selectedObjective?.profileId === profile.id ? input.workspace.focusKind : undefined,
          focusId: input.workspace.selectedObjective?.profileId === profile.id ? input.workspace.focusId : undefined,
          filter: input.workspace.filter,
          basePath: input.request.shellBase,
        }),
        summary: describeProfileMarkdown(profile).summary,
        selected: profile.id === input.workspace.activeProfileId,
      })),
      workspace: input.workspace,
      currentRole,
      currentPresence,
    };
  };

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

  const assertComposeDispatchActionAllowed = (
    profile: Awaited<ReturnType<typeof resolveFactoryChatProfile>>,
    action: FactoryDispatchAction,
  ): void => {
    try {
      assertFactoryProfileDispatchActionAllowed(factoryChatResolvedProfileActionSubject(profile), action);
    } catch (err) {
      throw new FactoryServiceError(409, err instanceof Error ? err.message : "profile action is not allowed");
    }
  };

  const assertComposeCreateModeAllowed = (
    profile: Awaited<ReturnType<typeof resolveFactoryChatProfile>>,
    objectiveMode: FactoryChatProfileObjectiveMode,
  ): void => {
    try {
      assertFactoryProfileCreateModeAllowed(factoryChatResolvedProfileActionSubject(profile), objectiveMode);
    } catch (err) {
      throw new FactoryServiceError(409, err instanceof Error ? err.message : "profile create mode is not allowed");
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

  const workbenchSessionRuntimeCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<Awaited<ReturnType<typeof buildWorkbenchSessionRuntime>>>;
  }>();
  const workbenchWorkspaceCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<FactoryWorkbenchWorkspaceModel>;
  }>();
  const workbenchChatCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<FactoryChatIslandModel>;
  }>();
  const workbenchPageCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<FactoryWorkbenchPageModel>;
  }>();
  const WORKBENCH_MODEL_CACHE_TTL_MS = 5_000;

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

  const loadRuntimeDashboard = createRuntimeDashboardLoader({
    ctx,
    service,
    agentRuntime,
    loadRecentJobs,
  });

  const resolveSessionObjectiveId = async (input: {
    readonly repoRoot: string;
    readonly profileId: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly selectedJob?: QueueJob;
    readonly jobs: ReadonlyArray<QueueJob>;
    readonly liveObjectives?: ReadonlyArray<{ readonly objectiveId: string }>;
  }): Promise<string | undefined> => {
    const normalizeSessionObjectiveId = (candidate: string | undefined): string | undefined => {
      const objectiveId = candidate?.trim();
      if (!objectiveId) return undefined;
      return input.liveObjectives
        ? normalizeKnownObjectiveId(objectiveId, input.liveObjectives)
        : objectiveId;
    };
    const requestedObjectiveId = normalizeSessionObjectiveId(input.objectiveId);
    if (requestedObjectiveId) return requestedObjectiveId;
    const selectedJobObjectiveId = normalizeSessionObjectiveId(jobObjectiveId(input.selectedJob));
    if (selectedJobObjectiveId) return selectedJobObjectiveId;
    if (!input.chatId) return undefined;
    const stream = factoryChatSessionStream(input.repoRoot, input.profileId, input.chatId);
    const projected = await loadChatContextProjectionForSession({ sessionStream: stream });
    const projectedObjectiveId = normalizeSessionObjectiveId(projected?.bindings.objectiveId);
    if (projectedObjectiveId) return projectedObjectiveId;
    const indexChain = await agentRuntime.chain(stream);
    const runIds = collectRunIds(indexChain);
    const runChains = await Promise.all(runIds.map((runId) => agentRuntime.chain(agentRunStream(stream, runId))));
    const discoveredObjectiveId = latestObjectiveIdFromRunChains(runChains)
      ?? latestObjectiveIdFromJobs(input.jobs, stream, input.chatId);
    return normalizeSessionObjectiveId(discoveredObjectiveId);
  };

  const {
    ensureObjectiveHandoffInSession,
    collectExplicitObjectiveJobs,
    buildWorkbenchSessionRuntime,
  } = createFactoryRouteSessionRuntime({
    service,
    agentRuntime,
    profileRoot,
    loadRecentJobs,
    loadFactoryProfiles,
    resolveSessionObjectiveId,
    scopeRunTimelineToObjective,
    loadChatContextProjectionForSession,
    getJob: (jobId) => ctx.queue.getJob(jobId),
  });

  const routeEvents = createFactoryRouteEvents({
    ctx,
    service,
    profileRoot,
    loadRecentJobs,
    resolveSessionObjectiveId,
  });
  const {
    resolveChatEventSubscriptions,
  } = routeEvents;

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

  const sessionContinuationPredecessorObjectiveIds = (
    chain: AgentRunChain,
    preservedObjectiveId?: string,
  ): ReadonlySet<string> => {
    const distinctBindingObjectiveIds: string[] = [];
    let lastBoundObjectiveId: string | undefined;
    for (const receipt of chain) {
      if (receipt.body.type !== "thread.bound") continue;
      const objectiveId = receipt.body.objectiveId.trim();
      if (!objectiveId || objectiveId === lastBoundObjectiveId) continue;
      distinctBindingObjectiveIds.push(objectiveId);
      lastBoundObjectiveId = objectiveId;
    }
    const latestObjectiveId = distinctBindingObjectiveIds.at(-1);
    if (!latestObjectiveId) return new Set<string>();
    return new Set(
      distinctBindingObjectiveIds.filter((objectiveId) =>
        objectiveId !== latestObjectiveId
        && objectiveId !== preservedObjectiveId),
    );
  };

  const filterSessionContinuationPredecessors = <T extends { readonly objectiveId: string }>(
    cards: ReadonlyArray<T> | undefined,
    predecessorObjectiveIds: ReadonlySet<string>,
    preservedObjectiveId?: string,
  ): ReadonlyArray<T> =>
    (cards ?? []).filter((card) =>
      card.objectiveId === preservedObjectiveId
      || !predecessorObjectiveIds.has(card.objectiveId));
  const WORKBENCH_OBJECTIVE_PAGE_SIZE = 8;

  const paginateObjectiveCards = (
    cards: ReadonlyArray<FactoryChatObjectiveNav>,
    page: number,
  ): {
    readonly count: number;
    readonly items: ReadonlyArray<FactoryChatObjectiveNav>;
    readonly page: number;
    readonly pageCount: number;
    readonly hasPreviousPage: boolean;
    readonly hasNextPage: boolean;
  } => {
    const pageCount = Math.max(1, Math.ceil(cards.length / WORKBENCH_OBJECTIVE_PAGE_SIZE));
    const normalizedPage = Math.min(Math.max(1, Math.floor(page || 1)), pageCount);
    const start = (normalizedPage - 1) * WORKBENCH_OBJECTIVE_PAGE_SIZE;
    return {
      count: cards.length,
      items: cards.slice(start, start + WORKBENCH_OBJECTIVE_PAGE_SIZE),
      page: normalizedPage,
      pageCount,
      hasPreviousPage: normalizedPage > 1,
      hasNextPage: normalizedPage < pageCount,
    };
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
    phaseDetail: objective.phaseDetail,
    statusAuthority: objective.statusAuthority,
    hasAuthoritativeLiveJob: objective.hasAuthoritativeLiveJob,
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
    _filter: FactoryWorkbenchFilterKey,
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
    readonly blockedPage: ReturnType<typeof paginateObjectiveCards>;
    readonly runningPage: ReturnType<typeof paginateObjectiveCards>;
    readonly queuedPage: ReturnType<typeof paginateObjectiveCards>;
    readonly pastPage: ReturnType<typeof paginateObjectiveCards>;
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
      ?? selectedObjective?.renderedBody
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
      systemImprovement: input.board.systemImprovement,
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
            loading: focus.loading,
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
        count: input.blockedPage.count,
        emptyMessage: input.filter === "objective.needs_attention"
          ? "No blocked objectives match the current filter."
          : "Blocked objectives will appear here when work needs intervention.",
        items: input.blockedPage.items,
        page: input.blockedPage.page,
        pageSize: WORKBENCH_OBJECTIVE_PAGE_SIZE,
        pageCount: input.blockedPage.pageCount,
        hasPreviousPage: input.blockedPage.hasPreviousPage,
        hasNextPage: input.blockedPage.hasNextPage,
      }] : []),
      ...(showRunning ? [{
        key: "running",
        title: "In Progress",
        shape: "objective-list" as const,
        count: input.runningPage.count,
        emptyMessage: input.filter === "objective.running"
          ? "No in-progress objectives match the current filter."
          : "Objectives with active execution will appear here.",
        items: input.runningPage.items,
        page: input.runningPage.page,
        pageSize: WORKBENCH_OBJECTIVE_PAGE_SIZE,
        pageCount: input.runningPage.pageCount,
        hasPreviousPage: input.runningPage.hasPreviousPage,
        hasNextPage: input.runningPage.hasNextPage,
      }] : []),
      ...(showQueued ? [{
        key: "queued",
        title: "Queued",
        shape: "objective-list" as const,
        count: input.queuedPage.count,
        emptyMessage: input.filter === "objective.queued"
          ? "No queued objectives match the current filter."
          : "Queued objectives waiting for execution will appear here.",
        items: input.queuedPage.items,
        page: input.queuedPage.page,
        pageSize: WORKBENCH_OBJECTIVE_PAGE_SIZE,
        pageCount: input.queuedPage.pageCount,
        hasPreviousPage: input.queuedPage.hasPreviousPage,
        hasNextPage: input.queuedPage.hasNextPage,
      }] : []),
    ];
    const selectedObjectiveSection = selectedObjective && ![
      ...input.blockedPage.items,
      ...input.runningPage.items,
      ...input.queuedPage.items,
      ...input.pastPage.items,
    ].some((objective) => objective.objectiveId === selectedObjective.objectiveId)
      ? {
          key: "selected",
          title: "Current selection",
          shape: "objective-list" as const,
          count: 1,
          emptyMessage: "The selected objective will stay visible here when the current filter hides it.",
          items: [selectedObjectiveNavCard(selectedObjective)],
          page: 1,
          pageSize: 1,
          pageCount: 1,
          hasPreviousPage: false,
          hasNextPage: false,
        }
      : undefined;
    const objectiveBlockSections = selectedObjectiveSection
      ? [selectedObjectiveSection, ...objectiveSections]
      : objectiveSections;
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
            loading: focus.loading,
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
            count: input.pastPage.count,
            emptyMessage: input.filter === "objective.completed"
              ? "No completed objectives match the current filter."
              : "Completed objectives and recent history will appear here.",
            items: input.pastPage.items,
            page: input.pastPage.page,
            pageSize: WORKBENCH_OBJECTIVE_PAGE_SIZE,
            pageCount: input.pastPage.pageCount,
            hasPreviousPage: input.pastPage.hasPreviousPage,
            hasNextPage: input.pastPage.hasNextPage,
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
    readonly page: number;
  }): Promise<FactoryWorkbenchWorkspaceModel> => {
    await service.ensureBootstrap();
    const repoRoot = service.git.repoRoot;
    const requestedObjectiveId = input.objectiveId?.trim();
    const [resolved, detail] = await Promise.all([
      resolveFactoryChatProfileCached({
        repoRoot,
        profileRoot,
        requestedId: input.profileId,
      }),
      requestedObjectiveId
        ? service.getObjective(requestedObjectiveId).catch((err) => {
            if (err instanceof FactoryServiceError && err.status === 404) return undefined;
            throw err;
          })
        : Promise.resolve(undefined),
    ]);
    const effectiveProfileId = detail?.profile.rootProfileId ?? resolved.root.id;
    const effectiveProfile = effectiveProfileId === resolved.root.id
      ? {
          id: resolved.root.id,
          label: resolved.root.label,
        }
      : {
          id: effectiveProfileId,
          label: detail?.profile.rootProfileLabel ?? resolved.root.label,
        };
    const board = await service.buildBoardProjection({
      selectedObjectiveId: requestedObjectiveId,
      profileId: effectiveProfileId,
    });
    const sessionObjectiveId = await resolveSessionObjectiveId({
      repoRoot,
      profileId: effectiveProfile.id,
      chatId: input.chatId,
      objectiveId: requestedObjectiveId,
      jobs: [],
      liveObjectives: board.objectives,
    });
    const resolvedObjectiveId = detail?.objectiveId
      ?? sessionObjectiveId
      ?? preferredWorkbenchSelectedObjectiveId(board, input.filter, requestedObjectiveId)
      ?? requestedObjectiveId;
    const selectedBoardObjective = resolvedObjectiveId
      ? board.objectives.find((objective) => objective.objectiveId === resolvedObjectiveId)
      : undefined;
    const selectedObjectiveBase = detail
      ? toFactorySelectedObjectiveCard(detail)
      : selectedBoardObjective
        ? toFactorySelectedObjectiveCard(selectedBoardObjective)
        : undefined;
    const selectedObjective = selectedObjectiveBase
      ? {
          ...selectedObjectiveBase,
          systemImprovement: board.systemImprovement,
        }
      : undefined;
    const objectiveChatBindings = await readObjectiveChatBindings([
      ...board.objectives.map((objective) => objective.objectiveId),
      ...(resolvedObjectiveId ? [resolvedObjectiveId] : []),
    ], effectiveProfile.id);
    const objectiveChatIdsByObjectiveId = new Map<string, string>(
      [...objectiveChatBindings.entries()].map(([objectiveId, binding]) => [objectiveId, binding.chatId]),
    );
    const effectiveChatId = resolvedObjectiveId
      ? objectiveChatBindings.get(resolvedObjectiveId)?.chatId ?? input.chatId
      : input.chatId;
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
    const sessionStream = effectiveChatId
      ? factoryChatSessionStream(repoRoot, effectiveProfile.id, effectiveChatId)
      : undefined;
    const sessionChain = sessionStream
      ? await agentRuntime.chain(sessionStream)
      : undefined;
    const sessionChatContext = sessionStream
      ? await loadChatContextProjectionForSession({
          sessionStream,
          fallbackChain: chatProjectionDataDir ? undefined : sessionChain,
        })
      : undefined;
    const sessionContinuationPredecessors = sessionStream
      ? sessionContinuationPredecessorObjectiveIds(
          sessionChain ?? [],
          resolvedObjectiveId,
        )
      : new Set<string>();
    const workbenchBoard = sessionContinuationPredecessors.size > 0
      ? {
          ...board,
          objectives: filterSessionContinuationPredecessors(
            board.objectives,
            sessionContinuationPredecessors,
            resolvedObjectiveId,
          ),
          sections: {
            needs_attention: filterSessionContinuationPredecessors(
              board.sections.needs_attention,
              sessionContinuationPredecessors,
              resolvedObjectiveId,
            ),
            active: filterSessionContinuationPredecessors(
              board.sections.active,
              sessionContinuationPredecessors,
              resolvedObjectiveId,
            ),
            queued: filterSessionContinuationPredecessors(
              board.sections.queued,
              sessionContinuationPredecessors,
              resolvedObjectiveId,
            ),
            completed: filterSessionContinuationPredecessors(
              board.sections.completed,
              sessionContinuationPredecessors,
              resolvedObjectiveId,
            ),
            archived: filterSessionContinuationPredecessors(
              board.sections.archived,
              sessionContinuationPredecessors,
              resolvedObjectiveId,
            ),
          },
        }
      : board;
    const activeRun = (() => {
      const projectedRuns = resolvedObjectiveId
        ? (sessionChatContext?.runs ?? []).filter((run) => run.objectiveId === resolvedObjectiveId)
        : (sessionChatContext?.runs ?? []);
      const latestRun = projectedRuns.at(-1);
      if (!latestRun) return undefined;
      const latestAssistantMessage = [...(sessionChatContext?.conversation ?? [])]
        .reverse()
        .find((message) => message.runId === latestRun.runId && message.role === "assistant");
      const summary = latestAssistantMessage?.text?.trim()
        || (workbench?.focus?.summary?.trim() || undefined)
        || `${effectiveProfile.label} is working on the selected objective.`;
      return {
        runId: latestRun.runId,
        profileLabel: effectiveProfile.label,
        status: latestRun.status ?? (latestRun.terminal ? "completed" : "running"),
        summary,
        updatedAt: latestRun.updatedAt,
        link: buildChatLink({
          profileId: effectiveProfile.id,
          chatId: effectiveChatId,
          objectiveId: resolvedObjectiveId,
          runId: latestRun.runId,
          focusKind: workbench?.focus?.focusKind,
          focusId: workbench?.focus?.focusId,
        }),
      } satisfies FactoryLiveRunCard;
    })();
    const activeCodex = recentJobs.length > 0 ? buildActiveCodexCard(recentJobs) : undefined;
    const liveChildren = sessionStream
      ? buildLiveChildCards(recentJobs, sessionStream, resolvedObjectiveId)
      : [];
    const filters = workbenchFilterModels(workbenchBoard, input.filter);
    const blockedObjectives = dedupeObjectiveCards(
      workbenchFilterMatchesSection(input.filter, "needs_attention")
        ? buildObjectiveNavCards(workbenchBoard.sections.needs_attention, resolvedObjectiveId, {
            chatIdsByObjectiveId: objectiveChatIdsByObjectiveId,
          })
        : [],
    );
    const blockedPage = paginateObjectiveCards(blockedObjectives, input.page);
    const runningObjectives = dedupeObjectiveCards(
      workbenchFilterMatchesSection(input.filter, "active")
        ? buildObjectiveNavCards(workbenchBoard.sections.active, resolvedObjectiveId, {
            chatIdsByObjectiveId: objectiveChatIdsByObjectiveId,
          })
        : [],
    );
    const runningPage = paginateObjectiveCards(runningObjectives, input.page);
    const queuedObjectives = dedupeObjectiveCards(
      workbenchFilterMatchesSection(input.filter, "queued")
        ? buildObjectiveNavCards(workbenchBoard.sections.queued, resolvedObjectiveId, {
            chatIdsByObjectiveId: objectiveChatIdsByObjectiveId,
          })
        : [],
    );
    const queuedPage = paginateObjectiveCards(queuedObjectives, input.page);
    const activeObjectives = dedupeObjectiveCards([
      ...blockedObjectives,
      ...runningObjectives,
      ...queuedObjectives,
    ]).slice(0, 10);
    const pastObjectives = dedupeObjectiveCards(
      workbenchFilterMatchesSection(input.filter, "completed")
        ? buildObjectiveNavCards(workbenchBoard.sections.completed, resolvedObjectiveId, {
            chatIdsByObjectiveId: objectiveChatIdsByObjectiveId,
          })
        : [],
    );
    const pastPage = paginateObjectiveCards(pastObjectives, input.page);
    const hasActiveExecution = Boolean(
      activeRun
      ||
      workbench?.focus?.active
      || workbench?.focus?.status === "running"
      || workbench?.focus?.status === "queued"
      || activeCodex?.running
      || liveChildren.some((child) => child.running),
    );
    const detailTab = input.detailTab === "review" || input.detailTab === "queue" || input.detailTab === "action"
      ? input.detailTab
      : hasActiveExecution
        ? "review"
        : normalizedWorkbenchDetailTab(input.detailTab, Boolean(selectedObjective));
    return {
      activeProfileId: effectiveProfile.id,
      activeProfileLabel: effectiveProfile.label,
      chatId: effectiveChatId ?? "",
      objectiveId: resolvedObjectiveId,
      inspectorTab: normalizedWorkbenchInspectorTab(input.inspectorTab),
      detailTab,
      page: input.page,
      focusKind: workbench?.focus?.focusKind,
      focusId: workbench?.focus?.focusId,
      filter: input.filter,
      filters,
      selectedObjective,
      activeCodex,
      liveChildren,
      activeRun,
      workbench,
      board: workbenchBoard,
      activeObjectives,
      pastObjectives: pastPage.items,
      blocks: buildWorkbenchBlocks({
        board: workbenchBoard,
        selectedObjective,
        blockedPage,
        runningPage,
        queuedPage,
        pastPage,
        activeRun,
        workbench,
        detailTab,
        filter: input.filter,
      }),
    };
  };

  const buildWorkbenchSessionRuntimeCached = async (input: {
    readonly repoRoot: string;
    readonly profileId: string;
    readonly profileLabel: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly seedJobs?: ReadonlyArray<QueueJob>;
    readonly versions?: WorkbenchResolvedVersions;
  }): Promise<Awaited<ReturnType<typeof buildWorkbenchSessionRuntime>>> => {
    const sessionVersion = input.versions?.sessionVersion
      ?? await resolveSessionStreamVersionCached({
        profileId: input.profileId,
        chatId: input.chatId,
      });
    return withProjectionCache(
      workbenchSessionRuntimeCache,
      JSON.stringify({
        input,
        queueVersion: ctx.queue.snapshot?.().version ?? 0,
        sessionVersion,
      }),
      () => buildWorkbenchSessionRuntime(input),
      WORKBENCH_MODEL_CACHE_TTL_MS,
    );
  };

  const buildWorkbenchWorkspaceModelCached = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly detailTab?: FactoryWorkbenchDetailTab;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly filter: FactoryWorkbenchFilterKey;
    readonly page: number;
    readonly versions?: WorkbenchResolvedVersions;
  }): Promise<FactoryWorkbenchWorkspaceModel> => {
    const sessionVersion = input.versions?.sessionVersion
      ?? await resolveSessionStreamVersionCached({
        profileId: input.profileId,
        chatId: input.chatId,
      });
    const objectiveVersion = input.versions?.objectiveVersion
      ?? await resolveObjectiveProjectionVersionCached();
    return withProjectionCache(
      workbenchWorkspaceCache,
      JSON.stringify({
        input,
        queueVersion: ctx.queue.snapshot?.().version ?? 0,
        objectiveVersion,
        sessionVersion,
      }),
      () => buildWorkbenchWorkspaceModel(input),
      WORKBENCH_MODEL_CACHE_TTL_MS,
    );
  };

  const buildWorkbenchChatModel = async (input: {
    readonly profileId: string;
    readonly chatId: string;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly selectedObjectiveId?: string;
  }): Promise<FactoryChatIslandModel> => {
    await service.ensureBootstrap();
    const repoRoot = service.git.repoRoot;
    const resolved = await resolveFactoryChatProfileCached({
      repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const activeProfileOverview = describeProfileMarkdown(resolved.root);
    const selectedObjectiveId = input.selectedObjectiveId?.trim();
    if (selectedObjectiveId) {
      try {
        const selectedObjective = toFactorySelectedObjectiveCard(await service.getObjective(selectedObjectiveId));
        await ensureObjectiveHandoffInSession({
          profileId: resolved.root.id,
          chatId: input.chatId,
          objective: selectedObjective,
        });
      } catch (err: unknown) {
        const status = typeof err === "object" && err !== null && "status" in err
          ? (err as { readonly status?: unknown }).status
          : undefined;
        const message = err instanceof Error ? err.message : undefined;
        if (status !== 404 && !message?.includes("not found")) throw err;
      }
    }
    const sessionStream = factoryChatSessionStream(repoRoot, resolved.root.id, input.chatId);
    const fallbackSessionChain = chatProjectionDataDir
      ? undefined
      : await agentRuntime.chain(sessionStream);
    const chatContext = await loadChatContextProjectionForSession({
      sessionStream,
      fallbackChain: fallbackSessionChain,
    });
    const projectedRuns = chatContext?.runs ?? [];
    const canScopeProjectedConversation = !selectedObjectiveId
      || projectedRuns.some((run) => run.objectiveId === selectedObjectiveId);
    if (!chatContext || !canScopeProjectedConversation) {
      const runtime = await buildWorkbenchSessionRuntimeCached({
        repoRoot,
        profileId: resolved.root.id,
        profileLabel: resolved.root.label,
        chatId: input.chatId,
        objectiveId: selectedObjectiveId,
      });
      const jobsById = new Map(runtime.scopedJobs.map((job) => [job.id, job] as const));
      return {
        activeProfileId: resolved.root.id,
        activeProfileLabel: resolved.root.label,
        chatId: input.chatId,
        objectiveId: selectedObjectiveId,
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
        chatContext,
        items: runtime.runChains.flatMap((runChain, index) => buildChatItemsForRun(runtime.runIds[index]!, runChain, jobsById)),
      };
    }
    const scopedRuns = selectedObjectiveId
      ? projectedRuns.filter((run) => run.objectiveId === selectedObjectiveId)
      : projectedRuns;
    const discoveredObjectiveId = selectedObjectiveId
      ?? chatContext.bindings.objectiveId;
    return {
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      chatId: input.chatId,
      objectiveId: discoveredObjectiveId,
      runId: scopedRuns.at(-1)?.runId ?? chatContext.bindings.latestRunId,
      knownRunIds: scopedRuns.map((run) => run.runId),
      terminalRunIds: scopedRuns.filter((run) => run.terminal).map((run) => run.runId),
      inspectorTab: normalizedWorkbenchInspectorTab(input.inspectorTab),
      activeProfilePrimaryRole: activeProfileOverview.primaryRole,
      activeProfileRoles: activeProfileOverview.roles,
      activeProfileResponsibilities: activeProfileOverview.responsibilities,
      activeProfileSummary: activeProfileOverview.summary,
      activeProfileSoulSummary: activeProfileOverview.soulSummary,
      activeProfileProfileSummary: activeProfileOverview.profileSummary,
      activeProfileSections: activeProfileOverview.sections,
      activeProfileTools: resolved.toolAllowlist,
      activeCodex: undefined,
      liveChildren: [],
      activeRun: undefined,
      jobs: [],
      chatContext,
      items: buildChatItemsFromConversation(chatContext.conversation, {
        runs: projectedRuns,
        selectedObjectiveId,
      }),
    };
  };

  const buildWorkbenchChatModelCached = async (input: {
    readonly profileId: string;
    readonly chatId: string;
    readonly inspectorTab?: FactoryInspectorTab;
    readonly selectedObjectiveId?: string;
    readonly versions?: WorkbenchResolvedVersions;
  }): Promise<FactoryChatIslandModel> => {
    const sessionVersion = input.versions?.sessionVersion
      ?? await resolveSessionStreamVersionCached({
        profileId: input.profileId,
        chatId: input.chatId,
      });
    const objectiveVersion = input.versions?.objectiveVersion
      ?? await resolveObjectiveProjectionVersionCached();
    return withProjectionCache(
      workbenchChatCache,
      JSON.stringify({
        input,
        queueVersion: ctx.queue.snapshot?.().version ?? 0,
        objectiveVersion,
        sessionVersion,
      }),
      () => buildWorkbenchChatModel(input),
      WORKBENCH_MODEL_CACHE_TTL_MS,
    );
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
    readonly page: number;
    readonly shellBase?: string;
    readonly versions?: WorkbenchResolvedVersions;
  }): Promise<FactoryWorkbenchPageModel> => {
    const workspace = await buildWorkbenchWorkspaceModelCached({
      profileId: input.profileId,
      chatId: input.chatId,
      objectiveId: input.objectiveId,
      inspectorTab: input.inspectorTab,
      detailTab: input.detailTab,
      focusKind: input.focusKind,
      focusId: input.focusId,
      filter: input.filter,
      page: input.page,
      versions: input.versions,
    });
    await ensureObjectiveHandoffInSession({
      profileId: workspace.activeProfileId,
      chatId: workspace.chatId,
      objective: workspace.selectedObjective,
    });
    const [baseChat, profiles] = await Promise.all([
      buildWorkbenchChatModelCached({
        profileId: workspace.activeProfileId,
        chatId: workspace.chatId,
        inspectorTab: input.inspectorTab,
        selectedObjectiveId: workspace.objectiveId,
        versions: input.versions,
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
      chatId: workspace.chatId,
      objectiveId: workspace.objectiveId,
      inspectorTab: normalizedWorkbenchInspectorTab(input.inspectorTab),
      detailTab: workspace.detailTab,
      page: workspace.page,
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
          page: workspace.page,
          focusKind: workspace.selectedObjective?.profileId === profile.id ? workspace.focusKind : undefined,
          focusId: workspace.selectedObjective?.profileId === profile.id ? workspace.focusId : undefined,
          filter: workspace.filter,
          basePath: input.shellBase,
        }),
        summary: describeProfileMarkdown(profile).summary,
        selected: profile.id === workspace.activeProfileId,
      })),
      workspace,
      chat,
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
    readonly page: number;
    readonly shellBase?: string;
    readonly versions?: WorkbenchResolvedVersions;
  }): Promise<FactoryWorkbenchPageModel> => {
    const sessionVersion = input.versions?.sessionVersion
      ?? await resolveSessionStreamVersionCached({
        profileId: input.profileId,
        chatId: input.chatId,
      });
    const objectiveVersion = input.versions?.objectiveVersion
      ?? await resolveObjectiveProjectionVersionCached();
    return withProjectionCache(
      workbenchPageCache,
      JSON.stringify({
        input,
        queueVersion: ctx.queue.snapshot?.().version ?? 0,
        objectiveVersion,
        sessionVersion,
      }),
      () => buildWorkbenchPageModel(input),
      WORKBENCH_MODEL_CACHE_TTL_MS,
    );
  };

  const loadWorkbenchRequestContext = async (
    req: Request,
    timing?: WorkbenchServerTiming,
    options: {
      readonly includeSessionVersion?: boolean;
    } = {},
  ): Promise<WorkbenchRequestContext> => {
    const request = timing
      ? await timing.measure("request_normalization", () => Promise.resolve(readWorkbenchRequest(req)))
      : readWorkbenchRequest(req);
    const includeSessionVersion = options.includeSessionVersion ?? true;
    const [sessionVersion, objectiveVersion, queueVersion] = await Promise.all([
      includeSessionVersion
        ? (timing
            ? timing.measure("session_version", () => resolveSessionStreamVersionCached({
                profileId: request.profileId,
                chatId: request.chatId,
              }))
            : resolveSessionStreamVersionCached({
                profileId: request.profileId,
                chatId: request.chatId,
              }))
        : Promise.resolve(undefined),
      timing
        ? timing.measure("objective_version", () => resolveObjectiveProjectionVersionCached())
        : resolveObjectiveProjectionVersionCached(),
      Promise.resolve(ctx.queue.snapshot?.().version ?? 0),
    ]);
    return {
      request,
      versions: {
        sessionVersion,
        objectiveVersion,
        queueVersion,
      },
    };
  };

  const loadWorkbenchRequestPreviewStaticEnvelope = async (
    req: Request,
    timing?: WorkbenchServerTiming,
  ): Promise<{
    readonly request: FactoryWorkbenchRequestState;
    readonly envelope: WorkbenchVersionEnvelope;
  }> => {
    const context = await loadWorkbenchRequestContext(req, timing, {
      includeSessionVersion: false,
    });
    return {
      request: context.request,
      envelope: buildWorkbenchVersionEnvelope(context.request, context.versions),
    };
  };

  const loadWorkbenchRequestPreviewChatEnvelope = async (
    req: Request,
    timing?: WorkbenchServerTiming,
  ): Promise<{
    readonly request: FactoryWorkbenchRequestState;
    readonly envelope: WorkbenchVersionEnvelope;
  }> => {
    const context = await loadWorkbenchRequestContext(req, timing, {
      includeSessionVersion: true,
    });
    return {
      request: context.request,
      envelope: buildWorkbenchVersionEnvelope(context.request, context.versions),
    };
  };

  const loadWorkbenchRequestModel = async (
    req: Request,
    timing?: WorkbenchServerTiming,
  ): Promise<{
    readonly request: FactoryWorkbenchRequestState;
    readonly model: FactoryWorkbenchPageModel;
    readonly envelope: WorkbenchVersionEnvelope;
  }> => {
    const context = await loadWorkbenchRequestContext(req, timing);
    const model = timing
      ? await timing.measure("page_model", () => buildWorkbenchPageModelCached({
          ...context.request,
          versions: context.versions,
        }))
      : await buildWorkbenchPageModelCached({
          ...context.request,
          versions: context.versions,
        });
    return {
      request: context.request,
      model,
      envelope: buildWorkbenchVersionEnvelope(context.request, context.versions),
    };
  };

  const loadWorkbenchRequestWorkspaceModel = async (
    req: Request,
    timing?: WorkbenchServerTiming,
  ): Promise<{
    readonly request: FactoryWorkbenchRequestState;
    readonly model: FactoryWorkbenchWorkspaceModel;
  }> => {
    const context = await loadWorkbenchRequestContext(req, timing);
    const model = timing
      ? await timing.measure("workspace_model", () => buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        }))
      : await buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        });
    return { request: context.request, model };
  };

  const loadWorkbenchRequestHeaderModel = async (
    req: Request,
    timing?: WorkbenchServerTiming,
  ): Promise<{
    readonly request: FactoryWorkbenchRequestState;
    readonly model: FactoryWorkbenchHeaderIslandModel;
  }> => {
    const context = await loadWorkbenchRequestContext(req, timing);
    const workspace = timing
      ? await timing.measure("workspace_model", () => buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        }))
      : await buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        });
    const profiles = timing
      ? await timing.measure("profiles", () => loadFactoryProfiles())
      : await loadFactoryProfiles();
    return {
      request: context.request,
      model: buildWorkbenchHeaderModel({
        request: context.request,
        workspace,
        profiles,
      }),
    };
  };

  const loadWorkbenchRequestBoardModel = async (
    req: Request,
    timing?: WorkbenchServerTiming,
  ): Promise<WorkbenchRequestBoardModel> => {
    const context = await loadWorkbenchRequestContext(req, timing);
    const workspace = timing
      ? await timing.measure("workspace_model", () => buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        }))
      : await buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        });
    const profiles = timing
      ? await timing.measure("profiles", () => loadFactoryProfiles())
      : await loadFactoryProfiles();
    return {
      request: context.request,
      envelope: buildWorkbenchVersionEnvelope(context.request, context.versions),
      header: buildWorkbenchHeaderModel({
        request: context.request,
        workspace,
        profiles,
      }),
      workspace,
    };
  };

  const loadWorkbenchRequestFocusModel = async (
    req: Request,
    timing?: WorkbenchServerTiming,
  ): Promise<WorkbenchRequestFocusModel> => {
    const context = await loadWorkbenchRequestContext(req, timing);
    const workspace = timing
      ? await timing.measure("workspace_model", () => buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        }))
      : await buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        });
    return {
      request: context.request,
      envelope: buildWorkbenchVersionEnvelope(context.request, context.versions),
      workspace,
    };
  };

  const loadWorkbenchRequestChatModel = async (
    req: Request,
    timing?: WorkbenchServerTiming,
  ): Promise<{
    readonly request: FactoryWorkbenchRequestState;
    readonly model: FactoryChatIslandModel;
  }> => {
    const context = await loadWorkbenchRequestContext(req, timing);
    if (context.request.inspectorTab === "chat" && !context.request.objectiveId) {
      const model = timing
        ? await timing.measure("chat_model", () => buildWorkbenchChatModelCached({
            profileId: context.request.profileId,
            chatId: context.request.chatId,
            inspectorTab: context.request.inspectorTab,
            selectedObjectiveId: context.request.objectiveId,
            versions: context.versions,
          }))
        : await buildWorkbenchChatModelCached({
            profileId: context.request.profileId,
            chatId: context.request.chatId,
            inspectorTab: context.request.inspectorTab,
            selectedObjectiveId: context.request.objectiveId,
            versions: context.versions,
          });
      return { request: context.request, model };
    }
    const workspace = timing
      ? await timing.measure("workspace_model", () => buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        }))
      : await buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        });
    await ensureObjectiveHandoffInSession({
      profileId: workspace.activeProfileId,
      chatId: workspace.chatId,
      objective: workspace.selectedObjective,
    });
    const model = timing
      ? await timing.measure("chat_model", () => buildWorkbenchChatModelCached({
          profileId: workspace.activeProfileId,
          chatId: workspace.chatId,
          inspectorTab: context.request.inspectorTab,
          selectedObjectiveId: workspace.objectiveId,
          versions: context.versions,
        }))
      : await buildWorkbenchChatModelCached({
          profileId: workspace.activeProfileId,
          chatId: workspace.chatId,
          inspectorTab: context.request.inspectorTab,
          selectedObjectiveId: workspace.objectiveId,
          versions: context.versions,
        });
    return { request: context.request, model };
  };

  const loadWorkbenchRequestChatShellModel = async (
    req: Request,
    timing?: WorkbenchServerTiming,
  ): Promise<{
    readonly request: FactoryWorkbenchRequestState;
    readonly workspace: FactoryWorkbenchWorkspaceModel;
    readonly chat: FactoryChatIslandModel;
  }> => {
    const context = await loadWorkbenchRequestContext(req, timing);
    const workspace = timing
      ? await timing.measure("workspace_model", () => buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        }))
      : await buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        });
    await ensureObjectiveHandoffInSession({
      profileId: workspace.activeProfileId,
      chatId: workspace.chatId,
      objective: workspace.selectedObjective,
    });
    const chat = timing
      ? await timing.measure("chat_model", () => buildWorkbenchChatModelCached({
          profileId: workspace.activeProfileId,
          chatId: workspace.chatId,
          inspectorTab: context.request.inspectorTab,
          selectedObjectiveId: workspace.objectiveId,
          versions: context.versions,
        }))
      : await buildWorkbenchChatModelCached({
          profileId: workspace.activeProfileId,
          chatId: workspace.chatId,
          inspectorTab: context.request.inspectorTab,
          selectedObjectiveId: workspace.objectiveId,
          versions: context.versions,
    });
    return { request: context.request, workspace, chat };
  };

  const loadWorkbenchRequestChatBodyModel = async (
    req: Request,
    timing?: WorkbenchServerTiming,
  ): Promise<WorkbenchRequestChatBodyModel> => {
    const context = await loadWorkbenchRequestContext(req, timing);
    const workspace = timing
      ? await timing.measure("workspace_model", () => buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        }))
      : await buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        });
    await ensureObjectiveHandoffInSession({
      profileId: workspace.activeProfileId,
      chatId: workspace.chatId,
      objective: workspace.selectedObjective,
    });
    const chat = timing
      ? await timing.measure("chat_model", () => buildWorkbenchChatModelCached({
          profileId: workspace.activeProfileId,
          chatId: workspace.chatId,
          inspectorTab: context.request.inspectorTab,
          selectedObjectiveId: workspace.objectiveId,
          versions: context.versions,
        }))
      : await buildWorkbenchChatModelCached({
          profileId: workspace.activeProfileId,
          chatId: workspace.chatId,
          inspectorTab: context.request.inspectorTab,
          selectedObjectiveId: workspace.objectiveId,
          versions: context.versions,
        });
    return {
      request: context.request,
      envelope: buildWorkbenchVersionEnvelope(context.request, context.versions),
      workspace,
      chat,
    };
  };

  const loadWorkbenchRequestSelectionModel = async (
    req: Request,
    timing?: WorkbenchServerTiming,
  ): Promise<{
    readonly request: FactoryWorkbenchRequestState;
    readonly envelope: WorkbenchVersionEnvelope;
    readonly header: FactoryWorkbenchHeaderIslandModel;
    readonly workspace: FactoryWorkbenchWorkspaceModel;
    readonly chat: FactoryChatIslandModel;
    readonly detail?: FactoryObjectiveDetail;
  }> => {
    const context = await loadWorkbenchRequestContext(req, timing);
    const workspace = timing
      ? await timing.measure("workspace_model", () => buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        }))
      : await buildWorkbenchWorkspaceModelCached({
          ...context.request,
          versions: context.versions,
        });
    const [chat, profiles] = await Promise.all([
      timing
        ? timing.measure("chat_model", () => buildWorkbenchChatModelCached({
            profileId: workspace.activeProfileId,
            chatId: workspace.chatId,
            inspectorTab: context.request.inspectorTab,
            selectedObjectiveId: workspace.objectiveId,
            versions: context.versions,
          }))
        : buildWorkbenchChatModelCached({
            profileId: workspace.activeProfileId,
            chatId: workspace.chatId,
            inspectorTab: context.request.inspectorTab,
            selectedObjectiveId: workspace.objectiveId,
            versions: context.versions,
          }),
      timing
        ? timing.measure("profiles", () => loadFactoryProfiles())
        : loadFactoryProfiles(),
    ]);
    const detail = workspace.objectiveId
      ? timing
        ? await timing.measure("selected_objective_detail", () => service.getObjective(workspace.objectiveId).catch((err) => {
            if (err instanceof FactoryServiceError && err.status === 404) return undefined;
            throw err;
          }))
        : await service.getObjective(workspace.objectiveId).catch((err) => {
            if (err instanceof FactoryServiceError && err.status === 404) return undefined;
            throw err;
          })
      : undefined;
    return {
      request: context.request,
      envelope: buildWorkbenchVersionEnvelope(context.request, context.versions),
      workspace,
      chat,
      detail,
      header: buildWorkbenchHeaderModel({
        request: context.request,
        workspace,
        profiles,
      }),
    };
  };

  return {
    id: "factory",
    kind: "factory",
    paths: {
      shell: "/factory",
      state: "/factory/api/objectives",
      events: "/factory/live",
    },
    register: (app: Hono) => {
      registerFactoryUiRoutes({
        app,
        wrap,
        loadWorkbenchRequestModel,
        loadWorkbenchRequestWorkspaceModel,
        loadWorkbenchRequestBoardModel,
        loadWorkbenchRequestFocusModel,
        loadWorkbenchRequestChatModel,
        loadWorkbenchRequestChatShellModel,
        loadWorkbenchRequestChatBodyModel,
        loadWorkbenchRequestSelectionModel,
      });
      registerFactoryLinearUiRoutes({
        app,
        wrap,
        loadWorkbenchRequestModel,
        loadWorkbenchRequestHeaderModel,
        loadWorkbenchRequestWorkspaceModel,
        loadWorkbenchRequestChatModel,
        loadWorkbenchRequestChatShellModel,
        loadWorkbenchRequestSelectionModel,
      });
      registerFactoryPreviewRoutes({
        app,
        wrap,
        ctx,
        loadWorkbenchRequestBoardModel,
        loadWorkbenchRequestFocusModel,
        loadWorkbenchRequestChatBodyModel,
        loadWorkbenchRequestSelectionModel,
        loadWorkbenchRequestPreviewStaticEnvelope,
        loadWorkbenchRequestPreviewChatEnvelope,
        resolveChatEventSubscriptions,
      });
      registerFactoryApiRoutes({
        app,
        basePath: "/factory",
        wrap,
        ctx,
        service,
        profileRoot,
        loadFactoryProfiles,
        resolveObjectiveChatBinding,
        resolveWatchedObjectiveId,
        resolveComposerJob,
        assertComposeDispatchActionAllowed,
        assertComposeCreateModeAllowed,
        resolveChatEventSubscriptions,
        agentRuntime,
        memoryTools,
        dataDir: chatProjectionDataDir,
      });
      registerFactoryApiRoutes({
        app,
        basePath: "/factory-new",
        wrap,
        ctx,
        service,
        profileRoot,
        loadFactoryProfiles,
        resolveObjectiveChatBinding,
        resolveWatchedObjectiveId,
        resolveComposerJob,
        assertComposeDispatchActionAllowed,
        assertComposeCreateModeAllowed,
        resolveChatEventSubscriptions,
        agentRuntime,
        memoryTools,
        dataDir: chatProjectionDataDir,
      });
      registerFactoryApiRoutes({
        app,
        basePath: "/factory-preview",
        wrap,
        ctx,
        service,
        profileRoot,
        loadFactoryProfiles,
        resolveObjectiveChatBinding,
        resolveWatchedObjectiveId,
        resolveComposerJob,
        assertComposeDispatchActionAllowed,
        assertComposeCreateModeAllowed,
        resolveChatEventSubscriptions,
        agentRuntime,
        memoryTools,
        dataDir: chatProjectionDataDir,
      });
      registerReceiptRoutes({ app, ctx });
      registerRuntimeRoutes({
        app,
        wrap,
        loadRuntimeDashboard,
      });
    },
  };
};

export default createFactoryRoute;
