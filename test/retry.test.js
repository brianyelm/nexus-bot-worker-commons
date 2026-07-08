// Tests for the fleet retry primitive: withRetry loop behavior and the Anthropic
// error classifier. Pure functions; no live Anthropic call needed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { withRetry, isRetryableAnthropicError } from "../src/lib/retry.js";

// A function that throws `failures` times then resolves to `value`, counting calls.
function flaky(failures, value, errFactory = (n) => new Error(`fail ${n}`)) {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls <= failures) throw errFactory(calls);
    return value;
  };
  return { fn, calls: () => calls };
}

// Zero-delay backoff so tests do not actually wait.
const NO_WAIT = { backoffMs: () => 0 };

test("withRetry returns immediately on first success", async () => {
  const { fn, calls } = flaky(0, "ok");
  const out = await withRetry(fn, { attempts: 3, ...NO_WAIT });
  assert.equal(out, "ok");
  assert.equal(calls(), 1);
});

test("withRetry retries transient failures then succeeds", async () => {
  const { fn, calls } = flaky(2, "recovered");
  const out = await withRetry(fn, { attempts: 3, isRetryable: () => true, ...NO_WAIT });
  assert.equal(out, "recovered");
  assert.equal(calls(), 3);
});

test("withRetry exhausts attempts and throws the last error", async () => {
  const { fn, calls } = flaky(5, "never");
  await assert.rejects(
    withRetry(fn, { attempts: 3, isRetryable: () => true, ...NO_WAIT }),
    /fail 3/,
  );
  assert.equal(calls(), 3);
});

test("withRetry does not retry a non-retryable error", async () => {
  const { fn, calls } = flaky(5, "never");
  await assert.rejects(
    withRetry(fn, { attempts: 3, isRetryable: () => false, ...NO_WAIT }),
    /fail 1/,
  );
  assert.equal(calls(), 1);
});

test("withRetry calls onRetry once per retry with the computed delay", async () => {
  const { fn } = flaky(2, "ok");
  const seen = [];
  await withRetry(fn, {
    attempts: 3,
    backoffMs: [10, 20, 30],
    isRetryable: () => true,
    onRetry: (err, attempt, delay) => seen.push([attempt, delay]),
  });
  assert.deepEqual(seen, [[1, 10], [2, 20]]);
});

test("withRetry: a throwing onRetry never breaks the loop", async () => {
  const { fn } = flaky(1, "ok");
  const out = await withRetry(fn, {
    attempts: 2,
    isRetryable: () => true,
    onRetry: () => { throw new Error("telemetry boom"); },
    ...NO_WAIT,
  });
  assert.equal(out, "ok");
});

test("isRetryableAnthropicError retries 429 (the old shim's bug)", () => {
  assert.equal(isRetryableAnthropicError(new Error("[anthropic] API error 429: rate limited")), true);
});

test("isRetryableAnthropicError retries 5xx (529 overloaded, 503)", () => {
  assert.equal(isRetryableAnthropicError(new Error("[anthropic] API error 529: overloaded")), true);
  assert.equal(isRetryableAnthropicError(new Error("[anthropic] API error 503: unavailable")), true);
  assert.equal(isRetryableAnthropicError(new Error("[anthropic] API error 500: oops")), true);
});

test("isRetryableAnthropicError fails closed on 4xx client errors", () => {
  assert.equal(isRetryableAnthropicError(new Error("[anthropic] API error 400: bad request")), false);
  assert.equal(isRetryableAnthropicError(new Error("[anthropic] API error 401: unauthorized")), false);
  assert.equal(isRetryableAnthropicError(new Error("[anthropic] API error 404: not found")), false);
});

test("isRetryableAnthropicError retries transient network/timeout tells", () => {
  assert.equal(isRetryableAnthropicError(new Error("[anthropic] fetch failed: network error")), true);
  assert.equal(isRetryableAnthropicError(new Error("The operation timed out")), true);
  assert.equal(isRetryableAnthropicError(new Error("socket hang up")), true);
});

test("isRetryableAnthropicError fails closed on unknown shapes and nullish", () => {
  assert.equal(isRetryableAnthropicError(new Error("[anthropic] JSON parse failed: unexpected token")), false);
  assert.equal(isRetryableAnthropicError(new Error("something totally unexpected")), false);
  assert.equal(isRetryableAnthropicError(null), false);
});
