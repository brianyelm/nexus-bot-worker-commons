import { test } from "node:test";
import assert from "node:assert/strict";

import { isAutomaticReply } from "../src/lib/mailSafety.js";

// Concur invoice-capture ack looped Maxwell into replying to a no-reply bot
// (2026-06-25): the "Auto Reply" label is mid-subject (not anchored) and the
// sender is on concursolutions.com, so the old anchored rules both missed it.
test("Concur invoice-capture ack is detected as automatic (mid-subject phrase)", () => {
  const r = isAutomaticReply({
    subject: "Concur Auto Reply Invoice INV-0419 - Black Raven IT",
    from: "AutoNotification@concursolutions.com",
  });
  assert.equal(r.isAuto, true);
});

test("concursolutions.com sender alone is treated as automatic", () => {
  const r = isAutomaticReply({ subject: "Submission received", from: "irem_invoicecapture@concursolutions.com" });
  assert.equal(r.isAuto, true);
  assert.match(r.reason, /auto-domain/);
});

test("invoice-capture local part is treated as automatic on any domain", () => {
  const r = isAutomaticReply({ subject: "Received", from: "invoicecapture@vendor.example" });
  assert.equal(r.isAuto, true);
});

test("classic anchored auto-reply subject still detected", () => {
  assert.equal(isAutomaticReply({ subject: "Automatic reply: Out of office" }).isAuto, true);
  assert.equal(isAutomaticReply({ subject: "Re: Automatic reply" }).isAuto, true);
});

test("a normal human invoice question is NOT suppressed", () => {
  const r = isAutomaticReply({
    subject: "Re: Invoice INV-0419 - question about the BCDR line",
    from: "ap.clerk@institute-example.org",
  });
  assert.equal(r.isAuto, false);
});
