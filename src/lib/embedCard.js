// =============================================================================
// lib/embedCard.js - Bot-command embed-card wrapper for Nexus rich-embed UI.
//
// The Nexus UI renderer (ui/src/components/MessageGroup.jsx, EmbedMessageBody)
// turns this exact markup into a Discord-style card with colored left border,
// bold title, and tinted body background:
//
//   [embed color:#hex title:Foo]
//   <body markdown>
//   [/embed]
//
// EMBED_RE in the renderer is anchored to ^ and $ and expects the body to be
// preceded and followed by a single newline. Any leading whitespace, missing
// newline, or different bracket style will fall through to the plain message
// renderer, defeating the visual separation Brian wants for !commands.
//
// Why this is shared from commons rather than reimplemented in each worker:
// - Per-bot color palette is a fleet-wide UX decision; one source of truth.
// - Format must match the Nexus parser exactly. One careful implementation
//   here beats seven copies drifting independently.
// - handleChatMessage uses this to auto-wrap !cmd replies so per-bot command
//   handlers do not have to call it themselves.
//
// Usage from commands:
//   import { asEmbedCard } from "nexus-bot-worker-commons";
//   await ctx.reply(asEmbedCard("Robert Raven -- SOC Commands", body, "#ef4444"));
//
// Usage via handleChatMessage auto-wrap (preferred):
//   The library wraps ctx.reply transparently. Handlers call ctx.reply(body)
//   exactly as before; the embed wrapper is applied per-call using the bot's
//   default color from BOT_COMMAND_COLORS and a verb-derived title.
//
// To override title or color per-call (e.g. severity-tinted !status):
//   await ctx.reply(body, { title: "Robert Raven -- Status (DOWN)", color: "#ef4444" });
//
// To opt out entirely (raw chat, no card) -- e.g. when a command wants to
// stream a natural reply rather than a structured response:
//   await ctx.reply(body, { embed: false });
//
// =============================================================================

/**
 * Per-bot default color for command embed cards. Keep these in sync with the
 * MEMORY.md color contract for the bot fleet. New bots should pick a hex value
 * that is visually distinct from this set so the chat journal stays scannable.
 *
 * @type {Object.<string, string>}
 */
export const BOT_COMMAND_COLORS = {
  robert:   "#ef4444", // red, SOC tone
  dexter:   "#3b82f6", // blue, DevOps
  maxwell:  "#f59e0b", // amber, finance
  courtney: "#10b981", // green, IT triage
  jacob:    "#8b5cf6", // purple, sales
  moxie:    "#ec4899", // pink, content / marketing
  wren:     "#06b6d4", // cyan, personal assistant
};

/**
 * Default embed color when the bot is unknown (or the bot has not registered
 * a color in BOT_COMMAND_COLORS). Matches the BR accent token in the UI so
 * the card still renders gracefully instead of leaking a raw [embed] tag.
 */
export const DEFAULT_COMMAND_COLOR = "#5b8def";

/**
 * Build the embed markup string the Nexus UI renderer recognises.
 * Caller is responsible for choosing the title and color; this helper is
 * format-only and does not consult any per-bot configuration.
 *
 * Body is preserved as-is. Newlines, markdown, code fences inside the body
 * are all fine. A trailing newline is stripped to keep the closer on its
 * own line as EMBED_RE requires.
 *
 * @param {string} title - card title; rendered bold above the body
 * @param {string} body - markdown body content
 * @param {string} [color] - hex color (#RRGGBB) for the left border accent
 * @returns {string}
 */
export function asEmbedCard(title, body, color = DEFAULT_COMMAND_COLOR) {
  const safeTitle = typeof title === "string" ? title.trim() : "";
  const safeBody = typeof body === "string" ? body.replace(/\n+$/, "") : String(body ?? "");
  const safeColor = typeof color === "string" && /^#[0-9a-fA-F]{3,6}$/.test(color)
    ? color
    : DEFAULT_COMMAND_COLOR;
  // Order of attributes (color first, then title) matches the existing
  // formatEmbed helper in shared-bot-modules/nexus.js so a regex-based audit
  // sees one canonical shape.
  return `[embed color:${safeColor} title:${safeTitle}]\n${safeBody}\n[/embed]`;
}

