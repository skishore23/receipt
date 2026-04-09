import type { QueueJob } from "../adapters/sqlite-queue";
import type {
  FactoryArtifactActivity,
  FactoryLiveOutputSnapshot,
  FactoryObjectiveDetail,
  FactoryTaskView,
} from "../services/factory-types";
import { summarizeFactoryQueueJob } from "./factory/job-presenters";

type WorkbenchEmphasis = "accent" | "warning" | "danger" | "success" | "muted";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const isTerminalJobStatus = (status?: string): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const LIVE_JOB_STALE_AFTER_MS = 90_000;

const jobProgressAt = (job: QueueJob | undefined): number | undefined => {
  const result = asRecord(job?.result);
  return typeof result?.progressAt === "number" && Number.isFinite(result.progressAt)
    ? result.progressAt
    : undefined;
};

const displayJobStatus = (job: QueueJob | undefined, fallback?: string, now = Date.now()): string | undefined => {
  if (!job) return fallback;
  if (isTerminalJobStatus(job.status)) return job.status;
  const progressAt = jobProgressAt(job);
  if (job.status === "running" && typeof progressAt === "number" && now - progressAt >= LIVE_JOB_STALE_AFTER_MS) {
    return "stalled";
  }
  if (job.status === "leased") return "running";
  return job.status;
};

const isDisplayActiveJobStatus = (status?: string): boolean =>
  status === "queued" || status === "running";

const isTerminalTaskStatus = (status: string | undefined): boolean =>
  status === "approved" || status === "blocked" || status === "integrated" || status === "superseded";

const isWorkbenchExecutionJob = (payload: Record<string, unknown>): boolean => {
  const kind = asString(payload.kind);
  return kind === "factory.task.run"
    || kind === "factory.integration.validate"
    || kind === "factory.integration.publish"
    || Boolean(asString(payload.taskId))
    || Boolean(asString(payload.candidateId));
};

const emphasisForReceipt = (type: string): WorkbenchEmphasis => {
  if (type.includes("failed") || type.includes("error")) return "danger";
  if (type.includes("blocked") || type.includes("conflicted")) return "warning";
  if (type.includes("promoted") || type.includes("ready_to_promote") || type.includes("completed")) return "success";
  if (type.includes("rebracket")) return "accent";
  return "muted";
};

const dependencySummary = (
  task: Pick<FactoryTaskView, "dependsOn" | "status">,
  titleById: ReadonlyMap<string, string>,
): string | undefined => {
  if (task.dependsOn.length === 0) return undefined;
  const labels = task.dependsOn.map((taskId) => {
    const title = titleById.get(taskId);
    return title ? `${taskId}: ${title}` : taskId;
  });
  return task.status === "pending"
    ? `Waiting on ${labels.join(", ")}`
    : `Depends on ${labels.join(", ")}`;
};

export type FactoryWorkbenchTaskCard = {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly jobStatus?: string;
  readonly workerType: string;
  readonly taskKind: string;
  readonly prompt: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly dependencySummary?: string;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly jobId?: string;
  readonly candidateId?: string;
  readonly candidateStatus?: string;
  readonly candidateSummary?: string;
  readonly candidateTokensUsed?: number;
  readonly workspaceExists: boolean;
  readonly workspaceDirty: boolean;
  readonly workspaceHead?: string;
  readonly elapsedMs?: number;
  readonly isActive: boolean;
  readonly isReady: boolean;
  readonly lastMessage?: string;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  readonly artifactSummary?: string;
  readonly artifactActivity?: ReadonlyArray<FactoryArtifactActivity>;
  readonly manifestPath?: string;
  readonly contextPackPath?: string;
  readonly promptPath?: string;
  readonly memoryScriptPath?: string;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
  readonly lastMessagePath?: string;
};

export type FactoryWorkbenchJobCard = {
  readonly jobId: string;
  readonly agentId: string;
  readonly status: string;
  readonly summary: string;
  readonly updatedAt?: number;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly running: boolean;
};

export type FactoryWorkbenchActivityItem = {
  readonly id: string;
  readonly kind: "decision" | "activity" | "receipt";
  readonly title: string;
  readonly summary: string;
  readonly meta: string;
  readonly at?: number;
  readonly emphasis: WorkbenchEmphasis;
};

