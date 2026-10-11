-- Planning decisions (docs/superpowers/specs/2026-10-10-slack-planning-decisions-design.md).
-- Replaces the /grill-me voting tables from 0003, which were never wired to Slack.
DROP TABLE votes;
DROP TABLE questions;
DROP TABLE thread_participants;

-- One row per card revision. A card's state is its latest revision: decided when
-- that row has a decision, open otherwise. Earlier revisions are history.
CREATE TABLE card_revisions (
  card_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  conversation_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  message_ts TEXT,
  question TEXT NOT NULL,
  context TEXT,
  recommendation TEXT NOT NULL,
  choices TEXT, -- JSON array of { id, label }
  choice_id TEXT,
  custom_answer TEXT,
  reasoning TEXT,
  decided_by TEXT,
  decided_by_name TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (card_id, revision),
  CONSTRAINT card_choices CHECK (
    choices IS NULL OR
    (json_valid(choices) AND json_type(choices) = 'array' AND json_array_length(choices) >= 2)
  ),
  -- Undecided: every decision column empty. Decided: actor and time, and exactly
  -- one of a listed choice or a custom answer.
  CONSTRAINT card_decision CHECK (
    (decided_at IS NULL AND decided_by IS NULL AND decided_by_name IS NULL
      AND choice_id IS NULL AND custom_answer IS NULL AND reasoning IS NULL) OR
    (decided_at IS NOT NULL AND decided_by IS NOT NULL AND decided_by_name IS NOT NULL
      AND (choice_id IS NULL) <> (custom_answer IS NULL)
      AND (choice_id IS NULL OR choices IS NOT NULL))
  )
);

CREATE INDEX card_revisions_by_conversation ON card_revisions (conversation_id, created_at);

-- A thread in a planning session stays quiet: unmentioned replies are not dispatched.
CREATE TABLE planning_sessions (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
