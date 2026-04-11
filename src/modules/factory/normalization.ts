import {
  DEFAULT_FACTORY_OBJECTIVE_POLICY,
  DEFAULT_FACTORY_OBJECTIVE_PROFILE,
  emptyIntegration,
  initialFactoryState,
} from "./defaults";
import type {
  FactoryCandidateRecord,
  FactoryCheckResult,
  FactoryIntegrationRecord,
  FactoryInvestigationSynthesisRecord,
  FactoryInvestigationTaskReport,
  FactoryObjectiveHandoffRecord,
  FactoryObjectiveMode,
  FactoryProfileDispatchAction,
  FactoryObjectivePolicy,
  FactoryObjectiveProfileSnapshot,
  FactoryObjectiveSeverity,
  FactoryProfileCloudProvider,
  FactorySchedulerRecord,
  FactoryState,
  FactoryTaskPresentationRecord,
  FactoryTaskExecutionMode,
  FactoryTaskExecutionPhase,
  FactoryTaskRecord,
  FactoryTaskStatus,
  FactoryWaitRecord,
  FactoryWorkerType,
  FactoryWorkflowStatus,
} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeObjectiveMode = (value: unknown): FactoryObjectiveMode =>
  value === "investigation" ? "investigation" : "delivery";

const normalizeDispatchActionList = (value: unknown): ReadonlyArray<FactoryProfileDispatchAction> => {
  if (!Array.isArray(value)) return DEFAULT_FACTORY_OBJECTIVE_PROFILE.actionPolicy.allowedDispatchActions;
  const normalized = value.filter((item): item is FactoryProfileDispatchAction =>
    item === "create"
    || item === "react"
    || item === "promote"
    || item === "cancel"
    || item === "cleanup"
    || item === "archive");
  return uniqueStrings(normalized) as ReadonlyArray<FactoryProfileDispatchAction>;
};

const normalizeTaskExecutionMode = (value: unknown): FactoryTaskExecutionMode =>
  value === "isolated" ? "isolated" : "worktree";

const normalizeTaskExecutionPhase = (value: unknown): FactoryTaskExecutionPhase | undefined =>
  value === "collecting_evidence" || value === "evidence_ready" || value === "synthesizing"
    ? value
    : undefined;

const normalizeProfileCloudProvider = (value: unknown): FactoryProfileCloudProvider | undefined =>
  value === "aws" || value === "gcp" || value === "azure"
    ? value
    : undefined;

const normalizeObjectiveSeverity = (value: unknown): FactoryObjectiveSeverity => {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : NaN;
  if (!Number.isFinite(numeric)) return 1;
  const clamped = Math.max(1, Math.min(5, Math.round(numeric)));
  return clamped as FactoryObjectiveSeverity;
};

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
};

const uniqueStrings = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];

const normalizeCandidateOrder = (
  candidateOrder: unknown,
  candidates: Readonly<Record<string, FactoryCandidateRecord>>,
): ReadonlyArray<string> => {
  const ordered = Array.isArray(candidateOrder)
    ? candidateOrder.filter((candidateId): candidateId is string => typeof candidateId === "string" && Boolean(candidates[candidateId]))
    : [];
  return uniqueStrings(ordered);
};

const normalizeWorkflowStatus = (value: unknown): FactoryWorkflowStatus => {
  if (value === "completed" || value === "blocked" || value === "failed" || value === "canceled") return value;
  return "active";
};

const uniqueExistingTaskIds = (
  taskIds: ReadonlyArray<string>,
  tasksById: Readonly<Record<string, FactoryTaskRecord>>,
): ReadonlyArray<string> =>
  [...new Set(taskIds.filter((taskId) => typeof taskId === "string" && Boolean(tasksById[taskId])))];

