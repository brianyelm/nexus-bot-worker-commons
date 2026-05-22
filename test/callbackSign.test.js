import { test } from "node:test";
import assert from "node:assert/strict";

import { timingSafeEqual, verifyNexusSignature } from "../src/lib/callbackSign.js";

// ─── timingSafeEqual ─────────────────────────────────────────────────────────

test("timingSafeEqual returns true for identical arrays", () => {
  const a = new Uint8Array([1, 2, 3, 4]);
  const b = new Uint8Array([1, 2, 3, 4]);
  assert.equal(timingSafeEqual(a, b), true);
});

test("timingSafeEqual returns false for different content", () => {
  const a = new Uint8Array([1, 2, 3, 4]);
  const b = new Uint8Array([1, 2, 3, 5]);
  assert.equal(timingSafeEqual(a, b), false);
});

test("timingSafeEqual returns false for different lengths", () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([1, 2, 3, 4]);
  assert.equal(timingSafeEqual(a, b), false);
});

test("timingSafeEqual handles empty arrays", () => {
  assert.equal(timingSafeEqual(new Uint8Array([]), new Uint8Array([])), true);
});

// ─── verifyNexusSignature ────────────────────────────────────────────────────

function makeHeaders(ts, sig) {
  return new Headers({
    "X-Nexus-Timestamp": String(ts),
    "X-Nexus-Signature": sig,
  });
}

async function signPayload(secret, ts, body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${body}`));
  return "sha256=" + Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

test("verifies valid signature with fresh timestamp", async () => {
  const secret = "test-secret-key";
  const body = '{"type":"message","text":"hello"}';
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signPayload(secret, ts, body);
  const headers = makeHeaders(ts, sig);

  const result = await verifyNexusSignature(secret, body, headers);
  assert.equal(result, true);
});

test("rejects missing secret", async () => {
  const headers = makeHeaders(Math.floor(Date.now() / 1000), "sha256=abc");
  const result = await verifyNexusSignature("", "body", headers);
  assert.equal(result, false);
});

test("rejects missing timestamp header", async () => {
  const headers = new Headers({ "X-Nexus-Signature": "sha256=abc" });
  const result = await verifyNexusSignature("secret", "body", headers);
  assert.equal(result, false);
});

test("rejects missing signature header", async () => {
  const headers = new Headers({ "X-Nexus-Timestamp": String(Math.floor(Date.now() / 1000)) });
  const result = await verifyNexusSignature("secret", "body", headers);
  assert.equal(result, false);
});

test("rejects stale timestamp outside replay window", async () => {
  const secret = "test-secret";
  const body = "test";
  const staleTs = Math.floor(Date.now() / 1000) - 600;
  const sig = await signPayload(secret, staleTs, body);
  const headers = makeHeaders(staleTs, sig);

  const result = await verifyNexusSignature(secret, body, headers);
  assert.equal(result, false);
});

test("rejects tampered body", async () => {
  const secret = "test-secret";
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signPayload(secret, ts, "original");
  const headers = makeHeaders(ts, sig);

  const result = await verifyNexusSignature(secret, "tampered", headers);
  assert.equal(result, false);
});

test("rejects wrong secret", async () => {
  const body = "test";
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signPayload("correct-secret", ts, body);
  const headers = makeHeaders(ts, sig);

  const result = await verifyNexusSignature("wrong-secret", body, headers);
  assert.equal(result, false);
});

test("respects custom replayWindowSec", async () => {
  const secret = "test-secret";
  const body = "test";
  const ts = Math.floor(Date.now() / 1000) - 10;
  const sig = await signPayload(secret, ts, body);
  const headers = makeHeaders(ts, sig);

  const pass = await verifyNexusSignature(secret, body, headers, { replayWindowSec: 30 });
  assert.equal(pass, true);

  const fail = await verifyNexusSignature(secret, body, headers, { replayWindowSec: 5 });
  assert.equal(fail, false);
});
