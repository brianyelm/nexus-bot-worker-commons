#!/usr/bin/env node
// check-empty-catch.mjs - fleet silent-failure tripwire.
//
// The house rule bans swallowed errors: every catch block must log, rethrow, or
// otherwise handle. This scans JS/TS source for TRULY BARE catch blocks - an
// empty body with not even a comment explaining the swallow. A silent bare
// `catch {}` is how the VC and mobile bugs became "frequent but invisible".
//
// A catch body that carries an explanatory comment (e.g. `/* best-effort */`)
// is treated as a declared, intentional swallow and passes: the comment IS the
// author asserting they meant to. The ban targets the zero-explanation case.
//
// Detected (flagged):
//   catch {}      catch (e) {}      catch { }      catch (e) {   }
// Allowed (comment = declared intent):
//   catch { /* socket already closed */ }
//
// A bare swallow that is genuinely intentional can still pass by adding the
// marker "catch-ok" on the catch line, forcing an explicit opt-out.
//
// Usage:
//   node check-empty-catch.mjs [--strict] <dir-or-file> [...more]
//     default (no --strict): report violations, exit 0 (adoption/reporting mode)
//     --strict: exit 1 on any violation (wire into `npm test` once a repo is clean)
//   Default scan path when none given: src

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const SCAN_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx", ".jsx"]);
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", ".wrangler", ".wrangler-dry", "coverage"]);
const SKIP_MARKER = "catch-ok";
const CATCH_OPEN_RE = /\bcatch\s*(\([^)]*\))?\s*\{/g;

/**
 * Recursively collect scannable source files.
 * @param {string} target
 * @param {string[]} [found]
 * @returns {string[]}
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
 * Find bare (whitespace-only body) catch blocks in one file.
 * @param {string} content
 * @returns {Array<{line: number, excerpt: string}>}
 */
function findViolations(content) {
  const violations = [];
  const lineStarts = [];
  let acc = 0;
  for (const l of content.split("\n")) {
    lineStarts.push(acc);
    acc += l.length + 1;
  }
  const lineAt = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  let m;
  CATCH_OPEN_RE.lastIndex = 0;
  while ((m = CATCH_OPEN_RE.exec(content)) !== null) {
    // Walk from the opening brace to its matching close (naive brace count;
    // safe here because an empty/comment-only body has no string literals).
    const openIdx = content.indexOf("{", m.index);
    if (openIdx === -1) continue;
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < content.length; i++) {
      const c = content[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { closeIdx = i; break; }
      }
    }
    if (closeIdx === -1) continue;
    const body = content.slice(openIdx + 1, closeIdx);
    // A non-empty body (real code OR an explanatory comment) is a declared
    // handling/swallow and passes. Only a whitespace-only body is a bare,
    // zero-explanation silent failure.
    if (body.trim() !== "") continue;

    const lineNo = lineAt(m.index);
    const lineText = content.slice(lineStarts[lineNo - 1], lineStarts[lineNo] ?? content.length);
    if (lineText.includes(SKIP_MARKER)) continue;
    violations.push({ line: lineNo, excerpt: content.slice(m.index, closeIdx + 1).replace(/\s+/g, " ").slice(0, 100) });
  }
  return violations;
}

const rawArgs = process.argv.slice(2);
const strict = rawArgs.includes("--strict");
const targets = rawArgs.filter((a) => a !== "--strict");
if (targets.length === 0) targets.push("src");

let total = 0;
let scanned = 0;
for (const target of targets) {
  if (!existsSync(target)) continue;
  for (const file of collectFiles(target)) {
    scanned++;
    for (const v of findViolations(readFileSync(file, "utf8"))) {
      total++;
      console.error(`${file}:${v.line} [empty-catch] ${v.excerpt}`);
    }
  }
}

if (total > 0) {
  console.error(`\ncheck-empty-catch: ${total} swallowed catch block(s) in ${scanned} file(s). Log, rethrow, or mark an intentional swallow with "${SKIP_MARKER}" on the catch line.`);
  if (strict) process.exit(1);
  process.exit(0);
}
console.log(`check-empty-catch: clean (${scanned} files scanned)`);
