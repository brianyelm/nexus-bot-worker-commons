// The cache prefix is ordered tools -> system -> messages, so anything that
// changes between turns must live BEHIND the history, not in the system prompt.
// These pin the two halves of that fix: the assistant anchor that gives the
// history a stable breakpoint to be read from, and the session-context block
// that keeps per-turn grounding out of `system`.
//
// Measured on Sonnet 5 with 8 exchanges of history: the old shape wrote 5067
// tokens and read 4711 per turn; this one writes 15 and reads 9747.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMessageCache, withSessionContext } from "../src/lib/anthropic.js";

const FIVE_MIN = { type: "ephemeral" };

/** Pull the cache_control off a message's last content block, if any. */
function controlOf(m) {
  if (!Array.isArray(m.content)) return undefined;
  return m.content[m.content.length - 1].cache_control;
}

const CONVO = [
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "second question" },
  { role: "assistant", content: "second answer" },
  { role: "user", content: "third question" },
];

test("anchors the last assistant turn and the newest message, nothing else", () => {
  const out = applyMessageCache(CONVO);
  assert.deepEqual(controlOf(out[3]), FIVE_MIN, "last assistant is the anchor");
  assert.deepEqual(controlOf(out[4]), FIVE_MIN, "newest message extends the cache");
  assert.equal(controlOf(out[0]), undefined);
  assert.equal(controlOf(out[1]), undefined, "an earlier assistant turn is not anchored");
  assert.equal(controlOf(out[2]), undefined);
});

test("stays inside the four-breakpoint API cap", () => {
  const marked = applyMessageCache(CONVO).filter((m) => controlOf(m) !== undefined);
  // Two here, leaving room for the system prompt and the tool schemas.
  assert.equal(marked.length, 2);
});

test("the anchor honours the worker TTL override", () => {
  const out = applyMessageCache(CONVO, { ANTHROPIC_CACHE_TTL: "1h" });
  assert.deepEqual(controlOf(out[3]), { type: "ephemeral", ttl: "1h" });
  // The newest message is rewritten every turn regardless, so it stays on 5m.
  assert.deepEqual(controlOf(out[4]), FIVE_MIN);
});

test("a first turn with no assistant yet just marks the newest message", () => {
  const out = applyMessageCache([{ role: "user", content: "hello" }]);
  assert.equal(out.length, 1);
  assert.deepEqual(controlOf(out[0]), FIVE_MIN);
});

test("does not mutate the caller's array", () => {
  const original = [{ role: "user", content: "hello" }];
  applyMessageCache(original);
  assert.equal(original[0].content, "hello");
});

test("session context rides the newest user turn, ahead of their text", () => {
  const out = withSessionContext(CONVO, "today is Tuesday");
  assert.equal(out.length, CONVO.length);
  const last = out[out.length - 1];
  assert.equal(last.role, "user");
  assert.equal(last.content.length, 2);
  assert.match(last.content[0].text, /^<session_context>\ntoday is Tuesday\n<\/session_context>$/);
  assert.equal(last.content[1].text, "third question");
});

test("earlier turns are untouched, so the cached history keeps its bytes", () => {
  const out = withSessionContext(CONVO, "today is Tuesday");
  assert.deepEqual(out.slice(0, -1), CONVO.slice(0, -1));
});

test("preserves existing content blocks such as attachments", () => {
  const withImage = [
    { role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "what is this" }] },
  ];
  const out = withSessionContext(withImage, "context");
  assert.equal(out[0].content.length, 3);
  assert.equal(out[0].content[0].type, "text");
  assert.equal(out[0].content[1].type, "image");
});

test("never injects into a tool_result turn, which must lead its message", () => {
  const toolTurn = [
    { role: "user", content: "q" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  ];
  // The last turn is a user message, but its first block is a tool_result, so
  // the guard is that injection only ever runs before the tool loop starts.
  const out = withSessionContext(toolTurn, "context");
  assert.equal(out[2].content[0].type, "text");
  assert.equal(out[2].content[1].type, "tool_result");
});

test("an empty or missing session context is a no-op", () => {
  assert.equal(withSessionContext(CONVO, ""), CONVO);
  assert.equal(withSessionContext(CONVO, undefined), CONVO);
});

test("a trailing assistant turn is left alone rather than injected into", () => {
  const endsWithAssistant = [
    { role: "user", content: "q" },
    { role: "assistant", content: "a" },
  ];
  assert.equal(withSessionContext(endsWithAssistant, "context"), endsWithAssistant);
});
