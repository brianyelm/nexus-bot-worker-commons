import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQaEntry } from "../src/lib/qaCapture.js";

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
  assert.equal(parsed.v, 1);
  assert.equal(parsed.bot, "maxwell");
  assert.equal(parsed.kind, "tool.xero_create_invoice");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.surface, "chat");
  assert.equal(parsed.ts, "2026-05-26T14:03:01Z");
  assert.deepEqual(parsed.meta, { model: "x" });
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
