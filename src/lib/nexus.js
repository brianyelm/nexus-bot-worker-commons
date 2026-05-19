// =============================================================================
// lib/nexus.js - Nexus comms-app integration for bot workers
//
// Provides:
//   postToNexus(env, slug, content, [options])      - POST markdown to a channel
//                                                     (auto-switches to channel-gated
//                                                     Bearer route when attachment_ids
//                                                     supplied so images render inline)
//   uploadBotAttachment(env, bytes, filename, mime, [options]) - upload file, get id
//   attachButtons(env, messageId, buttons, [options]) - attach interactive buttons
//   sendNexusHeartbeat(env, [meta], [options])       - heartbeat ping
//   sendTyping(env, slug, action, [options])        - "<bot> is typing..." indicator
//
// options:
//   nexusKeyEnvVar     {string} - env var name for the API key (default: inferred below)
//   callbackSecretEnvVar {string} - env var name for button callback_secret
//
// Auth: X-API-Key: <env[nexusKeyEnvVar]> on every request (or Bearer
// where the Nexus route requires it; sendTyping uses Bearer).
// Errors are swallowed with console.warn so a Nexus outage never crashes a
// cron job or chat handler. Callers receive null on failure.
//
// Because this library is shared across bots, the nexusKeyEnvVar option
// must be supplied via the options object. postToNexus and attachButtons
// look up the key as env[options.nexusKeyEnvVar]. When options is omitted
// the caller should ensure env.NEXUS_KEY or env[botName + "_NEXUS_KEY"]
// is reachable -- but the canonical path is via options.nexusKeyEnvVar.
//
// NOTE: handleChatMessage passes options automatically from config.
// Direct callers (cron jobs) should pass { nexusKeyEnvVar: "BOT_NEXUS_KEY" }.
//
// Fleet error surfacing: attachButtons and editNexusMessage call
// reportFleetError on failure. postToNexus, sendTyping, sendNexusHeartbeat,
// and pingBotPresence do NOT -- postToNexus would recurse, the typing/
// heartbeat/presence ops are high-frequency ambient calls whose failures
// are expected noise during brief outages and must stay silent.
// =============================================================================

import { getProvenanceContext } from "./provenanceContext.js";

// Lazy import to avoid circular dependency: fleetError imports postToNexus,
// so we must not import at module load time (CF Workers module-scope I/O ban
// and circular dep risk). We inline a dynamic import wrapper instead.
// Because CF Workers are module workers, top-level dynamic import is fine
// as long as it happens inside a function body (per-request), not at parse time.
let _reportFleetError = null;
async function _getReportFleetError() {
  if (!_reportFleetError) {
    const mod = await import("./fleetError.js");
    _reportFleetError = mod.reportFleetError;
  }
  return _reportFleetError;
}

const TIMEOUT_MS = 8000;

/**
 * Resolve the Nexus API key from env using the provided env var name or
 * common fallback names.
 *
 * @param {object} env
 * @param {object} [options]
 * @returns {string|undefined}
 */
function resolveNexusKey(env, options = {}) {
  if (options.nexusKeyEnvVar) return env[options.nexusKeyEnvVar];
  // Fallback: try common names so direct callers without options still work
  return env.NEXUS_KEY || env.BOT_NEXUS_KEY;
}

/**
 * Derive a human-readable bot display name from the nexusKeyEnvVar option or
 * the BOT_DISPLAY_NAME env binding. Used when calling reportFleetError so
 * errors in #fleet-errors are attributed to the right bot rather than
 * falling back to "unknown-bot".
 *
 * Resolution order:
 *   1. options.nexusKeyEnvVar stripped of "_NEXUS_KEY" suffix (e.g.
 *      "COURTNEY_NEXUS_KEY" -> "Courtney", "BOT_NEXUS_KEY" -> "Bot")
 *   2. env.BOT_DISPLAY_NAME (wrangler [vars] entry, set per-worker)
 *   3. undefined (reportFleetError uses its own fallback "unknown-bot")
 *
 * @param {object} env
 * @param {object} [options]
 * @returns {string|undefined}
 */
