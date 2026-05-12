CREATE TABLE IF NOT EXISTS hitl_pending (
  message_id TEXT PRIMARY KEY,
  channel_slug TEXT NOT NULL,
  action_payload TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT
);
