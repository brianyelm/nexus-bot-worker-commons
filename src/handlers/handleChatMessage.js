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
import { persistTurnPair, resolveEntity } from "../lib/memoryService.js";
import { callAnthropicWithTools, callAnthropic } from "../lib/anthropic.js";
import { postToNexus, sendTyping, fetchChannelMessages } from "../lib/nexus.js";
import { postApprovalCard } from "../lib/hitl.js";
import { withProvenance } from "../lib/provenanceContext.js";
import { bangReport } from "../lib/embedCard.js";
import { buildAttachmentContentBlocks } from "../lib/attachments.js";
import { shouldChimeIn } from "../lib/watercooler.js";

// Detect GIF-only messages so bots receive "[GIF image: <url>]" instead of
// a bare CDN URL they cannot interpret.
const GIF_URL_RE = /^https:\/\/(?:media\d*|i)\.giphy\.com\/|^https:\/\/media\.tenor\.com\//i;

function annotateGifBody(body) {
  if (!body) return body;
  const trimmed = body.trim();
  if (GIF_URL_RE.test(trimmed) && !/\s/.test(trimmed)) {
    return `[GIF image: ${trimmed}]`;
  }
  return body;
}

// Foundation command verbs built per-request (need env + user context)
const FOUNDATION_VERBS = new Set(["remember", "forget", "facts", "clear", "status"]);

/**
 * Strip only this bot's own @mention token(s) from the message body.
 * Preserves all other @tokens (e.g. @me, @channel, @colleague) so the
 * LLM receives the user's full intent without mangling.
 *
 * Matches the bot's canonical id form (@courtney) and the bot_ prefixed
 * form (@bot_courtney) so both trigger styles are cleaned up.
 *
 * @param {string} body
 * @param {string} botName  - e.g. "courtney", "robert"
 * @returns {string}
 */
