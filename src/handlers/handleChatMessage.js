// =============================================================================
// handlers/handleChatMessage.js - Config-driven Nexus chat callback entry point
//
// handleChatMessage(request, env, ctx, config) -> Promise<Response>
//
// This is the main exported function. Per-bot workers import this and wire
// it to POST /api/internal/chat-message. The bot-specific behavior (persona,
// tools, commands, trigger matching) is expressed entirely through the config
// object. See SPEC.md for the full config schema.
//
// Pipeline (in order):
//   1. Read raw body.
//   2. Verify HMAC (verifyNexusSignature). Reject 401 on failure.
//   3. Parse JSON payload. Reject 400 on failure.
//   4. Validate required fields (user_id, body, channel_slug). Reject 400.
//   5. Strip @mention tokens to produce userText. Reject 400 if empty.
//   6. !cmd dispatch (BEFORE the ambient gate).
//      Build foundation handlers (remember/forget/facts/clear/status) per-request
//      so they close over env + userId. Merge with config.commands. Dispatch
//      matching verb and return 200. Unknown !cmd falls through to LLM.
//   7. Ambient gate. If trigger_type="ambient" and config.triggers.ambient
//      returns false, return 200 { skipped: true }.
//   8. Return 202 immediately and push the LLM pipeline into ctx.waitUntil.
//      (Nexus aborts the inbound request at 8s; the tool loop takes 30+ seconds.)
//
// Hard rules:
//   - No module-level I/O. All fetch/crypto/Response calls are inside functions.
//   - Tool handler signature is (input, env, ctx). Always.
//   - No em dashes or en dashes.
//   - ES modules only.
// =============================================================================

import { verifyNexusSignature } from "../lib/callbackSign.js";
import { parseCommand } from "../lib/commandParser.js";
import { loadHistory, appendHistory } from "../lib/history.js";
import { rememberFact, forgetFact, listFacts, buildFactsBlock } from "../lib/memory.js";
import { callAnthropicWithTools } from "../lib/anthropic.js";
import { postToNexus } from "../lib/nexus.js";
import { postApprovalCard } from "../lib/hitl.js";
import { asEmbedCard, buildCommandTitle, colorForBot } from "../lib/embedCard.js";

// Nexus @mention token pattern (e.g. @robert, @bot_robert)
const MENTION_RE = /@\S+/g;

// Foundation command verbs built per-request (need env + user context)
const FOUNDATION_VERBS = new Set(["remember", "forget", "facts", "clear", "status"]);

/**
 * Strip @mention tokens from the message body.
 *
 * @param {string} body
 * @returns {string}
 */
function stripMention(body) {
  if (typeof body !== "string") return "";
  return body.replace(MENTION_RE, "").trim();
}

/**
 * Build a JSON response.
 *
 * @param {object} body
 * @param {number} [status=200]
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Build per-request foundation command handlers that close over env and userId.
 * These need runtime context (env bindings, historyKey) so they cannot be
 * defined statically.
 *
 * @param {object} env
 * @param {string} userId
 * @param {string} historyKey
 * @param {string} channel_slug - used for postToNexus inside status
 * @param {object} config - full bot config (for botName, displayName)
 * @param {object} nexusOptions - passed to postToNexus calls inside handlers
 * @returns {object} Map of verb -> async (cmdCtx) => void
 */