const normalizeIntegration = (value: unknown, updatedAt: number): FactoryIntegrationRecord => {
  if (!isRecord(value)) return emptyIntegration(updatedAt);
  const prUrl = typeof value.prUrl === "string" && value.prUrl.trim().length > 0
    ? value.prUrl.trim()
    : undefined;
  const prNumber = typeof value.prNumber === "number" && Number.isFinite(value.prNumber)
    ? Math.max(0, Math.floor(value.prNumber))
    : undefined;
  const headRefName = typeof value.headRefName === "string" && value.headRefName.trim().length > 0
    ? value.headRefName.trim()
    : undefined;
  const baseRefName = typeof value.baseRefName === "string" && value.baseRefName.trim().length > 0
    ? value.baseRefName.trim()
    : undefined;
  return {
    ...emptyIntegration(updatedAt),
    ...value,
    queuedCandidateIds: Array.isArray(value.queuedCandidateIds)
      ? uniqueStrings(value.queuedCandidateIds.filter((candidateId): candidateId is string => typeof candidateId === "string"))
      : [],
    validationResults: Array.isArray(value.validationResults)
      ? value.validationResults as ReadonlyArray<FactoryCheckResult>
      : [],
    prUrl,
    prNumber,
    headRefName,
    baseRefName,
    updatedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : updatedAt,
  };
};

const normalizeScheduler = (value: unknown): FactorySchedulerRecord =>
  isRecord(value) ? value as FactorySchedulerRecord : {};

const normalizeWaitRecord = (value: unknown): FactoryWaitRecord | undefined => {
  if (!isRecord(value)) return undefined;
  const kind = value.kind === "slot"
    || value.kind === "control_reconcile"
    || value.kind === "evidence"
    || value.kind === "synthesis_dispatch"
    || value.kind === "promotion"
    ? value.kind
    : undefined;
  const owner = value.owner === "controller" || value.owner === "task" || value.owner === "integration"
    ? value.owner
    : undefined;
  const wakeCondition = value.wakeCondition === "slot_admitted"
    || value.wakeCondition === "control_pass"
    || value.wakeCondition === "evidence_captured"
    || value.wakeCondition === "synthesis_dispatched"
    || value.wakeCondition === "promotion_finished"
    ? value.wakeCondition
    : undefined;
  const reason = typeof value.reason === "string" && value.reason.trim().length > 0
    ? value.reason.trim()
    : undefined;
  const since = typeof value.since === "number" && Number.isFinite(value.since)
    ? value.since
    : undefined;
  if (!kind || !owner || !wakeCondition || !reason || since === undefined) return undefined;
  return {
    kind,
    owner,
    wakeCondition,
    reason,
    since,
  };
};

const normalizeTaskPresentation = (value: unknown): FactoryTaskPresentationRecord | undefined => {
  if (!isRecord(value)) return undefined;
  const kind = value.kind === "inline"
    || value.kind === "artifacts"
    || value.kind === "investigation_report"
    || value.kind === "generic"
    ? value.kind
    : undefined;
  if (!kind) return undefined;
  const renderHint = value.renderHint === "table"
    || value.renderHint === "report"
    || value.renderHint === "list"
    || value.renderHint === "generic"
    ? value.renderHint
    : "generic";
  const inlineBody = typeof value.inlineBody === "string" && value.inlineBody.trim().length > 0
    ? value.inlineBody.trim()
    : undefined;
  const primaryArtifactLabels = Array.isArray(value.primaryArtifactLabels)
    ? uniqueStrings(value.primaryArtifactLabels.filter((item): item is string => typeof item === "string" && item.trim().length > 0))
    : undefined;
  return {
    kind,
    renderHint,
    ...(inlineBody ? { inlineBody } : {}),
    ...(primaryArtifactLabels?.length ? { primaryArtifactLabels } : {}),
  };
};

const normalizeObjectiveHandoff = (value: unknown): FactoryObjectiveHandoffRecord | undefined => {
  if (!isRecord(value)) return undefined;
  const status = value.status === "blocked"
    || value.status === "completed"
    || value.status === "failed"
    || value.status === "canceled"
    ? value.status
    : undefined;
  const summary = typeof value.summary === "string" && value.summary.trim().length > 0
    ? value.summary.trim()
    : undefined;
  const handoffKey = typeof value.handoffKey === "string" && value.handoffKey.trim().length > 0
    ? value.handoffKey.trim()
    : undefined;
  const sourceUpdatedAt = typeof value.sourceUpdatedAt === "number" && Number.isFinite(value.sourceUpdatedAt)
    ? value.sourceUpdatedAt
    : undefined;
  if (!status || !summary || !handoffKey || sourceUpdatedAt === undefined) return undefined;
  const renderedBody = typeof value.renderedBody === "string" && value.renderedBody.trim().length > 0
    ? value.renderedBody.trim()
    : typeof value.output === "string" && value.output.trim().length > 0
      ? value.output.trim()
      : summary;
  return {
    status,
    summary,
    renderedBody,
    renderSourceHash: typeof value.renderSourceHash === "string" && value.renderSourceHash.trim().length > 0
      ? value.renderSourceHash.trim()
      : undefined,
    renderedAt: typeof value.renderedAt === "number" && Number.isFinite(value.renderedAt)
      ? value.renderedAt
      : sourceUpdatedAt,
    output: typeof value.output === "string" && value.output.trim().length > 0 ? value.output.trim() : undefined,
    blocker: typeof value.blocker === "string" && value.blocker.trim().length > 0 ? value.blocker.trim() : undefined,
    nextAction: typeof value.nextAction === "string" && value.nextAction.trim().length > 0 ? value.nextAction.trim() : undefined,
    handoffKey,
    sourceUpdatedAt,
  };
};

