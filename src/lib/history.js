// =============================================================================
// lib/history.js - D1-backed conversation history for Nexus chat bots
//
// history_key format: nexus:<user_id>
// Each user gets an isolated conversation thread per bot. Per-bot isolation
// is achieved by using separate D1 databases (one DB binding per bot worker).
//
// Functions:
//   loadHistory(env, historyKey, [options])  - returns last N turns, chronological
//   appendHistory(env, historyKey, role, content, [options]) - inserts one row
//
// Cap: last 30 turns per key by default. Older rows are not pruned from the DB
// automatically; the SELECT simply reads the tail. Pruning can be added later.
//
// options:
//   dbBinding {string} - env binding name for the D1 database (default: "DB")
//   maxTurns  {number} - max turns to return (default: 30)
//
// Errors are caught, logged, and swallowed. loadHistory returns []; appendHistory
// is a no-op on failure. History loss is better than crashing the bot.
// =============================================================================

const DEFAULT_DB_BINDING = "DB";
const DEFAULT_MAX_TURNS = 30;

/**
 * Load the last maxTurns conversation turns for a given history key.
 * Returns rows in chronological order (oldest first).
 *
 * @param {object} env - Worker environment bindings
 * @param {string} historyKey - e.g. "nexus:12345"
 * @param {object} [options]
 * @param {string} [options.dbBinding="DB"] - D1 binding name on env
 * @param {number} [options.maxTurns=30] - Max turns to return
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
export async function loadHistory(env, historyKey, options = {}) {
  const dbKey = options.dbBinding || DEFAULT_DB_BINDING;
  const maxTurns = options.maxTurns || DEFAULT_MAX_TURNS;
  const db = env[dbKey];

  if (!db) {
    console.warn(`[history] DB binding "${dbKey}" not available -- returning empty history`);
    return [];
  }
  try {
    const result = await db
      .prepare(
        "SELECT role, content FROM chat_history WHERE history_key = ? ORDER BY created_at DESC LIMIT ?",
      )
      .bind(historyKey, maxTurns)
      .all();

    const rows = result?.results || [];
    return rows.reverse().map(({ role, content }) => ({ role, content }));
  } catch (err) {
    console.error("[history] loadHistory failed:", err.message);
    return [];
  }
}

/**
 * Append a single conversation turn to D1.
 * Errors are logged and swallowed.
 *
 * @param {object} env - Worker environment bindings
 * @param {string} historyKey - e.g. "nexus:12345"
 * @param {"user"|"assistant"} role
 * @param {string} content
 * @param {object} [options]
 * @param {string} [options.dbBinding="DB"] - D1 binding name on env
 * @returns {Promise<void>}
 */
export async function appendHistory(env, historyKey, role, content, options = {}) {
  const dbKey = options.dbBinding || DEFAULT_DB_BINDING;
  const db = env[dbKey];

  if (!db) {
    console.warn(`[history] DB binding "${dbKey}" not available -- skipping append`);
    return;
  }
  const createdAt = Math.floor(Date.now() / 1000);
  try {
    await db
      .prepare(
        "INSERT INTO chat_history (history_key, role, content, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(historyKey, role, content, createdAt)
      .run();
  } catch (err) {
    console.error("[history] appendHistory failed:", err.message);
  }
}
