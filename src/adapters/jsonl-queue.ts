// ============================================================================
// Receipt-native Queue Adapter - derives queue state from job receipts
// ============================================================================

import { randomUUID } from "node:crypto";

import type { Runtime } from "@receipt/core/runtime";
import type {
  JobCmd,
  JobCommandRecord,
  JobEvent,
  JobLane,
  JobRecord,
  JobState,
  JobStatus,
  QueueCommandLane,
  QueueCommandType,
} from "../modules/job";
import { readJobProjection, syncChangedJobProjections, syncJobProjectionHeartbeat, syncJobProjectionStream, type StoredJobProjection } from "../db/projectors";

export type QueueCommandRecord = {
  readonly id: string;
  readonly command: QueueCommandType;
  readonly lane: QueueCommandLane;
  readonly payload?: Record<string, unknown>;
  readonly by?: string;
  readonly createdAt: number;
  readonly consumedAt?: number;
};

export type JobPayload = Readonly<Record<string, unknown>> & {
  readonly runId?: string;
  readonly runStream?: string;
  readonly stream?: string;
};

export type QueueJob = {
  readonly id: string;
  readonly agentId: string;
  readonly lane: JobLane;
  readonly sessionKey?: string;
  readonly singletonMode?: "allow" | "cancel" | "steer";
  readonly payload: JobPayload;
  readonly status: JobStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly leaseOwner?: string;
  readonly leaseUntil?: number;
  readonly lastError?: string;
  readonly result?: Record<string, unknown>;
  readonly canceledReason?: string;
  readonly abortRequested?: boolean;
  readonly commands: ReadonlyArray<QueueCommandRecord>;
};

export type EnqueueJobInput = {
  readonly jobId?: string;
  readonly agentId: string;
  readonly lane?: JobLane;
  readonly sessionKey?: string;
  readonly singletonMode?: "allow" | "cancel" | "steer";
  readonly payload: JobPayload;
  readonly maxAttempts?: number;
};

export type LeaseOptions = {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly agentId?: string;
  readonly agentIds?: ReadonlyArray<string>;
  readonly lanes?: ReadonlyArray<JobLane>;
};

export type QueueCommandInput = {
  readonly jobId: string;
  readonly command: QueueCommandType;
  readonly payload?: Record<string, unknown>;
  readonly by?: string;
};

export type QueueSnapshot = {
  readonly version: number;
  readonly total: number;
  readonly queued: number;
  readonly leased: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly canceled: number;
  readonly updatedAt?: number;
};

export type WaitForWorkOptions = {
  readonly sinceVersion?: number;
  readonly timeoutMs?: number;
  readonly wakeOnQueued?: boolean;
};

export type JsonlQueue = {
  readonly enqueue: (input: EnqueueJobInput) => Promise<QueueJob>;
  readonly leaseNext: (opts: LeaseOptions) => Promise<QueueJob | undefined>;
  readonly leaseJob: (jobId: string, workerId: string, leaseMs: number) => Promise<QueueJob | undefined>;
  readonly heartbeat: (jobId: string, workerId: string, leaseMs: number) => Promise<QueueJob | undefined>;
  readonly progress: (
    jobId: string,
    workerId: string,
    result?: Record<string, unknown>
  ) => Promise<QueueJob | undefined>;
  readonly complete: (jobId: string, workerId: string, result?: Record<string, unknown>) => Promise<QueueJob | undefined>;
  readonly fail: (
    jobId: string,
    workerId: string,
    error: string,
    noRetry?: boolean,
    result?: Record<string, unknown>
  ) => Promise<QueueJob | undefined>;
  readonly cancel: (jobId: string, reason?: string, by?: string) => Promise<QueueJob | undefined>;
  readonly queueCommand: (input: QueueCommandInput) => Promise<QueueCommandRecord | undefined>;
  readonly consumeCommands: (
    jobId: string,
    filter?: ReadonlyArray<QueueCommandType>
  ) => Promise<ReadonlyArray<QueueCommandRecord>>;
  readonly getJob: (jobId: string) => Promise<QueueJob | undefined>;
  readonly listJobs: (opts?: { readonly status?: JobStatus; readonly limit?: number }) => Promise<ReadonlyArray<QueueJob>>;
  readonly waitForJob: (jobId: string, timeoutMs?: number, pollMs?: number) => Promise<QueueJob | undefined>;
  readonly waitForWork: (opts?: WaitForWorkOptions) => Promise<QueueSnapshot>;
  readonly notifyWorkAvailable: () => void;
  readonly snapshot: () => QueueSnapshot;
  readonly refresh: () => Promise<QueueSnapshot>;
};

type JsonlQueueOptions = {
  readonly runtime: Runtime<JobCmd, JobEvent, JobState>;
  readonly stream: string;
  readonly now?: () => number;
  readonly onJobChange?: (jobs: ReadonlyArray<QueueJob>) => Promise<void> | void;
  readonly watchDir?: string;
  readonly expireLeasesOnRefresh?: boolean;
  readonly fullRefreshWindowMs?: number;
};

