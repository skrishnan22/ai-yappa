-- Scheduled automations (docs/superpowers/specs/2026-10-13-scheduled-automations-design.md).

CREATE TABLE automations (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'reminder')),
  owner_user_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'channel')),
  destination_channel_id TEXT NOT NULL,
  repo TEXT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT, -- five-field cron; NULL for a one-off
  run_at TEXT, -- the one-off instant (UTC ISO); NULL for recurring
  timezone TEXT NOT NULL,
  next_run_at TEXT,
  last_scheduled_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'blocked', 'completed', 'deleted')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT automation_schedule CHECK ((schedule IS NULL) <> (run_at IS NULL))
);

-- The heartbeat reads `status = 'active' AND next_run_at <= now`.
CREATE INDEX automations_due ON automations (status, next_run_at);
CREATE INDEX automations_by_owner ON automations (owner_user_id);
CREATE INDEX automations_by_destination ON automations (destination_channel_id);

-- One row per fire. (automation_id, fire_time) is the dedupe key: a second
-- tick that read the same due row fails to claim it. Kept after deletion.
CREATE TABLE automation_runs (
  automation_id TEXT NOT NULL,
  fire_time TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'dispatched', 'posted', 'failed', 'succeeded')),
  conversation_id TEXT,
  submission_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (automation_id, fire_time)
);

CREATE INDEX automation_runs_by_submission ON automation_runs (submission_id);
