import type { JsonlQueue, QueueJob } from "../adapters/jsonl-queue";
import type { FactoryObjectiveInput, FactoryService } from "../services/factory-service";
import { factoryChatCodexArtifactPaths, readTextTail } from "../services/factory-codex-artifacts";
import { summarizeFactoryObjective } from "../views/factory/objective-presenters";
import { buildFactoryQueueJobSnapshot } from "../views/factory/job-presenters";
import {
  runAgent,
  type AgentFinalizer,
  type AgentRunInput,
  type AgentRunResult,
} from "./agent";
import {
  createCapabilitySpec,
  codexLogsCapability,
  codexRunCapability,
  codexStatusCapability,
  factoryDispatchCapability,
  factoryOutputCapability,
  factoryStatusCapability,
  jobsListCapability,
  repoStatusCapability,
  type AgentToolExecutor,
} from "./capabilities";
import {
  clampWaitMs,
  combineFinalizers,
  createLiveFactoryFinalizer,
  createRepoStatusTool,
  deriveObjectiveTitle,
  effectiveFactoryLiveWaitMs,
  isActiveJobStatus,
  waitForSnapshotChange,
  type FactoryLiveWaitState,
} from "./orchestration-utils";
import {
  isObjectiveContinuationBoundary,
  normalizeFactoryDispatchInput,
  resolveFactoryDispatchAction,
} from "./factory/dispatch";

export const CODEX_SUPERVISOR_WORKFLOW_ID = "agent-codex-supervisor-v1";
export const CODEX_SUPERVISOR_WORKFLOW_VERSION = "1.0.0";

const DIRECT_WORKSPACE_TOOLS = new Set(["ls", "read", "replace", "write", "bash", "grep", "agent.delegate"]);

export const CODEX_SUPERVISOR_TOOL_ALLOWLIST = [
  "memory.read",
  "memory.search",
  "memory.summarize",
  "agent.status",
  "agent.inspect",
  "jobs.list",
  "repo.status",
  "codex.logs",
  "codex.status",
  "codex.run",
  "factory.dispatch",
  "factory.status",
  "factory.output",
  "skill.read",
] as const;

export type CodexSupervisorRunInput = AgentRunInput & {
  readonly queue: JsonlQueue;
  readonly supervisorSessionId?: string;
  readonly dataDir?: string;
  readonly factoryService?: FactoryService;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asStringList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values.filter((value) => value.trim().length > 0))];

const stableCodexSessionKey = (supervisorSessionId: string): string =>
  `codex:${supervisorSessionId}`;

const latestActiveCodexJob = async (queue: JsonlQueue, input: {
  readonly runId: string;
  readonly stream: string;
  readonly supervisorSessionId: string;
}): Promise<QueueJob | undefined> =>
  (await listSupervisorJobs(queue, input))
    .filter((job) => job.agentId === "codex" && isActiveJobStatus(job.status))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];

const readCodexArtifacts = async (dataDir: string, jobId: string): Promise<{
  readonly artifacts: ReturnType<typeof factoryChatCodexArtifactPaths>;
  readonly lastMessage?: string;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
}> => {
  const artifacts = factoryChatCodexArtifactPaths(dataDir, jobId);
  const [lastMessage, stdoutTail, stderrTail] = await Promise.all([
    readTextTail(artifacts.lastMessagePath, 400),
    readTextTail(artifacts.stdoutPath, 900),
    readTextTail(artifacts.stderrPath, 600),
  ]);
  return {
    artifacts,
    lastMessage,
    stdoutTail,
    stderrTail,
  };
};

const normalizeJobSnapshot = (job: QueueJob): Record<string, unknown> => {
  const base = buildFactoryQueueJobSnapshot(job);
  return {
    ...base,
    supervisorSessionId: asString(job.payload.supervisorSessionId),
  };
};

