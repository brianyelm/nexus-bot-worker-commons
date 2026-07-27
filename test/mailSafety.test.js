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

// Robert drafted HITL replies to DMARC rua report robots (2026-07-23): Google's
// sender has a suffix after "noreply" and Microsoft's has no no-reply marker at
// all, so both slipped the old sender regex. The RFC 7489 subject shape and the
// suffix-tolerant sender rule must each catch them independently.
test("Google DMARC rua sender (noreply with suffix) is automatic", () => {
  const r = isAutomaticReply({
    subject: "Report domain: 1stamericaninsurance.com Submitter: google.com Report-ID: 123",
    from: "noreply-dmarc-support@google.com",
  });
  assert.equal(r.isAuto, true);
  assert.match(r.reason, /sender=/);
});

test("Microsoft DMARC rua report is automatic via subject shape", () => {
  const r = isAutomaticReply({
    subject: "[Preview] Report Domain: 1stamericaninsurance.com Submitter: enterprise.protection.outlook.com Report-ID: abc",
    from: "dmarcreport@microsoft.com",
  });
  assert.equal(r.isAuto, true);
  assert.match(r.reason, /dmarc-report/);
});

test("web.de DMARC rua sender (noreply-dmarc@) is automatic", () => {
  const r = isAutomaticReply({ subject: "Report Domain: example.com Submitter: web.de Report-ID: x", from: "noreply-dmarc@sicher.web.de" });
  assert.equal(r.isAuto, true);
});

test("dmarcreport@ local part is automatic even without the subject", () => {
  const r = isAutomaticReply({ subject: "hello", from: "dmarcreport@microsoft.com" });
  assert.equal(r.isAuto, true);
});

test("a human mentioning a report domain mid-subject is NOT suppressed", () => {
  const r = isAutomaticReply({
    subject: "Question about the report domain settings on our site",
    from: "steven@1stamericaninsurance.com",
  });
  assert.equal(r.isAuto, false);
});

test("a normal human invoice question is NOT suppressed", () => {
  const r = isAutomaticReply({
    subject: "Re: Invoice INV-0419 - question about the BCDR line",
    from: "ap.clerk@institute-example.org",
  });
  assert.equal(r.isAuto, false);
});
