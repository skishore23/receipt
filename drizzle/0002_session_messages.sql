CREATE TABLE IF NOT EXISTS session_messages (
  message_id TEXT PRIMARY KEY NOT NULL,
  session_stream TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL,
  order_key INTEGER NOT NULL,
  receipt_refs_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_messages_session_idx ON session_messages(session_stream, order_key);
CREATE INDEX IF NOT EXISTS session_messages_chat_idx ON session_messages(chat_id, ts);
CREATE INDEX IF NOT EXISTS session_messages_repo_profile_ts_idx ON session_messages(repo_key, profile_id, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
  text,
  content='session_messages',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS session_messages_ai AFTER INSERT ON session_messages BEGIN
  INSERT INTO session_messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS session_messages_ad AFTER DELETE ON session_messages BEGIN
  INSERT INTO session_messages_fts(session_messages_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS session_messages_au AFTER UPDATE ON session_messages BEGIN
  INSERT INTO session_messages_fts(session_messages_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
  INSERT INTO session_messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