const normalizeInvestigation = (value: unknown): FactoryState["investigation"] => {
  if (!isRecord(value)) {
    return {
      reports: {},
      reportOrder: [],
    };
  }
  const reports = isRecord(value.reports)
    ? Object.fromEntries(
        Object.entries(value.reports)
          .filter(([, report]) => isRecord(report) && typeof report.taskId === "string")
          .map(([taskId, report]) => [taskId, {
            ...(report as FactoryInvestigationTaskReport),
            presentation: normalizeTaskPresentation((report as Record<string, unknown>).presentation),
          } satisfies FactoryInvestigationTaskReport]),
      ) as Readonly<Record<string, FactoryInvestigationTaskReport>>
    : {};
  const reportOrder = Array.isArray(value.reportOrder)
    ? uniqueStrings(value.reportOrder.filter((taskId): taskId is string => typeof taskId === "string" && Boolean(reports[taskId])))
    : [];
  return {
    reports,
    reportOrder,
    synthesized: isRecord(value.synthesized) ? value.synthesized as FactoryInvestigationSynthesisRecord : undefined,
  };
};

export const stringList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];

export const workflowTaskIds = (state: FactoryState): ReadonlyArray<string> =>
  stringList(state.workflow.taskIds);

export const workflowActiveTaskIds = (state: FactoryState): ReadonlyArray<string> =>
  stringList(state.workflow.activeTaskIds);

export const candidateOrderList = (state: FactoryState): ReadonlyArray<string> =>
  stringList(state.candidateOrder);

export const workflowTaskList = (state: FactoryState): ReadonlyArray<FactoryTaskRecord> =>
  workflowTaskIds(state)
    .map((taskId) => state.workflow.tasksById[taskId])
    .filter((task): task is FactoryTaskRecord => Boolean(task));

export const taskStatusSet = (statuses: ReadonlyArray<FactoryTaskStatus>): ReadonlySet<FactoryTaskStatus> =>
  new Set(statuses);

export const taskHasStatus = (
  task: FactoryTaskRecord,
  statuses: ReadonlySet<FactoryTaskStatus>,
): boolean => statuses.has(task.status);

export const taskDepsSatisfied = (
  state: FactoryState,
  task: FactoryTaskRecord,
  completedStatuses: ReadonlySet<FactoryTaskStatus>,
): boolean =>
  task.dependsOn.every((depId) => {
    const dependency = state.workflow.tasksById[depId];
    return Boolean(dependency) && completedStatuses.has(dependency.status);
  });

export const normalizeTaskRecord = (
  task: FactoryTaskRecord,
  defaultExecutionMode: FactoryTaskExecutionMode,
): FactoryTaskRecord => ({
  ...task,
  wait: normalizeWaitRecord(task.wait),
  executionMode: normalizeTaskExecutionMode(task.executionMode ?? defaultExecutionMode),
  executionPhase: normalizeTaskExecutionPhase(task.executionPhase),
});

