import path from "node:path";

import type { Hono } from "hono";

import { LocalCodexExecutor } from "../../adapters/codex-executor";
import type { MemoryTools } from "../../adapters/memory-tools";
import type { Runtime } from "@receipt/core/runtime";
import {
  html,
  json,
  optionalTrimmedString,
  readRecordBody,
  text,
} from "../../framework/http";
import type { AgentLoaderContext, AgentRouteModule } from "../../framework/agent-types";
import { agentRunStream } from "../agent.streams";
import type { AgentCmd, AgentEvent, AgentState } from "../../modules/agent";
import type { JobRecord } from "../../modules/job";
import {
  factoryChatStream,
  factoryChatSessionStream,
  type FactoryChatProfile,
  discoverFactoryChatProfiles,
  resolveFactoryChatProfile,
} from "../../services/factory-chat-profiles";
import {
  FactoryService,
  FactoryServiceError,
  type FactoryLiveOutputTargetKind,
} from "../../services/factory-service";
import {
  factoryChatIsland,
  factoryChatShell,
  factorySidebarIsland,
} from "../../views/factory-chat";
import {
  factoryInspectorIsland,
  factoryInspectorPanelIsland,
  factoryInspectorSelectionIsland,
  factoryInspectorTabsIsland,
} from "../../views/factory-inspector";
import {
  toFactorySelectedObjectiveCard,
  toFactoryStateSelectedObjectiveCard,
} from "../../views/factory/objective-presenters";
import { buildFactoryWorkbench } from "../../views/factory-workbench";
import type {
  FactoryChatIslandModel,
  FactoryChatItem,
  FactoryChatObjectiveNav,
  FactoryChatProfileNav,
  FactoryChatShellModel,
  FactoryChatJobNav,
  FactoryInspectorPanel,
  FactorySelectedObjectiveCard,
  FactoryNavModel,
  FactoryInspectorModel,
  FactoryInspectorTabsModel,
} from "../../views/factory-models";
import type { QueueJob } from "../../adapters/jsonl-queue";
import { readObjectiveAnalysis } from "../../factory-cli/analyze";
import {
  inferObjectiveProfileHint,
  parseComposerDraft,
} from "../../factory-cli/composer";
import {
  listReceiptFiles,
  readReceiptFile,
  sliceReceiptRecords,
  buildReceiptTimeline,
} from "../../adapters/receipt-tools";
import {
  receiptShell,
  receiptFoldsHtml,
  receiptRecordsHtml,
  receiptSideHtml,
} from "../../views/receipt";
import { parseOrder, parseLimit, parseInspectorDepth } from "../../framework/http";
import type { FactoryLiveScopePayload } from "./client-contract";
import { buildChatItemsForRun } from "./chat-items";
import {
  buildChatLink,
  latestObjectiveIdFromJobs,
  latestObjectiveIdFromRunChains,
  normalizeKnownObjectiveId,
  resolveChatViewStream,
} from "./links";
import {
  buildActiveCodexCard,
  buildLiveChildCards,
  collectRunIds,
  collectRunLineageIds,
  jobMatchesRunIds,
  summarizeActiveRunCard,
  summarizePendingRunJob,
  summarizeJob,
} from "./live-jobs";
import {
  buildObjectiveNavCards,
  collectTerminalRunIds,
  looksLikeConversationalPrompt,
} from "./page-builders";
import { describeProfileMarkdown } from "./profile-markdown";
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
} from "./shared";

const isInspectorPanel = (value: string | undefined): value is FactoryInspectorPanel =>
  value === "overview"
  || value === "analysis"
  || value === "execution"
  || value === "live"
  || value === "receipts";

const isTerminalObjectiveStatus = (status: unknown): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const objectiveProfileIdForPrompt = (input: {
  readonly prompt: string;
  readonly resolvedProfile: FactoryChatProfile;
  readonly profiles: ReadonlyArray<FactoryChatProfile>;
}): string => {
  if (input.resolvedProfile.id !== "generalist") return input.resolvedProfile.id;
  const hintedProfileId = inferObjectiveProfileHint(input.prompt);
  if (!hintedProfileId) return input.resolvedProfile.id;
  const hintedProfile = input.profiles.find((profile) => profile.id === hintedProfileId);
  return hintedProfile?.id ?? input.resolvedProfile.id;
};

type FactoryObjectiveListItem = Awaited<ReturnType<FactoryService["listObjectives"]>>[number];
type FactoryObjectiveDetailRecord = Awaited<ReturnType<FactoryService["getObjective"]>>;
type FactoryObjectiveStateRecord = Awaited<ReturnType<FactoryService["getObjectiveState"]>>;

