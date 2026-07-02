// Unit tests for src/lib/sanitize.js + the mimeEmail wiring.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scrubFleetDashes,
  detectFreelanceEmoji,
  detectBareCapsHeader,
  detectEmDashLeak,
  inspectOutboundText,
} from "../src/lib/sanitize.js";
import { buildMimeMessage } from "../src/lib/mimeEmail.js";

test("detectEmDashLeak finds em-dashes and en-dashes", () => {
  assert.equal(detectEmDashLeak("plain text"), false);
  assert.equal(detectEmDashLeak("alpha — beta"), true);
  assert.equal(detectEmDashLeak("1–5"), true);
  assert.equal(detectEmDashLeak(""), false);
  assert.equal(detectEmDashLeak(null), false);
});

test("detectFreelanceEmoji false for palette-only headers", () => {
  assert.equal(detectFreelanceEmoji("### 📧 **Inbox** *(3)*"), false);
  assert.equal(detectFreelanceEmoji("### 🛡 **Posture**"), false);
});

test("detectFreelanceEmoji true for non-palette emoji in header", () => {
  // 🦄 is not in the palette
  assert.equal(detectFreelanceEmoji("### 🦄 **Section**"), true);
  assert.equal(detectFreelanceEmoji("## 🐍 Title"), true);
});

test("detectFreelanceEmoji ignores emoji outside headers", () => {
  assert.equal(detectFreelanceEmoji("- some bullet with 🦄"), false);
  assert.equal(detectFreelanceEmoji("plain prose with 🐍 in it"), false);
});

test("detectBareCapsHeader finds standalone ALL-CAPS labels", () => {
  assert.equal(detectBareCapsHeader("OPEN TICKETS:\n- x"), true);
  assert.equal(detectBareCapsHeader("DAILY SUMMARY"), true);
});

test("detectBareCapsHeader ignores proper markdown headers", () => {
  assert.equal(detectBareCapsHeader("### **Open Tickets**"), false);
  assert.equal(detectBareCapsHeader("## DAILY SUMMARY"), false);
});

test("detectBareCapsHeader ignores normal sentences", () => {
  assert.equal(detectBareCapsHeader("This is a normal sentence."), false);
  assert.equal(detectBareCapsHeader("- bullet with words"), false);
});

test("inspectOutboundText returns all three flags", () => {
  const r = inspectOutboundText("OPEN TICKETS:\n### 🦄 **Section**\nalpha — beta");
  assert.deepEqual(r, {
    has_em_dash: true,
    has_bare_caps: true,
    has_freelance_emoji: true,
  });
});

test("scrubFleetDashes replaces em-dash with comma-space", () => {
  assert.equal(scrubFleetDashes("alpha — beta"), "alpha, beta");
  assert.equal(scrubFleetDashes("alpha—beta"), "alpha, beta");
});

test("scrubFleetDashes replaces en-dash with hyphen", () => {
  assert.equal(scrubFleetDashes("1–5"), "1-5");
  assert.equal(scrubFleetDashes("Mon – Fri"), "Mon - Fri");
});

test("scrubFleetDashes replaces a spaced double-hyphen pause with comma-space", () => {
  assert.equal(scrubFleetDashes("plain text -- with dashes"), "plain text, with dashes");
  assert.equal(scrubFleetDashes("Owner -- email sent"), "Owner, email sent");
});

test("scrubFleetDashes leaves CLI flags and bare hyphens alone", () => {
  assert.equal(scrubFleetDashes("npm run deploy -- --skip-tests"), "npm run deploy, --skip-tests");
  assert.equal(scrubFleetDashes("run with --skip-tests today"), "run with --skip-tests today");
  assert.equal(scrubFleetDashes("well-known config"), "well-known config");
});

test("scrubFleetDashes rewrites unspaced double-hyphens in prose", () => {
  // Letter-to-letter is the dash-as-pause tell.
  assert.equal(scrubFleetDashes("alpha--beta"), "alpha, beta");
  // Digit-to-digit is a range: single hyphen.
  assert.equal(scrubFleetDashes("2024--2025"), "2024-2025");
});

test("scrubFleetDashes handles figure dash and horizontal bar", () => {
  assert.equal(scrubFleetDashes("alpha ― beta"), "alpha, beta");
  assert.equal(scrubFleetDashes("pages 3‒7"), "pages 3-7");
  assert.equal(detectEmDashLeak("alpha ― beta"), true);
});

test("scrubFleetDashes leaves hyphen runs of 3+ alone", () => {
  assert.equal(scrubFleetDashes("---"), "---");
  assert.equal(scrubFleetDashes("a---b"), "a---b");
  assert.equal(scrubFleetDashes("----------"), "----------");
});

test("scrubFleetDashes never rewrites inside code fences or inline code", () => {
  const fenced = "before — text\n```sql\nSELECT 1; -- a comment\n```\nafter -- text";
  assert.equal(
    scrubFleetDashes(fenced),
    "before, text\n```sql\nSELECT 1; -- a comment\n```\nafter, text"
  );
  assert.equal(
    scrubFleetDashes("run `git log -- path` then stop -- now"),
    "run `git log -- path` then stop, now"
  );
  // Unterminated fence (streamed/partial text) is still protected.
  assert.equal(
    scrubFleetDashes("intro -- pause\n```\ngit checkout -- ."),
    "intro, pause\n```\ngit checkout -- ."
  );
});

test("scrubFleetDashes never rewrites inside HTML pre/code bodies", () => {
  assert.equal(
    scrubFleetDashes("<p>note — here</p><pre>flag -- kept</pre>"),
    "<p>note, here</p><pre>flag -- kept</pre>"
  );
  assert.equal(
    scrubFleetDashes("<code>x -- y</code> but prose -- scrubbed"),
    "<code>x -- y</code> but prose, scrubbed"
  );
});

test("detectEmDashLeak flags prose double-hyphens but not code or flags", () => {
  assert.equal(detectEmDashLeak("stop -- now"), true);
  assert.equal(detectEmDashLeak("alpha--beta"), true);
  assert.equal(detectEmDashLeak("run with --skip-tests"), false);
  assert.equal(detectEmDashLeak("```\nSELECT 1; -- comment\n```"), false);
  assert.equal(detectEmDashLeak("`git log -- path`"), false);
  assert.equal(detectEmDashLeak("---"), false);
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