function buildFoundationHandlers(env, userId, historyKey, channel_slug, config, nexusOptions) {
  const botName = config.botName || "bot";
  const displayName = config.persona?.displayName || botName;

  return {
    remember: async (cmdCtx) => {
      const fact = cmdCtx.args.trim();
      if (!fact) {
        await cmdCtx.reply("Usage: `!remember <fact>`");
        return;
      }
      const id = await rememberFact(env, userId, fact, { dbBinding: config.dbBinding });
      if (id === null) {
        await cmdCtx.reply("Could not save that fact (DB unavailable).");
      } else {
        await cmdCtx.reply(`Remembered: ${fact}`);
      }
    },

    forget: async (cmdCtx) => {
      const q = cmdCtx.args.trim();
      if (!q) {
        await cmdCtx.reply("Usage: `!forget <text>`");
        return;
      }
      const count = await forgetFact(env, userId, q, { dbBinding: config.dbBinding });
      if (count === 0) {
        await cmdCtx.reply(`No memory matched "${q}".`);
      } else {
        await cmdCtx.reply(`Forgot ${count} item(s) matching "${q}".`);
      }
    },

    facts: async (cmdCtx) => {
      const facts = await listFacts(env, userId, { dbBinding: config.dbBinding });
      if (facts.length === 0) {
        await cmdCtx.reply("No facts remembered yet.");
        return;
      }
      const lines = [`**Facts (${facts.length})**`];
      facts.forEach((f, i) => lines.push(`${i + 1}. ${f.text}`));
      await cmdCtx.reply(lines.join("\n"));
    },

    clear: async (cmdCtx) => {
      const dbKey = config.dbBinding || "DB";
      const db = env[dbKey];
      if (db) {
        try {
          await db
            .prepare("DELETE FROM chat_history WHERE history_key = ?")
            .bind(historyKey)
            .run();
        } catch (err) {
          console.error("[handleChatMessage] clear history failed:", err.message);
        }
      }
      await cmdCtx.reply("Conversation history cleared.");
    },

    status: async (cmdCtx) => {
      const histDepth = await loadHistory(env, historyKey, { dbBinding: config.dbBinding })
        .then(h => h.length)
        .catch(() => 0);
      const enabledKey = `${botName.toUpperCase().replace(/-/g, "_")}_WORKER_ENABLED`;
      await cmdCtx.reply(
        `Chat history: ${histDepth} turns\nWorker: ${botName}-worker (CF Workers)\nEnabled: ${env[enabledKey] || "unknown"}`
      );
    },
  };
}

/**
 * Long-running LLM pipeline. Pulled out of handleChatMessage so the inbound
 * HTTP request can return 202 before this begins. All errors are caught and
 * logged -- this runs inside ctx.waitUntil with no caller to surface errors to.
 *
 * @param {object} args
 * @returns {Promise<void>}
 */
async function runLlmPipeline({
  env,
  user_id,
  display_name,
  channel_slug,
  userText,
  labeledUserText,
  historyKey,
  config,
}) {
  const nexusOptions = { nexusKeyEnvVar: config.nexusKeyEnvVar };
  const actionRegex = config.actionRegex || /<action>([\s\S]*?)<\/action>/;
  const systemPrompt = config.persona.systemPrompt;
  const approvalSlug = config.approvalSlug || "soc-approvals";

  let responseText;
  let history;

  try {
    history = await loadHistory(env, historyKey, { dbBinding: config.dbBinding });
    history.push({ role: "user", content: labeledUserText });

    const factsBlock = await buildFactsBlock(env, user_id, { dbBinding: config.dbBinding });
    const systemPromptWithFacts = factsBlock ? systemPrompt + factsBlock : systemPrompt;

    responseText = await callAnthropicWithTools(
      env,
      systemPromptWithFacts,
      history,
      config.tools.definitions || [],
      config.tools.handlers || {},
      { user_id, display_name, channel_slug },
    );
  } catch (err) {
    console.error("[handleChatMessage] pipeline error:", err.message);
    try {
      await postToNexus(
        env,
        channel_slug,
        "Hit a snag running that one. Try again in a moment or check the worker logs.",
        nexusOptions,
      );
    } catch { /* ignore */ }
    return;
  }

  // ---- <action> block detection --------------------------------------------
  const actionMatch = responseText.match(actionRegex);
  let visibleResponse = responseText;

  if (actionMatch) {
    let action = null;
    try {
      action = JSON.parse(actionMatch[1].trim());
    } catch (err) {
      console.warn("[handleChatMessage] could not parse <action> JSON:", err.message);
    }

    visibleResponse = responseText.replace(actionRegex, "").trim();

    if (action) {
      try {
        await postApprovalCard(env, {
          action,
          channelSlug: channel_slug,
          requesterUserId: user_id,
          summary: action.description || null,
        }, {
          approvalSlug,
          nexusKeyEnvVar: config.nexusKeyEnvVar,
          workerBaseUrlEnvVar: config.workerBaseUrlEnvVar || "WORKER_BASE_URL",
          dbBinding: config.dbBinding,
        });
        if (!visibleResponse) {
          await postToNexus(
            env,
            channel_slug,
            `Response action sent to ${approvalSlug} for authorization. Risk: ${(action.risk || "?").toUpperCase()}`,
            nexusOptions,
          );
        }
      } catch (err) {
        console.error("[handleChatMessage] HITL postApprovalCard error:", err.message);
      }
    }
  }

  // ---- Persist + post final response ---------------------------------------
  try {
    await appendHistory(env, historyKey, "user", labeledUserText, { dbBinding: config.dbBinding });
    await appendHistory(env, historyKey, "assistant", responseText, { dbBinding: config.dbBinding });
  } catch (err) {
    console.error("[handleChatMessage] history persist error:", err.message);
  }

  if (visibleResponse) {
    try {
      await postToNexus(env, channel_slug, visibleResponse, nexusOptions);
    } catch (err) {
      console.error("[handleChatMessage] nexus post error:", err.message);
    }
  }
}

