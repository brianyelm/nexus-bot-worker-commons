// =============================================================================
// lib/embedCard.js — bangReport / bangAlert helpers for Nexus bot output.
//
// 2026-05-17 fleet-wide format reset:
//
//   - Discord-style embed cards retired. Every bot post is a bangReport-style
//     code-block-wrapped plain-text report. The Nexus UI renders these as
//     monospace dark blocks with marked.js + highlight.js auto-detect.
//   - Per-bot canonical colors deleted. Left-border accent is now sourced from
//     msg.provenance via PROVENANCE_COLORS on the message-row wrapper.
//
// Usage:
//   bangReport({ botName: "Dexter", verb: "status", args: "fleet", sections })
//     -> ```\nDexter !status -- fleet\nGenerated: ...\n=====\n<sec>\n```
//
//   bangAlert({ botName: "Courtney", verb: "ticket-alert", sections })
//     -> ```\nCourtney ticket-alert\nGenerated: ...\n=====\n<sec>\n```
//
// The leading-! is a bangReport convention for !command output; bangAlert is
// for cron / handler / webhook output where there's no chat command.
//
// Sections is an array of strings (each with embedded newlines) OR an array
// of arrays of strings (per-section line arrays, joined with \n).
// =============================================================================

/**
 * Sanitize a string for safe inclusion in a bangReport title or section.
 *
 * Strips `[` and `]` characters so any historical embed-attribute parsers
 * downstream don't choke, and collapses runs of whitespace. Promoted from
 * courtney-worker so every caller hits the same definition.
 *
 * @param {string} str
 * @returns {string}
 */
export function safeEmbedTitle(str) {
  return String(str ?? "")
    .replace(/[\[\]]/g, " ")
    .replace(/  +/g, " ")
    .trim();
}

// ─── bangReport: dexter device-count style structured plain-text report ───────

const REPORT_WIDTH = 72;
const HEADER_RULE = "=".repeat(REPORT_WIDTH);
const SECTION_RULE = "-".repeat(REPORT_WIDTH);

/**
 * Build a dexter-style structured plain-text report wrapped in a code block.
 *
 * @param {object} opts
 * @param {string} opts.botName - "Dexter" / "Jacob" / etc. (first word of display name)
 * @param {string} opts.verb - bang command verb without leading !
 * @param {string} [opts.args] - args string from the command invocation
 * @param {Array<string|string[]>} opts.sections - per-section body (string or array of lines)
 * @param {string} [opts.subtitle] - optional override for the title line; default `${botName} !${verb}{ -- args}`
 * @returns {string} markdown-ready report (code-block wrapped)
 */
export function bangReport({ botName, verb, args, sections, subtitle } = {}) {
  const argsPart = args ? ` -- ${args}` : "";
  const title = subtitle || `${botName} !${verb}${argsPart}`;
  const out = [
    title,
    `Generated: ${new Date().toISOString()}`,
    HEADER_RULE,
  ];
  const list = Array.isArray(sections) ? sections : [];
  for (let i = 0; i < list.length; i++) {
    if (i > 0) {
      out.push("");
      out.push(SECTION_RULE);
    }
    const s = list[i];
    if (Array.isArray(s)) out.push(s.join("\n"));
    else if (typeof s === "string") out.push(s);
  }
  return "```\n" + out.join("\n") + "\n```";
}

export const BANG_REPORT_RULES = { HEADER_RULE, SECTION_RULE };

/**
 * bangAlert — non-command variant of bangReport for cron jobs, pollers, and
 * webhook handlers. Same output shape as bangReport (code-block-wrapped,
 * 72-wide rules, sections) but the title line is "Botname verb" (no leading
 * `!`), since the post isn't the response to a chat command.
 *
 * The fleet-wide format mandate (2026-05-17): every cron/handler post uses
 * this instead of asRichEmbedCard. Left-border color comes from the
 * message's provenance slug at the renderer level; the bot does not pick
 * a color here.
 *
 * @param {object} opts
 * @param {string} opts.botName - "Courtney" / "Dexter" / etc.
 * @param {string} opts.verb - kind of post (e.g. "ticket-alert", "uptime-alert")
 * @param {string} [opts.args] - optional args string appended after `--`
 * @param {Array<string|string[]>} opts.sections - per-section body
 * @returns {string} code-block-wrapped report ready to pass to postToNexus
 */
export function bangAlert({ botName, verb, args, sections } = {}) {
  const argsPart = args ? ` -- ${args}` : "";
  return bangReport({
    botName,
    verb,
    args,
    sections,
    subtitle: `${botName} ${verb}${argsPart}`,
  });
}
