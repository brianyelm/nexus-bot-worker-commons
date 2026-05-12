// =============================================================================
// lib/triggers.js - Ambient trigger pattern matching for Nexus bot workers
//
// When a bot has ambient_listen=1 on a channel, Nexus fires a callback for
// every message (trigger_type="ambient"). This module decides whether the
// bot should actually respond to that message.
//
// Factory function:
//   makeShouldRespond(botName, aliases) -> (body, replyTo, lastMsgId) => boolean
//
// Match patterns (any one is sufficient to return true):
//   1. body contains @<alias> mention (case-insensitive, word-boundary-safe)
//   2. body contains "<botName>:" at the start or after whitespace
//   3. body starts with "<botName> " (case-insensitive)
//   4. replyTo === lastMsgId (both non-null) -- user replied to bot's last message
//
// botName is always added as an implicit alias alongside the supplied aliases.
//
// Examples:
//   makeShouldRespond("robert", ["rob", "bob"])
//   makeShouldRespond("dexter", ["dex"])
//   makeShouldRespond("maxwell", [])
// =============================================================================

/**
 * Build a pattern that matches @alias tokens in a message body.
 * Handles word boundaries on both sides without using \b (which is ASCII-only).
 *
 * @param {string} alias
 * @returns {RegExp}
 */
function aliasPattern(alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)@${escaped}(?:\\s|$|[^a-zA-Z0-9_])`, "i");
}

/**
 * Build a pattern that matches "<name>:" at start of body or after whitespace.
 *
 * @param {string} name
 * @returns {RegExp}
 */
function colonPattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}:`, "i");
}

/**
 * Build a pattern that matches "<name> " at the very beginning of the body.
 *
 * @param {string} name
 * @returns {RegExp}
 */
function spaceLeadPattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\s`, "i");
}

/**
 * Factory: returns a shouldRespond function configured for a specific bot.
 *
 * @param {string} botName - Primary bot name (e.g. "robert", "dexter")
 * @param {string[]} [aliases=[]] - Additional aliases (e.g. ["rob", "bob"])
 * @returns {(body: string, replyTo: string|null, lastMsgId: string|null) => boolean}
 */
export function makeShouldRespond(botName, aliases = []) {
  // All names to check for @-alias patterns
  const allAliases = [botName, ...aliases];
  const aliasPatterns = allAliases.map(aliasPattern);

  // Name-colon and name-space patterns are only built from botName (primary)
  const colonRe = colonPattern(botName);
  const spaceLeadRe = spaceLeadPattern(botName);

  /**
   * Determine whether the bot should respond to an ambient message.
   *
   * @param {string} body - raw message body text
   * @param {string|null} replyTo - parent message_id from callback payload, or null
   * @param {string|null} lastMsgId - most recent message id posted by this bot in channel, or null
   * @returns {boolean}
   */
  return function shouldRespond(body, replyTo, lastMsgId) {
    if (typeof body !== "string" || body.length === 0) return false;

    // Direct reply to a bot-authored message
    if (replyTo && lastMsgId && replyTo === lastMsgId) return true;

    // @alias mentions (includes @botName itself)
    for (const re of aliasPatterns) {
      if (re.test(body)) return true;
    }

    // "botName:" prefix
    if (colonRe.test(body)) return true;

    // "botName " at the beginning of the body
    if (spaceLeadRe.test(body)) return true;

    return false;
  };
}
