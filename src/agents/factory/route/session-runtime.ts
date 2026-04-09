import type { Receipt } from "@receipt/core/types";
import type { Runtime } from "@receipt/core/runtime";

import type { AgentCmd, AgentEvent, AgentState } from "../../../modules/agent";
import type { JobRecord } from "../../../modules/job";
import { agentRunStream } from "../../agent.streams";
import {
  factoryChatSessionStream,
  type FactoryChatProfile,
  resolveFactoryChatProfile,
} from "../../../services/factory-chat-profiles";
import {
  FactoryService,
  FactoryServiceError,
} from "../../../services/factory-service";
import {
  toFactorySelectedObjectiveCard,
  toFactoryStateSelectedObjectiveCard,
} from "../../../views/factory/objective-presenters";
import type {
  FactoryInspectorModel,
  FactoryLiveRunCard,
  FactorySelectedObjectiveCard,
} from "../../../views/factory-models";
import type { QueueJob } from "../../../adapters/sqlite-queue";
import {
  buildActiveCodexCard,
  buildLiveChildCards,
  collectRunIds,
  collectRunLineageIds,
  jobMatchesRunIds,
  summarizeActiveRunCard,
} from "../live-jobs";
import type { FactoryChatContextProjection } from "../chat-context";
import {
  asString,
  compareJobsByRecency,
  isRelevantShellJob,
  type AgentRunChain,
} from "../shared";
import {
  writeObjectiveHandoffToSession,
  type ObjectiveHandoffView,
} from "../session-handoff";

type FactoryObjectiveListItem = Awaited<ReturnType<FactoryService["listObjectives"]>>[number];
type FactoryObjectiveDetailRecord = Awaited<ReturnType<FactoryService["getObjective"]>>;
type FactoryObjectiveStateRecord = Awaited<ReturnType<FactoryService["getObjectiveState"]>>;

