-- HITL pending actions table for Nexus bot workers
-- Tracks approval cards posted to the approvals channel.
-- Apply via: wrangler d1 execute <db-name> --file=migrations/003_hitl_pending.sql --remote

CREATE TABLE IF NOT EXISTS hitl_pending (
  message_id        TEXT    PRIMARY KEY,
  channel_slug      TEXT    NOT NULL,
  action_payload    TEXT    NOT NULL,
  requester_user_id TEXT    NOT NULL,
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER,
  resolution        TEXT
);
