// Unit tests for src/lib/graphJson.js
//
// The contract these lock down is the one that broke Maxwell on 2026-08-06:
// a Graph send answers 202 with an empty body, and any parser that throws
// there reports a delivered email as a failed one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGraphResponse } from "../src/lib/graphJson.js";

test("202 Accepted returns null without touching the body", async () => {
  let bodyRead = false;
  const res = {
    status: 202,
    text: async () => {
      bodyRead = true;
      return "";
    },
  };
  assert.equal(await parseGraphResponse(res), null);
  assert.equal(bodyRead, false, "202 must short-circuit before reading the stream");
});

test("204 No Content returns null", async () => {
  assert.equal(await parseGraphResponse(new Response(null, { status: 204 })), null);
});

test("empty 200 body returns null instead of throwing", async () => {
  assert.equal(await parseGraphResponse(new Response("", { status: 200 })), null);
});

test("whitespace-only body returns null", async () => {
  assert.equal(await parseGraphResponse(new Response("   \n  ", { status: 200 })), null);
});

test("valid JSON parses through unchanged", async () => {
  const res = new Response(JSON.stringify({ id: "AAMk", subject: "hi" }), { status: 200 });
  const parsed = await parseGraphResponse(res);
  assert.equal(parsed.id, "AAMk");
  assert.equal(parsed.subject, "hi");
});

test("non-JSON success body is surfaced as _raw, never thrown", async () => {
  const res = new Response("<html>edge interstitial</html>", { status: 200 });
  const parsed = await parseGraphResponse(res, { method: "POST", path: "/messages/1/send" });
  assert.equal(typeof parsed._raw, "string");
  assert.match(parsed._raw, /interstitial/);
});

test("a body-read failure degrades to null rather than throwing", async () => {
  const res = {
    status: 200,
    text: async () => {
      throw new Error("stream already consumed");
    },
  };
  assert.equal(await parseGraphResponse(res), null);
});