export const createFactoryRouteSessionRuntime = (input: {
  readonly service: FactoryService;
  readonly agentRuntime: Runtime<AgentCmd, AgentEvent, AgentState>;
  readonly profileRoot: string;
  readonly loadRecentJobs: (limit?: number) => Promise<ReadonlyArray<QueueJob>>;
  readonly loadFactoryProfiles: () => Promise<ReadonlyArray<FactoryChatProfile>>;
  readonly resolveSessionObjectiveId: (inputValue: {
    readonly repoRoot: string;
    readonly profileId: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly selectedJob?: QueueJob;
    readonly jobs: ReadonlyArray<QueueJob>;
    readonly liveObjectives?: ReadonlyArray<{ readonly objectiveId: string }>;
  }) => Promise<string | undefined>;
  readonly scopeRunTimelineToObjective: (inputValue: {
    readonly objectiveId?: string;
    readonly runIds: ReadonlyArray<string>;
    readonly runChains: ReadonlyArray<AgentRunChain>;
    readonly jobs?: ReadonlyArray<QueueJob>;
  }) => {
    readonly runIds: ReadonlyArray<string>;
    readonly runChains: ReadonlyArray<AgentRunChain>;
  };
  readonly loadChatContextProjectionForSession: (inputValue: {
    readonly sessionStream: string;
    readonly fallbackChain?: ReadonlyArray<Receipt<AgentEvent>>;
  }) => Promise<FactoryChatContextProjection | undefined>;
  readonly getJob: (jobId: string) => Promise<QueueJob | undefined>;
}) => {
  const ensureObjectiveHandoffInSession = async (handoffInput: {
    readonly profileId: string;
    readonly chatId?: string;
    readonly objective?: ObjectiveHandoffView;
  }): Promise<void> => {
    if (!handoffInput.chatId || !handoffInput.objective) return;
    await writeObjectiveHandoffToSession({
      agentRuntime: input.agentRuntime,
      repoRoot: input.service.git.repoRoot,
      profileId: handoffInput.profileId,
      chatId: handoffInput.chatId,
      objective: handoffInput.objective,
    });
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
      selectedJob = await input.getJob(selectedJobId);
    }
    const jobs = [...jobsById.values()].sort(compareJobsByRecency);
    return {
      jobs,
      selectedJob,
    };
  };

  const buildWorkbenchSessionRuntime = async (runtimeInput: {
    readonly repoRoot: string;
    readonly profileId: string;
    readonly profileLabel: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly seedJobs?: ReadonlyArray<QueueJob>;
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
    if (!runtimeInput.chatId) {
      const scopedJobs = [...(runtimeInput.seedJobs ?? [])].sort(compareJobsByRecency).slice(0, 24);
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
    const stream = factoryChatSessionStream(runtimeInput.repoRoot, runtimeInput.profileId, runtimeInput.chatId);
    const indexChain = await input.agentRuntime.chain(stream);
    const runIds = collectRunIds(indexChain);
    const recentJobs = runIds.length > 0 ? await input.loadRecentJobs(80) : [];
    const jobsById = new Map<string, QueueJob>();
    for (const job of runtimeInput.seedJobs ?? []) jobsById.set(job.id, job);
    for (const job of recentJobs) jobsById.set(job.id, job);
    const scopedJobs = [...jobsById.values()]
      .filter((job) =>
        asString(job.payload.chatId) === runtimeInput.chatId
        || isRelevantShellJob(job, stream, runtimeInput.objectiveId))
      .sort(compareJobsByRecency)
      .slice(0, 24);
    const collectedRunChains = await Promise.all(
      runIds.map((runId) => input.agentRuntime.chain(agentRunStream(stream, runId))),
    );
    const scopedRunTimeline = input.scopeRunTimelineToObjective({
      objectiveId: runtimeInput.objectiveId,
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
          runId: activeRunId!,
          runChain: runChains[activeRunIndex]!,
          relatedJobs: activeRunJobs,
          profileLabel: runtimeInput.profileLabel,
          profileId: runtimeInput.profileId,
          chatId: runtimeInput.chatId,
          objectiveId: runtimeInput.objectiveId,
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
      liveChildren: buildLiveChildCards(scopedJobs, stream, runtimeInput.objectiveId),
    };
  };

  const mergeExplicitObjectiveIntoCards = (
    objectives: ReadonlyArray<FactoryObjectiveListItem>,
    detail: FactoryObjectiveDetailRecord | undefined,
  ): ReadonlyArray<FactoryObjectiveListItem> => {
    if (!detail || objectives.some((objective) => objective.objectiveId === detail.objectiveId)) return objectives;
    return [detail, ...objectives];
  };

  const loadExplicitObjectiveContext = async (contextInput: {
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
    await input.service.ensureBootstrap();
    const repoRoot = input.service.git.repoRoot;
    const [resolved, profiles, state, detail, objectives] = await Promise.all([
      resolveFactoryChatProfile({
        repoRoot,
        profileRoot: input.profileRoot,
        requestedId: contextInput.profileId,
      }),
      input.loadFactoryProfiles(),
      input.service.getObjectiveState(contextInput.objectiveId).catch(() => undefined),
      input.service.getObjective(contextInput.objectiveId).catch((err) => {
        if (err instanceof FactoryServiceError && err.status === 404) return undefined;
        throw err;
      }),
      input.service.listObjectives(),
    ]);
    const effectiveProfileId = detail?.profile.rootProfileId ?? state?.profile.rootProfileId;
    const effectiveProfile = profiles.find((profile) => profile.id === effectiveProfileId) ?? resolved.root;
    const { jobs: objectiveJobs, selectedJob } = await collectExplicitObjectiveJobs(detail, contextInput.selectedJobId);
    const recentJobs = selectedJob && !objectiveJobs.some((job) => job.id === selectedJob.id)
      ? [selectedJob, ...objectiveJobs]
      : objectiveJobs;
    return {
      objectiveId: contextInput.objectiveId,
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

  return {
    ensureObjectiveHandoffInSession,
    collectExplicitObjectiveJobs,
    buildWorkbenchSessionRuntime,
    mergeExplicitObjectiveIntoCards,
    loadExplicitObjectiveContext,
  };
};