function deriveBotName(env, options = {}) {
  if (options.nexusKeyEnvVar) {
    // Strip the "_NEXUS_KEY" or "_NEXUS_KEY_TEST" suffix and title-case the remainder.
    const raw = options.nexusKeyEnvVar.replace(/_NEXUS_KEY(?:_TEST)?$/, "");
    if (raw && raw !== options.nexusKeyEnvVar) {
      // Convert SCREAMING_SNAKE to Title Case: "COURTNEY" -> "Courtney"
      return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    }
  }
  if (env && env.BOT_DISPLAY_NAME) return String(env.BOT_DISPLAY_NAME);
  return undefined;
}

/**
 * Resolve the callback secret from env.
 *
 * @param {object} env
 * @param {object} [options]
 * @returns {string|undefined}
 */
function resolveCallbackSecret(env, options = {}) {
  if (options.callbackSecretEnvVar) return env[options.callbackSecretEnvVar];
  if (options.callbackSecret) return options.callbackSecret;
  return env.CALLBACK_SECRET || env.BOT_CALLBACK_SECRET;
}

/**
 * POST JSON to a Nexus endpoint using X-API-Key auth and return parsed JSON on success.
 * Throws on non-2xx so callers can catch and log.
 *
 * @param {string} url
 * @param {object} body
 * @param {string} apiKey
 * @returns {Promise<object>}
 */
async function _post(url, body, apiKey) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Nexus POST ${url} -> ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * POST JSON to a Nexus endpoint using Authorization: Bearer auth and return parsed JSON on success.
 * Used for bot-side component routes (e.g. /api/bot/messages/:id/buttons) which require
 * Bearer token auth rather than X-API-Key.
 * Throws on non-2xx so callers can catch and log.
 *
 * @param {string} url
 * @param {object} body
 * @param {string} apiKey
 * @returns {Promise<object>}
 */
async function _bearerPost(url, body, apiKey) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Nexus POST ${url} -> ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Post a markdown message to a Nexus channel by slug.
 *
 * Default path: POST /api/bot/messages (the X-API-Key bot endpoint).
 * When options.attachment_ids is supplied, switches to the channel-gated
 * Bearer route POST /api/bot/channels/:slug/messages so the file(s) render
 * inline in the channel. The attachment_ids must come from a prior
 * uploadBotAttachment() call by the same bot.
 *
 * Content is truncated to 8000 chars defensively.
 *
 * @param {object} env
 * @param {string} slug - Nexus channel slug (e.g. "robert-soc", "soc-approvals")
 * @param {string} content - markdown body
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @param {string[]} [options.attachment_ids] - attachment ids from uploadBotAttachment
 * @returns {Promise<object|null>} Nexus message object with .id, or null on error
 */
export async function postToNexus(env, slug, content, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) {
    console.warn("[nexus] missing API key or NEXUS_BASE_URL, skipping post");
    return null;
  }
  const body = typeof content === "string" ? content.slice(0, 8000) : String(content).slice(0, 8000);
  const attachmentIds = Array.isArray(options.attachment_ids) && options.attachment_ids.length > 0
    ? options.attachment_ids
    : null;

  try {
    const provenance = options.provenance ?? getProvenanceContext() ?? null;

    if (attachmentIds) {
      // Channel-gated Bearer route. Required for attachments; provenance mandatory.
      const payload = { body, attachment_ids: attachmentIds };
      if (options.reply_to) payload.reply_to = options.reply_to;
      payload.provenance = provenance || "scheduled-cron";
      const result = await _bearerPost(
        `${env.NEXUS_BASE_URL}/api/bot/channels/${encodeURIComponent(slug)}/messages`,
        payload,
        apiKey,
      );
      pingBotPresence(env, options).catch(() => {});
      return result?.data || null;
    }

    const payload = { channel_slug: slug, body };
    if (options.reply_to) payload.reply_to = options.reply_to;
    if (provenance) payload.provenance = provenance;
    const result = await _post(
      `${env.NEXUS_BASE_URL}/api/bot/messages`,
      payload,
      apiKey,
    );
    // Stamp presence fire-and-forget so the dot turns green. Do not await.
    pingBotPresence(env, options).catch(() => {});
    return result?.data || null;
  } catch (err) {
    console.warn(`[nexus] postToNexus(${slug}) failed:`, err.message);
    return null;
  }
}

