// The system prompt is split so the stable persona keeps its cache while the
// volatile tail does not drag it down with it.
//
// One block meant one cache entry, so the date or the user's name changing
// invalidated the whole persona: Jacob was rewriting 34k tokens of cache every
// turn, which is slower than a read and billed at 1.25x. These pin the shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemBlocks } from "../src/lib/anthropic.js";

// The stable prefix also runs a 1h TTL: the 5m default expired between
// human-paced turns, so every turn re-wrote the whole persona instead of
// reading it (Flynn: 404k written vs 658k read on 2026-08-15).
const HOUR = { type: "ephemeral", ttl: "1h" };

test("a plain string still gets one cached block, on the long TTL", () => {
  const blocks = buildSystemBlocks("just the persona");
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].cache_control, HOUR);
});

test("segments cache the stable half and leave the volatile half uncached", () => {
  const blocks = buildSystemBlocks([
    { text: "PERSONA", cache: true },
    { text: "today is Tuesday", cache: false },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "PERSONA");
  assert.deepEqual(blocks[0].cache_control, HOUR);
  assert.equal(blocks[1].text, "today is Tuesday");
  assert.equal(blocks[1].cache_control, undefined);
});

test("ANTHROPIC_CACHE_TTL=5m reverts to the bare ephemeral form", () => {
  const blocks = buildSystemBlocks("persona", { ANTHROPIC_CACHE_TTL: "5m" });
  assert.deepEqual(blocks[0].cache_control, { type: "ephemeral" });
});

test("an explicit TTL override is passed through", () => {
  const blocks = buildSystemBlocks("persona", { ANTHROPIC_CACHE_TTL: "1h" });
  assert.deepEqual(blocks[0].cache_control, HOUR);
});

test("empty segments are dropped so no empty text block is sent", () => {
  const blocks = buildSystemBlocks([
    { text: "PERSONA", cache: true },
    { text: "", cache: false },
  ]);
  assert.equal(blocks.length, 1);
});

test("the concatenated text is unchanged by the split", () => {
  const persona = "PERSONA BODY";
  const tail = "\n\nfacts\n\ncontext";
  const blocks = buildSystemBlocks([{ text: persona, cache: true }, { text: tail, cache: false }]);
  assert.equal(blocks.map((b) => b.text).join(""), persona + tail);
});