const codexJobSnapshot = async (job: QueueJob, dataDir?: string): Promise<Record<string, unknown>> => {
  const base = normalizeJobSnapshot(job);
  if (job.agentId !== "codex" || !dataDir) return base;
  const artifactSnapshot = await readCodexArtifacts(dataDir, job.id);
  return {
    ...base,
    artifacts: artifactSnapshot.artifacts,
    lastMessage: artifactSnapshot.lastMessage ?? base.lastMessage,
    stdoutTail: artifactSnapshot.stdoutTail ?? base.stdoutTail,
    stderrTail: artifactSnapshot.stderrTail ?? base.stderrTail,
  };
};

const jobMatchesSupervisor = (
  job: QueueJob,
  input: {
    readonly runId: string;
    readonly stream: string;
    readonly supervisorSessionId: string;
  },
): boolean => {
  const payloadSupervisorSessionId = asString(job.payload.supervisorSessionId);
  const parentRunId = asString(job.payload.parentRunId);
  const parentStream = asString(job.payload.parentStream);
  return payloadSupervisorSessionId === input.supervisorSessionId
    || parentRunId === input.runId
    || parentStream === input.stream;
};

const listSupervisorJobs = async (
  queue: JsonlQueue,
  input: {
    readonly runId: string;
    readonly stream: string;
    readonly supervisorSessionId: string;
  },
): Promise<ReadonlyArray<QueueJob>> => {
  const jobs = await queue.listJobs({ limit: 200 });
  return jobs.filter((job) => jobMatchesSupervisor(job, input));
};

const createCodexRunTool = (input: {
  readonly queue: JsonlQueue;
  readonly runId: string;
  readonly stream: string;
  readonly supervisorSessionId: string;
  readonly dataDir?: string;
}): AgentToolExecutor =>
  async (toolInput) => {
    const prompt = asString(toolInput.prompt) ?? asString(toolInput.task);
    if (!prompt) throw new Error("codex.run requires prompt");
    const existing = await latestActiveCodexJob(input.queue, input);
    if (existing) {
      const snapshot = await codexJobSnapshot(existing, input.dataDir);
      const result: Record<string, unknown> = {
        ...snapshot,
        worker: "codex",
        mode: "read_only_probe",
        readOnly: true,
        summary: `reusing active codex probe ${existing.id}`,
      };
      return {
        output: JSON.stringify(result, null, 2),
        summary: String(result.summary),
      };
    }
    const timeoutMs = typeof toolInput.timeoutMs === "number" && Number.isFinite(toolInput.timeoutMs)
      ? Math.max(30_000, Math.min(Math.floor(toolInput.timeoutMs), 900_000))
      : 180_000;
    const created = await input.queue.enqueue({
      agentId: "codex",
      lane: "collect",
      sessionKey: stableCodexSessionKey(input.supervisorSessionId),
      singletonMode: "steer",
      maxAttempts: 1,
      payload: {
        kind: "codex.run",
        parentRunId: input.runId,
        parentStream: input.stream,
        supervisorSessionId: input.supervisorSessionId,
        stream: input.stream,
        mode: "read_only_probe",
        readOnly: true,
        task: prompt,
        prompt,
        timeoutMs,
      },
    });
    const result: Record<string, unknown> = {
      ...(await codexJobSnapshot(created, input.dataDir)),
      worker: "codex",
      mode: "read_only_probe",
      readOnly: true,
      summary: `codex read-only probe queued as ${created.id}`,
    };
    return {
      output: JSON.stringify(result, null, 2),
      summary: String(result.summary),
    };
  };

