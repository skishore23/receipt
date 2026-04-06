import { createHash } from "node:crypto";

import type { Receipt } from "@receipt/core/types";
import type { Runtime } from "@receipt/core/runtime";

import { makeEventId, optionalTrimmedString } from "../../../framework/http";
import { agentRunStream } from "../../agent.streams";
import type { AgentCmd, AgentEvent, AgentState } from "../../../modules/agent";
import type { JobRecord } from "../../../modules/job";
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
import { renderObjectiveHandoffMessage } from "../chat-items";
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

type FactoryObjectiveListItem = Awaited<ReturnType<FactoryService["listObjectives"]>>[number];
type FactoryObjectiveDetailRecord = Awaited<ReturnType<FactoryService["getObjective"]>>;
type FactoryObjectiveStateRecord = Awaited<ReturnType<FactoryService["getObjectiveState"]>>;

type ObjectiveHandoffPresence = {
  readonly problem: boolean;
  readonly binding: boolean;
  readonly handoff: boolean;
  readonly finalized: boolean;
  readonly status: boolean;
};

const hasCompleteObjectiveHandoff = (presence: ObjectiveHandoffPresence): boolean =>
  presence.problem
  && presence.binding
  && presence.handoff
  && presence.finalized
  && presence.status;

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
    const handoff = buildObjectiveHandoffPayload(handoffInput.objective);
    if (!handoff) return;
    const renderedHandoff = renderObjectiveHandoffMessage(handoff);
    const sessionStream = factoryChatSessionStream(input.service.git.repoRoot, handoffInput.profileId, handoffInput.chatId);
    const sessionChain = await input.agentRuntime.chain(sessionStream);
    const latestSessionHandoff = [...sessionChain].reverse().find((receipt) =>
      receipt.body.type === "objective.handoff"
      && receipt.body.objectiveId === handoff.objectiveId,
    )?.body;
    const runStream = agentRunStream(sessionStream, handoff.runId);
    const runChain = await input.agentRuntime.chain(runStream);
    const collectPresence = (
      chain: ReadonlyArray<Receipt<AgentEvent>>,
      streamType: "session" | "run",
    ): ObjectiveHandoffPresence => ({
      problem: chain.some((receipt) =>
        receipt.body.type === "problem.set"
        && receipt.body.runId === handoff.runId,
      ),
      binding: chain.some((receipt) =>
        receipt.body.type === "thread.bound"
        && receipt.body.runId === handoff.runId
        && receipt.body.objectiveId === handoff.objectiveId
        && receipt.body.chatId === handoffInput.chatId,
      ),
      handoff: streamType === "session"
        ? latestSessionHandoff?.type === "objective.handoff"
          && latestSessionHandoff.handoffKey === handoff.handoffKey
        : chain.some((receipt) =>
          receipt.body.type === "objective.handoff"
          && receipt.body.handoffKey === handoff.handoffKey
        ),
      finalized: chain.some((receipt) =>
        receipt.body.type === "response.finalized"
        && receipt.body.runId === handoff.runId,
      ),
      status: chain.some((receipt) =>
        receipt.body.type === "run.status"
        && receipt.body.runId === handoff.runId
        && receipt.body.status === "completed",
      ),
    });
    const runPresence = collectPresence(runChain, "run");
    const sessionPresence = collectPresence(sessionChain, "session");
    if (hasCompleteObjectiveHandoff(sessionPresence) && hasCompleteObjectiveHandoff(runPresence)) {
      return;
    }
    const problemEvent: Extract<AgentEvent, { readonly type: "problem.set" }> = {
      type: "problem.set",
      runId: handoff.runId,
      agentId: "orchestrator",
      problem: `Objective handoff for ${handoff.title}`,
    };
    const threadBoundEvent: Extract<AgentEvent, { readonly type: "thread.bound" }> = {
      type: "thread.bound",
      runId: handoff.runId,
      agentId: "orchestrator",
      objectiveId: handoff.objectiveId,
      chatId: handoffInput.chatId,
      reason: "dispatch_update",
    };
    const finalEvent: Extract<AgentEvent, { readonly type: "response.finalized" }> = {
      type: "response.finalized",
      runId: handoff.runId,
      agentId: "orchestrator",
      content: renderedHandoff.body,
    };
    const statusEvent: Extract<AgentEvent, { readonly type: "run.status" }> = {
      type: "run.status",
      runId: handoff.runId,
      agentId: "orchestrator",
      status: "completed",
      note: `objective ${handoff.status} handoff`,
    };
    const buildMissingEvents = (presence: ObjectiveHandoffPresence): AgentEvent[] => [
      ...(!presence.problem ? [problemEvent] : []),
      ...(!presence.binding ? [threadBoundEvent] : []),
      ...(!presence.handoff ? [handoff] : []),
      ...(!presence.finalized ? [finalEvent] : []),
      ...(!presence.status ? [statusEvent] : []),
    ];
    const emitMissingEvents = async (
      stream: string,
      events: ReadonlyArray<AgentEvent>,
    ): Promise<void> => {
      for (const event of events) {
        await input.agentRuntime.execute(stream, {
          type: "emit",
          eventId: makeEventId(stream),
          event,
        });
      }
    };
    const runEvents = buildMissingEvents(runPresence);
    const sessionEvents = buildMissingEvents(sessionPresence);
    if (runEvents.length > 0) await emitMissingEvents(runStream, runEvents);
    if (sessionEvents.length > 0) await emitMissingEvents(sessionStream, sessionEvents);
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