/**
 * Upload bytes as an attachment owned by this bot, return the attachment id.
 *
 * Hits POST /api/bot/attachments (Bearer auth, multipart/form-data). Returns
 * the new attachment id, which can be passed to postToNexus(..., { attachment_ids })
 * so the message renders the image/file inline.
 *
 * Max size: 25 MiB (server-enforced). Caller should chunk or downscale before
 * calling for large media. PNG/JPEG/GIF/WEBP/PDF render inline in the Nexus UI;
 * other mimes display as a download link.
 *
 * @param {object} env
 * @param {Uint8Array | ArrayBuffer | Blob} bytes - file contents
 * @param {string} filename - display filename (e.g. "morphora-quote-card.png")
 * @param {string} mime - mime type (e.g. "image/png")
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @returns {Promise<string|null>} attachment id, or null on error
 */
export async function uploadBotAttachment(env, bytes, filename, mime, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) {
    console.warn("[nexus] uploadBotAttachment: missing API key or NEXUS_BASE_URL");
    return null;
  }
  if (!bytes || !filename) {
    console.warn("[nexus] uploadBotAttachment: bytes + filename required");
    return null;
  }

  const blob = bytes instanceof Blob
    ? bytes
    : new Blob([bytes], { type: mime || "application/octet-stream" });

  const form = new FormData();
  form.append("file", blob, filename);

  try {
    const res = await fetch(`${env.NEXUS_BASE_URL}/api/bot/attachments`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[nexus] uploadBotAttachment(${filename}) -> ${res.status}: ${text}`);
      _getReportFleetError().then(fn => fn(env, {
        bot: deriveBotName(env, options),
        op: "uploadBotAttachment",
        msg: `HTTP ${res.status}: ${text.slice(0, 120)}`,
        ctx: { filename, mime, size: blob.size },
      }, options)).catch(() => {});
      return null;
    }
    const j = await res.json().catch(() => ({}));
    return j?.data?.id || null;
  } catch (err) {
    console.warn(`[nexus] uploadBotAttachment(${filename}) failed:`, err.message);
    _getReportFleetError().then(fn => fn(env, {
      bot: deriveBotName(env, options),
      op: "uploadBotAttachment",
      msg: err.message,
      ctx: { filename, mime },
    }, options)).catch(() => {});
    return null;
  }
}

/**
 * Attach interactive buttons to a Nexus message.
 * Uses POST /api/bot/messages/:id/buttons (Bearer auth, bot-side route added 2026-05-10).
 *
 * This route requires:
 *   - Authorization: Bearer <BOT_NEXUS_KEY> (not X-API-Key)
 *   - The bot must have a bot_channel_permissions row for the message's channel
 *   - The message must have been authored by the same bot
 *
 * Stamps each button with callback_secret so Nexus can HMAC-sign the dispatch.
 * The receiving handler (buttonClick.js) verifies the resulting X-Nexus-Signature.
 *
 * @param {object} env
 * @param {string} messageId - Nexus message id returned by postToNexus
 * @param {Array<{button_id: string, label: string, style?: string, callback_url: string}>} buttons
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @param {string} [options.callbackSecretEnvVar] - env var name for callback_secret
 * @param {string} [options.callbackSecret] - callback_secret value directly
 * @returns {Promise<Array|null>} inserted button rows or null on error
 */
export async function attachButtons(env, messageId, buttons, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return null;

  const callbackSecret = resolveCallbackSecret(env, options);

  const withSecret = (Array.isArray(buttons) ? buttons : []).map(b => ({
    ...b,
    ...(callbackSecret ? { callback_secret: callbackSecret } : {}),
  }));

  try {
    const result = await _bearerPost(
      `${env.NEXUS_BASE_URL}/api/bot/messages/${messageId}/buttons`,
      { buttons: withSecret },
      apiKey,
    );
    // Stamp presence fire-and-forget. Do not await.
    pingBotPresence(env, options).catch(() => {});
    return result?.data || null;
  } catch (err) {
    console.warn(`[nexus] attachButtons(${messageId}) failed:`, err.message);
    _getReportFleetError().then(fn => fn(env, {
      bot: deriveBotName(env, options),
      op: "attachButtons",
      msg: err.message,
      ctx: { messageId, buttonCount: Array.isArray(buttons) ? buttons.length : null },
    }, options)).catch(() => {});
    return null;
  }
}

/**
 * Attach message-modal triggers to a Nexus message.
 * Uses POST /api/bot/messages/:id/modals (Bearer auth, same as attachButtons).
 *
 * Each entry in the modals array is stored in Nexus D1. The UI renders a
 * trigger button per modal; clicking it opens an inline form overlay. On
 * submission the server HMAC-signs the payload and POSTs to callback_url.
 *
 * @param {object} env
 * @param {string} messageId - Nexus message id returned by postToNexus
 * @param {Array<{modal_id: string, title: string, fields: Array<object>, callback_url: string}>} modals
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @param {string} [options.callbackSecretEnvVar] - env var name for callback_secret
 * @param {string} [options.callbackSecret] - callback_secret value directly
 * @returns {Promise<Array|null>} inserted modal rows or null on error
 */
export async function attachModals(env, messageId, modals, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return null;

  const callbackSecret = resolveCallbackSecret(env, options);

  const withSecret = (Array.isArray(modals) ? modals : []).map((m) => ({
    ...m,
    ...(callbackSecret ? { callback_secret: callbackSecret } : {}),
  }));

  try {
    const result = await _bearerPost(
      `${env.NEXUS_BASE_URL}/api/bot/messages/${messageId}/modals`,
      { modals: withSecret },
      apiKey,
    );
    pingBotPresence(env, options).catch(() => {});
    return result?.data || null;
  } catch (err) {
    console.warn(`[nexus] attachModals(${messageId}) failed:`, err.message);
    _getReportFleetError().then(fn => fn(env, {
      bot: deriveBotName(env, options),
      op: "attachModals",
      msg: err.message,
      ctx: { messageId, modalCount: Array.isArray(modals) ? modals.length : null },
    }, options)).catch(() => {});
    return null;
  }
}

/**
 * Edit a Nexus message previously posted by this bot.
 * Uses PATCH /api/bot/messages/:id (Bearer auth, authorship enforced
 * server-side -- bot can only edit its own messages).
 *
 * Best-effort: returns null on failure so callers in click-handlers do
 * not crash an HTTP response chain when Nexus is briefly unreachable.
 *
 * @param {object} env
 * @param {string} messageId
 * @param {string} body - new markdown body
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar]
 * @returns {Promise<object|null>}
 */
export async function editNexusMessage(env, messageId, body, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return null;
  if (!messageId || typeof body !== "string" || !body.trim()) return null;
  try {
    const res = await fetch(
      `${env.NEXUS_BASE_URL}/api/bot/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ body, body_format: "markdown" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[nexus] editNexusMessage(${messageId}) -> ${res.status}: ${text}`);
      _getReportFleetError().then(fn => fn(env, {
        bot: deriveBotName(env, options),
        op: "editNexusMessage",
        msg: `HTTP ${res.status}: ${text.slice(0, 120)}`,
        ctx: { messageId },
      }, options)).catch(() => {});
      return null;
    }
    // Stamp presence fire-and-forget. Do not await.
    pingBotPresence(env, options).catch(() => {});
    const j = await res.json().catch(() => ({}));
    return j?.data || null;
  } catch (err) {
    console.warn(`[nexus] editNexusMessage(${messageId}) failed:`, err.message);
    _getReportFleetError().then(fn => fn(env, {
      bot: deriveBotName(env, options),
      op: "editNexusMessage",
      msg: err.message,
      ctx: { messageId },
    }, options)).catch(() => {});
    return null;
  }
}

/**
 * Send a "<bot> is typing..." indicator to a Nexus channel.
 *
 * Hits POST /api/bot/typing (X-API-Key auth, same identity model as
 * postToNexus) which fans the frame out through the channel's ChatRoom
 * DO. The DO sets a 90s TTL on each start; callers in long-running tool
 * loops should re-send "start" periodically (every ~60s) to keep the
 * indicator alive. "stop" clears it immediately (the auto-clear on bot
 * message arrival also handles this, so an explicit stop is mostly
 * insurance for error paths).
 *
 * Why this uses the X-API-Key route, not the channel-gated Bearer route:
 * the typing entry's user_id needs to match the eventual message's
 * user_id so the DO's auto-clear-on-arrival logic lines up. The legacy
 * X-API-Key path resolves keys to bot_<name> (underscore) while the
 * channel-gated Bearer path uses bot-<name> (hyphen); we want the same
 * id chain the post will use.
 *
 * Best-effort: never throws. A Nexus outage or auth misconfig must not
 * crash a chat handler or take down a tool loop.
 *
 * @param {object} env
 * @param {string} slug - Nexus channel slug
 * @param {"start"|"stop"} action
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @returns {Promise<void>}
 */
export async function sendTyping(env, slug, action, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return;
  if (action !== "start" && action !== "stop") return;
  if (!slug || typeof slug !== "string") return;
  try {
    const res = await fetch(
      `${env.NEXUS_BASE_URL}/api/bot/typing`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({ channel_slug: slug, action }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[nexus] sendTyping(${slug}, ${action}) -> ${res.status}: ${text}`);
    }
  } catch (err) {
    console.warn(`[nexus] sendTyping(${slug}, ${action}) failed:`, err.message);
  }
}

