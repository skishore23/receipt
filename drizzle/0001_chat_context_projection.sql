CREATE TABLE IF NOT EXISTS chat_context_projection (
  stream TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  bound_objective_id TEXT,
  latest_run_id TEXT,
  last_global_seq INTEGER NOT NULL,
  context_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_context_projection_chat_idx ON chat_context_projection(chat_id, updated_at);
CREATE INDEX IF NOT EXISTS chat_context_projection_profile_idx ON chat_context_projection(profile_id, updated_at);
CREATE INDEX IF NOT EXISTS chat_context_projection_objective_idx ON chat_context_projection(bound_objective_id, updated_at);
