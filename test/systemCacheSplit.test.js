// The system prompt is split so the stable persona keeps its cache while the
// volatile tail does not drag it down with it.
//
// One block meant one cache entry, so the date or the user's name changing
// invalidated the whole persona: Jacob was rewriting 34k tokens of cache every
// turn, which is slower than a read and billed at 1.25x. These pin the shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemBlocks } from "../src/lib/anthropic.js";

// The stable prefix runs the 5m TTL. A 1h write costs 1.00x base input against
// the 5m write's 0.25x, so it only pays if the prefix is read back roughly four
// times as often; the measured fleet traffic is nowhere near that bar. See the
// header note in src/lib/anthropic.js for the arithmetic.
const FIVE_MIN = { type: "ephemeral" };
const HOUR = { type: "ephemeral", ttl: "1h" };

test("a plain string still gets one cached block, on the short TTL", () => {
  const blocks = buildSystemBlocks("just the persona");
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].cache_control, FIVE_MIN);
});

test("segments cache the stable half and leave the volatile half uncached", () => {
  const blocks = buildSystemBlocks([
    { text: "PERSONA", cache: true },
    { text: "today is Tuesday", cache: false },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "PERSONA");
  assert.deepEqual(blocks[0].cache_control, FIVE_MIN);
  assert.equal(blocks[1].text, "today is Tuesday");
  assert.equal(blocks[1].cache_control, undefined);
});

test("ANTHROPIC_CACHE_TTL=5m is the default and stays the bare ephemeral form", () => {
  const blocks = buildSystemBlocks("persona", { ANTHROPIC_CACHE_TTL: "5m" });
  assert.deepEqual(blocks[0].cache_control, FIVE_MIN);
});

test("a worker can opt into the 1h TTL explicitly", () => {
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
