import type { AgentCapabilitySpec, AgentToolExecutor } from "../../capabilities";
import {
  agentDelegateCapability,
  agentStatusCapability,
  codexLogsCapability,
  codexRunCapability,
  codexStatusCapability,
  createCapabilitySpec,
  factoryDispatchCapability,
  factoryOutputCapability,
  factoryReceiptsCapability,
  factoryStatusCapability,
  jobControlCapability,
  jobsListCapability,
  profileHandoffCapability,
  repoStatusCapability,
} from "../../capabilities";
import type { SqliteQueue } from "../../../adapters/sqlite-queue";
import type { MemoryTools } from "../../../adapters/memory-tools";
import type { FactoryService, FactoryObjectiveInput } from "../../../services/factory-service";
import {
  factoryChatStream,
  factoryChatSessionStream,
  assertFactoryProfileCreateModeAllowed,
  assertFactoryProfileDispatchActionAllowed,
  factoryChatResolvedProfileActionSubject,
  resolveFactoryChatProfile,
  type FactoryChatResolvedProfile,
} from "../../../services/factory-chat-profiles";
import { createRepoStatusTool, effectiveFactoryLiveWaitMs, waitForSnapshotChange, isActiveJobStatus, clampWaitMs, deriveObjectiveTitle } from "../../orchestration-utils";
import { summarizeFactoryObjective } from "../../../views/factory/objective-presenters";
import { normalizeFactoryDispatchInput, resolveFactoryDispatchAction, isObjectiveContinuationBoundary } from "../dispatch";
import { asString, asRecord, asStringList, nextId, stableCodexSessionKey, workerMemoryScope, toolSummary, latestActiveCodexJob, jobMatchesProfileContext, codexJobPriority, normalizeJobSnapshot, reusableInfrastructureRefs } from "./input";
import { commitWorkerSummary } from "./memory";
import { codexJobSnapshot } from "./status";
import { FactorySupervisorConfig, queueSupervisorCommandOnce, isSupervisorStallSummary } from "./supervisor";

type FactoryChatToolsInput = {
  readonly queue: SqliteQueue;
  readonly runId: string;
  readonly stream: string;
  readonly repoRoot: string;
  readonly repoKey: string;
  readonly profileRoot: string;
  readonly problem: string;
  readonly chatId?: string;
  readonly continuationDepth: number;
  readonly currentJobId?: string;
  readonly dataDir?: string;
  readonly memoryTools: MemoryTools;
  readonly profile: FactoryChatResolvedProfile;
  readonly factoryService: FactoryService;
  readonly getCurrentObjectiveId: () => string | undefined;
  readonly setCurrentObjectiveId: (objectiveId: string | undefined) => void;
  readonly consumeDiscoveryBudget?: () => void;
  readonly liveWaitState: { surfaced: boolean };
  readonly supervisorConfig: FactorySupervisorConfig;
};

const isTerminalObjectiveStatus = (status: unknown): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const latestObjectiveByStream = new Map<string, string>();

const dispatchRequestedCrossProfileAssignment = (toolInput: unknown): boolean => {
  const record = asRecord(toolInput);
  return Boolean(record && Object.prototype.hasOwnProperty.call(record, "profileId"));
};

const resolveDispatchCreateMode = (
  input: FactoryChatToolsInput,
  normalized: ReturnType<typeof normalizeFactoryDispatchInput>,
  currentObjective: Awaited<ReturnType<FactoryService["getObjective"]>> | undefined,
): "delivery" | "investigation" =>
  normalized.objectiveMode
  ?? currentObjective?.objectiveMode
  ?? input.profile.objectivePolicy.defaultObjectiveMode;

const renderProfileHandoffProblem = (input: {
  readonly fromProfileId: string;
  readonly toProfileId: string;
  readonly reason: string;
  readonly goal: string;
  readonly currentState: string;
  readonly doneWhen: string;
  readonly evidence: ReadonlyArray<string>;
  readonly blockers: ReadonlyArray<string>;
  readonly originalProblem: string;
}): string => {
  const sections = [
    [
      `Engineer handoff from ${input.fromProfileId} to ${input.toProfileId}.`,
      `Reason: ${input.reason}`,
      `Goal: ${input.goal}`,
      `Current state: ${input.currentState}`,
      `Done when: ${input.doneWhen}`,
    ].join("\n"),
  ];
  if (input.evidence.length > 0) {
    sections.push([
      "Evidence:",
      ...input.evidence.map((entry) => `- ${entry}`),
    ].join("\n"));
  }
  if (input.blockers.length > 0) {
    sections.push([
      "Blockers:",
      ...input.blockers.map((entry) => `- ${entry}`),
    ].join("\n"));
  }
  sections.push([
    "Original request:",
    input.originalProblem,
  ].join("\n"));
  return sections.join("\n\n");
};

