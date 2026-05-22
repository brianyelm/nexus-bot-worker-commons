import { test } from "node:test";
import assert from "node:assert/strict";

import { makeShouldRespond } from "../src/lib/triggers.js";

const shouldRespond = makeShouldRespond("robert", ["rob", "bob"]);

// ─── @mention patterns ───────────────────────────────────────────────────────

test("matches @botName mention", () => {
  assert.equal(shouldRespond("@robert what's up", null, null), true);
});

test("matches @alias mention", () => {
  assert.equal(shouldRespond("@rob help me", null, null), true);
  assert.equal(shouldRespond("@bob check this", null, null), true);
});

test("case-insensitive @mention", () => {
  assert.equal(shouldRespond("@ROBERT hello", null, null), true);
  assert.equal(shouldRespond("@Rob status", null, null), true);
});

test("@mention at start of line", () => {
  assert.equal(shouldRespond("@robert", null, null), true);
});

test("@mention after whitespace", () => {
  assert.equal(shouldRespond("hey @robert", null, null), true);
});

test("does not match @mention embedded in word", () => {
  assert.equal(shouldRespond("email@robert.com", null, null), false);
});

// ─── reply-to-last-message ───────────────────────────────────────────────────

test("matches when replyTo equals lastMsgId", () => {
  assert.equal(shouldRespond("random text", "msg-123", "msg-123"), true);
});

test("does not match when replyTo differs from lastMsgId", () => {
  assert.equal(shouldRespond("random text", "msg-123", "msg-456"), false);
});

test("does not match when replyTo or lastMsgId is null", () => {
  assert.equal(shouldRespond("random text", null, "msg-123"), false);
  assert.equal(shouldRespond("random text", "msg-123", null), false);
});

// ─── non-matching inputs ─────────────────────────────────────────────────────

test("does not match plain text", () => {
  assert.equal(shouldRespond("hello everyone", null, null), false);
});

test("does not match empty string", () => {
  assert.equal(shouldRespond("", null, null), false);
});

test("does not match non-string body", () => {
  assert.equal(shouldRespond(null, null, null), false);
  assert.equal(shouldRespond(undefined, null, null), false);
});

test("does not match partial alias in other words", () => {
  assert.equal(shouldRespond("robber took it", null, null), false);
});

// ─── no-alias bot ────────────────────────────────────────────────────────────

test("works with empty aliases array", () => {
  const respond = makeShouldRespond("maxwell", []);
  assert.equal(respond("@maxwell hello", null, null), true);
  assert.equal(respond("hello maxwell", null, null), false);
});

// ─── special characters in alias ─────────────────────────────────────────────

test("escapes regex special chars in alias", () => {
  const respond = makeShouldRespond("bot", ["c++"]);
  assert.equal(respond("@c++ help", null, null), true);
});
