import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const streams = sqliteTable("streams", {
  name: text("name").primaryKey(),
  headHash: text("head_hash"),
  receiptCount: integer("receipt_count").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  lastTs: integer("last_ts", { mode: "number" }),
}, (table) => [
  index("streams_updated_at_idx").on(table.updatedAt),
]);

export const receipts = sqliteTable("receipts", {
  globalSeq: integer("global_seq").primaryKey({ autoIncrement: true }),
  stream: text("stream").notNull(),
  streamSeq: integer("stream_seq").notNull(),
  receiptId: text("receipt_id").notNull(),
  ts: integer("ts", { mode: "number" }).notNull(),
  prevHash: text("prev_hash"),
  hash: text("hash").notNull(),
  eventType: text("event_type").notNull(),
  bodyJson: text("body_json").notNull(),
  hintsJson: text("hints_json"),
}, (table) => [
  uniqueIndex("receipts_stream_seq_uq").on(table.stream, table.streamSeq),
  uniqueIndex("receipts_stream_hash_uq").on(table.stream, table.hash),
  uniqueIndex("receipts_stream_receipt_id_uq").on(table.stream, table.receiptId),
  uniqueIndex("receipts_hash_uq").on(table.hash),
  index("receipts_stream_ts_idx").on(table.stream, table.ts),
  index("receipts_event_type_idx").on(table.eventType),
  index("receipts_stream_event_type_idx").on(table.stream, table.eventType),
]);

export const branches = sqliteTable("branches", {
  name: text("name").primaryKey(),
  parent: text("parent"),
  forkAt: integer("fork_at"),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
}, (table) => [
  index("branches_parent_idx").on(table.parent),
]);

