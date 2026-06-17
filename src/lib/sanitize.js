// =============================================================================
// lib/sanitize.js -- fleet-wide content sanitizers.
//
// Single source of truth for output normalization rules that apply across
// every bot surface (Nexus posts, Graph email, voice TTS prompts, social
// captions). These run on the final outbound string regardless of whether
// the upstream prompt told the model not to produce them; LLMs leak.
// =============================================================================

/**
 * Replace em-dashes (U+2014), en-dashes (U+2013), AND the ASCII double-hyphen
 * pause ( -- ) with forms a human would naturally type. Em-dash and a spaced
 * "--" both collapse surrounding whitespace into a single ", " so
 * "alpha - beta", "alpha-beta", and "alpha -- beta" all become "alpha, beta"
 * (not "alpha ,  beta"). En-dash becomes "-" (numeric range formatting works
 * either way).
 *
 * The " -- " rule exists because the fleet's "no em/en dash" instruction made
 * the models reach for a double-hyphen as a substitute, which is its own
 * tell. A spaced "--" is the dash-as-pause; separate clauses with a comma like
 * a person does. We require whitespace on BOTH sides so CLI flags (--skip),
 * ranges (2024--2025), and option lists are left untouched.
 *
 * Also handles the common HTML entity forms (&mdash;, &ndash;, &#8212;,
 * &#8211;) so HTML email bodies are scrubbed correctly before MIME assembly.
 * Adjacent commas from chained replacements are collapsed.
 *
 * Why: em/en dashes and "--" are a dead giveaway that text came from an LLM.
 * Office workers rarely type them; their presence in an email / voice line /
 * Nexus post makes the bot legible as a bot. The fleet rule is to strip them
 * at every human-facing seam.
 *
 * Non-strings pass through untouched so this is safe to call on any value.
 *
 * @param {*} text
 * @returns {*}
 */
export function scrubFleetDashes(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s*(?:&mdash;|&#8212;)\s*/gi, ", ")
    .replace(/ +-- +/g, ", ")
    .replace(/–/g, "-")
    .replace(/(?:&ndash;|&#8211;)/gi, "-")
    .replace(/,\s*,/g, ",");
}

// -----------------------------------------------------------------------------
// Warn-only detectors. These do not rewrite -- they return booleans that
// callers (postToNexus) can use to flag non-conformant outbound text.
// -----------------------------------------------------------------------------

/**
 * The PALETTE emoji codepoints, as a Set, for the freelance-emoji check.
 * Built lazily so format.js's PALETTE update doesn't require a cycle.
 *
 * @type {Set<string>|null}
 */
let _paletteSet = null;
function _loadPaletteSet() {
  if (_paletteSet) return _paletteSet;
  // Inlined snapshot of PALETTE values, kept in sync with format.js. Each
  // emoji is the *value* the LLM is likely to produce; if format.js adds a
  // key, mirror it here.
  _paletteSet = new Set([
    "📅","📧","✅","⏰","📝","💰",
    "📊","🖥","🔍","⚠️","🚨","❌",
    "🛡","🔓","🆕","⏳","🏁","🛑",
    "💬","🎫","🔗",
    // Deprecated keys retained so existing call sites don't trip the detector:
    "🌤","📋","📈","👤",
  ]);
  return _paletteSet;
}

// Detect emoji *anywhere* in a string. Range covers the common pictographic
// blocks; not exhaustive, intentionally loose. Used only as a filter before
// the palette membership check.
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/**
 * True if any `### **Title**` line contains an emoji that is NOT in the
 * canonical PALETTE. Other lines (body bullets, etc.) are not inspected --
 * one-emoji-per-section-header is the only enforced rule.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function detectFreelanceEmoji(text) {
  if (typeof text !== "string" || !text) return false;
  const palette = _loadPaletteSet();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    // Match a section header line. Two shapes:
    //   - legacy / HITL `## ` or `### ` headers (emoji sits before the title)
    //   - house-style numbered sections: "<emoji> **1. Title**" (no markdown header)
    if (!/^#{2,3}\s/.test(line) && !/^\S+\s+\*\*\d+\.\s/.test(line)) continue;
    const matches = line.match(EMOJI_RE);
    if (!matches) continue;
    for (const m of matches) {
      if (!palette.has(m)) return true;
    }
  }
  return false;
}

/**
 * True if a line that looks like a bot-authored header is written as
 * bare ALL-CAPS (e.g. "OPEN TICKETS:"). The style guide section 2 forbids
 * this -- use a numbered emoji+bold section line ("<emoji> **1. Title**") instead.
 *
 * Heuristic: a standalone line that is 3+ words, all-uppercase with at most
 * one trailing colon, and not a fenced-block marker.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function detectBareCapsHeader(text) {
  if (typeof text !== "string" || !text) return false;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("```")) continue;
    if (line.startsWith("#")) continue;     // proper markdown header
    if (line.startsWith(">")) continue;
    if (line.startsWith("-") || line.startsWith("•")) continue;
    // Drop trailing colon for the check.
    const stripped = line.endsWith(":") ? line.slice(0, -1) : line;
    if (stripped.length < 8) continue;       // too short to be a "header"
    if (stripped.length > 80) continue;      // probably a sentence
    // Must contain only A-Z, digits, spaces, and a few punctuation marks.
    if (!/^[A-Z0-9 _'/\-&]+$/.test(stripped)) continue;
    // At least one letter and at least two words.
    if (!/[A-Z]/.test(stripped)) continue;
    if (stripped.split(/\s+/).length < 2) continue;
    return true;
  }
  return false;
}

/**
 * True if the text contains any em-dash (U+2014) or en-dash (U+2013) --
 * after scrubFleetDashes has already run, this should always be false. A
 * hit means a code path bypassed the sanitizer.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function detectEmDashLeak(text) {
  if (typeof text !== "string") return false;
  return /[–—]/.test(text);
}

/**
 * Bundle the three detectors for one-call telemetry from postToNexus.
 *
 * @param {string} text
 * @returns {{has_em_dash:boolean, has_bare_caps:boolean, has_freelance_emoji:boolean}}
 */
export function inspectOutboundText(text) {
  return {
    has_em_dash: detectEmDashLeak(text),
    has_bare_caps: detectBareCapsHeader(text),
    has_freelance_emoji: detectFreelanceEmoji(text),
  };
}
