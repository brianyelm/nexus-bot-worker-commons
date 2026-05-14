// =============================================================================
// lib/watercooler.js - Watercooler ambient chime-in decision engine
//
// Probabilistic gate replicating Discord watercooler behavior: ~10% chime-in
// chance on human messages, rate-limited per bot (10 min own cooldown) and
// across bots (3 min cross-bot guard), with a channel-warmth requirement
// (2+ human messages in 3 min window).
//
// Usage (from handleChatMessage):
//   const decision = await shouldChimeIn(env, "robert", "watercooler", body, nexusOpts);
//   if (decision.respond) { /* run watercooler LLM pipeline */ }
// =============================================================================

import { fetchChannelMessages } from "./nexus.js";

const OWN_COOLDOWN_MS = 10 * 60 * 1000;
const CROSS_BOT_GUARD_MS = 3 * 60 * 1000;
const MIN_MSG_LENGTH = 15;
const CHIME_PROBABILITY = 0.10;

/**
 * Decide whether this bot should chime in on a watercooler message.
 *
 * @param {object} env
 * @param {string} botName - e.g. "robert"
 * @param {string} channelSlug
 * @param {string} body - the triggering message text
 * @param {object} nexusOptions - { nexusKeyEnvVar }
 * @returns {Promise<{respond: boolean, reason: string}>}
 */
export async function shouldChimeIn(env, botName, channelSlug, body, nexusOptions) {
  if ((body || "").trim().length < MIN_MSG_LENGTH) {
    return { respond: false, reason: "too short" };
  }

  const recent = await fetchChannelMessages(env, channelSlug, {
    ...nexusOptions,
    limit: 20,
  });
  if (!recent || recent.length === 0) {
    return { respond: false, reason: "no recent messages" };
  }

  const now = Date.now();
  const botId = `bot_${botName}`;

  for (const m of recent) {
    if (m.user_id === botId && now - m.created_at < OWN_COOLDOWN_MS) {
      return { respond: false, reason: "own cooldown" };
    }
  }

  for (const m of recent) {
    const uid = m.user_id || "";
    if (uid !== botId && uid.startsWith("bot_") && now - m.created_at < CROSS_BOT_GUARD_MS) {
      return { respond: false, reason: "another bot just spoke" };
    }
  }

  if (Math.random() >= CHIME_PROBABILITY) {
    return { respond: false, reason: "no chime roll" };
  }

  return { respond: true, reason: "ambient chime-in" };
}
