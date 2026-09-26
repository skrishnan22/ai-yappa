-- Person Preferences: one row per preference, about exactly one Slack user.
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  subject_user_id TEXT NOT NULL,
  content TEXT,
  source_conversation_id TEXT NOT NULL,
  source_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX memories_live_subject ON memories (subject_user_id, created_at)
  WHERE deleted_at IS NULL;
