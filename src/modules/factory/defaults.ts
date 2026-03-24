import type {
  FactoryIntegrationRecord,
  FactoryNormalizedObjectivePolicy,
  FactoryObjectiveProfileSnapshot,
  FactoryState,
  FactoryTaskStatus,
  FactoryWorkflowState,
  FactoryWorkflowStatus,
} from "./types";

export const FACTORY_TASK_WORKFLOW_BUCKETS = {
  planned: ["pending"],
  ready: ["ready"],
  active: ["running", "reviewing"],
  completed: ["approved", "integrated", "superseded"],
  blocked: ["blocked"],
  terminal: ["approved", "integrated", "blocked", "superseded"],
} as const satisfies Readonly<Record<string, ReadonlyArray<FactoryTaskStatus>>>;

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

export const emptyIntegration = (ts: number): FactoryIntegrationRecord => ({
  status: "idle",
  queuedCandidateIds: [],
  validationResults: [],
  updatedAt: ts,
});

export const createFactoryWorkflowState = (
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
