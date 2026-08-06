#!/usr/bin/env node
// check-graph-send-parse.mjs, the fleet "202 empty body" tripwire (2026-08-06).
//
// Microsoft Graph write endpoints do not all return JSON on success:
//   POST /messages/{id}/send      -> 202, EMPTY body
//   POST /users/{mbx}/sendMail    -> 202, EMPTY body
//   POST /messages/{id}/reply     -> 202, EMPTY body
// A bare `res.json()` on any of those throws "Unexpected end of JSON input"
// AFTER the mail has already left the tenant. Every caller that treats the
// throw as a send failure then re-stages its HITL card, and the next Approve
// click delivers a DUPLICATE to the client.
//
// Robert hit this 2026-07-23 on the DMARC report replies. Maxwell hit the
// identical bug 2026-08-06 because the fix was never shared. It is now
// commons `parseGraphResponse`; this script stops the third occurrence.
//
// The rule: a `res.json()` on a Microsoft Graph response is a violation unless
// something nearby proves the empty-body case was considered. Proof is any of
// `parseGraphResponse`, a literal `202`, or a `.text()`-then-parse.
//
// The rule deliberately does NOT look for `/send` near the `.json()`. In every
// real occurrence the parse lives in a GENERIC helper (`graphRequest(env,
// method, path)`) and the send path is a variable supplied hundreds of lines
// away at the call site, so a path-adjacency rule sees nothing. A `204`-only
// guard is likewise not proof: that is exactly what Maxwell had.
//
// If a call site is genuinely fine, put the literal marker
// "graph-send-parse-ok" on the same line as the `.json()` to skip it.
//
// Usage: node check-graph-send-parse.mjs <dir-or-file> [...more]
//   Missing paths are skipped so every worker can pass the same arg list.
//   Default args when none are given: src

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const SCAN_EXTENSIONS = new Set([".js", ".mjs", ".ts"]);
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", ".wrangler", ".wrangler-dry"]);
const SKIP_MARKER = "graph-send-parse-ok";

// `.json()` called on a response-shaped identifier. Deliberately narrow: we do
// not want to flag `JSON.parse`, `req.json()` on inbound requests, or
// `something.json` property reads.
const RES_JSON_RE = /\b(res|resp|response|r|graphRes|gRes)\s*\.\s*json\s*\(\s*\)/g;
// Evidence that this response came from Microsoft Graph.
const GRAPH_RE = /graph\.microsoft\.com|GRAPH_BASE|graphRequest|graphFetch|graphGet|graphPost/i;
// Evidence that the empty-body case was actually handled. A bare `204` guard is
// NOT on this list on purpose: Maxwell had one and still shipped the bug.
const LENIENT_RE = /parseGraphResponse|\b202\b|\.\s*text\s*\(\s*\)/;
// How far back from the `.json()` counts as "this call".
const LOOKBACK = 700;

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
 * Find `.json()` parses on a Graph response with no empty-body handling.
 * @param {string} content - File text.
 * @returns {Array<{line: number, excerpt: string}>} Violations found.
 */
function findViolations(content) {
  const violations = [];
  const lines = content.split(/\r?\n/);
  // A file that never touches Graph cannot hold this bug.
  if (!GRAPH_RE.test(content)) return violations;

  RES_JSON_RE.lastIndex = 0;
  let m;
  while ((m = RES_JSON_RE.exec(content)) !== null) {
    const lineNo = content.slice(0, m.index).split(/\r?\n/).length;
    const lineText = lines[lineNo - 1] || "";
    if (lineText.includes(SKIP_MARKER)) continue;

    // `res.json().catch(...)` cannot throw on an empty body, so it is safe
    // whatever the endpoint returns.
    if (/^\s*\.\s*catch\s*\(/.test(content.slice(m.index + m[0].length))) continue;

    const window = content.slice(Math.max(0, m.index - LOOKBACK), m.index);
    // Only care about responses that plausibly came from Graph.
    if (!GRAPH_RE.test(window)) continue;
    if (LENIENT_RE.test(window)) continue;

    violations.push({ line: lineNo, excerpt: lineText.trim().slice(0, 120) });
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
      console.error(`${file}:${v.line} [json() on a Graph send response] ${v.excerpt}`);
    }
  }
}

if (totalViolations > 0) {
  console.error(`\ncheck-graph-send-parse: ${totalViolations} site(s) call .json() on a Graph response with no empty-body handling. Graph send/write endpoints answer 202 with an EMPTY body, so this throws AFTER the mail was delivered and arms a double-send on retry. Use commons parseGraphResponse. Mark deliberate read-only call sites with "${SKIP_MARKER}".`);
  process.exit(1);
}
console.log(`check-graph-send-parse: clean (${scannedFiles} files scanned)`);
