import type { Decide, Reducer } from "../core/types.js";
import { CONTROL_RECEIPT_TYPES } from "../engine/runtime/control-receipts.js";
import {
  activatableNodes,
  createGraphState,
  graphNodeList,
  graphProjection,
  runnableNodes,
  type GraphBuckets,
  type GraphRef,
  type GraphRunStatus,
  type GraphState,
  type GraphNodeBase,
} from "../core/graph.js";

export type FactoryObjectiveStatus =
  | "decomposing"
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
  | "ready_to_promote"
  | "promoting"
  | "promoted"
  | "conflicted";

export type FactoryWorkerType =
  | "codex"
  | "agent"
  | "infra"
  | string;

export type FactoryObjectiveProfileWorktreeMode = "required" | "forbidden";

export type FactoryObjectiveProfilePolicy = {
  readonly allowedWorkerTypes: ReadonlyArray<FactoryWorkerType>;
  readonly defaultWorkerType: FactoryWorkerType;
  readonly worktreeModeByWorker: Readonly<Record<string, FactoryObjectiveProfileWorktreeMode>>;
  readonly defaultValidationMode: "repo_profile" | "none";
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
  readonly objectivePolicy: FactoryObjectiveProfilePolicy;
};

export type FactoryMutationAggressiveness =
  | "off"
  | "conservative"
  | "balanced"
  | "aggressive";

export type FactoryObjectivePhase =
  | "preparing_repo"
  | "planning_graph"
  | "waiting_for_slot"
  | "executing"
  | "integrating"
  | "promoting"
  | "blocked";

export type FactoryObjectiveSlotState = "queued" | "active";

export type FactoryObjectivePolicy = {
  readonly concurrency?: {
    readonly maxActiveTasks?: number;
  };
  readonly budgets?: {
    readonly maxTaskRuns?: number;
    readonly maxCandidatePassesPerTask?: number;
    readonly maxReconciliationTasks?: number;
    readonly maxObjectiveMinutes?: number;
  };
  readonly throttles?: {
    readonly maxDispatchesPerReact?: number;
    readonly mutationCooldownMs?: number;
  };
  readonly mutation?: {
    readonly aggressiveness?: FactoryMutationAggressiveness;
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
    readonly maxReconciliationTasks: number;
    readonly maxObjectiveMinutes: number;
  };
  readonly throttles: {
    readonly maxDispatchesPerReact: number;
    readonly mutationCooldownMs: number;
  };
  readonly mutation: {
    readonly aggressiveness: FactoryMutationAggressiveness;
  };
  readonly promotion: {
    readonly autoPromote: boolean;
  };
};

