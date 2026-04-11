CREATE TABLE IF NOT EXISTS durable_workflow (
  key TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  input_json TEXT,
  metadata_json TEXT,
  output_json TEXT,
  error_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  last_signal_at INTEGER
);

CREATE TABLE IF NOT EXISTS durable_signal (
  id TEXT PRIMARY KEY NOT NULL,
  workflow_key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  signal TEXT NOT NULL,
  payload_json TEXT,
  by TEXT,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS durable_signal_workflow_seq_uq
  ON durable_signal(workflow_key, seq);

CREATE INDEX IF NOT EXISTS durable_signal_workflow_created_idx
  ON durable_signal(workflow_key, created_at);

CREATE TABLE IF NOT EXISTS durable_activity (
  key TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  input_json TEXT,
  metadata_json TEXT,
  output_json TEXT,
  error_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS durable_activity_attempt (
  id TEXT PRIMARY KEY NOT NULL,
  activity_key TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  metadata_json TEXT,
  error_text TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS durable_activity_attempt_uq
  ON durable_activity_attempt(activity_key, attempt);
