// =============================================================================
// lib/sanitize.js -- fleet-wide content sanitizers.
//
// Single source of truth for output normalization rules that apply across
// every bot surface (Nexus posts, Graph email, voice TTS prompts, social
// captions). These run on the final outbound string regardless of whether
// the upstream prompt told the model not to produce them; LLMs leak.
// =============================================================================

/**
 * Replace em-dashes (U+2014) and en-dashes (U+2013) with ASCII forms that
 * a human would naturally type. Em-dash collapses any surrounding whitespace
 * into a single ", " so "alpha - beta" and "alpha-beta" both become
 * "alpha, beta" (not "alpha ,  beta"). En-dash becomes "-" (numeric range
 * formatting works either way).
 *
 * Also handles the common HTML entity forms (&mdash;, &ndash;, &#8212;,
 * &#8211;) so HTML email bodies are scrubbed correctly before MIME assembly.
 * Adjacent commas from chained replacements are collapsed.
 *
 * Why: em/en dashes are a dead giveaway that text came from an LLM. Office
 * workers rarely type them; their presence in an email / voice line / Nexus
 * post makes the bot legible as a bot. The fleet rule is to strip them at
 * every human-facing seam.
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
    .replace(/–/g, "-")
    .replace(/(?:&ndash;|&#8211;)/gi, "-")
    .replace(/,\s*,/g, ",");
}