const makeFactoryRunId = (): string =>
  `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const makeFactoryChatId = (): string =>
  `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

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

  const requestedObjectiveId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("thread"))
    ?? optionalTrimmedString(new URL(req.url).searchParams.get("objective"));

  const requestedChatId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("chat"));

  const requestedProfileId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("profile"));

  const requestedRunId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("run"));

  const requestedJobId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("job"));

  const requestedFocusId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("focusId"));

  const requestedPanel = (req: Request): FactoryInspectorPanel => {
    const panel = optionalTrimmedString(new URL(req.url).searchParams.get("panel"));
    if (panel === "debug") return "overview";
    return isInspectorPanel(panel) ? panel : "overview";
  };

  const requestedPanelParam = (req: Request): FactoryInspectorPanel | undefined => {
    const panel = optionalTrimmedString(new URL(req.url).searchParams.get("panel"));
    if (panel === "debug") return "overview";
    return isInspectorPanel(panel) ? panel : undefined;
  };

  const requestedShowAll = (req: Request): boolean =>
    optionalTrimmedString(new URL(req.url).searchParams.get("all")) === "1";

  const requestedFocusKind = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("focusKind"));

  const normalizeFocusKind = (value: string | undefined): "task" | "job" | undefined =>
    value === "task" || value === "job" ? value : undefined;

  const wantsJsonNavigation = (req: Request): boolean =>
    (req.headers.get("accept") ?? "").includes("application/json");

  const navigationResponse = (
    req: Request,
    location: string,
    options?: {
      readonly live?: FactoryLiveScopePayload;
    },
  ): Response =>
    wantsJsonNavigation(req)
      ? json(200, {
          location,
          ...(options?.live ? { live: options.live } : {}),
        })
      : new Response(null, {
          status: 303,
          headers: {
            Location: location,
            "Cache-Control": "no-store",
          },
        });

  const navigationError = (req: Request, status: number, message: string): Response =>
    wantsJsonNavigation(req)
      ? json(status, { error: message })
      : text(status, message);

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

  const projectionCacheTtlMs = 900;
  const chatShellCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<FactoryChatShellModel>;
  }>();
  const recentJobsCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<ReadonlyArray<QueueJob>>;
  }>();
  const profileCatalogCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<ReadonlyArray<FactoryChatProfile>>;
  }>();
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

  const withProjectionCache = async <T>(
    cache: Map<string, { readonly expiresAt: number; readonly value: Promise<T> }>,
    key: string,
    build: () => Promise<T>,
  ): Promise<T> => {
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = build();
    cache.set(key, {
      expiresAt: now + projectionCacheTtlMs,
      value,
    });
    setTimeout(() => {
      const current = cache.get(key);
      if (current?.value === value && current.expiresAt <= Date.now()) {
        cache.delete(key);
      }
    }, projectionCacheTtlMs + 20);
    return value;
  };

  const loadRecentJobs = async (limit = 120): Promise<ReadonlyArray<QueueJob>> => withProjectionCache(
    recentJobsCache,
    JSON.stringify({
      limit,
      queueVersion: ctx.queue.snapshot?.().version ?? 0,
    }),
    () => ctx.queue.listJobs({ limit }),
  );

  const loadFactoryProfiles = async (): Promise<ReadonlyArray<FactoryChatProfile>> => withProjectionCache(
    profileCatalogCache,
    profileRoot,
    () => discoverFactoryChatProfiles(profileRoot),
  );

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

  const buildChatShellModel = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
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
      objectivesPromise ??= service.listObjectives();
      return objectivesPromise;
    };
    let initialSessionStream: string | undefined;
    let initialIndexChain: Awaited<ReturnType<typeof agentRuntime.chain>> = [];
    let jobs: ReadonlyArray<QueueJob> = [];
    let chatMatchesExplicitObjective = false;

    if (!explicitObjectiveId && (input.jobId || input.runId)) {
      jobs = await loadRecentJobs();
    } else if (input.chatId) {
      initialSessionStream = factoryChatSessionStream(repoRoot, resolved.root.id, input.chatId);
      initialIndexChain = await agentRuntime.chain(initialSessionStream);
      const initialRunIds = collectRunIds(initialIndexChain);
      if (initialRunIds.length > 0) {
        jobs = await loadRecentJobs();
        if (explicitObjectiveId) {
          const initialRunChains = await Promise.all(
            initialRunIds.map((runId) => agentRuntime.chain(agentRunStream(initialSessionStream!, runId))),
          );
          const discoveredObjectiveId = latestObjectiveIdFromRunChains(initialRunChains)
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
      const activeProfileOverview = describeProfileMarkdown(effectiveProfile.mdBody);
      const jobsById = new Map(relevantObjectiveJobs.map((job) => [job.id, job] as const));
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
      const runChains = await Promise.all(runIds.map((runId) => stream ? agentRuntime.chain(agentRunStream(stream, runId)) : Promise.resolve([])));
      const chatItems = runChains.flatMap((runChain, index) => buildChatItemsForRun(runIds[index]!, runChain, jobsById));
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
            profileId: effectiveProfile.id,
            objectiveId: explicitObjectiveId,
            runId: jobAnyRunId(job),
            jobId: job.id,
            panel: inspectorPanel,
            focusKind: "job",
            focusId: job.id,
          }),
        } satisfies FactoryChatJobNav));
      const profileNav: ReadonlyArray<FactoryChatProfileNav> = profiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        summary: describeProfileMarkdown(profile.mdBody).summary,
        selected: profile.id === effectiveProfile.id,
      }));
      const objectiveNav: ReadonlyArray<FactoryChatObjectiveNav> = buildObjectiveNavCards(
        objectives,
        explicitObjectiveId,
        { includeArchivedSelectedOnly: true },
      );
      const activeCodex = buildActiveCodexCard(relevantObjectiveJobs);
      const liveChildren = stream
        ? buildLiveChildCards(relevantObjectiveJobs, stream, explicitObjectiveId)
        : [];
      const activeRunIndex = activeRunId ? runIds.indexOf(activeRunId) : -1;
      const activeRun = activeRunIndex >= 0
        ? summarizeActiveRunCard({
            runId: activeRunId!,
            runChain: runChains[activeRunIndex]!,
            relatedJobs: relevantObjectiveJobs,
            profileLabel: effectiveProfile.label,
            profileId: effectiveProfile.id,
            objectiveId: explicitObjectiveId,
          })
        : selectedJob
          ? summarizePendingRunJob(selectedJob, effectiveProfile.label)
          : undefined;
      const chatModel: FactoryChatIslandModel = {
        activeProfileId: effectiveProfile.id,
        activeProfileLabel: effectiveProfile.label,
        objectiveId: explicitObjectiveId,
        runId: activeRunId,
        knownRunIds: runIds,
        terminalRunIds: collectTerminalRunIds(runIds, runChains),
        jobId: input.jobId,
        panel: inspectorPanel,
        focusKind: resolvedFocusKind,
        focusId: resolvedFocusId,
        activeProfileSummary: activeProfileOverview.summary,
        activeProfileSections: activeProfileOverview.sections,
        selectedThread: selectedObjective,
        jobs: relevantJobs,
        activeCodex,
        liveChildren,
        activeRun,
        workbench,
        items: chatItems,
      };
      const navModel: FactoryNavModel = {
        activeProfileId: effectiveProfile.id,
        activeProfileLabel: effectiveProfile.label,
        panel: inspectorPanel,
        profiles: profileNav,
        objectives: objectiveNav,
        showAll: input.showAll,
      };
      const inspectorModel: FactoryInspectorModel = {
        panel: inspectorPanel,
        activeProfileId: effectiveProfile.id,
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
        jobs: relevantJobs,
        tasks: detail?.tasks,
      };
      return {
        activeProfileId: effectiveProfile.id,
        activeProfileLabel: effectiveProfile.label,
        objectiveId: explicitObjectiveId,
        runId: activeRunId,
        jobId: input.jobId,
        panel: inspectorPanel,
        focusKind: resolvedFocusKind,
        focusId: resolvedFocusId,
        chat: chatModel,
        nav: navModel,
        inspector: inspectorModel,
        };
      }

    if (input.chatId && !input.runId && !input.jobId && initialIndexChain.length === 0) {
      return buildUnselectedThreadShellModel({
        resolvedProfile: resolved.root,
        profiles,
        chatId: input.chatId,
        panel: input.panel,
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
    const indexChain = stream
      ? stream === initialSessionStream
        ? initialIndexChain
        : await agentRuntime.chain(stream)
      : [];

    const allRunIds = collectRunIds(indexChain);
    const requestedRunIndex = input.runId ? allRunIds.indexOf(input.runId) : -1;
    const runIds = requestedRunIndex >= 0 ? allRunIds.slice(requestedRunIndex) : allRunIds;
    const activeRunId = runIds.at(-1) ?? input.runId;
    const runChains = await Promise.all(runIds.map((runId) => stream ? agentRuntime.chain(agentRunStream(stream, runId)) : Promise.resolve([])));
    const runChainsById = new Map(runIds.map((runId, index) => [runId, runChains[index]!] as const));
    const chatItems = runChains.flatMap((runChain, index) => buildChatItemsForRun(runIds[index]!, runChain, jobsById));
    const selectedObjective = resolvedObjectiveId
      ? await service.getObjective(resolvedObjectiveId).catch(err => {
          if (err instanceof FactoryServiceError && err.status === 404) return undefined;
          throw err;
        })
      : undefined;
    const activeProfileOverview = describeProfileMarkdown(resolved.root.mdBody);

    const profileNav: ReadonlyArray<FactoryChatProfileNav> = profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      summary: describeProfileMarkdown(profile.mdBody).summary,
      selected: profile.id === resolved.root.id,
    }));
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
          runId: activeRunId!,
          runChain: runChains[activeRunIndex]!,
          relatedJobs: activeRunJobs,
          profileLabel: resolved.root.label,
          profileId: resolved.root.id,
          chatId: input.chatId,
          objectiveId: resolvedObjectiveId,
        })
      : selectedJob
          ? summarizePendingRunJob(selectedJob, resolved.root.label)
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
    const objectiveCards = objectives;
    const objectiveNav: ReadonlyArray<FactoryChatObjectiveNav> = buildObjectiveNavCards(
      objectiveCards,
      resolvedObjectiveId,
      { includeArchivedSelectedOnly: true },
    );

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

    const chatModel: FactoryChatIslandModel = {
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      runId: activeRunId,
      knownRunIds: runIds,
      terminalRunIds: collectTerminalRunIds(runIds, runChains),
      jobId: input.jobId,
      panel: inspectorPanel,
      focusKind: resolvedFocusKind,
      focusId: resolvedFocusId,
      activeProfileSummary: activeProfileOverview.summary,
      activeProfileSections: activeProfileOverview.sections,
      activeProfileTools: resolved.toolAllowlist,
      selectedThread: selectedObjectiveCard,
      jobs: relevantJobs,
      activeCodex,
      liveChildren,
      activeRun,
      workbench,
      items: chatItems,
    };
    const navModel: FactoryNavModel = {
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      chatId: input.chatId,
      panel: inspectorPanel,
      profiles: profileNav,
      objectives: objectiveNav,
      showAll: input.showAll,
    };
    const inspectorModel: FactoryInspectorModel = {
      panel: inspectorPanel,
      activeProfileId: resolved.root.id,
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
      jobs: relevantJobs,
      tasks: selectedObjective?.tasks,
      analysis: inspectorPanel === "analysis" && resolvedObjectiveId
        ? await readObjectiveAnalysis(service.dataDir, resolvedObjectiveId).catch(() => undefined)
        : undefined,
    };
    return {
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      runId: activeRunId,
      jobId: input.jobId,
      panel: inspectorPanel,
      focusKind: resolvedFocusKind,
      focusId: resolvedFocusId,
      chat: chatModel,
      nav: navModel,
      inspector: inspectorModel,
    };
  };

  const buildSidebarModel = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
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
      return {
        nav: {
          activeProfileId: explicitContext.effectiveProfile.id,
          activeProfileLabel: explicitContext.effectiveProfile.label,
          panel: input.panel,
          profiles: buildProfileNav(explicitContext.profiles, explicitContext.effectiveProfile.id),
          objectives: buildObjectiveNavCards(
            explicitContext.objectives,
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
    const objectives = await service.listObjectives();
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
    const profileNav: ReadonlyArray<FactoryChatProfileNav> = profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      summary: describeProfileMarkdown(profile.mdBody).summary,
      selected: profile.id === resolved.root.id,
    }));
    const objectiveNav: ReadonlyArray<FactoryChatObjectiveNav> = buildObjectiveNavCards(
      objectives,
      resolvedObjectiveId,
      { includeArchivedSelectedOnly: true },
    );
    return {
      nav: {
        activeProfileId: resolved.root.id,
        activeProfileLabel: resolved.root.label,
        chatId: input.chatId,
        panel: input.panel,
        profiles: profileNav,
        objectives: objectiveNav,
        showAll: input.showAll,
      },
      selectedObjective: selectedObjective ? toFactorySelectedObjectiveCard(selectedObjective) : undefined,
    };
  };

  const buildMissingInspectorModel = (input: {
    readonly activeProfileId: string;
    readonly objectiveId: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
  }): FactoryInspectorModel => ({
    panel: input.panel ?? "overview",
    activeProfileId: input.activeProfileId,
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
    profiles: ReadonlyArray<FactoryChatProfile>,
    selectedProfileId: string,
  ): ReadonlyArray<FactoryChatProfileNav> => profiles.map((profile) => ({
    id: profile.id,
    label: profile.label,
    summary: describeProfileMarkdown(profile.mdBody).summary,
    selected: profile.id === selectedProfileId,
  }));

  const buildUnselectedInspectorModel = (input: {
    readonly activeProfileId: string;
    readonly chatId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
  }): FactoryInspectorModel => ({
    panel: input.panel ?? "overview",
    activeProfileId: input.activeProfileId,
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
    readonly resolvedProfile: FactoryChatProfile;
    readonly profiles: ReadonlyArray<FactoryChatProfile>;
    readonly chatId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly showAll?: boolean;
  }): FactoryChatShellModel => {
    const activeProfileOverview = describeProfileMarkdown(input.resolvedProfile.mdBody);
    const inspectorPanel = input.panel ?? "overview";
    const profileNav = buildProfileNav(input.profiles, input.resolvedProfile.id);
    const chatModel: FactoryChatIslandModel = {
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      chatId: input.chatId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      focusKind: input.focusKind,
      focusId: input.focusId,
      activeProfileSummary: activeProfileOverview.summary,
      activeProfileSections: activeProfileOverview.sections,
      activeProfileTools: input.resolvedProfile.toolAllowlist,
      items: [],
    };
    const navModel: FactoryNavModel = {
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      chatId: input.chatId,
      panel: inspectorPanel,
      profiles: profileNav,
      objectives: [],
      showAll: input.showAll,
    };
    const inspectorModel = buildUnselectedInspectorModel({
      activeProfileId: input.resolvedProfile.id,
      chatId: input.chatId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      focusKind: input.focusKind,
      focusId: input.focusId,
    });
    return {
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      chatId: input.chatId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      focusKind: input.focusKind,
      focusId: input.focusId,
      chat: chatModel,
      nav: navModel,
      inspector: inspectorModel,
    };
  };

  const buildMissingExplicitThreadShellModel = (input: {
    readonly resolvedProfile: FactoryChatProfile;
    readonly profiles: ReadonlyArray<FactoryChatProfile>;
    readonly objectives: Awaited<ReturnType<FactoryService["listObjectives"]>>;
    readonly objectiveId: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly showAll?: boolean;
  }): FactoryChatShellModel => {
    const activeProfileOverview = describeProfileMarkdown(input.resolvedProfile.mdBody);
    const inspectorPanel = input.panel ?? "overview";
    const profileNav = buildProfileNav(input.profiles, input.resolvedProfile.id);
    const chatModel: FactoryChatIslandModel = {
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      objectiveId: input.objectiveId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      focusKind: input.focusKind,
      focusId: input.focusId,
      activeProfileSummary: activeProfileOverview.summary,
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
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      panel: inspectorPanel,
      profiles: profileNav,
      objectives: buildObjectiveNavCards(
        input.objectives,
        input.objectiveId,
        { includeArchivedSelectedOnly: true },
      ),
      showAll: input.showAll,
    };
    const inspectorModel = buildMissingInspectorModel({
      activeProfileId: input.resolvedProfile.id,
      objectiveId: input.objectiveId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      focusKind: input.focusKind,
      focusId: input.focusId,
    });
    return {
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      objectiveId: input.objectiveId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      focusKind: input.focusKind,
      focusId: input.focusId,
      chat: chatModel,
      nav: navModel,
      inspector: inspectorModel,
    };
  };

  const buildExplicitInspectorModel = async (input: {
    readonly profileId?: string;
    readonly objectiveId: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
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

    if (!selectedObjective && (panel === "overview" || panel === "receipts")) {
      return buildMissingInspectorModel({
        activeProfileId: effectiveProfile.id,
        objectiveId,
        runId: input.runId,
        jobId: input.jobId,
        panel,
        focusKind: input.focusKind,
        focusId: input.focusId,
      });
    }

    if (panel === "overview") {
      return {
        panel,
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
        jobs: [],
        tasks: undefined,
        debugInfo: maybeState,
      };
    }

    if (panel === "receipts") {
      return {
        panel,
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
        jobs: [],
        tasks: undefined,
        receipts: await service.listObjectiveReceipts(objectiveId, 100).catch(() => undefined),
      };
    }

    if (!detail) {
      return buildMissingInspectorModel({
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
    return {
      panel,
      activeProfileId: effectiveProfile.id,
      objectiveId,
      runId: input.runId,
      jobId: input.jobId,
      focusKind: workbench?.focus?.focusKind,
      focusId: workbench?.focus?.focusId,
      selectedObjective,
      activeCodex: buildActiveCodexCard(recentJobs),
      liveChildren: [],
      activeRun: undefined,
      workbench,
      jobs: relevantJobs,
      tasks: detail.tasks,
      analysis: panel === "analysis"
        ? await readObjectiveAnalysis(service.dataDir, objectiveId).catch(() => undefined)
        : undefined,
    };
  };

  const buildInspectorTabsModel = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
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
        panel: input.panel ?? "overview",
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
      panel: input.panel ?? "overview",
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
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
  }): Promise<FactoryInspectorModel> => {
    const explicitObjectiveId = input.objectiveId?.trim();
    if (explicitObjectiveId) {
      return buildExplicitInspectorModel({
        profileId: input.profileId,
        objectiveId: explicitObjectiveId,
        runId: input.runId,
        jobId: input.jobId,
        panel: input.panel,
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
    const allRunIds = collectRunIds(indexChain);
    const requestedRunIndex = input.runId ? allRunIds.indexOf(input.runId) : -1;
    const runIds = requestedRunIndex >= 0 ? allRunIds.slice(requestedRunIndex) : allRunIds;
    const activeRunId = runIds.at(-1) ?? input.runId;
    const runChains = await Promise.all(
      runIds.map((runId) => stream ? agentRuntime.chain(agentRunStream(stream, runId)) : Promise.resolve([])),
    );
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
          runId: activeRunId!,
          runChain: runChains[activeRunIndex]!,
          relatedJobs: activeRunJobs,
          profileLabel: resolved.root.label,
          profileId: resolved.root.id,
          chatId: input.chatId,
          objectiveId: resolvedObjectiveId,
        })
      : selectedJob
          ? summarizePendingRunJob(selectedJob, resolved.root.label)
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
    return {
      panel,
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
      jobs: relevantJobs,
      tasks: selectedObjective?.tasks,
    };
  };

  const buildChatShellModelCached = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly showAll?: boolean;
  }): Promise<FactoryChatShellModel> => withProjectionCache(
    chatShellCache,
    JSON.stringify({
      input,
      queueVersion: ctx.queue.snapshot?.().version ?? 0,
      objectiveVersion: typeof service.projectionVersion === "function" ? service.projectionVersion() : 0,
    }),
    () => buildChatShellModel(input),
  );

  const buildSidebarModelCached = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly showAll?: boolean;
  }): Promise<{ readonly nav: FactoryNavModel; readonly selectedObjective?: FactorySelectedObjectiveCard }> => withProjectionCache(
    sidebarCache,
    JSON.stringify({
      input,
      queueVersion: ctx.queue.snapshot?.().version ?? 0,
      objectiveVersion: typeof service.projectionVersion === "function" ? service.projectionVersion() : 0,
    }),
    () => buildSidebarModel(input),
  );

  const buildInspectorTabsModelCached = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: string;
    readonly focusId?: string;
  }): Promise<FactoryInspectorTabsModel> => withProjectionCache(
    inspectorTabsCache,
    JSON.stringify({
      input,
      queueVersion: ctx.queue.snapshot?.().version ?? 0,
      objectiveVersion: typeof service.projectionVersion === "function" ? service.projectionVersion() : 0,
    }),
    () => buildInspectorTabsModel(input),
  );

  const buildInspectorModelCached = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
  }): Promise<FactoryInspectorModel> => withProjectionCache(
    inspectorPanelCache,
    JSON.stringify({
      input,
      queueVersion: ctx.queue.snapshot?.().version ?? 0,
      objectiveVersion: typeof service.projectionVersion === "function" ? service.projectionVersion() : 0,
    }),
    () => buildInspectorModel(input),
  );

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

  const collectChatSubscriptionJobIds = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
  }): Promise<ReadonlyArray<string>> => {
    const resolved = await resolveFactoryChatProfile({
      repoRoot: service.git.repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const jobs = await loadRecentJobs();
    const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
    const selectedJob = input.jobId ? jobsById.get(input.jobId) : undefined;
    const resolvedObjectiveId = await resolveSessionObjectiveId({
      repoRoot: service.git.repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: input.objectiveId,
      selectedJob,
      jobs,
      allowExplicitFallback: true,
    });
    const stream = resolveChatViewStream({
      repoRoot: service.git.repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      job: selectedJob,
    });
    const baseQueueJobs = stream
      ? jobs.filter((job) => isRelevantShellJob(job, stream, resolvedObjectiveId))
      : [];
    const selectedRunIds = collectRunLineageIds(
      [
        input.runId,
        selectedJob ? jobRunId(selectedJob) : undefined,
        selectedJob ? jobParentRunId(selectedJob) : undefined,
      ],
      new Map<string, AgentRunChain>(),
      baseQueueJobs,
    );
    const scopedJobs = selectedRunIds.size > 0 || input.jobId
      ? baseQueueJobs.filter((job) => job.id === input.jobId || jobMatchesRunIds(job, selectedRunIds))
      : baseQueueJobs.slice(0, 16);
    return [...new Set([
      ...scopedJobs.map((job) => job.id),
      ...(input.jobId ? [input.jobId] : []),
    ])];
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
      app.post("/factory/compose", async (c) => {
        const req = c.req.raw;
        try {
          await service.ensureBootstrap();
          const body = await readRecordBody(req, (message) => new FactoryServiceError(400, message));
          const prompt = optionalTrimmedString(body.prompt);
          if (!prompt) return navigationError(req, 400, "Enter a chat message or slash command.");

          const requestedObjective = requestedObjectiveId(req);
          const requestedChatParam = requestedChatId(req);
          let requestedChat = requestedChatParam ?? (!requestedObjective ? makeFactoryChatId() : undefined);
          const requestedJob = optionalTrimmedString(body.currentJobId) ?? requestedJobId(req);
          const currentPanel = requestedPanelParam(req);
          const resolved = await resolveFactoryChatProfile({
            repoRoot: service.git.repoRoot,
            profileRoot,
            requestedId: requestedProfileId(req),
          });
          const [objectives, jobs] = await Promise.all([
            service.listObjectives(),
            loadRecentJobs(),
          ]);
          const liveObjectives = objectives.filter((objective) => !objective.archivedAt);
          const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
          let objectiveId = await resolveSessionObjectiveId({
            repoRoot: service.git.repoRoot,
            profileId: resolved.root.id,
            chatId: requestedChat,
            objectiveId: requestedObjective,
            selectedJob: requestedJob ? jobsById.get(requestedJob) : undefined,
            jobs,
            liveObjectives,
            allowExplicitFallback: true,
          });
          let activeProfileId = resolved.root.id;
          const conversationalPrompt = !prompt.startsWith("/") && looksLikeConversationalPrompt(prompt);

          if (conversationalPrompt && objectiveId) {
            requestedChat = makeFactoryChatId();
            objectiveId = undefined;
          }
          if (!prompt.startsWith("/") && !objectiveId) {
            activeProfileId = objectiveProfileIdForPrompt({
              prompt,
              resolvedProfile: resolved.root,
              profiles: await loadFactoryProfiles(),
            });
          }

          if (prompt.startsWith("/")) {
            const parsed = parseComposerDraft(prompt, objectiveId);
            if (!parsed.ok) return navigationError(req, 400, parsed.error);
            const command = parsed.command;

            switch (command.type) {
              case "help":
                return navigationResponse(
                  req,
                  `${buildChatLink({
                    profileId: resolved.root.id,
                    chatId: requestedChat,
                    objectiveId,
                    panel: currentPanel,
                  })}#factory-command-help`,
                );
              case "analyze":
                if (!objectiveId) return navigationError(req, 409, "Select an objective before opening its analysis.");
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId,
                  panel: "analysis",
                }));
              case "watch": {
                const nextObjectiveId = await resolveWatchedObjectiveId(command.objectiveId ?? objectiveId);
                if (!nextObjectiveId) {
                  return navigationError(req, 404, command.objectiveId
                    ? `Objective '${command.objectiveId}' was not found.`
                    : "Select an objective or provide one to /watch.");
                }
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId: nextObjectiveId,
                  panel: currentPanel,
                }));
              }
              case "new": {
                const nextChatId = makeFactoryChatId();
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
                return navigationResponse(req, buildChatLink({
                  profileId: targetProfileId,
                  chatId: nextChatId,
                  objectiveId: created.objectiveId,
                  panel: currentPanel,
                }));
              }
              case "react": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before reacting to it.");
                const detail = await service.reactObjectiveWithNote(objectiveId, command.message);
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId: detail.objectiveId,
                  panel: currentPanel,
                }));
              }
              case "promote": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before promoting it.");
                const detail = await service.promoteObjective(objectiveId);
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId: detail.objectiveId,
                  panel: currentPanel,
                }));
              }
              case "cancel": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before canceling it.");
                const detail = await service.cancelObjective(objectiveId, command.reason ?? "canceled from UI");
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId: detail.objectiveId,
                  panel: currentPanel,
                }));
              }
              case "cleanup": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before cleaning workspaces.");
                const detail = await service.cleanupObjectiveWorkspaces(objectiveId);
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId: detail.objectiveId,
                  panel: currentPanel,
                }));
              }
              case "archive": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before archiving it.");
                const detail = await service.archiveObjective(objectiveId);
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId: detail.objectiveId,
                  panel: currentPanel,
                }));
              }
              case "abort-job": {
                const job = await resolveComposerJob(objectiveId, requestedJob);
                const queued = await service.queueJobAbort(
                  job.id,
                  command.reason ?? "abort requested from UI",
                  "factory.web",
                );
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId: jobObjectiveId(queued.job) ?? objectiveId,
                  jobId: queued.job.id,
                  panel: currentPanel,
                  focusKind: "job",
                  focusId: queued.job.id,
                }));
              }
            }
          }

          const selectedObjective = objectiveId
            ? await service.getObjective(objectiveId).catch(() => undefined)
            : undefined;
          const redirectObjectiveId = conversationalPrompt
            ? undefined
            : selectedObjective && isTerminalObjectiveStatus(selectedObjective.status)
            ? undefined
            : objectiveId;

          const stream = requestedChat
            ? factoryChatSessionStream(service.git.repoRoot, activeProfileId, requestedChat)
            : factoryChatStream(service.git.repoRoot, activeProfileId, objectiveId);
          const runId = makeFactoryRunId();
          const created = await ctx.queue.enqueue({
            agentId: "factory",
            lane: "chat",
            sessionKey: `factory-chat:${stream}`,
            singletonMode: "allow",
            maxAttempts: 1,
            payload: {
              kind: "factory.run",
              stream,
              runId,
              problem: prompt,
              profileId: activeProfileId,
              ...(objectiveId ? { objectiveId } : {}),
              ...(requestedChat ? { chatId: requestedChat } : {}),
            },
          });
          ctx.sse.publish("jobs", created.id);
          if (objectiveId) ctx.sse.publish("factory", objectiveId);
          return navigationResponse(req, buildChatLink({
            profileId: activeProfileId,
            chatId: requestedChat,
            objectiveId: redirectObjectiveId,
            panel: currentPanel,
          }), {
            live: {
              profileId: activeProfileId,
              ...(requestedChat ? { chatId: requestedChat } : {}),
              ...(objectiveId ? { objectiveId } : {}),
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

      app.get("/factory", async (c) => wrap(
        async () => buildChatShellModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
          showAll: requestedShowAll(c.req.raw),
        }),
        (model) => html(factoryChatShell(model))
      ));

      app.get("/factory/new-chat", async (c) => wrap(
        async () => buildChatLink({
          profileId: requestedProfileId(c.req.raw) ?? "generalist",
          chatId: makeFactoryChatId(),
        }),
        (location) => new Response(null, {
          status: 303,
          headers: {
            Location: location,
            "Cache-Control": "no-store",
          },
        })
      ));

      app.get("/factory/events", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          const resolved = await resolveFactoryChatProfile({
            repoRoot: service.git.repoRoot,
            profileRoot,
            requestedId: requestedProfileId(c.req.raw),
          });
          const chatId = requestedChatId(c.req.raw);
          const jobId = requestedJobId(c.req.raw);
          const selectedJob = jobId ? await ctx.queue.getJob(jobId) : undefined;
          const jobs = await loadRecentJobs();
          const objectiveId = await resolveSessionObjectiveId({
            repoRoot: service.git.repoRoot,
            profileId: resolved.root.id,
            chatId,
            objectiveId: requestedObjectiveId(c.req.raw),
            selectedJob,
            jobs,
            allowExplicitFallback: true,
          });
          return {
            stream: resolveChatViewStream({
              repoRoot: service.git.repoRoot,
              profileId: resolved.root.id,
              chatId,
              objectiveId,
              job: selectedJob,
            }),
            objectiveId,
            jobId,
            jobIds: await collectChatSubscriptionJobIds({
              profileId: requestedProfileId(c.req.raw),
              chatId,
              objectiveId,
              runId: requestedRunId(c.req.raw),
              jobId,
            }),
          };
        },
        (body) => ctx.sse.subscribeMany([
          ...(body.stream ? [{ topic: "agent" as const, stream: body.stream }] : []),
          { topic: "factory" as const },
          ...body.jobIds.map((jobId) => ({ topic: "jobs" as const, stream: jobId })),
          ...(body.jobId && !body.jobIds.includes(body.jobId) ? [{ topic: "jobs" as const, stream: body.jobId }] : []),
        ], c.req.raw.signal)
      ));

      app.get("/factory/island/chat", async (c) => wrap(
        async () => {
          const model = await buildChatShellModelCached({
            profileId: requestedProfileId(c.req.raw),
            chatId: requestedChatId(c.req.raw),
            objectiveId: requestedObjectiveId(c.req.raw),
            runId: requestedRunId(c.req.raw),
            jobId: requestedJobId(c.req.raw),
            panel: requestedPanel(c.req.raw),
            focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
            focusId: requestedFocusId(c.req.raw),
            showAll: requestedShowAll(c.req.raw),
          });
          return model.chat;
        },
        (model) => html(factoryChatIsland(model))
      ));

      app.get("/factory/island/sidebar", async (c) => wrap(
        async () => buildSidebarModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          showAll: requestedShowAll(c.req.raw),
        }),
        (model) => html(factorySidebarIsland(model.nav, model.selectedObjective))
      ));

      app.get("/factory/island/inspector", async (c) => wrap(
        async () => hydrateInspectorPanel(await buildInspectorModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
        })),
        (model) => html(factoryInspectorIsland(model))
      ));

      app.get("/factory/island/inspector/tabs", async (c) => wrap(
        async () => buildInspectorTabsModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: requestedFocusKind(c.req.raw),
          focusId: requestedFocusId(c.req.raw),
        }),
        (model) => html(factoryInspectorTabsIsland(model))
      ));

      app.get("/factory/island/inspector/panel", async (c) => wrap(
        async () => hydrateInspectorPanel(await buildInspectorModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
        })),
        (model) => html(factoryInspectorPanelIsland(model))
      ));

      app.get("/factory/island/inspector/select", async (c) => wrap(
        async () => hydrateInspectorPanel(await buildInspectorModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
        })),
        (model) => html(factoryInspectorSelectionIsland(model))
      ));

      app.get("/factory/chat", async (c) => wrap(
        async () => buildChatLink({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanelParam(c.req.raw),
        }),
        (location) => new Response(null, {
          status: 303,
          headers: {
            Location: location,
            "Cache-Control": "no-store",
          },
        })
      ));

      app.get("/factory/chat/events", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          const resolved = await resolveFactoryChatProfile({
            repoRoot: service.git.repoRoot,
            profileRoot,
            requestedId: requestedProfileId(c.req.raw),
          });
          const chatId = requestedChatId(c.req.raw);
          const jobId = requestedJobId(c.req.raw);
          const selectedJob = jobId ? await ctx.queue.getJob(jobId) : undefined;
          const jobs = await loadRecentJobs();
          const objectiveId = await resolveSessionObjectiveId({
            repoRoot: service.git.repoRoot,
            profileId: resolved.root.id,
            chatId,
            objectiveId: requestedObjectiveId(c.req.raw),
            selectedJob,
            jobs,
            allowExplicitFallback: true,
          });
          return {
            stream: resolveChatViewStream({
              repoRoot: service.git.repoRoot,
              profileId: resolved.root.id,
              chatId,
              objectiveId,
              job: selectedJob,
            }),
            objectiveId,
            jobId,
            jobIds: await collectChatSubscriptionJobIds({
              profileId: requestedProfileId(c.req.raw),
              chatId,
              objectiveId,
              runId: requestedRunId(c.req.raw),
              jobId,
            }),
          };
        },
        (body) => ctx.sse.subscribeMany([
          ...(body.stream ? [{ topic: "agent" as const, stream: body.stream }] : []),
          { topic: "factory" as const },
          ...body.jobIds.map((jobId) => ({ topic: "jobs" as const, stream: jobId })),
          ...(body.jobId && !body.jobIds.includes(body.jobId) ? [{ topic: "jobs" as const, stream: body.jobId }] : []),
        ], c.req.raw.signal)
      ));

      app.get("/factory/chat/island/chat", async (c) => wrap(
        async () => {
          const model = await buildChatShellModelCached({
            profileId: requestedProfileId(c.req.raw),
            chatId: requestedChatId(c.req.raw),
            objectiveId: requestedObjectiveId(c.req.raw),
            runId: requestedRunId(c.req.raw),
            jobId: requestedJobId(c.req.raw),
            panel: requestedPanel(c.req.raw),
            focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
            focusId: requestedFocusId(c.req.raw),
          });
          return model.chat;
        },
        (model) => html(factoryChatIsland(model))
      ));

      app.get("/factory/chat/island/sidebar", async (c) => wrap(
        async () => buildSidebarModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          showAll: requestedShowAll(c.req.raw),
        }),
        (model) => html(factorySidebarIsland(model.nav, model.selectedObjective))
      ));

      app.get("/factory/chat/island/inspector", async (c) => wrap(
        async () => hydrateInspectorPanel(await buildInspectorModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
        })),
        (model) => html(factoryInspectorIsland(model))
      ));

      app.get("/factory/chat/island/inspector/tabs", async (c) => wrap(
        async () => buildInspectorTabsModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: requestedFocusKind(c.req.raw),
          focusId: requestedFocusId(c.req.raw),
        }),
        (model) => html(factoryInspectorTabsIsland(model))
      ));

      app.get("/factory/chat/island/inspector/panel", async (c) => wrap(
        async () => hydrateInspectorPanel(await buildInspectorModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
        })),
        (model) => html(factoryInspectorPanelIsland(model))
      ));

      app.get("/factory/chat/island/inspector/select", async (c) => wrap(
        async () => hydrateInspectorPanel(await buildInspectorModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
        })),
        (model) => html(factoryInspectorSelectionIsland(model))
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

      app.get("/receipt", async (c) => {
        const file = c.req.query("file") ?? "";
        const order = parseOrder(c.req.query("order"));
        const limit = parseLimit(c.req.query("limit"));
        const depth = parseInspectorDepth(c.req.query("depth"));
        const files = await listReceiptFiles(receiptDataDir);
        const selected = files.find((f) => f.name === file)?.name ?? files[0]?.name;
        return html(receiptShell({ selected, limit, order, depth }));
      });

      app.get("/receipt/island/folds", async (c) => {
        const selected = c.req.query("selected") ?? "";
        const order = parseOrder(c.req.query("order"));
        const limit = parseLimit(c.req.query("limit"));
        const depth = parseInspectorDepth(c.req.query("depth"));
        const files = await listReceiptFiles(receiptDataDir);
        return html(receiptFoldsHtml(files, selected, order, limit, depth));
      });

      app.get("/receipt/island/records", async (c) => {
        const file = c.req.query("file") ?? "";
        if (!file) return html(receiptRecordsHtml({ selected: undefined, records: [], order: "desc", limit: 200, total: 0 }));
        const files = await listReceiptFiles(receiptDataDir);
        const found = files.find((f) => f.name === file);
        if (!found) return html(`<div class="empty">Stream not found.</div>`);
        const records = await readReceiptFile(receiptDataDir, found.name);
        const order = parseOrder(c.req.query("order"));
        const limit = parseLimit(c.req.query("limit"));
        const slice = sliceReceiptRecords(records, order, limit);
        return html(receiptRecordsHtml({ selected: found.name, records: slice, order, limit, total: records.length }));
      });

      app.get("/receipt/island/side", async (c) => {
        const file = c.req.query("file") ?? "";
        const order = parseOrder(c.req.query("order"));
        const limit = parseLimit(c.req.query("limit"));
        const depth = parseInspectorDepth(c.req.query("depth"));
        if (!file) {
          return html(receiptSideHtml({ selected: undefined, order, limit, depth, total: 0, shown: 0 }));
        }
        const files = await listReceiptFiles(receiptDataDir);
        const found = files.find((f) => f.name === file);
        if (!found) {
          return html(receiptSideHtml({ selected: file, order, limit, depth, total: 0, shown: 0 }));
        }
        const records = await readReceiptFile(receiptDataDir, found.name);
        const slice = sliceReceiptRecords(records, order, limit);
        const timeline = buildReceiptTimeline(records, depth);
        return html(receiptSideHtml({
          selected: found.name,
          order,
          limit,
          depth,
          total: records.length,
          shown: slice.length,
          fileMeta: { size: found.size, mtime: found.mtime },
          timeline,
        }));
      });

      app.get("/receipt/stream", async (c) => receiptSse.subscribe("receipt", undefined, c.req.raw.signal));
    },
  };
};

export default createFactoryRoute;