const createCodexStatusTool = (input: {
  readonly queue: JsonlQueue;
  readonly runId: string;
  readonly stream: string;
  readonly supervisorSessionId: string;
  readonly dataDir?: string;
}): AgentToolExecutor =>
  async (toolInput) => {
    const waitForChangeMs = clampWaitMs(toolInput.waitForChangeMs);
    const buildStatus = async (): Promise<Record<string, unknown>> => {
      const jobId = asString(toolInput.jobId);
      if (jobId) {
        const job = await input.queue.getJob(jobId);
        if (!job) throw new Error(`job ${jobId} not found`);
        if (job.agentId !== "codex") throw new Error(`job ${jobId} is not a codex job`);
        const snapshot = await codexJobSnapshot(job, input.dataDir);
        return {
          worker: "codex",
          activeCount: isActiveJobStatus(job.status) ? 1 : 0,
          latest: snapshot,
          jobs: [snapshot],
        };
      }

      const limit = typeof toolInput.limit === "number" && Number.isFinite(toolInput.limit)
        ? Math.max(1, Math.min(Math.floor(toolInput.limit), 10))
        : 5;
      const includeCompleted = toolInput.includeCompleted === true;
      const sessionJobs = (await listSupervisorJobs(input.queue, input))
        .filter((job) => job.agentId === "codex")
        .sort((left, right) =>
          Number(isActiveJobStatus(right.status)) - Number(isActiveJobStatus(left.status))
          || right.updatedAt - left.updatedAt
        );
      const selectedJobs = includeCompleted
        ? sessionJobs
        : (() => {
          const activeJobs = sessionJobs.filter((job) => isActiveJobStatus(job.status));
          return activeJobs.length > 0 ? activeJobs : sessionJobs;
        })();
      const snapshots = await Promise.all(selectedJobs.slice(0, limit).map((job) => codexJobSnapshot(job, input.dataDir)));
      return {
        worker: "codex",
        activeCount: sessionJobs.filter((job) => isActiveJobStatus(job.status)).length,
        latest: snapshots[0],
        jobs: snapshots,
      };
    };
    const initial = await buildStatus();
    const waited = waitForChangeMs > 0 && Number(initial.activeCount ?? 0) > 0
      ? await waitForSnapshotChange(initial, waitForChangeMs, buildStatus)
      : { value: initial, waitedMs: 0, changed: false };
    const payload = waited.waitedMs > 0
      ? { ...waited.value, waitedMs: waited.waitedMs, changed: waited.changed }
      : waited.value;
    const snapshots = Array.isArray(payload.jobs)
      ? payload.jobs as ReadonlyArray<Record<string, unknown>>
      : [];
    return {
      output: JSON.stringify(payload, null, 2),
      summary: snapshots[0]
        ? `codex ${String(snapshots[0].jobId)}: ${String(snapshots[0].status)}${waited.waitedMs > 0 ? ` after waiting ${waited.waitedMs}ms` : ""}`
        : "0 codex jobs",
      pauseBudget: waited.waitedMs > 0 && waited.changed === false,
    };
  };

const createCodexLogsTool = (input: {
  readonly queue: JsonlQueue;
  readonly runId: string;
  readonly stream: string;
  readonly supervisorSessionId: string;
  readonly dataDir: string;
}): AgentToolExecutor =>
  async (toolInput) => {
    const requestedJobId = asString(toolInput.jobId);
    let job = requestedJobId ? await input.queue.getJob(requestedJobId) : undefined;
    if (requestedJobId && !job) throw new Error(`job ${requestedJobId} not found`);
    if (!job) {
      job = (await listSupervisorJobs(input.queue, input))
        .filter((candidate) => candidate.agentId === "codex")
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    }
    if (!job) throw new Error("no codex child jobs found for this agent session");
    if (job.agentId !== "codex") throw new Error(`job ${job.id} is not a codex job`);
    const snapshot = await codexJobSnapshot(job, input.dataDir);
    return {
      output: JSON.stringify({
        worker: "codex",
        action: "logs",
        ...snapshot,
      }, null, 2),
      summary: `codex logs ${job.id}: ${String(snapshot.status ?? job.status)}`,
    };
  };