export const normalizeFactoryObjectiveProfileSnapshot = (value: unknown): FactoryObjectiveProfileSnapshot => {
  if (!isRecord(value)) return DEFAULT_FACTORY_OBJECTIVE_PROFILE;
  const policyInput = isRecord(value.objectivePolicy) ? value.objectivePolicy : {};
  const actionPolicyInput = isRecord(value.actionPolicy) ? value.actionPolicy : {};
  return {
    rootProfileId: typeof value.rootProfileId === "string" && value.rootProfileId.trim()
      ? value.rootProfileId
      : DEFAULT_FACTORY_OBJECTIVE_PROFILE.rootProfileId,
    rootProfileLabel: typeof value.rootProfileLabel === "string" && value.rootProfileLabel.trim()
      ? value.rootProfileLabel
      : DEFAULT_FACTORY_OBJECTIVE_PROFILE.rootProfileLabel,
    resolvedProfileHash: typeof value.resolvedProfileHash === "string"
      ? value.resolvedProfileHash
      : DEFAULT_FACTORY_OBJECTIVE_PROFILE.resolvedProfileHash,
    promptHash: typeof value.promptHash === "string"
      ? value.promptHash
      : DEFAULT_FACTORY_OBJECTIVE_PROFILE.promptHash,
    promptPath: typeof value.promptPath === "string" && value.promptPath.trim()
      ? value.promptPath
      : DEFAULT_FACTORY_OBJECTIVE_PROFILE.promptPath,
    selectedSkills: Array.isArray(value.selectedSkills)
      ? value.selectedSkills.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : DEFAULT_FACTORY_OBJECTIVE_PROFILE.selectedSkills,
    cloudProvider: normalizeProfileCloudProvider(value.cloudProvider),
    actionPolicy: {
      allowedDispatchActions: normalizeDispatchActionList(actionPolicyInput.allowedDispatchActions),
      allowedCreateModes: Array.isArray(actionPolicyInput.allowedCreateModes)
        ? uniqueStrings(actionPolicyInput.allowedCreateModes.map((item) => normalizeObjectiveMode(item))) as ReadonlyArray<FactoryObjectiveMode>
        : DEFAULT_FACTORY_OBJECTIVE_PROFILE.actionPolicy.allowedCreateModes,
    },
    objectivePolicy: {
      allowedWorkerTypes: Array.isArray(policyInput.allowedWorkerTypes)
        ? policyInput.allowedWorkerTypes.filter((item): item is FactoryWorkerType => typeof item === "string" && item.trim().length > 0)
        : DEFAULT_FACTORY_OBJECTIVE_PROFILE.objectivePolicy.allowedWorkerTypes,
      defaultWorkerType: typeof policyInput.defaultWorkerType === "string" && policyInput.defaultWorkerType.trim()
        ? policyInput.defaultWorkerType
        : DEFAULT_FACTORY_OBJECTIVE_PROFILE.objectivePolicy.defaultWorkerType,
      defaultTaskExecutionMode: normalizeTaskExecutionMode(policyInput.defaultTaskExecutionMode),
      defaultValidationMode: policyInput.defaultValidationMode === "none"
        ? "none"
        : DEFAULT_FACTORY_OBJECTIVE_PROFILE.objectivePolicy.defaultValidationMode,
      defaultObjectiveMode: normalizeObjectiveMode(policyInput.defaultObjectiveMode),
      defaultSeverity: normalizeObjectiveSeverity(policyInput.defaultSeverity),
      maxParallelChildren: typeof policyInput.maxParallelChildren === "number" && Number.isFinite(policyInput.maxParallelChildren)
        ? Math.max(1, Math.round(policyInput.maxParallelChildren))
        : DEFAULT_FACTORY_OBJECTIVE_PROFILE.objectivePolicy.maxParallelChildren,
      allowObjectiveCreation: typeof policyInput.allowObjectiveCreation === "boolean"
        ? policyInput.allowObjectiveCreation
        : DEFAULT_FACTORY_OBJECTIVE_PROFILE.objectivePolicy.allowObjectiveCreation,
    },
  };
};