export const projectionOffsets = sqliteTable("projection_offsets", {
  projector: text("projector").primaryKey(),
  lastGlobalSeq: integer("last_global_seq").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export const changeLog = sqliteTable("change_log", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  globalSeq: integer("global_seq").notNull(),
  stream: text("stream").notNull(),
  eventType: text("event_type").notNull(),
  changedAt: integer("changed_at", { mode: "number" }).notNull(),
}, (table) => [
  index("change_log_global_seq_idx").on(table.globalSeq),
  index("change_log_stream_idx").on(table.stream),
  index("change_log_changed_at_idx").on(table.changedAt),
]);

export const jobProjection = sqliteTable("job_projection", {
  jobId: text("job_id").primaryKey(),
  stream: text("stream").notNull(),
  agentId: text("agent_id").notNull(),
  lane: text("lane").notNull(),
  sessionKey: text("session_key"),
  singletonMode: text("singleton_mode"),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull(),
  attempt: integer("attempt").notNull(),
  maxAttempts: integer("max_attempts").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  leaseOwner: text("lease_owner"),
  leaseUntil: integer("lease_until", { mode: "number" }),
  lastError: text("last_error"),
  resultJson: text("result_json"),
  canceledReason: text("canceled_reason"),
  abortRequested: integer("abort_requested", { mode: "boolean" }).notNull().default(false),
  commandsJson: text("commands_json").notNull(),
}, (table) => [
  uniqueIndex("job_projection_stream_uq").on(table.stream),
  index("job_projection_status_idx").on(table.status, table.updatedAt),
  index("job_projection_session_key_idx").on(table.sessionKey),
  index("job_projection_agent_lane_idx").on(table.agentId, table.lane, table.status),
]);

export const jobPendingCommands = sqliteTable("job_pending_commands", {
  commandId: text("command_id").primaryKey(),
  jobId: text("job_id").notNull(),
  command: text("command").notNull(),
  lane: text("lane").notNull(),
  payloadJson: text("payload_json"),
  by: text("by"),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  consumedAt: integer("consumed_at", { mode: "number" }),
}, (table) => [
  index("job_pending_commands_job_idx").on(table.jobId, table.createdAt),
  index("job_pending_commands_unconsumed_idx").on(table.jobId, table.consumedAt),
]);

export const objectiveProjection = sqliteTable("objective_projection", {
  objectiveId: text("objective_id").primaryKey(),
  stream: text("stream").notNull(),
  title: text("title").notNull(),
  objectiveMode: text("objective_mode").notNull(),
  severity: integer("severity").notNull(),
  status: text("status").notNull(),
  archivedAt: integer("archived_at", { mode: "number" }),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  latestSummary: text("latest_summary"),
  blockedReason: text("blocked_reason"),
  integrationStatus: text("integration_status").notNull(),
  slotState: text("slot_state").notNull(),
  activeTaskCount: integer("active_task_count").notNull(),
  readyTaskCount: integer("ready_task_count").notNull(),
  taskCount: integer("task_count").notNull(),
  stateJson: text("state_json").notNull(),
  projectionJson: text("projection_json").notNull(),
}, (table) => [
  uniqueIndex("objective_projection_stream_uq").on(table.stream),
  index("objective_projection_status_idx").on(table.status, table.updatedAt),
  index("objective_projection_slot_state_idx").on(table.slotState, table.updatedAt),
]);

export const chatContextProjection = sqliteTable("chat_context_projection", {
  stream: text("stream").primaryKey(),
  chatId: text("chat_id").notNull(),
  profileId: text("profile_id").notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  boundObjectiveId: text("bound_objective_id"),
  latestRunId: text("latest_run_id"),
  lastGlobalSeq: integer("last_global_seq").notNull(),
  contextJson: text("context_json").notNull(),
}, (table) => [
  index("chat_context_projection_chat_idx").on(table.chatId, table.updatedAt),
  index("chat_context_projection_profile_idx").on(table.profileId, table.updatedAt),
  index("chat_context_projection_objective_idx").on(table.boundObjectiveId, table.updatedAt),
]);

export const sessionMessages = sqliteTable("session_messages", {
  messageId: text("message_id").primaryKey(),
  sessionStream: text("session_stream").notNull(),
  chatId: text("chat_id").notNull(),
  profileId: text("profile_id").notNull(),
  repoKey: text("repo_key").notNull(),
  runId: text("run_id").notNull(),
  role: text("role").notNull(),
  text: text("text").notNull(),
  ts: integer("ts", { mode: "number" }).notNull(),
  orderKey: integer("order_key").notNull(),
  receiptRefsJson: text("receipt_refs_json").notNull(),
}, (table) => [
  index("session_messages_session_idx").on(table.sessionStream, table.orderKey),
  index("session_messages_chat_idx").on(table.chatId, table.ts),
  index("session_messages_repo_profile_ts_idx").on(table.repoKey, table.profileId, table.ts),
]);

export const memoryEntries = sqliteTable("memory_entries", {
  entryId: text("entry_id").primaryKey(),
  scope: text("scope").notNull(),
  text: text("text").notNull(),
  tagsJson: text("tags_json"),
  metaJson: text("meta_json"),
  ts: integer("ts", { mode: "number" }).notNull(),
}, (table) => [
  index("memory_entries_scope_ts_idx").on(table.scope, table.ts),
]);

export const memoryAccesses = sqliteTable("memory_accesses", {
  accessId: text("access_id").primaryKey(),
  scope: text("scope").notNull(),
  operation: text("operation").notNull(),
  strategy: text("strategy").notNull(),
  query: text("query"),
  limit: integer("limit"),
  maxChars: integer("max_chars"),
  fromTs: integer("from_ts", { mode: "number" }),
  toTs: integer("to_ts", { mode: "number" }),
  resultCount: integer("result_count").notNull(),
  resultIdsJson: text("result_ids_json"),
  summaryChars: integer("summary_chars"),
  metaJson: text("meta_json"),
  ts: integer("ts", { mode: "number" }).notNull(),
}, (table) => [
  index("memory_accesses_scope_ts_idx").on(table.scope, table.ts),
]);

export const schemaMigrations = sqliteTable("schema_migrations", {
  name: text("name").primaryKey(),
  appliedAt: integer("applied_at", { mode: "number" }).notNull(),
});
