// Something must always disclose, and never two things at once.
//
// There are two places the AI disclosure can come from: the rendering platform,
// which speaks it before her first word, and her greeting, which is a fixed
// string we set on the persona. They are wired together by one flag. Get the
// flag wrong in one direction and she says it twice inside ten seconds, which
// reads as a fault. Get it wrong in the other and NOBODY discloses, which is
// the failure that has a number attached to it (EUR 15,000,000 or 3 percent of
// worldwide turnover under Article 50, plus CA AB 853 and the NY synthetic
// performer rules).
//
// The second failure is silent. Nothing throws, nothing logs, she just opens
// with "Hi, I'm Luna" and the conversation carries on. So it gets a test.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildLunaBrain, LUNA_SURFACES } from "../src/personas/luna.js";
import { AI_DISCLOSURE_COPY } from "../src/lib/aiDisclosure.js";

/** Says the word AI, in any of the ways a greeting might spell it. */
const saysAi = (text) => /\bA\.?I\.?\b|artificial intelligence/i.test(text);
/** Admits the face or the voice is not a real person's. */
const saysSynthetic = (text) => /computer generated|not a real person|synthetic/i.test(text);

// ─── the greeting ────────────────────────────────────────────────────────────

for (const surface of LUNA_SURFACES) {
  test(`${surface}: greeting discloses in full when the platform does not`, () => {
    const { greeting } = buildLunaBrain({ surface });
    assert.ok(saysAi(greeting), `${surface} greeting must say she is an AI:\n${greeting}`);
    assert.ok(
      saysSynthetic(greeting),
      `${surface} greeting must say the face and voice are generated:\n${greeting}`,
    );
  });

  test(`${surface}: greeting stops repeating the platform's line`, () => {
    const { greeting } = buildLunaBrain({ surface, platformDisclosure: true });
    // The platform has just said "computer generated" out loud. Her saying it
    // again a second later is the thing this flag exists to prevent.
    assert.ok(
      !saysSynthetic(greeting),
      `${surface} greeting repeats the platform disclosure:\n${greeting}`,
    );
    // But the word AI still survives, so a platform disclosure that is ever
    // switched off does not leave her opening as a person.
    assert.ok(saysAi(greeting), `${surface} greeting must still say AI:\n${greeting}`);
  });

  test(`${surface}: an explicit greeting is used exactly as given`, () => {
    // The caller owns an override, on both settings. prospect-luna guards its
    // own dossier greetings; the brain must not second guess a caller.
    const mine = "Hi, I'm Luna, an AI. Ready when you are.";
    for (const platformDisclosure of [false, true]) {
      const { greeting } = buildLunaBrain({ surface, greeting: mine, platformDisclosure });
      assert.equal(greeting, mine);
    }
  });
}

// ─── the prompt ──────────────────────────────────────────────────────────────

for (const surface of LUNA_SURFACES) {
  test(`${surface}: prompt tells her to disclose when nothing else will`, () => {
    const { systemPrompt } = buildLunaBrain({ surface });
    assert.ok(systemPrompt.includes("Disclose at the start"));
    assert.ok(!systemPrompt.includes("The opening disclosure is already handled"));
  });

  test(`${surface}: prompt stands down only the opening instruction`, () => {
    const { systemPrompt } = buildLunaBrain({ surface, platformDisclosure: true });
    assert.ok(systemPrompt.includes("The opening disclosure is already handled"));
    // The cancellation must come AFTER the block it cancels, because the whole
    // prompt is ordered "the later one wins". Reversed, she discloses twice.
    assert.ok(
      systemPrompt.indexOf("Disclose at the start") <
        systemPrompt.indexOf("The opening disclosure is already handled"),
      "the stand down must follow the rule it cancels",
    );
  });

  test(`${surface}: the rules that are not about the opening always survive`, () => {
    for (const platformDisclosure of [false, true]) {
      const { systemPrompt } = buildLunaBrain({ surface, platformDisclosure });
      // Refusing to claim humanity and refusing to give a testimonial are not
      // the platform's job and are never handled for her. A stand down that
      // took these with it would trade an Article 50 problem for a 16 CFR 465
      // one at USD 51,744 a violation.
      assert.ok(systemPrompt.includes("Never give a testimonial"), "testimonial ban dropped");
      assert.ok(systemPrompt.includes("Answer the question straight"), "humanity refusal dropped");
      assert.ok(systemPrompt.includes("Keep the disclosure intact"), "tamper refusal dropped");
    }
  });
}

// ─── the copy the platform is handed ─────────────────────────────────────────

test("the spoken disclosure names both the AI and the synthetic face", () => {
  // This exact string is what gets patched onto every persona as
  // verbal_disclosure. The platform default says only that it is an AI, which
  // is why we override it: someone watching a photoreal face needs to be told
  // the face is generated, not merely that software is involved.
  assert.ok(saysAi(AI_DISCLOSURE_COPY.spokenOpening));
  assert.ok(saysSynthetic(AI_DISCLOSURE_COPY.spokenOpening));
});

test("the banner is present tense", () => {
  // beforeInteraction reads "about to talk", which is wrong on a banner shown
  // during the conversation. That is the whole reason visualBanner exists.
  assert.ok(saysAi(AI_DISCLOSURE_COPY.visualBanner));
  assert.ok(!/about to/i.test(AI_DISCLOSURE_COPY.visualBanner));
});

test("the emotion notice is about the visitor, not about Luna", () => {
  // A separate disclosure about a separate person. Every other string here says
  // what SHE is; this one says what the call does to THEM, and no vendor ships
  // a banner for it, so ours has to carry it.
  const copy = AI_DISCLOSURE_COPY.cameraReadsExpression;
  assert.ok(/camera/i.test(copy), "must name the camera, so the choice is obvious");
  assert.ok(/expression|emotion|mood|tone/i.test(copy), "must say what is being read");
});

// ─── the failure that has a number attached ──────────────────────────────────

test("no combination of flags leaves nobody disclosing", () => {
  for (const surface of LUNA_SURFACES) {
    for (const platformDisclosure of [false, true]) {
      const { greeting, systemPrompt } = buildLunaBrain({ surface, platformDisclosure });
      // Either she opens by disclosing, or the prompt tells her to, or the
      // platform has been told to. One of the three, on every path.
      const covered =
        saysAi(greeting) ||
        systemPrompt.includes("Disclose at the start") ||
        platformDisclosure === true;
      assert.ok(covered, `${surface} (platform=${platformDisclosure}) discloses nowhere`);
    }
  }
});
