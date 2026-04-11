export type ExecutionKey = string;

export type WorkflowStatus =
  | "idle"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type WorkflowSnapshot = {
  readonly key: ExecutionKey;
  readonly status: WorkflowStatus;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly lastSignalAt?: number;
  readonly input?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly output?: Record<string, unknown>;
  readonly error?: string;
};

export type SignalEnvelope = {
  readonly id: string;
  readonly workflowKey: ExecutionKey;
  readonly seq: number;
  readonly signal: string;
  readonly payload?: Record<string, unknown>;
  readonly by?: string;
  readonly createdAt: number;
  readonly consumedAt?: number;
};

export type ActivityStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type ActivitySnapshot = {
  readonly key: ExecutionKey;
  readonly status: ActivityStatus;
  readonly attempts: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly input?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly output?: Record<string, unknown>;
  readonly error?: string;
};

export type StartWorkflowInput = {
  readonly key: ExecutionKey;
  readonly input?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
};

export type WorkflowSignalInput = {
  readonly key: ExecutionKey;
  readonly signal: string;
  readonly payload?: Record<string, unknown>;
  readonly by?: string;
};

export type WorkflowConsumeInput = {
  readonly key: ExecutionKey;
  readonly signals?: ReadonlyArray<string>;
  readonly limit?: number;
};

export type WorkflowStatusUpdate = {
  readonly key: ExecutionKey;
  readonly status: WorkflowStatus;
  readonly output?: Record<string, unknown>;
  readonly error?: string;
  readonly metadata?: Record<string, unknown>;
};

export type ActivityRunInput<Result extends Record<string, unknown>> = {
  readonly key: ExecutionKey;
  readonly input?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly recover?: () => Promise<Result | undefined>;
  readonly run: () => Promise<Result>;
};

export type DurableBackend = {
  readonly startOrResumeWorkflow: (
    input: StartWorkflowInput,
  ) => Promise<WorkflowSnapshot>;
  readonly signalWorkflow: (
    input: WorkflowSignalInput,
  ) => Promise<SignalEnvelope>;
  readonly consumeWorkflowSignals: (
    input: WorkflowConsumeInput,
  ) => Promise<ReadonlyArray<SignalEnvelope>>;
  readonly listWorkflowSignals: (
    key: ExecutionKey,
  ) => Promise<ReadonlyArray<SignalEnvelope>>;
  readonly setWorkflowStatus: (
    input: WorkflowStatusUpdate,
  ) => Promise<WorkflowSnapshot | undefined>;
  readonly cancelWorkflow: (
    key: ExecutionKey,
    reason?: string,
  ) => Promise<WorkflowSnapshot | undefined>;
  readonly getWorkflow: (
    key: ExecutionKey,
  ) => Promise<WorkflowSnapshot | undefined>;
  readonly listWorkflows: (opts?: {
    readonly prefix?: string;
    readonly statuses?: ReadonlyArray<WorkflowStatus>;
  }) => Promise<ReadonlyArray<WorkflowSnapshot>>;
  readonly waitForWorkflowChange: (input: {
    readonly key: ExecutionKey;
    readonly sinceRevision?: number;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
  }) => Promise<WorkflowSnapshot | undefined>;
  readonly getActivity: (
    key: ExecutionKey,
  ) => Promise<ActivitySnapshot | undefined>;
  readonly listActivities: (opts?: {
    readonly prefix?: string;
    readonly statuses?: ReadonlyArray<ActivityStatus>;
  }) => Promise<ReadonlyArray<ActivitySnapshot>>;
  readonly runDurableActivity: <Result extends Record<string, unknown>>(
    input: ActivityRunInput<Result>,
  ) => Promise<{ readonly snapshot: ActivitySnapshot; readonly result: Result }>;
};

export const startOrResumeWorkflow = (
  backend: DurableBackend,
  input: StartWorkflowInput,
): Promise<WorkflowSnapshot> => backend.startOrResumeWorkflow(input);

export const signalWorkflow = (
  backend: DurableBackend,
  input: WorkflowSignalInput,
): Promise<SignalEnvelope> => backend.signalWorkflow(input);

export const cancelWorkflow = (
  backend: DurableBackend,
  key: ExecutionKey,
  reason?: string,
): Promise<WorkflowSnapshot | undefined> => backend.cancelWorkflow(key, reason);

export const getWorkflow = (
  backend: DurableBackend,
  key: ExecutionKey,
): Promise<WorkflowSnapshot | undefined> => backend.getWorkflow(key);

export const waitForWorkflowChange = (
  backend: DurableBackend,
  input: {
    readonly key: ExecutionKey;
    readonly sinceRevision?: number;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
  },
): Promise<WorkflowSnapshot | undefined> => backend.waitForWorkflowChange(input);

export const runDurableActivity = <Result extends Record<string, unknown>>(
  backend: DurableBackend,
  input: ActivityRunInput<Result>,
): Promise<{ readonly snapshot: ActivitySnapshot; readonly result: Result }> =>
  backend.runDurableActivity(input);