export type FactoryWorkbenchFocus = {
  readonly focusKind: "task" | "job";
  readonly focusId: string;
  readonly title: string;
  readonly status: string;
  readonly active: boolean;
  readonly summary?: string;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly jobId?: string;
  readonly updatedAt?: number;
  readonly lastMessage?: string;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  readonly artifactSummary?: string;
  readonly artifactActivity?: ReadonlyArray<FactoryArtifactActivity>;
};

export type FactoryWorkbenchSummary = {
  readonly objectiveId: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly phaseDetail?: string;
  readonly statusAuthority?: string;
  readonly integrationStatus: string;
  readonly slotState: string;
  readonly queuePosition?: number;
  readonly activeTaskCount: number;
  readonly readyTaskCount: number;
  readonly taskCount: number;
  readonly activeJobCount: number;
  readonly elapsedMinutes: number;
  readonly tokensUsed?: number;
  readonly checks: ReadonlyArray<string>;
  readonly checksCount: number;
  readonly nextAction?: string;
  readonly latestDecisionSummary?: string;
  readonly latestDecisionAt?: number;
};

export type FactoryWorkbenchModel = {
  readonly summary: FactoryWorkbenchSummary;
  readonly tasks: ReadonlyArray<FactoryWorkbenchTaskCard>;
  readonly jobs: ReadonlyArray<FactoryWorkbenchJobCard>;
  readonly focus?: FactoryWorkbenchFocus;
  readonly focusedTask?: FactoryWorkbenchTaskCard;
  readonly activity: ReadonlyArray<FactoryWorkbenchActivityItem>;
  readonly hasActiveExecution: boolean;
};

