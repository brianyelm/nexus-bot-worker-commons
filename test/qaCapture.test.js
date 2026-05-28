import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQaEntry, isNoopCronResult } from "../src/lib/qaCapture.js";

function parseEntry(out) {
  const json = out.split("```qa\n")[1].split("\n```")[0];
  return JSON.parse(json);
}

test("buildQaEntry emits a header + parseable qa JSON block", () => {
  const out = buildQaEntry({
    bot: "maxwell",
    kind: "tool.xero_create_invoice",
    summary: "created DRAFT BRIT-1042",
    detail: "contact=Acme; total=1840",
    ok: true,
    surface: "chat",
    ts: "2026-05-26T14:03:01Z",
    meta: { model: "x" },
  });
  assert.match(out, /^QA `tool\.xero_create_invoice` \| created DRAFT BRIT-1042\n```qa\n/);
  const parsed = parseEntry(out);
  assert.equal(parsed.v, 2);
  assert.equal(parsed.bot, "maxwell");
  assert.equal(parsed.kind, "tool.xero_create_invoice");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.surface, "chat");
  assert.equal(parsed.ts, "2026-05-26T14:03:01Z");
  // v2 meta is the user-supplied fields plus the computed compliance signals.
  assert.equal(parsed.meta.model, "x");
  assert.equal(parsed.meta.format_mode, "chat");
  assert.equal(parsed.meta.posted_via, "raw");
  assert.equal(parsed.meta.has_em_dash, false);
  assert.equal(parsed.meta.section_count, 0);
});

test("buildQaEntry v2 detects em-dash leak and rich format_mode", () => {
  const out = buildQaEntry({
    bot: "x", kind: "k",
    detail: "## A Title\n\n### **Section**\nbody with an em — dash",
    meta: { posted_via: "buildReport" },
  });
  const parsed = parseEntry(out);
  assert.equal(parsed.meta.has_em_dash, true);
  assert.equal(parsed.meta.section_count, 1);
  assert.equal(parsed.meta.format_mode, "rich");
  assert.equal(parsed.meta.posted_via, "buildReport");
});

test("buildQaEntry v2 maps postHitlCard postedVia to format_mode='hitl'", () => {
  const out = buildQaEntry({
    bot: "maxwell", kind: "vendor-reply",
    detail: "## Vendor reply\n\n### **Original**\n> text",
    meta: { posted_via: "postHitlCard" },
  });
  const parsed = parseEntry(out);
  assert.equal(parsed.meta.format_mode, "hitl");
});

test("buildQaEntry v2 detects fenced bangReport", () => {
  const out = buildQaEntry({
    bot: "x", kind: "k",
    detail: "```bangReport\nGET /health -> 530\n```",
  });
  const parsed = parseEntry(out);
  assert.equal(parsed.meta.format_mode, "fenced");
});

test("buildQaEntry v2 carries button/modal violation counts from caller", () => {
  const out = buildQaEntry({
    bot: "x", kind: "k",
    detail: "plain reply",
    meta: {
      button_label_violations: 2,
      button_id_violations: 1,
      modal_payload_shape: "fields",
    },
  });
  const parsed = parseEntry(out);
  assert.equal(parsed.meta.button_label_violations, 2);
  assert.equal(parsed.meta.button_id_violations, 1);
  assert.equal(parsed.meta.modal_payload_shape, "fields");
});

test("buildQaEntry caps summary + detail and defaults ok=true", () => {
  const out = buildQaEntry({ bot: "b", kind: "k", summary: "x".repeat(300), detail: "y".repeat(5000) });
  const parsed = parseEntry(out);
  assert.equal(parsed.summary.length, 120);
  assert.equal(parsed.detail.length, 1500);
  assert.equal(parsed.ok, true);
});

test("buildQaEntry serializes non-string detail", () => {
  const out = buildQaEntry({ bot: "b", kind: "k", detail: { a: 1, b: [2, 3] } });
  const parsed = parseEntry(out);
  assert.equal(parsed.detail, JSON.stringify({ a: 1, b: [2, 3] }));
});

test("buildQaEntry tolerates missing fields with safe defaults", () => {
  const out = buildQaEntry({});
  const parsed = parseEntry(out);
  assert.equal(parsed.bot, "unknown");
  assert.equal(parsed.kind, "unknown");
  assert.equal(parsed.surface, "chat");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary, "");
  assert.match(out, /\| \(no summary\)\n/);
});

test("buildQaEntry collapses whitespace in summary", () => {
  const out = buildQaEntry({ bot: "b", kind: "k", summary: "  multi\n  line   summary " });
  const parsed = parseEntry(out);
  assert.equal(parsed.summary, "multi line summary");
});

// --- isNoopCronResult ---------------------------------------------------------

test("isNoopCronResult skips ok cron ticks with fired:0,errors:0", () => {
  assert.equal(isNoopCronResult("cron", true, '{"fired":0,"errors":0}'), true);
});

test("isNoopCronResult does NOT skip when fired>0", () => {
  assert.equal(isNoopCronResult("cron", true, '{"fired":3,"errors":0}'), false);
});

test("isNoopCronResult does NOT skip when errors>0", () => {
  assert.equal(isNoopCronResult("cron", true, '{"fired":0,"errors":2}'), false);
});

test("isNoopCronResult does NOT skip failed ticks regardless of detail", () => {
  // Failures are always interesting -- never suppress them.
  assert.equal(isNoopCronResult("cron", false, '{"fired":0,"errors":0}'), false);
});

test("isNoopCronResult does NOT skip non-cron surfaces", () => {
  // chat/tool/email/voice surfaces don't get the cron-noise filter.
  assert.equal(isNoopCronResult("chat", true, '{"fired":0,"errors":0}'), false);
  assert.equal(isNoopCronResult("tool", true, '{"fired":0,"errors":0}'), false);
});

test("isNoopCronResult skips truly-empty detail on cron ok ticks", () => {
  assert.equal(isNoopCronResult("cron", true, "null"), true);
  assert.equal(isNoopCronResult("cron", true, "{}"), true);
  assert.equal(isNoopCronResult("cron", true, '""'), true);
  assert.equal(isNoopCronResult("cron", true, ""), true);
});

test("isNoopCronResult does NOT skip detail with content but no fired/errors keys", () => {
  // A cron that doesn't emit fired/errors counters is presumed meaningful.
  assert.equal(isNoopCronResult("cron", true, '{"synced":12}'), false);
});
