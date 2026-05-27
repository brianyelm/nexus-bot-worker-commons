// =============================================================================
// testing/workersPool.js -- builds the @cloudflare/vitest-pool-workers options
// object for a bot's e2e tier. Returns a PLAIN object only; it deliberately does
// NOT import the pool plugin or vitest, because this file lives in the commons
// package and is consumed by bots through a file: symlink -- a bare import of
// `@cloudflare/vitest-pool-workers` here would resolve from commons' own
// node_modules (where it isn't installed), not the bot's. The bot's
// vitest.workers.config.js imports `cloudflareTest` from its OWN node_modules
// and wraps the object this returns.
// =============================================================================

/**
 * Build the options object passed to `cloudflareTest(...)` in a bot's
 * vitest.workers.config.js. Inherits D1/KV/DO/SELF + the .md Text rule from the
 * bot's wrangler.toml; `bindings` injects the per-bot test secrets (Nexus key,
 * callback secret, Anthropic key) that aren't in wrangler.toml.
 *
 * @param {object} params
 * @param {Record<string, string>} params.bindings - test-only env bindings
 * @param {string} [params.wranglerPath="./wrangler.toml"]
 * @returns {{ wrangler: { configPath: string }, miniflare: { bindings: Record<string,string> } }}
 */
export function workersPoolOptions({ bindings, wranglerPath = "./wrangler.toml" } = {}) {
  return {
    wrangler: { configPath: wranglerPath },
    miniflare: { bindings: bindings || {} },
  };
}
