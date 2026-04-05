import type { AgentLoaderContext } from "../../../framework/agent-types";
import { resolveFactoryChatProfile } from "../../../services/factory-chat-profiles";
import { isRelevantShellJob, jobParentRunId, jobRunId, type AgentRunChain } from "../shared";
import { collectRunLineageIds, jobMatchesRunIds } from "../live-jobs";
import { resolveChatViewStream } from "../links";
import type { QueueJob } from "../../../adapters/jsonl-queue";
import type { FactoryService } from "../../../services/factory-service";

export const createFactoryRouteEvents = (input: {
  readonly ctx: AgentLoaderContext;
  readonly service: FactoryService;
  readonly profileRoot: string;
  readonly loadRecentJobs: (limit?: number) => Promise<ReadonlyArray<QueueJob>>;
  readonly resolveSessionObjectiveId: (input: {
    readonly repoRoot: string;
    readonly profileId: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly selectedJob?: QueueJob;
    readonly jobs: ReadonlyArray<QueueJob>;
  }) => Promise<string | undefined>;
}) => {
  const resolveChatEventSubscriptions = async (inputEvent: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
  }): Promise<{
    readonly profileId: string;
    readonly stream?: string;
    readonly objectiveId?: string;
    readonly jobIds: ReadonlyArray<string>;
  }> => {
    const profile = await resolveFactoryChatProfile({
      repoRoot: input.service.git.repoRoot,
      profileRoot: input.profileRoot,
      requestedId: inputEvent.profileId,
    });
    const jobs = await input.loadRecentJobs();
    const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
    const selectedJob = inputEvent.jobId ? jobsById.get(inputEvent.jobId) : undefined;
    const resolvedObjectiveId = await input.resolveSessionObjectiveId({
      repoRoot: input.service.git.repoRoot,
      profileId: profile.root.id,
      chatId: inputEvent.chatId,
      objectiveId: inputEvent.objectiveId,
      selectedJob,
      jobs,
    });
    const stream = resolveChatViewStream({
      repoRoot: input.service.git.repoRoot,
      profileId: profile.root.id,
      chatId: inputEvent.chatId,
      objectiveId: resolvedObjectiveId,
      job: selectedJob,
    });
    const baseQueueJobs = stream
      ? jobs.filter((job) => isRelevantShellJob(job, stream, resolvedObjectiveId))
      : [];
    const selectedRunIds = collectRunLineageIds(
      [
        inputEvent.runId,
        selectedJob ? jobRunId(selectedJob) : undefined,
        selectedJob ? jobParentRunId(selectedJob) : undefined,
      ],
      new Map<string, AgentRunChain>(),
      baseQueueJobs,
    );
    const scopedJobs = selectedRunIds.size > 0 || inputEvent.jobId
      ? baseQueueJobs.filter((job) => job.id === inputEvent.jobId || jobMatchesRunIds(job, selectedRunIds))
      : baseQueueJobs.slice(0, 16);
    return {
      profileId: profile.root.id,
      stream,
      objectiveId: resolvedObjectiveId,
      jobIds: [...new Set([
        ...scopedJobs.map((job) => job.id),
        ...(inputEvent.jobId ? [inputEvent.jobId] : []),
      ])],
    };
  };

  const subscribeChatEventStream = (
    body: {
      readonly profileId: string;
      readonly stream?: string;
      readonly objectiveId?: string;
      readonly jobIds: ReadonlyArray<string>;
    },
    signal: AbortSignal,
  ): Response => input.ctx.sse.subscribeMany([
    ...(body.stream ? [{ topic: "agent" as const, stream: body.stream }] : []),
    { topic: "profile-board" as const, stream: body.profileId },
    ...(body.objectiveId ? [{ topic: "factory" as const, stream: body.objectiveId }] : []),
    ...(body.objectiveId ? [{ topic: "objective-runtime" as const, stream: body.objectiveId }] : []),
    ...body.jobIds.map((jobId) => ({ topic: "jobs" as const, stream: jobId })),
  ], signal);

  return {
    resolveChatEventSubscriptions,
    subscribeChatEventStream,
  };
};