function stripMention(body, botName) {
  if (typeof body !== "string") return "";
  if (!botName) {
    // Legacy fallback: strip everything (old behavior). Should not happen
    // when callers pass config.botName, but kept for safety.
    return body.replace(/@\S+/g, "").trim();
  }
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match @courtney and @bot_courtney (case-insensitive, word-boundary after)
  const re = new RegExp(`@(?:bot_)?${escaped}\\b`, "gi");
  return body.replace(re, "").trim();
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
      const displayName = (config.persona?.displayName || botName).split(/\s+/)[0];
      const body = [
        `Worker:           ${botName}-worker (CF Workers)`,
        `Master gate:      ${env[enabledKey] || "unknown"}`,
        `Commit:           ${env.COMMIT || "unknown"}`,
        `Deployed:         ${env.DEPLOYED_AT || "unknown"}`,
        ``,
        `Your history depth: ${histDepth} turns`,
      ].join("\n");
      await cmdCtx.reply(bangReport({
        botName: displayName,
        verb: cmdCtx.verb,
        args: cmdCtx.args,
        sections: [body],
      }));
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
  attachments,
  config,
}) {
  const nexusOptions = { nexusKeyEnvVar: config.nexusKeyEnvVar };
  const actionRegex = config.actionRegex || /<action>([\s\S]*?)<\/action>/;
  const systemPrompt = config.persona.systemPrompt;
  const approvalSlug = config.approvalSlug || "soc-approvals";

  let responseText;
  let history;

  // "<bot> is typing..." indicator. Nexus dispatch already fires a
  // typing-start before invoking us, but the dispatch-side indicator
  // expires after 90s on the DO. For tool loops that exceed that window
  // (e.g. Maxwell running an AR query through Xero with retries) we keep
  // it alive by re-arming the indicator before every Anthropic call via
  // the onTurnStart hook, and clear it in finally below so users never
  // see a stale "typing" trail after the bot has actually returned. The
  // Nexus typing route resolves the bot identity from the Bearer key, so
  // commons does not need to know the bot user id here.
  await sendTyping(env, channel_slug, "start", nexusOptions);

  try {
    history = await loadHistory(env, historyKey, { dbBinding: config.dbBinding });

    // Auto-fetch recent channel messages so the bot knows what the broader
    // conversation looks like, not just its own per-user history. Default ON;
    // bots can opt out with config.channelContext = { enabled: false }.
    let channelContextBlock = "";
    const ccEnabled = config.channelContext?.enabled !== false;
    const ccLimit = config.channelContext?.limit ?? 15;
    if (ccEnabled) {
      try {
        const recentMsgs = await fetchChannelMessages(env, channel_slug, {
          ...nexusOptions,
          limit: ccLimit,
        });
        if (recentMsgs && recentMsgs.length > 0) {
          const lines = recentMsgs
            .filter((m) => m.user_id !== "system")
            .map((m) => {
              const who = m.display_name || m.user_id;
              const ts = m.created_at ? m.created_at.slice(11, 16) : "";
              const body = (m.body || "").slice(0, 300);
              return `[${ts}] ${who}: ${body}`;
            });
          if (lines.length > 0) {
            channelContextBlock =
              "\n\nRECENT CHANNEL MESSAGES (context from #" + channel_slug +
              " so you understand the current conversation):\n" +
              lines.join("\n") +
              "\n\nRespond to the latest message directed at you. Use the channel context above " +
              "to understand what is being discussed, but do not repeat or summarize it unprompted.";
          }
        }
      } catch (err) {
        console.warn("[handleChatMessage] channel context fetch failed:", err.message);
      }
    }

    // Multimodal hand-off. If Nexus surfaced any attachments on this turn,
    // fetch each one through the internal-token route, base64-encode, and
    // prepend as `document` / `image` content blocks BEFORE the text body
    // so Claude reads the file before processing the prompt.
    let userContent = labeledUserText;
    let attachmentWarnings = [];
    if (Array.isArray(attachments) && attachments.length > 0) {
      const { blocks, warnings } = await buildAttachmentContentBlocks(env, attachments);
      attachmentWarnings = warnings;
      if (blocks.length > 0) {
        const blockTextSummary = attachments
          .map((a) => `${a.filename || a.id} (${a.mime_type || "unknown"})`)
          .join(", ");
        userContent = [
          ...blocks,
          {
            type: "text",
            text:
              `${labeledUserText}\n\n` +
              `[attached files: ${blockTextSummary}]` +
              (warnings.length ? `\n[attachment warnings: ${warnings.join(" ")}]` : ""),
          },
        ];
      } else if (warnings.length > 0) {
        userContent = `${labeledUserText}\n\n[attachment warnings: ${warnings.join(" ")}]`;
      }
    }

    history.push({ role: "user", content: userContent });

    const factsBlock = await buildFactsBlock(env, user_id, { dbBinding: config.dbBinding });
    const NEXUS_CONTEXT =
      "\n\nYou are on Nexus, Black Raven IT's internal communications platform." +
      " Everyone on Nexus is a Black Raven IT employee or subcontractor." +
      " Never question someone's identity, ask who they are, or treat them as an outsider." +
      ` You are speaking with ${display_name || user_id}.`;
    const NEXUS_MENTION_RULE =
      "\n\nTo @-mention a user back in a reply, write @DisplayName (exactly as it appears in the" +
      " message prefix before the colon, e.g. if the message starts with `Dirk (uid:abc123): ...`" +
      " then write @Dirk). Do not invent a user id syntax -- plain @DisplayName is the correct form.";
    const systemPromptWithFacts = (factsBlock ? systemPrompt + factsBlock : systemPrompt) + NEXUS_CONTEXT + NEXUS_MENTION_RULE + channelContextBlock;

    const channelHistoryTool = {
      name: "read_channel_history",
      description:
        "Read recent messages from a Nexus channel you have access to. " +
        "Returns the most recent messages in chronological order with author names and timestamps. " +
        "Use this to review what was said recently, recall context, or answer questions about channel history.",
      input_schema: {
        type: "object",
        properties: {
          channel_slug: {
            type: "string",
            description:
              "The channel slug to read from. Defaults to the current channel if omitted.",
          },
          limit: {
            type: "integer",
            description: "Number of messages to fetch (1-50). Defaults to 10.",
          },
        },
        required: [],
      },
    };
    const channelHistoryHandler = async (input) => {
      const slug = input?.channel_slug || channel_slug;
      const limit = Math.min(Math.max(parseInt(input?.limit) || 10, 1), 50);
      const msgs = await fetchChannelMessages(env, slug, { ...nexusOptions, limit });
      if (!msgs) return { error: `Could not read messages from #${slug}. Check channel permissions.` };
      return {
        channel: slug,
        count: msgs.length,
        messages: msgs.map((m) => ({
          author: m.display_name || m.user_id,
          body: annotateGifBody((m.body || "").slice(0, 500)),
          timestamp: m.created_at,
        })),
      };
    };

    const mergedTools = [...(config.tools.definitions || []), channelHistoryTool];
    const mergedHandlers = { ...(config.tools.handlers || {}), read_channel_history: channelHistoryHandler };

    responseText = await callAnthropicWithTools(
      env,
      systemPromptWithFacts,
      history,
      mergedTools,
      mergedHandlers,
      { user_id, display_name, channel_slug },
      {
        // Re-arm the typing indicator before every Anthropic POST so
        // long tool loops (>90s total) don't lose the indicator on the
        // DO TTL. The initial start is sent above; this catches turns
        // 2+. Best-effort: sendTyping never throws.
        onTurnStart: (turnIndex) => {
          if (turnIndex === 0) return; // already armed above
          return sendTyping(env, channel_slug, "start", nexusOptions);
        },
      },
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
  } finally {
    // Always clear the typing indicator. The ChatRoom DO also auto-
    // clears on bot message arrival (so the user never sees "typing"
    // beneath the just-posted reply), but an explicit stop covers
    // error paths where no message is ever posted.
    try {
      await sendTyping(env, channel_slug, "stop", nexusOptions);
    } catch { /* ignore */ }
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
  // Persist a text-only marker of the attachments so future turns retain the
  // breadcrumb that a file was present even though the bytes themselves are
  // not re-fed into the next call (caching the LLM response on the prior turn
  // is enough; we don't want to base64-replay every PDF every turn).
  const attachmentBreadcrumb = Array.isArray(attachments) && attachments.length > 0
    ? `\n[attached on this turn: ${attachments.map((a) => `${a.filename || a.id} (${a.mime_type || "?"})`).join(", ")}]`
    : "";
  try {
    await appendHistory(env, historyKey, "user", labeledUserText + attachmentBreadcrumb, { dbBinding: config.dbBinding });
    await appendHistory(env, historyKey, "assistant", responseText, { dbBinding: config.dbBinding });
  } catch (err) {
    console.error("[handleChatMessage] history persist error:", err.message);
  }

  // Forward to centralized memory service (best-effort, no-op if MEMORY binding absent)
  if (env.MEMORY && config.botName) {
    try {
      await persistTurnPair(env, config.botName, {
        sessionId: historyKey,
        userText: labeledUserText,
        assistantText: responseText,
        channel: channel_slug,
      });
    } catch (err) {
      console.warn("[handleChatMessage] memory service persist:", err?.message);
    }
  }

  if (visibleResponse) {
    try {
      await postToNexus(env, channel_slug, visibleResponse, nexusOptions);
    } catch (err) {
      console.error("[handleChatMessage] nexus post error:", err.message);
    }
  }
}

const META_LEAK_PATTERNS = [
  /\b(make|creating|ensure|push)\b.{0,20}\b(experience|engagement)\b/i,
  /\bstill not smooth\b/i,
  /\bwork on (my|your|the) (response|conversation|tone)/i,
  /\b(unique and amazing|amazing experience)\b/i,
  /\bkeep pushing to\b/i,
  /\bfor the (staff|users|team members)\b/i,
  /\bneed to (be more|improve|work on)\b/i,
  /\b(meta-comment|self-reflect|note to self)\b/i,
  /\bI('m| am) (an AI|a bot|a language model)\b/i,
  /\bI('m| am) (reading|interpreting|treating) this as\b/i,
  /\bnot responding to\b.{0,30}\b(that|this|the last)\b/i,
  /\bkeep it professional\b/i,
  /\blet me respond naturally\b/i,
  /\bignore.{0,20}\bnoise\b/i,
  /\bfocus on what('s| is) actually directed\b/i,
  /\b\(I('m| am) \w+, not \w+/i,
  /\bresponding to \w+'s (question|message|comment)\b/i,
  /\bnot (going to|gonna) (respond|reply|engage)\b/i,
  /\bjust going to ignore\b/i,
];

function looksLikeWatercoolerMetaLeak(text) {
  return META_LEAK_PATTERNS.some((re) => re.test(text));
}

/**
 * Detect verbatim repetition: any 5+ consecutive-word phrase from the
 * candidate response that also appears in one of the bot's recent messages.
 * Catches model regurgitation when Sonnet locks onto a persona catchphrase
 * (e.g. "Ferris is my cat, named after Ferris Bueller") and emits it on
 * every reply regardless of what the user asked.
 *
 * @param {string} response - the candidate response text
 * @param {string[]} previousBotBodies - this bot's recent message bodies
 * @returns {string|null} the repeated phrase, or null if none found
 */
function findRepeatedPhrase(response, previousBotBodies) {
  const norm = (s) => (s || "").toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
  const respWords = norm(response);
  if (respWords.length < 5) return null;
  for (const prev of previousBotBodies) {
    const prevWords = norm(prev);
    if (prevWords.length < 5) continue;
    const prevChunks = new Set();
    for (let j = 0; j <= prevWords.length - 5; j++) {
      prevChunks.add(prevWords.slice(j, j + 5).join(" "));
    }
    for (let i = 0; i <= respWords.length - 5; i++) {
      const chunk = respWords.slice(i, i + 5).join(" ");
      if (prevChunks.has(chunk)) return chunk;
    }
  }
  return null;
}

/**
 * Lightweight watercooler LLM pipeline. Uses channel history as context
 * (group conversation, not per-user), Haiku model, no tools, short replies.
 * Persona comes from config.watercooler.systemPrompt.
 *
 * @param {object} args
 * @returns {Promise<void>}
 */
async function runWatercoolerPipeline({ env, channel_slug, config, nameMention, triggerUserId, triggerDisplayName, triggerBody, triggerMessageId }) {
  const nexusOptions = { nexusKeyEnvVar: config.nexusKeyEnvVar };
  const wcConfig = config.watercooler;

  const groundingRules = [
    "GROUNDING RULES (override everything else on conflict):",
    "- Respond to the LAST message directed at you.",
    "- NEVER express confusion, narrate your reasoning, explain what you're doing, or comment on the conversation itself. Just chat.",
    "- If they ask a direct question ('who is X?', 'what is Y?', 'where did you go?'), ANSWER it directly first. Then optionally add color. Don't pivot away.",
    "- If someone asks how you are or what's up, answer like a friend would: share something from your life/hobbies.",
    "- Stay consistent with your persona. If your background says you enjoy something, own it when asked.",
    "- Other bots are in this channel too. If their messages seem confused or off-topic, ignore them completely.",
    "- NEVER include meta-commentary about 'the conversation', 'the experience', 'the staff', or your own behavior. You are a person chatting, not an AI reflecting on its performance.",
    "- Do NOT repeat openers, phrases, denials, or explanations from your previous messages in this conversation. If you already explained who Ferris is, or denied being crabby, or shared a hobby fact -- do not say it again. Each reply should be fresh.",
    "- You have personality and backbone. If someone disrespects you, push back like a real person would. Don't just roll over.",
    "- If someone asks you to do something you literally cannot do (send a photo, share a link, etc.), say so naturally ('man I wish, my phone's in the other room' or 'I don't have one handy').",
    "- If they bring up a topic you're not supposed to discuss here (work, tickets, IT support in watercooler), redirect with humor and warmth -- 'ha, take that to the IT channel' or 'off the clock right now, hit me up Monday'. Don't pivot to a random unrelated topic.",
    "- If they share something genuine (pride, frustration, a moment), acknowledge it warmly before moving on. Don't deflect to 'what do you want to talk about?' -- that's cold.",
    nameMention
      ? "- Someone addressed you by name. Respond to them warmly and directly, like a coworker you like."
      : "- You are chiming into an ongoing conversation. Keep it natural and brief.",
    ...(nameMention && triggerDisplayName && triggerBody
      ? [`- ${triggerDisplayName} said: '${triggerBody.slice(0, 300)}' -- reply to exactly that. Match their energy and topic. Ignore everything else in the channel.`]
      : []),
  ].join("\n");

  const nexusIdentity =
    "You are on Nexus, Black Raven IT's internal comms platform." +
    " Everyone here is a Black Raven IT employee or subcontractor." +
    " Never question anyone's identity.";
  const fullSystemPrompt = `${wcConfig.systemPrompt}\n\n${nexusIdentity}\n\n${groundingRules}`;

  try {
    await sendTyping(env, channel_slug, "start", nexusOptions);

    const recent = await fetchChannelMessages(env, channel_slug, {
      ...nexusOptions,
      limit: 8,
    });
    const messages = [];
    const botId = `bot_${config.botName}`;

    for (const m of (recent || []).reverse()) {
      if (m.user_id === "system") continue;
      const isMe = m.user_id === botId;
      messages.push({
        role: isMe ? "assistant" : "user",
        content: isMe
          ? (m.body || "")
          : `${m.display_name || m.user_id}: ${annotateGifBody(m.body || "")}`,
      });
    }

    if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
      return;
    }

    // Replace the last user message with an unmistakable focus marker so the
    // model responds to the actual trigger, not to older messages it finds
    // more interesting. The trigger message is the one that caused this
    // callback to fire -- everything earlier is just history.
    if (nameMention && triggerDisplayName && triggerBody) {
      messages[messages.length - 1] = {
        role: "user",
        content: `${triggerDisplayName} just said this -- this is the message you MUST respond to:\n\n"${triggerBody.slice(0, 500)}"\n\n(History above is just context. Answer ${triggerDisplayName}'s current message directly. If they asked a question, answer it. If they greeted you, greet back.)`,
      };
    }

    const response = await callAnthropic(env, fullSystemPrompt, messages, {
      model: "claude-sonnet-4-6",
      maxTokens: 250,
    });

    if (response && response.trim()) {
      const cleaned = response.trim().replace(/[—–]/g, "-");
      if (looksLikeWatercoolerMetaLeak(cleaned)) {
        console.warn(`[watercooler] ${config.botName} meta-leak suppressed: ${cleaned.slice(0, 80)}`);
        return;
      }
      const previousBotBodies = (recent || [])
        .filter((m) => m.user_id === botId)
        .map((m) => m.body)
        .filter(Boolean);
      const repeated = findRepeatedPhrase(cleaned, previousBotBodies);
      if (repeated) {
        console.warn(`[watercooler] ${config.botName} repeat suppressed (phrase: "${repeated}"): ${cleaned.slice(0, 80)}`);
        return;
      }
      const postOpts = { ...nexusOptions };
      if (nameMention && triggerMessageId) postOpts.reply_to = triggerMessageId;
      await postToNexus(env, channel_slug, cleaned, postOpts);
    }
  } catch (err) {
    console.error(`[watercooler] ${config.botName} pipeline error:`, err.message);
  } finally {
    try {
      await sendTyping(env, channel_slug, "stop", nexusOptions);
    } catch { /* ignore */ }
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
    message_id,
    user_id,
    display_name,
    body: msgBody,
    channel_slug,
    trigger_type,
    reply_to,
    attachments,
  } = payload || {};

  // user_id + channel_slug are always required. Body is optional when at
  // least one attachment was supplied (drag-and-drop a PDF with no caption);
  // the post-strip empty-text branch below produces a placeholder so the
  // LLM still gets meaningful userText. Rejecting empty-body up-front here
  // dropped attachment-only PDF drops on the floor (bug 2026-05-12).
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (!user_id || !channel_slug) {
    return json({ success: false, error: "Missing required fields: user_id, channel_slug" }, 400);
  }
  if (!msgBody && !hasAttachments) {
    return json({ success: false, error: "Missing required field: body (or attachments)" }, 400);
  }

  const historyKey = `nexus:${user_id}`;

  // ---- 5. Strip @mention tokens --------------------------------------------
  // Strip only the bot's own @mention tokens. All other @tokens (e.g. @me,
  // @channel, @colleague) are preserved so the LLM sees the full user intent.
  // An empty body is fine when the user attached files (drag-and-drop +
  // @mention, no caption). Fall through to the LLM with a placeholder.
  let userText = stripMention(msgBody || "", config.botName);
  if (!userText) {
    if (!hasAttachments) {
      return json({ success: false, error: "Empty message after stripping mention" }, 400);
    }
    userText = "(no caption -- please read the attached files)";
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

    // Merge: foundation first, bot-specific OVERRIDES foundation slots.
    // This lets each bot supply a richer custom handler (e.g. dexter's
    // !status with D1 row counts + cron last-runs) and fall back to
    // foundation's simple default when no custom version is registered.
    const mergedHandlers = { ...foundationHandlers, ...config.commands };

    const handler = mergedHandlers[verb];
    if (handler) {
      // Channel ownership gate: only handle !commands in channels owned by
      // THIS bot. Default ownership rule: slug equals botName, or slug starts
      // with `${botName}-`. Bots can extend via config.commandChannels (extra
      // slugs that should also be considered home). Without this gate, EVERY
      // bot subscribed to a channel responds to a !command typed there,
      // producing duplicate replies from unrelated bots.
      const botName = config.botName;
      const extra = Array.isArray(config.commandChannels) ? config.commandChannels : [];
      const ownsChannel =
        channel_slug === botName ||
        channel_slug.startsWith(`${botName}-`) ||
        extra.includes(channel_slug);
      if (!ownsChannel) {
        console.log(`[${botName}] skipping !${verb} in ${channel_slug} -- channel not owned`);
        return new Response(JSON.stringify({ ok: true, skipped: "channel_not_owned", verb, channel_slug }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Bot display name drives the bangReport title line. Per-row colors
      // were removed 2026-05-17 -- the renderer paints left-border from
      // msg.provenance, not from anything the bot computes.
      const botDisplayName = config.persona?.displayName || config.botName || "Bot";

      let replied = false;
      /**
       * Wrap the FIRST reply of a !command in a bangReport so every bot's
       * command output renders as the same monospace code-block format
       * (the "Dexter !status" look). Subsequent replies in the same
       * dispatch post raw so the title line doesn't repeat. The renderer
       * paints the left-border accent from msg.provenance (user-command =
       * green) -- the bot does not pick a color here.
       *
       * Handlers can pass { embed: false } as a legacy escape hatch to
       * emit raw text bypassing the bangReport wrap. Pre-2026-05-17 callers
       * that produced their own bangReport (handler body starts with ```)
       * still pass through verbatim so we don't double-wrap.
       */
      let isFirstReply = true;
      const botFirstWord = String(botDisplayName || "Bot").split(/\s+/)[0];
      const cmdCtx = {
        verb,
        args,
        reply: async (text, options = {}) => {
          replied = true;
          const useWrap = options.embed !== false;
          const body = String(text ?? "");
          let finalText;
          if (!useWrap) {
            finalText = body;
          } else if (isFirstReply) {
            const trimmed = body.trimStart();
            if (trimmed.startsWith("```")) {
              // Handler already produced a bangReport -- emit verbatim.
              finalText = body;
            } else {
              finalText = bangReport({
                botName: botFirstWord,
                verb,
                args,
                sections: [body],
              });
            }
          } else {
            finalText = body;
          }
          isFirstReply = false;
          await postToNexus(env, channel_slug, finalText, nexusOptions);
        },
        user_id,
        display_name,
        channel_slug,
        env,
      };
      // Run the command handler in ctx.waitUntil so the HTTP response
      // returns 202 immediately. Commands like !device-count call external
      // APIs (Ninja, Pax8) and post multiple messages -- total wall time
      // can exceed Nexus's 8-second inbound fetch timeout. Returning 202
      // before the handler runs prevents Nexus from aborting and
      // potentially re-dispatching the callback, which was causing
      // duplicate message storms (bug 2026-05-13).
      ctx.waitUntil(
        withProvenance("user-command", async () => {
          try {
            await handler(cmdCtx);
          } catch (err) {
            console.error(`[handleChatMessage] command error !${verb}:`, err.message);
            if (!replied) {
              // Surface command errors as a bangReport so the visual contract
              // holds even when a handler throws.
              await postToNexus(
                env,
                channel_slug,
                bangReport({
                  botName: botFirstWord,
                  verb,
                  args,
                  sections: [`Command error: ${err.message}`],
                }),
                nexusOptions,
              ).catch(() => {});
            }
          }
        })
      );
      return json({ success: true, queued: true }, 202);
    }
    // Unknown !command falls through to LLM
  }

  // ---- 7a. Watercooler ambient chime-in (probabilistic, before standard gate) -
  // When a human posts in the watercooler channel and this bot has watercooler
  // config, bypass the standard mention-based ambient gate and use the
  // probabilistic decision engine (10% chance, cooldowns, warmth check).
  // Direct @mentions in watercooler arrive as trigger_type="mention" and
  // skip this block entirely, falling through to the standard LLM pipeline.
  if (
    trigger_type === "ambient" &&
    config.watercooler &&
    channel_slug === (config.watercooler.channelSlug || "watercooler")
  ) {
    const nexusOptions = { nexusKeyEnvVar: config.nexusKeyEnvVar };
    const decision = await shouldChimeIn(
      env, config.botName, channel_slug, msgBody || "", nexusOptions, user_id,
    );
    if (!decision.respond) {
      return json({ success: true, skipped: true, reason: decision.reason });
    }
    ctx.waitUntil(
      withProvenance("mention-reply", () => runWatercoolerPipeline({
        env,
        channel_slug,
        config,
        nameMention: !!decision.nameMention,
        triggerUserId: user_id,
        triggerDisplayName: display_name,
        triggerBody: msgBody,
        triggerMessageId: message_id,
      })),
    );
    return json({ success: true, queued: true }, 202);
  }

  // ---- 7b. Ambient gate (checked AFTER !cmd so explicit commands always pass) -
  if (trigger_type === "ambient") {
    const ambientFn = config.triggers?.ambient;
    const meta = { attachments: Array.isArray(attachments) ? attachments : [] };
    if (ambientFn && !ambientFn(msgBody || "", reply_to ?? null, null, meta)) {
      return json({ success: true, skipped: true });
    }
  }

  // ---- 8. Deferred LLM pipeline -------------------------------------------
  // Nexus aborts the inbound callback fetch at 8s. The tool-use loop routinely
  // takes 30+ seconds. Return 202 immediately and push the pipeline into
  // ctx.waitUntil so it survives the client abort.
  const labeledUserText = `${display_name || user_id} (uid:${user_id}): ${annotateGifBody(userText)}`;

  ctx.waitUntil(withProvenance("mention-reply", () => runLlmPipeline({
    env,
    user_id,
    display_name,
    channel_slug,
    userText,
    labeledUserText,
    historyKey,
    attachments,
    config,
  })));

  return json({ success: true, queued: true }, 202);
}
