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
import { postToNexus, sendTyping, fetchChannelMessages, fetchThreadMessages } from "../lib/nexus.js";
import { postApprovalCard } from "../lib/hitl.js";
import { withProvenance } from "../lib/provenanceContext.js";
import { bangReport } from "../lib/embedCard.js";
import { buildAttachmentContentBlocks } from "../lib/attachments.js";
import { shouldChimeIn } from "../lib/watercooler.js";
import { phoenixToday } from "../lib/format.js";

// Detect GIF-only messages so bots receive "[GIF image: <url>]" instead of
// a bare CDN URL they cannot interpret.
const GIF_URL_RE = /^https:\/\/(?:media\d*|i)\.giphy\.com\/|^https:\/\/media\.tenor\.com\//i;

/**
 * Hand a chat-message job to the bot's LlmRoom Durable Object so the LLM
 * tool loop runs outside the calling worker's 30s waitUntil ceiling. Falls
 * back to inline withProvenance + runLlmPipeline when the DO binding is
 * absent (legacy bots that haven't migrated yet).
 *
 * @param {object} env - worker bindings (DO binding read via config.llmRoomBinding)
 * @param {string} historyKey - "nexus:<user_id>", used as DO instance name suffix
 * @param {object} job - serializable payload (no functions); pipeline args + provenance
 * @param {object} config - bot config (NOT serialized; the DO subclass imports it itself)
 * @returns {Promise<void>}
 */
async function dispatchLlmJob(env, historyKey, job, config) {
  const bindingName = config.llmRoomBinding || "LLM_ROOM";
  const ns = env[bindingName];

  if (!ns || typeof ns.idFromName !== "function") {
    console.warn(`[handleChatMessage] no ${bindingName} DO binding; running inline (may hit 30s waitUntil cap)`);
    try {
      await withProvenance(job.provenance || "mention-reply", () =>
        runLlmPipeline({ env, ...job, config })
      );
    } catch (err) {
      console.error("[handleChatMessage] inline pipeline error:", err?.message);
    }
    return;
  }

  const id = ns.idFromName(`${config.botName || "bot"}:${historyKey}`);
  const stub = ns.get(id);

  try {
    const res = await stub.fetch("https://llm-room.internal/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[handleChatMessage] LlmRoom dispatch non-2xx ${res.status}: ${txt.slice(0, 200)}`);
    }
  } catch (err) {
    console.error("[handleChatMessage] LlmRoom dispatch failed:", err?.message);
  }
}

function annotateGifBody(body) {
  if (!body) return body;
  const trimmed = body.trim();
  if (GIF_URL_RE.test(trimmed) && !/\s/.test(trimmed)) {
    return `[GIF image: ${trimmed}]`;
  }
  return body;
}

