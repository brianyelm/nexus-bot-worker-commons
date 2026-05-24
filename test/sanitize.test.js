// Unit tests for src/lib/sanitize.js + the mimeEmail wiring.

import { test } from "node:test";
import assert from "node:assert/strict";

import { scrubFleetDashes } from "../src/lib/sanitize.js";
import { buildMimeMessage } from "../src/lib/mimeEmail.js";

test("scrubFleetDashes replaces em-dash with comma-space", () => {
  assert.equal(scrubFleetDashes("alpha — beta"), "alpha, beta");
  assert.equal(scrubFleetDashes("alpha—beta"), "alpha, beta");
});

test("scrubFleetDashes replaces en-dash with hyphen", () => {
  assert.equal(scrubFleetDashes("1–5"), "1-5");
  assert.equal(scrubFleetDashes("Mon – Fri"), "Mon - Fri");
});

test("scrubFleetDashes leaves ASCII characters alone", () => {
  assert.equal(scrubFleetDashes("plain text -- with dashes"), "plain text -- with dashes");
});

test("scrubFleetDashes passes through non-strings", () => {
  assert.equal(scrubFleetDashes(null), null);
  assert.equal(scrubFleetDashes(undefined), undefined);
  assert.equal(scrubFleetDashes(42), 42);
});

test("scrubFleetDashes handles empty string", () => {
  assert.equal(scrubFleetDashes(""), "");
});

test("scrubFleetDashes handles HTML entity em-dash forms", () => {
  assert.equal(scrubFleetDashes("alpha &mdash; beta"), "alpha, beta");
  assert.equal(scrubFleetDashes("alpha&mdash;beta"), "alpha, beta");
  assert.equal(scrubFleetDashes("alpha &#8212; beta"), "alpha, beta");
});

test("scrubFleetDashes handles HTML entity en-dash forms", () => {
  assert.equal(scrubFleetDashes("1&ndash;5"), "1-5");
  assert.equal(scrubFleetDashes("1&#8211;5"), "1-5");
});

test("scrubFleetDashes collapses adjacent commas from chained replacements", () => {
  assert.equal(scrubFleetDashes("alpha — , beta"), "alpha, beta");
});

test("buildMimeMessage scrubs em-dashes from subject", () => {
  const { mime } = buildMimeMessage({
    from: "bot@example.com",
    to: "user@example.com",
    subject: "Quarterly review — Q1 update",
    htmlBody: "<p>Body</p>",
  });
  assert.ok(mime.includes("Subject: Quarterly review, Q1 update"));
  assert.ok(!mime.includes("—"));
});

test("buildMimeMessage scrubs em-dashes from html body", () => {
  const { mime } = buildMimeMessage({
    from: "bot@example.com",
    to: "user@example.com",
    subject: "Test",
    htmlBody: "<p>Important — please read</p>",
  });
  assert.ok(!mime.includes("—"));
  // Quoted-printable encoding preserves the comma.
  assert.ok(mime.includes("Important, please read"));
});

test("buildMimeMessage scrubs em-dashes from explicit textBody", () => {
  const { mime } = buildMimeMessage({
    from: "bot@example.com",
    to: "user@example.com",
    subject: "Test",
    htmlBody: "<p>html version</p>",
    textBody: "plain — text — version",
  });
  assert.ok(!mime.includes("—"));
  assert.ok(mime.includes("plain, text, version"));
});

test("buildMimeMessage scrubs en-dashes too", () => {
  const { mime } = buildMimeMessage({
    from: "bot@example.com",
    to: "user@example.com",
    subject: "Hours 9–5",
    htmlBody: "<p>pages 3–10</p>",
  });
  assert.ok(!mime.includes("–"));
  assert.ok(mime.includes("Hours 9-5"));
});
