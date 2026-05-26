import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTRACT_VERSION,
  VALIDATORS,
  validateChatMessage,
  validateButtonClick,
  validateModalSubmit,
  validateModalDefinition,
  fixtures,
  modalSubmitFixture,
  chatMessageFixture,
  modalDefinitionFixture,
} from "../contracts/index.js";
import { signCallback, verifyNexusSignature } from "../src/lib/callbackSign.js";

// ── version ──────────────────────────────────────────────────────────────────

test("CONTRACT_VERSION is exposed", () => {
  assert.ok(CONTRACT_VERSION, "version must be set so stale consumers are detectable");
});

// ── every fixture is self-valid ────────────────────────────────────────────────

test("every shipped fixture validates clean", () => {
  for (const [type, fixture] of Object.entries(fixtures)) {
    const errs = VALIDATORS[type](fixture);
    assert.deepEqual(errs, [], `${type} fixture should be valid, got: ${errs.join("; ")}`);
  }
});

// ── modal-submit: the values-vs-fields drift this contract exists to catch ──────

test("modal-submit keyed `fields` instead of `values` is rejected", () => {
  const { values, ...rest } = modalSubmitFixture;
  const drifted = { ...rest, fields: values }; // the bug: payload uses `fields`
  const errs = validateModalSubmit(drifted);
  assert.ok(errs.some((e) => e.includes("values")), `should flag missing values, got: ${errs.join("; ")}`);
});

test("modal-submit missing required ids is rejected", () => {
  assert.ok(validateModalSubmit({ modal_id: "m", user_id: "u", values: {} }).length > 0);
});

// ── modal DEFINITION (attach direction): value vs default_value ─────────────────

test("modal-definition fixture validates clean", () => {
  assert.deepEqual(validateModalDefinition(modalDefinitionFixture), []);
});

test("modal-definition field keyed `default_value` is rejected (renders blank)", () => {
  const broken = {
    ...modalDefinitionFixture,
    fields: [{ name: "subject", label: "Subject", type: "text", default_value: "prefill" }],
  };
  const errs = validateModalDefinition(broken);
  assert.ok(errs.some((e) => e.includes("default_value")), `should flag default_value, got: ${errs.join("; ")}`);
});

test("modal-definition rejects an unknown field type and missing title", () => {
  const errs = validateModalDefinition({
    modal_id: "m:1",
    callback_url: "https://x/cb",
    fields: [{ name: "f", label: "F", type: "slider" }],
  });
  assert.ok(errs.some((e) => e.includes("title")));
  assert.ok(errs.some((e) => e.includes("type")));
});

// ── chat-message cross-field rules ──────────────────────────────────────────────

test("chat-message with neither body nor attachments is rejected", () => {
  const errs = validateChatMessage({ user_id: "u", channel_slug: "c", trigger_type: "ambient" });
  assert.ok(errs.some((e) => e.includes("body or attachments")));
});

test("attachment-only chat-message (no body) is valid", () => {
  const errs = validateChatMessage({
    user_id: "u",
    channel_slug: "c",
    trigger_type: "ambient",
    attachments: [{ id: "a1", filename: "statement.pdf" }],
  });
  assert.deepEqual(errs, []);
});

test("mention without mentioned_bot_id is rejected", () => {
  const { mentioned_bot_id, ...rest } = chatMessageFixture;
  const errs = validateChatMessage(rest);
  assert.ok(errs.some((e) => e.includes("mentioned_bot_id")));
});

test("unknown trigger_type is rejected", () => {
  const errs = validateChatMessage({ ...chatMessageFixture, trigger_type: "shouting" });
  assert.ok(errs.some((e) => e.includes("trigger_type")));
});

// ── button-click ────────────────────────────────────────────────────────────────

test("button-click missing button_id is rejected", () => {
  const errs = validateButtonClick({ message_id: "m", user_id: "u" });
  assert.ok(errs.some((e) => e.includes("button_id")));
});

// ── signCallback <-> verifyNexusSignature round-trip ────────────────────────────

test("a fixture signed with signCallback verifies", async () => {
  const secret = "test-secret-key";
  const body = JSON.stringify(modalSubmitFixture);
  const { timestamp, signature } = await signCallback(secret, body);
  const headers = new Headers({ "X-Nexus-Timestamp": timestamp, "X-Nexus-Signature": signature });
  assert.equal(await verifyNexusSignature(secret, body, headers), true);
});

test("a tampered body fails verification", async () => {
  const secret = "test-secret-key";
  const body = JSON.stringify(modalSubmitFixture);
  const { timestamp, signature } = await signCallback(secret, body);
  const headers = new Headers({ "X-Nexus-Timestamp": timestamp, "X-Nexus-Signature": signature });
  assert.equal(await verifyNexusSignature(secret, body + " ", headers), false);
});

test("a stale timestamp fails verification", async () => {
  const secret = "test-secret-key";
  const body = JSON.stringify(buttonClickFixtureBody());
  const stale = Math.floor(Date.now() / 1000) - 600;
  const { timestamp, signature } = await signCallback(secret, body, { timestamp: stale });
  const headers = new Headers({ "X-Nexus-Timestamp": timestamp, "X-Nexus-Signature": signature });
  assert.equal(await verifyNexusSignature(secret, body, headers), false);
});

function buttonClickFixtureBody() {
  return fixtures["button-click"];
}
