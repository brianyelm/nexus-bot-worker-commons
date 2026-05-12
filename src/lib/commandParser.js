// =============================================================================
// lib/commandParser.js - Parse !command syntax from Nexus chat messages
//
// parseCommand(body, [knownVerbs]) recognises "!verb arg1 arg2 ..." at the
// start of a message body (after @mention tokens have been stripped).
// Returns { verb, args } or null.
//
// knownVerbs behavior:
//   - When knownVerbs is a Set or Array, parseCommand returns null unless the
//     verb is in the set. This prevents false matches on !something that is
//     not a supported command.
//   - When knownVerbs is omitted or falsy, any leading !word is parsed and
//     the caller dispatches (useful for bots with open-ended command surfaces).
//
// Foundation verbs (remember/forget/facts/clear/status) are added by
// handleChatMessage at dispatch time; they are NOT hardcoded here. This keeps
// parseCommand pure and reusable across bots with different command sets.
// =============================================================================

/**
 * Parse a !command out of a message body.
 *
 * @param {string} body - Raw message body (already mention-stripped)
 * @param {Set<string>|Array<string>|null} [knownVerbs] - Optional allowed verb list
 * @returns {{ verb: string, args: string } | null}
 */
export function parseCommand(body, knownVerbs) {
  if (typeof body !== "string") return null;

  const trimmed = body.trim();
  if (!trimmed.startsWith("!")) return null;

  const parts = trimmed.split(/\s+/);
  const rawVerb = parts[0].slice(1).toLowerCase();

  if (knownVerbs) {
    const verbSet = Array.isArray(knownVerbs)
      ? new Set(knownVerbs.map(v => v.toLowerCase()))
      : knownVerbs;
    if (!verbSet.has(rawVerb)) return null;
  }

  const args = parts.slice(1).join(" ");
  return { verb: rawVerb, args };
}
