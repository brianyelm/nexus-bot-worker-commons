// Unit tests for src/lib/format.js
// Run via `npm test` (node --test test/).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fmtDate, fmtTime, fmtDateTime, fmtRelative, nexusTimestamp,
  fmtCurrency, fmtNumber, fmtPercent, fmtBytes,
  truncate, pluralize, pluralizeBare, fmtList, fmtKv, fmtTable, joinOxford, stripMarkdown,
  mention, mentionMany, channelLink, codeSpan, linkLabel,
  PALETTE,
} from "../src/lib/format.js";

// Fixed instant: 2026-05-20 16:00:00 UTC = 2026-05-20 09:00:00 America/Phoenix
const FIXED = new Date("2026-05-20T16:00:00Z");

// ─── dates / times ────────────────────────────────────────────────────────

test("fmtDate long with AZ tz", () => {
  assert.equal(fmtDate(FIXED, { tz: "America/Phoenix" }), "May 20, 2026");
});

test("fmtDate iso tz-shifted", () => {
  // Late UTC instant near midnight, AZ should still be previous day's iso
  const lateUtc = new Date("2026-05-21T03:00:00Z"); // 2026-05-20 20:00 AZ
  assert.equal(fmtDate(lateUtc, { tz: "America/Phoenix", format: "iso" }), "2026-05-20");
});

test("fmtDate day", () => {
  assert.equal(fmtDate(FIXED, { tz: "America/Phoenix", format: "day" }), "Wednesday");
});

test("fmtDate full", () => {
  assert.equal(fmtDate(FIXED, { tz: "America/Phoenix", format: "full" }), "Wednesday, May 20, 2026");
});

test("fmtTime AZ suffix", () => {
  // Default hour12:true → "9:00 AM AZ"
  assert.equal(fmtTime(FIXED, { tz: "America/Phoenix" }), "9:00 AM AZ");
});

test("fmtTime no tz no suffix", () => {
  const t = fmtTime(FIXED); // runtime-local
  assert.match(t, /^\d{1,2}:\d{2} (AM|PM)$/);
});

test("fmtTime hour12 false", () => {
  assert.equal(fmtTime(FIXED, { tz: "America/Phoenix", hour12: false }), "09:00 AZ");
});

test("fmtDateTime combines", () => {
  assert.equal(fmtDateTime(FIXED, { tz: "America/Phoenix" }), "May 20, 2026 9:00 AM AZ");
});

test("fmtRelative past minutes", () => {
  const now = FIXED.getTime();
  assert.equal(fmtRelative(new Date(now - 5 * 60 * 1000), { now }), "5m ago");
});

test("fmtRelative future hours", () => {
  const now = FIXED.getTime();
  assert.equal(fmtRelative(new Date(now + 3 * 60 * 60 * 1000), { now }), "in 3h");
});

test("fmtRelative just now", () => {
  const now = FIXED.getTime();
  assert.equal(fmtRelative(new Date(now - 10 * 1000), { now }), "just now");
});

test("nexusTimestamp emits token", () => {
  assert.equal(nexusTimestamp(FIXED), `<t:${Math.floor(FIXED.getTime() / 1000)}:f>`);
});

test("nexusTimestamp relative format", () => {
  assert.equal(nexusTimestamp(FIXED, "R"), `<t:${Math.floor(FIXED.getTime() / 1000)}:R>`);
});

// ─── numbers / money ──────────────────────────────────────────────────────

test("fmtCurrency basic", () => {
  assert.equal(fmtCurrency(1234.5), "$1,234.50");
});

test("fmtCurrency null safe", () => {
  assert.equal(fmtCurrency(null), "$0.00");
  assert.equal(fmtCurrency(NaN), "$0.00");
});

test("fmtCurrency cents mode", () => {
  assert.equal(fmtCurrency(1234, { cents: true }), "$12.34");
});

test("fmtNumber grouping", () => {
  assert.equal(fmtNumber(1234567), "1,234,567");
});

test("fmtNumber decimals", () => {
  assert.equal(fmtNumber(1234.567, { decimals: 2 }), "1,234.57");
});

test("fmtNumber compact", () => {
  assert.equal(fmtNumber(1234567, { compact: true }), "1.2M");
});

test("fmtPercent fraction heuristic", () => {
  assert.equal(fmtPercent(0.0734), "7%");
  assert.equal(fmtPercent(0.0734, { decimals: 1 }), "7.3%");
});

test("fmtPercent explicit", () => {
  assert.equal(fmtPercent(73, { mode: "percent" }), "73%");
});

