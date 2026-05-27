// Unit tests for src/lib/nexus.js. Focused on the dash sanitizer that runs
// inside postToNexus/editNexusMessage. The actual HTTP paths are exercised
// in worker integration tests; here we cover the string-rewrite contract.

import { test } from "node:test";
import assert from "node:assert/strict";

import { postToNexus, attachButtons } from "../src/lib/nexus.js";

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

test("postToNexus replaces em-dashes with comma-space", async () => {
  const sent = await captureBody("alpha — beta — gamma");
  assert.equal(sent.body, "alpha, beta, gamma");
});

test("postToNexus collapses em-dashes without surrounding spaces", async () => {
  const sent = await captureBody("alpha—beta—gamma");
  assert.equal(sent.body, "alpha, beta, gamma");
});

test("postToNexus replaces en-dashes with hyphen", async () => {
  const sent = await captureBody("range 1–5 and 10–20");
  assert.equal(sent.body, "range 1-5 and 10-20");
});

test("postToNexus handles mixed em and en dashes", async () => {
  const sent = await captureBody("title — pages 3–7");
  assert.equal(sent.body, "title, pages 3-7");
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

// ── attachButtons retry behavior ──────────────────────────────────────
// A swallowed attach failure strands a button-less HITL card, so transient
// faults (5xx / network) must be retried; permanent 4xx must short-circuit.

const ATTACH_ENV = { NEXUS_BASE_URL: "https://nexus.example", TEST_KEY: "k" };
const ATTACH_OPTS = { nexusKeyEnvVar: "TEST_KEY" };
const ONE_BUTTON = [{ button_id: "approve:1", label: "Approve", callback_url: "https://b.example/cb" }];

// Run attachButtons with a scripted sequence of fetch responses. setTimeout is
// stubbed to fire immediately so backoff adds no real delay to the test.
async function runAttach(responses) {
  // Count only calls to the buttons route; reportFleetError fires its own
  // fetch on persistent failure, which must not pollute the attempt count.
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { fn(); return 0; };
  globalThis.fetch = async (url) => {
    if (!String(url).endsWith("/buttons")) {
      return new Response(JSON.stringify({ data: { id: "x" } }), { status: 200 });
    }
    const r = responses[callCount] ?? responses[responses.length - 1];
    callCount += 1;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
  };
  try {
    const result = await attachButtons(ATTACH_ENV, "msg-1", ONE_BUTTON, ATTACH_OPTS);
    return { result, callCount };
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
}

test("attachButtons retries a 503 then succeeds", async () => {
  const { result, callCount } = await runAttach([
    { status: 503, json: {} },
    { status: 201, json: { data: [{ id: 1 }] } },
  ]);
  assert.equal(callCount, 2);
  assert.deepEqual(result, [{ id: 1 }]);
});

test("attachButtons retries a network error then succeeds", async () => {
  const { result, callCount } = await runAttach([
    new Error("network unreachable"),
    { status: 201, json: { data: [{ id: 2 }] } },
  ]);
  assert.equal(callCount, 2);
  assert.deepEqual(result, [{ id: 2 }]);
});

test("attachButtons does NOT retry a permanent 400", async () => {
  const { result, callCount } = await runAttach([
    { status: 400, json: { error: "bad button" } },
  ]);
  assert.equal(callCount, 1);
  assert.equal(result, null);
});

test("attachButtons gives up after 3 attempts on persistent 500", async () => {
  const { result, callCount } = await runAttach([
    { status: 500, json: {} },
  ]);
  assert.equal(callCount, 3);
  assert.equal(result, null);
});
