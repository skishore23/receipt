import type { Decide, Reducer } from "@receipt/core/types";
import { CONTROL_RECEIPT_TYPES } from "../engine/runtime/control-receipts";
import { type GraphRef } from "@receipt/core/graph";

export type FactoryObjectiveStatus =
  | "planning"
  | "executing"
  | "integrating"
  | "promoting"
  | "completed"
  | "blocked"
  | "failed"
  | "canceled";

export type FactoryTaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "reviewing"
  | "approved"
  | "integrated"
  | "blocked"
  | "superseded";

export type FactoryCandidateStatus =
  | "planned"
  | "running"
  | "awaiting_review"
  | "changes_requested"
  | "approved"
  | "integrated"
  | "rejected"
  | "conflicted";

export type FactoryIntegrationStatus =
  | "idle"
  | "queued"
  | "merging"
  | "validating"
  | "validated"
  | "ready_to_promote"
  | "promoting"
  | "promoted"
  | "conflicted";

export type FactoryWorkerType =
  | "codex"
  | "agent"
  | "infra"
  | string;

export type FactoryObjectiveMode =
  | "delivery"
  | "investigation";

export type FactoryObjectiveSeverity =
  | 1
  | 2
  | 3
  | 4
  | 5;

export type FactoryProfileCloudProvider = "aws" | "gcp" | "azure";

export type FactoryInvestigationEvidence = {
  readonly title: string;
  readonly summary: string;
  readonly detail?: string;
};

export type FactoryInvestigationScriptRun = {
  readonly command: string;
  readonly summary?: string;
  readonly status?: "ok" | "warning" | "error";
};

export type FactoryInvestigationReport = {
  readonly conclusion: string;
  readonly evidence: ReadonlyArray<FactoryInvestigationEvidence>;
  readonly scriptsRun: ReadonlyArray<FactoryInvestigationScriptRun>;
  readonly disagreements: ReadonlyArray<string>;
  readonly nextSteps: ReadonlyArray<string>;
};

export type FactoryInvestigationTaskReport = {
  readonly taskId: string;
  readonly candidateId: string;
  readonly summary: string;
  readonly handoff: string;
  readonly report: FactoryInvestigationReport;
  readonly artifactRefs: Readonly<Record<string, GraphRef>>;
  readonly evidenceCommit?: string;
  readonly reportedAt: number;
};

export type FactoryInvestigationSynthesisRecord = {
  readonly summary: string;
  readonly report: FactoryInvestigationReport;
  readonly taskIds: ReadonlyArray<string>;
  readonly synthesizedAt: number;
};

export type FactoryTaskExecutionMode = "worktree" | "isolated";

export type FactoryObjectiveProfilePolicy = {
  readonly allowedWorkerTypes: ReadonlyArray<FactoryWorkerType>;
  readonly defaultWorkerType: FactoryWorkerType;
  readonly defaultTaskExecutionMode: FactoryTaskExecutionMode;
  readonly defaultValidationMode: "repo_profile" | "none";
  readonly defaultObjectiveMode: FactoryObjectiveMode;
  readonly defaultSeverity: FactoryObjectiveSeverity;
  readonly maxParallelChildren: number;
  readonly allowObjectiveCreation: boolean;
};

export type FactoryObjectiveProfileSnapshot = {
  readonly rootProfileId: string;
  readonly rootProfileLabel: string;
  readonly resolvedProfileHash: string;
  readonly promptHash: string;
  readonly promptPath: string;
  readonly selectedSkills: ReadonlyArray<string>;
  readonly cloudProvider?: FactoryProfileCloudProvider;
  readonly objectivePolicy: FactoryObjectiveProfilePolicy;
};

export type FactoryObjectivePhase =
  | "planning"
  | "waiting_for_slot"
  | "executing"
  | "integrating"
  | "promoting"
  | "completed"
  | "blocked";

export type FactoryObjectiveSlotState = "queued" | "active" | "released";

export type FactoryObjectivePolicy = {
  readonly concurrency?: {
    readonly maxActiveTasks?: number;
  };
  readonly budgets?: {
    readonly maxTaskRuns?: number;
    readonly maxCandidatePassesPerTask?: number;
    readonly maxObjectiveMinutes?: number;
  };
  readonly throttles?: {
    readonly maxDispatchesPerReact?: number;
  };
  readonly promotion?: {
    readonly autoPromote?: boolean;
  };
};

export type FactoryNormalizedObjectivePolicy = {
  readonly concurrency: {
    readonly maxActiveTasks: number;
  };
  readonly budgets: {
    readonly maxTaskRuns: number;
    readonly maxCandidatePassesPerTask: number;
    readonly maxObjectiveMinutes: number;
  };
  readonly throttles: {
    readonly maxDispatchesPerReact: number;
  };
  readonly promotion: {
    readonly autoPromote: boolean;
  };
};

export type FactoryBudgetState = {
  readonly taskRunsUsed: number;
  readonly candidatePassesByTask: Readonly<Record<string, number>>;
  readonly consecutiveFailuresByTask: Readonly<Record<string, number>>;
  readonly elapsedMinutes: number;
  readonly lastDispatchAt?: number;
  readonly policyBlockedReason?: string;
};

export type FactorySchedulerRecord = {
  readonly slotState?: FactoryObjectiveSlotState;
  readonly queuedAt?: number;
  readonly admittedAt?: number;
  readonly releasedAt?: number;
  readonly releaseReason?: string;
};

export type FactoryCheckResult = {
  readonly command: string;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: number;
  readonly finishedAt: number;
};

export type FactoryRebracketRecord = {
  readonly frontierTaskIds: ReadonlyArray<string>;
  readonly selectedActionId?: string;
  readonly reason: string;
  readonly confidence?: number;
  readonly source: "orchestrator" | "fallback" | "runtime";
  readonly appliedAt: number;
  readonly basedOn?: string;
};

export type FactoryTaskRecord = {
  readonly nodeId: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly status: FactoryTaskStatus;
  readonly taskId: string;
  readonly taskKind: "planned";
  readonly title: string;
  readonly prompt: string;
  readonly workerType: FactoryWorkerType;
  readonly executionMode?: FactoryTaskExecutionMode;
  readonly sourceTaskId?: string;
  readonly baseCommit: string;
  readonly latestSummary?: string;
  readonly latestTraceSummary?: string;
  readonly blockedReason?: string;
  readonly candidateId?: string;
  readonly workspaceId?: string;
  readonly workspacePath?: string;
  readonly jobId?: string;
  readonly skillBundlePaths: ReadonlyArray<string>;
  readonly contextRefs: ReadonlyArray<GraphRef>;
  readonly artifactRefs: Readonly<Record<string, GraphRef>>;
  readonly basedOn?: string;
  readonly createdAt: number;
  readonly readyAt?: number;
  readonly startedAt?: number;
  readonly reviewingAt?: number;
  readonly completedAt?: number;
};

