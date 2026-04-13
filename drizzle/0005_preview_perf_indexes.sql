CREATE INDEX IF NOT EXISTS change_log_global_seq_stream_idx
  ON change_log(global_seq, stream);

CREATE INDEX IF NOT EXISTS chat_context_projection_objective_profile_updated_idx
  ON chat_context_projection(bound_objective_id, profile_id, updated_at, stream);
