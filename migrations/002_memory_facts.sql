-- Facts (memory) table for Nexus bot workers
-- Scoped to user_id. Used by rememberFact / forgetFact / listFacts / buildFactsBlock.
-- Apply via: wrangler d1 execute <db-name> --file=migrations/002_memory_facts.sql --remote

CREATE TABLE IF NOT EXISTS facts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facts_user ON facts (user_id);