export type FactoryCandidateRecord = {
  readonly candidateId: string;
  readonly taskId: string;
  readonly status: FactoryCandidateStatus;
  readonly parentCandidateId?: string;
  readonly baseCommit: string;
  readonly headCommit?: string;
  readonly summary?: string;
  readonly handoff?: string;
  readonly checkResults: ReadonlyArray<FactoryCheckResult>;
  readonly artifactRefs: Readonly<Record<string, GraphRef>>;
  readonly latestReason?: string;
  readonly tokensUsed?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly approvedAt?: number;
  readonly integratedAt?: number;
  readonly conflictReason?: string;
};

export type FactoryWorkflowStatus =
  | "active"
  | "completed"
  | "blocked"
  | "failed"
  | "canceled";

export type FactoryIntegrationRecord = {
  readonly status: FactoryIntegrationStatus;
  readonly branchName?: string;
  readonly branchRef?: GraphRef;
  readonly headCommit?: string;
  readonly queuedCandidateIds: ReadonlyArray<string>;
  readonly activeCandidateId?: string;
  readonly validationResults: ReadonlyArray<FactoryCheckResult>;
  readonly lastSummary?: string;
  readonly conflictReason?: string;
  readonly promotedCommit?: string;
  readonly updatedAt: number;
};

export type FactoryWorkflowState = {
  readonly objectiveId: string;
  readonly status: FactoryWorkflowStatus;
  readonly activeTaskIds: ReadonlyArray<string>;
  readonly taskIds: ReadonlyArray<string>;
  readonly tasksById: Readonly<Record<string, FactoryTaskRecord>>;
  readonly updatedAt: number;
};

export type FactoryState = {
  readonly objectiveId: string;
  readonly title: string;
  readonly prompt: string;
  readonly channel: string;
  readonly baseHash: string;
  readonly objectiveMode: FactoryObjectiveMode;
  readonly severity: FactoryObjectiveSeverity;
  readonly checks: ReadonlyArray<string>;
  readonly checksSource: "explicit" | "profile" | "default";
  readonly profile: FactoryObjectiveProfileSnapshot;
  readonly policy: FactoryNormalizedObjectivePolicy;
  readonly status: FactoryObjectiveStatus;
  readonly archivedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly taskRunsUsed: number;
  readonly candidatePassesByTask: Readonly<Record<string, number>>;
  readonly consecutiveFailuresByTask: Readonly<Record<string, number>>;
  readonly lastDispatchAt?: number;
  readonly candidates: Readonly<Record<string, FactoryCandidateRecord>>;
  readonly candidateOrder: ReadonlyArray<string>;
  readonly workflow: FactoryWorkflowState;
  readonly integration: FactoryIntegrationRecord;
  readonly scheduler: FactorySchedulerRecord;
  readonly investigation: {
    readonly reports: Readonly<Record<string, FactoryInvestigationTaskReport>>;
    readonly reportOrder: ReadonlyArray<string>;
    readonly synthesized?: FactoryInvestigationSynthesisRecord;
  };
  readonly latestRebracket?: FactoryRebracketRecord;
};

export type FactoryProjection = {
  readonly objectiveId: string;
  readonly title: string;
  readonly status: FactoryObjectiveStatus;
  readonly archivedAt?: number;
  readonly updatedAt: number;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly activeTasks: ReadonlyArray<FactoryTaskRecord>;
  readonly readyTasks: ReadonlyArray<FactoryTaskRecord>;
  readonly pendingTasks: ReadonlyArray<FactoryTaskRecord>;
  readonly completedTasks: ReadonlyArray<FactoryTaskRecord>;
  readonly blockedTasks: ReadonlyArray<FactoryTaskRecord>;
  readonly tasks: ReadonlyArray<FactoryTaskRecord>;
  readonly candidates: ReadonlyArray<FactoryCandidateRecord>;
  readonly integration: FactoryIntegrationRecord;
};

export const FACTORY_TASK_WORKFLOW_BUCKETS = {
  planned: ["pending"],
  ready: ["ready"],
  active: ["running", "reviewing"],
  completed: ["approved", "integrated", "superseded"],
  blocked: ["blocked"],
  terminal: ["approved", "integrated", "blocked", "superseded"],
} as const;

export const DEFAULT_FACTORY_OBJECTIVE_POLICY: FactoryNormalizedObjectivePolicy = {
  concurrency: {
    maxActiveTasks: 4,
  },
  budgets: {
    maxTaskRuns: 50,
    maxCandidatePassesPerTask: 4,
    maxObjectiveMinutes: 1_440,
  },
  throttles: {
    maxDispatchesPerReact: 4,
  },
  promotion: {
    autoPromote: true,
  },
};

export const DEFAULT_FACTORY_OBJECTIVE_PROFILE: FactoryObjectiveProfileSnapshot = {
  rootProfileId: "generalist",
  rootProfileLabel: "Generalist",
  resolvedProfileHash: "",
  promptHash: "",
  promptPath: "profiles/generalist/PROFILE.md",
  selectedSkills: [],
  objectivePolicy: {
    allowedWorkerTypes: ["codex", "infra", "agent"],
    defaultWorkerType: "codex",
    defaultTaskExecutionMode: "worktree",
    defaultValidationMode: "repo_profile",
    defaultObjectiveMode: "delivery",
    defaultSeverity: 1,
    maxParallelChildren: 1,
    allowObjectiveCreation: true,
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeObjectiveMode = (value: unknown): FactoryObjectiveMode =>
  value === "investigation" ? "investigation" : "delivery";

const normalizeTaskExecutionMode = (value: unknown): FactoryTaskExecutionMode =>
  value === "isolated" ? "isolated" : "worktree";

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

export const normalizeFactoryObjectiveProfileSnapshot = (value: unknown): FactoryObjectiveProfileSnapshot => {
  if (!isRecord(value)) return DEFAULT_FACTORY_OBJECTIVE_PROFILE;
  const policyInput = isRecord(value.objectivePolicy) ? value.objectivePolicy : {};
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

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
};

export const normalizeFactoryObjectivePolicy = (
  policy?: FactoryObjectivePolicy,
): FactoryNormalizedObjectivePolicy => {
  const maxActiveTasks = clampInt(
    policy?.concurrency?.maxActiveTasks,
    1,
    8,
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
        8,
        maxActiveTasks,
      ),
    },
    promotion: {
      autoPromote: typeof policy?.promotion?.autoPromote === "boolean"
        ? policy.promotion.autoPromote
        : DEFAULT_FACTORY_OBJECTIVE_POLICY.promotion.autoPromote,
    },
  };
};

