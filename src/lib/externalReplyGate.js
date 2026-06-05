// =============================================================================
// lib/externalReplyGate.js -- Shared "external mail gets a HITL draft" gate.
//
// Brian 2026-06-05: every email to every bot should surface a HITL draft so no
// inbox needs manual checking. Bots whose mail pollers auto-reply to internal
// staff but SILENTLY DROP external mail (Dexter, Robert, Maxwell) use this to
// turn each external message into a "Approve & Send" card in the bot's HITL
// channel instead. Internal auto-replies are unchanged.
//
// Storage is KV (every bot has a CACHE binding) keyed by the Nexus card id, so
// there is no per-bot D1 migration. The card shows the full inbound + drafted
// reply + recipients; Approve & Send / Reject buttons reuse each bot's existing
// /api/internal/button-click dispatcher. Nothing sends until Approve is clicked.
// =============================================================================

import { postToNexus, attachButtons, editNexusMessage } from "./nexus.js";
import { buildReport } from "./embedCard.js";

const TTL_SECONDS = 7 * 24 * 60 * 60;

function clamp(v, n) { const s = String(v ?? ""); return s.length <= n ? s : s.slice(0, n - 3) + "..."; }

/**
 * Stage an external inbound email as a HITL reply card.
 *
 * @param {object} env
 * @param {object} opts
 * @param {string} opts.botName            display name (e.g. "Dexter")
 * @param {string} opts.nexusKeyEnvVar     outbound Nexus key env var
 * @param {string} opts.callbackSecretEnvVar
 * @param {string} opts.hitlChannel        slug (e.g. "dexter-hitl")
 * @param {string} opts.workerBaseUrl      absolute base for the button callback_url
 * @param {string} [opts.buttonPrefix="extmail"]   button id prefix (approve/reject)
 * @param {string} [opts.kvPrefix="extreply:"]     KV key prefix for pending payloads
 * @param {object} opts.inbound  { emailId, from, fromName, to, cc, subject, received, preview }
 * @param {string} opts.draftHtml  drafted reply body (HTML)
 * @param {string} opts.draftText  drafted reply as plain text (for the card preview)
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
export async function stageExternalReply(env, opts) {
  if (!env.CACHE) return { success: false, error: "CACHE (KV) binding missing" };
  const buttonPrefix = opts.buttonPrefix || "extmail";
  const kvPrefix = opts.kvPrefix || "extreply:";
  const inb = opts.inbound || {};
  const cc = Array.isArray(inb.cc) ? inb.cc : (inb.cc ? [inb.cc] : []);

  const card = buildReport({
    botName: opts.botName,
    emoji: "📨",
    title: "External Email -- Reply Draft",
    subtitle: "Awaiting approval -- nothing sent until you Approve & Send",
    sections: [
      {
        emoji: "📧",
        title: "Inbound",
        lines: [
          `- **From:** ${clamp(`${inb.fromName ? `${inb.fromName} ` : ""}<${inb.from || "unknown"}>`, 200)}`,
          `- **Subject:** ${clamp(inb.subject || "(no subject)", 200)}`,
          `- **Received:** ${clamp(inb.received || "(unknown)", 60)}`,
          inb.preview ? `- **Preview:** ${clamp(inb.preview, 600)}` : null,
        ].filter(Boolean).join("\n"),
      },
      {
        emoji: "↩️",
        title: "Draft reply",
        lines: [
          `- **To:** ${clamp(inb.from || "(unknown)", 200)}`,
          `- **CC:** ${clamp(cc.length ? cc.join(", ") : "(none)", 300)}`,
          "",
          clamp(opts.draftText || "(empty)", 1500),
        ].join("\n"),
      },
    ],
  });

  const nexusOpts = { nexusKeyEnvVar: opts.nexusKeyEnvVar, callbackSecretEnvVar: opts.callbackSecretEnvVar };
  let msg;
  try {
    msg = await postToNexus(env, opts.hitlChannel, card, { nexusKeyEnvVar: opts.nexusKeyEnvVar });
  } catch (err) {
    return { success: false, error: `postToNexus failed: ${err.message}` };
  }
  const messageId = msg?.id;
  if (!messageId) return { success: false, error: "no message id from Nexus" };

  const payload = {
    emailId: inb.emailId,
    from: inb.from,
    to: inb.from,
    cc,
    subject: inb.subject,
    draftHtml: opts.draftHtml || "",
    staged_at: new Date().toISOString(),
  };
  try {
    await env.CACHE.put(`${kvPrefix}${messageId}`, JSON.stringify(payload), { expirationTtl: TTL_SECONDS });
  } catch (err) {
    return { success: false, error: `KV put failed: ${err.message}`, messageId };
  }

  const callbackUrl = `${opts.workerBaseUrl || ""}/api/internal/button-click`;
  await attachButtons(env, messageId, [
    { button_id: `${buttonPrefix}_approve:${messageId}`, label: "Approve & Send", style: "primary", callback_url: callbackUrl },
    { button_id: `${buttonPrefix}_reject:${messageId}`,  label: "Reject",         style: "danger",  callback_url: callbackUrl },
  ], nexusOpts).catch(err => console.warn(`[externalReplyGate] attachButtons failed: ${err.message}`));

  return { success: true, messageId };
}

/**
 * Handle an Approve & Send / Reject click for an external-reply card. Routes by
 * button prefix, loads the KV payload, and on approve invokes the bot-provided
 * sendReply(env, payload) (which performs the actual Graph reply). Idempotent:
 * the KV row is deleted on first action so a double click cannot double-send.
 *
 * @param {object} env
 * @param {object} payload   normalized button-click payload (button_id, message_id, display_name)
 * @param {object} opts
 * @param {string} opts.nexusKeyEnvVar
 * @param {string} [opts.buttonPrefix="extmail"]
 * @param {string} [opts.kvPrefix="extreply:"]
 * @param {(env: object, pending: object) => Promise<void>} opts.sendReply
 * @returns {Promise<{ handled: boolean, action?: string }>}
 */
