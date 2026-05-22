import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCommand } from "../src/lib/commandParser.js";

// ─── basic parsing ───────────────────────────────────────────────────────────

test("parses !verb with no args", () => {
  const r = parseCommand("!help");
  assert.deepEqual(r, { verb: "help", args: "" });
});

test("parses !verb with args", () => {
  const r = parseCommand("!remember name=Brian");
  assert.deepEqual(r, { verb: "remember", args: "name=Brian" });
});

test("lowercases verb", () => {
  const r = parseCommand("!REMEMBER something");
  assert.equal(r.verb, "remember");
});

test("preserves args case", () => {
  const r = parseCommand("!search Brian Yelm");
  assert.equal(r.args, "Brian Yelm");
});

test("handles leading/trailing whitespace", () => {
  const r = parseCommand("  !status  ");
  assert.deepEqual(r, { verb: "status", args: "" });
});

test("collapses multiple spaces between args", () => {
  const r = parseCommand("!cmd  arg1   arg2");
  assert.equal(r.args, "arg1 arg2");
});

// ─── non-command inputs ──────────────────────────────────────────────────────

test("returns null for plain text", () => {
  assert.equal(parseCommand("hello world"), null);
});

test("returns null for empty string", () => {
  assert.equal(parseCommand(""), null);
});

test("returns null for non-string input", () => {
  assert.equal(parseCommand(null), null);
  assert.equal(parseCommand(undefined), null);
  assert.equal(parseCommand(42), null);
  assert.equal(parseCommand({}), null);
});

test("! with space parses as empty verb", () => {
  const r = parseCommand("! something");
  assert.deepEqual(r, { verb: "", args: "something" });
});

test("returns null for mid-sentence bang", () => {
  assert.equal(parseCommand("hey !help"), null);
});

// ─── knownVerbs filtering ────────────────────────────────────────────────────

test("knownVerbs as Set allows listed verb", () => {
  const known = new Set(["help", "status"]);
  const r = parseCommand("!help", known);
  assert.deepEqual(r, { verb: "help", args: "" });
});

test("knownVerbs as Set rejects unlisted verb", () => {
  const known = new Set(["help", "status"]);
  assert.equal(parseCommand("!unknown arg", known), null);
});

test("knownVerbs as Array allows listed verb (case-insensitive)", () => {
  const r = parseCommand("!HELP me", ["help", "status"]);
  assert.deepEqual(r, { verb: "help", args: "me" });
});

test("knownVerbs as Array rejects unlisted verb", () => {
  assert.equal(parseCommand("!nope", ["help", "status"]), null);
});

test("null/undefined knownVerbs allows any verb", () => {
  assert.notEqual(parseCommand("!anything", null), null);
  assert.notEqual(parseCommand("!whatever", undefined), null);
});