const emptyIntegration = (ts: number): FactoryIntegrationRecord => ({
  status: "idle",
  queuedCandidateIds: [],
  validationResults: [],
  updatedAt: ts,
});

const createFactoryWorkflowState = (
  objectiveId: string,
  updatedAt: number,
  status: FactoryWorkflowStatus = "active",
): FactoryWorkflowState => ({
  objectiveId,
  status,
  activeTaskIds: [],
  taskIds: [],
  tasksById: {},
  updatedAt,
});

const taskStatusSet = (statuses: ReadonlyArray<FactoryTaskStatus>): ReadonlySet<FactoryTaskStatus> =>
  new Set(statuses);

const taskHasStatus = (task: FactoryTaskRecord, statuses: ReadonlySet<FactoryTaskStatus>): boolean =>
  statuses.has(task.status);

const stringList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];

const workflowTaskIds = (state: FactoryState): ReadonlyArray<string> =>
  stringList(state.workflow.taskIds);

const workflowActiveTaskIds = (state: FactoryState): ReadonlyArray<string> =>
  stringList(state.workflow.activeTaskIds);

const candidateOrderList = (state: FactoryState): ReadonlyArray<string> =>
  uniqueStrings([
    ...stringList(state.candidateOrder),
    ...Object.keys(state.candidates),
  ]);

const workflowTaskList = (state: FactoryState): ReadonlyArray<FactoryTaskRecord> =>
  (workflowTaskIds(state).length > 0 ? workflowTaskIds(state) : Object.keys(state.workflow.tasksById))
    .map((taskId) => state.workflow.tasksById[taskId])
    .filter((task): task is FactoryTaskRecord => Boolean(task));

const taskDepsSatisfied = (
  state: FactoryState,
  task: FactoryTaskRecord,
  completedStatuses: ReadonlySet<FactoryTaskStatus>,
): boolean =>
  task.dependsOn.every((depId) => {
    const dependency = state.workflow.tasksById[depId];
    return Boolean(dependency) && completedStatuses.has(dependency.status);
  });

const FACTORY_TASK_STATUS_SETS = {
  planned: taskStatusSet(FACTORY_TASK_WORKFLOW_BUCKETS.planned),
  ready: taskStatusSet(FACTORY_TASK_WORKFLOW_BUCKETS.ready),
  active: taskStatusSet(FACTORY_TASK_WORKFLOW_BUCKETS.active),
  completed: taskStatusSet(FACTORY_TASK_WORKFLOW_BUCKETS.completed),
  blocked: taskStatusSet(FACTORY_TASK_WORKFLOW_BUCKETS.blocked),
  terminal: taskStatusSet(FACTORY_TASK_WORKFLOW_BUCKETS.terminal),
} as const;

const normalizeWorkflowStatus = (value: unknown): FactoryWorkflowStatus => {
  if (value === "completed" || value === "blocked" || value === "failed" || value === "canceled") return value;
  return "active";
};

const uniqueExistingTaskIds = (
  taskIds: ReadonlyArray<string>,
  tasksById: Readonly<Record<string, FactoryTaskRecord>>,
): ReadonlyArray<string> =>
  [...new Set(taskIds.filter((taskId) => typeof taskId === "string" && Boolean(tasksById[taskId])))];

const uniqueStrings = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];

const normalizeCandidateOrder = (
  candidateOrder: unknown,
  candidates: Readonly<Record<string, FactoryCandidateRecord>>,
): ReadonlyArray<string> => {
  const ordered = Array.isArray(candidateOrder)
    ? candidateOrder.filter((candidateId): candidateId is string => typeof candidateId === "string" && Boolean(candidates[candidateId]))
    : [];
  const allIds = Object.keys(candidates);
  return uniqueStrings([...ordered, ...allIds]);
};

const normalizeIntegration = (value: unknown, updatedAt: number): FactoryIntegrationRecord => {
  if (!isRecord(value)) return emptyIntegration(updatedAt);
  return {
    ...emptyIntegration(updatedAt),
    ...value,
    queuedCandidateIds: Array.isArray(value.queuedCandidateIds)
      ? uniqueStrings(value.queuedCandidateIds.filter((candidateId): candidateId is string => typeof candidateId === "string"))
      : [],
    validationResults: Array.isArray(value.validationResults)
      ? value.validationResults as ReadonlyArray<FactoryCheckResult>
      : [],
    updatedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : updatedAt,
  };
};

const normalizeScheduler = (value: unknown): FactorySchedulerRecord =>
  isRecord(value) ? value as FactorySchedulerRecord : {};

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
          .filter(([, report]) => isRecord(report) && typeof report.taskId === "string"),
      ) as Readonly<Record<string, FactoryInvestigationTaskReport>>
    : {};
  const reportOrder = Array.isArray(value.reportOrder)
    ? uniqueStrings(value.reportOrder.filter((taskId): taskId is string => typeof taskId === "string" && Boolean(reports[taskId])))
    : Object.keys(reports);
  const synthesized = isRecord(value.synthesized) ? value.synthesized as FactoryInvestigationSynthesisRecord : undefined;
  return {
    reports,
    reportOrder,
    synthesized,
  };
};

