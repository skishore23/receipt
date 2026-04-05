import { createRuntime, type Runtime } from "@receipt/core/runtime";

import { getProjectionOffset, getReceiptDb, latestGlobalSeq, listChangedStreams, listStreamsByPrefix, setProjectionOffset } from "./client";
import { jsonParse, jsonParseOptional, jsonStringify } from "./json";
import {
  chatSessionStreamFromStream,
  isFactoryChatSessionStream,
  projectFactoryChatContextFromReceipts,
  type FactoryChatContextProjection,
} from "../agents/factory/chat-context";
import type { MemoryCmd, MemoryEvent, MemoryState } from "../adapters/memory-tools";
import type { JobCmd, JobCommandRecord, JobEvent, JobRecord, JobState } from "../modules/job";
import { buildFactoryProjection } from "../modules/factory/selectors";
import type { FactoryCmd, FactoryEvent } from "../modules/factory/events";
import type { FactoryState } from "../modules/factory/types";
import type { QueueCommandType } from "../modules/job";
import { decideMemory, initialMemoryState, reduceMemory } from "../adapters/memory-tools";
import { jsonBranchStore, jsonlStore } from "../adapters/jsonl";

export const JOB_PROJECTOR = "job_projection";
export const OBJECTIVE_PROJECTOR = "objective_projection";
export const CHAT_CONTEXT_PROJECTOR = "chat_context_projection";
export const MEMORY_PROJECTOR = "memory_projection";

const jobIdFromStream = (stream: string): string | undefined =>
  stream.startsWith("jobs/") && !stream.slice("jobs/".length).includes("/")
    ? stream.slice("jobs/".length)
    : undefined;

const scopeFromMemoryStream = (stream: string): string | undefined =>
  stream.startsWith("memory/") ? stream.slice("memory/".length) : undefined;

const sessionStreamFromChangedStream = (stream: string): string | undefined =>
  isFactoryChatSessionStream(stream) ? stream : chatSessionStreamFromStream(stream);

export type StoredJobProjection = {
  readonly id: string;
  readonly agentId: string;
  readonly lane: JobRecord["lane"];
  readonly sessionKey?: string;
  readonly idempotencyKey?: string;
  readonly singletonMode?: "allow" | "cancel" | "steer";
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: JobRecord["status"];
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
  readonly commands: ReadonlyArray<JobCommandRecord>;
};

const toStoredJob = (record: JobRecord): StoredJobProjection => ({
  id: record.id,
  agentId: record.agentId,
  lane: record.lane,
  sessionKey: record.sessionKey,
  idempotencyKey: record.idempotencyKey,
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
  commands: record.commands.map((command) => ({ ...command, payload: command.payload ? { ...command.payload } : undefined })),
});

