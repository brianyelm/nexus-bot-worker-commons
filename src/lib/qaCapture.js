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
import { getProvenanceContext, withProvenance } from "./provenanceContext.js";

const MAX_SUMMARY = 120;
const MAX_DETAIL = 1500;

/**
 * Detect a no-op cron tick result. The dominant noise source in the fleet's
 * QA channels is every-minute reminder-firing crons logging "fired:0, errors:0"
 * 1440 times a day per bot. Suppress these so the daily analyzer sees real
 * signal, not 99% empty ticks. Errors and non-cron surfaces are NEVER skipped.
 *
 * @param {string|undefined} surface
 * @param {boolean} ok
 * @param {string} detail - already-stringified detail field
 * @returns {boolean}
 */
export function isNoopCronResult(surface, ok, detail) {
  if (surface !== "cron") return false;
  if (!ok) return false;
  if (!detail || detail === "null" || detail === "{}" || detail === '""') return true;
  // Match the canonical "{...fired:0...errors:0...}" shape that the router
  // wrappers serialize when a reminder sweep had nothing to do.
  const hasFired = /"fired"\s*:\s*\d+/.test(detail);
  const hasErrors = /"errors"\s*:\s*\d+/.test(detail);
  if (hasFired && hasErrors) {
    const firedNonZero = /"fired"\s*:\s*[1-9]/.test(detail);
    const errorsNonZero = /"errors"\s*:\s*[1-9]/.test(detail);
    return !firedNonZero && !errorsNonZero;
  }
  return false;
}

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
/**
 * Wrap a cron job invocation with QA capture in a single call. Replaces the
 * common pattern
 *
 *   ctx.waitUntil(withProvenance("scheduled-cron", () => runX(env)));
 *
 * with
 *
 *   captureCronRun(env, ctx, { bot: "jacob", name: "runX", run: () => runX(env), cron });
 *
 * Standardizes cron QA across the fleet for bots that have no router.js seam.
 * The no-op skip in captureQa keeps tight every-minute crons from flooding QA.
 *
 * @param {object} env
 * @param {ExecutionContext} ctx
 * @param {object} opts
 * @param {string} opts.bot - bot name (used to derive slug + nexus key var)
 * @param {string} opts.name - cron job name (becomes kind: `cron.${name}`)
 * @param {Function} opts.run - 0-arg async fn that performs the cron work
 * @param {string} [opts.cron] - cron string from event.cron (recorded in meta)
 * @param {string} [opts.provenance="scheduled-cron"] - provenance scope
 * @returns {void}
 */
export function captureCronRun(env, ctx, opts = {}) {
  const { bot, name, run, cron, provenance = "scheduled-cron" } = opts;
  if (typeof run !== "function") {
    console.warn(`[captureCronRun] missing run fn for bot=${bot} name=${name}`);
    return;
  }
  ctx.waitUntil((async () => {
    try {
      const r = await withProvenance(provenance, () => run());
      await captureQa(env, {
        bot,
        kind: `cron.${name}`,
        surface: "cron",
        ok: true,
        summary: `${name} ok`,
        detail: JSON.stringify(r ?? null).slice(0, MAX_DETAIL),
        meta: { cron },
      });
    } catch (err) {
      console.error(`[cron] ${name} failed:`, err?.stack || err);
      await captureQa(env, {
        bot,
        kind: `cron.${name}`,
        surface: "cron",
        ok: false,
        summary: `${name} FAILED`,
        detail: String(err?.message || err).slice(0, MAX_DETAIL),
        meta: { cron },
      });
    }
  })());
}

export async function captureQa(env, fields = {}, options = {}) {
  try {
    if (!env || env.QA_CAPTURE_ENABLED === "false") return;
    const bot = fields.bot;
    if (!bot) {
      console.warn("[captureQa] missing 'bot'; skipping");
      return;
    }
    // Suppress no-op cron ticks (the * * * * * reminder pollers that log
    // "fired:0,errors:0" 1440 times a day per bot). Caller can override with
    // options.forceCapture=true if every tick really matters.
    if (!options.forceCapture) {
      const detailStr = typeof fields.detail === "string"
        ? fields.detail
        : JSON.stringify(fields.detail ?? null);
      if (isNoopCronResult(fields.surface, fields.ok !== false, detailStr)) {
        return;
      }
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
