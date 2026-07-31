import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AI_DISCLOSURE_COPY,
  renderAiBadge,
  renderSyntheticMediaLabel,
} from "../src/lib/aiDisclosure.js";

const PROMPT_BLOCK = readFileSync(
  new URL("../src/persona-blocks/AI_DISCLOSURE.md", import.meta.url),
  "utf8",
);

// Suppliers we must never name on an audience facing surface. Fleet rule: state
// the capability, never who provides it.
const VENDOR_NAMES = [
  "Tavus",
  "Cloudflare",
  "Anthropic",
  "Claude",
  "ElevenLabs",
  "Deepgram",
  "Cartesia",
  "Daily",
  "LiveKit",
  "Simli",
  "Protoface",
  "bitHuman",
  "HeyGen",
  "Nexus",
];

// ─── copy ────────────────────────────────────────────────────────────────────

test("every disclosure string is non-empty", () => {
  for (const [key, value] of Object.entries(AI_DISCLOSURE_COPY)) {
    assert.equal(typeof value, "string", `${key} should be a string`);
    assert.ok(value.trim().length > 0, `${key} should not be blank`);
  }
});

test("disclosure copy names no supplier and no internal system", () => {
  const surfaces = [...Object.values(AI_DISCLOSURE_COPY), renderAiBadge(), renderSyntheticMediaLabel(), PROMPT_BLOCK];
  for (const surface of surfaces) {
    for (const vendor of VENDOR_NAMES) {
      assert.ok(
        !new RegExp(`\\b${vendor}\\b`, "i").test(surface),
        `audience copy must not name ${vendor}`,
      );
    }
  }
});

test("disclosure copy avoids the vague labels the Commission guidance rejects", () => {
  // Guidance adopted 2026-07-20 calls out "assistant" and similar euphemisms as
  // inadequate. The copy has to say AI outright.
  for (const key of ["beforeInteraction", "spokenOpening", "notHumanAnswer"]) {
    assert.match(AI_DISCLOSURE_COPY[key], /\bAI\b/, `${key} must say AI plainly`);
    assert.ok(
      !/\b(assistant|virtual agent|digital human)\b/i.test(AI_DISCLOSURE_COPY[key]),
      `${key} must not hide behind a euphemism`,
    );
  }
});

test("the not-human answer is unambiguous", () => {
  assert.match(AI_DISCLOSURE_COPY.notHumanAnswer, /^No\b/);
});

// ─── markup ──────────────────────────────────────────────────────────────────

test("renderAiBadge emits the canonical label by default", () => {
  const html = renderAiBadge();
  assert.match(html, /ai-disclosure-badge/);
  assert.ok(html.includes(AI_DISCLOSURE_COPY.badge));
});

test("renderAiBadge carries the full disclosure for screen readers", () => {
  assert.ok(renderAiBadge().includes(`aria-label="${AI_DISCLOSURE_COPY.beforeInteraction}"`));
});

test("renderAiBadge cannot be clicked away", () => {
  // Persistence is the regulatory requirement. A dismissible badge fails it, so
  // the indicator is inert by construction and owns no dismiss affordance.
  const html = renderAiBadge();
  assert.match(html, /pointer-events: none/);
  assert.ok(!/onclick|<button|dismiss|role="button"/i.test(html));
});

test("renderAiBadge honours placement and label overrides", () => {
  const html = renderAiBadge({ label: "AI generated video", placement: "bottom: 4px; right: 4px;" });
  assert.ok(html.includes("AI generated video"));
  assert.match(html, /bottom: 4px; right: 4px/);
  assert.ok(!/;;/.test(html), "trailing semicolon should not double up");
});

test("renderSyntheticMediaLabel stacks above the persistent badge", () => {
  const html = renderSyntheticMediaLabel();
  assert.ok(html.includes(AI_DISCLOSURE_COPY.syntheticMedia));
  assert.match(html, /z-index: 41/);
});

// ─── prompt block ────────────────────────────────────────────────────────────

test("prompt block forbids claiming humanity and forbids testimonials", () => {
  assert.match(PROMPT_BLOCK, /never give a testimonial/i);
  assert.match(PROMPT_BLOCK, /first hand experience/i);
  assert.match(PROMPT_BLOCK, /do not roleplay as a human/i);
});

test("prompt block refuses to let the disclosure be dropped on request", () => {
  assert.match(PROMPT_BLOCK, /never agree to drop the disclosure/i);
});
