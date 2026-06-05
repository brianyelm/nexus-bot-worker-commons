// Tests for lib/actionTrace.js -- action breadcrumb + unbacked-claim detection.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isReadonlyToolName,
  summarizeToolCall,
  summarizeToolResult,
  buildActionBreadcrumb,
  looksLikeUnbackedClaim,
} from "../src/lib/actionTrace.js";

test("isReadonlyToolName: exact read-only tools", () => {
  assert.equal(isReadonlyToolName("read_channel_history"), true);
  assert.equal(isReadonlyToolName("nexus_load_attachment"), true);
  assert.equal(isReadonlyToolName("nexus_view_gif"), true);
});

test("isReadonlyToolName: read-only prefixes", () => {
  for (const n of ["get_invoices", "list_events", "search_crm", "find_contact", "check_status", "lookup_company"]) {
    assert.equal(isReadonlyToolName(n), true, n);
  }
});

test("isReadonlyToolName: write tools are not read-only", () => {
  for (const n of ["send_email", "draft_email", "create_reminder", "schedule_meeting", "set_watch"]) {
    assert.equal(isReadonlyToolName(n), false, n);
  }
});

test("isReadonlyToolName: junk input", () => {
  assert.equal(isReadonlyToolName(""), false);
  assert.equal(isReadonlyToolName(null), false);
  assert.equal(isReadonlyToolName(undefined), false);
});

test("summarizeToolCall: records whitelisted identifier keys only", () => {
  const s = summarizeToolCall("draft_email", {
    to: "ilya@example.com",
    subject: "Re: Chicago",
    body: "SECRET BODY TEXT that must never appear",
  });
  assert.match(s, /draft_email\(/);
  assert.match(s, /to: ilya@example\.com/);
  assert.match(s, /subject: Re: Chicago/);
  assert.doesNotMatch(s, /SECRET BODY/);
});

test("summarizeToolCall: no-arg tool", () => {
  assert.equal(summarizeToolCall("morning_briefing", {}), "morning_briefing()");
});

test("summarizeToolCall: error flag appended", () => {
  const s = summarizeToolCall("create_reminder", { title: "call Sarah" }, true);
  assert.match(s, /\[FAILED\]$/);
});

test("summarizeToolCall: long values truncated", () => {
  const long = "x".repeat(200);
  const s = summarizeToolCall("set_watch", { email: long });
  assert.ok(s.length < 200, "value should be truncated");
  assert.match(s, /\.\.\./);
});

test("buildActionBreadcrumb: empty trace returns empty string", () => {
  assert.equal(buildActionBreadcrumb([]), "");
  assert.equal(buildActionBreadcrumb(null), "");
});

test("buildActionBreadcrumb: lists tool calls", () => {
  const b = buildActionBreadcrumb([
    { name: "read_email", input: { from: "bryan@cadenceconsultants.com" } },
    { name: "create_reminder", input: { title: "reach out to Bryan" } },
  ]);
  assert.match(b, /actions you actually performed/);
  assert.match(b, /read_email\(from: bryan@cadenceconsultants\.com\)/);
  assert.match(b, /create_reminder\(title: reach out to Bryan\)/);
});

test("buildActionBreadcrumb: includes staged HITL card", () => {
  const b = buildActionBreadcrumb(
    [{ name: "draft_email", input: { to: "bryan@x.com" } }],
    { description: "Reply to Bryan re: Chicago itinerary", channel: "wren-hitl" },
  );
  assert.match(b, /staged HITL approval card in #wren-hitl/);
  assert.match(b, /Reply to Bryan re: Chicago/);
});

test("buildActionBreadcrumb: caps long traces", () => {
  const trace = Array.from({ length: 15 }, (_, i) => ({ name: `tool_${i}`, input: {} }));
  const b = buildActionBreadcrumb(trace);
  assert.match(b, /\(\+5 more\)/);
});

test("summarizeToolResult: pulls top-level ids from a JSON string", () => {
  const s = summarizeToolResult('{"InvoiceNumber":"INV-0042","Total":4200,"Status":"DRAFT"}');
  assert.match(s, /InvoiceNumber: INV-0042/);
  assert.match(s, /Total: 4200/);
  assert.match(s, /Status: DRAFT/);
});

test("summarizeToolResult: looks one level into a wrapper envelope", () => {
  const s = summarizeToolResult({ success: true, invoice: { InvoiceID: "abc-123", Status: "AUTHORISED" } });
  assert.match(s, /InvoiceID: abc-123/);
  assert.match(s, /Status: AUTHORISED/);
});

test("summarizeToolResult: ignores non-objects, arrays, and bodyless results", () => {
  assert.equal(summarizeToolResult("just a sentence, not json"), "");
  assert.equal(summarizeToolResult(["multimodal", "block"]), "");
  assert.equal(summarizeToolResult(null), "");
  assert.equal(summarizeToolResult('{"message":"sent"}').includes("message"), false);
});

test("buildActionBreadcrumb: appends returned identifiers on success", () => {
  const b = buildActionBreadcrumb([
    { name: "xero_list_invoices", input: { company: "Acme" }, isError: false,
      result: '{"InvoiceNumber":"INV-0042","Total":4200}' },
  ]);
  assert.match(b, /xero_list_invoices\(company: Acme\) -> InvoiceNumber: INV-0042/);
});

test("buildActionBreadcrumb: does not append result ids on a failed call", () => {
  const b = buildActionBreadcrumb([
    { name: "xero_create_invoice", input: { company: "Acme" }, isError: true,
      result: '{"id":"should-not-appear"}' },
  ]);
  assert.equal(b.includes("should-not-appear"), false);
  assert.match(b, /\[FAILED\]/);
});

test("looksLikeUnbackedClaim: claims success with no tool call", () => {
  assert.equal(looksLikeUnbackedClaim("Done! Added all 4 reminders for you.", []), true);
});

test("looksLikeUnbackedClaim: claims success but only read tools ran", () => {
  assert.equal(
    looksLikeUnbackedClaim("Done, I scheduled it.", [{ name: "read_channel_history" }]),
    true,
  );
});

test("looksLikeUnbackedClaim: success backed by a write tool is fine", () => {
  assert.equal(
    looksLikeUnbackedClaim("Done, reminder set.", [{ name: "create_reminder" }]),
    false,
  );
});

test("looksLikeUnbackedClaim: write tool that errored does not back the claim", () => {
  assert.equal(
    looksLikeUnbackedClaim("Done, reminder set.", [{ name: "create_reminder", isError: true }]),
    true,
  );
});

test("looksLikeUnbackedClaim: no success claim, no flag", () => {
  assert.equal(looksLikeUnbackedClaim("Sure, I can help with that. What would you like?", []), false);
});

test("looksLikeUnbackedClaim: future-tense intention is not a claim", () => {
  assert.equal(looksLikeUnbackedClaim("I'll send that over once you confirm.", []), false);
});

test("looksLikeUnbackedClaim: junk input", () => {
  assert.equal(looksLikeUnbackedClaim("", []), false);
  assert.equal(looksLikeUnbackedClaim(null, []), false);
});
