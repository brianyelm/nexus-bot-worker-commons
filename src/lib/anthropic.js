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

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-opus-4-7";
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 60000;
const MAX_TOOL_ITERATIONS = 10;

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
 * Raw POST to the Anthropic Messages API.
 *
 * @param {string} apiKey
 * @param {object} body
 * @returns {Promise<object>} Parsed JSON response
 */
async function _post(apiKey, body) {
  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
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
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: applyCacheToLastMessage(messages),
  };

  const data = await _post(apiKey, body);
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
 * @param {(name: string, input: object, isError: boolean) => void} [options.onToolCall]
 *   Hook called once per executed tool_use block (after the handler runs).
 *   Used to accumulate an action breadcrumb for conversation memory. Errors
 *   in the hook are caught and never break the tool loop.
 * @returns {Promise<string>} Final assistant text
 */
export async function callAnthropicWithTools(env, systemPrompt, messages, tools, handlers, ctx = {}, options = {}) {
  const model = env.CLAUDE_MODEL || DEFAULT_MODEL;
  const apiKey = env.ANTHROPIC_API_KEY;

  if (!apiKey) throw new Error("[anthropic] ANTHROPIC_API_KEY is not configured");

  const toolsWithCache = applyCacheToTools(tools);

  const baseParams = {
    model,
    max_tokens: options.maxTokens || MAX_TOKENS,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: toolsWithCache,
  };

  let workingMessages = [...messages];
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
  });
  if (response.usage) {
    usageAcc.input_tokens += response.usage.input_tokens || 0;
    usageAcc.output_tokens += response.usage.output_tokens || 0;
    usageAcc.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0;
    usageAcc.cache_read_input_tokens += response.usage.cache_read_input_tokens || 0;
  }

  while (response.stop_reason === "tool_use") {
    iterations++;
    if (iterations > MAX_TOOL_ITERATIONS) {
      console.warn(`[anthropic] tool_loop_limit reached after ${iterations} iterations`);
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
        resultContent = typeof raw === "string" ? raw : JSON.stringify(raw).slice(0, 20000);
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
          options.onToolCall(block.name, block.input, isError);
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
    });
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
