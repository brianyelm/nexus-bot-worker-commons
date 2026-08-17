// Bots used to tell Brian they had "no visibility into recipient lists" because
// every mail formatter in the fleet handed the model a subject and a body and
// nothing else. These pin the envelope that fixes that, including the Bcc
// caveat, which exists so a model never reports an incomplete To/Cc list as the
// complete distribution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEmailHeader, renderEmailForPrompt } from "../src/lib/emailHeader.js";

function recipient(name, address) {
  return { emailAddress: { name, address } };
}

// The real 2026-08-17 payroll thread that exposed the gap.
const PAYROLL_MSG = {
  from: recipient("Black Raven", "owner@blackravenit.com"),
  toRecipients: [
    recipient("Teri Shoemaker", "teri@payrollplusglobal.com"),
    recipient("Cali Chodrick", "cali@payrollplusglobal.com"),
    recipient("Maxwell Raven", "maxwell.raven@blackravenit.com"),
  ],
  ccRecipients: [recipient("Ashley Thompson", "ashley.thompson@payrollplusglobal.com")],
  receivedDateTime: "2026-08-15T19:34:29Z",
  subject: "Re: Payroll Reminder for 8.14.2026",
};

test("renders From, To and Cc from a real thread", () => {
  const out = renderEmailHeader(PAYROLL_MSG);
  assert.match(out, /^From: Black Raven <owner@blackravenit\.com>$/m);
  assert.match(out, /^To: Teri Shoemaker <teri@payrollplusglobal\.com>, Cali Chodrick <cali@payrollplusglobal\.com>, Maxwell Raven <maxwell\.raven@blackravenit\.com>$/m);
  assert.match(out, /^Cc: Ashley Thompson <ashley\.thompson@payrollplusglobal\.com>$/m);
  assert.match(out, /^Subject: Re: Payroll Reminder for 8\.14\.2026$/m);
});

test("warns that Bcc is invisible whenever a recipient list is shown", () => {
  assert.match(renderEmailHeader(PAYROLL_MSG), /Bcc recipients are not visible/);
});

test("omits the Bcc caveat when there is no recipient list to qualify", () => {
  const out = renderEmailHeader({ from: recipient("A", "a@x.com"), subject: "Hi" });
  assert.doesNotMatch(out, /Bcc/);
});

test("collapses a name that merely repeats the address", () => {
  const out = renderEmailHeader({ toRecipients: [recipient("a@x.com", "a@x.com")] });
  assert.match(out, /^To: a@x\.com$/m);
});

test("falls back to the address when no display name is present", () => {
  const out = renderEmailHeader({ toRecipients: [{ emailAddress: { address: "a@x.com" } }] });
  assert.match(out, /^To: a@x\.com$/m);
});

test("skips recipients that carry no address at all", () => {
  const out = renderEmailHeader({
    toRecipients: [{ emailAddress: { name: "Ghost" } }, recipient(null, "real@x.com")],
  });
  assert.match(out, /^To: real@x\.com$/m);
  assert.doesNotMatch(out, /Ghost/);
});

test("counts the overflow instead of dropping it on a large distribution", () => {
  const many = Array.from({ length: 20 }, (_, i) => recipient(null, `u${i}@x.com`));
  const out = renderEmailHeader({ toRecipients: many });
  assert.match(out, /and 5 more$/m);
  assert.match(out, /u14@x\.com/);
  assert.doesNotMatch(out, /u15@x\.com/);
});

test("falls back to sender when from is absent", () => {
  const out = renderEmailHeader({ sender: recipient("S", "s@x.com") });
  assert.match(out, /^From: S <s@x\.com>$/m);
});

test("emits Reply-To when Graph supplies one", () => {
  const out = renderEmailHeader({ replyTo: [recipient(null, "noreply@x.com")] });
  assert.match(out, /^Reply-To: noreply@x\.com$/m);
});

test("honours includeSubject and includeDate opt-outs", () => {
  const out = renderEmailHeader(PAYROLL_MSG, { includeSubject: false, includeDate: false });
  assert.doesNotMatch(out, /^Subject:/m);
  assert.doesNotMatch(out, /^Date:/m);
  assert.match(out, /^From:/m);
});

test("returns an empty string for an envelope-less or invalid message", () => {
  assert.equal(renderEmailHeader({}), "");
  assert.equal(renderEmailHeader(null), "");
  assert.equal(renderEmailHeader("nope"), "");
});

test("renderEmailForPrompt puts the envelope above the body", () => {
  const out = renderEmailForPrompt(PAYROLL_MSG, "Can you please add my accountant?");
  assert.match(out, /^From: Black Raven/);
  assert.match(out, /\n\nCan you please add my accountant\?$/);
});

test("renderEmailForPrompt degrades to the body alone with no envelope", () => {
  assert.equal(renderEmailForPrompt({}, "just the body"), "just the body");
  assert.equal(renderEmailForPrompt({}, undefined), "");
});
