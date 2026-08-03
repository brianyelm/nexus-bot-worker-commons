// =============================================================================
// lib/usageReport.js. Fleet-wide per-bot Anthropic usage attribution.
//
// Maxwell aggregates fleet Anthropic spend at USAGE_REPORT_URL
// (maxwell-worker /api/internal/usage-report). Until 2026-08-03 only the
// commons chat path and jacob's cron drafters reported, so most cron spend
// was invisible in maxwell-state.api_usage. This helper is the single shared
// reporter: commons callAnthropic/callAnthropicWithTools self-report through
// it by default, and per-bot raw-fetch funnels call it explicitly.
//
// Fire-and-forget by design (mirrors handleChatMessage): never await, never
// throw into the caller's path. A failed report must not break a job.
// =============================================================================

/**
 * Report one Anthropic call's token usage to Maxwell's intake endpoint.
 * No-ops silently when usage/model are missing or USAGE_REPORT_URL is unset.
 *
 * @param {object} env - Worker env. Reads USAGE_REPORT_URL + NEXUS_INTERNAL_TOKEN,
 *   and AI_GATEWAY_BOT / WORKER_NAME for the default bot name.
 * @param {object} args
 * @param {object} args.usage - The usage block from the Anthropic response.
 * @param {string} args.model - The model id actually sent to Anthropic.
 * @param {string} [args.surface] - Call-site label (e.g. "email-poller").
 * @param {string} [args.bot] - Bot name override; defaults to env.AI_GATEWAY_BOT.
 * @param {string|null} [args.channelSlug] - Optional Nexus channel context.
 * @returns {void}
 */
export function reportUsage(env, { usage, model, surface, bot, channelSlug = null }) {
  if (!usage || !model || !env?.USAGE_REPORT_URL) return;

  const botName =
    bot || env.AI_GATEWAY_BOT || String(env.WORKER_NAME || "bot").replace(/-worker$/, "");

  fetch(env.USAGE_REPORT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": env.NEXUS_INTERNAL_TOKEN || "",
    },
    body: JSON.stringify({
      bot: botName,
      model,
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      channel_slug: channelSlug,
      surface: surface || "cron",
      ts: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}
