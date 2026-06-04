// Unit tests for src/lib/incomingPayment.js -- the shared AR-vs-AP guard.

import { test } from "node:test";
import assert from "node:assert/strict";

import { looksLikeIncomingPayment } from "../src/lib/incomingPayment.js";

test("flags white-label Biller Genie receipt from hello@blackravenit.com (the 2026-06-04 miss)", () => {
  assert.equal(
    looksLikeIncomingPayment({
      from: "Black Raven <hello@blackravenit.com>",
      subject: "Receipt for Transaction #9879855",
      body: "Arizona Integrative Medical -- payment receipt",
    }),
    true,
  );
});

test("flags a forwarded receipt that keeps 'Original From: hello@blackravenit.com' in the body", () => {
  assert.equal(
    looksLikeIncomingPayment({
      from: "owner@blackravenit.com",
      subject: "Fwd: Receipt for Transaction #9879855 [vendor bill -- Arizona Integrative Medical]",
      text: "Auto-forwarded by Wren. Original From: hello@blackravenit.com ...",
    }),
    true,
  );
});

test("flags literal Biller Genie mention", () => {
  assert.equal(looksLikeIncomingPayment({ from: "noreply@billergenie.com", subject: "Payment" }), true);
});

test("flags clear money-in language", () => {
  assert.equal(looksLikeIncomingPayment({ subject: "A payout has been deposited to your account" }), true);
  assert.equal(looksLikeIncomingPayment({ body: "Customer payment received for invoice INV-0042" }), true);
});

test("does NOT flag a real external vendor paid-receipt (auto-pay flow must still book it)", () => {
  assert.equal(
    looksLikeIncomingPayment({
      from: "billing@ninjaone.com",
      subject: "Your payment was received",
      body: "Thank you for your payment. Your card was charged $1,350.00.",
    }),
    false,
  );
});

test("does NOT flag an ordinary vendor invoice", () => {
  assert.equal(
    looksLikeIncomingPayment({
      from: "ar@stellarcyber.com",
      subject: "Invoice 3023-2",
      body: "Amount due $4,772.51. Net 30.",
    }),
    false,
  );
});

test("handles empty input", () => {
  assert.equal(looksLikeIncomingPayment(), false);
  assert.equal(looksLikeIncomingPayment({}), false);
});