export const normalizeFactoryState = (state: FactoryState): FactoryState => {
  const profile = normalizeFactoryObjectiveProfileSnapshot(state.profile);
  const candidates = isRecord(state.candidates)
    ? Object.fromEntries(
        Object.entries(state.candidates)
          .filter(([, candidate]) => isRecord(candidate) && typeof candidate.candidateId === "string"),
      ) as Readonly<Record<string, FactoryCandidateRecord>>
    : {};
  const candidateOrder = normalizeCandidateOrder(state.candidateOrder, candidates);

  const legacy = state as FactoryState & {
    readonly taskOrder?: unknown;
    readonly graph?: {
      readonly status?: unknown;
      readonly activeNodeIds?: unknown;
      readonly order?: unknown;
      readonly nodes?: unknown;
      readonly updatedAt?: unknown;
    };
  };
  const currentWorkflow = isRecord(state.workflow) ? state.workflow : undefined;
  const taskNodes = isRecord(currentWorkflow?.tasksById)
    ? currentWorkflow.tasksById
    : isRecord(legacy.graph?.nodes)
      ? legacy.graph.nodes
      : {};
  const tasksById = Object.fromEntries(
    Object.entries(taskNodes)
      .filter(([, task]) => isRecord(task) && typeof task.taskId === "string")
      .map(([taskId, task]) => [taskId, normalizeTaskRecord(task as FactoryTaskRecord, profile.objectivePolicy.defaultTaskExecutionMode)]),
  ) as Readonly<Record<string, FactoryTaskRecord>>;
  const orderedTaskIds = Array.isArray(currentWorkflow?.taskIds)
    ? currentWorkflow.taskIds.filter((taskId): taskId is string => typeof taskId === "string")
    : Array.isArray(legacy.taskOrder)
      ? legacy.taskOrder.filter((taskId): taskId is string => typeof taskId === "string")
      : Array.isArray(legacy.graph?.order)
        ? legacy.graph.order.filter((taskId): taskId is string => typeof taskId === "string")
        : Object.keys(tasksById);
  const taskIds = uniqueExistingTaskIds(orderedTaskIds, tasksById);
  const activeTaskIds = uniqueExistingTaskIds(
    Array.isArray(currentWorkflow?.activeTaskIds)
      ? currentWorkflow.activeTaskIds.filter((taskId): taskId is string => typeof taskId === "string")
      : Array.isArray(legacy.graph?.activeNodeIds)
        ? legacy.graph.activeNodeIds.filter((taskId): taskId is string => typeof taskId === "string")
        : [],
    tasksById,
  );
  const workflowUpdatedAt = typeof currentWorkflow?.updatedAt === "number" && Number.isFinite(currentWorkflow.updatedAt)
    ? currentWorkflow.updatedAt
    : typeof legacy.graph?.updatedAt === "number" && Number.isFinite(legacy.graph.updatedAt)
      ? legacy.graph.updatedAt
      : state.updatedAt;
  const workflowStatus = normalizeWorkflowStatus(currentWorkflow?.status ?? legacy.graph?.status);
  return {
    ...initialFactoryState,
    ...state,
    profile,
    candidates,
    candidateOrder,
    workflow: {
      objectiveId: state.objectiveId,
      status: workflowStatus,
      activeTaskIds,
      taskIds,
      tasksById,
      updatedAt: workflowUpdatedAt,
    },
    integration: normalizeIntegration(state.integration, state.updatedAt),
    scheduler: normalizeScheduler(state.scheduler),
    investigation: normalizeInvestigation(state.investigation),
    candidatePassesByTask: isRecord(state.candidatePassesByTask) ? state.candidatePassesByTask : {},
    consecutiveFailuresByTask: isRecord(state.consecutiveFailuresByTask) ? state.consecutiveFailuresByTask : {},
    checks: Array.isArray(state.checks) ? state.checks.filter((check): check is string => typeof check === "string") : [],
  };
};

const updateTask = (
  state: FactoryState,
  taskId: string,
  patch: Partial<FactoryTaskRecord>,
): FactoryState => {
  const current = state.workflow.tasksById[taskId];
  if (!current) return state;
  return {
    ...state,
    workflow: {
      ...state.workflow,
      tasksById: {
        ...state.workflow.tasksById,
        [taskId]: {
          ...current,
          ...patch,
        },
      },
    },
  };
};

const normalizeTaskRecord = (
  task: FactoryTaskRecord,
  defaultExecutionMode: FactoryTaskExecutionMode,
): FactoryTaskRecord => ({
  ...task,
  executionMode: normalizeTaskExecutionMode(task.executionMode ?? defaultExecutionMode),
});

const upsertTask = (
  state: FactoryState,
  task: FactoryTaskRecord,
): FactoryState => ({
  ...state,
  workflow: {
    ...state.workflow,
    taskIds: workflowTaskIds(state).includes(task.taskId)
      ? workflowTaskIds(state)
      : [...workflowTaskIds(state), task.taskId],
    tasksById: {
      ...state.workflow.tasksById,
      [task.taskId]: normalizeTaskRecord(task, state.profile.objectivePolicy.defaultTaskExecutionMode),
    },
  },
});

const updateCandidate = (
  state: FactoryState,
  candidateId: string,
  patch: Partial<FactoryCandidateRecord>,
): FactoryState => {
  const current = state.candidates[candidateId];
  if (!current) return state;
  return {
    ...state,
    candidates: {
      ...state.candidates,
      [candidateId]: {
        ...current,
        ...patch,
      },
    },
  };
};

const latestTaskCandidate = (
  state: FactoryState,
  taskId: string,
): FactoryCandidateRecord | undefined => {
  const orderedCandidates = candidateOrderList(state);
  for (let index = orderedCandidates.length - 1; index >= 0; index -= 1) {
    const candidateId = orderedCandidates[index];
    const candidate = state.candidates[candidateId];
    if (candidate?.taskId === taskId) return candidate;
  }
  return undefined;
};

const upsertCandidate = (
  state: FactoryState,
  candidate: FactoryCandidateRecord,
): FactoryState => ({
  ...state,
  candidates: {
    ...state.candidates,
    [candidate.candidateId]: candidate,
  },
  candidateOrder: candidateOrderList(state).includes(candidate.candidateId)
    ? candidateOrderList(state)
    : [...candidateOrderList(state), candidate.candidateId],
});

const setWorkflowStatus = (
  state: FactoryState,
  ts: number,
  status: FactoryWorkflowStatus = state.workflow.status,
): FactoryState => ({
  ...state,
  updatedAt: ts,
  workflow: {
    ...state.workflow,
    status,
    updatedAt: ts,
  },
});

const setActiveTaskIds = (state: FactoryState, activeTaskIds: ReadonlyArray<string>, ts: number): FactoryState => ({
  ...state,
  updatedAt: ts,
  workflow: {
    ...state.workflow,
    activeTaskIds: [...new Set(stringList(activeTaskIds).filter((taskId) => Boolean(state.workflow.tasksById[taskId])))],
    updatedAt: ts,
  },
});

