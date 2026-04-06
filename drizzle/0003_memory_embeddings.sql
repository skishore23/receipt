CREATE TABLE IF NOT EXISTS memory_embeddings (
  entry_id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_embeddings_scope_idx
  ON memory_embeddings(scope, updated_at);
