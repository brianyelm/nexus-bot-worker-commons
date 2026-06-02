// =============================================================================
// lib/memoryRecall.js - Shared cross-surface memory recall for non-Nexus
// surfaces (email pollers, Twilio voice bridge).
//
// Nexus chat/voice already identify people by nexus_user_id (Nexus is internal
// staff only). Email and phone instead arrive with an address or a number, so
// those surfaces must MATCH the inbound identity to a known Black Raven user
// (their email or phone) before recalling memory. This helper does exactly
// that: resolve the contact's shared memory entity by email/phone/userId, then
// build a recall block of durable facts + recent cross-surface turns.
//
// The point is PARITY: a fact stated on a call or in Nexus chat ("Mike Roberts'
// favorite color is red") is then available when the same person is answered by
// email or phone too, because all surfaces resolve to ONE entity per person.
//
// Best-effort: returns { entityId: null, block: "" } when MEMORY is unbound,
// the contact cannot be matched, or nothing is known.
// =============================================================================

import { resolveEntity, getEntityContext } from "./memoryService.js";

/**
 * Resolve a contact's memory entity by whichever identifier the surface knows
 * (email for mail, phone for Twilio, userId for completeness) and build a
 * recall block to inject into the model's system prompt.
 *
 * @param {object} env - worker env with MEMORY service binding
 * @param {string} botId - e.g. "courtney", "wren", "robert"
 * @param {object} contact
 * @param {string} [contact.userId] - Nexus user_id (if known)
 * @param {string} [contact.email] - sender email (mail surfaces)
 * @param {string} [contact.phone] - caller phone E.164 (Twilio)
 * @param {string} [contact.displayName]
 * @param {string} [query] - subject/body/utterance text for semantic ranking
 * @param {object} [opts]
 * @param {number} [opts.maxFacts=20]
 * @param {number} [opts.maxTurns=10]
 * @returns {Promise<{entityId: string|null, block: string}>}
 */
export async function buildContactRecall(env, botId, contact = {}, query, opts = {}) {
  if (!env || !env.MEMORY) return { entityId: null, block: "" };
  const { userId, email, phone, displayName } = contact;
  if (!userId && !email && !phone) return { entityId: null, block: "" };
  const maxFacts = opts.maxFacts ?? 20;
  const maxTurns = opts.maxTurns ?? 10;

  try {
    const entityId = await resolveEntity(env, botId, { userId, email, phone, displayName });
    if (!entityId) return { entityId: null, block: "" };
    const ctx = await getEntityContext(env, botId, entityId, query);
    if (!ctx) return { entityId, block: "" };

    const lines = [];
    const facts = (Array.isArray(ctx.facts) ? ctx.facts : []).filter(f => f?.predicate && f?.object);
    if (facts.length) {
      lines.push("Known facts:");
      for (const f of facts.slice(0, maxFacts)) {
        lines.push(`- ${String(f.predicate).replace(/_/g, " ")}: ${f.object}`);
      }
    }
    const turns = (Array.isArray(ctx.recent_turns) ? ctx.recent_turns : []).filter(t => t?.content);
    if (turns.length) {
      if (lines.length) lines.push("");
      lines.push("Recent across chat/voice/phone/email (oldest to newest):");
      for (const t of turns.slice(-maxTurns)) {
        const who = t.role === "assistant" ? "you" : "them";
        lines.push(`- ${who}: ${String(t.content).replace(/\s+/g, " ").slice(0, 200)}`);
      }
    }
    if (!lines.length) return { entityId, block: "" };

    const block =
      "\n\nWHAT YOU REMEMBER ABOUT THIS PERSON (your shared memory across chat, voice calls, " +
      "phone, and email; use it naturally for continuity, do NOT recite it verbatim or say you " +
      "looked it up). If it answers what they asked, just answer:\n" + lines.join("\n");
    return { entityId, block };
  } catch (err) {
    console.warn(`[memoryRecall] recall failed (${botId}): ${err?.message}`);
    return { entityId: null, block: "" };
  }
}
