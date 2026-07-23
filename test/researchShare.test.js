// =============================================================================
// test/researchShare.test.js -- pure-helper coverage for the grounded-share lib
//
// The network path (researchWatercoolerShare) is exercised in prod smoke; these
// tests pin the anti-hallucination contract: URL collection from real search
// result blocks, grounding verification, and strict-JSON parsing.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectSearchResultUrls,
  verifySharedUrl,
  parseResearchJson,
  recoverGroundedUrl,
  groundUrlsInText,
} from "../src/lib/researchShare.js";

const SAMPLE_CONTENT = [
  { type: "server_tool_use", id: "tu_1", name: "web_search", input: { query: "birding news" } },
  {
    type: "web_search_tool_result",
    tool_use_id: "tu_1",
    content: [
      { type: "web_search_result", url: "https://www.audubon.org/news/some-story", title: "Some Story" },
      { type: "web_search_result", url: "https://example.com/article/", title: "Other" },
    ],
  },
  {
    type: "text",
    text: "picked one",
    citations: [{ type: "web_search_result_location", url: "https://cited.example.org/piece" }],
  },
];

test("collectSearchResultUrls pulls result and citation urls", () => {
  const urls = collectSearchResultUrls(SAMPLE_CONTENT);
  assert.deepEqual(urls, [
    "https://www.audubon.org/news/some-story",
    "https://example.com/article/",
    "https://cited.example.org/piece",
  ]);
});

test("collectSearchResultUrls tolerates empty and error-shaped blocks", () => {
  assert.deepEqual(collectSearchResultUrls([]), []);
  assert.deepEqual(collectSearchResultUrls(undefined), []);
  const errBlock = [{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }];
  assert.deepEqual(collectSearchResultUrls(errBlock), []);
});

test("verifySharedUrl accepts exact and normalized matches only", () => {
  const urls = collectSearchResultUrls(SAMPLE_CONTENT);
  assert.equal(verifySharedUrl("https://www.audubon.org/news/some-story", urls), true);
  // trailing slash + host case differences normalize away
  assert.equal(verifySharedUrl("https://EXAMPLE.com/article", urls), true);
  // hallucinated URL on a real domain is still rejected
  assert.equal(verifySharedUrl("https://www.audubon.org/news/invented-story", urls), false);
  assert.equal(verifySharedUrl("not a url", urls), false);
  assert.equal(verifySharedUrl("", urls), false);
});

test("recoverGroundedUrl repairs a small tail garble, rejects real divergence", () => {
  const real = "https://wfopublications.org/rare-bird-sighting-a-fork-tailed-flycatcher-in-oregon/";
  const urls = [real, "https://other.example.com/story"];
  // the live-observed failure: duplicated syllable appended to the real URL
  const garbled = "https://wfopublications.org/rare-bird-sighting-a-fork-tailed-flycatcher-in-oregonon/";
  assert.equal(recoverGroundedUrl(garbled, urls), real);
  // different host never recovers
  assert.equal(recoverGroundedUrl("https://evil.example.net/rare-bird-sighting-a-fork-tailed-flycatcher-in-oregon/", urls), null);
  // same host but a different article never recovers
  assert.equal(recoverGroundedUrl("https://wfopublications.org/completely-invented-story/", urls), null);
  assert.equal(recoverGroundedUrl("not a url", urls), null);
});

test("groundUrlsInText keeps grounded urls, repairs garbles, strips inventions", () => {
  const allowed = ["https://darknetdiaries.com/episode/150", "https://example.com/real-article"];
  // grounded url with trailing punctuation survives intact
  const keep = groundUrlsInText("this one is great: https://darknetdiaries.com/episode/150.", allowed);
  assert.equal(keep.text, "this one is great: https://darknetdiaries.com/episode/150.");
  assert.deepEqual(keep.dropped, []);
  // garbled tail repaired to the real url
  const fix = groundUrlsInText("check https://example.com/real-articlecle out", allowed);
  assert.equal(fix.text, "check https://example.com/real-article out");
  // invented url stripped, text tidied
  const strip = groundUrlsInText("try https://podcastland.example.net/made-up maybe", allowed);
  assert.equal(strip.text, "try maybe");
  assert.deepEqual(strip.dropped, ["https://podcastland.example.net/made-up"]);
  // no urls = untouched
  assert.equal(groundUrlsInText("no links here", allowed).text, "no links here");
});

test("parseResearchJson handles fences, stray prose, and missing fields", () => {
  const good = parseResearchJson('```json\n{"title":"T","url":"https://x.y/z","post":"hey https://x.y/z"}\n```');
  assert.equal(good.title, "T");
  assert.equal(good.url, "https://x.y/z");
  const prose = parseResearchJson('sure, here you go {"title":"T","url":"https://x.y/z","post":"p"} done');
  assert.equal(prose.post, "p");
  assert.throws(() => parseResearchJson("no json here"), /no JSON object/);
  assert.throws(() => parseResearchJson('{"title":"T","url":"https://x.y/z"}'), /missing "post"/);
  assert.throws(() => parseResearchJson('{"title":" ","url":"u","post":"p"}'), /missing "title"/);
});
