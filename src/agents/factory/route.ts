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
import { parseComposerDraft, prepareObjectiveCreation } from "../../factory-cli/composer";
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
import { buildChatItemsForRun } from "./chat-items";
import {
  buildChatLink,
  collectScopedObjectiveIds,
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

const FACTORY_INSPECTOR_TABS_TRIGGER = "sse:factory-refresh throttle:900ms, sse:job-refresh throttle:900ms";
const FACTORY_INSPECTOR_PANEL_TRIGGER = "sse:factory-refresh throttle:450ms, sse:job-refresh throttle:450ms";

const isTerminalObjectiveStatus = (status: unknown): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

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
    return panel === "execution" || panel === "live" || panel === "receipts" || panel === "debug"
      ? panel
      : "overview";
  };

  const requestedPanelParam = (req: Request): FactoryInspectorPanel | undefined => {
    const panel = optionalTrimmedString(new URL(req.url).searchParams.get("panel"));
    return panel === "overview" || panel === "execution" || panel === "live" || panel === "receipts" || panel === "debug"
      ? panel
      : undefined;
  };

  const requestedShowAll = (req: Request): boolean =>
    optionalTrimmedString(new URL(req.url).searchParams.get("all")) === "1";

  const requestedFocusKind = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("focusKind"));

  const normalizeFocusKind = (value: string | undefined): "task" | "job" | undefined =>
    value === "task" || value === "job" ? value : undefined;

  const wantsJsonNavigation = (req: Request): boolean =>
    (req.headers.get("accept") ?? "").includes("application/json");

  const navigationResponse = (req: Request, location: string): Response =>
    wantsJsonNavigation(req)
      ? json(200, { location })
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
    const scopedUi = Boolean(input.objectiveId?.trim() || input.chatId?.trim());
    const [resolved, profiles] = await Promise.all([
      resolveFactoryChatProfile({
        repoRoot,
        profileRoot,
        requestedId: input.profileId,
      }),
      loadFactoryProfiles(),
    ]);
    let initialSessionStream: string | undefined;
    let initialIndexChain: Awaited<ReturnType<typeof agentRuntime.chain>> = [];
    let jobs: ReadonlyArray<QueueJob> = [];

    if (explicitObjectiveId || input.jobId || input.runId) {
      jobs = await loadRecentJobs();
    } else if (input.chatId) {
      initialSessionStream = factoryChatSessionStream(repoRoot, resolved.root.id, input.chatId);
      initialIndexChain = await agentRuntime.chain(initialSessionStream);
      if (collectRunIds(initialIndexChain).length > 0) {
        jobs = await loadRecentJobs();
      }
    }

    if (explicitObjectiveId && !input.chatId) {
      const [state, detail] = await Promise.all([
        service.getObjectiveState(explicitObjectiveId).catch(() => undefined),
        service.getObjective(explicitObjectiveId).catch((err) => {
          if (err instanceof FactoryServiceError && err.status === 404) return undefined;
          throw err;
        }),
      ]);
      if (!state && !detail) {
        return buildMissingExplicitThreadShellModel({
          resolvedProfile: resolved.root,
          profiles,
          objectiveId: explicitObjectiveId,
          runId: input.runId,
          jobId: input.jobId,
          panel: input.panel,
          focusKind: input.focusKind,
          focusId: input.focusId,
          showAll: input.showAll,
        });
      }
      const stateProfileId = state?.profile.rootProfileId;
      const effectiveProfile = profiles.find((profile) => profile.id === stateProfileId) ?? resolved.root;
      const activeProfileOverview = describeProfileMarkdown(effectiveProfile.mdBody);
      const objectiveJobs = jobs
        .filter((job) => jobObjectiveId(job) === explicitObjectiveId)
        .sort(compareJobsByRecency);
      const jobsById = new Map(objectiveJobs.map((job) => [job.id, job] as const));
      const selectedJob = input.jobId ? jobsById.get(input.jobId) : undefined;
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
      const selectedObjectiveCard = detail
        ? toFactorySelectedObjectiveCard(detail)
        : state
          ? toFactoryStateSelectedObjectiveCard(state)
          : undefined;
      const initialWorkbench = detail
        ? buildFactoryWorkbench({
            detail,
            recentJobs: objectiveJobs,
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
            recentJobs: objectiveJobs,
            requestedFocusKind: initialWorkbench?.focus?.focusKind ?? input.focusKind,
            requestedFocusId: initialWorkbench?.focus?.focusId ?? input.focusId,
            liveOutput,
          })
        : undefined;
      const resolvedFocusKind = workbench?.focus?.focusKind ?? input.focusKind;
      const resolvedFocusId = workbench?.focus?.focusId ?? input.focusId;
      const inspectorPanel = input.panel ?? (workbench?.hasActiveExecution ? "live" : "overview");
      const relevantJobs = objectiveJobs
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
      const objectiveNav: ReadonlyArray<FactoryChatObjectiveNav> = selectedObjectiveCard
        ? [{
            objectiveId: selectedObjectiveCard.objectiveId,
            title: selectedObjectiveCard.title,
            status: selectedObjectiveCard.status,
            phase: selectedObjectiveCard.phase,
            summary: selectedObjectiveCard.summary,
            selected: true,
            slotState: selectedObjectiveCard.slotState,
            activeTaskCount: selectedObjectiveCard.activeTaskCount,
            readyTaskCount: selectedObjectiveCard.readyTaskCount,
            taskCount: selectedObjectiveCard.taskCount,
            integrationStatus: selectedObjectiveCard.integrationStatus,
            tokensUsed: selectedObjectiveCard.tokensUsed,
          }]
        : [];
      const activeCodex = buildActiveCodexCard(objectiveJobs);
      const liveChildren = stream
        ? buildLiveChildCards(objectiveJobs, stream, explicitObjectiveId)
        : [];
      const activeRunIndex = activeRunId ? runIds.indexOf(activeRunId) : -1;
      const activeRun = activeRunIndex >= 0
        ? summarizeActiveRunCard({
            runId: activeRunId!,
            runChain: runChains[activeRunIndex]!,
            relatedJobs: objectiveJobs,
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
        jobId: input.jobId,
        panel: inspectorPanel,
        focusKind: resolvedFocusKind,
        focusId: resolvedFocusId,
        activeProfileSummary: activeProfileOverview.summary,
        activeProfileSections: activeProfileOverview.sections,
        selectedThread: selectedObjectiveCard,
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
        selectedObjective: selectedObjectiveCard,
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

    const objectives = scopedUi ? [] : await service.listObjectives();
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
    const scopedObjectiveIds = collectScopedObjectiveIds({
      requestedObjectiveId: input.objectiveId,
      resolvedObjectiveId,
      chatId: input.chatId,
      items: chatItems,
      jobs: relevantQueueJobs,
    });
    const objectiveCards = scopedUi
      ? (scopedObjectiveIds.length > 0
          ? await service.listObjectives({ objectiveIds: scopedObjectiveIds })
          : [])
      : objectives;
    const objectiveNav: ReadonlyArray<FactoryChatObjectiveNav> = objectiveCards
      .filter((objective) => !objective.archivedAt || objective.objectiveId === resolvedObjectiveId)
      .slice(0, input.showAll ? undefined : 16)
      .map((objective) => ({
        objectiveId: objective.objectiveId,
        title: objective.title,
        status: objective.status,
        phase: objective.phase,
        summary: objective.latestSummary ?? objective.nextAction,
        updatedAt: objective.updatedAt,
        selected: objective.objectiveId === resolvedObjectiveId,
        slotState: objective.scheduler.slotState,
        activeTaskCount: objective.activeTaskCount,
        readyTaskCount: objective.readyTaskCount,
        taskCount: objective.taskCount,
        integrationStatus: objective.integrationStatus,
        tokensUsed: objective.tokensUsed,
      }));

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
    readonly showAll?: boolean;
  }): Promise<{ readonly nav: FactoryNavModel; readonly selectedObjective?: FactorySelectedObjectiveCard }> => {
    await service.ensureBootstrap();
    const repoRoot = service.git.repoRoot;
    const explicitObjectiveId = input.objectiveId?.trim();
    const scopedUi = Boolean(input.objectiveId?.trim() || input.chatId?.trim());
    const resolved = await resolveFactoryChatProfile({
      repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const profilesPromise = loadFactoryProfiles();
    let jobs: ReadonlyArray<QueueJob> = [];
    if (explicitObjectiveId) {
      if (input.jobId) jobs = await loadRecentJobs();
    } else if (input.jobId || input.runId) {
      jobs = await loadRecentJobs();
    } else if (input.chatId) {
      const initialSessionStream = factoryChatSessionStream(repoRoot, resolved.root.id, input.chatId);
      const indexChain = await agentRuntime.chain(initialSessionStream);
      if (collectRunIds(indexChain).length > 0) {
        jobs = await loadRecentJobs();
      }
    }
    const profiles = await profilesPromise;
    const objectives = scopedUi ? [] : await service.listObjectives();
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
    const scopedObjectiveIds = explicitObjectiveId
      ? [explicitObjectiveId]
      : collectScopedObjectiveIds({
          requestedObjectiveId: input.objectiveId,
          resolvedObjectiveId,
          chatId: input.chatId,
          items: [],
          jobs: scopedJobs,
        });
    const objectiveCards = scopedUi
      ? (scopedObjectiveIds.length > 0
          ? await service.listObjectives({
              objectiveIds: scopedObjectiveIds,
            })
          : [])
      : objectives;
    const selectedObjective = objectiveCards.find((objective) => objective.objectiveId === resolvedObjectiveId);
    const profileNav: ReadonlyArray<FactoryChatProfileNav> = profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      summary: describeProfileMarkdown(profile.mdBody).summary,
      selected: profile.id === resolved.root.id,
    }));
    const objectiveNav: ReadonlyArray<FactoryChatObjectiveNav> = objectiveCards
      .filter((objective) => !objective.archivedAt || objective.objectiveId === resolvedObjectiveId)
      .slice(0, input.showAll ? undefined : 16)
      .map((objective) => ({
        objectiveId: objective.objectiveId,
        title: objective.title,
        status: objective.status,
        phase: objective.phase,
        summary: objective.latestSummary ?? objective.nextAction,
        updatedAt: objective.updatedAt,
        selected: objective.objectiveId === resolvedObjectiveId,
        slotState: objective.scheduler.slotState,
        activeTaskCount: objective.activeTaskCount,
        readyTaskCount: objective.readyTaskCount,
        taskCount: objective.taskCount,
        integrationStatus: objective.integrationStatus,
      }));
    return {
      nav: {
        activeProfileId: resolved.root.id,
        activeProfileLabel: resolved.root.label,
        chatId: input.chatId,
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

  const buildMissingExplicitThreadShellModel = (input: {
    readonly resolvedProfile: FactoryChatProfile;
    readonly profiles: ReadonlyArray<FactoryChatProfile>;
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
    const profileNav: ReadonlyArray<FactoryChatProfileNav> = input.profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      summary: describeProfileMarkdown(profile.mdBody).summary,
      selected: profile.id === input.resolvedProfile.id,
    }));
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
      profiles: profileNav,
      objectives: [],
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
    const repoRoot = service.git.repoRoot;
    const resolved = await resolveFactoryChatProfile({
      repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const objectiveId = input.objectiveId.trim();
    const panel = input.panel ?? "overview";
    const [maybeState, objectiveJobs] = await Promise.all([
      panel === "overview" || panel === "debug" || panel === "receipts"
        ? service.getObjectiveState(objectiveId).catch(() => undefined)
        : Promise.resolve(undefined),
      panel === "overview" || panel === "live"
        ? loadRecentJobs().then((jobs) =>
            jobs
              .filter((job) => jobObjectiveId(job) === objectiveId)
              .sort(compareJobsByRecency)
          )
        : Promise.resolve([] as ReadonlyArray<QueueJob>),
    ]);
    const selectedObjective = maybeState ? toFactoryStateSelectedObjectiveCard(maybeState) : undefined;

    if (!maybeState && (panel === "overview" || panel === "receipts" || panel === "debug")) {
      return buildMissingInspectorModel({
        activeProfileId: resolved.root.id,
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
        activeProfileId: resolved.root.id,
        objectiveId,
        runId: input.runId,
        jobId: input.jobId,
        focusKind: input.focusKind,
        focusId: input.focusId,
        selectedObjective,
        activeCodex: buildActiveCodexCard(objectiveJobs),
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
        activeProfileId: resolved.root.id,
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

    if (panel === "debug") {
      return {
        panel,
        activeProfileId: resolved.root.id,
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
        debugInfo: maybeState,
      };
    }

    const detail = await service.getObjective(objectiveId).catch(() => undefined);
    if (!detail) {
      return buildMissingInspectorModel({
        activeProfileId: resolved.root.id,
        objectiveId,
        runId: input.runId,
        jobId: input.jobId,
        panel,
        focusKind: input.focusKind,
        focusId: input.focusId,
      });
    }
    const selectedObjectiveDetail = toFactorySelectedObjectiveCard(detail);

    const recentJobs = objectiveJobs.length > 0
      ? objectiveJobs
      : await loadRecentJobs().then((jobs) =>
          jobs
            .filter((job) => jobObjectiveId(job) === objectiveId)
            .sort(compareJobsByRecency)
        );
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
          profileId: resolved.root.id,
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
      activeProfileId: resolved.root.id,
      objectiveId,
      runId: input.runId,
      jobId: input.jobId,
      focusKind: workbench?.focus?.focusKind,
      focusId: workbench?.focus?.focusId,
      selectedObjective: selectedObjectiveDetail,
      activeCodex: buildActiveCodexCard(recentJobs),
      liveChildren: [],
      activeRun: undefined,
      workbench,
      jobs: relevantJobs,
      tasks: detail.tasks,
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
    const repoRoot = service.git.repoRoot;
    const explicitObjectiveId = input.objectiveId?.trim();
    const resolved = await resolveFactoryChatProfile({
      repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const jobs = explicitObjectiveId && !input.jobId
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
    let receipts: FactoryInspectorModel["receipts"];
    let debugInfo: FactoryInspectorModel["debugInfo"];
    let tasks: FactoryInspectorModel["tasks"];

    if (objectiveId) {
      if (panel === "receipts" && !model.receipts) {
        try {
          receipts = await service.listObjectiveReceipts(objectiveId, 100);
        } catch {
          // Ignore if not initialized
        }
      } else if (panel === "debug" && !model.debugInfo) {
        try {
          debugInfo = await service.getObjectiveState(objectiveId);
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
      receipts: receipts ?? model.receipts,
      debugInfo: debugInfo ?? model.debugInfo,
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
          const requestedChat = requestedChatId(req) ?? (!requestedObjective ? makeFactoryChatId() : undefined);
          const requestedRun = requestedRunId(req);
          const requestedJob = optionalTrimmedString(body.currentJobId) ?? requestedJobId(req);
          const currentPanel = requestedPanelParam(req);
          const currentFocusKind = normalizeFocusKind(requestedFocusKind(req));
          const currentFocusId = requestedFocusId(req);
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
                    runId: requestedRun,
                    jobId: requestedJob,
                    panel: currentPanel,
                    focusKind: currentFocusKind,
                    focusId: currentFocusId,
                  })}#factory-command-help`,
                );
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
                const created = await service.createObjective({
                  title: command.title ?? "Factory objective",
                  prompt: command.prompt,
                  objectiveMode: command.objectiveMode,
                  profileId: resolved.root.id,
                  startImmediately: true,
                });
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
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
                  runId: requestedRun,
                  jobId: requestedJob,
                  panel: currentPanel,
                  focusKind: currentFocusKind,
                  focusId: currentFocusId,
                }));
              }
              case "promote": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before promoting it.");
                const detail = await service.promoteObjective(objectiveId);
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId: detail.objectiveId,
                  runId: requestedRun,
                  jobId: requestedJob,
                  panel: currentPanel,
                  focusKind: currentFocusKind,
                  focusId: currentFocusId,
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
                  focusKind: currentFocusKind,
                  focusId: currentFocusId,
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
                  focusKind: currentFocusKind,
                  focusId: currentFocusId,
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
                  focusKind: currentFocusKind,
                  focusId: currentFocusId,
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
                  runId: jobAnyRunId(queued.job) ?? requestedRun,
                  jobId: queued.job.id,
                  panel: currentPanel,
                  focusKind: "job",
                  focusId: queued.job.id,
                }));
              }
            }
          }

          if (!objectiveId) {
            const prepared = prepareObjectiveCreation(prompt);
            const created = await service.createObjective({
              title: prepared.title,
              prompt: prepared.prompt,
              objectiveMode: prepared.objectiveMode,
              profileId: resolved.root.id,
              startImmediately: true,
            });
            objectiveId = created.objectiveId;
          }

          const selectedObjective = objectiveId
            ? await service.getObjective(objectiveId).catch(() => undefined)
            : undefined;
          const redirectObjectiveId = selectedObjective && isTerminalObjectiveStatus(selectedObjective.status)
            ? undefined
            : objectiveId;

          const stream = requestedChat
            ? factoryChatSessionStream(service.git.repoRoot, resolved.root.id, requestedChat)
            : factoryChatStream(service.git.repoRoot, resolved.root.id, objectiveId);
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
              profileId: resolved.root.id,
              ...(objectiveId ? { objectiveId } : {}),
              ...(requestedChat ? { chatId: requestedChat } : {}),
            },
          });
          ctx.sse.publish("jobs", created.id);
          if (objectiveId) ctx.sse.publish("factory", objectiveId);
          return navigationResponse(req, buildChatLink({
            profileId: resolved.root.id,
            chatId: requestedChat,
            objectiveId: redirectObjectiveId,
            runId,
            jobId: created.id,
            panel: currentPanel,
            focusKind: currentFocusKind,
            focusId: currentFocusId,
          }));
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
          ...(body.objectiveId ? [{ topic: "factory" as const, stream: body.objectiveId }] : []),
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
        (model) => html(factoryInspectorIsland(model, {
          tabsTrigger: FACTORY_INSPECTOR_TABS_TRIGGER,
          panelTrigger: FACTORY_INSPECTOR_PANEL_TRIGGER,
        }))
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
        (model) => html(factoryInspectorTabsIsland(model, {
          tabsTrigger: FACTORY_INSPECTOR_TABS_TRIGGER,
        }))
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
        (model) => html(factoryInspectorPanelIsland(model, {
          panelTrigger: FACTORY_INSPECTOR_PANEL_TRIGGER,
        }))
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
        (model) => html(factoryInspectorSelectionIsland(model, {
          tabsTrigger: FACTORY_INSPECTOR_TABS_TRIGGER,
          panelTrigger: FACTORY_INSPECTOR_PANEL_TRIGGER,
        }))
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
          ...(body.objectiveId ? [{ topic: "factory" as const, stream: body.objectiveId }] : []),
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
        (model) => html(factoryInspectorIsland(model, {
          tabsTrigger: FACTORY_INSPECTOR_TABS_TRIGGER,
          panelTrigger: FACTORY_INSPECTOR_PANEL_TRIGGER,
        }))
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
        (model) => html(factoryInspectorTabsIsland(model, {
          tabsTrigger: FACTORY_INSPECTOR_TABS_TRIGGER,
        }))
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
        (model) => html(factoryInspectorPanelIsland(model, {
          panelTrigger: FACTORY_INSPECTOR_PANEL_TRIGGER,
        }))
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
        (model) => html(factoryInspectorSelectionIsland(model, {
          tabsTrigger: FACTORY_INSPECTOR_TABS_TRIGGER,
          panelTrigger: FACTORY_INSPECTOR_PANEL_TRIGGER,
        }))
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
