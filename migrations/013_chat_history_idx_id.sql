-- Migration 013: covering index for chat_history loadHistory query
--
-- The original idx_chat_history_key index covers (history_key, created_at).
-- The loadHistory query was changed from ORDER BY created_at DESC, id DESC
-- to ORDER BY id DESC to avoid an in-memory sort over all rows for a key.
-- This index on (history_key, id) fully covers the new query shape so D1
-- can seek to the tail of a key's rows without a table scan or memory sort.
--
-- Also performs a one-time prune of any history_key that already has more
-- than 200 rows, keeping the 150 most-recent by id. This clears accumulated
-- backlog that can cause D1 timeout errors and LlmRoom DO resets.
--
-- Apply per-bot:
--   npx wrangler d1 execute <db-name> --file=migrations/013_chat_history_idx_id.sql --remote

CREATE INDEX IF NOT EXISTS idx_chat_history_key_id
  ON chat_history (history_key, id);

-- One-time backlog prune: for every history_key with more than 200 rows,
-- delete everything older than the 150th-most-recent row (by id).
DELETE FROM chat_history
WHERE id < (
  SELECT s.cutoff_id
  FROM (
    SELECT
      c2.history_key AS hk,
      (
        SELECT c3.id
        FROM chat_history c3
        WHERE c3.history_key = c2.history_key
        ORDER BY c3.id DESC
        LIMIT 1 OFFSET 149
      ) AS cutoff_id,
      COUNT(*) AS cnt
    FROM chat_history c2
    GROUP BY c2.history_key
    HAVING COUNT(*) > 200
  ) s
  WHERE s.hk = chat_history.history_key
    AND s.cutoff_id IS NOT NULL
);