export type FactoryBudgetState = {
  readonly taskRunsUsed: number;
  readonly candidatePassesByTask: Readonly<Record<string, number>>;
  readonly reconciliationTasksUsed: number;
  readonly elapsedMinutes: number;
  readonly lastMutationAt?: number;
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

export type FactoryRepoProfileRecord = {
  readonly status: "missing" | "generating" | "ready" | "stale" | "failed";
  readonly generatedAt?: number;
  readonly inferredChecks: ReadonlyArray<string>;
  readonly generatedSkillRefs: ReadonlyArray<GraphRef>;
  readonly summary: string;
};

export type FactoryPlanRecord = {
  readonly proposedAt?: number;
  readonly adoptedAt?: number;
  readonly summary?: string;
  readonly fallback?: boolean;
  readonly taskIds: ReadonlyArray<string>;
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

export type FactoryScoreVector = Readonly<Record<string, number>>;

export type FactoryActionEvidence = {
  readonly basedOn?: string;
  readonly summary: string;
  readonly actionIds: ReadonlyArray<string>;
  readonly computedAt: number;
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

export type FactoryTaskRecord = GraphNodeBase<FactoryTaskStatus> & {
  readonly taskId: string;
  readonly taskKind: "planned" | "split" | "reconciliation";
  readonly title: string;
  readonly prompt: string;
  readonly workerType: FactoryWorkerType;
  readonly sourceTaskId?: string;
  readonly sourceCandidateId?: string;
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
  readonly lastScore?: number;
  readonly lastScoreVector?: FactoryScoreVector;
  readonly lastScoreReason?: string;
  readonly latestReason?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly approvedAt?: number;
  readonly integratedAt?: number;
  readonly conflictReason?: string;
};

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

export type FactoryGraphState = GraphState<FactoryTaskRecord, GraphRunStatus>;

export type FactoryState = {
  readonly objectiveId: string;
  readonly title: string;
  readonly prompt: string;
  readonly channel: string;
  readonly baseHash: string;
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
  readonly reconciliationTasksUsed: number;
  readonly lastMutationAt?: number;
  readonly lastDispatchAt?: number;
  readonly taskOrder: ReadonlyArray<string>;
  readonly candidates: Readonly<Record<string, FactoryCandidateRecord>>;
  readonly candidateOrder: ReadonlyArray<string>;
  readonly graph: FactoryGraphState;
  readonly integration: FactoryIntegrationRecord;
  readonly scheduler: FactorySchedulerRecord;
  readonly repoProfile: FactoryRepoProfileRecord;
  readonly plan: FactoryPlanRecord;
  readonly latestEvidence?: FactoryActionEvidence;
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

export const FACTORY_TASK_GRAPH_BUCKETS = {
  planned: ["pending"],
  ready: ["ready"],
  active: ["running", "reviewing"],
  completed: ["approved", "integrated", "superseded"],
  blocked: ["blocked"],
  terminal: ["approved", "integrated", "blocked", "superseded"],
} as const satisfies GraphBuckets<FactoryTaskStatus>;

export const DEFAULT_FACTORY_OBJECTIVE_POLICY: FactoryNormalizedObjectivePolicy = {
  concurrency: {
    maxActiveTasks: 4,
  },
  budgets: {
    maxTaskRuns: 50,
    maxCandidatePassesPerTask: 4,
    maxReconciliationTasks: 8,
    maxObjectiveMinutes: 1_440,
  },
  throttles: {
    maxDispatchesPerReact: 4,
    mutationCooldownMs: 15_000,
  },
  mutation: {
    aggressiveness: "balanced",
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
    allowedWorkerTypes: ["codex", "infra", "theorem", "axiom", "writer", "inspector", "agent"],
    defaultWorkerType: "codex",
    worktreeModeByWorker: {
      codex: "required",
      infra: "required",
      theorem: "required",
      axiom: "required",
      writer: "forbidden",
      inspector: "forbidden",
      agent: "forbidden",
    },
    defaultValidationMode: "repo_profile",
    maxParallelChildren: 4,
    allowObjectiveCreation: true,
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const normalizeFactoryObjectiveProfileSnapshot = (value: unknown): FactoryObjectiveProfileSnapshot => {
  if (!isRecord(value)) return DEFAULT_FACTORY_OBJECTIVE_PROFILE;
  const policyInput = isRecord(value.objectivePolicy) ? value.objectivePolicy : {};
  const worktreeModes = isRecord(policyInput.worktreeModeByWorker)
    ? policyInput.worktreeModeByWorker
    : {};
  const normalizedWorktreeModes = Object.fromEntries(
    Object.entries(worktreeModes)
      .filter(([, mode]) => mode === "required" || mode === "forbidden"),
  ) as Readonly<Record<string, FactoryObjectiveProfileWorktreeMode>>;
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
    objectivePolicy: {
      allowedWorkerTypes: Array.isArray(policyInput.allowedWorkerTypes)
        ? policyInput.allowedWorkerTypes.filter((item): item is FactoryWorkerType => typeof item === "string" && item.trim().length > 0)
        : DEFAULT_FACTORY_OBJECTIVE_PROFILE.objectivePolicy.allowedWorkerTypes,
      defaultWorkerType: typeof policyInput.defaultWorkerType === "string" && policyInput.defaultWorkerType.trim()
        ? policyInput.defaultWorkerType
        : DEFAULT_FACTORY_OBJECTIVE_PROFILE.objectivePolicy.defaultWorkerType,
      worktreeModeByWorker: {
        ...DEFAULT_FACTORY_OBJECTIVE_PROFILE.objectivePolicy.worktreeModeByWorker,
        ...normalizedWorktreeModes,
      },
      defaultValidationMode: policyInput.defaultValidationMode === "none"
        ? "none"
        : DEFAULT_FACTORY_OBJECTIVE_PROFILE.objectivePolicy.defaultValidationMode,
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
      maxReconciliationTasks: clampInt(
        policy?.budgets?.maxReconciliationTasks,
        0,
        50,
        DEFAULT_FACTORY_OBJECTIVE_POLICY.budgets.maxReconciliationTasks,
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
      mutationCooldownMs: clampInt(
        policy?.throttles?.mutationCooldownMs,
        0,
        300_000,
        DEFAULT_FACTORY_OBJECTIVE_POLICY.throttles.mutationCooldownMs,
      ),
    },
    mutation: {
      aggressiveness:
        policy?.mutation?.aggressiveness === "off"
        || policy?.mutation?.aggressiveness === "conservative"
        || policy?.mutation?.aggressiveness === "balanced"
        || policy?.mutation?.aggressiveness === "aggressive"
          ? policy.mutation.aggressiveness
          : DEFAULT_FACTORY_OBJECTIVE_POLICY.mutation.aggressiveness,
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

const updateTask = (
  state: FactoryState,
  taskId: string,
  patch: Partial<FactoryTaskRecord>,
): FactoryState => {
  const current = state.graph.nodes[taskId];
  if (!current) return state;
  return {
    ...state,
    graph: {
      ...state.graph,
      nodes: {
        ...state.graph.nodes,
        [taskId]: {
          ...current,
          ...patch,
        },
      },
    },
  };
};

const upsertTask = (
  state: FactoryState,
  task: FactoryTaskRecord,
): FactoryState => ({
  ...state,
  taskOrder: state.taskOrder.includes(task.taskId)
    ? state.taskOrder
    : [...state.taskOrder, task.taskId],
  graph: {
    ...state.graph,
    order: state.graph.order.includes(task.taskId)
      ? state.graph.order
      : [...state.graph.order, task.taskId],
    nodes: {
      ...state.graph.nodes,
      [task.taskId]: task,
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

const upsertCandidate = (
  state: FactoryState,
  candidate: FactoryCandidateRecord,
): FactoryState => ({
  ...state,
  candidates: {
    ...state.candidates,
    [candidate.candidateId]: candidate,
  },
  candidateOrder: state.candidateOrder.includes(candidate.candidateId)
    ? state.candidateOrder
    : [...state.candidateOrder, candidate.candidateId],
});

const setGraphStatus = (
  state: FactoryState,
  ts: number,
  status: GraphRunStatus = state.graph.status,
): FactoryState => ({
  ...state,
  updatedAt: ts,
  graph: {
    ...state.graph,
    status,
    updatedAt: ts,
  },
});

const setActiveTaskIds = (state: FactoryState, activeNodeIds: ReadonlyArray<string>, ts: number): FactoryState => ({
  ...state,
  updatedAt: ts,
  graph: {
    ...state.graph,
    activeNodeIds: [...new Set(activeNodeIds.filter((taskId) => Boolean(state.graph.nodes[taskId])))],
    updatedAt: ts,
  },
});

export const factoryTaskList = (state: FactoryState): ReadonlyArray<FactoryTaskRecord> =>
  graphNodeList(state.graph);

export const factoryTaskGraphProjection = (state: FactoryState) =>
  graphProjection(state.graph, FACTORY_TASK_GRAPH_BUCKETS);

export const factoryReadyTasks = (state: FactoryState): ReadonlyArray<FactoryTaskRecord> =>
  runnableNodes(state.graph, {
    ready: FACTORY_TASK_GRAPH_BUCKETS.ready,
    completed: FACTORY_TASK_GRAPH_BUCKETS.completed,
  });

export const factoryActivatableTasks = (state: FactoryState): ReadonlyArray<FactoryTaskRecord> =>
  activatableNodes(state.graph, {
    planned: FACTORY_TASK_GRAPH_BUCKETS.planned,
    completed: FACTORY_TASK_GRAPH_BUCKETS.completed,
  });

export const buildFactoryProjection = (state: FactoryState): FactoryProjection => {
  const tasks = factoryTaskGraphProjection(state);
  return {
    objectiveId: state.objectiveId,
    title: state.title,
    status: state.status,
    archivedAt: state.archivedAt,
    updatedAt: state.updatedAt,
    latestSummary: state.latestSummary,
    blockedReason: state.blockedReason,
    activeTasks: tasks.active,
    readyTasks: tasks.ready,
    pendingTasks: tasks.planned,
    completedTasks: tasks.completed,
    blockedTasks: tasks.blocked,
    tasks: factoryTaskList(state),
    candidates: state.candidateOrder
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
      readonly checks: ReadonlyArray<string>;
      readonly checksSource: "explicit" | "profile" | "default";
      readonly profile: FactoryObjectiveProfileSnapshot;
      readonly policy: FactoryNormalizedObjectivePolicy;
      readonly createdAt: number;
    }
  | {
      readonly type: "repo.profile.requested";
      readonly objectiveId: string;
      readonly requestedAt: number;
    }
  | {
      readonly type: "repo.profile.generated";
      readonly objectiveId: string;
      readonly generatedAt: number;
      readonly status: FactoryRepoProfileRecord["status"];
      readonly inferredChecks: ReadonlyArray<string>;
      readonly generatedSkillRefs: ReadonlyArray<GraphRef>;
      readonly summary: string;
      readonly source?: "generated" | "reused" | "fallback";
    }
  | {
      readonly type: "objective.plan.proposed";
      readonly objectiveId: string;
      readonly taskCount: number;
      readonly summary: string;
      readonly fallback?: boolean;
      readonly proposedAt: number;
    }
  | {
      readonly type: "objective.plan.adopted";
      readonly objectiveId: string;
      readonly taskIds: ReadonlyArray<string>;
      readonly summary: string;
      readonly fallback?: boolean;
      readonly adoptedAt: number;
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
      readonly type: "task.split";
      readonly objectiveId: string;
      readonly sourceTaskId: string;
      readonly tasks: ReadonlyArray<FactoryTaskRecord>;
      readonly reason: string;
      readonly basedOn?: string;
      readonly createdAt: number;
    }
  | {
      readonly type: "task.dependency.updated";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly dependsOn: ReadonlyArray<string>;
      readonly reason: string;
      readonly basedOn?: string;
      readonly updatedAt: number;
    }
  | {
      readonly type: "task.worker.reassigned";
      readonly objectiveId: string;
      readonly taskId: string;
      readonly workerType: FactoryWorkerType;
      readonly reason: string;
      readonly basedOn?: string;
      readonly updatedAt: number;
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
      readonly type: "candidate.conflicted";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly reason: string;
      readonly conflictedAt: number;
    }
  | {
      readonly type: "merge.evidence.computed";
      readonly objectiveId: string;
      readonly frontierTaskIds: ReadonlyArray<string>;
      readonly actionIds: ReadonlyArray<string>;
      readonly summary: string;
      readonly basedOn?: string;
      readonly computedAt: number;
    }
  | {
      readonly type: "merge.candidate.scored";
      readonly objectiveId: string;
      readonly decisionId: string;
      readonly candidateId?: string;
      readonly taskId?: string;
      readonly actionType?: string;
      readonly score: number;
      readonly scoreVector: FactoryScoreVector;
      readonly reason: string;
      readonly scoredAt: number;
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
      readonly type: "integration.ready_to_promote";
      readonly objectiveId: string;
      readonly candidateId: string;
      readonly headCommit: string;
      readonly validationResults: ReadonlyArray<FactoryCheckResult>;
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
  checks: [],
  checksSource: "default",
  profile: DEFAULT_FACTORY_OBJECTIVE_PROFILE,
  policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
  status: "decomposing",
  archivedAt: undefined,
  createdAt: 0,
  updatedAt: 0,
  taskRunsUsed: 0,
  candidatePassesByTask: {},
  reconciliationTasksUsed: 0,
  lastMutationAt: undefined,
  lastDispatchAt: undefined,
  taskOrder: [],
  candidates: {},
  candidateOrder: [],
  graph: createGraphState<FactoryTaskRecord>("", 0, "active"),
  integration: emptyIntegration(0),
  scheduler: {},
  repoProfile: {
    status: "missing",
    inferredChecks: [],
    generatedSkillRefs: [],
    summary: "",
  },
  plan: {
    taskIds: [],
  },
};

export const decideFactory: Decide<FactoryCmd, FactoryEvent> = (cmd) => {
  if (cmd.events?.length) return [...cmd.events];
  return cmd.event ? [cmd.event] : [];
};

export const reduceFactory: Reducer<FactoryState, FactoryEvent> = (state, event) => {
  if (CONTROL_RECEIPT_TYPES.has(event.type as never)) return state;
  switch (event.type) {
    case "objective.created":
      return {
        objectiveId: event.objectiveId,
        title: event.title,
        prompt: event.prompt,
        channel: event.channel,
        baseHash: event.baseHash,
        checks: event.checks,
        checksSource: event.checksSource,
        profile: normalizeFactoryObjectiveProfileSnapshot(event.profile),
        policy: event.policy,
        status: "decomposing",
        archivedAt: undefined,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        taskRunsUsed: 0,
        candidatePassesByTask: {},
        reconciliationTasksUsed: 0,
        lastMutationAt: undefined,
        lastDispatchAt: undefined,
        taskOrder: [],
        candidates: {},
        candidateOrder: [],
        graph: createGraphState<FactoryTaskRecord>(event.objectiveId, event.createdAt, "active"),
        integration: emptyIntegration(event.createdAt),
        scheduler: {},
        repoProfile: {
          status: "missing",
          inferredChecks: [],
          generatedSkillRefs: [],
          summary: "",
        },
        plan: {
          taskIds: [],
        },
      };
    case "repo.profile.requested":
      return {
        ...state,
        updatedAt: event.requestedAt,
        status: state.status === "blocked" ? state.status : "decomposing",
        repoProfile: {
          ...state.repoProfile,
          status: "generating",
        },
      };
    case "repo.profile.generated":
      return {
        ...state,
        updatedAt: event.generatedAt,
        checks: state.checksSource === "default" && event.inferredChecks.length > 0
          ? event.inferredChecks
          : state.checks,
        repoProfile: {
          status: event.status,
          generatedAt: event.generatedAt,
          inferredChecks: event.inferredChecks,
          generatedSkillRefs: event.generatedSkillRefs,
          summary: event.summary,
        },
      };
    case "objective.plan.proposed":
      return {
        ...state,
        status: state.status === "blocked" ? state.status : "planning",
        updatedAt: event.proposedAt,
        latestSummary: event.summary,
        plan: {
          ...state.plan,
          proposedAt: event.proposedAt,
          summary: event.summary,
          fallback: event.fallback,
        },
      };
    case "objective.plan.adopted":
      return {
        ...state,
        status: state.status === "blocked" ? state.status : "planning",
        updatedAt: event.adoptedAt,
        latestSummary: event.summary,
        plan: {
          ...state.plan,
          adoptedAt: event.adoptedAt,
          taskIds: [...event.taskIds],
          summary: event.summary,
          fallback: event.fallback,
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
        state.taskOrder.length === 0 ? "planning" : state.status === "decomposing" ? "planning" : state.status;
      return {
        ...upsertTask(state, event.task),
        status: nextStatus,
        updatedAt: event.createdAt,
        reconciliationTasksUsed: state.reconciliationTasksUsed + (event.task.taskKind === "reconciliation" ? 1 : 0),
        lastMutationAt: event.task.taskKind === "planned" ? state.lastMutationAt : event.createdAt,
        graph: {
          ...upsertTask(state, event.task).graph,
          updatedAt: event.createdAt,
        },
      };
    }
    case "task.split": {
      let next = state;
      for (const task of event.tasks) {
        next = upsertTask(next, task);
      }
      return {
        ...next,
        updatedAt: event.createdAt,
        latestSummary: event.reason,
        lastMutationAt: event.createdAt,
        graph: {
          ...next.graph,
          updatedAt: event.createdAt,
        },
      };
    }
    case "task.dependency.updated":
      return {
        ...setGraphStatus(updateTask(state, event.taskId, {
          dependsOn: event.dependsOn,
          basedOn: event.basedOn,
        }), event.updatedAt),
        lastMutationAt: event.updatedAt,
      };
    case "task.worker.reassigned":
      return {
        ...setGraphStatus(updateTask(state, event.taskId, {
          workerType: event.workerType,
          basedOn: event.basedOn,
        }), event.updatedAt),
        lastMutationAt: event.updatedAt,
      };
    case "task.ready":
      return setGraphStatus(updateTask(state, event.taskId, {
        status: "ready",
        readyAt: event.readyAt,
      }), event.readyAt);
    case "task.dispatched": {
      const currentActive = new Set(state.graph.activeNodeIds);
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
        taskRunsUsed: state.taskRunsUsed + 1,
        lastDispatchAt: event.startedAt,
      };
    }
    case "task.review.requested":
      return setActiveTaskIds(updateTask(state, event.taskId, {
        status: "reviewing",
        reviewingAt: event.reviewRequestedAt,
      }), state.graph.activeNodeIds, event.reviewRequestedAt);
    case "task.approved": {
      const active = state.graph.activeNodeIds.filter((taskId) => taskId !== event.taskId);
      return {
        ...setActiveTaskIds(updateTask(state, event.taskId, {
          status: "approved",
          latestSummary: event.summary,
          completedAt: event.approvedAt,
        }), active, event.approvedAt),
        latestSummary: event.summary,
      };
    }
    case "task.integrated": {
      const active = state.graph.activeNodeIds.filter((taskId) => taskId !== event.taskId);
      return {
        ...setActiveTaskIds(updateTask(state, event.taskId, {
          status: "integrated",
          latestSummary: event.summary,
          completedAt: event.integratedAt,
        }), active, event.integratedAt),
        latestSummary: event.summary,
      };
    }
    case "task.blocked": {
      const active = state.graph.activeNodeIds.filter((taskId) => taskId !== event.taskId);
      return {
        ...setActiveTaskIds(updateTask(state, event.taskId, {
          status: "blocked",
          blockedReason: event.reason,
          completedAt: event.blockedAt,
        }), active, event.blockedAt),
        latestSummary: event.reason,
      };
    }
    case "task.unblocked":
      return {
        ...setGraphStatus(updateTask(state, event.taskId, {
          status: "ready",
          readyAt: event.readyAt,
          blockedReason: undefined,
        }), event.readyAt),
        lastMutationAt: event.readyAt,
      };
    case "task.superseded": {
      const active = state.graph.activeNodeIds.filter((taskId) => taskId !== event.taskId);
      return {
        ...setActiveTaskIds(updateTask(state, event.taskId, {
          status: "superseded",
          latestSummary: event.reason,
          completedAt: event.supersededAt,
        }), active, event.supersededAt),
        lastMutationAt: event.supersededAt,
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
        ...setActiveTaskIds(next, state.graph.activeNodeIds.filter((taskId) => taskId !== event.taskId), event.reviewedAt),
        latestSummary: event.summary,
      };
    }
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
    case "merge.evidence.computed":
      return {
        ...state,
        latestEvidence: {
          summary: event.summary,
          actionIds: event.actionIds,
          basedOn: event.basedOn,
          computedAt: event.computedAt,
        },
        updatedAt: event.computedAt,
      };
    case "merge.candidate.scored":
      if (!event.candidateId) {
        return {
          ...state,
          updatedAt: event.scoredAt,
        };
      }
      return {
        ...updateCandidate(state, event.candidateId, {
          lastScore: event.score,
          lastScoreVector: event.scoreVector,
          lastScoreReason: event.reason,
          updatedAt: event.scoredAt,
        }),
        updatedAt: event.scoredAt,
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
    case "integration.ready_to_promote":
      return {
        ...state,
        status: "promoting",
        updatedAt: event.readyAt,
        latestSummary: event.summary,
        integration: {
          ...state.integration,
          status: "ready_to_promote",
          activeCandidateId: event.candidateId,
          headCommit: event.headCommit,
          validationResults: event.validationResults,
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
        graph: {
          ...state.graph,
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
        graph: {
          ...state.graph,
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
        graph: {
          ...state.graph,
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
        graph: {
          ...state.graph,
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
