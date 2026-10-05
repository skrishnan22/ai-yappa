-- /grill-me questions. A thread is a group when it has more than one participant.
CREATE TABLE thread_participants (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  message_ts TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('choice', 'open')),
  title TEXT NOT NULL,
  body TEXT,
  recommendation TEXT NOT NULL,
  choices TEXT, -- JSON array of { id, label, recommended? }; NULL for open questions
  status TEXT NOT NULL CHECK (status IN ('open', 'submitted', 'closed')),
  submitted_by TEXT,
  submitted_by_name TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE UNIQUE INDEX one_open_question ON questions (conversation_id) WHERE status = 'open';

CREATE TABLE votes (
  question_id TEXT NOT NULL REFERENCES questions(id),
  user_id TEXT NOT NULL,
  choice_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (question_id, user_id)
);