/**
 * Handle POST /api/internal/chat-message
 *
 * @param {Request} request - Inbound CF Workers Request
 * @param {object} env - CF Workers environment bindings
 * @param {ExecutionContext} ctx - CF Workers execution context
 * @param {object} config - Per-bot configuration (see SPEC.md)
 * @returns {Promise<Response>}
 */
export async function handleChatMessage(request, env, ctx, config) {
  // ---- 1. Read raw body ----------------------------------------------------
  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return json({ success: false, error: "Could not read body" }, 400);
  }

  // ---- 2. Verify HMAC ------------------------------------------------------
  // Inbound HMAC secret comes from callbackSecretEnvVar when set (modern
  // two-secret pattern: callbackSecret inbound + nexusKey outbound), or
  // falls back to nexusKeyEnvVar (legacy single-secret pattern used by
  // robert-worker -- ROBERT_NEXUS_KEY does double duty there).
  const inboundSecretEnvVar = config.callbackSecretEnvVar || config.nexusKeyEnvVar;
  const secret = env[inboundSecretEnvVar];
  const authorized = await verifyNexusSignature(secret, rawBody, request.headers);
  if (!authorized) {
    return new Response("Unauthorized", { status: 401 });
  }

  // ---- 3. Parse JSON -------------------------------------------------------
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ success: false, error: "Invalid JSON" }, 400);
  }

  // ---- 4. Validate required fields -----------------------------------------
  const {
    user_id,
    display_name,
    body: msgBody,
    channel_slug,
    trigger_type,
    reply_to,
  } = payload || {};

  if (!user_id || !msgBody || !channel_slug) {
    return json({ success: false, error: "Missing required fields: user_id, body, channel_slug" }, 400);
  }

  const historyKey = `nexus:${user_id}`;

  // ---- 5. Strip @mention tokens --------------------------------------------
  const userText = stripMention(msgBody);
  if (!userText) {
    return json({ success: false, error: "Empty message after stripping mention" }, 400);
  }

  // ---- 6. !cmd dispatch (BEFORE the ambient gate) --------------------------
  // Collect the full known-verbs set: foundation + any bot-specific command
  // keys from config.commands. parseCommand uses this to filter false matches.
  const botCommandVerbs = config.commands ? Object.keys(config.commands) : [];
  const allKnownVerbs = new Set([...FOUNDATION_VERBS, ...botCommandVerbs]);

  const parsed = parseCommand(userText, allKnownVerbs);
  if (parsed) {
    const { verb, args } = parsed;

    const nexusOptions = { nexusKeyEnvVar: config.nexusKeyEnvVar };

    // Build per-request foundation handlers (close over env + userId)
    const foundationHandlers = buildFoundationHandlers(
      env, user_id, historyKey, channel_slug, config, nexusOptions
    );

    // Merge: bot-specific commands first, foundation fills in remaining slots.
    // Foundation verbs (remember/forget/facts/clear/status) cannot be overridden
    // unless the bot explicitly passes them in config.commands (which is fine).
    const mergedHandlers = { ...config.commands, ...foundationHandlers };

    const handler = mergedHandlers[verb];
    if (handler) {
      // Resolve the bot's default command-card color + canonical title once
      // per dispatch so per-reply wrapping is cheap.
      const botDisplayName = config.persona?.displayName || config.botName || "Bot";
      const defaultColor = config.commandColor || colorForBot(config.botName);
      // Per-bot verb -> title override map (config.commandTitles) lets each
      // worker spell its help/status cards naturally ("SOC Commands" instead
      // of just "Help") while every other verb falls back to the canonical
      // "<Bot> -- <Verb>" shape.
      const titleOverride = config.commandTitles && config.commandTitles[verb];
      const defaultTitle = titleOverride
        ? `${botDisplayName} -- ${titleOverride}`
        : buildCommandTitle(botDisplayName, verb);

      let replied = false;
      /**
       * Wrap a command reply in the Nexus rich-embed card markup unless the
       * caller opts out. Handlers can override the title and color per-call
       * (useful for severity-tinted !status output) or pass embed:false to
       * emit a raw chat reply that bypasses the visual treatment.
       *
       * Signature: reply(text, options?)
       *   options.title  string  override the auto-derived title
       *   options.color  string  override the bot's default color (hex)
       *   options.embed  boolean false => skip wrapper, post as-is
       */
      const cmdCtx = {
        verb,
        args,
        reply: async (text, options = {}) => {
          replied = true;
          const useEmbed = options.embed !== false;
          const finalText = useEmbed
            ? asEmbedCard(
                options.title || defaultTitle,
                String(text ?? ""),
                options.color || defaultColor,
              )
            : String(text ?? "");
          await postToNexus(env, channel_slug, finalText, nexusOptions);
        },
        user_id,
        display_name,
        channel_slug,
        env,
      };
      try {
        await handler(cmdCtx);
      } catch (err) {
        console.error(`[handleChatMessage] command error !${verb}:`, err.message);
        if (!replied) {
          // Surface command errors as a wrapped card too so the visual
          // contract holds even when a handler throws.
          const errBody = `Command error: ${err.message}`;
          await postToNexus(
            env,
            channel_slug,
            asEmbedCard(`${botDisplayName} -- Error`, errBody, defaultColor),
            nexusOptions,
          ).catch(() => {});
        }
      }
      return json({ success: true });
    }
    // Unknown !command falls through to LLM
  }

  // ---- 7. Ambient gate (checked AFTER !cmd so explicit commands always pass) -
  if (trigger_type === "ambient") {
    const ambientFn = config.triggers?.ambient;
    if (ambientFn && !ambientFn(msgBody, reply_to ?? null, null)) {
      return json({ success: true, skipped: true });
    }
  }

  // ---- 8. Deferred LLM pipeline -------------------------------------------
  // Nexus aborts the inbound callback fetch at 8s. The tool-use loop routinely
  // takes 30+ seconds. Return 202 immediately and push the pipeline into
  // ctx.waitUntil so it survives the client abort.
  const labeledUserText = `${display_name || user_id} (uid:${user_id}): ${userText}`;

  ctx.waitUntil(runLlmPipeline({
    env,
    user_id,
    display_name,
    channel_slug,
    userText,
    labeledUserText,
    historyKey,
    config,
  }));

  return json({ success: true, queued: true }, 202);
}
