// Tests for lib/voicePersona.js -- chat persona rendered for the voice surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVoicePersona, handleVoicePersona } from "../src/lib/voicePersona.js";

const PROMPT = "You are Jacob Raven, Director of Business Development.";

function req(key) {
  const headers = new Headers();
  if (key) headers.set("x-api-key", key);
  return new Request("https://bot.example/api/internal/voice-persona", { headers });
}

test("buildVoicePersona: chat persona leads, delivery rules follow", () => {
  const persona = buildVoicePersona({ systemPrompt: PROMPT, postChannelSlug: "jacob-sales" });
  assert.ok(persona.startsWith(PROMPT));
  assert.ok(persona.includes("VOICE DELIVERY"));
  assert.ok(persona.includes("jacob-sales"));
});

test("buildVoicePersona: no channel slug still gets a tool-output rule", () => {
  const persona = buildVoicePersona({ systemPrompt: PROMPT });
  assert.ok(persona.includes("brief 1 to 2 sentence summary"));
  assert.ok(!persona.includes("auto-posts to undefined"));
});

test("buildVoicePersona: contains no dash punctuation", () => {
  const persona = buildVoicePersona({ systemPrompt: PROMPT, postChannelSlug: "jacob-sales" });
  assert.ok(!/—|–/.test(persona));
});

test("handleVoicePersona: correct key returns the rendered persona", async () => {
  const res = handleVoicePersona(req("sekrit"), { JACOB_NEXUS_KEY: "sekrit" }, {
    systemPrompt: PROMPT,
    nexusKeyEnvVar: "JACOB_NEXUS_KEY",
    botName: "jacob",
    postChannelSlug: "jacob-sales",
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.bot, "jacob");
  assert.ok(body.persona.startsWith(PROMPT));
});

test("handleVoicePersona: wrong same-length key is rejected", async () => {
  // Letters XOR to NaN in a naive string compare; this guards the encode path.
  const res = handleVoicePersona(req("abcdef"), { JACOB_NEXUS_KEY: "ghijkl" }, {
    systemPrompt: PROMPT,
    nexusKeyEnvVar: "JACOB_NEXUS_KEY",
  });
  assert.equal(res.status, 401);
});

test("handleVoicePersona: missing key or secret is rejected", () => {
  assert.equal(handleVoicePersona(req(null), { K: "x" }, { systemPrompt: PROMPT, nexusKeyEnvVar: "K" }).status, 401);
  assert.equal(handleVoicePersona(req("x"), {}, { systemPrompt: PROMPT, nexusKeyEnvVar: "K" }).status, 401);
});

test("handleVoicePersona: authed but unconfigured persona is 503", () => {
  const res = handleVoicePersona(req("k"), { K: "k" }, { nexusKeyEnvVar: "K" });
  assert.equal(res.status, 503);
});