export const factoryTaskList = (state: FactoryState): ReadonlyArray<FactoryTaskRecord> =>
  workflowTaskList(state);

export const factoryReadyTasks = (state: FactoryState): ReadonlyArray<FactoryTaskRecord> =>
  workflowTaskList(state).filter((task) =>
    !workflowActiveTaskIds(state).includes(task.taskId)
    && taskHasStatus(task, FACTORY_TASK_STATUS_SETS.ready)
    && taskDepsSatisfied(state, task, FACTORY_TASK_STATUS_SETS.completed)
  );

export const factoryActivatableTasks = (state: FactoryState): ReadonlyArray<FactoryTaskRecord> =>
  workflowTaskList(state).filter((task) =>
    !workflowActiveTaskIds(state).includes(task.taskId)
    && taskHasStatus(task, FACTORY_TASK_STATUS_SETS.planned)
    && taskDepsSatisfied(state, task, FACTORY_TASK_STATUS_SETS.completed)
  );

export const buildFactoryProjection = (state: FactoryState): FactoryProjection => {
  const tasks = workflowTaskList(state);
  const objectiveStopsLiveTaskCounts =
    state.status === "blocked"
    || state.status === "failed"
    || state.status === "canceled"
    || state.status === "completed";
  return {
    objectiveId: state.objectiveId,
    title: state.title,
    status: state.status,
    archivedAt: state.archivedAt,
    updatedAt: state.updatedAt,
    latestSummary: state.latestSummary,
    blockedReason: state.blockedReason,
    activeTasks: objectiveStopsLiveTaskCounts
      ? []
      : tasks.filter((task) =>
          workflowActiveTaskIds(state).includes(task.taskId) || taskHasStatus(task, FACTORY_TASK_STATUS_SETS.active)
        ),
    readyTasks: objectiveStopsLiveTaskCounts
      ? []
      : tasks.filter((task) => taskHasStatus(task, FACTORY_TASK_STATUS_SETS.ready)),
    pendingTasks: tasks.filter((task) => taskHasStatus(task, FACTORY_TASK_STATUS_SETS.planned)),
    completedTasks: tasks.filter((task) => taskHasStatus(task, FACTORY_TASK_STATUS_SETS.completed)),
    blockedTasks: tasks.filter((task) => taskHasStatus(task, FACTORY_TASK_STATUS_SETS.blocked)),
    tasks,
    candidates: candidateOrderList(state)
      .map((candidateId) => state.candidates[candidateId])
      .filter((candidate): candidate is FactoryCandidateRecord => Boolean(candidate)),
    integration: state.integration,
  };
};

export type FactoryEvent =
  | {
      readonly type: "objective.created";
      readonly objectiveId: string;
      readonly title: string;
      readonly prompt: string;
      readonly channel: string;
      readonly baseHash: string;
      readonly objectiveMode: FactoryObjectiveMode;
      readonly severity: FactoryObjectiveSeverity;
      readonly checks: ReadonlyArray<string>;
      readonly checksSource: "explicit" | "profile" | "default";
      readonly profile: FactoryObjectiveProfileSnapshot;
      readonly policy: FactoryNormalizedObjectivePolicy;
      readonly createdAt: number;
    }
  | {
      readonly type: "objective.operator.noted";
      readonly objectiveId: string;
      readonly message: string;
      readonly notedAt: number;
    }
  | {
      readonly type: "objective.slot.queued";
      readonly objectiveId: string;
      readonly queuedAt: number;
    }
  | {
      readonly type: "objective.slot.admitted";
      readonly objectiveId: string;
      readonly admittedAt: number;
    }
  | {
      readonly type: "objective.slot.released";
      readonly objectiveId: string;
      readonly releasedAt: number;
      readonly reason: string;
    }
  | {
      readonly type: "task.added";
      readonly objectiveId: string;
      readonly task: FactoryTaskRecord;
      readonly createdAt: number;
    }
  | {
      readonly type: "task.ready";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly readyAt: number;
    }
  | {
      readonly type: "task.dispatched";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly candidateId: string;
      readonly jobId: string;
      readonly workspaceId: string;
      readonly workspacePath: string;
      readonly skillBundlePaths: ReadonlyArray<string>;
      readonly contextRefs: ReadonlyArray<GraphRef>;
      readonly startedAt: number;
    }
  | {
      readonly type: "task.review.requested";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly reviewRequestedAt: number;
    }
  | {
      readonly type: "task.approved";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly summary: string;
      readonly approvedAt: number;
    }
  | {
      readonly type: "task.integrated";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly summary: string;
      readonly integratedAt: number;
    }
  | {
      readonly type: "task.blocked";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly reason: string;
      readonly blockedAt: number;
    }
  | {
      readonly type: "task.unblocked";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly readyAt: number;
    }
  | {
      readonly type: "task.superseded";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly reason: string;
      readonly supersededAt: number;
    }
  | {
      readonly type: "candidate.created";
      readonly objectiveId: string;
      readonly candidate: FactoryCandidateRecord;
      readonly createdAt: number;
    }
  | {
      readonly type: "candidate.produced";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly taskId: string;
      readonly headCommit: string;
      readonly summary: string;
      readonly handoff: string;
      readonly checkResults: ReadonlyArray<FactoryCheckResult>;
      readonly artifactRefs: Readonly<Record<string, GraphRef>>;
      readonly tokensUsed?: number;
      readonly producedAt: number;
    }
  | {
      readonly type: "candidate.reviewed";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly taskId: string;
      readonly status: Extract<FactoryCandidateStatus, "changes_requested" | "approved" | "rejected">;
      readonly summary: string;
      readonly handoff: string;
      readonly reviewedAt: number;
    }
  | {
      readonly type: "investigation.reported";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly candidateId: string;
      readonly summary: string;
      readonly handoff: string;
      readonly report: FactoryInvestigationReport;
      readonly artifactRefs: Readonly<Record<string, GraphRef>>;
      readonly evidenceCommit?: string;
      readonly reportedAt: number;
    }
  | {
      readonly type: "investigation.synthesized";
      readonly objectiveId: string;
      readonly summary: string;
      readonly report: FactoryInvestigationReport;
      readonly taskIds: ReadonlyArray<string>;
      readonly synthesizedAt: number;
    }
  | {
      readonly type: "candidate.conflicted";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly reason: string;
      readonly conflictedAt: number;
    }
  | {
      readonly type: "rebracket.applied";
      readonly objectiveId: string;
      readonly frontierTaskIds: ReadonlyArray<string>;
      readonly selectedActionId?: string;
      readonly reason: string;
      readonly confidence?: number;
      readonly source: "orchestrator" | "fallback" | "runtime";
      readonly basedOn?: string;
      readonly appliedAt: number;
    }
  | {
      readonly type: "merge.applied";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly taskId: string;
      readonly summary: string;
      readonly mergeCommit: string;
      readonly appliedAt: number;
    }
  | {
      readonly type: "integration.queued";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly branchName: string;
      readonly branchRef?: GraphRef;
      readonly queuedAt: number;
    }
  | {
      readonly type: "integration.merging";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly startedAt: number;
    }
  | {
      readonly type: "integration.validating";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly startedAt: number;
    }
  | {
      readonly type: "integration.validated";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly headCommit: string;
      readonly validationResults: ReadonlyArray<FactoryCheckResult>;
      readonly summary: string;
      readonly validatedAt: number;
    }
  | {
      readonly type: "integration.ready_to_promote";
      readonly objectiveId: string;
      readonly headCommit: string;
      readonly summary: string;
      readonly readyAt: number;
    }
  | {
      readonly type: "integration.promoting";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly startedAt: number;
    }
  | {
      readonly type: "integration.promoted";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly promotedCommit: string;
      readonly summary: string;
      readonly promotedAt: number;
    }
  | {
      readonly type: "integration.conflicted";
      readonly objectiveId: string;
      readonly candidateId?: string;
      readonly reason: string;
      readonly headCommit?: string;
      readonly conflictedAt: number;
    }
  | {
      readonly type: "objective.completed";
      readonly objectiveId: string;
      readonly summary: string;
      readonly completedAt: number;
    }
  | {
      readonly type: "objective.blocked";
      readonly objectiveId: string;
      readonly reason: string;
      readonly summary: string;
      readonly blockedAt: number;
    }
  | {
      readonly type: "objective.failed";
      readonly objectiveId: string;
      readonly reason: string;
      readonly failedAt: number;
    }
  | {
      readonly type: "objective.canceled";
      readonly objectiveId: string;
      readonly reason?: string;
      readonly canceledAt: number;
    }
  | {
      readonly type: "objective.archived";
      readonly objectiveId: string;
      readonly archivedAt: number;
    };

