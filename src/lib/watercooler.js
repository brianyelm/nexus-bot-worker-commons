// =============================================================================
// lib/watercooler.js - Watercooler ambient chime-in decision engine
//
// Two tiers:
//   Tier 1 (name mention): someone said this bot's name -> always respond
//          (bypasses probability + cross-bot guard; short cooldown applies)
//   Tier 2 (ambient):      probabilistic chime-in (~12%), rate-limited
//          suppressed when the message clearly addresses a different bot
//
// Usage (from handleChatMessage):
//   const decision = await shouldChimeIn(env, "robert", "watercooler", body, nexusOpts);
//   if (decision.respond) { /* run watercooler LLM pipeline */ }
// =============================================================================

import { fetchChannelMessages } from "./nexus.js";

const OWN_COOLDOWN_MS = 90 * 1000;
const AMBIENT_COOLDOWN_MS = 10 * 60 * 1000;
const CROSS_BOT_GUARD_MS = 3 * 60 * 1000;
const MIN_MSG_LENGTH = 15;
const CHIME_PROBABILITY = 0.12;

const NAME_ALIASES = {
  robert: ["robert", "rob", "robby", "bob", "bobby"],
  courtney: ["courtney", "court"],
  dexter: ["dexter", "dex"],
  jacob: ["jacob", "jake"],
  maxwell: ["maxwell", "max"],
  moxie: ["moxie", "mox"],
  wren: ["wren"],
  kate: ["kate", "katie"],
};

function mentionsBotName(body, botName) {
  const lower = (body || "").toLowerCase();
  const aliases = NAME_ALIASES[botName] || [botName];
  for (const alias of aliases) {
    const re = new RegExp(`\\b${alias}\\b`, "i");
    if (re.test(lower)) return true;
  }
  return false;
}

function mentionsAnyBot(body) {
  for (const [, aliases] of Object.entries(NAME_ALIASES)) {
    for (const alias of aliases) {
      const re = new RegExp(`\\b${alias}\\b`, "i");
      if (re.test(body || "")) return true;
    }
  }
  return false;
}

/**
 * @param {object} env
 * @param {string} botName - e.g. "robert"
 * @param {string} channelSlug
 * @param {string} body - the triggering message text
 * @param {object} nexusOptions - { nexusKeyEnvVar }
 * @returns {Promise<{respond: boolean, reason: string, nameMention?: boolean}>}
 */
export async function shouldChimeIn(env, botName, channelSlug, body, nexusOptions) {
  const trimmed = (body || "").trim();
  const named = mentionsBotName(body, botName);

  if (!named && trimmed.length < MIN_MSG_LENGTH) {
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
  const cooldown = named ? OWN_COOLDOWN_MS : AMBIENT_COOLDOWN_MS;

  for (const m of recent) {
    if (m.user_id === botId && now - m.created_at < cooldown) {
      return { respond: false, reason: "own cooldown" };
    }
  }

  // Tier 1: name mentioned -> respond (skip cross-bot guard + probability)
  if (named) {
    return { respond: true, reason: "name mentioned", nameMention: true };
  }

  // Tier 2: ambient probabilistic
  // Suppress when the message addresses a different bot by name
  if (mentionsAnyBot(body)) {
    return { respond: false, reason: "message addresses another bot" };
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
