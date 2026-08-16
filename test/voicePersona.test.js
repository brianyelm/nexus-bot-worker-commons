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

// ---- avatar variant ----

import { buildAvatarPersona } from "../src/lib/avatarPersona.js";

function avatarReq(key, query) {
  const headers = new Headers();
  if (key) headers.set("x-api-key", key);
  return new Request(`https://bot.example/api/internal/voice-persona${query}`, { headers });
}

test("buildAvatarPersona: knowledge baked in, local-first rules present, no dashes", () => {
  const persona = buildAvatarPersona({ identity: PROMPT, audience: "internal" });
  assert.ok(persona.startsWith(PROMPT));
  assert.ok(persona.includes("ANSWER FROM THIS PROMPT FIRST"));
  assert.ok(persona.includes("ANNOUNCE EVERY LOOKUP"));
  assert.ok(persona.includes("Live FAQ"));
  // Internal audience carries the full knowledge set.
  assert.ok(persona.includes("Qualifying Questions") || persona.includes("How We Price"));
  assert.ok(!/\u2014|\u2013/.test(persona));
});

test("buildAvatarPersona: public audience strips internal sections", () => {
  const persona = buildAvatarPersona({ identity: PROMPT, audience: "public" });
  assert.ok(!persona.includes("Qualifying Questions"));
  assert.ok(!persona.includes("Pricing Philosophy"));
});

test("handleVoicePersona: variant=avatar routes to the builder", async () => {
  const res = handleVoicePersona(avatarReq("k", "?variant=avatar&audience=public"), { K: "k" }, {
    systemPrompt: PROMPT,
    nexusKeyEnvVar: "K",
    botName: "jacob",
    buildAvatar: (audience) => `AVATAR:${audience}`,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, "avatar-persona");
  assert.equal(body.persona, "AVATAR:public");
});

test("handleVoicePersona: unknown audience coerces to internal", async () => {
  const res = handleVoicePersona(avatarReq("k", "?variant=avatar&audience=admin"), { K: "k" }, {
    systemPrompt: PROMPT,
    nexusKeyEnvVar: "K",
    buildAvatar: (audience) => `AVATAR:${audience}`,
  });
  assert.equal((await res.json()).persona, "AVATAR:internal");
});

test("handleVoicePersona: avatar builder throwing falls back to the voice persona", async () => {
  const res = handleVoicePersona(avatarReq("k", "?variant=avatar"), { K: "k" }, {
    systemPrompt: PROMPT,
    nexusKeyEnvVar: "K",
    buildAvatar: () => { throw new Error("boom"); },
  });
  const body = await res.json();
  assert.equal(body.source, "chat-persona");
  assert.ok(body.persona.startsWith(PROMPT));
});

test("handleVoicePersona: no buildAvatar means variant param is ignored", async () => {
  const res = handleVoicePersona(avatarReq("k", "?variant=avatar"), { K: "k" }, {
    systemPrompt: PROMPT,
    nexusKeyEnvVar: "K",
  });
  assert.equal((await res.json()).source, "chat-persona");
});