test("fmtBytes scaling", () => {
  assert.equal(fmtBytes(0), "0 B");
  assert.equal(fmtBytes(1024), "1.0 KB");
  assert.equal(fmtBytes(1536), "1.5 KB");
  assert.equal(fmtBytes(1024 * 1024 * 5), "5.0 MB");
});

// ─── strings / lists ──────────────────────────────────────────────────────

test("truncate basic", () => {
  assert.equal(truncate("hello world", 5), "hell…");
});

test("truncate no cut", () => {
  assert.equal(truncate("short", 10), "short");
});

test("truncate surrogate safe", () => {
  // emoji is one grapheme but two code units
  const s = "🌟🌟🌟🌟🌟";
  assert.equal([...truncate(s, 3)].length, 3);
});

test("pluralize 1 vs many", () => {
  assert.equal(pluralize(1, "endpoint"), "1 endpoint");
  assert.equal(pluralize(3, "endpoint"), "3 endpoints");
});

test("pluralize custom plural", () => {
  assert.equal(pluralize(3, "box", "boxes"), "3 boxes");
});

test("pluralize zero/null/negative", () => {
  assert.equal(pluralize(0, "endpoint"), "0 endpoints");
  assert.equal(pluralize(null, "endpoint"), "0 endpoints");
  assert.equal(pluralize(-1, "endpoint"), "-1 endpoints");
});

test("pluralizeBare", () => {
  assert.equal(pluralizeBare(1, "ticket"), "ticket");
  assert.equal(pluralizeBare(3, "ticket"), "tickets");
});

test("fmtList basic", () => {
  assert.equal(fmtList(["a", "b"]), "• a\n• b");
});

test("fmtList overflow", () => {
  const out = fmtList(["a", "b", "c", "d", "e"], { max: 3 });
  assert.equal(out, "• a\n• b\n• c\n_+2 more_");
});

test("fmtList empty → explicit label", () => {
  assert.equal(fmtList([]), "(none)");
});

test("fmtList filters falsy", () => {
  assert.equal(fmtList(["a", null, undefined, "", "b"]), "• a\n• b");
});

test("fmtKv aligned", () => {
  const out = fmtKv([["Client", "IREM"], ["Severity", "High"]]);
  assert.equal(out, "Client  : IREM\nSeverity: High");
});

test("fmtTable GFM", () => {
  const out = fmtTable(["A", "B"], [["1", "2"], ["3", "4"]]);
  assert.equal(out, "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
});

test("joinOxford", () => {
  assert.equal(joinOxford(["a"]), "a");
  assert.equal(joinOxford(["a", "b"]), "a and b");
  assert.equal(joinOxford(["a", "b", "c"]), "a, b, and c");
  assert.equal(joinOxford(["a", "b", "c"], "or"), "a, b, or c");
});

test("stripMarkdown — fences gone", () => {
  const s = "```\nfoo\n```\n**bold** [link](https://example.com) <t:123:f>";
  const out = stripMarkdown(s);
  assert.equal(out.includes("```"), false);
  assert.equal(out.includes("**"), false);
  assert.equal(out.includes("<t:"), false);
  assert.match(out, /link/);
  assert.equal(out.includes("bold"), true);
});

// ─── nexus chips ──────────────────────────────────────────────────────────

test("mention", () => {
  assert.equal(mention("abc-def"), "<@abc-def>");
  assert.equal(mention(""), "");
  assert.equal(mention(null), "");
});

test("mentionMany", () => {
  assert.equal(mentionMany(["a", "b"]), "<@a> and <@b>");
  assert.equal(mentionMany(["a", "b", "c"], "or"), "<@a>, <@b>, or <@c>");
});

test("channelLink", () => {
  assert.equal(channelLink("fleet"), "#fleet");
  assert.equal(channelLink("#fleet"), "#fleet");
});

test("codeSpan escapes backticks", () => {
  assert.equal(codeSpan("foo`bar"), "`foo\\`bar`");
});

test("linkLabel", () => {
  assert.equal(linkLabel("https://x.test/q", "search"), "[search](https://x.test/q)");
});

// ─── palette ──────────────────────────────────────────────────────────────

test("palette is closed", () => {
  assert.equal(Object.isFrozen(PALETTE), true);
  assert.equal(PALETTE.SCHEDULE, "📅");
  assert.equal(PALETTE.MONEY, "💰");
});

// ─── tz leakage guard ─────────────────────────────────────────────────────
// If process.env.TZ leaks through Intl, AZ-tagged output should still show AZ.

test("tz pin survives UTC process tz", () => {
  const original = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    assert.equal(fmtTime(FIXED, { tz: "America/Phoenix" }), "9:00 AM AZ");
  } finally {
    process.env.TZ = original;
  }
});
