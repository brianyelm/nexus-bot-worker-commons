// Tests for the fleet content judge's pure contract (parse + retry feedback).
// judgeContent() itself needs a live Anthropic call and is exercised by the
// consuming workers' integration paths.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseJudgeVerdict,
  buildRetryFeedback,
  judgeContentWithRedraft,
  FLEET_RUBRICS,
  JUDGE_PASS_THRESHOLD,
} from "../src/lib/contentJudge.js";

// A scripted judge stub: returns the next queued verdict on each call, records
// every content string it was asked to judge. Lets the redraft loop be tested
// without a live Anthropic call (via the _judge injection seam).
function stubJudge(verdicts) {
  const seen = [];
  let i = 0;
  const judge = async (_env, { content }) => {
    seen.push(content);
    return verdicts[Math.min(i++, verdicts.length - 1)];
  };
  return { judge, seen };
}
const PASS = { pass: true, score: 9, issues: [], skipped: false };
const FAIL = { pass: false, score: 3, issues: ["too vague"], skipped: false };
const SKIP = { pass: true, score: 0, issues: [], skipped: true };

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
  const surfaces = [
    "cold-email", "b2b-followup", "newsletter", "meeting-recap", "client-report",
    "morphora-quote", "linkedin-post", "jimifalls-captions",
  ];
  for (const key of surfaces) {
    assert.ok(typeof FLEET_RUBRICS[key] === "string" && FLEET_RUBRICS[key].length > 100, `missing rubric: ${key}`);
  }
});

test("judgeContentWithRedraft: passes first try, never redrafts", async () => {
  const { judge, seen } = stubJudge([PASS]);
  let redraftCalls = 0;
  const res = await judgeContentWithRedraft({}, {
    surface: "meeting-recap", content: "clean draft",
    redraft: async () => { redraftCalls++; return "should not run"; },
    _judge: judge,
  });
  assert.equal(res.verdict.pass, true);
  assert.equal(res.redrafts, 0);
  assert.equal(redraftCalls, 0);
  assert.deepEqual(seen, ["clean draft"]);
});

test("judgeContentWithRedraft: fails then a redraft fixes it", async () => {
  const { judge, seen } = stubJudge([FAIL, PASS]);
  const res = await judgeContentWithRedraft({}, {
    surface: "meeting-recap", content: "leaky draft",
    redraft: async (prev, verdict, attempt) => {
      assert.equal(verdict.pass, false);
      assert.equal(attempt, 1);
      return "fixed draft";
    },
    _judge: judge,
  });
  assert.equal(res.verdict.pass, true);
  assert.equal(res.content, "fixed draft");
  assert.equal(res.redrafts, 1);
  assert.deepEqual(seen, ["leaky draft", "fixed draft"]);
});

test("judgeContentWithRedraft: persistent failure exhausts the budget", async () => {
  const { judge, seen } = stubJudge([FAIL]); // always fails
  let attempts = 0;
  const res = await judgeContentWithRedraft({}, {
    surface: "meeting-recap", content: "v0",
    maxRedrafts: 2,
    redraft: async () => `v${++attempts}`,
    _judge: judge,
  });
  assert.equal(res.verdict.pass, false);
  assert.equal(res.redrafts, 2);          // 2 redrafts after the first judge
  assert.equal(seen.length, 3);           // 1 initial + 2 re-judges
  assert.deepEqual(seen, ["v0", "v1", "v2"]);
});

test("judgeContentWithRedraft: infra skip stops the loop immediately", async () => {
  const { judge } = stubJudge([SKIP]);
  let redraftCalls = 0;
  const res = await judgeContentWithRedraft({}, {
    surface: "meeting-recap", content: "draft",
    redraft: async () => { redraftCalls++; return "x"; },
    _judge: judge,
  });
  assert.equal(res.verdict.skipped, true);
  assert.equal(res.verdict.pass, true);   // fail-open
  assert.equal(res.redrafts, 0);
  assert.equal(redraftCalls, 0);
});

test("judgeContentWithRedraft: a falsy or unchanged redraft stops the loop", async () => {
  const { judge } = stubJudge([FAIL]);
  const resNull = await judgeContentWithRedraft({}, {
    surface: "meeting-recap", content: "draft",
    redraft: async () => null,
    _judge: judge,
  });
  assert.equal(resNull.redrafts, 0);
  assert.equal(resNull.verdict.pass, false);

  const { judge: judge2 } = stubJudge([FAIL]);
  const resSame = await judgeContentWithRedraft({}, {
    surface: "meeting-recap", content: "draft",
    redraft: async () => "draft", // identical, no progress
    _judge: judge2,
  });
  assert.equal(resSame.redrafts, 0);
});

test("judgeContentWithRedraft: no redraft callback degrades to a single judge pass", async () => {
  const { judge, seen } = stubJudge([FAIL]);
  const res = await judgeContentWithRedraft({}, {
    surface: "meeting-recap", content: "draft",
    _judge: judge,
  });
  assert.equal(res.verdict.pass, false);
  assert.equal(res.redrafts, 0);
  assert.deepEqual(seen, ["draft"]);
});
