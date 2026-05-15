// =============================================================================
// lib/watercooler.js - Watercooler ambient chime-in decision engine
//
// Three tiers:
//   Tier 0 (active convo): this bot posted recently and the SAME human is
//          still talking -> respond (15s cooldown only)
//   Tier 1 (name mention): someone said this bot's name -> respond (15s cooldown)
//   Tier 2 (ambient):      probabilistic chime-in (~12%), rate-limited (10min)
//          suppressed when the message clearly addresses a different bot
//
// Usage (from handleChatMessage):
//   const decision = await shouldChimeIn(env, "robert", "watercooler", body, nexusOpts);
//   if (decision.respond) { /* run watercooler LLM pipeline */ }
// =============================================================================

import { fetchChannelMessages } from "./nexus.js";

const CONVO_COOLDOWN_MS = 15 * 1000;
const AMBIENT_COOLDOWN_MS = 10 * 60 * 1000;
const CONVO_WINDOW_MS = 5 * 60 * 1000;
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
 * Detect whether this bot is in an active back-and-forth with the user who
 * just posted. Walk recent messages backwards: if we find a message from
 * this bot within CONVO_WINDOW_MS, AND the message before it (or after it
 * in the list) was from the same user_id that triggered this callback,
 * the bot is mid-conversation and should keep responding.
 *
 * @param {object[]} recent - messages newest-first
 * @param {string} botId - e.g. "bot_robert"
 * @param {string} userId - the human who just posted
 * @param {number} now
 * @returns {boolean}
 */
function isActiveConvo(recent, botId, userId, now) {
  for (let i = 0; i < recent.length; i++) {
    const m = recent[i];
    if (m.user_id === botId && now - m.created_at < CONVO_WINDOW_MS) {
      const prev = recent[i + 1];
      if (prev && prev.user_id === userId) return true;
      if (i > 0 && recent[i - 1].user_id === userId) return true;
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
 * @param {string} [userId] - the user who posted the message
 * @returns {Promise<{respond: boolean, reason: string, nameMention?: boolean}>}
 */
export async function shouldChimeIn(env, botName, channelSlug, body, nexusOptions, userId) {
  const trimmed = (body || "").trim();
  const named = mentionsBotName(body, botName);

  const recent = await fetchChannelMessages(env, channelSlug, {
    ...nexusOptions,
    limit: 20,
  });
  if (!recent || recent.length === 0) {
    return { respond: false, reason: "no recent messages" };
  }

  const now = Date.now();
  const botId = `bot_${botName}`;

  const inConvo = userId && isActiveConvo(recent, botId, userId, now);
  const directlyAddressed = named || inConvo;

  if (!directlyAddressed && trimmed.length < MIN_MSG_LENGTH) {
    return { respond: false, reason: "too short" };
  }

  const cooldown = directlyAddressed ? CONVO_COOLDOWN_MS : AMBIENT_COOLDOWN_MS;

  for (const m of recent) {
    if (m.user_id === botId && now - m.created_at < cooldown) {
      return { respond: false, reason: "own cooldown" };
    }
  }

  // Tier 0: active conversation continuation
  if (inConvo) {
    return { respond: true, reason: "active conversation", nameMention: true };
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
