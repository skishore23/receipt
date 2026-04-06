import { createHash } from "node:crypto";

import { createRuntime, type Runtime } from "@receipt/core/runtime";
import { desc, eq, like, max, or, sql } from "drizzle-orm";

import { getProjectionOffset, getReceiptDb, latestGlobalSeq, listChangedStreams, listStreamsByPrefix, setProjectionOffset } from "./client";
import { jsonParse, jsonParseOptional, jsonStringify } from "./json";
import * as schema from "./schema";
import {
  chatSessionStreamFromStream,
  isFactoryChatSessionStream,
  parseFactoryChatSessionStream,
  projectFactoryChatContextFromReceipts,
  type FactoryChatContextProjection,
} from "../agents/factory/chat-context";
import type { MemoryCmd, MemoryEvent, MemoryState } from "../adapters/memory-tools";
import type { JobCmd, JobCommandRecord, JobEvent, JobRecord, JobState } from "../modules/job";
import { buildFactoryProjection } from "../modules/factory/selectors";
import type { FactoryCmd, FactoryEvent } from "../modules/factory/events";
import type { FactoryProjection, FactoryState } from "../modules/factory/types";
import { decideMemory, initialMemoryState, reduceMemory } from "../adapters/memory-tools";
import { sqliteBranchStore, sqliteReceiptStore } from "../adapters/sqlite";

export const JOB_PROJECTOR = "job_projection";
export const OBJECTIVE_PROJECTOR = "objective_projection";
export const CHAT_CONTEXT_PROJECTOR = "chat_context_projection";
export const MEMORY_PROJECTOR = "memory_projection";

const normalizeSessionMessageText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const stableSessionMessageId = (input: {
  readonly sessionStream: string;
  readonly runId: string;
  readonly role: string;
  readonly text: string;
}): string =>
  `msg_${createHash("sha1")
    .update([
      input.sessionStream,
      input.runId,
      input.role,
      normalizeSessionMessageText(input.text),
    ].join("\u0000"))
    .digest("hex")
    .slice(0, 20)}`;

const syncSessionMessageProjection = (
  dataDir: string,
  projection: FactoryChatContextProjection,
): void => {
  const parsed = parseFactoryChatSessionStream(projection.source.sessionStream);
  if (!parsed) return;
  const db = getReceiptDb(dataDir);
  db.write(() => {
    db.orm.delete(schema.sessionMessages)
      .where(eq(schema.sessionMessages.sessionStream, projection.source.sessionStream))
      .run();
    if (projection.conversation.length === 0) return;
    db.orm.insert(schema.sessionMessages)
      .values(projection.conversation.map((message) => {
        const orderKey = message.refs.reduce(
          (min, ref) => Math.min(min, ref.globalSeq ?? ref.ts),
          Number.POSITIVE_INFINITY,
        );
        return {
          messageId: stableSessionMessageId({
            sessionStream: projection.source.sessionStream,
            runId: message.runId,
            role: message.role,
            text: message.text,
          }),
          sessionStream: projection.source.sessionStream,
          chatId: projection.chatId,
          profileId: projection.profileId,
          repoKey: parsed.repoKey,
          runId: message.runId,
          role: message.role,
          text: message.text,
          ts: message.ts,
          orderKey: Number.isFinite(orderKey) ? orderKey : message.ts,
          receiptRefsJson: jsonStringify(message.refs),
        };
      }))
      .run();
  });
};

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
  db.transaction((tx) => {
    tx.delete(schema.jobPendingCommands)
      .where(eq(schema.jobPendingCommands.jobId, jobId))
      .run();
    if (!record) {
      tx.delete(schema.jobProjection)
        .where(eq(schema.jobProjection.jobId, jobId))
        .run();
      return;
    }
    const stored = toStoredJob(record);
    tx.insert(schema.jobProjection)
      .values({
        jobId: stored.id,
        stream,
        agentId: stored.agentId,
        lane: stored.lane,
        sessionKey: stored.sessionKey ?? null,
        singletonMode: stored.singletonMode ?? null,
        payloadJson: jsonStringify(stored.payload),
        status: stored.status,
        attempt: stored.attempt,
        maxAttempts: stored.maxAttempts,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        leaseOwner: stored.leaseOwner ?? null,
        leaseUntil: stored.leaseUntil ?? null,
        lastError: stored.lastError ?? null,
        resultJson: stored.result ? jsonStringify(stored.result) : null,
        canceledReason: stored.canceledReason ?? null,
        abortRequested: stored.abortRequested ?? false,
        commandsJson: jsonStringify(stored.commands),
      })
      .onConflictDoUpdate({
        target: schema.jobProjection.jobId,
        set: {
          stream,
          agentId: stored.agentId,
          lane: stored.lane,
          sessionKey: stored.sessionKey ?? null,
          singletonMode: stored.singletonMode ?? null,
          payloadJson: jsonStringify(stored.payload),
          status: stored.status,
          attempt: stored.attempt,
          maxAttempts: stored.maxAttempts,
          createdAt: stored.createdAt,
          updatedAt: stored.updatedAt,
          leaseOwner: stored.leaseOwner ?? null,
          leaseUntil: stored.leaseUntil ?? null,
          lastError: stored.lastError ?? null,
          resultJson: stored.result ? jsonStringify(stored.result) : null,
          canceledReason: stored.canceledReason ?? null,
          abortRequested: stored.abortRequested ?? false,
          commandsJson: jsonStringify(stored.commands),
        },
      })
      .run();
    const pendingCommands = stored.commands
      .filter((item) => !item.consumedAt)
      .map((command) => ({
        commandId: command.id,
        jobId: stored.id,
        command: command.command,
        lane: command.lane,
        payloadJson: command.payload ? jsonStringify(command.payload) : null,
        by: command.by ?? null,
        createdAt: command.createdAt,
        consumedAt: command.consumedAt ?? null,
      }));
    if (pendingCommands.length > 0) {
      tx.insert(schema.jobPendingCommands).values(pendingCommands).run();
    }
  });
  return record ? toStoredJob(record) : undefined;
};

