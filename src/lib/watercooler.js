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

function mentionsOtherBot(body, botName) {
  for (const [name, aliases] of Object.entries(NAME_ALIASES)) {
    if (name === botName) continue;
    for (const alias of aliases) {
      const re = new RegExp(`\\b${alias}\\b`, "i");
      if (re.test(body || "")) return true;
    }
  }
  return false;
}

/**
 * Detect whether this bot is in an active back-and-forth with a specific
 * user. Window-based: find the bot's most recent post within
 * CONVO_WINDOW_MS, then check whether userId posted at least once between
 * that bot post and now. No adjacency required -- interleaving messages
 * from other people do not break the conversation.
 *
 * @param {object[]} recent - messages newest-first
 * @param {string} botId - e.g. "bot_robert"
 * @param {string} userId - the human to check against
 * @param {number} now
 * @returns {boolean}
 */
function isActiveConvo(recent, botId, userId, now) {
  // Find the bot's most recent post within the conversation window.
  let botPostIndex = -1;
  for (let i = 0; i < recent.length; i++) {
    if (recent[i].user_id === botId && now - recent[i].created_at < CONVO_WINDOW_MS) {
      botPostIndex = i;
      break;
    }
  }
  if (botPostIndex < 0) return false;

  // Check if userId posted at least once between the bot's post and now
  // (i.e. in the messages newer than the bot's post).
  for (let i = 0; i < botPostIndex; i++) {
    if (recent[i].user_id === userId) return true;
  }
  return false;
}

/**
 * Find the userId the bot is currently in an active conversation with
 * (if any). Returns the partner's user_id or null.
 *
 * @param {object[]} recent - messages newest-first
 * @param {string} botId
 * @param {number} now
 * @returns {string|null}
 */
function findActiveConvoPartner(recent, botId, now) {
  // Find the bot's most recent post within the conversation window.
  let botPostIndex = -1;
  for (let i = 0; i < recent.length; i++) {
    if (recent[i].user_id === botId && now - recent[i].created_at < CONVO_WINDOW_MS) {
      botPostIndex = i;
      break;
    }
  }
  if (botPostIndex < 0) return null;

  // Walk messages newer than the bot's post to find a human who replied.
  for (let i = botPostIndex - 1; i >= 0; i--) {
    const uid = recent[i].user_id;
    if (uid && !uid.startsWith("bot_") && uid !== "system") return uid;
  }
  return null;
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

  const addressesOther = mentionsOtherBot(body, botName);
  const inConvo = userId && !addressesOther && isActiveConvo(recent, botId, userId, now);
  const directlyAddressed = named || inConvo;

  // Active-conversation suppression: if this bot is mid-conversation with
  // someone else and the current message is NOT from that partner and is NOT
  // a direct name-mention, suppress ambient chime-in so the bot stays
  // focused on its current conversation partner.
  if (!named && userId) {
    const partner = findActiveConvoPartner(recent, botId, now);
    if (partner && partner !== userId) {
      return { respond: false, reason: "active conversation with someone else" };
    }
  }

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