export type FactoryCmd = {
  readonly type: "emit";
  readonly event?: FactoryEvent;
  readonly events?: ReadonlyArray<FactoryEvent>;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export const initialFactoryState: FactoryState = {
  objectiveId: "",
  title: "",
  prompt: "",
  channel: "results",
  baseHash: "",
  objectiveMode: "delivery",
  severity: 1,
  checks: [],
  checksSource: "default",
  profile: DEFAULT_FACTORY_OBJECTIVE_PROFILE,
  policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
  status: "planning",
  archivedAt: undefined,
  createdAt: 0,
  updatedAt: 0,
  taskRunsUsed: 0,
  candidatePassesByTask: {},
  consecutiveFailuresByTask: {},
  lastDispatchAt: undefined,
  candidates: {},
  candidateOrder: [],
  workflow: createFactoryWorkflowState("", 0),
  integration: emptyIntegration(0),
  scheduler: {},
  investigation: {
    reports: {},
    reportOrder: [],
  },
};

export const decideFactory: Decide<FactoryCmd, FactoryEvent> = (cmd) => {
  if (cmd.events?.length) return [...cmd.events];
  return cmd.event ? [cmd.event] : [];
};

export const reduceFactory: Reducer<FactoryState, FactoryEvent> = (state, event) => {
  state = normalizeFactoryState(state);
  if (CONTROL_RECEIPT_TYPES.has(event.type as never)) return state;
  switch (event.type) {
    case "objective.created":
      return {
        objectiveId: event.objectiveId,
        title: event.title,
        prompt: event.prompt,
        channel: event.channel,
        baseHash: event.baseHash,
        objectiveMode: event.objectiveMode,
        severity: event.severity,
        checks: event.checks,
        checksSource: event.checksSource,
        profile: normalizeFactoryObjectiveProfileSnapshot(event.profile),
        policy: event.policy,
        status: "planning",
        archivedAt: undefined,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        taskRunsUsed: 0,
        candidatePassesByTask: {},
        consecutiveFailuresByTask: {},
        lastDispatchAt: undefined,
        candidates: {},
        candidateOrder: [],
        workflow: createFactoryWorkflowState(event.objectiveId, event.createdAt),
        integration: emptyIntegration(event.createdAt),
        scheduler: {},
        investigation: {
          reports: {},
          reportOrder: [],
        },
      };
    case "objective.operator.noted":
      return {
        ...state,
        latestSummary: event.message,
        updatedAt: event.notedAt,
      };
    case "objective.slot.queued":
      return {
        ...state,
        updatedAt: event.queuedAt,
        scheduler: {
          slotState: "queued",
          queuedAt: event.queuedAt,
          admittedAt: state.scheduler.admittedAt,
          releasedAt: state.scheduler.releasedAt,
          releaseReason: state.scheduler.releaseReason,
        },
      };
    case "objective.slot.admitted":
      return {
        ...state,
        updatedAt: event.admittedAt,
        scheduler: {
          slotState: "active",
          queuedAt: state.scheduler.queuedAt,
          admittedAt: event.admittedAt,
          releasedAt: undefined,
          releaseReason: undefined,
        },
      };
    case "objective.slot.released":
      return {
        ...state,
        updatedAt: event.releasedAt,
        scheduler: {
          slotState: state.scheduler.slotState,
          queuedAt: state.scheduler.queuedAt,
          admittedAt: state.scheduler.admittedAt,
          releasedAt: event.releasedAt,
          releaseReason: event.reason,
        },
      };
    case "task.added": {
      const nextStatus: FactoryObjectiveStatus =
        state.workflow.taskIds.length === 0 || state.status === "blocked"
          ? "planning"
          : state.status;
      const next = upsertTask(state, event.task);
      return {
        ...next,
        blockedReason: nextStatus === "planning" ? undefined : state.blockedReason,
        status: nextStatus,
        updatedAt: event.createdAt,
        workflow: {
          ...next.workflow,
          updatedAt: event.createdAt,
        },
      };
    }
    case "task.ready":
      return {
        ...setWorkflowStatus(updateTask(state, event.taskId, {
          status: "ready",
          readyAt: event.readyAt,
        }), event.readyAt),
        status: state.status === "blocked" ? "planning" : state.status,
        blockedReason: state.status === "blocked" ? undefined : state.blockedReason,
      };
    case "task.dispatched": {
      const currentActive = new Set(state.workflow.activeTaskIds);
      currentActive.add(event.taskId);
      let next = updateTask(state, event.taskId, {
        status: "running",
        candidateId: event.candidateId,
        jobId: event.jobId,
        workspaceId: event.workspaceId,
        workspacePath: event.workspacePath,
        skillBundlePaths: event.skillBundlePaths,
        contextRefs: event.contextRefs,
        startedAt: event.startedAt,
      });
      next = updateCandidate(next, event.candidateId, {
        status: "running",
        updatedAt: event.startedAt,
      });
      return {
        ...setActiveTaskIds(next, [...currentActive], event.startedAt),
        status: "executing",
        blockedReason: undefined,
        taskRunsUsed: state.taskRunsUsed + 1,
        lastDispatchAt: event.startedAt,
      };
    }
    case "task.review.requested":
      return setActiveTaskIds(updateTask(state, event.taskId, {
        status: "reviewing",
        reviewingAt: event.reviewRequestedAt,
      }), state.workflow.activeTaskIds, event.reviewRequestedAt);
    case "task.approved": {
      const active = state.workflow.activeTaskIds.filter((taskId) => taskId !== event.taskId);
      const { [event.taskId]: _, ...remainingFailures } = state.consecutiveFailuresByTask;
      return {
        ...setActiveTaskIds(updateTask(state, event.taskId, {
          status: "approved",
          latestSummary: event.summary,
          completedAt: event.approvedAt,
        }), active, event.approvedAt),
        latestSummary: event.summary,
        consecutiveFailuresByTask: remainingFailures,
      };
    }
    case "task.integrated": {
      const active = state.workflow.activeTaskIds.filter((taskId) => taskId !== event.taskId);
      const { [event.taskId]: _, ...remainingFailures } = state.consecutiveFailuresByTask;
      return {
        ...setActiveTaskIds(updateTask(state, event.taskId, {
          status: "integrated",
          latestSummary: event.summary,
          completedAt: event.integratedAt,
        }), active, event.integratedAt),
        latestSummary: event.summary,
        consecutiveFailuresByTask: remainingFailures,
      };
    }
    case "task.blocked": {
      const active = state.workflow.activeTaskIds.filter((taskId) => taskId !== event.taskId);
      const prev = state.workflow.tasksById[event.taskId];
      const wasDispatch = prev?.status === "running" || prev?.status === "reviewing";
      const prevFailures = state.consecutiveFailuresByTask[event.taskId] ?? 0;
      let next = updateTask(state, event.taskId, {
          status: "blocked",
          blockedReason: event.reason,
          completedAt: event.blockedAt,
        });
      const candidate = latestTaskCandidate(next, event.taskId);
      if (candidate && (candidate.status === "running" || candidate.status === "awaiting_review")) {
        next = updateCandidate(next, candidate.candidateId, {
          status: "changes_requested",
          latestReason: event.reason,
          updatedAt: event.blockedAt,
        });
      }
      return {
        ...setActiveTaskIds(next, active, event.blockedAt),
        latestSummary: event.reason,
        consecutiveFailuresByTask: wasDispatch
          ? { ...state.consecutiveFailuresByTask, [event.taskId]: prevFailures + 1 }
          : state.consecutiveFailuresByTask,
      };
    }
    case "task.unblocked":
      return {
        ...setWorkflowStatus(updateTask(state, event.taskId, {
          status: "ready",
          readyAt: event.readyAt,
          blockedReason: undefined,
        }), event.readyAt),
        status: state.status === "blocked" ? "planning" : state.status,
        blockedReason: state.status === "blocked" ? undefined : state.blockedReason,
      };
    case "task.superseded": {
      const active = state.workflow.activeTaskIds.filter((taskId) => taskId !== event.taskId);
      return {
        ...setActiveTaskIds(updateTask(state, event.taskId, {
          status: "superseded",
          latestSummary: event.reason,
          completedAt: event.supersededAt,
        }), active, event.supersededAt),
      };
    }
    case "candidate.created":
      return {
        ...upsertCandidate(state, event.candidate),
        updatedAt: event.createdAt,
        candidatePassesByTask: {
          ...state.candidatePassesByTask,
          [event.candidate.taskId]: (state.candidatePassesByTask[event.candidate.taskId] ?? 0) + 1,
        },
      };
    case "candidate.produced": {
      let next = updateCandidate(state, event.candidateId, {
        status: "awaiting_review",
        headCommit: event.headCommit,
        summary: event.summary,
        handoff: event.handoff,
        checkResults: event.checkResults,
        artifactRefs: event.artifactRefs,
        tokensUsed: event.tokensUsed,
        latestReason: event.summary,
        updatedAt: event.producedAt,
      });
      next = updateTask(next, event.taskId, {
        candidateId: event.candidateId,
        latestSummary: event.summary,
        artifactRefs: event.artifactRefs,
      });
      return {
        ...next,
        latestSummary: event.summary,
        updatedAt: event.producedAt,
      };
    }
    case "candidate.reviewed": {
      const taskStatus: FactoryTaskStatus =
        event.status === "approved" ? "approved" : event.status === "changes_requested" ? "ready" : "superseded";
      let next = updateCandidate(state, event.candidateId, {
        status: event.status,
        summary: event.summary,
        handoff: event.handoff,
        latestReason: event.summary,
        approvedAt: event.status === "approved" ? event.reviewedAt : undefined,
        updatedAt: event.reviewedAt,
      });
      next = updateTask(next, event.taskId, {
        status: taskStatus,
        latestSummary: event.summary,
        completedAt: event.status === "approved" ? event.reviewedAt : undefined,
      });
      return {
        ...setActiveTaskIds(next, state.workflow.activeTaskIds.filter((taskId) => taskId !== event.taskId), event.reviewedAt),
        latestSummary: event.summary,
      };
    }
    case "investigation.reported": {
      const active = state.workflow.activeTaskIds.filter((taskId) => taskId !== event.taskId);
      let next = updateCandidate(state, event.candidateId, {
        status: "approved",
        summary: event.summary,
        handoff: event.handoff,
        artifactRefs: event.artifactRefs,
        headCommit: event.evidenceCommit,
        latestReason: event.summary,
        approvedAt: event.reportedAt,
        updatedAt: event.reportedAt,
      });
      next = updateTask(next, event.taskId, {
        status: "approved",
        candidateId: event.candidateId,
        latestSummary: event.summary,
        artifactRefs: event.artifactRefs,
        completedAt: event.reportedAt,
      });
      return {
        ...setActiveTaskIds(next, active, event.reportedAt),
        latestSummary: event.summary,
        investigation: {
          reports: {
            ...state.investigation.reports,
            [event.taskId]: {
              taskId: event.taskId,
              candidateId: event.candidateId,
              summary: event.summary,
              handoff: event.handoff,
              report: event.report,
              artifactRefs: event.artifactRefs,
              evidenceCommit: event.evidenceCommit,
              reportedAt: event.reportedAt,
            },
          },
          reportOrder: state.investigation.reportOrder.includes(event.taskId)
            ? state.investigation.reportOrder
            : [...state.investigation.reportOrder, event.taskId],
          synthesized: undefined,
        },
      };
    }
    case "investigation.synthesized":
      return {
        ...state,
        latestSummary: event.summary,
        updatedAt: event.synthesizedAt,
        investigation: {
          ...state.investigation,
          synthesized: {
            summary: event.summary,
            report: event.report,
            taskIds: event.taskIds,
            synthesizedAt: event.synthesizedAt,
          },
        },
      };
    case "candidate.conflicted":
      return {
        ...updateCandidate(state, event.candidateId, {
          status: "conflicted",
          conflictReason: event.reason,
          latestReason: event.reason,
          updatedAt: event.conflictedAt,
        }),
        updatedAt: event.conflictedAt,
      };
    case "rebracket.applied":
      return {
        ...state,
        latestRebracket: {
          frontierTaskIds: event.frontierTaskIds,
          selectedActionId: event.selectedActionId,
          reason: event.reason,
          confidence: event.confidence,
          source: event.source,
          basedOn: event.basedOn,
          appliedAt: event.appliedAt,
        },
        updatedAt: event.appliedAt,
      };
    case "merge.applied":
      return {
        ...updateCandidate(state, event.candidateId, {
          status: "integrated",
          latestReason: event.summary,
          integratedAt: event.appliedAt,
          updatedAt: event.appliedAt,
        }),
        updatedAt: event.appliedAt,
        latestSummary: event.summary,
      };
    case "integration.queued":
      return {
        ...state,
        status: "integrating",
        updatedAt: event.queuedAt,
        integration: {
          ...state.integration,
          status: "queued",
          branchName: event.branchName,
          branchRef: event.branchRef,
          queuedCandidateIds: [...new Set([...state.integration.queuedCandidateIds, event.candidateId])],
          activeCandidateId: state.integration.activeCandidateId,
          updatedAt: event.queuedAt,
        },
      };
    case "integration.merging":
      return {
        ...state,
        status: "integrating",
        updatedAt: event.startedAt,
        integration: {
          ...state.integration,
          status: "merging",
          activeCandidateId: event.candidateId,
          updatedAt: event.startedAt,
        },
      };
    case "integration.validating":
      return {
        ...state,
        status: "integrating",
        updatedAt: event.startedAt,
        integration: {
          ...state.integration,
          status: "validating",
          activeCandidateId: event.candidateId,
          updatedAt: event.startedAt,
        },
      };
    case "integration.validated":
      return {
        ...state,
        status: "integrating",
        updatedAt: event.validatedAt,
        latestSummary: event.summary,
        integration: {
          ...state.integration,
          status: "validated",
          activeCandidateId: event.candidateId,
          headCommit: event.headCommit,
          validationResults: event.validationResults,
          lastSummary: event.summary,
          updatedAt: event.validatedAt,
        },
      };
    case "integration.ready_to_promote":
      return {
        ...state,
        status: "promoting",
        updatedAt: event.readyAt,
        latestSummary: event.summary,
        integration: {
          ...state.integration,
          status: "ready_to_promote",
          headCommit: event.headCommit,
          lastSummary: event.summary,
          updatedAt: event.readyAt,
        },
      };
    case "integration.promoting":
      return {
        ...state,
        status: "promoting",
        updatedAt: event.startedAt,
        integration: {
          ...state.integration,
          status: "promoting",
          activeCandidateId: event.candidateId,
          updatedAt: event.startedAt,
        },
      };
    case "integration.promoted":
      return {
        ...state,
        status: "completed",
        updatedAt: event.promotedAt,
        latestSummary: event.summary,
        integration: {
          ...state.integration,
          status: "promoted",
          promotedCommit: event.promotedCommit,
          lastSummary: event.summary,
          updatedAt: event.promotedAt,
        },
      };
    case "integration.conflicted":
      return {
        ...state,
        status: "integrating",
        updatedAt: event.conflictedAt,
        blockedReason: event.reason,
        integration: {
          ...state.integration,
          status: "conflicted",
          activeCandidateId: event.candidateId,
          headCommit: event.headCommit ?? state.integration.headCommit,
          conflictReason: event.reason,
          updatedAt: event.conflictedAt,
        },
      };
    case "objective.completed":
      return {
        ...state,
        status: "completed",
        latestSummary: event.summary,
        updatedAt: event.completedAt,
        workflow: {
          ...state.workflow,
          status: "completed",
          updatedAt: event.completedAt,
        },
      };
    case "objective.blocked":
      return {
        ...state,
        status: "blocked",
        blockedReason: event.reason,
        latestSummary: event.summary,
        updatedAt: event.blockedAt,
        workflow: {
          ...state.workflow,
          status: "blocked",
          updatedAt: event.blockedAt,
        },
      };
    case "objective.failed":
      return {
        ...state,
        status: "failed",
        blockedReason: event.reason,
        latestSummary: event.reason,
        updatedAt: event.failedAt,
        workflow: {
          ...state.workflow,
          status: "failed",
          updatedAt: event.failedAt,
        },
      };
    case "objective.canceled":
      return {
        ...state,
        status: "canceled",
        blockedReason: event.reason,
        latestSummary: event.reason ?? "canceled",
        updatedAt: event.canceledAt,
        workflow: {
          ...state.workflow,
          status: "canceled",
          updatedAt: event.canceledAt,
        },
      };
    case "objective.archived":
      return {
        ...state,
        archivedAt: state.archivedAt ?? event.archivedAt,
        updatedAt: event.archivedAt,
      };
    default: {
      const _never: never = event;
      return _never;
    }
  }
};