export const syncJobProjectionHeartbeat = (
  dataDir: string,
  jobId: string,
  leaseUntil: number,
  updatedAt: number,
): void => {
  const db = getReceiptDb(dataDir);
  db.write(() => {
    db.orm.update(schema.jobProjection)
      .set({ leaseUntil, updatedAt })
      .where(eq(schema.jobProjection.jobId, jobId))
      .run();
  });
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
  const row = db.read(() => db.orm.select({
    jobId: schema.jobProjection.jobId,
    agentId: schema.jobProjection.agentId,
    lane: schema.jobProjection.lane,
    sessionKey: schema.jobProjection.sessionKey,
    singletonMode: schema.jobProjection.singletonMode,
    payloadJson: schema.jobProjection.payloadJson,
    status: schema.jobProjection.status,
    attempt: schema.jobProjection.attempt,
    maxAttempts: schema.jobProjection.maxAttempts,
    createdAt: schema.jobProjection.createdAt,
    updatedAt: schema.jobProjection.updatedAt,
    leaseOwner: schema.jobProjection.leaseOwner,
    leaseUntil: schema.jobProjection.leaseUntil,
    lastError: schema.jobProjection.lastError,
    resultJson: schema.jobProjection.resultJson,
    canceledReason: schema.jobProjection.canceledReason,
    abortRequested: schema.jobProjection.abortRequested,
    commandsJson: schema.jobProjection.commandsJson,
  })
    .from(schema.jobProjection)
    .where(eq(schema.jobProjection.jobId, jobId))
    .get());
  return row ? {
    id: row.jobId,
    agentId: row.agentId,
    lane: row.lane as JobRecord["lane"],
    sessionKey: row.sessionKey ?? undefined,
    singletonMode: (row.singletonMode ?? undefined) as StoredJobProjection["singletonMode"],
    payload: jsonParse<Readonly<Record<string, unknown>>>(row.payloadJson, {}),
    status: row.status as JobRecord["status"],
    attempt: Number(row.attempt),
    maxAttempts: Number(row.maxAttempts),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    leaseOwner: row.leaseOwner ?? undefined,
    leaseUntil: row.leaseUntil ?? undefined,
    lastError: row.lastError ?? undefined,
    result: jsonParseOptional<Record<string, unknown>>(row.resultJson),
    canceledReason: row.canceledReason ?? undefined,
    abortRequested: Boolean(row.abortRequested),
    commands: jsonParse<ReadonlyArray<JobCommandRecord>>(row.commandsJson, []),
  } : undefined;
};