export const buildFactoryWorkbench = (input: {
  readonly detail?: FactoryObjectiveDetail;
  readonly recentJobs?: ReadonlyArray<QueueJob>;
  readonly requestedFocusKind?: string;
  readonly requestedFocusId?: string;
  readonly liveOutput?: FactoryLiveOutputSnapshot;
  readonly now?: number;
}): FactoryWorkbenchModel | undefined => {
  const detail = input.detail;
  if (!detail) return undefined;
  const now = input.now ?? Date.now();
  const stoppedTaskStatus = detail.status === "canceled"
    ? "canceled"
    : detail.status === "failed"
      ? "failed"
      : detail.status === "completed"
        ? "completed"
        : "blocked";
  const objectiveStopsLiveExecution =
    detail.status === "blocked"
    || detail.status === "failed"
    || detail.status === "canceled"
    || detail.status === "completed";
  const titleById = new Map(detail.tasks.map((task) => [task.taskId, task.title] as const));
  const tasks = detail.tasks.map((task) => {
    const effectiveJobStatus = displayJobStatus(task.job, task.jobStatus, now);
    const taskLooksActive = effectiveJobStatus === "stalled"
      ? false
      : task.status === "running" || task.status === "reviewing" || isDisplayActiveJobStatus(effectiveJobStatus);
    const stoppedMidTask = objectiveStopsLiveExecution && taskLooksActive;
    const effectiveStatus = stoppedMidTask ? stoppedTaskStatus : (effectiveJobStatus ?? task.status);
    const effectiveBlockedReason = stoppedMidTask
      ? detail.blockedReason ?? task.blockedReason ?? detail.latestSummary
      : task.blockedReason;
    return ({
    taskId: task.taskId,
    title: task.title,
    status: effectiveStatus,
    jobStatus: task.jobStatus,
    workerType: task.workerType,
    taskKind: task.taskKind,
    prompt: task.prompt,
    dependsOn: task.dependsOn,
    dependencySummary: dependencySummary(task, titleById),
    latestSummary: task.latestSummary,
    blockedReason: effectiveBlockedReason,
    jobId: task.jobId,
    candidateId: task.candidateId,
    candidateStatus: task.candidate?.status,
    candidateSummary: task.candidate?.summary,
    candidateTokensUsed: task.candidate?.tokensUsed,
    workspaceExists: task.workspaceExists,
    workspaceDirty: task.workspaceDirty,
    workspaceHead: task.workspaceHead,
    elapsedMs: task.elapsedMs,
    isActive: !objectiveStopsLiveExecution && taskLooksActive,
    isReady: !objectiveStopsLiveExecution && task.status === "ready",
    lastMessage: task.lastMessage,
    stdoutTail: task.stdoutTail,
    stderrTail: task.stderrTail,
    artifactSummary: task.artifactSummary,
    artifactActivity: task.artifactActivity,
    manifestPath: task.manifestPath,
    contextPackPath: task.contextPackPath,
    promptPath: task.promptPath,
    memoryScriptPath: task.memoryScriptPath,
    stdoutPath: task.stdoutPath,
    stderrPath: task.stderrPath,
    lastMessagePath: task.lastMessagePath,
  } satisfies FactoryWorkbenchTaskCard);
  });
  const taskById = new Map(tasks.map((task) => [task.taskId, task] as const));
  const jobs = (input.recentJobs ?? []).flatMap((job) => {
    const payload = asRecord(job.payload) ?? {};
    if (!isWorkbenchExecutionJob(payload)) return [];
    const taskId = asString(payload.taskId);
    const linkedTask = taskId ? taskById.get(taskId) : undefined;
    const linkedTaskTerminal = linkedTask ? isTerminalTaskStatus(linkedTask.status) : false;
    const displayStatus = displayJobStatus(job, job.status, now) ?? job.status;
    const running = !objectiveStopsLiveExecution && !linkedTaskTerminal && isDisplayActiveJobStatus(displayStatus);
    const effectiveStatus = running
      ? displayStatus
      : linkedTask?.status
        ?? (objectiveStopsLiveExecution && !isTerminalJobStatus(job.status) ? detail.status : displayStatus);
    return [{
      jobId: job.id,
      agentId: job.agentId,
      status: effectiveStatus,
      summary: summarizeFactoryQueueJob(job),
      updatedAt: job.updatedAt,
      taskId,
      candidateId: asString(payload.candidateId),
      running,
    } satisfies FactoryWorkbenchJobCard];
  });
  const defaultTask = tasks.find((task) => task.isActive) ?? tasks.find((task) => task.isReady) ?? tasks[0];
  const requestedFocusKind = input.requestedFocusKind === "job" || input.requestedFocusKind === "task"
    ? input.requestedFocusKind
    : undefined;
  const requestedFocusId = input.requestedFocusId?.trim();
  let focusedTask = requestedFocusKind === "task" && requestedFocusId ? taskById.get(requestedFocusId) : undefined;
  let focusedJob = requestedFocusKind === "job" && requestedFocusId
    ? jobs.find((job) => job.jobId === requestedFocusId)
    : undefined;
  if (!focusedTask && !focusedJob && defaultTask) {
    focusedTask = defaultTask;
  }
  if (!focusedTask && input.liveOutput?.taskId) {
    focusedTask = taskById.get(input.liveOutput.taskId);
  }
  const output = input.liveOutput;
  const preferTaskTerminalState = objectiveStopsLiveExecution && Boolean(focusedTask);
  const focusedTaskStatus = focusedTask
    ? preferTaskTerminalState
      ? (focusedTask.status ?? focusedTask.jobStatus ?? output?.status)
      : output?.status
        ?? focusedTask.status
      ?? focusedTask.jobStatus
    : undefined;
  const focusedTaskSummary = focusedTask
    ? preferTaskTerminalState
      ? (
        focusedTaskStatus === "blocked"
        || focusedTaskStatus === "failed"
        || focusedTaskStatus === "canceled"
        || focusedTaskStatus === "completed"
          ? focusedTask.blockedReason ?? focusedTask.latestSummary ?? focusedTask.candidateSummary ?? output?.summary
          : focusedTask.latestSummary ?? focusedTask.candidateSummary ?? output?.summary
      )
      : output?.summary
        ?? (
          focusedTaskStatus === "blocked"
          || focusedTaskStatus === "failed"
          || focusedTaskStatus === "canceled"
          || focusedTaskStatus === "completed"
            ? focusedTask.blockedReason ?? focusedTask.latestSummary ?? focusedTask.candidateSummary
            : focusedTask.latestSummary ?? focusedTask.candidateSummary
        )
    : undefined;
  const focus = focusedTask
    ? {
        focusKind: focusedJob ? "job" : "task",
        focusId: focusedJob?.jobId ?? focusedTask.taskId,
        title: focusedTask.title,
        status: focusedTaskStatus ?? focusedTask.status ?? focusedTask.jobStatus ?? "pending",
        active: output?.active ?? focusedTask.isActive,
        summary: focusedTaskSummary ?? focusedTask.blockedReason ?? focusedTask.latestSummary ?? focusedTask.candidateSummary,
        taskId: focusedTask.taskId,
        candidateId: output?.candidateId ?? focusedTask.candidateId,
        jobId: output?.jobId ?? focusedTask.jobId ?? focusedJob?.jobId,
        updatedAt: focusedJob?.updatedAt,
        lastMessage: output?.lastMessage ?? focusedTask.lastMessage,
        stdoutTail: output?.stdoutTail ?? focusedTask.stdoutTail,
        stderrTail: output?.stderrTail ?? focusedTask.stderrTail,
        artifactSummary: output?.artifactSummary ?? focusedTask.artifactSummary,
        artifactActivity: output?.artifactActivity ?? focusedTask.artifactActivity,
      } satisfies FactoryWorkbenchFocus
      : focusedJob
      ? {
          focusKind: "job",
          focusId: focusedJob.jobId,
          title: output?.title ?? `Job ${focusedJob.jobId}`,
          status: output?.status ?? focusedJob.status,
          active: output?.active ?? focusedJob.running,
          summary: output?.summary ?? focusedJob.summary,
          taskId: output?.taskId,
          candidateId: output?.candidateId ?? focusedJob.candidateId,
          jobId: focusedJob.jobId,
          updatedAt: focusedJob.updatedAt,
          lastMessage: output?.lastMessage,
          stdoutTail: output?.stdoutTail,
          stderrTail: output?.stderrTail,
          artifactSummary: output?.artifactSummary,
          artifactActivity: output?.artifactActivity,
        } satisfies FactoryWorkbenchFocus
      : undefined;
  const elapsedMinutes = typeof detail.budgetState.elapsedMinutes === "number"
    ? detail.budgetState.elapsedMinutes
    : Math.max(0, Math.floor((now - detail.createdAt) / 60_000));
  const activity = [
    ...(detail.latestDecision
      ? [{
          id: `decision:${detail.latestDecision.at}`,
          kind: "decision",
          title: "Latest decision",
          summary: detail.latestDecision.summary,
          meta: detail.latestDecision.source,
          at: detail.latestDecision.at,
          emphasis: "accent",
        } satisfies FactoryWorkbenchActivityItem]
      : []),
    ...detail.activity.map((entry) => ({
      id: `activity:${entry.kind}:${entry.at}:${entry.title}`,
      kind: "activity",
      title: entry.title,
      summary: entry.summary,
      meta: [entry.kind, entry.taskId, entry.candidateId].filter(Boolean).join(" · "),
      at: entry.at,
      emphasis: entry.kind === "job" ? "accent" : "muted",
    } satisfies FactoryWorkbenchActivityItem)),
    ...detail.recentReceipts.map((receipt) => ({
      id: `receipt:${receipt.hash}`,
      kind: "receipt",
      title: receipt.type,
      summary: receipt.summary,
      meta: [receipt.taskId, receipt.candidateId].filter(Boolean).join(" · "),
      at: receipt.ts,
      emphasis: emphasisForReceipt(receipt.type),
    } satisfies FactoryWorkbenchActivityItem)),
  ]
    .sort((left, right) => (right.at ?? 0) - (left.at ?? 0))
    .slice(0, 8);
  return {
    summary: {
      objectiveId: detail.objectiveId,
      title: detail.title,
      status: detail.status,
      phase: detail.phase,
      phaseDetail: detail.phaseDetail,
      statusAuthority: detail.statusAuthority,
      integrationStatus: detail.integration.status,
      slotState: detail.scheduler.slotState,
      queuePosition: detail.scheduler.queuePosition,
      activeTaskCount: detail.activeTaskCount,
      readyTaskCount: detail.readyTaskCount,
      taskCount: detail.taskCount,
      activeJobCount: jobs.filter((job) => job.running).length,
      elapsedMinutes,
      tokensUsed: detail.tokensUsed,
      checks: detail.checks,
      checksCount: detail.checks.length,
      nextAction: detail.nextAction,
      latestDecisionSummary: detail.latestDecision?.summary,
      latestDecisionAt: detail.latestDecision?.at,
    },
    tasks,
    jobs,
    focus,
    focusedTask,
    activity,
    hasActiveExecution: tasks.some((task) => task.isActive) || jobs.some((job) => job.running),
  };
};
