// The tool path must honour an explicit model, same as the plain path.
//
// It did not, and the failure was invisible: FleetView asked every spoken turn
// to run on Haiku, callAnthropicWithTools read env.CLAUDE_MODEL instead, and
// the turns quietly kept paying Sonnet's time to first token. Nothing errored,
// nothing logged, the answers were fine. Only the clock knew.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAnthropicWithTools, callAnthropic } from "../src/lib/anthropic.js";

/**
 * Capture the model on the outbound request without doing a real call.
 * @param {object} [env]
 * @returns {Promise<{model: string}>}
 */
async function modelUsed(fn, env = {}) {
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = JSON.parse(init.body).model;
    return new Response(JSON.stringify({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await fn(env);
  return seen;
}

const BASE = { ANTHROPIC_API_KEY: "k", CLAUDE_MODEL: "claude-sonnet-5" };

test("callAnthropicWithTools honours options.model over env.CLAUDE_MODEL", async () => {
  const seen = await modelUsed(
    (env) => callAnthropicWithTools(env, "sys", [{ role: "user", content: "hi" }], [], {}, {},
      { model: "claude-haiku-4-5-20251001" }),
    BASE,
  );
  assert.equal(seen, "claude-haiku-4-5-20251001");
});

test("callAnthropicWithTools falls back to env.CLAUDE_MODEL", async () => {
  const seen = await modelUsed(
    (env) => callAnthropicWithTools(env, "sys", [{ role: "user", content: "hi" }], [], {}, {}, {}),
    BASE,
  );
  assert.equal(seen, "claude-sonnet-5");
});

test("callAnthropic honours options.model too", async () => {
  const seen = await modelUsed(
    (env) => callAnthropic(env, "sys", [{ role: "user", content: "hi" }], { model: "claude-haiku-4-5-20251001" }),
    BASE,
  );
  assert.equal(seen, "claude-haiku-4-5-20251001");
});
