// Unit tests for src/lib/buttonId.js

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BUTTON_LABELS,
  buttonId,
  parseButtonId,
  makeButton,
  isCanonicalLabel,
} from "../src/lib/buttonId.js";

test("BUTTON_LABELS contains all 9 canonical verbs", () => {
  const keys = Object.keys(BUTTON_LABELS).sort();
  assert.deepEqual(keys, ["ack","approve","deny","discard","edit","retry","send","skip","snooze"]);
  for (const k of keys) {
    assert.ok(BUTTON_LABELS[k].label, `verb ${k} has a label`);
    assert.ok(BUTTON_LABELS[k].style, `verb ${k} has a style`);
  }
});

test("BUTTON_LABELS is frozen", () => {
  assert.throws(() => { BUTTON_LABELS.foo = { label: "Foo", style: "primary" }; });
});

test("buttonId builds canonical <verb>:<kind>:<id>", () => {
  assert.equal(buttonId("approve", "vendor-reply", "vr_42"), "approve:vendor-reply:vr_42");
  assert.equal(buttonId("DENY", "Cadence-Tick", "p_99"), "deny:cadence-tick:p_99");
});

test("buttonId accepts legacy hitl-approve / hitl-deny verbs", () => {
  assert.equal(buttonId("hitl-approve", "msg", "abc"), "hitl-approve:msg:abc");
  assert.equal(buttonId("hitl-deny", "msg", "abc"), "hitl-deny:msg:abc");
});

test("buttonId rejects unknown verb", () => {
  assert.throws(() => buttonId("yeet", "x", "1"), /unknown verb/);
});

test("buttonId rejects invalid kind grammar", () => {
  assert.throws(() => buttonId("approve", "Bad Kind!", "1"), /invalid kind/);
  assert.throws(() => buttonId("approve", "", "1"), /invalid kind/);
});

test("buttonId rejects empty id and id with colon", () => {
  assert.throws(() => buttonId("approve", "x", ""), /empty id/);
  assert.throws(() => buttonId("approve", "x", "a:b"), /may not contain ":"/);
});

test("parseButtonId returns canonical {verb, kind, id, legacy}", () => {
  assert.deepEqual(parseButtonId("approve:vendor-reply:vr_42"), {
    verb: "approve", kind: "vendor-reply", id: "vr_42", legacy: false,
  });
});

test("parseButtonId flags legacy hitl verbs", () => {
  const p = parseButtonId("hitl-approve:incident:abc-123");
  assert.equal(p.legacy, true);
  assert.equal(p.verb, "hitl-approve");
});

test("parseButtonId tolerates ids containing dots/hyphens/underscores", () => {
  const p = parseButtonId("approve:bill:inv_2026-05.42");
  assert.equal(p.id, "inv_2026-05.42");
});

test("parseButtonId rejects 2-part strings", () => {
  assert.throws(() => parseButtonId("approve:x"), /does not match/);
});

test("parseButtonId rejects empty string and non-strings", () => {
  assert.throws(() => parseButtonId(""), /expected non-empty/);
  assert.throws(() => parseButtonId(null), /expected non-empty/);
});

test("parseButtonId rejects unknown verb", () => {
  assert.throws(() => parseButtonId("yeet:x:1"), /unknown verb/);
});

test("makeButton merges canonical defaults with callback url", () => {
  const b = makeButton({
    verb: "approve", kind: "vendor-reply", id: "vr_1",
    callbackUrl: "https://x/cb",
  });
  assert.deepEqual(b, {
    button_id: "approve:vendor-reply:vr_1",
    label: "Approve",
    style: "success",
    callback_url: "https://x/cb",
  });
});

test("makeButton allows label/style override", () => {
  const b = makeButton({
    verb: "send", kind: "newsletter", id: "n1",
    callbackUrl: "u",
    label: "Approve & Send",
  });
  assert.equal(b.label, "Approve & Send");
  assert.equal(b.style, "primary"); // default for "send"
});

test("isCanonicalLabel matches defaults", () => {
  assert.equal(isCanonicalLabel("approve", "Approve", "success"), true);
  assert.equal(isCanonicalLabel("approve", "Approve & Send", "success"), false);
  assert.equal(isCanonicalLabel("unknown", "X", "primary"), false);
});