export const listJobProjectionRows = (
  dataDir: string,
  options?: { readonly status?: JobRecord["status"]; readonly limit?: number },
): ReadonlyArray<StoredJobProjection> => {
  const db = getReceiptDb(dataDir);
  const limit = Math.max(1, Math.min(options?.limit ?? 50, 500));
  const rows = db.read(() => (
    options?.status
      ? db.orm.select({ jobId: schema.jobProjection.jobId })
        .from(schema.jobProjection)
        .where(eq(schema.jobProjection.status, options.status))
        .orderBy(desc(schema.jobProjection.updatedAt), desc(schema.jobProjection.createdAt), desc(schema.jobProjection.jobId))
        .limit(limit)
        .all()
      : db.orm.select({ jobId: schema.jobProjection.jobId })
        .from(schema.jobProjection)
        .orderBy(desc(schema.jobProjection.updatedAt), desc(schema.jobProjection.createdAt), desc(schema.jobProjection.jobId))
        .limit(limit)
        .all()
  ));
  return rows.map((row) => readJobProjection(dataDir, row.jobId)).filter((job): job is StoredJobProjection => Boolean(job));
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
  const counts = db.read(() => db.orm.select({
    total: sql<number>`count(*)`,
    queued: sql<number>`sum(case when ${schema.jobProjection.status} = 'queued' then 1 else 0 end)`,
    leased: sql<number>`sum(case when ${schema.jobProjection.status} = 'leased' then 1 else 0 end)`,
    running: sql<number>`sum(case when ${schema.jobProjection.status} = 'running' then 1 else 0 end)`,
    completed: sql<number>`sum(case when ${schema.jobProjection.status} = 'completed' then 1 else 0 end)`,
    failed: sql<number>`sum(case when ${schema.jobProjection.status} = 'failed' then 1 else 0 end)`,
    canceled: sql<number>`sum(case when ${schema.jobProjection.status} = 'canceled' then 1 else 0 end)`,
    updatedAt: max(schema.jobProjection.updatedAt),
  })
    .from(schema.jobProjection)
    .get());
  const summary = counts ?? {
    total: 0,
    queued: 0,
    leased: 0,
    running: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    updatedAt: undefined,
  };
  return {
    total: Number(summary.total ?? 0),
    queued: Number(summary.queued ?? 0),
    leased: Number(summary.leased ?? 0),
    running: Number(summary.running ?? 0),
    completed: Number(summary.completed ?? 0),
    failed: Number(summary.failed ?? 0),
    canceled: Number(summary.canceled ?? 0),
    updatedAt: summary.updatedAt ?? undefined,
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
    db.write(() => {
      db.orm.delete(schema.objectiveProjection)
        .where(eq(schema.objectiveProjection.stream, stream))
        .run();
    });
    return undefined;
  }
  const projection = buildFactoryProjection(state);
  db.write(() => {
    db.orm.insert(schema.objectiveProjection)
      .values({
        objectiveId: state.objectiveId,
        stream,
        title: state.title,
        objectiveMode: state.objectiveMode,
        severity: state.severity,
        status: state.status,
        archivedAt: state.archivedAt ?? null,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        latestSummary: state.latestSummary ?? null,
        blockedReason: state.blockedReason ?? null,
        integrationStatus: state.integration.status,
        slotState: state.scheduler.slotState ?? "queued",
        activeTaskCount: projection.activeTasks.length,
        readyTaskCount: projection.readyTasks.length,
        taskCount: projection.tasks.length,
        stateJson: jsonStringify(state),
        projectionJson: jsonStringify(projection),
      })
      .onConflictDoUpdate({
        target: schema.objectiveProjection.objectiveId,
        set: {
          stream,
          title: state.title,
          objectiveMode: state.objectiveMode,
          severity: state.severity,
          status: state.status,
          archivedAt: state.archivedAt ?? null,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
          latestSummary: state.latestSummary ?? null,
          blockedReason: state.blockedReason ?? null,
          integrationStatus: state.integration.status,
          slotState: state.scheduler.slotState ?? "queued",
          activeTaskCount: projection.activeTasks.length,
          readyTaskCount: projection.readyTasks.length,
          taskCount: projection.tasks.length,
          stateJson: jsonStringify(state),
          projectionJson: jsonStringify(projection),
        },
      })
      .run();
  });
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

export type StoredObjectiveProjectionSummary = {
  readonly objectiveId: string;
  readonly stream: string;
  readonly objectiveMode: FactoryState["objectiveMode"];
  readonly status: FactoryState["status"];
  readonly archivedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly integrationStatus: FactoryState["integration"]["status"];
  readonly slotState?: FactoryState["scheduler"]["slotState"];
};

export type StoredObjectiveProjection = StoredObjectiveProjectionSummary & {
  readonly title: string;
  readonly severity: FactoryState["severity"];
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly activeTaskCount: number;
  readonly readyTaskCount: number;
  readonly taskCount: number;
  readonly state: FactoryState;
  readonly projection: FactoryProjection;
};

const toStoredObjectiveProjection = (row: {
  readonly objectiveId: string;
  readonly stream: string;
  readonly title: string;
  readonly objectiveMode: string;
  readonly severity: number;
  readonly status: string;
  readonly archivedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly latestSummary: string | null;
  readonly blockedReason: string | null;
  readonly integrationStatus: string;
  readonly slotState: string | null;
  readonly activeTaskCount: number;
  readonly readyTaskCount: number;
  readonly taskCount: number;
  readonly stateJson: string;
  readonly projectionJson: string;
}): StoredObjectiveProjection => {
  const state = jsonParse<FactoryState>(row.stateJson, {} as FactoryState);
  return {
    objectiveId: row.objectiveId,
    stream: row.stream,
    title: row.title,
    objectiveMode: row.objectiveMode as FactoryState["objectiveMode"],
    severity: Number(row.severity) as FactoryState["severity"],
    status: row.status as FactoryState["status"],
    archivedAt: row.archivedAt ?? undefined,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    latestSummary: row.latestSummary ?? undefined,
    blockedReason: row.blockedReason ?? undefined,
    integrationStatus: row.integrationStatus as FactoryState["integration"]["status"],
    slotState: (row.slotState ?? undefined) as FactoryState["scheduler"]["slotState"] | undefined,
    activeTaskCount: Number(row.activeTaskCount),
    readyTaskCount: Number(row.readyTaskCount),
    taskCount: Number(row.taskCount),
    state,
    projection: jsonParse<FactoryProjection>(row.projectionJson, buildFactoryProjection(state)),
  };
};

export const readObjectiveProjectionSummaries = (
  dataDir: string,
): ReadonlyArray<StoredObjectiveProjectionSummary> => {
  const db = getReceiptDb(dataDir);
  const rows = db.read(() => db.orm.select({
    objectiveId: schema.objectiveProjection.objectiveId,
    stream: schema.objectiveProjection.stream,
    objectiveMode: schema.objectiveProjection.objectiveMode,
    status: schema.objectiveProjection.status,
    archivedAt: schema.objectiveProjection.archivedAt,
    createdAt: schema.objectiveProjection.createdAt,
    updatedAt: schema.objectiveProjection.updatedAt,
    integrationStatus: schema.objectiveProjection.integrationStatus,
    slotState: schema.objectiveProjection.slotState,
  })
    .from(schema.objectiveProjection)
    .orderBy(schema.objectiveProjection.createdAt, schema.objectiveProjection.objectiveId)
    .all());
  return rows.map((row) => ({
    objectiveId: row.objectiveId,
    stream: row.stream,
    objectiveMode: row.objectiveMode as FactoryState["objectiveMode"],
    status: row.status as FactoryState["status"],
    archivedAt: row.archivedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    integrationStatus: row.integrationStatus as FactoryState["integration"]["status"],
    slotState: (row.slotState ?? undefined) as FactoryState["scheduler"]["slotState"] | undefined,
  }));
};

export const readObjectiveProjection = (
  dataDir: string,
  objectiveId: string,
): StoredObjectiveProjection | undefined => {
  const db = getReceiptDb(dataDir);
  const row = db.read(() => db.orm.select({
    objectiveId: schema.objectiveProjection.objectiveId,
    stream: schema.objectiveProjection.stream,
    title: schema.objectiveProjection.title,
    objectiveMode: schema.objectiveProjection.objectiveMode,
    severity: schema.objectiveProjection.severity,
    status: schema.objectiveProjection.status,
    archivedAt: schema.objectiveProjection.archivedAt,
    createdAt: schema.objectiveProjection.createdAt,
    updatedAt: schema.objectiveProjection.updatedAt,
    latestSummary: schema.objectiveProjection.latestSummary,
    blockedReason: schema.objectiveProjection.blockedReason,
    integrationStatus: schema.objectiveProjection.integrationStatus,
    slotState: schema.objectiveProjection.slotState,
    activeTaskCount: schema.objectiveProjection.activeTaskCount,
    readyTaskCount: schema.objectiveProjection.readyTaskCount,
    taskCount: schema.objectiveProjection.taskCount,
    stateJson: schema.objectiveProjection.stateJson,
    projectionJson: schema.objectiveProjection.projectionJson,
  })
    .from(schema.objectiveProjection)
    .where(eq(schema.objectiveProjection.objectiveId, objectiveId))
    .get());
  return row ? toStoredObjectiveProjection(row) : undefined;
};

export const listObjectiveProjectionRows = (
  dataDir: string,
): ReadonlyArray<StoredObjectiveProjection> => {
  const db = getReceiptDb(dataDir);
  const rows = db.read(() => db.orm.select({
    objectiveId: schema.objectiveProjection.objectiveId,
    stream: schema.objectiveProjection.stream,
    title: schema.objectiveProjection.title,
    objectiveMode: schema.objectiveProjection.objectiveMode,
    severity: schema.objectiveProjection.severity,
    status: schema.objectiveProjection.status,
    archivedAt: schema.objectiveProjection.archivedAt,
    createdAt: schema.objectiveProjection.createdAt,
    updatedAt: schema.objectiveProjection.updatedAt,
    latestSummary: schema.objectiveProjection.latestSummary,
    blockedReason: schema.objectiveProjection.blockedReason,
    integrationStatus: schema.objectiveProjection.integrationStatus,
    slotState: schema.objectiveProjection.slotState,
    activeTaskCount: schema.objectiveProjection.activeTaskCount,
    readyTaskCount: schema.objectiveProjection.readyTaskCount,
    taskCount: schema.objectiveProjection.taskCount,
    stateJson: schema.objectiveProjection.stateJson,
    projectionJson: schema.objectiveProjection.projectionJson,
  })
    .from(schema.objectiveProjection)
    .orderBy(schema.objectiveProjection.createdAt, schema.objectiveProjection.objectiveId)
    .all());
  return rows.map(toStoredObjectiveProjection);
};

export const syncChatContextProjectionStream = async (
  dataDir: string,
  sessionStream: string,
): Promise<FactoryChatContextProjection | undefined> => {
  if (!isFactoryChatSessionStream(sessionStream)) return undefined;
  const db = getReceiptDb(dataDir);
  const rows = db.read(() => db.orm.select({
    globalSeq: schema.receipts.globalSeq,
    stream: schema.receipts.stream,
    receiptId: schema.receipts.receiptId,
    ts: schema.receipts.ts,
    hash: schema.receipts.hash,
    eventType: schema.receipts.eventType,
    bodyJson: schema.receipts.bodyJson,
  })
    .from(schema.receipts)
    .where(or(
      eq(schema.receipts.stream, sessionStream),
      like(schema.receipts.stream, `${sessionStream}/runs/%`),
    ))
    .orderBy(schema.receipts.globalSeq)
    .all());
  if (rows.length === 0) {
    db.write(() => {
      db.orm.delete(schema.chatContextProjection)
        .where(eq(schema.chatContextProjection.stream, sessionStream))
        .run();
      db.orm.delete(schema.sessionMessages)
        .where(eq(schema.sessionMessages.sessionStream, sessionStream))
        .run();
    });
    return undefined;
  }
  const projection = projectFactoryChatContextFromReceipts({
    sessionStream,
    receipts: rows.map((row) => ({
      stream: row.stream,
      ts: Number(row.ts),
      hash: row.hash,
      id: row.receiptId,
      eventType: row.eventType,
      globalSeq: Number(row.globalSeq),
      body: jsonParse(row.bodyJson, {} as never),
    })),
    updatedAt: Date.now(),
  });
  if (!projection) {
    db.write(() => {
      db.orm.delete(schema.chatContextProjection)
        .where(eq(schema.chatContextProjection.stream, sessionStream))
        .run();
      db.orm.delete(schema.sessionMessages)
        .where(eq(schema.sessionMessages.sessionStream, sessionStream))
        .run();
    });
    return undefined;
  }
  db.write(() => {
    db.orm.insert(schema.chatContextProjection)
      .values({
        stream: sessionStream,
        chatId: projection.chatId,
        profileId: projection.profileId,
        updatedAt: projection.updatedAt,
        boundObjectiveId: projection.bindings.objectiveId ?? null,
        latestRunId: projection.bindings.latestRunId ?? null,
        lastGlobalSeq: projection.source.lastGlobalSeq,
        contextJson: jsonStringify(projection),
      })
      .onConflictDoUpdate({
        target: schema.chatContextProjection.stream,
        set: {
          chatId: projection.chatId,
          profileId: projection.profileId,
          updatedAt: projection.updatedAt,
          boundObjectiveId: projection.bindings.objectiveId ?? null,
          latestRunId: projection.bindings.latestRunId ?? null,
          lastGlobalSeq: projection.source.lastGlobalSeq,
          contextJson: jsonStringify(projection),
        },
      })
      .run();
  });
  syncSessionMessageProjection(dataDir, projection);
  return projection;
};

export const syncChangedChatContextProjections = async (
  dataDir: string,
): Promise<ReadonlyArray<string>> => {
  const db = getReceiptDb(dataDir);
  const lastOffset = getProjectionOffset(db, CHAT_CONTEXT_PROJECTOR);
  const changed = listChangedStreams(db, { afterGlobalSeq: lastOffset, streamPrefix: "agents/factory/" });
  const sessionMessageCount = Number(
    db.read(() => db.orm.select({ value: sql<number>`count(*)` })
      .from(schema.sessionMessages)
      .get())?.value ?? 0,
  );
  const bootstrapStreams = changed.length === 0 && lastOffset === 0
    || changed.length === 0 && sessionMessageCount === 0
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
  const row = db.read(() => db.orm.select({
    contextJson: schema.chatContextProjection.contextJson,
  })
    .from(schema.chatContextProjection)
    .where(eq(schema.chatContextProjection.stream, sessionStream))
    .get());
  return row ? jsonParse<FactoryChatContextProjection | undefined>(row.contextJson, undefined) : undefined;
};

export const readChatContextProjectionVersion = (
  dataDir: string,
  sessionStream: string,
): number | undefined => {
  const db = getReceiptDb(dataDir);
  const row = db.read(() => db.orm.select({
    lastGlobalSeq: schema.chatContextProjection.lastGlobalSeq,
  })
    .from(schema.chatContextProjection)
    .where(eq(schema.chatContextProjection.stream, sessionStream))
    .get());
  return row ? Number(row.lastGlobalSeq) : undefined;
};

export const rebuildMemoryProjection = async (dataDir: string): Promise<void> => {
  const db = getReceiptDb(dataDir);
  const memoryRuntime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
    sqliteReceiptStore<MemoryEvent>(dataDir),
    sqliteBranchStore(dataDir),
    decideMemory,
    reduceMemory,
    initialMemoryState,
  );
  const streams = listStreamsByPrefix(db, "memory/");
  db.transaction((tx) => {
    tx.delete(schema.memoryEntries).run();
    tx.delete(schema.memoryAccesses).run();
  });
  for (const stream of streams) {
    const scope = scopeFromMemoryStream(stream);
    if (!scope) continue;
    const state = await memoryRuntime.state(stream);
    const orderedEntries = [...state.entries].sort((left, right) => left.ts - right.ts || left.id.localeCompare(right.id));
    if (orderedEntries.length > 0) {
      db.write(() => {
        db.orm.insert(schema.memoryEntries)
          .values(orderedEntries.map((entry) => ({
            entryId: entry.id,
            scope: entry.scope,
            text: entry.text,
            tagsJson: entry.tags ? jsonStringify(entry.tags) : null,
            metaJson: entry.meta ? jsonStringify(entry.meta) : null,
            ts: entry.ts,
          })))
          .run();
      });
    }
    const orderedAccesses = [...state.accesses].sort((left, right) => left.ts - right.ts || left.id.localeCompare(right.id));
    if (orderedAccesses.length > 0) {
      db.write(() => {
        db.orm.insert(schema.memoryAccesses)
          .values(orderedAccesses.map((access) => ({
            accessId: access.id,
            scope: access.scope,
            operation: access.operation,
            strategy: access.strategy,
            query: access.query ?? null,
            limit: access.limit ?? null,
            maxChars: access.maxChars ?? null,
            fromTs: access.fromTs ?? null,
            toTs: access.toTs ?? null,
            resultCount: access.resultCount,
            resultIdsJson: access.resultIds ? jsonStringify(access.resultIds) : null,
            summaryChars: access.summaryChars ?? null,
            metaJson: access.meta ? jsonStringify(access.meta) : null,
            ts: access.ts,
          })))
          .run();
      });
    }
  }
  setProjectionOffset(db, MEMORY_PROJECTOR, latestGlobalSeq(db));
};
