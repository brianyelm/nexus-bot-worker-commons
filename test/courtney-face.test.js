// The Courtney FACE, not the Courtney bot. Three things about her are load
// bearing and all three fail silently, so all three get a test.
//
// 1. She must disclose. Same regulator, same numbers as Luna: Article 50, plus
//    CA AB 853 and the NY synthetic performer rules.
// 2. She must never answer a question about a name she does not recognise from
//    world knowledge. She shipped without this and told Brian about the Marvel
//    superhero when he asked about a client called Hawkeye. Nothing threw and
//    nothing logged; she just said it, out loud, in a voice people trust.
// 3. Her public surface must not leak a real name or a second company. Nothing
//    points at that surface today, both live ones are PIN gated, which is
//    precisely why it is the default a forgetful caller lands on.
//
// None of these produce an error when they break. They produce a sentence.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCourtneyBrain, COURTNEY_SURFACES, COURTNEY_SUPPORT_LINE } from "../src/personas/courtney.js";

test("every surface discloses in its greeting", () => {
  for (const surface of COURTNEY_SURFACES) {
    const { greeting } = buildCourtneyBrain({ surface });
    assert.match(greeting, /\bAI\b/, `${surface} greeting never says the word AI`);
  }
});

test("the platform-disclosed greeting still says AI, so a mis-set flag cannot silence her", () => {
  // If platformDisclosure is passed wrongly the platform says nothing. The
  // fallback greeting has to carry the word anyway, or nobody discloses at all.
  for (const surface of COURTNEY_SURFACES) {
    const { greeting } = buildCourtneyBrain({ surface, platformDisclosure: true });
    assert.match(greeting, /\bAI\b/, `${surface} disclosed greeting never says the word AI`);
  }
});

test("every surface carries the no-records rule, by name", () => {
  // Asserting on the Hawkeye sentence specifically. A softer "you have no
  // access" survives a careless edit; the worked example is the part that
  // actually stops her reaching for the encyclopedia.
  for (const surface of COURTNEY_SURFACES) {
    const { systemPrompt } = buildCourtneyBrain({ surface });
    assert.match(systemPrompt, /ASSUME IT IS ONE OF OUR CLIENTS/, `${surface} lost the unknown-name rule`);
    assert.match(systemPrompt, /Hawkeye/, `${surface} lost the worked example`);
  }
});

test("she never claims a lookup or a handoff she cannot perform", () => {
  const { systemPrompt } = buildCourtneyBrain({ surface: "desk" });
  assert.match(systemPrompt, /NO tools and NO access/);
  assert.match(systemPrompt, /cannot open a ticket/);
  assert.ok(systemPrompt.includes(COURTNEY_SUPPORT_LINE), "the one real route to a human is missing");
});

test("the public surface leaks no real name and no second company", () => {
  const { systemPrompt, greeting, context } = buildCourtneyBrain({
    surface: "desk",
    // The two places a name gets smuggled back in: a caller supplied briefing
    // and an overridden opener. Both go through the scrubs.
    context: "Brian Yelm is joining this call on behalf of Morphora.ai.",
    greeting: "Hi, I'm Courtney, an AI. Brian asked me to say hello.",
  });
  for (const [label, text] of [["prompt", systemPrompt], ["greeting", greeting], ["context", context]]) {
    assert.doesNotMatch(text, /\bBrian\b|\bYelm\b/, `${label} leaked a real name on a public surface`);
    assert.doesNotMatch(text, /Morphora/i, `${label} leaked a second company`);
  }
});

test("the attended surface may name the founder, because he is standing there", () => {
  const { systemPrompt } = buildCourtneyBrain({ surface: "demo" });
  assert.match(systemPrompt, /Brian/, "the demo surface should not be name-scrubbed");
});

test("an unknown surface falls back to the public one, not the permissive one", () => {
  const { systemPrompt } = buildCourtneyBrain({ surface: "nonsense" });
  assert.doesNotMatch(systemPrompt, /\bBrian\b|\bYelm\b/, "a typo'd surface must fail closed");
});

test("she never describes the company as an MSP", () => {
  for (const surface of COURTNEY_SURFACES) {
    const { systemPrompt } = buildCourtneyBrain({ surface });
    assert.match(systemPrompt, /Never describe the company as an IT provider, an MSP/);
  }
});
