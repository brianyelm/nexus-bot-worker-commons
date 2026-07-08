// =============================================================================
// lib/retry.js: fleet-shared retry-with-backoff primitive.
//
// Why this exists: the raw Anthropic helpers in lib/anthropic.js had NO retry,
// so a single transient blip (429 rate limit, 529 overloaded, 503, a dropped
// socket) killed any bot's LLM call outright. maxwell-worker hand-rolled its own
// wrapper (lib/anthropic-retry.js) that also mis-classified 429 as non-retryable.
// This module is the one shared implementation: withRetry is provider-agnostic,
// isRetryableAnthropicError is the single source of truth for "is this Anthropic
// error worth another attempt".
//
// Design rules:
//   - Fail CLOSED on unknown errors: an unrecognised failure is NOT retried, so a
//     genuine bug (bad request, auth) surfaces immediately instead of looping.
//   - Bounded attempts + bounded backoff array: no unbounded retry storm.
//   - onRetry is best-effort telemetry only; a throwing hook never breaks the loop.
// =============================================================================

// Default backoff schedule: delay BEFORE attempt N+1. Index 0 = before the 2nd
// attempt, index 1 = before the 3rd, etc. With attempts=3 this is 1s then 5s.
const DEFAULT_BACKOFF_MS = [1_000, 5_000, 15_000];

/** Sleep helper (runtime-only; never called at module scope). */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the delay before the next attempt from a backoff spec.
 * @param {number[]|((attempt: number) => number)} backoffMs - array of delays or fn(attempt)
 * @param {number} attempt - the attempt that just failed (1-based)
 * @returns {number} milliseconds to wait
 */
function resolveBackoff(backoffMs, attempt) {
  if (typeof backoffMs === "function") return Math.max(0, Number(backoffMs(attempt)) || 0);
  const arr = Array.isArray(backoffMs) && backoffMs.length ? backoffMs : DEFAULT_BACKOFF_MS;
  return arr[attempt - 1] ?? arr[arr.length - 1];
}

/**
 * Run an async function with retry-and-backoff on transient failure.
 *
 * @template T
 * @param {() => Promise<T>} fn - the operation to attempt
 * @param {object} [opts]
 * @param {number} [opts.attempts=3] - total tries (not extra retries)
 * @param {number[]|((attempt: number) => number)} [opts.backoffMs] - delay before each retry
 * @param {(err: Error, attempt: number) => boolean} [opts.isRetryable] - retry predicate; default retries all
 * @param {(err: Error, attempt: number, delayMs: number) => void} [opts.onRetry] - best-effort telemetry hook
 * @returns {Promise<T>}
 */
export async function withRetry(fn, {
  attempts = 3,
  backoffMs = DEFAULT_BACKOFF_MS,
  isRetryable = () => true,
  onRetry,
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isRetryable(err, attempt)) throw err;
      const delay = resolveBackoff(backoffMs, attempt);
      if (typeof onRetry === "function") {
        try { onRetry(err, attempt, delay); } catch { /* telemetry must never break the loop */ }
      }
      await sleep(delay);
    }
  }
  // Unreachable in practice (the loop either returns or throws), but keeps the
  // function total for a zero/negative attempts arg.
  throw lastErr || new Error("[retry] withRetry called with no attempts");
}

// Extracts the HTTP status the Anthropic wrapper embeds in its thrown messages,
// which are shaped "[anthropic] API error <status>: ...".
const ANTHROPIC_STATUS_RE = /API error (\d{3})/;
// Transient network/timeout tells surfaced by the fetch wrapper and the runtime.
const TRANSIENT_MSG_RE =
  /fetch failed|network|socket|timed out|timeout|aborted|ETIMEDOUT|ECONNRESET|overloaded|unavailable|service temporarily/i;

/**
 * Decide whether an error thrown by lib/anthropic.js is worth retrying.
 * Retry on 429 (rate limit) and any 5xx (500/503/529 overloaded), and on
 * transient network/timeout errors. Everything else, including other 4xx
 * (400 bad request, 401 auth, 404), fails CLOSED (not retried).
 *
 * This is the single fleet source of truth; it fixes the old maxwell shim bug
 * where 429 matched a "4xx = non-retryable" branch and was never retried.
 *
 * @param {Error} err
 * @returns {boolean}
 */
export function isRetryableAnthropicError(err) {
  if (!err) return false;
  const msg = String(err.message || "");
  const m = msg.match(ANTHROPIC_STATUS_RE);
  if (m) {
    const status = Number(m[1]);
    if (status === 429) return true;      // rate limited: back off and retry
    if (status >= 500) return true;       // 5xx incl. 529 overloaded / 503 unavailable
    return false;                          // other 4xx: caller bug, fail fast
  }
  if (TRANSIENT_MSG_RE.test(msg)) return true;
  return false;                            // unknown shape: fail closed, no storm
}
