-- Chat history table for Nexus bot workers
-- history_key format: nexus:<user_id>
-- Capped to last 30 turns per key in history.js loadHistory().
-- Apply via: wrangler d1 execute <db-name> --file=migrations/001_chat_history.sql --remote

CREATE TABLE IF NOT EXISTS chat_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  history_key TEXT    NOT NULL,
  role        TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_history_key
  ON chat_history (history_key, created_at);
