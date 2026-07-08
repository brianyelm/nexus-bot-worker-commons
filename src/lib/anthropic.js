// =============================================================================
// lib/anthropic.js - Anthropic Messages API wrapper with tool-use loop
//
// Two exported functions:
//
//   callAnthropic(env, systemPrompt, messages, [options])
//     Basic call. Returns assistant text. No tools.
//
//   callAnthropicWithTools(env, systemPrompt, messages, tools, handlers, [ctx], [options])
//     Full tool-use loop. Calls Anthropic, executes tool_use blocks,
//     feeds results back, repeats until stop_reason is "end_turn" or
//     max iterations is reached. Returns final assistant text.
//
// Cache strategy (mirrors EC2 robert-bot intentClassifier.js):
//   - System prompt: cache_control { type: "ephemeral" } always.
//   - Last tool definition: cache_control { type: "ephemeral" } if tools present.
//   - Last user message content block: cache_control { type: "ephemeral" }.
//   These breakpoints let the stable prefix (system + tools + N-1 messages)
//   be served from Anthropic prompt cache at ~1/10th cost on subsequent turns.
//
// Tool handler convention: handler(input, env, ctx). ALWAYS in this order.
//   input  = the tool_use block's .input object
//   env    = Worker environment bindings
//   ctx    = extra context { user_id, display_name, channel_slug }
//
// Available on env:
//   env.ANTHROPIC_API_KEY  - required
//   env.CLAUDE_MODEL       - optional; defaults to claude-opus-4-7
// =============================================================================

import { withRetry, isRetryableAnthropicError } from "./retry.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-opus-4-7";
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 60000;
const MAX_TOOL_ITERATIONS = 10;
// Retry the idempotent HTTP POST (not tool execution) on transient failures.
// 3 attempts with 1s then 5s backoff; classifier retries 429/5xx + network tells.
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1_000, 5_000, 15_000];

/**
 * Guarantee the messages array opens with a user turn. The Anthropic Messages
 * API requires messages[0] to have role "user" (a leading assistant turn 400s);
 * consecutive same-role turns are otherwise fine. The watercooler pipeline maps
 * a bot's own in-window posts to assistant turns, so when the oldest message in
 * the fetch window is the bot's own post the array would start with assistant
 * and the call would 400, silently dropping the reply. Prepend a minimal user
 * primer rather than dropping the assistant turn, so the bot still sees (and can
 * own) its own post. No-op when the array already starts with a user turn.
 *
 * @param {Array} messages
 * @returns {Array}
 */
function normalizeLeadingRole(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (messages[0].role === "user") return messages;
  return [{ role: "user", content: "(earlier in the conversation)" }, ...messages];
}

/**
 * Apply ephemeral cache_control to the last content block of the last message.
 * Returns a shallow-cloned array; safe to pass the original messages in.
 *
 * @param {Array} messages
 * @returns {Array}
 */
function applyCacheToLastMessage(messages) {
  if (!messages || messages.length === 0) return messages;
  return messages.map((m, i) => {
    if (i !== messages.length - 1) return m;
    if (typeof m.content === "string") {
      return {
        role: m.role,
        content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }],
      };
    }
    if (Array.isArray(m.content) && m.content.length > 0) {
      const lastIdx = m.content.length - 1;
      return {
        role: m.role,
        content: m.content.map((b, j) =>
          j === lastIdx ? { ...b, cache_control: { type: "ephemeral" } } : b
        ),
      };
    }
    return m;
  });
}

/**
 * Apply ephemeral cache_control to the last tool definition.
 *
 * @param {Array} tools
 * @returns {Array}
 */
function applyCacheToTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  return tools.map((t, i) =>
    i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t
  );
}

/**
 * Resolve where Anthropic calls go. When env.AI_GATEWAY_ANTHROPIC_URL is set
 * (only on workers opted into the CF AI Gateway pilot, e.g. courtney-worker),
 * route through the gateway and tag the request; otherwise hit the direct API.
 * Fail-open: unset = today's behavior, so the whole fleet is unaffected.
 *
 * @param {object} env
 * @param {string} [surface] - dashboard tag (chat/attachment/watercooler)
 * @returns {{ url: string, metadata: object|null }}
 */