const createJobsListTool = (input: {
  readonly queue: JsonlQueue;
  readonly runId: string;
  readonly stream: string;
  readonly supervisorSessionId: string;
}): AgentToolExecutor =>
  async (toolInput) => {
    const limit = typeof toolInput.limit === "number" && Number.isFinite(toolInput.limit)
      ? Math.max(1, Math.min(Math.floor(toolInput.limit), 20))
      : 10;
    const includeCompleted = toolInput.includeCompleted === true;
    const statusFilter = asString(toolInput.status);
    const jobs = (await listSupervisorJobs(input.queue, input))
      .filter((job) => includeCompleted || isActiveJobStatus(job.status))
      .filter((job) => !statusFilter || job.status === statusFilter)
      .slice(0, limit)
      .map((job) => normalizeJobSnapshot(job));
    return {
      output: JSON.stringify(jobs, null, 2),
      summary: `${jobs.length} jobs`,
    };
  };

const latestObjectiveByRun = new Map<string, string>();

const createFactoryDispatchTool = (input: {
  readonly factoryService: FactoryService;
  readonly runId: string;
  readonly getCurrentObjectiveId: () => string | undefined;
}): AgentToolExecutor =>
  async (toolInput) => {
    const normalized = normalizeFactoryDispatchInput(toolInput);
    const objectiveId = normalized.objectiveId ?? input.getCurrentObjectiveId();
    const currentObjective = objectiveId
      ? await input.factoryService.getObjective(objectiveId).catch(() => undefined)
      : undefined;
    let action = resolveFactoryDispatchAction(normalized, objectiveId);
    let detail: Awaited<ReturnType<FactoryService["getObjective"]>>;
    if (action === "create") {
      const prompt = normalized.prompt;
      if (!prompt) throw new Error("factory.dispatch create requires prompt");
      const payload: FactoryObjectiveInput = {
        title: normalized.title ?? deriveObjectiveTitle(prompt),
        prompt,
        baseHash: normalized.baseHash,
        objectiveMode: normalized.objectiveMode ?? currentObjective?.objectiveMode,
        severity: normalized.severity ?? currentObjective?.severity,
        checks: normalized.checks,
        channel: normalized.channel,
        profileId: normalized.profileId,
        startImmediately: true,
      };
      detail = await input.factoryService.createObjective(payload);
    } else if (action === "react") {
      if (!objectiveId) throw new Error("factory.dispatch react requires objectiveId");
      const followUpPrompt = normalized.note ?? normalized.prompt;
      if (currentObjective && isObjectiveContinuationBoundary(currentObjective)) {
        if (!followUpPrompt) {
          throw new Error("factory.dispatch react on a completed objective requires note or prompt to create a follow-up objective");
        }
        detail = await input.factoryService.createObjective({
          title: normalized.title ?? deriveObjectiveTitle(followUpPrompt),
          prompt: followUpPrompt,
          baseHash: normalized.baseHash,
          objectiveMode: normalized.objectiveMode ?? currentObjective.objectiveMode,
          severity: normalized.severity ?? currentObjective.severity,
          checks: normalized.checks,
          channel: normalized.channel,
          profileId: normalized.profileId,
          startImmediately: true,
        });
        action = "create";
      } else if (followUpPrompt) {
        detail = await input.factoryService.reactObjectiveWithNote(objectiveId, followUpPrompt);
      } else {
        await input.factoryService.reactObjective(objectiveId);
        detail = await input.factoryService.getObjective(objectiveId);
      }
    } else if (action === "promote") {
      if (!objectiveId) throw new Error("factory.dispatch promote requires objectiveId");
      detail = await input.factoryService.promoteObjective(objectiveId);
    } else if (action === "cancel") {
      if (!objectiveId) throw new Error("factory.dispatch cancel requires objectiveId");
      detail = await input.factoryService.cancelObjective(objectiveId, normalized.reason);
    } else if (action === "cleanup") {
      if (!objectiveId) throw new Error("factory.dispatch cleanup requires objectiveId");
      detail = await input.factoryService.cleanupObjectiveWorkspaces(objectiveId);
    } else if (action === "archive") {
      if (!objectiveId) throw new Error("factory.dispatch archive requires objectiveId");
      detail = await input.factoryService.archiveObjective(objectiveId);
    } else {
      throw new Error(`unsupported factory.dispatch action '${action}'`);
    }
    const summary = summarizeFactoryObjective(detail);
    if (detail.archivedAt || detail.status === "completed") {
      latestObjectiveByRun.delete(input.runId);
    } else {
      latestObjectiveByRun.set(input.runId, detail.objectiveId);
    }
    return {
      output: JSON.stringify({
        worker: "factory",
        action,
        reused: false,
        ...summary,
      }, null, 2),
      summary: summary.summary,
    };
  };