export async function handleExternalReplyGate(env, payload, opts) {
  const buttonId = String(payload?.button_id || "");
  const messageId = String(payload?.message_id || "");
  const actor = (typeof payload?.display_name === "string" && payload.display_name.trim()) ? payload.display_name.trim() : "someone";
  const buttonPrefix = opts.buttonPrefix || "extmail";
  const kvPrefix = opts.kvPrefix || "extreply:";
  const editOpts = { nexusKeyEnvVar: opts.nexusKeyEnvVar };

  if (!buttonId.startsWith(`${buttonPrefix}_`)) return { handled: false };
  if (!env.CACHE || !messageId) return { handled: false };

  const key = `${kvPrefix}${messageId}`;
  const raw = await env.CACHE.get(key);
  if (!raw) {
    await editNexusMessage(env, messageId, "**This email draft was already actioned.**", editOpts).catch(() => {});
    return { handled: true, action: "already" };
  }
  // Claim: delete first so a concurrent click loses the race.
  await env.CACHE.delete(key).catch(() => {});
  let pending;
  try { pending = JSON.parse(raw); } catch { pending = null; }

  if (buttonId.startsWith(`${buttonPrefix}_reject:`)) {
    await editNexusMessage(env, messageId, `**Rejected by ${actor}.** Nothing was sent.`, editOpts).catch(() => {});
    return { handled: true, action: "rejected" };
  }

  if (buttonId.startsWith(`${buttonPrefix}_approve:`)) {
    if (!pending) {
      await editNexusMessage(env, messageId, "**Draft payload was unreadable; nothing sent.**", editOpts).catch(() => {});
      return { handled: true, action: "error" };
    }
    try {
      await opts.sendReply(env, pending);
    } catch (err) {
      // Re-stage so the reviewer can retry.
      await env.CACHE.put(key, raw, { expirationTtl: TTL_SECONDS }).catch(() => {});
      await editNexusMessage(env, messageId, `**Send failed:** ${clamp(err.message, 200)}. Card left for retry.`, editOpts).catch(() => {});
      return { handled: true, action: "failed" };
    }
    const ccLine = Array.isArray(pending.cc) && pending.cc.length ? `  CC: ${pending.cc.join(", ")}` : "";
    await editNexusMessage(env, messageId, `**Sent by ${actor}.** To: ${pending.to}${ccLine}`, editOpts).catch(() => {});
    return { handled: true, action: "sent" };
  }

  return { handled: false };
}
