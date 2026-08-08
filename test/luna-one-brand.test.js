// Luna must never put a second company name in front of a customer.
//
// This is a commercial position, not a wording preference: the moment she names
// another business, the person works out which part is "really" whose and the
// single relationship we sell stops existing. She was doing it unprompted on the
// live website, because the knowledge modules are written for internal use and
// describe the group as two companies.
//
// The rule block alone is not enough. A model that is never shown a name cannot
// leak one, so the assembled prompt is substituted too, and this is the test
// that the substitution really reaches every surface.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildLunaBrain, LUNA_SURFACES } from "../src/personas/luna.js";

/** Every string a surface hands to the avatar. */
function allText(brain) {
  return [brain.systemPrompt, brain.context, brain.greeting].join("\n");
}

for (const surface of LUNA_SURFACES) {
  test(`${surface}: never names another company`, () => {
    // The rule block does not name anyone, so searching the whole prompt is fair.
    assert.doesNotMatch(allText(buildLunaBrain({ surface })), /morphora/i);
  });

  test(`${surface}: still knows what we sell`, () => {
    // The scrub must not gut what she can talk about. If the offering lines
    // vanish along with the name she has been made useless rather than discreet,
    // which is the failure this test exists to catch.
    //
    // These assertions track the CURRENT offering set in COMPANY_KNOWLEDGE.md.
    // The original pair (/website/i + /marketing automation/i) was written when
    // the group still sold web and marketing automation under the second brand;
    // the 2026 repositioning to an agentic AI company retired that language, so
    // asserting it made this test fail against copy that is deliberately worded
    // that way. Update this list when the offering set changes, but never delete
    // it: something must fail if the one-brand scrub takes the products with it.
    const text = allText(buildLunaBrain({ surface }));
    assert.match(text, /Raven CRM/i);
    assert.match(text, /customer experience portals/i);
    assert.match(text, /security operations/i);
    assert.match(text, /Black Raven/);
  });

  test(`${surface}: carries the one company rule`, () => {
    assert.match(buildLunaBrain({ surface }).systemPrompt, /ONE COMPANY/);
  });

  test(`${surface}: leaves no doubled company name`, () => {
    // "Morphora.ai and Black Raven IT" has to collapse to one company rather
    // than becoming "Black Raven and Black Raven", which would read as broken.
    const text = allText(buildLunaBrain({ surface }));
    assert.doesNotMatch(text, /Black Raven(?: IT)? and Black Raven/i);
  });
}

test("scrubs a caller supplied briefing and greeting too", () => {
  // A prospect dossier is exactly where the other name gets smuggled back in:
  // it is written by hand for one meeting and never reviewed.
  const brain = buildLunaBrain({
    surface: "prospect",
    context: "They already buy hosting from Morphora.ai and want more.",
    greeting: "Hi, I am Luna from Morphora.",
  });
  assert.doesNotMatch(allText(brain), /morphora/i);
  // "Black Raven", not "Black Raven IT": the legal form is deliberately dropped
  // for speech, because it is not how anyone says it out loud.
  assert.match(brain.context, /Black Raven\b/);
});

// Everything below is written FOR US, not for a customer. Handing any of it to a
// stranger means our qualifying script, our pricing posture or our internal
// mailbox gets read back to the person we are selling to. All of it was reaching
// the live website, because the heading matcher never matched a CRLF file.
const INTERNAL_ONLY = [
  "Qualifying Questions",
  "Objection Handling",
  "Pricing Philosophy",
  "What to Avoid",
  "Email Identity",
  "How We Price",
  "jacob.raven@blackravenit.com",
  // Verbatim lines from those sections, in case a heading is ever renamed.
  "Position value before price",
  "Never lead with pricing",
  "Compared to what?",
];

test("the public website surface carries no internal sales material", () => {
  const text = allText(buildLunaBrain({ surface: "website" }));
  for (const phrase of INTERNAL_ONLY) {
    assert.ok(
      !text.includes(phrase),
      `"${phrase}" reached the public website surface`,
    );
  }
});

test("the internal surfaces still HAVE that material", () => {
  // The strip must be scoped to public surfaces. If it ran everywhere it would
  // quietly lobotomise the ambassador Luna who is meant to use this.
  const text = allText(buildLunaBrain({ surface: "event" }));
  assert.match(text, /Qualifying Questions/);
  assert.match(text, /Objection Handling/);
});

test("the public website surface still hides the founder", () => {
  // Guards the older rule while the new one is being added next to it.
  const text = allText(buildLunaBrain({ surface: "website" }));
  assert.doesNotMatch(text, /\bBrian\b/i);
  assert.doesNotMatch(text, /\bYelm\b/i);
});