export const normalizeFactoryObjectivePolicy = (policy?: FactoryObjectivePolicy) => {
  const maxActiveTasks = clampInt(
    policy?.concurrency?.maxActiveTasks,
    1,
    50,
    DEFAULT_FACTORY_OBJECTIVE_POLICY.concurrency.maxActiveTasks,
  );
  return {
    concurrency: {
      maxActiveTasks,
    },
    budgets: {
      maxTaskRuns: clampInt(
        policy?.budgets?.maxTaskRuns,
        1,
        200,
        DEFAULT_FACTORY_OBJECTIVE_POLICY.budgets.maxTaskRuns,
      ),
      maxCandidatePassesPerTask: clampInt(
        policy?.budgets?.maxCandidatePassesPerTask,
        1,
        12,
        DEFAULT_FACTORY_OBJECTIVE_POLICY.budgets.maxCandidatePassesPerTask,
      ),
      maxObjectiveMinutes: clampInt(
        policy?.budgets?.maxObjectiveMinutes,
        1,
        10_080,
        DEFAULT_FACTORY_OBJECTIVE_POLICY.budgets.maxObjectiveMinutes,
      ),
    },
    throttles: {
      maxDispatchesPerReact: clampInt(
        policy?.throttles?.maxDispatchesPerReact,
        1,
        30,
        DEFAULT_FACTORY_OBJECTIVE_POLICY.throttles.maxDispatchesPerReact,
      ),
    },
    promotion: {
      autoPromote: typeof policy?.promotion?.autoPromote === "boolean"
        ? policy.promotion.autoPromote
        : DEFAULT_FACTORY_OBJECTIVE_POLICY.promotion.autoPromote,
    },
  };
};

export const normalizeFactoryState = (state: FactoryState): FactoryState => {
  const profile = normalizeFactoryObjectiveProfileSnapshot(state.profile);
  const candidates = isRecord(state.candidates)
    ? Object.fromEntries(
        Object.entries(state.candidates)
          .filter(([, candidate]) => isRecord(candidate) && typeof candidate.candidateId === "string")
          .map(([candidateId, candidate]) => [candidateId, {
            ...(candidate as FactoryCandidateRecord),
            presentation: normalizeTaskPresentation((candidate as Record<string, unknown>).presentation),
          } satisfies FactoryCandidateRecord]),
      ) as Readonly<Record<string, FactoryCandidateRecord>>
    : {};
  const candidateOrder = normalizeCandidateOrder(state.candidateOrder, candidates);

  const currentWorkflow = isRecord(state.workflow) ? state.workflow : undefined;
  const taskNodes = isRecord(currentWorkflow?.tasksById)
    ? currentWorkflow.tasksById
    : {};
  const tasksById = Object.fromEntries(
    Object.entries(taskNodes)
      .filter(([, task]) => isRecord(task) && typeof task.taskId === "string")
      .map(([taskId, task]) => [taskId, normalizeTaskRecord(task as FactoryTaskRecord, profile.objectivePolicy.defaultTaskExecutionMode)]),
  ) as Readonly<Record<string, FactoryTaskRecord>>;
  const orderedTaskIds = Array.isArray(currentWorkflow?.taskIds)
    ? currentWorkflow.taskIds.filter((taskId): taskId is string => typeof taskId === "string")
    : [];
  const taskIds = uniqueExistingTaskIds(orderedTaskIds, tasksById);
  const activeTaskIds = uniqueExistingTaskIds(
    Array.isArray(currentWorkflow?.activeTaskIds)
      ? currentWorkflow.activeTaskIds.filter((taskId): taskId is string => typeof taskId === "string")
      : [],
    tasksById,
  );
  const workflowUpdatedAt = typeof currentWorkflow?.updatedAt === "number" && Number.isFinite(currentWorkflow.updatedAt)
    ? currentWorkflow.updatedAt
    : state.updatedAt;
  return {
    ...initialFactoryState,
    ...state,
    profile,
    wait: normalizeWaitRecord(state.wait),
    candidates,
    candidateOrder,
    workflow: {
      objectiveId: state.objectiveId,
      status: normalizeWorkflowStatus(currentWorkflow?.status),
      activeTaskIds,
      taskIds,
      tasksById,
      updatedAt: workflowUpdatedAt,
    },
    integration: normalizeIntegration(state.integration, state.updatedAt),
    scheduler: normalizeScheduler(state.scheduler),
    investigation: normalizeInvestigation(state.investigation),
    latestHandoff: normalizeObjectiveHandoff(state.latestHandoff),
    candidatePassesByTask: isRecord(state.candidatePassesByTask) ? state.candidatePassesByTask : {},
    consecutiveFailuresByTask: isRecord(state.consecutiveFailuresByTask) ? state.consecutiveFailuresByTask : {},
    checks: Array.isArray(state.checks) ? state.checks.filter((check): check is string => typeof check === "string") : [],
    sourceWarnings: Array.isArray(state.sourceWarnings)
      ? state.sourceWarnings.filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0)
      : [],
  };
};