function resolveAnthropicRoute(env, surface) {
  const gw = env && env.AI_GATEWAY_ANTHROPIC_URL;
  if (!gw) return { url: API_URL, metadata: null };
  return {
    url: gw,
    metadata: { bot: env.AI_GATEWAY_BOT || env.WORKER_NAME || "bot", surface: surface || "chat" },
  };
}

/**
 * Raw POST to the Anthropic Messages API (or the AI Gateway when route.url set).
 *
 * @param {string} apiKey
 * @param {object} body
 * @param {{ url?: string, metadata?: object }} [route]
 * @returns {Promise<object>} Parsed JSON response
 */
async function _post(apiKey, body, route = {}) {
  const url = route.url || API_URL;
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
    "anthropic-beta": "prompt-caching-2024-07-31",
  };
  // Tag the request for the CF AI Gateway dashboard when routed through it.
  if (route.metadata) headers["cf-aig-metadata"] = JSON.stringify(route.metadata);

  // Retry the POST on transient failures (429/5xx/network). The status-check
  // throw lives INSIDE the retried closure so the classifier sees the status
  // and a 5xx/429 is retried while a 4xx fails fast. Only the idempotent HTTP
  // POST retries here; the tool-use loop never re-executes handlers.
  return withRetry(
    async () => {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(`[anthropic] fetch failed: ${err.message}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`[anthropic] API error ${res.status}: ${text}`);
      }
      try {
        return await res.json();
      } catch (err) {
        throw new Error(`[anthropic] JSON parse failed: ${err.message}`);
      }
    },
    {
      attempts: RETRY_ATTEMPTS,
      backoffMs: RETRY_BACKOFF_MS,
      isRetryable: isRetryableAnthropicError,
      onRetry: (err, attempt, delayMs) =>
        console.warn(`[anthropic] transient failure, retry ${attempt} in ${delayMs}ms: ${err.message}`),
    },
  );
}

/**
 * Extract the final text content from an Anthropic response.
 *
 * @param {object} data - Anthropic response object
 * @returns {string}
 */
function extractText(data) {
  return (data?.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
}

/**
 * Call the Anthropic Messages API and return the assistant response text.
 * No tool-use loop -- use callAnthropicWithTools for that.
 *
 * @param {object} env - Worker environment bindings
 * @param {string} systemPrompt - Full system prompt text
 * @param {Array<{role: string, content: string|Array}>} messages - Conversation turns
 * @param {object} [options]
 * @param {number} [options.maxTokens]
 * @returns {Promise<string>} Assistant message text
 */
export async function callAnthropic(env, systemPrompt, messages, options = {}) {
  const model = options.model || env.CLAUDE_MODEL || DEFAULT_MODEL;
  const apiKey = env.ANTHROPIC_API_KEY;

  if (!apiKey) throw new Error("[anthropic] ANTHROPIC_API_KEY is not configured");

  const body = {
    model,
    max_tokens: options.maxTokens || MAX_TOKENS,
    // Sonnet 5 / Opus 4.7+ default to adaptive thinking when `thinking` is
    // omitted, which silently adds latency + token cost on chat/structured
    // paths that never wanted it. Pin disabled by default; a caller opts a
    // specific job into adaptive by passing options.thinking. No-op on the
    // Haiku/Sonnet-4.6 paths that already ran thinking-off. (2026-07-01 fleet bump.)
    thinking: options.thinking || { type: "disabled" },
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: applyCacheToLastMessage(normalizeLeadingRole(messages)),
  };

  const data = await _post(apiKey, body, resolveAnthropicRoute(env, options.surface));
  const text = data?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`[anthropic] unexpected response shape: ${JSON.stringify(data)}`);
  }
  if (typeof options.onUsage === "function" && data.usage) {
    try { options.onUsage(data.usage); } catch (e) { /* never break main flow */ }
  }
  return text;
}

/**
 * Call Anthropic with a tools array and execute the full tool-use loop.
 *
 * Pipeline:
 *   1. Call Anthropic with messages + tools.
 *   2. If stop_reason === "tool_use", execute each tool_use block.
 *   3. Append tool_result blocks to messages and call again.
 *   4. Repeat up to MAX_TOOL_ITERATIONS.
 *   5. Return final text response.
 *
 * Tool handlers are ALWAYS called as handler(input, env, ctx).
 *   input  = tool_use block .input object
 *   env    = CF Worker env bindings
 *   ctx    = extra context passed by caller (user_id, display_name, channel_slug, etc.)
 *
 * @param {object} env - Worker environment bindings
 * @param {string} systemPrompt
 * @param {Array} messages - Conversation turns (shallow-cloned internally; original not mutated)
 * @param {Array} tools - Anthropic tool definition objects
 * @param {object} handlers - { [toolName]: async (input, env, ctx) => any }
 * @param {object} [ctx] - Extra context passed to handlers
 * @param {object} [options]
 * @param {(turnIndex: number) => (void|Promise<void>)} [options.onTurnStart] - Hook
 *   called immediately before each Anthropic POST. turnIndex starts at 0 for
 *   the initial call, then increments per tool-loop iteration. Used by
 *   handleChatMessage to re-arm the Nexus typing indicator across long
 *   tool loops (the indicator has a 90s TTL on the Nexus DO).
 * @param {(name: string, input: object, isError: boolean, result?: string|Array) => void} [options.onToolCall]
 *   Hook called once per executed tool_use block (after the handler runs).
 *   Used to accumulate an action breadcrumb for conversation memory. Errors
 *   in the hook are caught and never break the tool loop.
 * @returns {Promise<string>} Final assistant text
 */
export async function callAnthropicWithTools(env, systemPrompt, messages, tools, handlers, ctx = {}, options = {}) {
  const model = env.CLAUDE_MODEL || DEFAULT_MODEL;
  const apiKey = env.ANTHROPIC_API_KEY;

  if (!apiKey) throw new Error("[anthropic] ANTHROPIC_API_KEY is not configured");

  const route = resolveAnthropicRoute(env, options.surface || "chat");
  const toolsWithCache = applyCacheToTools(tools);

  const baseParams = {
    model,
    max_tokens: options.maxTokens || MAX_TOKENS,
    // Pin thinking disabled by default (see callAnthropic note). Opt a job into
    // adaptive via options.thinking. No-op on Haiku/Sonnet-4.6 paths. (2026-07-01)
    thinking: options.thinking || { type: "disabled" },
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: toolsWithCache,
  };

  let workingMessages = normalizeLeadingRole([...messages]);
  let iterations = 0;
  let response;
  let turnIndex = 0;
  const usageAcc = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  const onTurnStart = typeof options.onTurnStart === "function" ? options.onTurnStart : null;
  if (onTurnStart) {
    try { await onTurnStart(turnIndex); } catch (err) {
      console.warn("[anthropic] onTurnStart hook failed:", err.message);
    }
  }

  response = await _post(apiKey, {
    ...baseParams,
    messages: applyCacheToLastMessage(workingMessages),
  }, route);
  if (response.usage) {
    usageAcc.input_tokens += response.usage.input_tokens || 0;
    usageAcc.output_tokens += response.usage.output_tokens || 0;
    usageAcc.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0;
    usageAcc.cache_read_input_tokens += response.usage.cache_read_input_tokens || 0;
  }

  while (response.stop_reason === "tool_use") {
    iterations++;
    if (iterations > MAX_TOOL_ITERATIONS) {
      // The model still wants tools but has spent its budget. Breaking here
      // leaves `response` holding only tool_use blocks, so extractText() returns
      // "" and the caller posts nothing -- the user watches the typing indicator
      // resolve to silence. Instead, feed the pending tool_use blocks a
      // "budget exhausted" result and make ONE final call with tool_choice
      // "none" so the model MUST answer in plain text from what it has.
      console.warn(`[anthropic] tool_loop_limit reached after ${iterations} iterations; forcing a final text answer`);
      const pendingAssistant = response.content || [];
      workingMessages.push({ role: "assistant", content: pendingAssistant });
      const pendingToolUses = pendingAssistant.filter(b => b.type === "tool_use");
      if (pendingToolUses.length > 0) {
        workingMessages.push({
          role: "user",
          content: pendingToolUses.map(b => ({
            type: "tool_result",
            tool_use_id: b.id,
            content:
              "Tool-call budget reached. Do not request any more tools. Answer the user " +
              "now in plain text using the information you already gathered.",
          })),
        });
      } else {
        workingMessages.push({
          role: "user",
          content:
            "Answer the user now in plain text using what you already have. Do not call any more tools.",
        });
      }
      try {
        response = await _post(apiKey, {
          ...baseParams,
          tool_choice: { type: "none" },
          messages: applyCacheToLastMessage(workingMessages),
        }, route);
        if (response.usage) {
          usageAcc.input_tokens += response.usage.input_tokens || 0;
          usageAcc.output_tokens += response.usage.output_tokens || 0;
          usageAcc.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0;
          usageAcc.cache_read_input_tokens += response.usage.cache_read_input_tokens || 0;
        }
      } catch (err) {
        console.error("[anthropic] forced final-answer call failed:", err.message);
      }
      break;
    }

    const assistantContent = response.content || [];
    workingMessages.push({ role: "assistant", content: assistantContent });

    const toolCalls = assistantContent.filter(b => b.type === "tool_use");
    console.log(`[anthropic] tool iteration ${iterations}: ${toolCalls.map(b => b.name).join(", ")}`);

    const toolResults = [];
    for (const block of toolCalls) {
      const handler = handlers[block.name];
      let resultContent;
      let isError = false;
      try {
        if (!handler) throw new Error(`Unknown tool: ${block.name}`);
        const raw = await handler(block.input, env, ctx);
        // A handler may return { toolResultContent: [...blocks] } to hand the
        // model a multimodal tool result (e.g. an image block so it can SEE a
        // GIF the user referenced). Otherwise the result is text/JSON.
        if (raw && typeof raw === "object" && Array.isArray(raw.toolResultContent)) {
          resultContent = raw.toolResultContent;
        } else {
          resultContent = typeof raw === "string" ? raw : JSON.stringify(raw).slice(0, 20000);
        }
      } catch (err) {
        console.error(`[anthropic] tool_error tool=${block.name}:`, err.message);
        resultContent = `Error: ${err.message}`;
        isError = true;
      }
      const result = {
        type: "tool_result",
        tool_use_id: block.id,
        content: resultContent,
      };
      if (isError) result.is_error = true;
      toolResults.push(result);

      // Surface each executed tool call so callers can build an action
      // breadcrumb for conversation memory. Best-effort: a throwing hook
      // must never break the tool loop.
      if (typeof options.onToolCall === "function") {
        try {
          // Pass resultContent (4th arg) so callers can retain identifiers the
          // tool RETURNED (invoice id, contact id, ticket number), not just the
          // inputs. A follow-up turn ("authorise it") needs the id that came
          // back, which the input-only breadcrumb dropped. Multimodal results
          // (arrays) are passed as-is; the summarizer ignores non-objects.
          options.onToolCall(block.name, block.input, isError, resultContent);
        } catch (err) {
          console.warn("[anthropic] onToolCall hook failed:", err.message);
        }
      }
    }

    workingMessages.push({ role: "user", content: toolResults });

    turnIndex++;
    if (onTurnStart) {
      try { await onTurnStart(turnIndex); } catch (err) {
        console.warn("[anthropic] onTurnStart hook failed:", err.message);
      }
    }

    response = await _post(apiKey, {
      ...baseParams,
      messages: applyCacheToLastMessage(workingMessages),
    }, route);
    if (response.usage) {
      usageAcc.input_tokens += response.usage.input_tokens || 0;
      usageAcc.output_tokens += response.usage.output_tokens || 0;
      usageAcc.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0;
      usageAcc.cache_read_input_tokens += response.usage.cache_read_input_tokens || 0;
    }
  }

  if (typeof options.onUsage === "function") {
    try { options.onUsage(usageAcc); } catch (e) { /* never break main flow */ }
  }
  return extractText(response);
}