export const syncJobProjectionStream = async (
  dataDir: string,
  runtime: Runtime<JobCmd, JobEvent, JobState>,
  stream: string,
): Promise<StoredJobProjection | undefined> => {
  const jobId = jobIdFromStream(stream);
  if (!jobId) return undefined;
  const db = getReceiptDb(dataDir);
  const state = await runtime.state(stream);
  const record = state.jobs[jobId];
  const tx = db.sqlite.transaction(() => {
    db.sqlite.query("DELETE FROM job_pending_commands WHERE job_id = ?").run(jobId);
    if (!record) {
      db.sqlite.query("DELETE FROM job_projection WHERE job_id = ?").run(jobId);
      return;
    }
    const stored = toStoredJob(record);
    db.sqlite.query(`
      INSERT INTO job_projection (
        job_id,
        stream,
        agent_id,
        lane,
        session_key,
        singleton_mode,
        payload_json,
        status,
        attempt,
        max_attempts,
        created_at,
        updated_at,
        lease_owner,
        lease_until,
        last_error,
        result_json,
        canceled_reason,
        abort_requested,
        commands_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        stream = excluded.stream,
        agent_id = excluded.agent_id,
        lane = excluded.lane,
        session_key = excluded.session_key,
        singleton_mode = excluded.singleton_mode,
        payload_json = excluded.payload_json,
        status = excluded.status,
        attempt = excluded.attempt,
        max_attempts = excluded.max_attempts,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        lease_owner = excluded.lease_owner,
        lease_until = excluded.lease_until,
        last_error = excluded.last_error,
        result_json = excluded.result_json,
        canceled_reason = excluded.canceled_reason,
        abort_requested = excluded.abort_requested,
        commands_json = excluded.commands_json
    `).run(
      stored.id,
      stream,
      stored.agentId,
      stored.lane,
      stored.sessionKey ?? null,
      stored.singletonMode ?? null,
      jsonStringify(stored.payload),
      stored.status,
      stored.attempt,
      stored.maxAttempts,
      stored.createdAt,
      stored.updatedAt,
      stored.leaseOwner ?? null,
      stored.leaseUntil ?? null,
      stored.lastError ?? null,
      stored.result ? jsonStringify(stored.result) : null,
      stored.canceledReason ?? null,
      stored.abortRequested ? 1 : 0,
      jsonStringify(stored.commands),
    );
    for (const command of stored.commands.filter((item) => !item.consumedAt)) {
      db.sqlite.query(`
        INSERT INTO job_pending_commands (
          command_id,
          job_id,
          command,
          lane,
          payload_json,
          by,
          created_at,
          consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        command.id,
        stored.id,
        command.command,
        command.lane,
        command.payload ? jsonStringify(command.payload) : null,
        command.by ?? null,
        command.createdAt,
        command.consumedAt ?? null,
      );
    }
  });
  tx();
  return record ? toStoredJob(record) : undefined;
};

export const syncJobProjectionHeartbeat = (
  dataDir: string,
  jobId: string,
  leaseUntil: number,
  updatedAt: number,
): void => {
  const db = getReceiptDb(dataDir);
  db.sqlite.query(
    `UPDATE job_projection SET lease_until = ?, updated_at = ? WHERE job_id = ?`,
  ).run(leaseUntil, updatedAt, jobId);
};

export const syncChangedJobProjections = async (
  dataDir: string,
  runtime: Runtime<JobCmd, JobEvent, JobState>,
): Promise<ReadonlyArray<string>> => {
  const db = getReceiptDb(dataDir);
  const lastOffset = getProjectionOffset(db, JOB_PROJECTOR);
  const changed = listChangedStreams(db, { afterGlobalSeq: lastOffset, streamPrefix: "jobs/" });
  const bootstrapStreams = changed.length === 0 && lastOffset === 0
    ? listStreamsByPrefix(db, "jobs/")
    : [];
  const streams = changed.length > 0 ? changed.map((entry) => entry.stream) : bootstrapStreams;
  if (streams.length === 0) return [];
  for (const stream of streams) {
    await syncJobProjectionStream(dataDir, runtime, stream);
  }
  setProjectionOffset(db, JOB_PROJECTOR, latestGlobalSeq(db));
  return streams
    .map((stream) => jobIdFromStream(stream))
    .filter((jobId): jobId is string => Boolean(jobId));
};

export const readJobProjection = (dataDir: string, jobId: string): StoredJobProjection | undefined => {
  const db = getReceiptDb(dataDir);
  const row = db.sqlite.query(`
    SELECT
      job_id,
      agent_id,
      lane,
      session_key,
      singleton_mode,
      payload_json,
      status,
      attempt,
      max_attempts,
      created_at,
      updated_at,
      lease_owner,
      lease_until,
      last_error,
      result_json,
      canceled_reason,
      abort_requested,
      commands_json
    FROM job_projection
    WHERE job_id = ?
  `).get(jobId) as {
    readonly job_id: string;
    readonly agent_id: string;
    readonly lane: JobRecord["lane"];
    readonly session_key: string | null;
    readonly singleton_mode: "allow" | "cancel" | "steer" | null;
    readonly payload_json: string;
    readonly status: JobRecord["status"];
    readonly attempt: number;
    readonly max_attempts: number;
    readonly created_at: number;
    readonly updated_at: number;
    readonly lease_owner: string | null;
    readonly lease_until: number | null;
    readonly last_error: string | null;
    readonly result_json: string | null;
    readonly canceled_reason: string | null;
    readonly abort_requested: number;
    readonly commands_json: string;
  } | null;
  return row ? {
    id: row.job_id,
    agentId: row.agent_id,
    lane: row.lane,
    sessionKey: row.session_key ?? undefined,
    singletonMode: row.singleton_mode ?? undefined,
    payload: jsonParse<Readonly<Record<string, unknown>>>(row.payload_json, {}),
    status: row.status,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    leaseOwner: row.lease_owner ?? undefined,
    leaseUntil: row.lease_until ?? undefined,
    lastError: row.last_error ?? undefined,
    result: jsonParseOptional<Record<string, unknown>>(row.result_json),
    canceledReason: row.canceled_reason ?? undefined,
    abortRequested: Boolean(row.abort_requested),
    commands: jsonParse<ReadonlyArray<JobCommandRecord>>(row.commands_json, []),
  } : undefined;
};

export const listJobProjectionRows = (
  dataDir: string,
  options?: { readonly status?: JobRecord["status"]; readonly limit?: number },
): ReadonlyArray<StoredJobProjection> => {
  const db = getReceiptDb(dataDir);
  const limit = Math.max(1, Math.min(options?.limit ?? 50, 500));
  const rows = options?.status
    ? db.sqlite.query(`
        SELECT job_id
        FROM job_projection
        WHERE status = ?
        ORDER BY updated_at DESC, created_at DESC, job_id DESC
        LIMIT ?
      `).all(options.status, limit)
    : db.sqlite.query(`
        SELECT job_id
        FROM job_projection
        ORDER BY updated_at DESC, created_at DESC, job_id DESC
        LIMIT ?
      `).all(limit);
  return (rows as Array<{ readonly job_id: string }>).map((row) => readJobProjection(dataDir, row.job_id)).filter((job): job is StoredJobProjection => Boolean(job));
};

export const queueProjectionSnapshot = (dataDir: string): {
  readonly total: number;
  readonly queued: number;
  readonly leased: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly canceled: number;
  readonly updatedAt?: number;
} => {
  const db = getReceiptDb(dataDir);
  const counts = db.sqlite.query(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) AS canceled,
      MAX(updated_at) AS updated_at
    FROM job_projection
  `).get() as {
    readonly total: number | null;
    readonly queued: number | null;
    readonly leased: number | null;
    readonly running: number | null;
    readonly completed: number | null;
    readonly failed: number | null;
    readonly canceled: number | null;
    readonly updated_at: number | null;
  };
  return {
    total: Number(counts.total ?? 0),
    queued: Number(counts.queued ?? 0),
    leased: Number(counts.leased ?? 0),
    running: Number(counts.running ?? 0),
    completed: Number(counts.completed ?? 0),
    failed: Number(counts.failed ?? 0),
    canceled: Number(counts.canceled ?? 0),
    updatedAt: counts.updated_at ?? undefined,
  };
};

export const syncObjectiveProjectionStream = async (
  dataDir: string,
  runtime: Runtime<FactoryCmd, FactoryEvent, FactoryState>,
  stream: string,
): Promise<FactoryState | undefined> => {
  if (!stream.startsWith("factory/objectives/")) return undefined;
  const db = getReceiptDb(dataDir);
  const state = await runtime.state(stream);
  if (!state.objectiveId) {
    db.sqlite.query("DELETE FROM objective_projection WHERE stream = ?").run(stream);
    return undefined;
  }
  const projection = buildFactoryProjection(state);
  db.sqlite.query(`
    INSERT INTO objective_projection (
      objective_id,
      stream,
      title,
      objective_mode,
      severity,
      status,
      archived_at,
      created_at,
      updated_at,
      latest_summary,
      blocked_reason,
      integration_status,
      slot_state,
      active_task_count,
      ready_task_count,
      task_count,
      state_json,
      projection_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(objective_id) DO UPDATE SET
      stream = excluded.stream,
      title = excluded.title,
      objective_mode = excluded.objective_mode,
      severity = excluded.severity,
      status = excluded.status,
      archived_at = excluded.archived_at,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      latest_summary = excluded.latest_summary,
      blocked_reason = excluded.blocked_reason,
      integration_status = excluded.integration_status,
      slot_state = excluded.slot_state,
      active_task_count = excluded.active_task_count,
      ready_task_count = excluded.ready_task_count,
      task_count = excluded.task_count,
      state_json = excluded.state_json,
      projection_json = excluded.projection_json
  `).run(
    state.objectiveId,
    stream,
    state.title,
    state.objectiveMode,
    state.severity,
    state.status,
    state.archivedAt ?? null,
    state.createdAt,
    state.updatedAt,
    state.latestSummary ?? null,
    state.blockedReason ?? null,
    state.integration.status,
    state.scheduler.slotState ?? "queued",
    projection.activeTasks.length,
    projection.readyTasks.length,
    projection.tasks.length,
    jsonStringify(state),
    jsonStringify(projection),
  );
  return state;
};

export const syncChangedObjectiveProjections = async (
  dataDir: string,
  runtime: Runtime<FactoryCmd, FactoryEvent, FactoryState>,
): Promise<ReadonlyArray<string>> => {
  const db = getReceiptDb(dataDir);
  const lastOffset = getProjectionOffset(db, OBJECTIVE_PROJECTOR);
  const changed = listChangedStreams(db, { afterGlobalSeq: lastOffset, streamPrefix: "factory/objectives/" });
  const bootstrapStreams = changed.length === 0 && lastOffset === 0
    ? listStreamsByPrefix(db, "factory/objectives/")
    : [];
  const streams = changed.length > 0 ? changed.map((entry) => entry.stream) : bootstrapStreams;
  if (streams.length === 0) return [];
  for (const stream of streams) {
    await syncObjectiveProjectionStream(dataDir, runtime, stream);
  }
  setProjectionOffset(db, OBJECTIVE_PROJECTOR, latestGlobalSeq(db));
  return streams;
};

export const readObjectiveStatesFromProjection = (
  dataDir: string,
): ReadonlyArray<FactoryState> => {
  const db = getReceiptDb(dataDir);
  const rows = db.sqlite.query(`
    SELECT state_json
    FROM objective_projection
    ORDER BY created_at ASC, objective_id ASC
  `).all() as Array<{ readonly state_json: string }>;
  return rows.map((row) => jsonParse<FactoryState>(row.state_json, {} as FactoryState));
};

export const syncChatContextProjectionStream = async (
  dataDir: string,
  sessionStream: string,
): Promise<FactoryChatContextProjection | undefined> => {
  if (!isFactoryChatSessionStream(sessionStream)) return undefined;
  const db = getReceiptDb(dataDir);
  const rows = db.sqlite.query(`
    SELECT
      global_seq,
      stream,
      receipt_id,
      ts,
      hash,
      event_type,
      body_json
    FROM receipts
    WHERE stream = ? OR stream LIKE ?
    ORDER BY global_seq ASC
  `).all(sessionStream, `${sessionStream}/runs/%`) as Array<{
    readonly global_seq: number;
    readonly stream: string;
    readonly receipt_id: string;
    readonly ts: number;
    readonly hash: string;
    readonly event_type: string;
    readonly body_json: string;
  }>;
  if (rows.length === 0) {
    db.sqlite.query("DELETE FROM chat_context_projection WHERE stream = ?").run(sessionStream);
    return undefined;
  }
  const projection = projectFactoryChatContextFromReceipts({
    sessionStream,
    receipts: rows.map((row) => ({
      stream: row.stream,
      ts: Number(row.ts),
      hash: row.hash,
      id: row.receipt_id,
      eventType: row.event_type,
      globalSeq: Number(row.global_seq),
      body: jsonParse(row.body_json, {} as never),
    })),
    updatedAt: Date.now(),
  });
  if (!projection) {
    db.sqlite.query("DELETE FROM chat_context_projection WHERE stream = ?").run(sessionStream);
    return undefined;
  }
  db.sqlite.query(`
    INSERT INTO chat_context_projection (
      stream,
      chat_id,
      profile_id,
      updated_at,
      bound_objective_id,
      latest_run_id,
      last_global_seq,
      context_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stream) DO UPDATE SET
      chat_id = excluded.chat_id,
      profile_id = excluded.profile_id,
      updated_at = excluded.updated_at,
      bound_objective_id = excluded.bound_objective_id,
      latest_run_id = excluded.latest_run_id,
      last_global_seq = excluded.last_global_seq,
      context_json = excluded.context_json
  `).run(
    sessionStream,
    projection.chatId,
    projection.profileId,
    projection.updatedAt,
    projection.bindings.objectiveId ?? null,
    projection.bindings.latestRunId ?? null,
    projection.source.lastGlobalSeq,
    jsonStringify(projection),
  );
  return projection;
};

export const syncChangedChatContextProjections = async (
  dataDir: string,
): Promise<ReadonlyArray<string>> => {
  const db = getReceiptDb(dataDir);
  const lastOffset = getProjectionOffset(db, CHAT_CONTEXT_PROJECTOR);
  const changed = listChangedStreams(db, { afterGlobalSeq: lastOffset, streamPrefix: "agents/factory/" });
  const bootstrapStreams = changed.length === 0 && lastOffset === 0
    ? listStreamsByPrefix(db, "agents/factory/").filter((stream) => isFactoryChatSessionStream(stream))
    : [];
  const streams = changed.length > 0
    ? [...new Set(
        changed
          .map((entry) => sessionStreamFromChangedStream(entry.stream))
          .filter((stream): stream is string => Boolean(stream)),
      )]
    : bootstrapStreams;
  if (streams.length === 0) return [];
  for (const stream of streams) {
    await syncChatContextProjectionStream(dataDir, stream);
  }
  setProjectionOffset(db, CHAT_CONTEXT_PROJECTOR, latestGlobalSeq(db));
  return streams;
};

export const readChatContextProjection = (
  dataDir: string,
  sessionStream: string,
): FactoryChatContextProjection | undefined => {
  const db = getReceiptDb(dataDir);
  const row = db.sqlite.query(`
    SELECT context_json
    FROM chat_context_projection
    WHERE stream = ?
  `).get(sessionStream) as {
    readonly context_json: string;
  } | null;
  return row ? jsonParse<FactoryChatContextProjection | undefined>(row.context_json, undefined) : undefined;
};

export const readChatContextProjectionVersion = (
  dataDir: string,
  sessionStream: string,
): number | undefined => {
  const db = getReceiptDb(dataDir);
  const row = db.sqlite.query(`
    SELECT last_global_seq
    FROM chat_context_projection
    WHERE stream = ?
  `).get(sessionStream) as {
    readonly last_global_seq: number;
  } | null;
  return row ? Number(row.last_global_seq) : undefined;
};

export const rebuildMemoryProjection = async (dataDir: string): Promise<void> => {
  const db = getReceiptDb(dataDir);
  const memoryRuntime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
    jsonlStore<MemoryEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideMemory,
    reduceMemory,
    initialMemoryState,
  );
  const streams = listStreamsByPrefix(db, "memory/");
  db.sqlite.exec("DELETE FROM memory_entries; DELETE FROM memory_accesses;");
  for (const stream of streams) {
    const scope = scopeFromMemoryStream(stream);
    if (!scope) continue;
    const state = await memoryRuntime.state(stream);
    for (const entry of [...state.entries].sort((left, right) => left.ts - right.ts || left.id.localeCompare(right.id))) {
      db.sqlite.query(`
        INSERT INTO memory_entries (entry_id, scope, text, tags_json, meta_json, ts)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        entry.id,
        entry.scope,
        entry.text,
        entry.tags ? jsonStringify(entry.tags) : null,
        entry.meta ? jsonStringify(entry.meta) : null,
        entry.ts,
      );
    }
    for (const access of [...state.accesses].sort((left, right) => left.ts - right.ts || left.id.localeCompare(right.id))) {
      db.sqlite.query(`
        INSERT INTO memory_accesses (
          access_id,
          scope,
          operation,
          strategy,
          query,
          "limit",
          max_chars,
          from_ts,
          to_ts,
          result_count,
          result_ids_json,
          summary_chars,
          meta_json,
          ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        access.id,
        access.scope,
        access.operation,
        access.strategy,
        access.query ?? null,
        access.limit ?? null,
        access.maxChars ?? null,
        access.fromTs ?? null,
        access.toTs ?? null,
        access.resultCount,
        access.resultIds ? jsonStringify(access.resultIds) : null,
        access.summaryChars ?? null,
        access.meta ? jsonStringify(access.meta) : null,
        access.ts,
      );
    }
  }
  setProjectionOffset(db, MEMORY_PROJECTOR, latestGlobalSeq(db));
};
