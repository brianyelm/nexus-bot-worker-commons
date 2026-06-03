import { test } from "node:test";
import assert from "node:assert/strict";

import { memoryHmacHex, buildMemoryAuthHeaders } from "../src/lib/memoryAuth.js";

// Re-implements memory-worker's verify (checkMemoryAuth core) so we prove the
// commons signer and the worker verifier agree on the exact algorithm without
// crossing repos.
async function verify(master, botId, headers, { multi = ["voice-bridge"], skew = 300 } = {}) {
  const caller = headers["X-Memory-Caller"];
  const ts = headers["X-Memory-Timestamp"];
  const sig = headers["X-Memory-Sig"];
  if (!caller || !ts || !sig) return { ok: false, reason: "missing" };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(ts, 10)) > skew) return { ok: false, reason: "stale" };
  if (caller !== botId && !multi.includes(caller)) return { ok: false, reason: "scope" };
  const expectedKey = await memoryHmacHex(master, caller);
  const expectedSig = await memoryHmacHex(expectedKey, `${caller}\n${botId}\n${ts}`);
  return { ok: sig === expectedSig, reason: sig === expectedSig ? undefined : "sig" };
}

const MASTER = "test-master-secret";
const keyFor = (caller) => memoryHmacHex(MASTER, caller);

test("buildMemoryAuthHeaders returns nothing when MEMORY_SIGNING_KEY unset", async () => {
  const h = await buildMemoryAuthHeaders({}, "courtney");
  assert.deepEqual(h, {});
});

test("a bot's signed request verifies against the master-derived key", async () => {
  const env = { MEMORY_SIGNING_KEY: await keyFor("courtney") };
  const headers = await buildMemoryAuthHeaders(env, "courtney");
  assert.equal((await verify(MASTER, "courtney", headers)).ok, true);
});

test("voice-bridge (multi-persona caller) may act as any persona's bot_id", async () => {
  const env = { MEMORY_SIGNING_KEY: await keyFor("voice-bridge"), MEMORY_CALLER_ID: "voice-bridge" };
  const headers = await buildMemoryAuthHeaders(env, "kate");
  assert.equal(headers["X-Memory-Caller"], "voice-bridge");
  assert.equal((await verify(MASTER, "kate", headers)).ok, true);
});

test("a compromised bot CANNOT forge a sibling's bot_id (scope reject)", async () => {
  // dexter holds only dexter's key and signs as caller=dexter (default).
  const env = { MEMORY_SIGNING_KEY: await keyFor("dexter") };
  const headers = await buildMemoryAuthHeaders(env, "dexter");
  // It tries to read courtney's memory by swapping the data-scope bot_id.
  const res = await verify(MASTER, "courtney", headers);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "scope");
});

test("a wrong/guessed signing key fails signature verification", async () => {
  const env = { MEMORY_SIGNING_KEY: "deadbeef-not-the-real-key" };
  const headers = await buildMemoryAuthHeaders(env, "courtney");
  const res = await verify(MASTER, "courtney", headers);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "sig");
});

test("a stale timestamp is rejected", async () => {
  const env = { MEMORY_SIGNING_KEY: await keyFor("courtney") };
  const headers = await buildMemoryAuthHeaders(env, "courtney");
  headers["X-Memory-Timestamp"] = String(Math.floor(Date.now() / 1000) - 4000);
  // sig no longer matches the tampered ts anyway, but the skew check fires first
  assert.equal((await verify(MASTER, "courtney", headers)).ok, false);
});
