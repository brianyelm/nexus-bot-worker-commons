#!/usr/bin/env node
// check-graph-reply.mjs, the fleet reply-threading tripwire (2026-07-06).
//
// Guards against the "bots keep deleting the client messages" regression:
// POSTing Microsoft Graph `.../messages/{id}/reply` with a `message` object
// that carries a `body` threads the reply but REPLACES the body wholesale, so
// the quoted original (the client's own words) is dropped from the sent mail.
//
// The only correct in-thread reply forms are:
//   1. `/reply` with a `{ comment: html }` payload (comment sits above the
//      auto-generated quote, which is preserved), or
//   2. `createReply` / `createReplyAll` -> PATCH the draft body to
//      `ourHtml + draft.body.content` (our text ABOVE the quote) -> `/send`.
//
// This script fails `npm test` if any source file POSTs `/reply` with a
// message-body payload. If a call site is genuinely fine, put the literal
// marker "reply-quote-ok" on the same line as the `/reply` endpoint to skip it.
//
// Usage: node check-graph-reply.mjs <dir-or-file> [...more]
//   Missing paths are skipped so every worker can pass the same arg list.
//   Default args when none are given: src

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const SCAN_EXTENSIONS = new Set([".js", ".mjs", ".ts"]);
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", ".wrangler", ".wrangler-dry"]);
const SKIP_MARKER = "reply-quote-ok";

// A send-now reply endpoint: a path literal ending in "/reply" (NOT
// "/createReply" or "/createReplyAll", which do not contain a leading-slash
// lowercase "/reply"). Matches the closing backtick/quote or a query char.
const REPLY_ENDPOINT_RE = /\/reply(?:[`"'?])/g;
// Inline message body in the SAME call payload: `message: { ... body/contentType }`.
const INLINE_MSG_BODY_RE = /message\s*:\s*\{[\s\S]{0,200}?(contentType|body\s*:\s*\{)/;
// Shorthand: a `message` variable passed as the reply payload (`{ message }`).
const SHORTHAND_MSG_RE = /\{\s*message\s*[},]/;
// A `message` variable assigned a body elsewhere in the file (pairs with the
// shorthand form). The safe `comment:` reply never defines this.
const MSG_VAR_BODY_RE = /\bmessage\s*=\s*\{[\s\S]{0,200}?(contentType|body\s*:\s*\{)/;
// How much of the source after the endpoint counts as "this call's payload".
const CALL_SPAN = 400;

/**
 * Recursively collect scannable files under a path.
 * @param {string} target - File or directory path.
 * @param {string[]} found - Accumulator of file paths.
 * @returns {string[]} All matching file paths.
 */
function collectFiles(target, found = []) {
  const stats = statSync(target);
  if (stats.isFile()) {
    if (SCAN_EXTENSIONS.has(extname(target))) found.push(target);
    return found;
  }
  for (const entry of readdirSync(target)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    collectFiles(join(target, entry), found);
  }
  return found;
}

/**
 * Find reply-quote-stripping call sites in one file's content. Each `/reply`
 * endpoint is judged by ITS OWN call payload (the text right after it), not by
 * a line window, so a nearby unrelated block cannot cross-contaminate.
 * @param {string} content - File text.
 * @returns {Array<{line: number, excerpt: string}>} Violations found.
 */
function findViolations(content) {
  const violations = [];
  const lines = content.split(/\r?\n/);
  // A file-wide signal that a `message` variable holds a body (for the shorthand form).
  const fileHasMessageVarBody = MSG_VAR_BODY_RE.test(content);

  REPLY_ENDPOINT_RE.lastIndex = 0;
  let m;
  while ((m = REPLY_ENDPOINT_RE.exec(content)) !== null) {
    const lineNo = content.slice(0, m.index).split(/\r?\n/).length;
    const lineText = lines[lineNo - 1] || "";
    if (lineText.includes(SKIP_MARKER)) continue;

    const payload = content.slice(m.index, m.index + CALL_SPAN);
    const inline = INLINE_MSG_BODY_RE.test(payload);
    const shorthand = SHORTHAND_MSG_RE.test(payload) && fileHasMessageVarBody;
    if (inline || shorthand) {
      violations.push({ line: lineNo, excerpt: lineText.trim().slice(0, 120) });
    }
  }
  return violations;
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ["src"];

let totalViolations = 0;
let scannedFiles = 0;
for (const target of targets) {
  if (!existsSync(target)) continue;
  for (const file of collectFiles(target)) {
    scannedFiles++;
    for (const v of findViolations(readFileSync(file, "utf8"))) {
      totalViolations++;
      console.error(`${file}:${v.line} [reply strips quoted history] ${v.excerpt}`);
    }
  }
}

if (totalViolations > 0) {
  console.error(`\ncheck-graph-reply: ${totalViolations} reply(s) POST a message-body to /reply, which wipes the quoted thread. Use createReply then PATCH body above the quote then send, or the { comment } form. Mark intentional lines with "${SKIP_MARKER}".`);
  process.exit(1);
}
console.log(`check-graph-reply: clean (${scannedFiles} files scanned)`);
