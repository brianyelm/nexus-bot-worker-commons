import { test } from "node:test";
import assert from "node:assert/strict";

import { withProvenance, getProvenanceContext } from "../src/lib/provenanceContext.js";

test("getProvenanceContext returns null outside any context", () => {
  assert.equal(getProvenanceContext(), null);
});

test("withProvenance sets context for sync code inside fn", async () => {
  let captured = null;
  await withProvenance("scheduled-cron", () => {
    captured = getProvenanceContext();
  });
  assert.equal(captured, "scheduled-cron");
});

test("withProvenance sets context for async code inside fn", async () => {
  let captured = null;
  await withProvenance("webhook-inbound", async () => {
    await new Promise(r => setTimeout(r, 5));
    captured = getProvenanceContext();
  });
  assert.equal(captured, "webhook-inbound");
});

test("nested withProvenance overrides parent", async () => {
  let outer = null;
  let inner = null;
  await withProvenance("mention-reply", async () => {
    outer = getProvenanceContext();
    await withProvenance("hitl-approval", () => {
      inner = getProvenanceContext();
    });
  });
  assert.equal(outer, "mention-reply");
  assert.equal(inner, "hitl-approval");
});

test("context does not leak after withProvenance completes", async () => {
  await withProvenance("email-triage", () => {});
  assert.equal(getProvenanceContext(), null);
});

test("parallel calls do not interfere", async () => {
  const results = [];
  await Promise.all([
    withProvenance("scheduled-cron", async () => {
      await new Promise(r => setTimeout(r, 10));
      results.push(getProvenanceContext());
    }),
    withProvenance("voice-call", async () => {
      await new Promise(r => setTimeout(r, 5));
      results.push(getProvenanceContext());
    }),
  ]);
  assert.ok(results.includes("scheduled-cron"));
  assert.ok(results.includes("voice-call"));
});

test("withProvenance returns the fn return value", async () => {
  const result = await withProvenance("manual-admin", () => 42);
  assert.equal(result, 42);
});