const TERMINAL = new Set<JobStatus>(["completed", "failed", "canceled"]);

const lanePriority: Record<JobLane, number> = {
  chat: 0,
  collect: 1,
  steer: 2,
  follow_up: 3,
};

const commandLane = (command: QueueCommandType): QueueCommandLane =>
  command === "follow_up" ? "follow_up" : "steer";

const cloneJob = (job: QueueJob): QueueJob => ({
  ...job,
  payload: { ...job.payload },
  result: job.result ? { ...job.result } : undefined,
  commands: job.commands.map((cmd) => ({
    ...cmd,
    payload: cmd.payload ? { ...cmd.payload } : undefined,
  })),
});

const projectedToQueueJob = (job: StoredJobProjection): QueueJob => ({
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
  leaseOwner: job.leaseOwner,
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

const eventId = (): string => `jobevt_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;

const emptyCounts = (): Record<JobStatus, number> => ({
  queued: 0,
  leased: 0,
  running: 0,
  completed: 0,
  failed: 0,
  canceled: 0,
});

const compareRecentJobs = (left: QueueJob, right: QueueJob): number =>
  right.updatedAt - left.updatedAt
  || right.createdAt - left.createdAt
  || right.id.localeCompare(left.id);

const compareQueuedJobs = (left: QueueJob, right: QueueJob): number =>
  lanePriority[left.lane] - lanePriority[right.lane]
  || left.createdAt - right.createdAt
  || left.id.localeCompare(right.id);

const CROSS_PROCESS_POLL_MS = 250;
const CROSS_PROCESS_FULL_REFRESH_MS = 30_000;
const sameJob = (left: QueueJob | undefined, right: QueueJob | undefined): boolean => {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.updatedAt !== right.updatedAt) return false;
  if (left.status !== right.status) return false;
  if (left.attempt !== right.attempt) return false;
  if (left.leaseUntil !== right.leaseUntil) return false;
  if (left.commands.length !== right.commands.length) return false;
  if (left.abortRequested !== right.abortRequested) return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

export const jsonlQueue = (opts: JsonlQueueOptions): JsonlQueue => {
  const nowTs = opts.now ?? Date.now;
  const expireLeasesOnRefresh = opts.expireLeasesOnRefresh ?? true;
  const fullRefreshWindowMs = Number.isFinite(opts.fullRefreshWindowMs)
    ? Math.max(0, Math.floor(opts.fullRefreshWindowMs ?? CROSS_PROCESS_FULL_REFRESH_MS))
    : CROSS_PROCESS_FULL_REFRESH_MS;
  const jobStateCache = new Map<string, JobState>();
  let knownJobIds: ReadonlyArray<string> | undefined;
  let writeLock = Promise.resolve();
  let manifestSyncAt = 0;
  let lastFullRefreshAt = 0;
  type QueueWaiter = {
    readonly ready: (snapshot: QueueSnapshot) => boolean;
    readonly resolve: (snapshot: QueueSnapshot) => void;
    timeout?: ReturnType<typeof setTimeout>;
  };
  const waiters = new Set<QueueWaiter>();
  const LEASED_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(["leased", "running"]);
  const index = {
    jobsById: new Map<string, QueueJob>(),
    recentJobIds: [] as string[],
    queuedJobIds: [] as string[],
    leasedJobs: new Set<string>(),
    sessionJobs: new Map<string, Set<string>>(),
    counts: emptyCounts(),
    version: 0,
    updatedAt: undefined as number | undefined,
    loaded: false,
  };

  const withWriteLock = async <T>(op: () => Promise<T>): Promise<T> => {
    const next = writeLock.then(op);
    writeLock = next.then(() => undefined, () => undefined);
    return next;
  };

  const jobStream = (jobId: string): string => `${opts.stream}/${jobId}`;
  const projectionDataDir = opts.watchDir;
  const discoverySyncWindowMs = 250;

  const emitToStream = async (stream: string, event: JobEvent, hint?: string): Promise<void> => {
    await opts.runtime.execute(stream, {
      type: "emit",
      event,
      eventId: hint ?? eventId(),
    });
  };

  const snapshot = (): QueueSnapshot => ({
    version: index.version,
    total: index.jobsById.size,
    queued: index.counts.queued,
    leased: index.counts.leased,
    running: index.counts.running,
    completed: index.counts.completed,
    failed: index.counts.failed,
    canceled: index.counts.canceled,
    updatedAt: index.updatedAt,
  });

  const settleWaiter = (
    waiter: {
      readonly ready: (current: QueueSnapshot) => boolean;
      readonly resolve: (current: QueueSnapshot) => void;
      timeout?: ReturnType<typeof setTimeout>;
    },
    current: QueueSnapshot,
  ): void => {
    waiters.delete(waiter);
    if (waiter.timeout) clearTimeout(waiter.timeout);
    waiter.resolve(current);
  };

  const notifyWaiters = (force = false): void => {
    const current = snapshot();
    for (const waiter of [...waiters]) {
      if (force || waiter.ready(current)) settleWaiter(waiter, current);
    }
  };

  const waitForSnapshot = async (input: {
    readonly timeoutMs?: number;
    readonly ready: (current: QueueSnapshot) => boolean;
  }): Promise<QueueSnapshot> => {
    const current = snapshot();
    if (input.ready(current)) return current;
    return new Promise<QueueSnapshot>((resolve) => {
      const waiter: QueueWaiter = {
        ready: input.ready,
        resolve,
      };
      if (typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs >= 0) {
        waiter.timeout = setTimeout(() => {
          settleWaiter(waiter, snapshot());
        }, input.timeoutMs);
      }
      waiters.add(waiter);
    });
  };

  const removeJobId = (items: string[], jobId: string): void => {
    const indexOfId = items.indexOf(jobId);
    if (indexOfId >= 0) items.splice(indexOfId, 1);
  };

  const insertJobId = (
    items: string[],
    job: QueueJob,
    compare: (left: QueueJob, right: QueueJob) => number,
  ): void => {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const existing = index.jobsById.get(items[mid]!);
      if (!existing || compare(job, existing) < 0) high = mid;
      else low = mid + 1;
    }
    items.splice(low, 0, job.id);
  };

  const removeSessionMember = (job: QueueJob): void => {
    if (!job.sessionKey) return;
    const members = index.sessionJobs.get(job.sessionKey);
    if (!members) return;
    members.delete(job.id);
    if (members.size === 0) index.sessionJobs.delete(job.sessionKey);
  };

  const addSessionMember = (job: QueueJob): void => {
    if (!job.sessionKey) return;
    const members = index.sessionJobs.get(job.sessionKey) ?? new Set<string>();
    members.add(job.id);
    index.sessionJobs.set(job.sessionKey, members);
  };

  const shouldQueueJob = (job: QueueJob): boolean =>
    job.status === "queued" && !job.abortRequested;

  const upsertIndexedJob = (job: QueueJob): void => {
    const previous = index.jobsById.get(job.id);
    if (previous) {
      index.counts[previous.status] -= 1;
      removeJobId(index.recentJobIds, previous.id);
      if (shouldQueueJob(previous)) removeJobId(index.queuedJobIds, previous.id);
      index.leasedJobs.delete(previous.id);
      removeSessionMember(previous);
    }
    const stored = cloneJob(job);
    index.jobsById.set(stored.id, stored);
    index.counts[stored.status] += 1;
    insertJobId(index.recentJobIds, stored, compareRecentJobs);
    if (shouldQueueJob(stored)) insertJobId(index.queuedJobIds, stored, compareQueuedJobs);
    if (LEASED_STATUSES.has(stored.status)) index.leasedJobs.add(stored.id);
    addSessionMember(stored);
    index.version += 1;
    index.updatedAt = Math.max(index.updatedAt ?? 0, stored.updatedAt, stored.createdAt);
  };

  const resetIndex = (jobs: ReadonlyArray<QueueJob>): QueueJob[] => {
    const previousJobs = new Map(index.jobsById);
    const nextJobs = jobs.map(cloneJob);
    const nextById = new Map<string, QueueJob>();
    const nextSessionJobs = new Map<string, Set<string>>();
    for (const job of nextJobs) {
      nextById.set(job.id, job);
      if (job.sessionKey) {
        const members = nextSessionJobs.get(job.sessionKey) ?? new Set<string>();
        members.add(job.id);
        nextSessionJobs.set(job.sessionKey, members);
      }
    }
    index.jobsById = nextById;
    index.recentJobIds = [...nextJobs]
      .sort(compareRecentJobs)
      .map((job) => job.id);
    index.queuedJobIds = nextJobs
      .filter((job) => shouldQueueJob(job))
      .sort(compareQueuedJobs)
      .map((job) => job.id);
    index.leasedJobs = new Set(
      nextJobs.filter((job) => LEASED_STATUSES.has(job.status)).map((job) => job.id),
    );
    index.sessionJobs = nextSessionJobs;
    index.counts = emptyCounts();
    index.updatedAt = undefined;
    for (const job of nextJobs) {
      index.counts[job.status] += 1;
      index.updatedAt = Math.max(index.updatedAt ?? 0, job.updatedAt, job.createdAt);
    }
    index.loaded = true;
    const changed = nextJobs.filter((job) => !sameJob(previousJobs.get(job.id), job));
    if (previousJobs.size !== nextJobs.length || changed.length > 0 || index.version === 0) {
      index.version += 1;
    }
    return changed;
  };

  const publishChangedJobs = async (changed: ReadonlyMap<string, QueueJob>): Promise<void> => {
    if (changed.size === 0) return;
    await opts.onJobChange?.([...changed.values()].map(cloneJob));
  };

  const publishChangedJobList = async (changed: ReadonlyArray<QueueJob>): Promise<void> => {
    if (changed.length === 0) return;
    await opts.onJobChange?.(changed.map(cloneJob));
  };

  const loadQueueJob = async (jobId: string): Promise<QueueJob | undefined> => {
    if (projectionDataDir) {
      const projected = readJobProjection(projectionDataDir, jobId);
      if (projected) return projectedToQueueJob(projected);
    }
    const state = await opts.runtime.state(jobStream(jobId));
    jobStateCache.set(jobId, state);
    const record = state.jobs[jobId];
    return record ? toQueueJob(record) : undefined;
  };

  const loadAuthoritativeJob = async (
    jobId: string,
    changedJobs?: Map<string, QueueJob>,
  ): Promise<QueueJob | undefined> => {
    const loaded = await loadQueueJob(jobId);
    if (!loaded) {
      const indexed = index.jobsById.get(jobId);
      return indexed ? cloneJob(indexed) : undefined;
    }
    const indexed = index.jobsById.get(jobId);
    if (!indexed || !sameJob(indexed, loaded)) {
      upsertIndexedJob(loaded);
      changedJobs?.set(loaded.id, cloneJob(loaded));
    }
    return cloneJob(loaded);
  };

  const emitHeartbeatFastPath = async (
    event: JobEvent & { readonly type: "job.heartbeat"; readonly jobId: string },
    changedJobs: Map<string, QueueJob>,
  ): Promise<void> => {
    await emitToStream(jobStream(event.jobId), event, eventId());
    const state = await opts.runtime.state(jobStream(event.jobId));
    const record = state.jobs[event.jobId];
    if (projectionDataDir && record?.leaseUntil != null) {
      syncJobProjectionHeartbeat(projectionDataDir, event.jobId, record.leaseUntil, record.updatedAt);
    }
    const changedJob = record ? toQueueJob(record) : await loadQueueJob(event.jobId);
    if (changedJob) {
      upsertIndexedJob(changedJob);
      changedJobs.set(changedJob.id, cloneJob(changedJob));
    }
  };

  const emitEvent = async (
    event: JobEvent,
    changedJobs: Map<string, QueueJob>,
  ): Promise<void> => {
    if ("jobId" in event) {
      if (event.type === "job.heartbeat") {
        await emitHeartbeatFastPath(event, changedJobs);
        return;
      }
      await emitToStream(jobStream(event.jobId), event, eventId());
      let changedJob: QueueJob | undefined;
      if (projectionDataDir) {
        const projected = await syncJobProjectionStream(projectionDataDir, opts.runtime, jobStream(event.jobId));
        changedJob = projected ? projectedToQueueJob(projected) : undefined;
      }
      if (!changedJob) {
        changedJob = await loadQueueJob(event.jobId);
      }
      if (changedJob) {
        upsertIndexedJob(changedJob);
        changedJobs.set(changedJob.id, cloneJob(changedJob));
      }
      knownJobIds = knownJobIds && knownJobIds.includes(event.jobId)
        ? knownJobIds
        : [...(knownJobIds ?? []), event.jobId];
    }
  };

  const discoverJobIds = async (): Promise<ReadonlyArray<string>> => {
    if (!opts.runtime.listStreams) {
      return knownJobIds ?? [];
    }
    const prefix = `${opts.stream}/`;
    const streams = await opts.runtime.listStreams(prefix);
    const ids = streams
      .map((stream) => stream.startsWith(prefix) ? stream.slice(prefix.length) : "")
      .filter((jobId) => Boolean(jobId) && !jobId.includes("/"))
      .sort((a, b) => a.localeCompare(b));
    knownJobIds = ids;
    return ids;
  };

  const toCommandRecord = (command: JobCommandRecord): QueueCommandRecord => ({
    id: command.id,
    command: command.command,
    lane: command.lane,
    payload: command.payload ? { ...command.payload } : undefined,
    by: command.by,
    createdAt: command.createdAt,
    consumedAt: command.consumedAt,
  });

  const toQueueJob = (record: JobRecord): QueueJob => ({
    id: record.id,
    agentId: record.agentId,
    lane: record.lane,
    sessionKey: record.sessionKey,
    singletonMode: record.singletonMode,
    payload: { ...record.payload },
    status: record.status,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    leaseOwner: record.workerId,
    leaseUntil: record.leaseUntil,
    lastError: record.lastError,
    result: record.result ? { ...record.result } : undefined,
    canceledReason: record.canceledReason,
    abortRequested: record.abortRequested,
    commands: record.commands.map(toCommandRecord),
  });

  const refreshAllJobs = async (): Promise<ReadonlyArray<QueueJob>> => {
    const bootstrap = !index.loaded;
    const changed = await withWriteLock(async () => {
      const ids = await discoverJobIds();
      const jobs: QueueJob[] = [];
      for (const jobId of ids) {
        const indexed = index.jobsById.get(jobId);
        if (indexed && TERMINAL.has(indexed.status)) {
          jobs.push(cloneJob(indexed));
          continue;
        }
        const loaded = await loadQueueJob(jobId);
        if (loaded) jobs.push(loaded);
      }
      const changedJobs = new Map<string, QueueJob>();
      const reloaded = resetIndex(jobs);
      if (!bootstrap) {
        for (const job of reloaded) {
          changedJobs.set(job.id, cloneJob(job));
        }
      }
      if (expireLeasesOnRefresh) {
        await handleExpiredLeases(nowTs(), changedJobs);
      }
      return [...changedJobs.values()].sort(compareRecentJobs);
    });
    lastFullRefreshAt = nowTs();
    return changed;
  };

  const refresh = async (): Promise<QueueSnapshot> => {
    if (projectionDataDir && !expireLeasesOnRefresh) {
      const changedIds = await syncChangedJobProjections(projectionDataDir, opts.runtime);
      if (changedIds.length > 0) {
        const changedJobs = new Map<string, QueueJob>();
        await withWriteLock(async () => {
          for (const jobId of changedIds) {
            await loadAuthoritativeJob(jobId, changedJobs);
          }
          index.loaded = true;
        });
        const changed = [...changedJobs.values()].sort(compareRecentJobs);
        if (changed.length > 0) notifyWaiters();
        await publishChangedJobList(changed);
        return snapshot();
      }
    }
    if (expireLeasesOnRefresh || !index.loaded || (nowTs() - lastFullRefreshAt) >= fullRefreshWindowMs) {
      const changed = await refreshAllJobs();
      if (changed.length > 0) notifyWaiters();
      await publishChangedJobList(changed);
      return snapshot();
    }

    const ids = await discoverJobIds();
    const changedJobs = new Map<string, QueueJob>();
    const idsToRefresh = [
      ...new Set([
        ...ids.filter((jobId) => !index.jobsById.has(jobId)),
        ...[...index.jobsById.values()]
          .filter((job) => !TERMINAL.has(job.status))
          .map((job) => job.id),
      ]),
    ];
    if (idsToRefresh.length === 0) return snapshot();

    await withWriteLock(async () => {
      for (const jobId of idsToRefresh) {
        await loadAuthoritativeJob(jobId, changedJobs);
      }
      index.loaded = true;
    });
    const changed = [...changedJobs.values()].sort(compareRecentJobs);
    if (changed.length > 0) notifyWaiters();
    await publishChangedJobList(changed);
    return snapshot();
  };

  const syncDiscoveredJobs = async (force = false): Promise<void> => {
    const ts = nowTs();
    if (!force && index.loaded && ts - manifestSyncAt < discoverySyncWindowMs) return;
    manifestSyncAt = ts;
    const ids = await discoverJobIds();
    if (!index.loaded && ids.length === 0) {
      index.loaded = true;
      return;
    }
    const missing = ids.filter((jobId) => !index.jobsById.has(jobId));
    if (missing.length === 0) {
      index.loaded = true;
      return;
    }
    const changed = new Map<string, QueueJob>();
    await withWriteLock(async () => {
      for (const jobId of missing) {
        const loaded = await loadQueueJob(jobId);
        if (!loaded) continue;
        upsertIndexedJob(loaded);
        changed.set(loaded.id, cloneJob(loaded));
      }
      index.loaded = true;
    });
    if (changed.size > 0) notifyWaiters();
    await publishChangedJobs(changed);
  };

  const ensureIndexLoaded = async (): Promise<void> => {
    if (index.loaded) return;
    await refresh();
  };

  const getIndexedJob = async (jobId: string): Promise<QueueJob | undefined> => {
    const changed = new Map<string, QueueJob>();
    const loaded = await withWriteLock(async () => {
      const current = await loadAuthoritativeJob(jobId, changed);
      if (current) {
        knownJobIds = knownJobIds && knownJobIds.includes(jobId)
          ? knownJobIds
          : [...(knownJobIds ?? []), jobId];
      }
      return current;
    });
    if (changed.size > 0) {
      notifyWaiters();
      await publishChangedJobs(changed);
    }
    return loaded;
  };

  const handleExpiredLeases = async (
    timestamp: number,
    changedJobs: Map<string, QueueJob>,
  ): Promise<void> => {
    for (const jobId of [...index.leasedJobs]) {
      const indexed = index.jobsById.get(jobId);
      if (!indexed || !indexed.leaseUntil || indexed.leaseUntil > timestamp) continue;
      const job = await loadAuthoritativeJob(jobId, changedJobs);
      if (!job) continue;
      if (!LEASED_STATUSES.has(job.status) || !job.leaseUntil) continue;
      if (job.leaseUntil > timestamp) continue;
      const retryable = job.attempt < job.maxAttempts;
      await emitEvent({
        type: "job.lease_expired",
        jobId: job.id,
        retryable,
        willRetry: retryable,
      }, changedJobs);
    }
  };

  const sortedByRecent = (all: ReadonlyArray<QueueJob>): QueueJob[] =>
    [...all].sort((a, b) =>
      b.updatedAt - a.updatedAt
      || b.createdAt - a.createdAt
      || b.id.localeCompare(a.id)
    );

  const activeBySession = (sessionKey: string, excludeId?: string): QueueJob[] => {
    const members = index.sessionJobs.get(sessionKey);
    if (!members) return [];
    return [...members]
      .map((jobId) => index.jobsById.get(jobId))
      .filter((job): job is QueueJob => Boolean(job))
      .filter((job) => !TERMINAL.has(job.status) && job.id !== excludeId);
  };

  const matchingAgentIds = (lease: LeaseOptions): ReadonlySet<string> => {
    const agentIds = new Set<string>();
    const single = typeof lease.agentId === "string" ? lease.agentId.trim() : "";
    if (single) agentIds.add(single);
    for (const candidate of lease.agentIds ?? []) {
      const normalized = typeof candidate === "string" ? candidate.trim() : "";
      if (normalized) agentIds.add(normalized);
    }
    return agentIds;
  };

  const matchingLanes = (lease: LeaseOptions): ReadonlySet<JobLane> => {
    const lanes = new Set<JobLane>();
    for (const candidate of lease.lanes ?? []) {
      if (candidate === "chat" || candidate === "collect" || candidate === "steer" || candidate === "follow_up") {
        lanes.add(candidate);
      }
    }
    return lanes;
  };

  const requestAbort = async (
    job: QueueJob,
    reason: string,
    changedJobs: Map<string, QueueJob>,
  ): Promise<void> => {
    if (job.status === "queued") {
      await emitEvent({
        type: "job.canceled",
        jobId: job.id,
        reason,
      }, changedJobs);
      return;
    }
    const ts = nowTs();
    const commandId = `cmd_${ts.toString(36)}_${randomUUID().slice(0, 6)}`;
    await emitEvent({
      type: "queue.command",
      jobId: job.id,
      commandId,
      command: "abort",
      lane: "steer",
      payload: { reason },
      createdAt: ts,
    }, changedJobs);
  };

  const requestSteer = async (
    job: QueueJob,
    payload: Record<string, unknown>,
    changedJobs: Map<string, QueueJob>,
  ): Promise<void> => {
    const ts = nowTs();
    const commandId = `cmd_${ts.toString(36)}_${randomUUID().slice(0, 6)}`;
    await emitEvent({
      type: "queue.command",
      jobId: job.id,
      commandId,
      command: "steer",
      lane: "steer",
      payload,
      createdAt: ts,
    }, changedJobs);
  };

  return {
    enqueue: async (input) => {
      const singletonMode = input.singletonMode ?? "allow";
      const requiresSessionScan = singletonMode === "cancel" || singletonMode === "steer";
      if (requiresSessionScan) {
        await ensureIndexLoaded();
        await syncDiscoveredJobs(true);
      }
      const changed = new Map<string, QueueJob>();
      const created = await withWriteLock(async () => {
        const ts = nowTs();
        const jobId = input.jobId ?? `job_${ts.toString(36)}_${randomUUID().slice(0, 6)}`;
        const existing = await loadAuthoritativeJob(jobId, changed);
        if (existing) return cloneJob(existing);
        const sessionKey = typeof input.sessionKey === "string" && input.sessionKey.trim()
          ? input.sessionKey.trim()
          : undefined;
        if (sessionKey && requiresSessionScan) {
          const active = sortedByRecent(activeBySession(sessionKey, jobId));
          if (singletonMode === "cancel" && active.length > 0) {
            for (const prior of active) {
              await requestAbort(prior, "singleton cancel", changed);
            }
          } else if (singletonMode === "steer" && active.length > 0) {
            const target = active[0];
            if (target) {
              await requestSteer(target, {
                fromSessionKey: sessionKey,
                fromEnqueue: true,
                payload: input.payload,
              }, changed);
              return cloneJob(target);
            }
          }
        }
        const job: QueueJob = {
          id: jobId,
          agentId: input.agentId,
          lane: input.lane ?? "collect",
          sessionKey,
          singletonMode,
          payload: input.payload,
          status: "queued",
          attempt: 0,
          maxAttempts: Math.max(1, Math.min(input.maxAttempts ?? 2, 8)),
          createdAt: ts,
          updatedAt: ts,
          commands: [],
        };
        await emitEvent({
          type: "job.enqueued",
          jobId: job.id,
          agentId: job.agentId,
          lane: job.lane,
          payload: job.payload,
          maxAttempts: job.maxAttempts,
          sessionKey: job.sessionKey,
          singletonMode: job.singletonMode,
          createdAt: job.createdAt,
        }, changed);
        const next = index.jobsById.get(job.id);
        if (!next) throw new Error(`Invariant: missing job ${job.id} after enqueue`);
        return cloneJob(next);
      });
      notifyWaiters();
      await publishChangedJobs(changed);
      return created;
    },

    leaseNext: async (lease) => {
      await ensureIndexLoaded();
      await syncDiscoveredJobs();
      const changed = new Map<string, QueueJob>();
      const leased = await withWriteLock(async () => {
        const ts = nowTs();
        await handleExpiredLeases(ts, changed);
        const agentIds = matchingAgentIds(lease);
        const lanes = matchingLanes(lease);
        let next: QueueJob | undefined;
        for (const jobId of [...index.queuedJobIds]) {
          const indexed = index.jobsById.get(jobId);
          if (!indexed || !shouldQueueJob(indexed)) continue;
          if (agentIds.size > 0 && !agentIds.has(indexed.agentId)) continue;
          if (lanes.size > 0 && !lanes.has(indexed.lane)) continue;
          const current = await loadAuthoritativeJob(jobId, changed);
          if (!current || !shouldQueueJob(current)) continue;
          if (agentIds.size > 0 && !agentIds.has(current.agentId)) continue;
          if (lanes.size > 0 && !lanes.has(current.lane)) continue;
          next = current;
          break;
        }
        if (!next) return undefined;
        const attempt = next.attempt + 1;
        await emitEvent({
          type: "job.leased",
          jobId: next.id,
          workerId: lease.workerId,
          leaseMs: Math.max(1_000, lease.leaseMs),
          attempt,
        }, changed);
        const current = index.jobsById.get(next.id);
        return current ? cloneJob(current) : undefined;
      });
      if (changed.size > 0) notifyWaiters();
      await publishChangedJobs(changed);
      return leased;
    },

    leaseJob: async (jobId, workerId, leaseMs) => {
      const changed = new Map<string, QueueJob>();
      const leased = await withWriteLock(async () => {
        const currentJob = await loadAuthoritativeJob(jobId, changed);
        if (!currentJob) return undefined;
        if (currentJob.status !== "queued") return cloneJob(currentJob);
        const attempt = currentJob.attempt + 1;
        await emitEvent({
          type: "job.leased",
          jobId,
          workerId,
          leaseMs: Math.max(1_000, leaseMs),
          attempt,
        }, changed);
        const next = index.jobsById.get(jobId);
        return next ? cloneJob(next) : undefined;
      });
      if (changed.size > 0) notifyWaiters();
      await publishChangedJobs(changed);
      return leased;
    },

    heartbeat: async (jobId, workerId, leaseMs) => {
      const changed = new Map<string, QueueJob>();
      const current = await withWriteLock(async () => {
        const currentJob = await loadAuthoritativeJob(jobId, changed);
        if (!currentJob) return undefined;
        if (TERMINAL.has(currentJob.status)) return cloneJob(currentJob);
        if (currentJob.leaseOwner && currentJob.leaseOwner !== workerId) return undefined;
        await emitEvent({
          type: "job.heartbeat",
          jobId,
          workerId,
          leaseMs: Math.max(1_000, leaseMs),
        }, changed);
        const next = index.jobsById.get(jobId);
        return next ? cloneJob(next) : undefined;
      });
      if (changed.size > 0) notifyWaiters();
      await publishChangedJobs(changed);
      return current;
    },

    progress: async (jobId, workerId, result) => {
      const changed = new Map<string, QueueJob>();
      const current = await withWriteLock(async () => {
        const currentJob = await loadAuthoritativeJob(jobId, changed);
        if (!currentJob) return undefined;
        if (TERMINAL.has(currentJob.status)) return cloneJob(currentJob);
        if (currentJob.leaseOwner && currentJob.leaseOwner !== workerId) return undefined;
        await emitEvent({
          type: "job.progress",
          jobId,
          workerId,
          result,
        }, changed);
        const next = index.jobsById.get(jobId);
        return next ? cloneJob(next) : undefined;
      });
      if (changed.size > 0) notifyWaiters();
      await publishChangedJobs(changed);
      return current;
    },

    complete: async (jobId, workerId, result) => {
      const changed = new Map<string, QueueJob>();
      const current = await withWriteLock(async () => {
        const currentJob = await loadAuthoritativeJob(jobId, changed);
        if (!currentJob) return undefined;
        if (TERMINAL.has(currentJob.status)) return cloneJob(currentJob);
        if (currentJob.leaseOwner && currentJob.leaseOwner !== workerId) return undefined;
        await emitEvent({
          type: "job.completed",
          jobId,
          workerId,
          result,
        }, changed);
        const next = index.jobsById.get(jobId);
        return next ? cloneJob(next) : undefined;
      });
      if (changed.size > 0) notifyWaiters();
      await publishChangedJobs(changed);
      return current;
    },

    fail: async (jobId, workerId, error, noRetry, result) => {
      const changed = new Map<string, QueueJob>();
      const current = await withWriteLock(async () => {
        const currentJob = await loadAuthoritativeJob(jobId, changed);
        if (!currentJob) return undefined;
        if (TERMINAL.has(currentJob.status)) return cloneJob(currentJob);
        if (currentJob.leaseOwner && currentJob.leaseOwner !== workerId) return undefined;
        const retryable = currentJob.attempt < currentJob.maxAttempts && !noRetry;
        await emitEvent({
          type: "job.failed",
          jobId,
          workerId,
          error,
          retryable,
          willRetry: retryable,
          result: retryable ? undefined : result,
        }, changed);
        const next = index.jobsById.get(jobId);
        return next ? cloneJob(next) : undefined;
      });
      if (changed.size > 0) notifyWaiters();
      await publishChangedJobs(changed);
      return current;
    },

    cancel: async (jobId, reason, by) => {
      const changed = new Map<string, QueueJob>();
      const current = await withWriteLock(async () => {
        const currentJob = await loadAuthoritativeJob(jobId, changed);
        if (!currentJob) return undefined;
        if (TERMINAL.has(currentJob.status)) return cloneJob(currentJob);
        await emitEvent({
          type: "job.canceled",
          jobId,
          reason,
          by,
        }, changed);
        const next = index.jobsById.get(jobId);
        return next ? cloneJob(next) : undefined;
      });
      if (changed.size > 0) notifyWaiters();
      await publishChangedJobs(changed);
      return current;
    },

    queueCommand: async (input) => {
      const changed = new Map<string, QueueJob>();
      const command = await withWriteLock(async () => {
        const current = await loadAuthoritativeJob(input.jobId, changed);
        if (!current) return undefined;
        const ts = nowTs();
        const queuedCommand: QueueCommandRecord = {
          id: `cmd_${ts.toString(36)}_${randomUUID().slice(0, 6)}`,
          command: input.command,
          lane: commandLane(input.command),
          payload: input.payload,
          by: input.by,
          createdAt: ts,
        };
        await emitEvent({
          type: "queue.command",
          jobId: input.jobId,
          commandId: queuedCommand.id,
          command: input.command,
          lane: commandLane(input.command),
          payload: input.payload,
          by: input.by,
          createdAt: ts,
        }, changed);
        if (input.command === "abort" && current.status === "queued") {
          await emitEvent({
            type: "job.canceled",
            jobId: input.jobId,
            reason: "abort requested",
            by: input.by,
          }, changed);
        }
        return queuedCommand;
      });
      if (changed.size > 0) notifyWaiters();
      await publishChangedJobs(changed);
      return command;
    },

    consumeCommands: async (jobId, filter) => {
      const changed = new Map<string, QueueJob>();
      const consumed = await withWriteLock(async () => {
        const current = await loadAuthoritativeJob(jobId, changed);
        if (!current) return [];
        const wanted = new Set(filter ?? ["steer", "follow_up", "abort"]);
        const unconsumed = current.commands.filter((cmd) => !cmd.consumedAt && wanted.has(cmd.command));
        if (unconsumed.length === 0) return [];
        const ts = nowTs();
        for (const cmd of unconsumed) {
          await emitEvent({
            type: "queue.command.consumed",
            jobId,
            commandId: cmd.id,
            consumedAt: ts,
          }, changed);
        }
        return unconsumed.map((cmd) => ({ ...cmd, consumedAt: ts }));
      });
      if (changed.size > 0) notifyWaiters();
      await publishChangedJobs(changed);
      return consumed;
    },

    getJob: async (jobId) => getIndexedJob(jobId),

    listJobs: async (options) => {
      await ensureIndexLoaded();
      await syncDiscoveredJobs();
      const limit = Math.max(1, Math.min(options?.limit ?? 50, 500));
      const listed: QueueJob[] = [];
      for (const jobId of index.recentJobIds) {
        const job = index.jobsById.get(jobId);
        if (!job) continue;
        if (options?.status && job.status !== options.status) continue;
        listed.push(cloneJob(job));
        if (listed.length >= limit) break;
      }
      return listed;
    },

    waitForJob: async (jobId, timeoutMs = 15_000, _pollMs = 200) => {
      void _pollMs;
      const end = nowTs() + Math.max(0, timeoutMs);
      let sinceVersion = snapshot().version;
      while (nowTs() <= end) {
        const current = await getIndexedJob(jobId);
        if (current && TERMINAL.has(current.status)) return cloneJob(current);
        const remaining = Math.max(0, end - nowTs());
        const next = await waitForSnapshot({
          timeoutMs: Math.min(remaining, CROSS_PROCESS_POLL_MS),
          ready: (currentSnapshot) => currentSnapshot.version > sinceVersion,
        });
        sinceVersion = next.version;
      }
      const current = await getIndexedJob(jobId);
      return current ? cloneJob(current) : undefined;
    },

    waitForWork: async (options) => {
      const sinceVersion = options?.sinceVersion ?? snapshot().version;
      const timeoutMs = typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
        ? Math.max(0, options.timeoutMs)
        : undefined;
      const wakeOnQueued = options?.wakeOnQueued ?? true;
      let current = snapshot();
      if (current.version > sinceVersion || (wakeOnQueued && current.queued > 0)) return current;
      const waitMs = timeoutMs ?? CROSS_PROCESS_POLL_MS;
      if (waitMs === 0) return refresh();

      current = await waitForSnapshot({
        timeoutMs: waitMs,
        ready: (next) => next.version > sinceVersion || (wakeOnQueued && next.queued > 0),
      });
      if (current.version > sinceVersion || (wakeOnQueued && current.queued > 0)) return current;
      return refresh();
    },

    notifyWorkAvailable: () => {
      notifyWaiters(true);
    },

    snapshot,
    refresh,
  };
};
