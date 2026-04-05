CREATE TABLE IF NOT EXISTS streams (
  name TEXT PRIMARY KEY NOT NULL,
  head_hash TEXT,
  receipt_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  last_ts INTEGER
);
CREATE INDEX IF NOT EXISTS streams_updated_at_idx ON streams(updated_at);

CREATE TABLE IF NOT EXISTS receipts (
  global_seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  stream TEXT NOT NULL,
  stream_seq INTEGER NOT NULL,
  receipt_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  prev_hash TEXT,
  hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  body_json TEXT NOT NULL,
  hints_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS receipts_stream_seq_uq ON receipts(stream, stream_seq);
CREATE UNIQUE INDEX IF NOT EXISTS receipts_stream_hash_uq ON receipts(stream, hash);
CREATE UNIQUE INDEX IF NOT EXISTS receipts_stream_receipt_id_uq ON receipts(stream, receipt_id);
CREATE UNIQUE INDEX IF NOT EXISTS receipts_hash_uq ON receipts(hash);
CREATE INDEX IF NOT EXISTS receipts_stream_ts_idx ON receipts(stream, ts);
CREATE INDEX IF NOT EXISTS receipts_event_type_idx ON receipts(event_type);
CREATE INDEX IF NOT EXISTS receipts_stream_event_type_idx ON receipts(stream, event_type);

CREATE TABLE IF NOT EXISTS branches (
  name TEXT PRIMARY KEY NOT NULL,
  parent TEXT,
  fork_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS branches_parent_idx ON branches(parent);

CREATE TABLE IF NOT EXISTS projection_offsets (
  projector TEXT PRIMARY KEY NOT NULL,
  last_global_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  global_seq INTEGER NOT NULL,
  stream TEXT NOT NULL,
  event_type TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS change_log_global_seq_idx ON change_log(global_seq);
CREATE INDEX IF NOT EXISTS change_log_stream_idx ON change_log(stream);
CREATE INDEX IF NOT EXISTS change_log_changed_at_idx ON change_log(changed_at);

CREATE TABLE IF NOT EXISTS job_projection (
  job_id TEXT PRIMARY KEY NOT NULL,
  stream TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  session_key TEXT,
  idempotency_key TEXT,
  singleton_mode TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER,
  last_error TEXT,
  result_json TEXT,
  canceled_reason TEXT,
  abort_requested INTEGER NOT NULL DEFAULT 0,
  commands_json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS job_projection_stream_uq ON job_projection(stream);
CREATE UNIQUE INDEX IF NOT EXISTS job_projection_idempotency_key_uq ON job_projection(idempotency_key);
CREATE INDEX IF NOT EXISTS job_projection_status_idx ON job_projection(status, updated_at);
CREATE INDEX IF NOT EXISTS job_projection_session_key_idx ON job_projection(session_key);
CREATE INDEX IF NOT EXISTS job_projection_agent_lane_idx ON job_projection(agent_id, lane, status);

CREATE TABLE IF NOT EXISTS job_pending_commands (
  command_id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  command TEXT NOT NULL,
  lane TEXT NOT NULL,
  payload_json TEXT,
  by TEXT,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS job_pending_commands_job_idx ON job_pending_commands(job_id, created_at);
CREATE INDEX IF NOT EXISTS job_pending_commands_unconsumed_idx ON job_pending_commands(job_id, consumed_at);

CREATE TABLE IF NOT EXISTS objective_projection (
  objective_id TEXT PRIMARY KEY NOT NULL,
  stream TEXT NOT NULL,
  title TEXT NOT NULL,
  objective_mode TEXT NOT NULL,
  severity INTEGER NOT NULL,
  status TEXT NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  latest_summary TEXT,
  blocked_reason TEXT,
  integration_status TEXT NOT NULL,
  slot_state TEXT NOT NULL,
  active_task_count INTEGER NOT NULL,
  ready_task_count INTEGER NOT NULL,
  task_count INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  projection_json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS objective_projection_stream_uq ON objective_projection(stream);
CREATE INDEX IF NOT EXISTS objective_projection_status_idx ON objective_projection(status, updated_at);
CREATE INDEX IF NOT EXISTS objective_projection_slot_state_idx ON objective_projection(slot_state, updated_at);

CREATE TABLE IF NOT EXISTS memory_entries (
  entry_id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  text TEXT NOT NULL,
  tags_json TEXT,
  meta_json TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_entries_scope_ts_idx ON memory_entries(scope, ts);

CREATE TABLE IF NOT EXISTS memory_accesses (
  access_id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  operation TEXT NOT NULL,
  strategy TEXT NOT NULL,
  query TEXT,
  "limit" INTEGER,
  max_chars INTEGER,
  from_ts INTEGER,
  to_ts INTEGER,
  result_count INTEGER NOT NULL,
  result_ids_json TEXT,
  summary_chars INTEGER,
  meta_json TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_accesses_scope_ts_idx ON memory_accesses(scope, ts);
