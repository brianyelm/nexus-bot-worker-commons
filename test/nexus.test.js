// Unit tests for src/lib/nexus.js. Focused on the dash sanitizer that runs
// inside postToNexus/editNexusMessage. The actual HTTP paths are exercised
// in worker integration tests; here we cover the string-rewrite contract.

import { test } from "node:test";
import assert from "node:assert/strict";

import { postToNexus } from "../src/lib/nexus.js";

// Capture what postToNexus sends to fetch. We stub global fetch, run the
// call, and assert on the body the worker emitted.
async function captureBody(content) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ data: { id: "msg-1" } }), { status: 200 });
  };
  try {
    await postToNexus(
      { NEXUS_BASE_URL: "https://nexus.example", TEST_KEY: "k" },
      "watercooler",
      content,
      { nexusKeyEnvVar: "TEST_KEY", provenance: "scheduled-cron" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  return calls[0]?.body;
}

test("postToNexus strips em-dashes", async () => {
  const sent = await captureBody("alpha — beta — gamma");
  assert.equal(sent.body, "alpha -- beta -- gamma");
});

test("postToNexus strips en-dashes", async () => {
  const sent = await captureBody("range 1–5 and 10–20");
  assert.equal(sent.body, "range 1-5 and 10-20");
});

test("postToNexus mixes em and en dashes correctly", async () => {
  const sent = await captureBody("title — pages 3–7");
  assert.equal(sent.body, "title -- pages 3-7");
});

test("postToNexus leaves ASCII hyphens alone", async () => {
  const sent = await captureBody("double--hyphen and single-hyphen");
  assert.equal(sent.body, "double--hyphen and single-hyphen");
});

test("postToNexus passes through dash-free content unchanged", async () => {
  const sent = await captureBody("plain text with no special punctuation.");
  assert.equal(sent.body, "plain text with no special punctuation.");
});

test("postToNexus coerces non-strings without throwing", async () => {
  const sent = await captureBody(12345);
  assert.equal(sent.body, "12345");
});