const createFactoryStatusTool = (input: {
  readonly factoryService: FactoryService;
  readonly liveWaitState: FactoryLiveWaitState;
  readonly getCurrentObjectiveId: () => string | undefined;
}): AgentToolExecutor =>
  async (toolInput) => {
    const objectiveId = asString(toolInput.objectiveId) ?? input.getCurrentObjectiveId();
    if (!objectiveId) throw new Error("factory.status requires objectiveId");
    const requestedWaitMs = clampWaitMs(toolInput.waitForChangeMs);
    const buildStatus = async (): Promise<Record<string, unknown>> => {
      const [detail, debug] = await Promise.all([
        input.factoryService.getObjective(objectiveId),
        input.factoryService.getObjectiveDebug(objectiveId),
      ]);
      const summary = summarizeFactoryObjective(detail);
      return {
        worker: "factory",
        action: "status",
        ...summary,
        latestDecision: detail.latestDecision,
        blockedExplanation: detail.blockedExplanation,
        evidenceCards: Array.isArray(detail.evidenceCards) ? detail.evidenceCards.slice(-8) : [],
        activeJobs: debug.activeJobs,
        taskWorktrees: debug.taskWorktrees,
        integrationWorktree: debug.integrationWorktree,
        recentReceipts: Array.isArray(debug.recentReceipts) ? debug.recentReceipts.slice(0, 12) : [],
        latestContextPacks: debug.latestContextPacks,
      };
    };
    const initial = await buildStatus();
    const live = (
      asString(initial.status) === "queued"
      || asString(initial.status) === "active"
      || asString(initial.status) === "executing"
      || (Array.isArray(initial.activeJobs) && initial.activeJobs.length > 0)
    );
    const waitForChangeMs = effectiveFactoryLiveWaitMs(requestedWaitMs, live, input.liveWaitState);
    const waited = waitForChangeMs > 0 && live
      ? await waitForSnapshotChange(initial, waitForChangeMs, buildStatus)
      : { value: initial, waitedMs: 0, changed: false };
    const payload = waited.waitedMs > 0
      ? { ...waited.value, waitedMs: waited.waitedMs, changed: waited.changed }
      : waited.value;
    const pauseBudget = waited.waitedMs > 0 && waited.changed === false && !input.liveWaitState.surfaced;
    if (live) input.liveWaitState.surfaced = true;
    return {
      output: JSON.stringify(payload, null, 2),
      summary: `${String(payload.summary ?? payload.title ?? objectiveId)}${waited.waitedMs > 0 ? ` after waiting ${waited.waitedMs}ms` : ""}`,
      pauseBudget,
    };
  };

