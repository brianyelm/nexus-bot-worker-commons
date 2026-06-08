// Tests for buildReport() + existing bangReport/bangAlert helpers.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bangReport, bangAlert, buildReport, previewOf, safeEmbedTitle,
} from "../src/lib/embedCard.js";
import { buildReportPrompt } from "../src/lib/reportPrompt.js";
import { PALETTE } from "../src/lib/format.js";

test("bangReport wraps in code fence", () => {
  const out = bangReport({ botName: "Dexter", verb: "status", sections: ["ok"] });
  assert.match(out, /^```\n/);
  assert.match(out, /\n```$/);
  assert.match(out, /Dexter !status/);
});

test("bangAlert no leading bang", () => {
  const out = bangAlert({ botName: "Courtney", verb: "ticket-alert", sections: ["x"] });
  assert.match(out, /Courtney ticket-alert/);
  assert.equal(out.includes("!"), false);
});

test("safeEmbedTitle strips brackets", () => {
  assert.equal(safeEmbedTitle(" [Foo]  bar "), "Foo bar");
});

test("buildReport basic shape", () => {
  const out = buildReport({
    botName: "Dexter",
    emoji: PALETTE.METRICS,
    title: "Device Sync",
    subtitle: "Wednesday, May 20, 2026",
    sections: [
      { emoji: PALETTE.OK, title: "Endpoints", count: 238, items: ["S1 active: 154", "Powered off: 12"] },
      { emoji: PALETTE.WARN, title: "Drift", items: ["3 endpoints missing S1"] },
    ],
    generatedAt: new Date("2026-05-20T16:00:00Z"),
  });
  assert.match(out, /^## 📊 Device Sync/);
  assert.match(out, /\*Wednesday, May 20, 2026\*/);
  // House style: numbered emoji+bold sections, NO ### headers.
  assert.match(out, /✅ \*\*1\. Endpoints\*\* \*\(238\)\*/);
  assert.match(out, /• S1 active: 154/);
  assert.match(out, /⚠️ \*\*2\. Drift\*\*/);
  assert.equal(out.includes("###"), false);
  // Footer with timestamp token
  assert.match(out, /<t:\d+:f>/);
});

test("buildReport empty section uses fallback label", () => {
  const out = buildReport({
    botName: "Wren",
    title: "Today",
    sections: [{ emoji: PALETTE.SCHEDULE, title: "Meetings", items: [] }],
  });
  assert.match(out, /\(none\)/);
});

test("buildReport single section is NOT numbered", () => {
  const out = buildReport({
    botName: "Courtney",
    title: "Daily Motivation",
    sections: [{ emoji: PALETTE.NOTES, title: "Today", lines: "Keep going." }],
  });
  // A lone section gets a clean header, no "1." prefix.
  assert.match(out, /\*\*Today\*\*/);
  assert.equal(/\*\*1\. Today\*\*/.test(out), false);
});

test("buildReportPrompt single section is NOT numbered", () => {
  const { user } = buildReportPrompt({
    botName: "Wren",
    period: "today",
    sections: [{ emoji: PALETTE.SCHEDULE, title: "Agenda", kind: "prose" }],
  });
  assert.match(user, /\*\*Agenda\*\*/);
  assert.equal(/\*\*1\. Agenda\*\*/.test(user), false);
});

test("buildReport overflow", () => {
  const out = buildReport({
    botName: "Wren",
    title: "Inbox",
    sections: [{
      emoji: PALETTE.EMAIL, title: "Unread",
      items: ["a","b","c","d","e","f","g","h","i","j"],
      max: 3,
    }],
  });
  assert.match(out, /_\+7 more_/);
});

test("buildReport title appears first — preview is readable", () => {
  const out = buildReport({
    botName: "Dexter",
    emoji: PALETTE.METRICS,
    title: "Daily Fleet Sweep",
    subtitle: "All bots reporting",
    sections: [{ emoji: PALETTE.OK, title: "Status", items: ["all green"] }],
  });
  const preview = previewOf(out);
  // No timestamp token leaks into preview
  assert.equal(preview.includes("<t:"), false);
  // No raw markdown markers
  assert.equal(preview.includes("##"), false);
  assert.equal(preview.includes("---"), false);
  // Title text is at the front
  assert.match(preview, /^📊 Daily Fleet Sweep/);
});

test("buildReport truncates when over soft cap", () => {
  // Build a ridiculous report to force truncation
  const big = Array.from({ length: 50 }, (_, i) => ({
    emoji: PALETTE.OK,
    title: `Section ${i}`,
    items: Array.from({ length: 20 }, (_, j) => `Item ${i}.${j} ` + "x".repeat(100)),
    max: Infinity,
  }));
  const out = buildReport({ botName: "Maxwell", title: "Stress", sections: big });
  assert.ok(out.length <= 6500, `expected <=6500 chars after truncation, got ${out.length}`);
  assert.match(out, /_truncated_/);
});

test("buildReport with raw lines", () => {
  const out = buildReport({
    botName: "Robert",
    title: "Triage",
    sections: [{ emoji: PALETTE.ALERT, title: "Incident", lines: "ID: 42\nSeverity: high\nOwner: <@brian>" }],
  });
  assert.match(out, /ID: 42/);
  assert.match(out, /Owner: <@brian>/);
});

test("buildReport body passthrough renders verbatim, not double-numbered", () => {
  const narrative = "📊 **1. Risk Posture Summary**\nStable.\n\n🚨 **2. Top Items**\n- **A:** b";
  const out = buildReport({
    botName: "Robert",
    emoji: PALETTE.ALERT,
    title: "CISO Brief: 2026-06-05",
    subtitle: "Risk posture: **Stable**",
    body: narrative,
    sections: [{ emoji: PALETTE.NOTES, title: "Ignored", lines: "should not render" }],
  });
  assert.match(out, /^## 🚨 CISO Brief: 2026-06-05/);
  assert.match(out, /📊 \*\*1\. Risk Posture Summary\*\*/);
  assert.match(out, /🚨 \*\*2\. Top Items\*\*/);
  // sections are ignored when body is present
  assert.equal(out.includes("should not render"), false);
  assert.equal(out.includes("###"), false);
});

test("buildReportPrompt embeds numbered emoji+bold headers and rules", () => {
  const { system, user } = buildReportPrompt({
    role: "CISO-level SOC analyst",
    botName: "Robert",
    period: "the past 24 hours",
    sections: [
      { emoji: PALETTE.METRICS, title: "Risk Posture Summary", kind: "prose", hint: "direction of travel" },
      { emoji: PALETTE.ALERT, title: "Top Attention Items", kind: "bullets" },
    ],
    data: '{"newThreats":3}',
    caveats: ["onlineAgents is a heartbeat count, not coverage"],
  });
  assert.match(system, /Robert/);
  assert.match(system, /em dashes/);
  assert.match(user, /📊 \*\*1\. Risk Posture Summary\*\*/);
  assert.match(user, /🚨 \*\*2\. Top Attention Items\*\*/);
  assert.match(user, /direction of travel/);
  assert.match(user, /Lead term/);
  assert.match(user, /newThreats/);
  assert.match(user, /heartbeat count/);
  assert.match(user, /Do not use `#`, `##`, or `###`/);
});
