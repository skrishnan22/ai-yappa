CREATE UNIQUE INDEX memories_live_subject_content ON memories (subject_user_id, content)
  WHERE deleted_at IS NULL;
