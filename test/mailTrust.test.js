import { test } from "node:test";
import assert from "node:assert/strict";

import { senderTrust } from "../src/lib/mailTrust.js";

// Helper: build a Graph message with the given internet message headers.
function msg(headers) {
  return { internetMessageHeaders: headers };
}
const ar = (value) => ({ name: "Authentication-Results", value });
const authAs = (value) => ({ name: "X-MS-Exchange-Organization-AuthAs", value });

// ─── trusted paths ───────────────────────────────────────────────────────────

test("trusts external mail when DMARC passes", () => {
  const r = senderTrust(msg([ar("spf=pass; dkim=pass; dmarc=pass action=none")]));
  assert.equal(r.dmarc, "pass");
  assert.equal(r.trusted, true);
});

test("trusts intra-org mail stamped AuthAs=Internal even when dmarc=none", () => {
  // Intra-tenant mail legitimately reports dmarc=none; EOP strips AuthAs from
  // external mail, so Internal is an unforgeable internal-sender signal.
  const r = senderTrust(msg([ar("dmarc=none"), authAs("Internal")]));
  assert.equal(r.dmarc, "none");
  assert.equal(r.authAs, "internal");
  assert.equal(r.trusted, true);
});

test("accepts a raw headers array as well as a message object", () => {
  const r = senderTrust([ar("dmarc=pass")]);
  assert.equal(r.trusted, true);
});

// ─── untrusted paths (the spoofing-defense cases) ────────────────────────────

test("rejects a spoofed internal-domain sender that fails DMARC", () => {
  // From: someone@blackravenit.com but dmarc=fail and NO AuthAs:Internal —
  // exactly what an external spoofer of an internal address looks like.
  const r = senderTrust(msg([ar("spf=fail; dmarc=fail action=oreject")]));
  assert.equal(r.dmarc, "fail");
  assert.equal(r.authAs, "");
  assert.equal(r.trusted, false);
});

test("rejects dmarc=none without AuthAs (external, unauthenticated)", () => {
  const r = senderTrust(msg([ar("dmarc=none")]));
  assert.equal(r.trusted, false);
});

test("rejects when there are no authentication headers at all", () => {
  const r = senderTrust(msg([]));
  assert.equal(r.dmarc, "unknown");
  assert.equal(r.trusted, false);
});

test("does not treat a forged AuthAs value other than Internal as trusted", () => {
  const r = senderTrust(msg([ar("dmarc=fail"), authAs("Anonymous")]));
  assert.equal(r.trusted, false);
});

test("handles missing/empty input without throwing", () => {
  assert.equal(senderTrust(undefined).trusted, false);
  assert.equal(senderTrust(null).trusted, false);
  assert.equal(senderTrust({}).trusted, false);
});