const createCodexRunTool = (input: FactoryChatToolsInput): AgentToolExecutor =>
  async (toolInput) => {
    const prompt = asString(toolInput.prompt) ?? asString(toolInput.task);
    if (!prompt) throw new Error("codex.run requires prompt");
    const objectiveId = input.getCurrentObjectiveId();
    const existing = await latestActiveCodexJob(input.queue, {
      runId: input.runId,
      stream: input.stream,
      profileId: input.profile.root.id,
      objectiveId,
    });
    if (existing) {
      const result: Record<string, unknown> = {
        ...(await codexJobSnapshot(existing, input.dataDir)),
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
    const sessionKey = stableCodexSessionKey(input.runId, prompt);
    const created = await input.queue.enqueue({
      agentId: "codex",
      lane: "collect",
      sessionKey,
      singletonMode: "allow",
      maxAttempts: 1,
      payload: {
        kind: "factory.codex.run",
        parentRunId: input.runId,
        parentStream: input.stream,
        stream: input.stream,
        profileId: input.profile.root.id,
        ...(objectiveId ? { objectiveId } : {}),
        mode: "read_only_probe",
        readOnly: true,
        task: prompt,
        prompt,
        timeoutMs,
      },
    });
    const result: Record<string, unknown> = {
      ...normalizeJobSnapshot(created),
      worker: "codex",
      mode: "read_only_probe",
      readOnly: true,
      summary: `codex read-only probe queued as ${created.id}`,
    };
    await commitWorkerSummary(
      input.memoryTools,
      workerMemoryScope(input.repoKey, "codex"),
      toolSummary("codex", String(result.status), String(result.summary)),
      { runId: input.runId, jobId: created.id, task: prompt },
    );
    return {
      output: JSON.stringify(result, null, 2),
      summary: String(result.summary),
    };
  };

const createAsyncDelegateTool = (input: FactoryChatToolsInput): AgentToolExecutor =>
  async (toolInput) => {
    const agentId = asString(toolInput.agentId);
    const task = asString(toolInput.task);
    if (!agentId) throw new Error("agent.delegate requires agentId");
    if (!task) throw new Error("agent.delegate requires task");
    const config = asRecord(toolInput.config) ?? {};
    const childRunId = nextId("run");
    const childStream = `agents/${agentId}`;
    const created = await input.queue.enqueue({
      agentId,
      lane: "collect",
      sessionKey: `factory-delegate:${input.stream}:${agentId}:${Date.now().toString(36)}`,
      singletonMode: "allow",
      maxAttempts: 2,
      payload: {
        kind: `${agentId}.run`,
        task,
        problem: task,
        config,
        isSubAgent: true,
        delegatedTo: agentId,
        runId: childRunId,
        stream: childStream,
        parentRunId: input.runId,
        parentStream: input.stream,
        profileId: input.profile.root.id,
        ...(input.getCurrentObjectiveId() ? { objectiveId: input.getCurrentObjectiveId() } : {}),
      },
    });
    const snapshot = normalizeJobSnapshot(created);
    await commitWorkerSummary(
      input.memoryTools,
      workerMemoryScope(input.repoKey, agentId),
      toolSummary(agentId, String(snapshot.status), String(snapshot.summary)),
      { runId: input.runId, jobId: created.id, task },
    );
    return {
      output: JSON.stringify(snapshot, null, 2),
      summary: `queued ${agentId} subagent`,
    };
  };

const createJobStatusTool = (input: FactoryChatToolsInput): AgentToolExecutor =>
  async (toolInput) => {
    const jobId = asString(toolInput.jobId);
    if (!jobId) throw new Error("agent.status requires jobId");
    if (jobId === input.currentJobId) {
      throw new Error("agent.status cannot target the current factory job; use the child jobId returned by codex.run or agent.delegate");
    }
    input.consumeDiscoveryBudget?.();
    const job = await input.queue.getJob(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    if (
      job.agentId === "codex"
      && job.status !== "completed"
      && job.status !== "failed"
      && job.status !== "canceled"
      && input.profile.orchestration.allowPollingWhileChildRunning === false
    ) {
      throw new Error("Profile child work is already running");
    }
    const snapshot = normalizeJobSnapshot(job);
    return {
      output: JSON.stringify(snapshot, null, 2),
      summary: `job ${jobId}: ${String(snapshot.status)}`,
    };
  };

const createJobsListTool = (input: FactoryChatToolsInput): AgentToolExecutor =>
  async (toolInput) => {
    const limit = typeof toolInput.limit === "number" && Number.isFinite(toolInput.limit)
      ? Math.max(1, Math.min(Math.floor(toolInput.limit), 30))
      : 10;
    const includeCompleted = toolInput.includeCompleted === true;
    const statusFilter = asString(toolInput.status);
    const objectiveId = input.getCurrentObjectiveId();
    input.consumeDiscoveryBudget?.();
    const jobs = await input.queue.listJobs({ limit: 120 });
    const filtered = jobs
      .filter((job) => jobMatchesProfileContext(job, {
        runId: input.runId,
        stream: input.stream,
        profileId: input.profile.root.id,
        objectiveId,
      }))
      .filter((job) => includeCompleted || (job.status !== "completed" && job.status !== "failed" && job.status !== "canceled"))
      .filter((job) => !statusFilter || job.status === statusFilter)
      .slice(0, limit)
      .map((job) => normalizeJobSnapshot(job));
    return {
      output: JSON.stringify(filtered, null, 2),
      summary: `${filtered.length} jobs`,
    };
  };

const createCodexStatusTool = (input: FactoryChatToolsInput): AgentToolExecutor =>
  async (toolInput) => {
    const waitForChangeMs = clampWaitMs(toolInput.waitForChangeMs);
    const buildStatus = async (): Promise<Record<string, unknown>> => {
      const objectiveId = input.getCurrentObjectiveId();
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
      const jobs = (await input.queue.listJobs({ limit: 200 }))
        .filter((job) => job.agentId === "codex")
        .filter((job) => jobMatchesProfileContext(job, {
          runId: input.runId,
          stream: input.stream,
          profileId: input.profile.root.id,
          objectiveId,
        }))
        .filter((job) => includeCompleted || isActiveJobStatus(job.status))
        .sort((left, right) =>
          codexJobPriority(right, { runId: input.runId, objectiveId })
          - codexJobPriority(left, { runId: input.runId, objectiveId })
          || right.updatedAt - left.updatedAt);
      const snapshots = await Promise.all(jobs.slice(0, limit).map((job) => codexJobSnapshot(job, input.dataDir)));
      return {
        worker: "codex",
        activeCount: jobs.filter((job) => isActiveJobStatus(job.status)).length,
        latest: snapshots[0] ?? null,
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
    const latest = snapshots[0];
    const activeCount = Number(payload.activeCount ?? 0);
    const pauseBudget = waited.waitedMs > 0 && waited.changed === false && !input.liveWaitState.surfaced;
    if (activeCount > 0) input.liveWaitState.surfaced = true;
    const summary = latest
      ? activeCount > 0
        ? `codex active: ${String(latest.jobId)} (${String(latest.status)})`
        : `latest codex job ${String(latest.jobId)} is ${String(latest.status)}`
      : "no codex jobs found for this context";
    return {
      output: JSON.stringify(payload, null, 2),
      summary: `${summary}${waited.waitedMs > 0 ? ` after waiting ${waited.waitedMs}ms` : ""}`,
      pauseBudget,
    };
  };

const createCodexLogsTool = (input: FactoryChatToolsInput): AgentToolExecutor =>
  async (toolInput) => {
    const objectiveId = input.getCurrentObjectiveId();
    const requestedJobId = asString(toolInput.jobId);
    const targetJob = requestedJobId
      ? await input.queue.getJob(requestedJobId)
      : (await input.queue.listJobs({ limit: 200 }))
        .filter((job) => job.agentId === "codex")
        .filter((job) => jobMatchesProfileContext(job, {
          runId: input.runId,
          stream: input.stream,
          profileId: input.profile.root.id,
          objectiveId,
        }))
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (!targetJob) throw new Error(requestedJobId ? `job ${requestedJobId} not found` : "no codex jobs found for this context");
    if (targetJob.agentId !== "codex") throw new Error(`job ${targetJob.id} is not a codex job`);
    const snapshot = await codexJobSnapshot(targetJob, input.dataDir);
    return {
      output: JSON.stringify({
        worker: "codex",
        action: "logs",
        ...snapshot,
      }, null, 2),
      summary: `codex logs ${targetJob.id}: ${String(snapshot.status ?? targetJob.status)}`,
    };
  };

const createJobControlTool = (input: FactoryChatToolsInput): AgentToolExecutor =>
  async (toolInput) => {
    const jobId = asString(toolInput.jobId);
    const command = asString(toolInput.command);
    if (!jobId) throw new Error("job.control requires jobId");
    if (jobId === input.currentJobId) {
      throw new Error("job.control cannot target the current factory job; use the child jobId returned by codex.run or agent.delegate");
    }
    if (command !== "abort") {
      throw new Error("job.control only supports abort");
    }
    const payload = { reason: asString(toolInput.reason) ?? "abort requested" };
    const queued = await input.queue.queueCommand({
      jobId,
      command,
      payload,
      by: "factory.chat",
    });
    if (!queued) throw new Error(`job ${jobId} not found`);
    return {
      output: JSON.stringify({
        jobId,
        command,
        status: "queued",
        payload,
      }, null, 2),
      summary: `${command} queued for ${jobId}`,
    };
  };

const createFactoryDispatchTool = (input: FactoryChatToolsInput): AgentToolExecutor =>
  async (toolInput) => {
    if (dispatchRequestedCrossProfileAssignment(toolInput)) {
      throw new Error("factory.dispatch does not accept profileId; use profile.handoff to change owners.");
    }
    const normalized = normalizeFactoryDispatchInput(toolInput);
    const requestedObjectiveId = normalized.objectiveId;
    const objectiveId = requestedObjectiveId ?? input.getCurrentObjectiveId();
    const currentObjective = objectiveId
      ? await input.factoryService.getObjective(objectiveId).catch(() => undefined)
      : undefined;
    let action = resolveFactoryDispatchAction(normalized, objectiveId);
    let detail: Awaited<ReturnType<FactoryService["getObjective"]>>;
    let reused = false;
    let bindingReason: "dispatch_create" | "dispatch_reuse" | "dispatch_update" = "dispatch_update";
    if (action === "create") {
      assertFactoryProfileDispatchActionAllowed(factoryChatResolvedProfileActionSubject(input.profile), action);
      const prompt = normalized.prompt;
      if (!prompt) throw new Error("factory.dispatch create requires prompt");
      const objectiveMode = resolveDispatchCreateMode(input, normalized, currentObjective);
      assertFactoryProfileCreateModeAllowed(factoryChatResolvedProfileActionSubject(input.profile), objectiveMode);
      const payload: FactoryObjectiveInput = {
        objectiveId: requestedObjectiveId,
        title: normalized.title ?? deriveObjectiveTitle(prompt),
        prompt,
        baseHash: normalized.baseHash,
        objectiveMode,
        severity: normalized.severity ?? currentObjective?.severity,
        checks: normalized.checks,
        channel: normalized.channel,
        profileId: input.profile.root.id,
        startImmediately: true,
      };
      detail = await input.factoryService.createObjective(payload);
      bindingReason = "dispatch_create";
    } else if (action === "react") {
      assertFactoryProfileDispatchActionAllowed(factoryChatResolvedProfileActionSubject(input.profile), action);
      if (!objectiveId) throw new Error("factory.dispatch react requires objectiveId");
      const followUpPrompt = normalized.note ?? normalized.prompt;
      if (currentObjective && isObjectiveContinuationBoundary(currentObjective)) {
        if (!followUpPrompt) {
          throw new Error("factory.dispatch react on a completed objective requires note or prompt to create a follow-up objective");
        }
        assertFactoryProfileDispatchActionAllowed(factoryChatResolvedProfileActionSubject(input.profile), "create");
        const objectiveMode = resolveDispatchCreateMode(input, normalized, currentObjective);
        assertFactoryProfileCreateModeAllowed(factoryChatResolvedProfileActionSubject(input.profile), objectiveMode);
        detail = await input.factoryService.createObjective({
          title: normalized.title ?? deriveObjectiveTitle(followUpPrompt),
          prompt: followUpPrompt,
          baseHash: normalized.baseHash,
          objectiveMode,
          severity: normalized.severity ?? currentObjective.severity,
          checks: normalized.checks,
          channel: normalized.channel,
          profileId: input.profile.root.id,
          startImmediately: true,
        });
        action = "create";
        bindingReason = "dispatch_create";
      } else {
        detail = await input.factoryService.reactObjectiveWithNote(
          objectiveId,
          followUpPrompt,
        );
      }
    } else if (action === "promote") {
      assertFactoryProfileDispatchActionAllowed(factoryChatResolvedProfileActionSubject(input.profile), action);
      if (!objectiveId) throw new Error("factory.dispatch promote requires objectiveId");
      detail = await input.factoryService.promoteObjective(objectiveId);
    } else if (action === "cancel") {
      assertFactoryProfileDispatchActionAllowed(factoryChatResolvedProfileActionSubject(input.profile), action);
      if (!objectiveId) throw new Error("factory.dispatch cancel requires objectiveId");
      detail = await input.factoryService.cancelObjective(objectiveId, asString(toolInput.reason));
    } else if (action === "cleanup") {
      assertFactoryProfileDispatchActionAllowed(factoryChatResolvedProfileActionSubject(input.profile), action);
      if (!objectiveId) throw new Error("factory.dispatch cleanup requires objectiveId");
      detail = await input.factoryService.cleanupObjectiveWorkspaces(objectiveId);
    } else if (action === "archive") {
      assertFactoryProfileDispatchActionAllowed(factoryChatResolvedProfileActionSubject(input.profile), action);
      if (!objectiveId) throw new Error("factory.dispatch archive requires objectiveId");
      detail = await input.factoryService.archiveObjective(objectiveId);
    } else {
      throw new Error(`unsupported factory.dispatch action '${action}'`);
    }
    const summary = summarizeFactoryObjective(detail);
    if (detail.archivedAt || isTerminalObjectiveStatus(detail.status)) {
      latestObjectiveByStream.delete(input.stream);
    } else {
      latestObjectiveByStream.set(input.stream, detail.objectiveId);
    }
    await commitWorkerSummary(
      input.memoryTools,
      workerMemoryScope(input.repoKey, "factory"),
      toolSummary("factory", summary.status, summary.summary),
      { runId: input.runId, objectiveId: summary.objectiveId, action },
    );
    input.setCurrentObjectiveId(detail.objectiveId);
    const chatId = input.chatId;
    return {
      output: JSON.stringify({ worker: "factory", action, reused, ...summary }, null, 2),
      summary: summary.summary,
      events: [{
        type: "thread.bound",
        runId: input.runId,
        agentId: "orchestrator",
        objectiveId: detail.objectiveId,
        ...(chatId ? { chatId } : {}),
        reason: bindingReason,
        created: action === "create" && reused === false,
      }],
    };
  };

const createProfileHandoffTool = (input: FactoryChatToolsInput): AgentToolExecutor =>
  async (toolInput) => {
    const targetProfileId = asString(toolInput.profileId)
      ?? asString(toolInput.target)
      ?? asString(toolInput.to)
      ?? asString(toolInput.profile);
    if (!targetProfileId) throw new Error("profile.handoff requires profileId");
    if (targetProfileId === input.profile.root.id) {
      throw new Error(`profile.handoff target must differ from the current profile '${input.profile.root.id}'`);
    }
    if (!input.profile.handoffTargets.includes(targetProfileId)) {
      throw new Error(`profile.handoff from '${input.profile.root.id}' to '${targetProfileId}' is not allowed`);
    }
    const reason = asString(toolInput.reason);
    if (!reason) throw new Error("profile.handoff requires reason");
    const goal = asString(toolInput.goal);
    if (!goal) throw new Error("profile.handoff requires goal");
    const currentState = asString(toolInput.currentState);
    if (!currentState) throw new Error("profile.handoff requires currentState");
    const doneWhen = asString(toolInput.doneWhen);
    if (!doneWhen) throw new Error("profile.handoff requires doneWhen");
    const evidence = asStringList(toolInput.evidence);
    const blockers = asStringList(toolInput.blockers);
    await resolveFactoryChatProfile({
      repoRoot: input.repoRoot,
      profileRoot: input.profileRoot,
      requestedId: targetProfileId,
    });
    const objectiveId = asString(toolInput.objectiveId) ?? input.getCurrentObjectiveId();
    const chatId = asString(toolInput.chatId) ?? input.chatId;
    const targetStream = chatId
      ? factoryChatSessionStream(input.repoRoot, targetProfileId, chatId)
      : factoryChatStream(input.repoRoot, targetProfileId, objectiveId);
    const nextRunId = nextId("run");
    const created = await input.queue.enqueue({
      agentId: "factory",
      lane: "chat",
      sessionKey: `factory-chat:${targetStream}`,
      singletonMode: "steer",
      maxAttempts: 1,
      payload: {
        kind: "factory.run",
        stream: targetStream,
        runId: nextRunId,
        problem: renderProfileHandoffProblem({
          fromProfileId: input.profile.root.id,
          toProfileId: targetProfileId,
          reason,
          goal,
          currentState,
          doneWhen,
          evidence,
          blockers,
          originalProblem: input.problem,
        }),
        profileId: targetProfileId,
        ...(chatId ? { chatId } : {}),
        ...(objectiveId ? { objectiveId } : {}),
        continuationDepth: input.continuationDepth + 1,
      },
    });
    return {
      output: JSON.stringify({
        worker: "factory",
        action: "profile_handoff",
        status: "queued",
        summary: `Queued ${targetProfileId} profile handoff.`,
        fromProfileId: input.profile.root.id,
        toProfileId: targetProfileId,
        reason,
        goal,
        currentState,
        doneWhen,
        ...(evidence.length > 0 ? { evidence } : {}),
        ...(blockers.length > 0 ? { blockers } : {}),
        nextRunId,
        nextJobId: created.id,
        targetStream,
        ...(objectiveId ? { objectiveId } : {}),
        ...(chatId ? { chatId } : {}),
      }, null, 2),
      summary: `Queued ${targetProfileId} profile handoff.`,
      finalText: `Handing this over to ${targetProfileId}.`,
      finalNote: `profile handoff queued to ${targetProfileId}`,
      events: [{
        type: "profile.handoff",
        runId: input.runId,
        agentId: "orchestrator",
        fromProfileId: input.profile.root.id,
        toProfileId: targetProfileId,
        reason,
        goal,
        currentState,
        doneWhen,
        ...(evidence.length > 0 ? { evidence } : {}),
        ...(blockers.length > 0 ? { blockers } : {}),
        nextRunId,
        nextJobId: created.id,
        targetStream,
        ...(objectiveId ? { objectiveId } : {}),
        ...(chatId ? { chatId } : {}),
      }],
    };
  };

const createFactoryStatusTool = (input: FactoryChatToolsInput): AgentToolExecutor =>
  async (toolInput) => {
    const objectiveId = asString(toolInput.objectiveId) ?? input.getCurrentObjectiveId();
    if (!objectiveId) throw new Error("factory.status requires objectiveId");
    const requestedWaitMs = clampWaitMs(toolInput.waitForChangeMs);
    const buildStatus = async (): Promise<Record<string, unknown>> => {
      const [detail, debug, receipts] = await Promise.all([
        input.factoryService.getObjective(objectiveId),
        input.factoryService.getObjectiveDebug(objectiveId),
        input.factoryService.listObjectiveReceipts(objectiveId, { limit: 20 }),
      ]);
      const summary = summarizeFactoryObjective(detail);
      const reusableRefs = reusableInfrastructureRefs(detail.contextSources?.sharedArtifactRefs);
      return {
        worker: "factory",
        action: "status",
        ...summary,
        activeJobId: debug.activeJobs[0]?.id,
        activeTaskId: detail.tasks.find((task) => task.status === "running")?.taskId,
        activeTaskTitle: detail.tasks.find((task) => task.status === "running")?.title,
        nextTaskId: detail.tasks.find((task) => task.status === "pending")?.taskId,
        nextTaskTitle: detail.tasks.find((task) => task.status === "pending")?.title,
        latestDecision: detail.latestDecision,
        blockedExplanation: detail.blockedExplanation,
        evidenceCards: Array.isArray(detail.evidenceCards) ? detail.evidenceCards.slice(-8) : [],
        recentReceipts: receipts,
        activeJobs: debug.activeJobs,
        taskWorktrees: debug.taskWorktrees,
        integrationWorktree: debug.integrationWorktree,
        latestContextPacks: debug.latestContextPacks,
        availableHelperEntrypoints: reusableRefs.scripts,
        availableHelperManifests: reusableRefs.knowledge,
        availableHelperSupport: reusableRefs.evidence,
        freshnessGuidance: reusableRefs.scripts.length > 0
          ? "For live cloud/account/runtime questions, rerun the best matching checked-in helper before finalizing."
          : undefined,
      };
    };
    const initial = await buildStatus();
    const live = (
      asString(initial.status) === "queued"
      || asString(initial.status) === "active"
      || asString(initial.status) === "executing"
      || (Array.isArray(initial.activeJobs) && initial.activeJobs.length > 0)
    );
    const waitForChangeMs = input.profile.orchestration.executionMode === "supervisor"
      ? requestedWaitMs
      : effectiveFactoryLiveWaitMs(requestedWaitMs, live, input.liveWaitState);
    const waited = waitForChangeMs > 0 && live
      ? await waitForSnapshotChange(initial, waitForChangeMs, buildStatus)
      : { value: initial, waitedMs: 0, changed: false };
    const payload = waited.waitedMs > 0
      ? { ...waited.value, waitedMs: waited.waitedMs, changed: waited.changed }
      : waited.value;
    const maybeActiveJobId = asString(payload.activeJobId);
    if (maybeActiveJobId && input.profile.orchestration.executionMode === "supervisor") {
      const currentTaskId = asString(payload.activeTaskId);
      const currentTaskTitle = asString(payload.activeTaskTitle);
      const nextTaskId = asString(payload.nextTaskId);
      const nextTaskTitle = asString(payload.nextTaskTitle);
      const liveOutput = await input.factoryService
        .getObjectiveLiveOutput(objectiveId, "task", currentTaskId ?? maybeActiveJobId)
        .catch(() => undefined);
      const liveSummary = [
        asString(liveOutput?.stderrTail),
        asString(liveOutput?.summary),
        asString(liveOutput?.lastMessage),
        asString(liveOutput?.stdoutTail),
      ].filter(Boolean).join("\n");
      const steerAfterMs = input.supervisorConfig.steerAfterMs ?? 0;
      const abortAfterMs = input.supervisorConfig.abortAfterMs ?? 0;
      if (/(AccessDenied|not authorized|forbidden)/i.test(liveSummary) && (nextTaskId || currentTaskId)) {
        await queueSupervisorCommandOnce({
          queue: input.queue,
          jobId: maybeActiveJobId,
          command: "follow_up",
          payload: {
            note: [
              "partial investigation report",
              "exact denied services/actions",
              nextTaskId && nextTaskTitle
                ? `${nextTaskId} (${nextTaskTitle})`
                : (currentTaskId && currentTaskTitle ? `${currentTaskId} (${currentTaskTitle})` : currentTaskId),
            ].join("; "),
          },
        });
      }
      if (waited.waitedMs >= steerAfterMs && currentTaskId && isSupervisorStallSummary(liveSummary)) {
        await queueSupervisorCommandOnce({
          queue: input.queue,
          jobId: maybeActiveJobId,
          command: "steer",
          payload: {
            problem: [
              `Focus only on ${currentTaskId}${currentTaskTitle ? `: ${currentTaskTitle}` : ""}.`,
              nextTaskId && nextTaskTitle ? `${nextTaskId} (${nextTaskTitle})` : undefined,
            ].filter(Boolean).join(" "),
          },
        });
      }
      if (currentTaskId && abortAfterMs > 0 && waited.waitedMs >= abortAfterMs && isSupervisorStallSummary(liveSummary)) {
        await queueSupervisorCommandOnce({
          queue: input.queue,
          jobId: maybeActiveJobId,
          command: "abort",
          payload: {
            reason: `child stalled beyond ${abortAfterMs}ms`,
          },
        });
        await input.factoryService.reactObjective(objectiveId).catch(() => undefined);
      }
    }
    const pauseBudget = waited.waitedMs > 0 && waited.changed === false && !input.liveWaitState.surfaced;
    if (live) input.liveWaitState.surfaced = true;
    return {
      output: JSON.stringify(payload, null, 2),
      summary: `${String(payload.summary ?? payload.title ?? objectiveId)}${waited.waitedMs > 0 ? ` after waiting ${waited.waitedMs}ms` : ""}`,
      pauseBudget,
    };
  };

const createFactoryOutputTool = (input: FactoryChatToolsInput): AgentToolExecutor =>
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
    const waitForChangeMs = input.profile.orchestration.executionMode === "supervisor"
      ? requestedWaitMs
      : effectiveFactoryLiveWaitMs(requestedWaitMs, live, input.liveWaitState);
    const waited = waitForChangeMs > 0 && live
      ? await waitForSnapshotChange(initial, waitForChangeMs, buildOutput)
      : { value: initial, waitedMs: 0, changed: false };
    const payload = waited.waitedMs > 0
      ? { ...waited.value, waitedMs: waited.waitedMs, changed: waited.changed }
      : waited.value;
    const maybeActiveJobId = asString(payload.jobId) ?? asString(payload.focusId);
    if (maybeActiveJobId && input.profile.orchestration.executionMode === "supervisor") {
      const currentTask = asString(payload.taskId) ?? focusId;
      const liveSummary = [
        String(payload.stderrTail ?? ""),
        String(payload.summary ?? ""),
        String(payload.lastMessage ?? ""),
        String(payload.stdoutTail ?? ""),
      ].filter(Boolean).join("\n");
      if (/(AccessDenied|not authorized|forbidden)/i.test(liveSummary)) {
        await queueSupervisorCommandOnce({
          queue: input.queue,
          jobId: maybeActiveJobId,
          command: "follow_up",
          payload: {
            note: ["partial investigation report", "exact denied services/actions", currentTask].join("; "),
          },
        });
      } else if (waited.changed === false && waited.waitedMs >= (input.supervisorConfig.steerAfterMs ?? 0) && isSupervisorStallSummary(liveSummary)) {
        await queueSupervisorCommandOnce({
          queue: input.queue,
          jobId: maybeActiveJobId,
          command: "steer",
          payload: {
            problem: `Focus only on ${currentTask}.`,
          },
        });
      } else if (waited.changed === false && waited.waitedMs >= (input.supervisorConfig.abortAfterMs ?? 0) && isSupervisorStallSummary(liveSummary)) {
        await queueSupervisorCommandOnce({
          queue: input.queue,
          jobId: maybeActiveJobId,
          command: "abort",
          payload: {
            reason: `child stalled beyond ${(input.supervisorConfig.abortAfterMs ?? 0)}ms`,
          },
        });
        await input.factoryService.reactObjective(objectiveId).catch(() => undefined);
      }
    }
    const pauseBudget = waited.waitedMs > 0 && waited.changed === false && !input.liveWaitState.surfaced;
    if (live) input.liveWaitState.surfaced = true;
    return {
      output: JSON.stringify(payload, null, 2),
      summary: `${String(payload.summary ?? `${focusKind} ${focusId}: ${String(payload.status ?? "unknown")}`)}${waited.waitedMs > 0 ? ` after waiting ${waited.waitedMs}ms` : ""}`,
      pauseBudget,
    };
  };

const createFactoryReceiptsTool = (input: FactoryChatToolsInput): AgentToolExecutor =>
  async (toolInput) => {
    const objectiveId = asString(toolInput.objectiveId) ?? input.getCurrentObjectiveId();
    if (!objectiveId) throw new Error("factory.receipts requires objectiveId");
    const limit = typeof toolInput.limit === "number" && Number.isFinite(toolInput.limit)
      ? Math.max(1, Math.min(Math.floor(toolInput.limit), 40))
      : 12;
    const types = Array.isArray(toolInput.types)
      ? toolInput.types.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
      : [];
    const receipts = await input.factoryService.listObjectiveReceipts(objectiveId, {
      limit,
      taskId: asString(toolInput.taskId),
      candidateId: asString(toolInput.candidateId),
      types,
    });
    return {
      output: JSON.stringify({
        worker: "factory",
        action: "receipts",
        objectiveId,
        count: receipts.length,
        receipts,
      }, null, 2),
      summary: `${receipts.length} receipts`,
    };
  };

const createRepoStatusToolFactory = (repoRoot: string): AgentToolExecutor => createRepoStatusTool(repoRoot);

export const createFactoryChatCapabilities = (input: FactoryChatToolsInput): AgentCapabilitySpec[] => {
  const codexLogsTool = input.dataDir
    ? createCodexLogsTool(input)
    : undefined;
  return [
    createCapabilitySpec(agentDelegateCapability, createAsyncDelegateTool(input)),
    createCapabilitySpec(agentStatusCapability, createJobStatusTool(input)),
    createCapabilitySpec(jobsListCapability, createJobsListTool(input)),
    createCapabilitySpec(repoStatusCapability, createRepoStatusToolFactory(input.repoRoot)),
    createCapabilitySpec(codexStatusCapability, createCodexStatusTool(input)),
    ...(codexLogsTool ? [createCapabilitySpec(codexLogsCapability, codexLogsTool)] : []),
    createCapabilitySpec(jobControlCapability, createJobControlTool(input)),
    createCapabilitySpec(codexRunCapability, createCodexRunTool(input)),
    createCapabilitySpec(profileHandoffCapability, createProfileHandoffTool(input), {
      isAvailable: () => input.profile.handoffTargets.length > 0,
    }),
    createCapabilitySpec(factoryDispatchCapability, createFactoryDispatchTool(input)),
    createCapabilitySpec(factoryStatusCapability, createFactoryStatusTool(input)),
    createCapabilitySpec(factoryOutputCapability, createFactoryOutputTool(input)),
    createCapabilitySpec(factoryReceiptsCapability, createFactoryReceiptsTool(input)),
  ];
};
