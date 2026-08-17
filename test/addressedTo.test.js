// The 2026-08-17 payroll thread: Brian asked Payroll Plus Global a question with
// four people on the message, and Maxwell answered as though he had been asked.
// These pin the gate that keeps a bot out of conversations between humans.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAddressedDirectly } from "../src/lib/addressedTo.js";

const MAX = "maxwell.raven@blackravenit.com";

function to(...addresses) {
  return addresses.map((address) => ({ emailAddress: { address } }));
}

test("replies when the bot is the only recipient and nobody is copied", () => {
  const r = isAddressedDirectly({ toRecipients: to(MAX), ccRecipients: [] }, MAX);
  assert.equal(r.direct, true);
  assert.equal(r.reason, "sole-recipient");
});

test("stays out of the real payroll thread that caused this", () => {
  const r = isAddressedDirectly({
    subject: "Re: Payroll Reminder for 8.14.2026",
    toRecipients: to("cali@payrollplusglobal.com", "teri@payrollplusglobal.com", MAX),
    ccRecipients: to("ashley.thompson@payrollplusglobal.com"),
  }, MAX);
  assert.equal(r.direct, false);
  assert.match(r.reason, /^group-thread-3-to$/);
});

test("stays out when addressed alone but someone else is copied", () => {
  const r = isAddressedDirectly({
    toRecipients: to(MAX),
    ccRecipients: to("someone@else.com"),
  }, MAX);
  assert.equal(r.direct, false);
  assert.equal(r.reason, "group-thread-1-cc");
});

test("still replies when the bot itself is the only address copied", () => {
  const r = isAddressedDirectly({ toRecipients: to(MAX), ccRecipients: to(MAX) }, MAX);
  assert.equal(r.direct, true);
});

test("does not reply when merely copied and not a To recipient", () => {
  const r = isAddressedDirectly({
    toRecipients: to("someone@else.com"),
    ccRecipients: to(MAX),
  }, MAX);
  assert.equal(r.direct, false);
  assert.equal(r.reason, "not-a-to-recipient");
});

test("does not reply to a forward even when solely addressed", () => {
  for (const subject of ["Fw: invoice", "FWD: invoice", "  fwd: invoice"]) {
    const r = isAddressedDirectly({ subject, toRecipients: to(MAX), ccRecipients: [] }, MAX);
    assert.equal(r.direct, false, subject);
    assert.equal(r.reason, "forward");
  }
});

test("a subject merely containing fwd later on is not a forward", () => {
  const r = isAddressedDirectly({
    subject: "Please fwd: the statement",
    toRecipients: to(MAX),
    ccRecipients: [],
  }, MAX);
  assert.equal(r.direct, true);
});

test("matches the address case-insensitively", () => {
  const r = isAddressedDirectly({ toRecipients: to("Maxwell.Raven@BlackRavenIT.com") }, MAX);
  assert.equal(r.direct, true);
});

test("fails open when Graph never returned recipient data", () => {
  const r = isAddressedDirectly({ subject: "hi" }, MAX);
  assert.equal(r.direct, true);
  assert.equal(r.reason, "recipients-unavailable");
});

test("an empty To array is a real answer, not missing data", () => {
  const r = isAddressedDirectly({ toRecipients: [], ccRecipients: [] }, MAX);
  assert.equal(r.direct, false);
  assert.equal(r.reason, "not-a-to-recipient");
});

test("fails open when the caller supplies no self address", () => {
  assert.equal(isAddressedDirectly({ toRecipients: to("x@y.com") }, "").direct, true);
});

test("ignores recipient entries carrying no address", () => {
  const r = isAddressedDirectly({
    toRecipients: [{ emailAddress: { name: "Ghost" } }, { emailAddress: { address: MAX } }],
    ccRecipients: [],
  }, MAX);
  assert.equal(r.direct, true);
});