const createFactoryOutputTool = (input: {
  readonly factoryService: FactoryService;
  readonly liveWaitState: FactoryLiveWaitState;
  readonly getCurrentObjectiveId: () => string | undefined;
}): AgentToolExecutor =>
  async (toolInput) => {
    const objectiveId = asString(toolInput.objectiveId) ?? input.getCurrentObjectiveId();
    if (!objectiveId) throw new Error("factory.output requires objectiveId");
    const taskId = asString(toolInput.taskId);
    const jobId = asString(toolInput.jobId);
    const requestedFocusKind = asString(toolInput.focusKind);
    const requestedFocusId = asString(toolInput.focusId);
    let focusKind: "task" | "job";
    let focusId: string;
    if (taskId) {
      focusKind = "task";
      focusId = taskId;
    } else if (jobId) {
      focusKind = "job";
      focusId = jobId;
    } else if (requestedFocusKind === "task" || requestedFocusKind === "job") {
      if (!requestedFocusId) throw new Error("factory.output requires focusId");
      focusKind = requestedFocusKind;
      focusId = requestedFocusId;
    } else if (requestedFocusKind) {
      throw new Error("factory.output requires focusKind of 'task' or 'job'");
    } else if (requestedFocusId) {
      throw new Error("factory.output requires focusKind when focusId is provided");
    } else {
      const inferredFocus = await input.factoryService.inferObjectiveLiveOutputFocus(objectiveId);
      if (!inferredFocus) {
        throw new Error("factory.output requires focusKind/focusId, taskId/jobId, or an objective with exactly one active/nonterminal task (or exactly one task total)");
      }
      focusKind = inferredFocus.focusKind;
      focusId = inferredFocus.focusId;
    }
    const requestedWaitMs = clampWaitMs(toolInput.waitForChangeMs);
    const buildOutput = async (): Promise<Record<string, unknown>> => ({
      worker: "factory",
      action: "output",
      ...await input.factoryService.getObjectiveLiveOutput(objectiveId, focusKind, focusId),
    });
    const initial = await buildOutput();
    const live = initial.active === true;
    const waitForChangeMs = effectiveFactoryLiveWaitMs(requestedWaitMs, live, input.liveWaitState);
    const waited = waitForChangeMs > 0 && live
      ? await waitForSnapshotChange(initial, waitForChangeMs, buildOutput)
      : { value: initial, waitedMs: 0, changed: false };
    const payload = waited.waitedMs > 0
      ? { ...waited.value, waitedMs: waited.waitedMs, changed: waited.changed }
      : waited.value;
    const pauseBudget = waited.waitedMs > 0 && waited.changed === false && !input.liveWaitState.surfaced;
    if (live) input.liveWaitState.surfaced = true;
    return {
      output: JSON.stringify(payload, null, 2),
      summary: `${String(payload.summary ?? `${focusKind} ${focusId}: ${String(payload.status ?? "unknown")}`)}${waited.waitedMs > 0 ? ` after waiting ${waited.waitedMs}ms` : ""}`,
      pauseBudget,
    };
  };

const createActiveCodexChildFinalizer = (input: {
  readonly queue: JsonlQueue;
  readonly runId: string;
  readonly stream: string;
  readonly supervisorSessionId: string;
}): AgentFinalizer =>
  async () => {
    const jobs = await listSupervisorJobs(input.queue, input);
    const activeCodex = jobs
      .filter((job) => job.agentId === "codex" && isActiveJobStatus(job.status))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const primary = activeCodex[0];
    if (!primary) return { accept: true };
    return {
      accept: false,
      note: `codex child ${primary.id} is still ${primary.status}; continue monitoring with codex.status or agent.status`,
    };
  };