/**
 * Stamp this bot's last_seen_at so the presence dot turns green.
 *
 * Fire-and-forget: called internally after every postToNexus /
 * attachButtons / editNexusMessage success. Callers never need to call
 * this directly, though they may if they have bot activity that doesn't
 * go through those helpers (e.g. a cron that only reads data).
 *
 * Uses the same Bearer auth as attachButtons / editNexusMessage.
 * Swallows all errors so a Nexus outage never crashes a cron job.
 *
 * @param {object} env
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @returns {Promise<void>}
 */
export async function pingBotPresence(env, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return;
  try {
    const res = await fetch(`${env.NEXUS_BASE_URL}/api/bot/me/last-seen`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[nexus] pingBotPresence -> ${res.status}: ${text}`);
    }
  } catch (err) {
    console.error("[nexus] pingBotPresence failed:", err.message);
  }
}

/**
 * Read recent messages from a Nexus channel.
 * Uses GET /api/bot/channels/:slug/messages (Bearer auth, channel-perm gated).
 *
 * @param {object} env
 * @param {string} slug - channel slug
 * @param {object} [options]
 * @param {number} [options.limit] - max messages to return (1-50, default 10)
 * @param {string} [options.nexusKeyEnvVar]
 * @returns {Promise<Array|null>} array of { id, user_id, display_name, body, created_at } or null
 */
export async function fetchChannelMessages(env, slug, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return null;
  const limit = options.limit || 10;
  try {
    const url = `${env.NEXUS_BASE_URL}/api/bot/channels/${encodeURIComponent(slug)}/messages?limit=${limit}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[nexus] fetchChannelMessages(${slug}) -> ${res.status}: ${text}`);
      return null;
    }
    const j = await res.json().catch(() => ({}));
    return j?.data || null;
  } catch (err) {
    console.warn(`[nexus] fetchChannelMessages(${slug}) failed:`, err.message);
    return null;
  }
}

/**
 * Send a heartbeat ping to Nexus.
 *
 * @param {object} env
 * @param {object} [meta] - optional metadata to include
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @returns {Promise<void>}
 */
export async function sendNexusHeartbeat(env, meta = {}, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return;
  try {
    const res = await fetch(`${env.NEXUS_BASE_URL}/api/bot/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ status: "ok", meta }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[nexus] heartbeat failed:", res.status, text);
    }
  } catch (err) {
    console.warn("[nexus] heartbeat error:", err.message);
  }
}
