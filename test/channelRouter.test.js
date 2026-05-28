// Unit tests for src/lib/channelRouter.js

import { test } from "node:test";
import assert from "node:assert/strict";

import { routeApprovalChannel, getApprovalChannelRegistry } from "../src/lib/channelRouter.js";

test("known bot:kind resolves to registered slug", () => {
  assert.equal(routeApprovalChannel({}, { bot: "maxwell", kind: "vendor-reply" }), "maxwell-finance");
  assert.equal(routeApprovalChannel({}, { bot: "jacob", kind: "cadence-tick" }), "jacob-hitl");
});

test("severity override wins over base route", () => {
  assert.equal(
    routeApprovalChannel({}, { bot: "robert", kind: "incident", severity: "CRITICAL" }),
    "soc-notifications",
  );
  // Lower severity falls through to the base route.
  assert.equal(
    routeApprovalChannel({}, { bot: "robert", kind: "incident", severity: "MEDIUM" }),
    "robert-hitl",
  );
});

test("unknown bot:kind falls back to {bot}-hitl", () => {
  assert.equal(routeApprovalChannel({}, { bot: "newbot", kind: "newkind" }), "newbot-hitl");
});

test("inputs are lowercased before lookup", () => {
  assert.equal(routeApprovalChannel({}, { bot: "MAXWELL", kind: "Vendor-Reply" }), "maxwell-finance");
});

test("missing bot or kind throws", () => {
  assert.throws(() => routeApprovalChannel({}, { kind: "x" }), /bot is required/);
  assert.throws(() => routeApprovalChannel({}, { bot: "x" }), /kind is required/);
});

test("getApprovalChannelRegistry returns the registry", () => {
  const r = getApprovalChannelRegistry();
  assert.ok(r.routes);
  assert.ok(r.default);
});
