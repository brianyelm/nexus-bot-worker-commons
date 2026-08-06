// Unit tests for src/lib/externalReplyGate.js
//
// Covers the 2026-08-06 grammar change: no blind Approve on new cards, the edit
// modal is the sole send path, a failed send never destroys the card, and a
// second send attempt is refused rather than silently duplicated.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  stageExternalReply,
  handleExternalReplyGate,
  handleExternalReplyModal,
} from "../src/lib/externalReplyGate.js";
import { withProvenance } from "../src/lib/provenanceContext.js";

const BASE = "https://worker.example";

/** In-memory env with a KV-shaped CACHE binding. */
function makeEnv() {
  const store = new Map();
  return {
    NEXUS_BASE_URL: "https://nexus.example",
    TEST_KEY: "k",
    _store: store,
    CACHE: {
      async get(key, type) {
        const val = store.get(key);
        if (val === undefined) return null;
        return type === "json" ? JSON.parse(val) : val;
      },
      async put(key, val) { store.set(key, val); },
      async delete(key) { store.delete(key); },
    },
  };
}

/** Install a fetch stub that records every Nexus call. Returns a restore fn. */
function captureFetch(calls) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    let body = null;
    try { body = init?.body ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
    calls.push({ url: String(url), method: init?.method || "GET", body });
    return new Response(JSON.stringify({ data: { id: "msg-1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return () => { globalThis.fetch = original; };
}

/** Standard staging options for a Maxwell-shaped card. */
function stageOpts(overrides = {}) {
  return {
    bot: "maxwell",
    botName: "Maxwell Raven",
    workerBaseUrl: BASE,
    nexusKeyEnvVar: "TEST_KEY",
    inbound: {
      emailId: "AAMk-1",
      from: "vendor@example.com",
      fromName: "Vendor Support",
      subject: "Your subscription renews",
      received: "2026-08-06T12:00:00Z",
      preview: "Just a heads up.",
      cc: ["billing@example.com"],
    },
    draftHtml: "<p>Thanks, noted.</p>",
    draftText: "Thanks, noted.",
    ...overrides,
  };
}

/** Stage one card and return { env, calls, result }. */
async function stageOnce(overrides = {}) {
  const env = makeEnv();
  const calls = [];
  const restore = captureFetch(calls);
  try {
    const result = await withProvenance("external-poll", () => stageExternalReply(env, stageOpts(overrides)));
    return { env, calls, result };
  } finally {
    restore();
  }
}

const buttonsCall = calls => calls.find(c => c.url.endsWith("/buttons"));
const modalsCall = calls => calls.find(c => c.url.endsWith("/modals"));
const patchCalls = calls => calls.filter(c => c.method === "PATCH");

test("staged card carries Reject only, never a blind approve button", async () => {
  const { calls, result } = await stageOnce();
  assert.equal(result.success, true);
  const buttons = buttonsCall(calls).body.buttons;
  assert.equal(buttons.length, 1);
  assert.ok(buttons[0].button_id.startsWith("extmail_reject:"));
  assert.ok(!JSON.stringify(buttons).includes("extmail_approve"));
});

test("edit modal is attached as the send path with a textarea cc field", async () => {
  const { calls } = await stageOnce();
  const modal = modalsCall(calls).body.modals[0];
  assert.ok(modal.modal_id.startsWith("extmail-edit:"));
  assert.equal(modal.callback_url, `${BASE}/api/internal/modal-submit`);
  const cc = modal.fields.find(f => f.name === "cc");
  // A text field with a large max_length is silently rejected by Nexus and
  // drops the whole modal, leaving the card with no send path at all.
  assert.equal(cc.type, "textarea");
  const body = modal.fields.find(f => f.name === "body");
  assert.equal(body.type, "textarea");
  assert.equal(body.required, true);
});

test("channel comes from routeApprovalChannel, not the primary channel", async () => {
  const { calls, result } = await stageOnce();
  assert.equal(result.channelSlug, "maxwell-hitl");
  const post = calls.find(c => c.url.endsWith("/api/bot/messages"));
  assert.equal(post.body.channel_slug, "maxwell-hitl");
});

test("staging refuses without a workerBaseUrl instead of posting a dead card", async () => {
  const { calls, result } = await stageOnce({ workerBaseUrl: "" });
  assert.equal(result.success, false);
  assert.match(result.error, /workerBaseUrl/);
  assert.equal(calls.length, 0);
});

test("failed send preserves the card body and leaves components live", async () => {
  const { env, result } = await stageOnce();
  const calls = [];
  const restore = captureFetch(calls);
  try {
    const out = await handleExternalReplyGate(env, {
      button_id: `extmail_approve:${result.messageId}`,
      message_id: result.messageId,
      display_name: "Brian",
    }, {
      nexusKeyEnvVar: "TEST_KEY",
      sendReply: async () => { throw new Error("Unexpected end of JSON input"); },
    });
    assert.equal(out.action, "failed");
  } finally {
    restore();
  }
  const patch = patchCalls(calls).at(-1);
  assert.ok(patch.body.body.includes("Your subscription renews"), "original card body survives the failure");
  assert.ok(patch.body.body.includes("Send failed (attempt 1)"));
  assert.ok(!patch.body.clear_components, "Reject and the edit modal stay actionable after a failure");
});

test("legacy extmail_approve cards still send", async () => {
  const { env, result } = await stageOnce();
  const calls = [];
  const restore = captureFetch(calls);
  let sent = 0;
  try {
    const out = await handleExternalReplyGate(env, {
      button_id: `extmail_approve:${result.messageId}`,
      message_id: result.messageId,
      display_name: "Brian",
    }, { nexusKeyEnvVar: "TEST_KEY", sendReply: async () => { sent += 1; } });
    assert.equal(out.action, "sent");
  } finally {
    restore();
  }
  assert.equal(sent, 1);
  assert.ok(patchCalls(calls).at(-1).body.clear_components, "a settled card clears its controls");
});

test("a second send attempt is refused by the attempt guard", async () => {
  const { env, result } = await stageOnce();
  let sent = 0;
  const opts = { nexusKeyEnvVar: "TEST_KEY", workerBaseUrl: BASE, sendReply: async () => { sent += 1; } };

  let restore = captureFetch([]);
  try {
    await handleExternalReplyGate(env, {
      button_id: `extmail_approve:${result.messageId}`,
      message_id: result.messageId,
      display_name: "Brian",
    }, opts);
  } finally { restore(); }

  // Re-stage the KV row the way a failure path would, then click again.
  await env.CACHE.put(`extreply:${result.messageId}`, JSON.stringify({
    emailId: "AAMk-1", to: "vendor@example.com", cc: [], draftHtml: "<p>x</p>",
    cardBody: "## Card", botName: "Maxwell Raven", attempts: 1,
  }));

  const calls = [];
  restore = captureFetch(calls);
  try {
    const out = await handleExternalReplyGate(env, {
      button_id: `extmail_approve:${result.messageId}`,
      message_id: result.messageId,
      display_name: "Brian",
    }, opts);
    assert.equal(out.action, "already_attempted");
  } finally { restore(); }

  assert.equal(sent, 1, "the duplicate click never reaches Graph");
  const patch = patchCalls(calls).at(-1);
  assert.match(patch.body.body, /A send was already attempted/);
  const forceButtons = buttonsCall(calls).body.buttons;
  assert.ok(forceButtons[0].button_id.startsWith("extmail_force:"));
});

test("edit modal submission sends the edited body and cc", async () => {
  const { env, result } = await stageOnce();
  const calls = [];
  const restore = captureFetch(calls);
  let seen = null;
  try {
    const out = await handleExternalReplyModal(env, {
      modal_id: `extmail-edit:${result.messageId}`,
      message_id: result.messageId,
      display_name: "Brian",
      values: { cc: "one@example.com; two@example.com", body: "Rewritten reply.\n\nSecond para." },
    }, { nexusKeyEnvVar: "TEST_KEY", sendReply: async (e, pending) => { seen = pending; } });
    assert.equal(out.action, "sent");
  } finally {
    restore();
  }
  assert.deepEqual(seen.cc, ["one@example.com", "two@example.com"]);
  assert.match(seen.draftHtml, /<p>Rewritten reply\.<\/p>/);
  assert.equal(seen.edited_by, "Brian");
  assert.ok(patchCalls(calls).at(-1).body.clear_components);
});

test("modal submission with an empty body sends nothing", async () => {
  const { env, result } = await stageOnce();
  const restore = captureFetch([]);
  let sent = 0;
  try {
    const out = await handleExternalReplyModal(env, {
      modal_id: `extmail-edit:${result.messageId}`,
      message_id: result.messageId,
      display_name: "Brian",
      values: { cc: "", body: "   " },
    }, { nexusKeyEnvVar: "TEST_KEY", sendReply: async () => { sent += 1; } });
    assert.equal(out.action, "empty_body");
  } finally {
    restore();
  }
  assert.equal(sent, 0);
  // The KV row must survive so the reviewer can reopen the modal.
  assert.ok(await env.CACHE.get(`extreply:${result.messageId}`));
});

test("reject settles the card and sends nothing", async () => {
  const { env, result } = await stageOnce();
  const calls = [];
  const restore = captureFetch(calls);
  let sent = 0;
  try {
    const out = await handleExternalReplyGate(env, {
      button_id: `extmail_reject:${result.messageId}`,
      message_id: result.messageId,
      display_name: "Brian",
    }, { nexusKeyEnvVar: "TEST_KEY", sendReply: async () => { sent += 1; } });
    assert.equal(out.action, "rejected");
  } finally {
    restore();
  }
  assert.equal(sent, 0);
  const patch = patchCalls(calls).at(-1);
  assert.match(patch.body.body, /Rejected, nothing sent/);
  assert.ok(patch.body.clear_components);
});
