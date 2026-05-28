// Unit tests for src/lib/interactionPayload.js

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseInteractionPayload, isLegacyFieldsPayload } from "../src/lib/interactionPayload.js";

test("parses canonical button-click payload", () => {
  const raw = {
    message_id: "m1",
    button_id: "approve:vr:42",
    user_id: "u1",
    display_name: "Brian",
    timestamp: 1700000000000,
  };
  const p = parseInteractionPayload(raw);
  assert.equal(p.messageId, "m1");
  assert.equal(p.buttonId, "approve:vr:42");
  assert.equal(p.modalId, null);
  assert.equal(p.userId, "u1");
  assert.equal(p.displayName, "Brian");
  assert.equal(p.timestamp, 1700000000000);
  assert.equal(p.payloadShape, "none");
  assert.deepEqual(p.values, {});
});

test("parses modal-submit payload with .values", () => {
  const p = parseInteractionPayload({
    message_id: "m1",
    modal_id: "edit-draft:42",
    user_id: "u1",
    display_name: "Brian",
    values: { subject: "Hi", body: "ok" },
    timestamp: 1700000000000,
  });
  assert.equal(p.buttonId, null);
  assert.equal(p.modalId, "edit-draft:42");
  assert.deepEqual(p.values, { subject: "Hi", body: "ok" });
  assert.equal(p.payloadShape, "values");
});

test("falls back to .fields when .values is absent", () => {
  const p = parseInteractionPayload({
    message_id: "m1",
    modal_id: "edit-draft:42",
    user_id: "u1",
    display_name: "Brian",
    fields: { subject: "Hi" },
  });
  assert.deepEqual(p.values, { subject: "Hi" });
  assert.equal(p.payloadShape, "fields");
  assert.equal(isLegacyFieldsPayload(p), true);
});

test("prefers .values when both shapes present", () => {
  const p = parseInteractionPayload({
    message_id: "m1",
    values: { a: "from-values" },
    fields: { a: "from-fields" },
  });
  assert.equal(p.values.a, "from-values");
  assert.equal(p.payloadShape, "values");
});

test("coerces non-string values to strings", () => {
  const p = parseInteractionPayload({
    message_id: "m1",
    values: { count: 42, enabled: true, missing: null },
  });
  assert.deepEqual(p.values, { count: "42", enabled: "true", missing: "" });
});

test("missing fields become empty strings, not undefined", () => {
  const p = parseInteractionPayload({});
  assert.equal(p.messageId, "");
  assert.equal(p.userId, "");
  assert.equal(p.displayName, "");
  assert.equal(p.buttonId, null);
  assert.equal(p.modalId, null);
});

test("non-numeric timestamp falls back to now", () => {
  const before = Date.now();
  const p = parseInteractionPayload({ message_id: "m1" });
  const after = Date.now();
  assert.ok(p.timestamp >= before && p.timestamp <= after);
});

test("ISO timestamp string is parsed", () => {
  const p = parseInteractionPayload({ message_id: "m1", timestamp: "2026-05-27T12:00:00Z" });
  assert.equal(p.timestamp, Date.UTC(2026, 4, 27, 12, 0, 0));
});

test("does not throw on null/undefined input", () => {
  assert.doesNotThrow(() => parseInteractionPayload(null));
  assert.doesNotThrow(() => parseInteractionPayload(undefined));
  assert.doesNotThrow(() => parseInteractionPayload("not an object"));
});

test("isLegacyFieldsPayload is false when shape is values or none", () => {
  assert.equal(isLegacyFieldsPayload({ payloadShape: "values" }), false);
  assert.equal(isLegacyFieldsPayload({ payloadShape: "none" }), false);
  assert.equal(isLegacyFieldsPayload(null), false);
});
