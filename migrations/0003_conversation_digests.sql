-- migrations/0002_conversation_digests.sql
-- Conversation Digests: one row per answered Flue response. Deterministic
-- fields only; no tool output, diffs, or model reasoning.
CREATE TABLE conversation_digests (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_visibility TEXT NOT NULL CHECK (channel_visibility IN ('public', 'private')),
  thread_ts TEXT NOT NULL,
  invoker_user_ids TEXT NOT NULL,        -- JSON array of Slack user IDs
  requests TEXT NOT NULL,
  replies TEXT NOT NULL,
  tools_used TEXT NOT NULL,
  pr_url TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX conversation_digests_conversation ON conversation_digests (conversation_id, created_at);

CREATE INDEX conversation_digests_created ON conversation_digests (created_at);

-- Keyed on the explicit `seq` column, not the table's implicit rowid: a
-- TEXT PRIMARY KEY (`id`) makes SQLite use a real rowid that VACUUM/export
-- can renumber, which would desync this external-content FTS index.
CREATE VIRTUAL TABLE conversation_digests_fts USING fts5(
  requests, replies,
  content = 'conversation_digests', content_rowid = 'seq',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER conversation_digests_ai AFTER INSERT ON conversation_digests BEGIN
  INSERT INTO conversation_digests_fts (rowid, requests, replies)
  VALUES (new.seq, new.requests, new.replies);
END;

CREATE TRIGGER conversation_digests_ad AFTER DELETE ON conversation_digests BEGIN
  INSERT INTO conversation_digests_fts (conversation_digests_fts, rowid, requests, replies)
  VALUES ('delete', old.seq, old.requests, old.replies);
END;

CREATE TRIGGER conversation_digests_au AFTER UPDATE ON conversation_digests BEGIN
  INSERT INTO conversation_digests_fts (conversation_digests_fts, rowid, requests, replies)
  VALUES ('delete', old.seq, old.requests, old.replies);
  INSERT INTO conversation_digests_fts (rowid, requests, replies)
  VALUES (new.seq, new.requests, new.replies);
END;