// Foundation command verbs built per-request (need env + user context)
const FOUNDATION_VERBS = new Set(["remember", "forget", "facts", "clear", "status", "fleet"]);

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
 * Exported so voice surfaces (each bot's tools/bangCommand.js) can reuse the
 * same handlers via run_bang_command without re-implementing them.
 *
 * @param {object} env
 * @param {string} userId
 * @param {string} historyKey
 * @param {string} channel_slug - used for postToNexus inside status
 * @param {object} config - full bot config (for botName, displayName)
 * @param {object} nexusOptions - passed to postToNexus calls inside handlers
 * @returns {object} Map of verb -> async (cmdCtx) => void
 */
export function buildFoundationHandlers(env, userId, historyKey, channel_slug, config, nexusOptions) {
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

    fleet: async (cmdCtx) => {
      const displayName = (config.persona?.displayName || botName).split(/\s+/)[0];
      const apiKey = env[config.nexusKeyEnvVar];
      if (!apiKey || !env.NEXUS_BASE_URL) {
        await cmdCtx.reply(bangReport({
          botName: displayName,
          verb: cmdCtx.verb,
          args: cmdCtx.args,
          sections: ["Cannot query fleet: NEXUS_BASE_URL or bot key not set."],
        }));
        return;
      }
      let bots = [];
      let generatedAt = null;
      let fetchErr = null;
      try {
        const res = await fetch(`${env.NEXUS_BASE_URL}/api/bot/fleet/status`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          fetchErr = `HTTP ${res.status}: ${txt.slice(0, 200)}`;
        } else {
          const j = await res.json();
          bots = j?.data?.bots || [];
          generatedAt = j?.data?.generated_at || null;
        }
      } catch (err) {
        fetchErr = err?.message || String(err);
      }
      if (fetchErr) {
        await cmdCtx.reply(bangReport({
          botName: displayName,
          verb: cmdCtx.verb,
          args: cmdCtx.args,
          sections: [`Fleet status fetch failed: ${fetchErr}`],
        }));
        return;
      }
      // Build a pm2-style table:
      //   Status  Bot        Commit    Deployed                  Latency
      const header = "Status  Bot          Commit    Deployed                 Latency";
      const sep = "-".repeat(header.length);
      const rows = bots.map((b) => {
        const ok = b.health_ok && b.version_ok && !b.error;
        const status = ok ? "  OK  " : " FAIL ";
        const name = String(b.name || "").padEnd(11);
        const commit = (b.commit ? String(b.commit) : "--------").slice(0, 8);
        const deployedRaw = b.deployed_at ? String(b.deployed_at) : "(unknown)";
        const deployed = deployedRaw.padEnd(24).slice(0, 24);
        const ms = String(b.latency_ms ?? 0).padStart(4) + "ms";
        return `${status}  ${name} ${commit}  ${deployed}  ${ms}`;
      });
      const errLines = bots
        .filter((b) => b.error || !b.health_ok || !b.version_ok)
        .map((b) => `  ${b.name}: ${b.error || `health=${b.health_status} version_ok=${b.version_ok}`}`);
      // bangReport already emits its own "Generated:" line; skip duplicating it.
      const sections = [header, sep, ...rows];
      if (errLines.length > 0) sections.push("", "Issues:", ...errLines);
      await cmdCtx.reply(bangReport({
        botName: displayName,
        verb: cmdCtx.verb,
        args: cmdCtx.args,
        sections: [sections.join("\n")],
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
export async function runLlmPipeline({
  env,
  user_id,
  user_email,
  display_name,
  channel_slug,
  userText,
  labeledUserText,
  historyKey,
  attachments,
  reply_to,
  config,
}) {
  const nexusOptions = { nexusKeyEnvVar: config.nexusKeyEnvVar };
  // When the triggering message was part of a thread, reply_to is the
  // parent message id. Thread the same reply_to into every outbound post
  // so the bot's response lands in the same thread as the user's message.
  if (reply_to) nexusOptions.reply_to = reply_to;
  // When replying in a thread, scope every "<bot> is typing..." frame to
  // that thread panel only. Without thread_id the indicator surfaces in
  // the parent channel's bottom-row footer, which is confusing when the
  // bot is actually conversing inside a thread side panel.
  const typingOptions = { ...nexusOptions };
  if (reply_to) typingOptions.thread_id = reply_to;
  const actionRegex = config.actionRegex || /<action>([\s\S]*?)<\/action>/;
  const systemPrompt = config.persona.systemPrompt;
  const approvalSlug = config.approvalSlug || "soc-approvals";

  let responseText;
  let capturedUsage = null;
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
  await sendTyping(env, channel_slug, "start", typingOptions);

  try {
    history = await loadHistory(env, historyKey, { dbBinding: config.dbBinding });

    // Auto-fetch recent channel messages so the bot knows what the broader
    // conversation looks like, not just its own per-user history. Default ON;
    // bots can opt out with config.channelContext = { enabled: false }.
    //
    // When reply_to is set, ALSO fetch the full thread (parent + replies) so
    // the bot can read everything said in this side-conversation -- the EC2
    // bots used to scroll back automatically when @mentioned in a thread, and
    // the worker port had been only pulling the parent channel feed (which
    // often did not include older thread replies). Brian flagged this as a
    // migration regression 2026-05-23.
    let channelContextBlock = "";
    let threadContextBlock = "";
    const ccEnabled = config.channelContext?.enabled !== false;
    const ccLimit = config.channelContext?.limit ?? 15;
    if (reply_to) {
      try {
        const thread = await fetchThreadMessages(env, reply_to, nexusOptions);
        if (thread && (thread.parent || (Array.isArray(thread.replies) && thread.replies.length > 0))) {
          const lines = [];
          const fmtRow = (m) => {
            const who = m.display_name || m.user_id || "unknown";
            let ts = "";
            if (m.created_at !== undefined && m.created_at !== null) {
              const d = new Date(m.created_at);
              if (!Number.isNaN(d.getTime())) ts = d.toISOString().slice(11, 16);
            }
            const body = (m.body || "").slice(0, 600);
            const atts = Array.isArray(m.attachments) ? m.attachments : [];
            const attSuffix = atts.length
              ? ` [attachments: ${atts.map((a) => `${a.filename || a.id} (${a.mime_type || "?"}, id=${a.id})`).join(", ")}]`
              : "";
            return `[${ts}] ${who}: ${body}${attSuffix}`;
          };
          if (thread.parent) lines.push(`(thread parent) ${fmtRow(thread.parent)}`);
          for (const r of thread.replies || []) {
            if (r.user_id === "system") continue;
            lines.push(fmtRow(r));
          }
          if (lines.length > 0) {
            threadContextBlock =
              "\n\nTHREAD CONTEXT (this @mention came from inside a thread -- here is the full thread you are replying inside, oldest to newest):\n" +
              lines.join("\n") +
              "\n\nReply to the most recent message above. The user expects you to have read the whole thread; do not ask them to repeat themselves. Your reply will be posted inside this same thread.";
          }
        }
      } catch (err) {
        console.warn("[handleChatMessage] thread context fetch failed:", err.message);
      }
    }
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
              // Nexus returns created_at as a number (epoch ms) since the
              // schema column is INTEGER; older code paths returned ISO
              // strings. Accept both so this never blows up the channel
              // context fetch on a string/number mismatch.
              let ts = "";
              if (m.created_at !== undefined && m.created_at !== null) {
                const d = new Date(m.created_at);
                if (!Number.isNaN(d.getTime())) ts = d.toISOString().slice(11, 16);
              }
              const body = (m.body || "").slice(0, 300);
              // Surface attachment metadata so the bot can see "Dirk posted
              // Nexus-Install-Guide.pdf earlier" instead of just the text.
              // Carries the attachment id so the bot can fetch it via the
              // nexus_load_attachment tool.
              const atts = Array.isArray(m.attachments) ? m.attachments : [];
              const attSuffix = atts.length
                ? ` [attachments: ${atts.map((a) => `${a.filename || a.id} (${a.mime_type || "?"}, id=${a.id})`).join(", ")}]`
                : "";
              return `[${ts}] ${who}: ${body}${attSuffix}`;
            });
          if (lines.length > 0) {
            channelContextBlock =
              "\n\nRECENT CHANNEL MESSAGES (context from #" + channel_slug +
              " so you understand the current conversation):\n" +
              lines.join("\n") +
              "\n\nRespond to the latest message directed at you, but FIRST read the messages above to " +
              "understand what it is about. When the message refers to something implicitly -- 'it', " +
              "'this', 'that one', 'send it', 'do it', 'go ahead', 'looks good', 'approve it' -- the " +
              "referent is almost always the most recent relevant thing you or they just posted in this " +
              "channel (an opportunity, quote, proposal, draft, invoice, document, or record). Resolve it " +
              "from the context above and act on THAT specific item. Only ask what they mean if the context " +
              "genuinely does not make it clear. Do not repeat or summarize the context unprompted." +
              "\n\nFILES/ATTACHMENTS: this applies to files too. If the user refers to 'this/the/that " +
              "statement, file, PDF, invoice, receipt, document, or attachment' and the CURRENT message " +
              "has no attachment, do NOT ask them to re-attach -- look in the messages above for the most " +
              "recently posted attachment (each is shown as `filename (mime, id=<uuid>)`) and use that " +
              "`id` with the relevant tool. If nothing recent matches, call read_channel_history to look " +
              "further back before giving up. Only ask the user to re-upload if no matching attachment " +
              "exists anywhere in the recent history.";
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
          .map((a) => `${a.filename || a.id} [id=${a.id}] (${a.mime_type || "unknown"})`)
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
      "\n\nWHEN YOU ARE @-MENTIONED, the mention is NOT context-free -- it refers to the ongoing" +
      " conversation. ALWAYS read the RECENT CHANNEL MESSAGES above before replying. If the user (or" +
      " anyone) gave an instruction, request, target, file, or decision in a recent message -- even one" +
      " not addressed to you by name -- and then pings you, treat it as directed at you and carry it out." +
      " Do NOT respond to a bare '@you' by asking what they need, or repeat a question they already" +
      " answered, when the recent messages make it clear. Pick up the thread and act on the most recent" +
      " relevant instruction." +
      "\n\nTo @-mention a user back in a reply, write @DisplayName (exactly as it appears in the" +
      " message prefix before the colon, e.g. if the message starts with `Dirk (uid:abc123): ...`" +
      " then write @Dirk). Do not invent a user id syntax -- plain @DisplayName is the correct form.";
    // Anchor the model to AZ wall-clock time so it never falls back to its
    // training-cutoff "today". AZ is UTC-7 year-round (no DST). Brian is in
    // Arizona; the whole company operates on AZ local time. Without this
    // block bots drift days behind because they inherit the model's cutoff.
    const today = phoenixToday();
    const NEXUS_TODAY =
      `\n\nCURRENT DATE AND TIME (authoritative — overrides any internal "today" you might recall):` +
      `\n- Today is ${today.full} in Arizona (America/Phoenix, UTC-7, no DST).` +
      `\n- Local time right now: ${today.time}.` +
      `\n- ISO date: ${today.iso}. ISO 8601: ${today.iso8601}.` +
      `\n- When asked what day/time it is, or when computing schedules, reports, due dates, or "today/yesterday/tomorrow", USE THIS. Do not use UTC. Do not use your training cutoff.`;
    const systemPromptWithFacts = (factsBlock ? systemPrompt + factsBlock : systemPrompt) + NEXUS_CONTEXT + NEXUS_TODAY + NEXUS_MENTION_RULE + threadContextBlock + channelContextBlock;

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
          message_id: m.id,
          author: m.display_name || m.user_id,
          body: annotateGifBody((m.body || "").slice(0, 500)),
          timestamp: m.created_at,
          attachments: Array.isArray(m.attachments)
            ? m.attachments.map((a) => ({
                id: a.id,
                filename: a.filename,
                mime_type: a.mime_type,
                size_bytes: a.size_bytes,
              }))
            : [],
        })),
      };
    };

    const loadAttachmentTool = {
      name: "nexus_load_attachment",
      description:
        "Load the content of a file that was attached to a previous Nexus message " +
        "(an attachment from the RECENT CHANNEL MESSAGES context block, or from the " +
        "read_channel_history tool). Use this when the user references a file from an " +
        "earlier turn that you need to read. PDFs return extracted markdown text. " +
        "Images return a short description. Returns 'error' on unsupported types or " +
        "when credentials are missing.",
      input_schema: {
        type: "object",
        properties: {
          attachment_id: {
            type: "string",
            description:
              "The attachment id (uuid) from a recent channel message. Listed in the " +
              "RECENT CHANNEL MESSAGES context block as `(id=<uuid>)` and in the " +
              "read_channel_history tool result under `attachments[].id`.",
          },
          purpose: {
            type: "string",
            description:
              "Optional. What you intend to use the content for (e.g. 'create KB article', " +
              "'summarize for ticket'). Steers the extraction prompt.",
          },
        },
        required: ["attachment_id"],
      },
    };
    const loadAttachmentHandler = async (input) => {
      const id = input?.attachment_id;
      if (!id || typeof id !== "string") return { error: "attachment_id is required" };
      const token = env.NEXUS_INTERNAL_TOKEN || env.INTERNAL_ADMIN_TOKEN;
      const baseUrl = env.NEXUS_BASE_URL;
      if (!token || !baseUrl) {
        return { error: "Bot worker is missing NEXUS_INTERNAL_TOKEN; ask Brian to set the secret." };
      }
      let resp;
      try {
        resp = await fetch(`${baseUrl.replace(/\/$/, "")}/api/internal/attachments/${encodeURIComponent(id)}`, {
          method: "GET",
          headers: { "X-Internal-Token": token },
          signal: AbortSignal.timeout(20000),
        });
      } catch (err) {
        return { error: `Fetch failed: ${err?.message || String(err)}` };
      }
      if (!resp.ok) {
        return { error: `Nexus returned HTTP ${resp.status} for attachment ${id}.` };
      }
      const mime = (resp.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > 10 * 1024 * 1024) {
        return { error: `Attachment ${id} is ${buf.byteLength} bytes; over 10 MB cap.` };
      }
      const bytes = new Uint8Array(buf);
      const CHUNK = 0x8000;
      let binary = "";
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
      }
      const b64 = btoa(binary);

      const isPdf = mime === "application/pdf";
      const isImage = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"].includes(mime);
      if (!isPdf && !isImage) {
        return { error: `Unsupported mime ${mime || "?"} for in-conversation load.` };
      }

      const purpose = input?.purpose ? String(input.purpose).slice(0, 200) : "general reference";
      const extractionPrompt = isPdf
        ? `Extract the full content of this PDF as well-structured markdown. Preserve headings, lists, tables, and code blocks. Include EVERY section verbatim where reasonable; do not summarize. Intended use: ${purpose}.`
        : `Describe this image in detail. Include all visible text verbatim (OCR), any diagrams, UI elements, or data. Intended use: ${purpose}.`;

      const block = isPdf
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
        : { type: "image", source: { type: "base64", media_type: mime, data: b64 } };

      try {
        const extracted = await callAnthropic(
          env,
          "You are an extraction assistant. Return ONLY the requested content, no preamble.",
          [{ role: "user", content: [block, { type: "text", text: extractionPrompt }] }],
          { maxTokens: 8000 },
        );
        return { ok: true, mime, bytes: buf.byteLength, content: extracted };
      } catch (err) {
        return { error: `Extraction failed: ${err?.message || String(err)}` };
      }
    };

    const mergedTools = [...(config.tools.definitions || []), channelHistoryTool, loadAttachmentTool];
    const mergedHandlers = {
      ...(config.tools.handlers || {}),
      read_channel_history: channelHistoryHandler,
      nexus_load_attachment: loadAttachmentHandler,
    };

    responseText = await callAnthropicWithTools(
      env,
      systemPromptWithFacts,
      history,
      mergedTools,
      mergedHandlers,
      { user_id, user_email, display_name, channel_slug },
      {
        // Re-arm the typing indicator before every Anthropic POST so
        // long tool loops (>90s total) don't lose the indicator on the
        // DO TTL. The initial start is sent above; this catches turns
        // 2+. Best-effort: sendTyping never throws.
        onTurnStart: (turnIndex) => {
          if (turnIndex === 0) return; // already armed above
          return sendTyping(env, channel_slug, "start", typingOptions);
        },
        onUsage: (usage) => { capturedUsage = usage; },
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
      await sendTyping(env, channel_slug, "stop", typingOptions);
    } catch { /* ignore */ }
  }

  if (capturedUsage && env.USAGE_REPORT_URL) {
    const model = env.CLAUDE_MODEL || "claude-opus-4-7";
    fetch(env.USAGE_REPORT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": env.NEXUS_INTERNAL_TOKEN || "",
      },
      body: JSON.stringify({
        bot: config.botName || "unknown",
        model,
        input_tokens: capturedUsage.input_tokens,
        output_tokens: capturedUsage.output_tokens,
        cache_creation_input_tokens: capturedUsage.cache_creation_input_tokens,
        cache_read_input_tokens: capturedUsage.cache_read_input_tokens,
        channel_slug,
        surface: "chat",
        ts: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
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

    // Auto-listen: if the bot just asked a question, register a short-lived
    // "expecting reply" flag in KV so the next ambient message in this channel
    // is treated as directed at this bot without the user needing to re-@
    // anyone. Brian called this out 2026-05-20: having to @<bot> after every
    // turn is annoying when the bot itself just asked a follow-up.
    // TTL 10 min. One-shot: consumed on the next inbound ambient message.
    // Detect `?` followed by whitespace or end-of-string so query-string `?`
    // inside URLs (https://x.com/?q=foo) doesn't false-positive.
    if (/\?[!.)\]]*(\s|$)/.test(visibleResponse)) {
      const cacheBinding = config.cacheBinding || "CACHE";
      const cache = env[cacheBinding];
      if (cache && typeof cache.put === "function") {
        try {
          const key = `bot_listening:${config.botName}:${channel_slug}`;
          await cache.put(
            key,
            JSON.stringify({ since: Date.now(), asked_user_id: user_id }),
            { expirationTtl: 600 },
          );
        } catch (err) {
          console.warn(`[handleChatMessage] auto-listen KV put failed: ${err?.message}`);
        }
      }
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
async function runWatercoolerPipeline({ env, channel_slug, config, nameMention, triggerUserId, triggerDisplayName, triggerBody, inboundReplyTo }) {
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
  const wcToday = phoenixToday();
  const wcTodayBlock =
    `CURRENT DATE AND TIME (use this if you reference today/yesterday/tomorrow or the time of day):\n` +
    `- ${wcToday.full}, ${wcToday.time}. ISO ${wcToday.iso}. Arizona local (UTC-7, no DST).`;
  const fullSystemPrompt = `${wcConfig.systemPrompt}\n\n${nexusIdentity}\n\n${wcTodayBlock}\n\n${groundingRules}`;

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
      // Only thread when the human's message was already in a thread.
      // Posting top-level here keeps watercooler replies in the main channel
      // by default; threading a top-level human message would silently spawn
      // a new thread off it, which is what we are explicitly avoiding.
      const postOpts = { ...nexusOptions };
      if (inboundReplyTo) postOpts.reply_to = inboundReplyTo;
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
    user_email,
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
    if (hasAttachments) {
      userText = "(no caption -- please read the attached files)";
    } else if (trigger_type === "mention") {
      // A bare @mention with no other text is a "catch up and act" ping.
      // Dispatch anyway and tell the LLM to read the recent channel messages
      // -- the user pinged to point at what they just said, not to say nothing.
      userText = "(I was @-mentioned with no other text -- read the recent messages in this channel and act on what was just asked.)";
    } else {
      return json({ success: false, error: "Empty message after stripping mention" }, 400);
    }
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
      // Channel ownership / explicit-address gate:
      //   1. trigger_type==="mention" -- user @-mentioned THIS bot explicitly,
      //      so they clearly want this bot to handle the !cmd no matter the
      //      channel. (Only the mentioned bot receives a "mention" callback,
      //      so this doesn't cause duplicate replies from other ambient bots.)
      //   2. Channel name matches botName or starts with `${botName}-`, or is
      //      listed in config.commandChannels.
      // The ownership-only gate was producing dead silence when users typed
      // "@<bot> !fleet" (or any !cmd) in a general-purpose channel, since
      // every bot would skip with "channel not owned". Bypass on explicit
      // mention restores the natural UX without re-introducing fleet-wide
      // ambient duplicate replies.
      const botName = config.botName;
      const extra = Array.isArray(config.commandChannels) ? config.commandChannels : [];
      const explicitlyMentioned = trigger_type === "mention";
      const ownsChannel =
        explicitlyMentioned ||
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
        inboundReplyTo: reply_to || null,
      })),
    );
    return json({ success: true, queued: true }, 202);
  }

  // ---- 7b. Ambient gate (checked AFTER !cmd so explicit commands always pass) -
  if (trigger_type === "ambient") {
    // Auto-listen bypass: if this bot recently posted a question in this
    // channel, treat the next inbound ambient message as directed at the
    // bot. KV key `bot_listening:<botName>:<channel_slug>` is set in
    // runLlmPipeline post-reply when the bot's response contains `?`.
    // Skip when (a) the author is itself a bot (don't bot-to-bot chain off
    // questions) or (b) the message @s a DIFFERENT bot explicitly (defer to
    // that bot's directed dispatch). Otherwise, consume the key and skip
    // the ambient trigger fn so the LLM pipeline runs.
    let autoListenBypass = false;
    const authorIsBot = typeof user_id === "string" && user_id.startsWith("bot_");
    if (!authorIsBot) {
      const cacheBinding = config.cacheBinding || "CACHE";
      const cache = env[cacheBinding];
      if (cache && typeof cache.get === "function") {
        try {
          const key = `bot_listening:${config.botName}:${channel_slug}`;
          const flag = await cache.get(key);
          if (flag) {
            const myBot = String(config.botName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const myMentionRe = myBot ? new RegExp(`@(?:bot_)?${myBot}\\b`, "i") : null;
            const otherBotMentionRe = /@(?:bot_)?(?:courtney|dexter|jacob|maxwell|moxie|robert|wren|kate)\b/i;
            const text = msgBody || "";
            const mentionsOther =
              otherBotMentionRe.test(text) && !(myMentionRe && myMentionRe.test(text));
            if (!mentionsOther) {
              autoListenBypass = true;
              await cache.delete(key).catch(() => {});
              console.log(`[handleChatMessage] auto-listen fired for ${config.botName} in #${channel_slug}`);
            }
          }
        } catch (err) {
          console.warn(`[handleChatMessage] auto-listen KV check failed: ${err?.message}`);
        }
      }
    }

    if (!autoListenBypass) {
      const ambientFn = config.triggers?.ambient;
      const meta = {
        attachments: Array.isArray(attachments) ? attachments : [],
        channel_slug,
      };
      if (ambientFn && !ambientFn(msgBody || "", reply_to ?? null, null, meta)) {
        return json({ success: true, skipped: true });
      }
    }
  }

  // ---- 8. Deferred LLM pipeline -------------------------------------------
  // The tool-use loop routinely runs 30+ seconds (multimodal PDFs, big Xero
  // queries). ctx.waitUntil has a ~30s wall-clock ceiling; over that it gets
  // cancelled and the bot never posts a reply. Hand the work to the LlmRoom
  // Durable Object which queues the job and processes it in an alarm handler
  // with no waitUntil ceiling. The DO binding is named via config.llmRoomBinding
  // (default LLM_ROOM); falls back to inline waitUntil if the binding is
  // missing so legacy bots without DO wiring still work.
  const labeledUserText = `${display_name || user_id} (uid:${user_id}): ${annotateGifBody(userText)}`;
  const llmJob = {
    user_id,
    user_email,
    display_name,
    channel_slug,
    userText,
    labeledUserText,
    historyKey,
    attachments,
    // Pass reply_to so the LLM pipeline posts into the same thread.
    // undefined is omitted by JSON.stringify so no-thread messages stay clean.
    reply_to: reply_to || undefined,
    provenance: "mention-reply",
  };

  ctx.waitUntil(dispatchLlmJob(env, historyKey, llmJob, config));

  return json({ success: true, queued: true }, 202);
}
