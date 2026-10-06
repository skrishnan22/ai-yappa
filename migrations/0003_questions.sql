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
  choices TEXT, -- JSON array of { id, label, recommended? }
  status TEXT NOT NULL CHECK (status IN ('open', 'submitted', 'closed')),
  submitted_by TEXT,
  submitted_by_name TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  -- Each CHECK lists the allowed row shapes; a write matching none is rejected.
  -- The 5-choice maximum is a product limit enforced by ask_question, not here.
  CONSTRAINT question_choices CHECK (
    (kind = 'open' AND choices IS NULL) OR
    (kind = 'choice' AND choices IS NOT NULL AND json_valid(choices) AND json_type(choices) = 'array'
      AND json_array_length(choices) >= 2)
  ),
  CONSTRAINT question_state CHECK (
    (status = 'open' AND closed_at IS NULL AND submitted_by IS NULL AND submitted_by_name IS NULL) OR
    (status = 'closed' AND closed_at IS NOT NULL AND submitted_by IS NULL AND submitted_by_name IS NULL) OR
    (status = 'submitted' AND closed_at IS NOT NULL AND submitted_by IS NOT NULL
      AND submitted_by_name IS NOT NULL)
  )
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
