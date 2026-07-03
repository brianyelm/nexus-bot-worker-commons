// =============================================================================
// lib/logger.js - Thin leveled logger for the Nexus bot fleet.
//
// Why this exists: the house rule bans bare `console.log` in product code, but
// the fleet still needs diagnostics. A structured, leveled logger gives one
// primitive that satisfies both: `error`/`warn` always emit; `info`/`debug` are
// suppressed in production so they never become the noise the ban targets. The
// `check-console-log` guard can then fail any raw `console.log` while allowing
// `log.debug(...)`.
//
// Usage:
//   import { createLogger } from "nexus-bot-worker-commons";
//   const log = createLogger("BotVoicePeer", env);
//   log.debug("ingest connected", { rtSid });   // silent unless LOG_LEVEL=debug
//   log.warn("greeting overflow", { droppedBytes });
//   log.error("adapter reinit failed", { err: err.message });
//
// Level gating: env.LOG_LEVEL (error < warn < info < debug), default "info".
// Set LOG_LEVEL=debug in a wrangler [vars] block to light up debug lines for a
// worker without a code change.
//
// This module is dependency-free and never throws: a logging call must never be
// the thing that breaks a request path.
// =============================================================================

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_LEVEL = "info";

/**
 * Resolve the active numeric threshold from env.LOG_LEVEL.
 * @param {object} [env]
 * @returns {number}
 */
function resolveThreshold(env) {
  const raw = (env && typeof env.LOG_LEVEL === "string" ? env.LOG_LEVEL : DEFAULT_LEVEL)
    .toLowerCase()
    .trim();
  return LEVELS[raw] ?? LEVELS[DEFAULT_LEVEL];
}

/**
 * Format one line: "[scope] message {json-context}". Context is best-effort
 * serialized and never allowed to throw.
 * @param {string} scope
 * @param {string} message
 * @param {*} [ctx]
 * @returns {string}
 */
function formatLine(scope, message, ctx) {
  let suffix = "";
  if (ctx !== undefined && ctx !== null) {
    try {
      suffix = " " + (typeof ctx === "string" ? ctx : JSON.stringify(ctx));
    } catch {
      suffix = " [unserializable ctx]";
    }
  }
  return `[${scope}] ${message}${suffix}`;
}

/**
 * Create a scoped logger. Cheap enough to create per-request or per-DO.
 *
 * @param {string} scope - short subsystem tag, e.g. "BotVoicePeer".
 * @param {object} [env] - worker env; reads LOG_LEVEL for gating.
 * @returns {{ error: Function, warn: Function, info: Function, debug: Function, child: Function }}
 */
export function createLogger(scope, env) {
  const threshold = resolveThreshold(env);
  const tag = String(scope || "app");

  const emit = (levelName, sink, message, ctx) => {
    if (LEVELS[levelName] > threshold) return;
    try {
      sink(formatLine(tag, message, ctx));
    } catch {
      /* logging must never throw into the caller */
    }
  };

  return {
    error: (message, ctx) => emit("error", console.error, message, ctx),
    warn: (message, ctx) => emit("warn", console.warn, message, ctx),
    info: (message, ctx) => emit("info", console.info, message, ctx),
    // debug intentionally routes to console.info (not console.log) so the
    // console-log guard stays a hard ban with no exceptions.
    debug: (message, ctx) => emit("debug", console.info, message, ctx),
    /** Derive a nested scope, e.g. log.child("ingest"). */
    child: (sub) => createLogger(`${tag}:${sub}`, env),
  };
}