export const runCodexSupervisor = async (input: CodexSupervisorRunInput): Promise<AgentRunResult> => {
  const supervisorSessionId = asString(input.supervisorSessionId) ?? input.runId;
  const getCurrentObjectiveId = (): string | undefined => latestObjectiveByRun.get(input.runId);
  const factoryLiveWaitState: FactoryLiveWaitState = { surfaced: false };
  const dataDir = input.dataDir;
  const factoryService = input.factoryService;
  const dynamicToolAllowlist = CODEX_SUPERVISOR_TOOL_ALLOWLIST.filter((name) =>
    (name !== "codex.logs" || Boolean(dataDir))
    && (!name.startsWith("factory.") || Boolean(factoryService))
  );
  const toolAllowlist = unique([
    ...dynamicToolAllowlist,
    ...(input.toolAllowlist ?? []),
  ]).filter((name) => !DIRECT_WORKSPACE_TOOLS.has(name));
  const jobsListTool = createJobsListTool({
    queue: input.queue,
    runId: input.runId,
    stream: input.stream,
    supervisorSessionId,
  });
  const repoStatusTool = createRepoStatusTool(input.workspaceRoot);
  const codexStatusTool = createCodexStatusTool({
    queue: input.queue,
    runId: input.runId,
    stream: input.stream,
    supervisorSessionId,
    dataDir,
  });
  const codexRunTool = createCodexRunTool({
    queue: input.queue,
    runId: input.runId,
    stream: input.stream,
    supervisorSessionId,
    dataDir,
  });
  const codexLogsTool = dataDir
    ? createCodexLogsTool({
      queue: input.queue,
      runId: input.runId,
      stream: input.stream,
      supervisorSessionId,
      dataDir,
    })
    : undefined;
  const factoryDispatchTool = factoryService
    ? createFactoryDispatchTool({
      factoryService,
      runId: input.runId,
      getCurrentObjectiveId,
    })
    : undefined;
  const factoryStatusTool = factoryService
    ? createFactoryStatusTool({
      factoryService,
      liveWaitState: factoryLiveWaitState,
      getCurrentObjectiveId,
    })
    : undefined;
  const factoryOutputTool = factoryService
    ? createFactoryOutputTool({
      factoryService,
      liveWaitState: factoryLiveWaitState,
      getCurrentObjectiveId,
    })
    : undefined;
  const capabilities = [
    createCapabilitySpec(jobsListCapability, jobsListTool),
    createCapabilitySpec(repoStatusCapability, repoStatusTool),
    createCapabilitySpec(codexStatusCapability, codexStatusTool),
    createCapabilitySpec(codexRunCapability, codexRunTool),
    ...(codexLogsTool ? [
      createCapabilitySpec(codexLogsCapability, codexLogsTool),
    ] : []),
    ...(factoryDispatchTool && factoryStatusTool && factoryOutputTool ? [
      createCapabilitySpec(factoryDispatchCapability, factoryDispatchTool),
      createCapabilitySpec(factoryStatusCapability, factoryStatusTool),
      createCapabilitySpec(factoryOutputCapability, factoryOutputTool),
    ] : []),
    ...(input.capabilities ?? []),
  ];

  return runAgent({
    ...input,
    workflowId: CODEX_SUPERVISOR_WORKFLOW_ID,
    workflowVersion: CODEX_SUPERVISOR_WORKFLOW_VERSION,
    toolAllowlist,
    extraConfig: {
      ...(input.extraConfig ?? {}),
      executionMode: "codex_supervisor",
      codeAccess: "codex_only",
      supervisorSessionId,
    },
    capabilities,
    finalizer: combineFinalizers(
      createLiveFactoryFinalizer({
        factoryService,
        getCurrentObjectiveId,
        liveWaitState: factoryLiveWaitState,
        describeActiveChild: async () => {
          const jobs = await listSupervisorJobs(input.queue, {
            runId: input.runId,
            stream: input.stream,
            supervisorSessionId,
          });
          const activeChild = jobs
            .filter((job) => job.agentId === "codex" && isActiveJobStatus(job.status))
            .sort((left, right) => right.updatedAt - left.updatedAt)[0];
          if (!activeChild) return undefined;
          const snapshot = await codexJobSnapshot(activeChild, dataDir);
          return {
            jobId: activeChild.id,
            detail: asString(snapshot.lastMessage)
              ?? asString(snapshot.stderrTail)
              ?? asString(snapshot.stdoutTail)
              ?? asString(snapshot.summary),
          };
        },
      }),
      combineFinalizers(
        createActiveCodexChildFinalizer({
          queue: input.queue,
          runId: input.runId,
          stream: input.stream,
          supervisorSessionId,
        }),
        input.finalizer,
      ),
    ),
  });
};
