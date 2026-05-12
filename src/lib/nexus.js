// =============================================================================
// lib/nexus.js - Nexus comms-app integration for bot workers
//
// Provides:
//   postToNexus(env, slug, content, [options])      - POST markdown to a channel
//   attachButtons(env, messageId, buttons, [options]) - attach interactive buttons
//   sendNexusHeartbeat(env, [meta], [options])       - heartbeat ping
//
// options:
//   nexusKeyEnvVar     {string} - env var name for the API key (default: inferred below)
//   callbackSecretEnvVar {string} - env var name for button callback_secret
//
// Auth: X-API-Key: <env[nexusKeyEnvVar]> on every request.
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
// =============================================================================

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
 * POST JSON to a Nexus endpoint and return parsed JSON on success.
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
 * Post a markdown message to a Nexus channel by slug.
 * Uses POST /api/bot/messages (the X-API-Key bot endpoint).
 * Content is truncated to 8000 chars defensively.
 *
 * @param {object} env
 * @param {string} slug - Nexus channel slug (e.g. "robert-soc", "soc-approvals")
 * @param {string} content - markdown body
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @returns {Promise<object|null>} Nexus message object with .id, or null on error
 */
export async function postToNexus(env, slug, content, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) {
    console.warn("[nexus] missing API key or NEXUS_BASE_URL, skipping post");
    return null;
  }
  const body = typeof content === "string" ? content.slice(0, 8000) : String(content).slice(0, 8000);
  try {
    const result = await _post(
      `${env.NEXUS_BASE_URL}/api/bot/messages`,
      { channel_slug: slug, body },
      apiKey,
    );
    return result?.data || null;
  } catch (err) {
    console.warn(`[nexus] postToNexus(${slug}) failed:`, err.message);
    return null;
  }
}

/**
 * Attach interactive buttons to a Nexus message.
 * Uses POST /api/messages/:id/buttons.
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
    const result = await _post(
      `${env.NEXUS_BASE_URL}/api/messages/${messageId}/buttons`,
      { buttons: withSecret },
      apiKey,
    );
    return result?.data || null;
  } catch (err) {
    console.warn(`[nexus] attachButtons(${messageId}) failed:`, err.message);
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