/**
 * Build a rich embed card with Discord-style structured fields and an
 * optional footer line. The output is a single string in the bracketed
 * markup the Nexus UI's EmbedMessageBody parser recognises.
 *
 * Output shape:
 *   [embed color:#hex title:Title]
 *   [field name:From]
 *   <multi-line value preserved as-is>
 *   [/field]
 *   [field name:Subject]
 *   ...
 *   [/field]
 *   [footer]
 *   <footer text>
 *   [/footer]
 *   [/embed]
 *
 * Any omitted argument is skipped (no empty blocks emitted). Field values
 * may span multiple lines; the parser preserves whitespace verbatim. The
 * caller is responsible for trimming each field value to a sensible
 * length (the Nexus message-body cap is 8000 chars total).
 *
 * Backward compatibility: when called with no fields and no footer the
 * output collapses to the same shape `asEmbedCard` produces, so existing
 * UI behaviour is preserved for callers who do not need the new layout.
 *
 * @param {{
 *   title?: string,
 *   color?: string,
 *   body?: string,
 *   fields?: Array<{name: string, value: string, inline?: boolean}>,
 *   footer?: string,
 * }} opts
 * @returns {string}
 */
export function asRichEmbedCard({ title = "", color = DEFAULT_COMMAND_COLOR, body = "", fields = [], footer = "" } = {}) {
  const safeTitle = typeof title === "string" ? title.trim() : "";
  const safeColor = typeof color === "string" && /^#[0-9a-fA-F]{3,6}$/.test(color)
    ? color
    : DEFAULT_COMMAND_COLOR;
  const lines = [`[embed color:${safeColor} title:${safeTitle}]`];

  // Optional intro body (above field blocks). Stripped of trailing newlines
  // so the field section starts cleanly underneath.
  if (typeof body === "string" && body.trim().length > 0) {
    lines.push(body.replace(/\n+$/, ""));
  }

  // Field blocks. Each becomes a Discord-style label-above-value pair in
  // the rendered card. Inline fields are flagged with `inline:true` in the
  // tag so the UI renderer can group them into a 2-column grid.
  // We coerce non-string values to strings and skip entries missing a name.
  if (Array.isArray(fields)) {
    for (const f of fields) {
      if (!f || typeof f !== "object") continue;
      const name = typeof f.name === "string" ? f.name.trim() : "";
      if (!name) continue;
      const rawValue = f.value === undefined || f.value === null ? "" : String(f.value);
      const value = rawValue.replace(/\n+$/, "");
      const inlineAttr = f.inline === true ? " inline:true" : "";
      lines.push(`[field name:${name}${inlineAttr}]`);
      lines.push(value);
      lines.push(`[/field]`);
    }
  }

  if (typeof footer === "string" && footer.trim().length > 0) {
    lines.push(`[footer]`);
    lines.push(footer.replace(/\n+$/, ""));
    lines.push(`[/footer]`);
  }

  lines.push(`[/embed]`);
  return lines.join("\n");
}

/**
 * Capitalize a single command verb for use in an auto-derived card title.
 * "help" -> "Help", "mitre" -> "Mitre", "playbooks" -> "Playbooks".
 *
 * @param {string} verb
 * @returns {string}
 */
export function prettifyVerb(verb) {
  if (typeof verb !== "string" || !verb) return "";
  return verb.charAt(0).toUpperCase() + verb.slice(1).toLowerCase();
}

/**
 * Build the canonical command-card title: "<Display Name> -- <Verb>".
 * Matches the convention Brian asked for (e.g. "Robert Raven -- Help",
 * "Dexter Raven -- Status"). Handlers can override by passing their own
 * { title } option to ctx.reply.
 *
 * @param {string} displayName - persona display name (e.g. "Robert Raven")
 * @param {string} verb - command verb (without the leading !)
 * @returns {string}
 */
export function buildCommandTitle(displayName, verb) {
  const dn = (typeof displayName === "string" && displayName.trim()) || "Bot";
  const v = prettifyVerb(verb);
  return v ? `${dn} -- ${v}` : dn;
}

/**
 * Resolve the bot's default command embed color, falling back to the global
 * default. Botname comparison is case-insensitive so config.botName variants
 * (e.g. "Robert" vs "robert") all map to the same palette entry.
 *
 * @param {string} botName
 * @returns {string}
 */
export function colorForBot(botName) {
  if (typeof botName !== "string" || !botName) return DEFAULT_COMMAND_COLOR;
  const key = botName.toLowerCase();
  return BOT_COMMAND_COLORS[key] || DEFAULT_COMMAND_COLOR;
}
