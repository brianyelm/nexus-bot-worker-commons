// Tests for the fleet content judge's pure contract (parse + retry feedback).
// judgeContent() itself needs a live Anthropic call and is exercised by the
// consuming workers' integration paths.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseJudgeVerdict,
  buildRetryFeedback,
  FLEET_RUBRICS,
  JUDGE_PASS_THRESHOLD,
} from "../src/lib/contentJudge.js";

test("parseJudgeVerdict parses a clean pass verdict", () => {
  assert.deepEqual(
    parseJudgeVerdict('{"pass": true, "score": 9, "issues": []}'),
    { pass: true, score: 9, issues: [] }
  );
});

test("parseJudgeVerdict parses a fail verdict with issues", () => {
  const v = parseJudgeVerdict('{"pass": false, "score": 4, "issues": ["invented deadline", "placeholder leakage"]}');
  assert.equal(v.pass, false);
  assert.equal(v.score, 4);
  assert.deepEqual(v.issues, ["invented deadline", "placeholder leakage"]);
});

test("parseJudgeVerdict tolerates code fences and surrounding prose", () => {
  const v = parseJudgeVerdict('Assessment:\n```json\n{"pass": true, "score": 8, "issues": []}\n```');
  assert.equal(v.pass, true);
  assert.equal(v.score, 8);
});

test("parseJudgeVerdict enforces the threshold even when the judge says pass", () => {
  const v = parseJudgeVerdict(`{"pass": true, "score": ${JUDGE_PASS_THRESHOLD - 1}, "issues": []}`);
  assert.equal(v.pass, false);
});

test("parseJudgeVerdict never passes on judge pass=false regardless of score", () => {
  const v = parseJudgeVerdict('{"pass": false, "score": 10, "issues": ["disqualifying"]}');
  assert.equal(v.pass, false);
});

test("parseJudgeVerdict clamps score to 1-10 and caps issues at 4", () => {
  const v = parseJudgeVerdict('{"pass": false, "score": 47, "issues": ["a","b","c","d","e"]}');
  assert.equal(v.score, 10);
  assert.equal(v.issues.length, 4);
});

test("parseJudgeVerdict drops non-string and empty issues", () => {
  const v = parseJudgeVerdict('{"pass": false, "score": 3, "issues": ["real", 42, null, "  "]}');
  assert.deepEqual(v.issues, ["real"]);
});

test("parseJudgeVerdict returns null on garbage / non-JSON / missing fields", () => {
  assert.equal(parseJudgeVerdict(""), null);
  assert.equal(parseJudgeVerdict(null), null);
  assert.equal(parseJudgeVerdict("Looks fine to me!"), null);
  assert.equal(parseJudgeVerdict("{broken"), null);
  assert.equal(parseJudgeVerdict('{"verdict": "good"}'), null);
});

test("buildRetryFeedback formats issues into an editor-rejection block", () => {
  const block = buildRetryFeedback({ score: 4, issues: ["invented Q3 deadline", "two competing asks"] });
  assert.match(block, /EDITOR REJECTION/);
  assert.match(block, /scored 4\/10/);
  assert.match(block, /- invented Q3 deadline/);
  assert.match(block, /- two competing asks/);
});

test("buildRetryFeedback returns empty string when nothing to fix", () => {
  assert.equal(buildRetryFeedback(null), "");
  assert.equal(buildRetryFeedback({ score: 9, issues: [] }), "");
});

test("FLEET_RUBRICS covers every launch surface", () => {
  for (const key of ["cold-email", "b2b-followup", "newsletter", "meeting-recap", "client-report"]) {
    assert.ok(typeof FLEET_RUBRICS[key] === "string" && FLEET_RUBRICS[key].length > 100, `missing rubric: ${key}`);
  }
});
