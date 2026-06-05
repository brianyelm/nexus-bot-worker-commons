// Unit tests for src/lib/hitlCard.js

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderHitlCard } from "../src/lib/hitlCard.js";

test("renders title with emoji and severity pill", () => {
  const md = renderHitlCard({
    bot: "dexter", kind: "breach-scan",
    title: "Breach Alert -- Acme Corp",
    titleEmoji: "🔓",
    severity: "critical",
    sections: [],
  });
  assert.ok(md.startsWith("## 🔓 Breach Alert -- Acme Corp `CRITICAL`"));
});

test("renders italic subtitle below title", () => {
  const md = renderHitlCard({
    bot: "jacob", kind: "newsletter",
    title: "Partner Newsletter",
    subtitle: "47 partners queued",
    sections: [],
  });
  assert.match(md, /## Partner Newsletter\n\*47 partners queued\*/);
});

test("sections with items render as bullet list", () => {
  const md = renderHitlCard({
    bot: "robert", kind: "incident",
    title: "Daily Brief",
    sections: [{
      emoji: "🛡",
      title: "Posture",
      count: 3,
      items: ["one", "two", "three"],
    }],
  });
  // House style: emoji+bold section header, no ###, no number by default for HITL.
  assert.match(md, /🛡 \*\*Posture\*\* \*\(3\)\*/);
  assert.equal(md.includes("###"), false);
  assert.match(md, /- one\n- two\n- three/);
});

test("numbered=true prefixes HITL sections with N.", () => {
  const md = renderHitlCard({
    bot: "robert", kind: "incident",
    title: "Daily Brief",
    numbered: true,
    sections: [
      { emoji: "🛡", title: "Posture", items: ["ok"] },
      { emoji: "🚨", title: "Cases", items: ["one"] },
    ],
  });
  assert.match(md, /🛡 \*\*1\. Posture\*\*/);
  assert.match(md, /🚨 \*\*2\. Cases\*\*/);
});

test("sections with kv render as labeled bullets", () => {
  const md = renderHitlCard({
    bot: "dexter", kind: "breach-scan",
    title: "Breach Alert",
    sections: [{
      emoji: "🔓", title: "Exposed credentials",
      kv: { "Plaintext passwords": 12, "Emails exposed": 47 },
    }],
  });
  assert.match(md, /- \*\*Plaintext passwords:\*\* 12/);
  assert.match(md, /- \*\*Emails exposed:\*\* 47/);
});

test("sections with quote render as blockquote with From/Subject", () => {
  const md = renderHitlCard({
    bot: "maxwell", kind: "vendor-reply",
    title: "Vendor reply draft",
    sections: [{
      emoji: "📧",
      title: "Original email",
      quote: {
        from: "vendor@example.com",
        subject: "Invoice INV-4821",
        body: "Hi team, is this net-30?",
      },
    }],
  });
  assert.match(md, /> \*\*From:\*\* vendor@example.com/);
  assert.match(md, /> \*\*Subject:\*\* Invoice INV-4821/);
  assert.match(md, /> Hi team, is this net-30\?/);
});

test("long quote is truncated with omitted-char count", () => {
  const long = "X".repeat(600);
  const md = renderHitlCard({
    bot: "maxwell", kind: "vendor-reply",
    title: "Quote test",
    sections: [{
      title: "Body",
      quote: { body: long, max: 400 },
    }],
  });
  assert.match(md, /truncated, 200 chars omitted/);
  assert.equal(md.includes("X".repeat(500)), false);
});

test("empty items list renders 'None'", () => {
  const md = renderHitlCard({
    bot: "courtney", kind: "onboarding-start",
    title: "Onboarding",
    sections: [{ title: "Outstanding", items: [] }],
  });
  assert.match(md, /\*\*Outstanding\*\*\nNone/);
});

test("items overflow appends '_+N more_'", () => {
  const items = Array.from({ length: 12 }, (_, i) => `item ${i + 1}`);
  const md = renderHitlCard({
    bot: "robert", kind: "incident",
    title: "Brief",
    sections: [{ title: "Cases", items, max: 5 }],
  });
  assert.match(md, /- item 5\n_\+7 more_/);
});

test("footer includes bot, kind, and a Nexus timestamp token", () => {
  const md = renderHitlCard({
    bot: "jacob", kind: "newsletter",
    title: "Newsletter",
    sections: [],
  });
  assert.match(md, /\*Jacob · newsletter · pending decision · <t:\d+:f>\*/);
});

test("severity pill is uppercased even when lowercase passed", () => {
  const md = renderHitlCard({
    bot: "robert", kind: "incident",
    title: "Incident",
    severity: "high",
    sections: [],
  });
  assert.match(md, /`HIGH`/);
});

test("no sections + no subtitle still renders a valid card", () => {
  const md = renderHitlCard({
    bot: "dexter", kind: "breach-scan",
    title: "Hello",
    sections: [],
  });
  assert.ok(md.includes("## Hello"));
  assert.ok(md.includes("---"));
});

test("oversized body is truncated to MAX_CARD_CHARS", () => {
  const huge = Array.from({ length: 500 }, (_, i) => `line ${i}`).join(", ");
  const md = renderHitlCard({
    bot: "maxwell", kind: "vendor-reply",
    title: "Big",
    sections: [{ title: "Bulk", lines: huge.repeat(20) }],
  });
  assert.ok(md.length <= 6000);
  assert.match(md, /_\.\.\. \(truncated\)_/);
});
