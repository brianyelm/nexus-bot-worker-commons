// =============================================================================
// lib/qaCapture.js -- cheap, LLM-free QA capture.
//
// Mirrors a compact, machine-parseable work-product entry to a bot's
// <bot>-qa Nexus channel so the daily fleet-healer batch review can analyze it.
// There is NO Anthropic call here -- this is a plain postToNexus wrapper. It is
// best-effort: a capture failure must NEVER affect the bot's real work, so the
// whole body is wrapped in try/catch and only ever logs a warning.
//
// Entry format (v1): a human-readable header line + a fenced ```qa block
// holding ONE line of JSON the reviewer parses deterministically. The schema
// version (v) lets the format evolve without breaking older rows.
//
// Provenance note: Nexus validates provenance against a strict allowlist
// (nexus-app lib/provenance.js). "qa-capture" is NOT in it and would 400, so we
// inherit the ambient provenance scope (mention-reply / scheduled-cron / etc.,
// which capture always fires inside) and fall back to the valid "system-alert".
// =============================================================================

import { postToNexus } from "./nexus.js";
import { getProvenanceContext } from "./provenanceContext.js";

const MAX_SUMMARY = 120;
const MAX_DETAIL = 1500;

/**
 * Build the QA channel entry (header + fenced JSON tail). Pure + testable.
 *
 * @param {object} fields - { bot, kind, summary, detail, meta?, surface?, ok?, ts? }
 * @returns {string}
 */
export function buildQaEntry(fields = {}) {
  const detailRaw = typeof fields.detail === "string"
    ? fields.detail
    : JSON.stringify(fields.detail ?? null);
  const entry = {
    v: 1,
    bot: fields.bot || "unknown",
    kind: fields.kind || "unknown",
    ts: fields.ts || new Date().toISOString(),
    surface: fields.surface || "chat",
    ok: fields.ok !== false,
    summary: String(fields.summary ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY),
    detail: detailRaw.slice(0, MAX_DETAIL),
    meta: (fields.meta && typeof fields.meta === "object") ? fields.meta : {},
  };
  const header = `QA \`${entry.kind}\` | ${entry.summary || "(no summary)"}`;
  return `${header}\n\`\`\`qa\n${JSON.stringify(entry)}\n\`\`\``;
}

/**
 * Mirror a work-product entry to the bot's QA channel. No LLM. Never throws.
 *
 * @param {object} env
 * @param {object} fields - { bot, kind, channelSlug?, summary, detail, meta?, surface?, ok?, ts? }
 * @param {object} [options] - passthrough to postToNexus (nexusKeyEnvVar, provenance, ...)
 * @returns {Promise<void>}
 */
export async function captureQa(env, fields = {}, options = {}) {
  try {
    if (!env || env.QA_CAPTURE_ENABLED === "false") return;
    const bot = fields.bot;
    if (!bot) {
      console.warn("[captureQa] missing 'bot'; skipping");
      return;
    }
    const slug = fields.channelSlug || `${bot}-qa`;
    const body = buildQaEntry(fields);
    const postOpts = { ...options };
    postOpts.provenance = options.provenance ?? getProvenanceContext() ?? "system-alert";
    if (!postOpts.nexusKeyEnvVar) {
      postOpts.nexusKeyEnvVar = `${String(bot).toUpperCase()}_NEXUS_KEY`;
    }
    await postToNexus(env, slug, body, postOpts);
  } catch (err) {
    console.warn(`[captureQa] non-fatal: ${err?.message || err}`);
  }
}
