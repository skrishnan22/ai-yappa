-- A failed assertion violates CHECK and makes Wrangler exit unsuccessfully.
-- The runner uses a fresh local database and deletes it afterwards.
CREATE TABLE smoke_assertions (ok INTEGER NOT NULL CHECK (ok = 1));

INSERT INTO questions
  (id, conversation_id, channel_id, thread_ts, kind, title, recommendation, choices, status, created_at)
VALUES
  ('smoke-q1', 'smoke-conv', 'C1', '1', 'choice', 'Where?', 'D1',
   '[{"id":"A","label":"KV"},{"id":"B","label":"D1","recommended":true}]', 'open', '2026-10-04T00:00:00.000Z');

INSERT INTO thread_participants (conversation_id, user_id, joined_at)
VALUES ('smoke-conv', 'U1', '2026-10-04T00:00:00.000Z')
ON CONFLICT (conversation_id, user_id) DO NOTHING;
INSERT INTO thread_participants (conversation_id, user_id, joined_at)
VALUES ('smoke-conv', 'U1', '2026-10-04T00:01:00.000Z')
ON CONFLICT (conversation_id, user_id) DO NOTHING;
INSERT INTO smoke_assertions SELECT COUNT(*) = 1 AND MIN(joined_at) = '2026-10-04T00:00:00.000Z'
FROM thread_participants WHERE conversation_id = 'smoke-conv';

INSERT INTO votes (question_id, user_id, choice_id, user_name, updated_at)
SELECT 'smoke-q1', 'U1', 'A', 'Maya', '2026-10-04T00:00:00.000Z' WHERE EXISTS (
  SELECT 1 FROM questions q, json_each(q.choices) choice
  WHERE q.id = 'smoke-q1' AND q.status = 'open' AND q.kind = 'choice'
    AND json_extract(choice.value, '$.id') = 'A'
) ON CONFLICT (question_id, user_id) DO UPDATE SET
choice_id = excluded.choice_id, user_name = excluded.user_name, updated_at = excluded.updated_at;
INSERT INTO votes (question_id, user_id, choice_id, user_name, updated_at)
SELECT 'smoke-q1', 'U1', 'B', 'Maya', '2026-10-04T00:01:00.000Z' WHERE EXISTS (
  SELECT 1 FROM questions q, json_each(q.choices) choice
  WHERE q.id = 'smoke-q1' AND q.status = 'open' AND q.kind = 'choice'
    AND json_extract(choice.value, '$.id') = 'B'
) ON CONFLICT (question_id, user_id) DO UPDATE SET
choice_id = excluded.choice_id, user_name = excluded.user_name, updated_at = excluded.updated_at;
INSERT INTO smoke_assertions SELECT COUNT(*) = 1 AND MIN(choice_id) = 'B'
FROM votes WHERE question_id = 'smoke-q1' AND user_id = 'U1';

UPDATE questions SET status = 'submitted', submitted_by = 'U1', submitted_by_name = 'Maya',
closed_at = '2026-10-04T00:02:00.000Z' WHERE id = 'smoke-q1' AND status = 'open';
INSERT INTO smoke_assertions VALUES (changes() = 1);
UPDATE questions SET status = 'submitted', submitted_by = 'U2', submitted_by_name = 'Raj',
closed_at = '2026-10-04T00:03:00.000Z' WHERE id = 'smoke-q1' AND status = 'open';
INSERT INTO smoke_assertions VALUES (changes() = 0);
INSERT INTO smoke_assertions SELECT COUNT(*) = 1 AND MIN(submitted_by) = 'U1' AND MIN(submitted_by_name) = 'Maya'
FROM questions WHERE id = 'smoke-q1' AND status = 'submitted';

INSERT INTO votes (question_id, user_id, choice_id, user_name, updated_at)
SELECT 'smoke-q1', 'U1', 'A', 'Maya', '2026-10-04T00:03:00.000Z' WHERE EXISTS (
  SELECT 1 FROM questions q, json_each(q.choices) choice
  WHERE q.id = 'smoke-q1' AND q.status = 'open' AND q.kind = 'choice'
    AND json_extract(choice.value, '$.id') = 'A'
) ON CONFLICT (question_id, user_id) DO UPDATE SET
choice_id = excluded.choice_id, user_name = excluded.user_name, updated_at = excluded.updated_at;
INSERT INTO smoke_assertions VALUES (changes() = 0);

INSERT INTO questions
  (id, conversation_id, channel_id, thread_ts, kind, title, recommendation, status, created_at)
VALUES ('smoke-q2', 'smoke-conv', 'C1', '1', 'open', 'Why?', 'Explain.', 'open', '2026-10-04T00:04:00.000Z');
INSERT INTO smoke_assertions SELECT COUNT(*) = 1 AND MIN(id) = 'smoke-q2'
FROM questions WHERE conversation_id = 'smoke-conv' AND status = 'open';

SELECT COUNT(*) AS passed_assertions FROM smoke_assertions;
