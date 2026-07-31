// =============================================================================
// lib/aiDisclosure.js - canonical AI disclosure copy and markup for every
// audience facing surface that shows a synthetic face or voice.
//
// Why this exists (regulatory, not cosmetic):
//   EU AI Act Article 50 applies in full from 2026-08-02. It was NOT delayed by
//   Regulation (EU) 2026/1744, which only pushed the high risk obligations.
//     50(1) interaction disclosure: a person must be told they are dealing with
//           an AI at the START of the first interaction.
//     50(4) synthetic media labelling: generated video carries a label
//           regardless of whether anyone intended to deceive.
//   Commission guidance adopted 2026-07-20 expressly rejects fine print,
//   metadata alone, and vague labels such as "assistant". It asks for plain
//   language plus a persistent visual indicator, which is what renderAiBadge
//   produces. Ceiling is EUR 15,000,000 or 3 percent of worldwide turnover.
//
//   California AB 853 lands the same day. New York's Synthetic Performer
//   Disclosure Law has been live since 2026-06-09 and specifically covers
//   performers that are NOT recognisable as any real person, which is exactly
//   what a fully synthetic fleet face is. Maine LD 1727 requires disclosure
//   whenever a reasonable consumer might think a human is on the line.
//
//   16 CFR Part 465 (USD 51,744 per violation) bans AI generated testimonials
//   and any endorsement from a source with no real experience of the product.
//   A synthetic persona may never claim to be human and may never claim first
//   hand experience. Labelling the video does NOT cure that, so the prompt side
//   guard lives in persona-blocks/AI_DISCLOSURE.md and must ship alongside.
//
// Copy rules baked in here:
//   - Never name a supplier. Audience copy states the capability, never who
//     provides it.
//   - Never name internal systems, channels or bot handles.
//   - Plain language only. "AI" and "computer generated", never "assistant",
//     "virtual agent" or any other euphemism a regulator would call vague.
//
// Exported:
//   AI_DISCLOSURE_COPY            -> the canonical strings, single source
//   renderAiBadge(options)        -> persistent on screen indicator, inline styled
//   renderSyntheticMediaLabel(o)  -> corner label for generated video
// =============================================================================

/**
 * Canonical disclosure strings. Every audience facing surface reads from here
 * so one wording change propagates to the whole fleet.
 *
 * @type {{badge: string, beforeInteraction: string, spokenOpening: string, syntheticMedia: string, notHumanAnswer: string}}
 */
export const AI_DISCLOSURE_COPY = {
  /** Short label for the always visible indicator. */
  badge: "AI generated",
  /** Shown before a person can start interacting. Satisfies Article 50(1). */
  beforeInteraction:
    "You are about to talk with an AI. The face and voice are computer generated and do not belong to a real person.",
  /** First thing the persona says out loud on turn one. */
  spokenOpening:
    "Before we start, you should know I am an AI, not a person. My face and voice are computer generated.",
  /** Label burned onto generated video. Satisfies Article 50(4). */
  syntheticMedia: "AI generated video. Synthetic face and voice.",
  /** Canonical answer when asked whether they are real, human, or a recording. */
  notHumanAnswer:
    "No, I am an AI. I am not a person, and my face and voice are computer generated.",
};

/**
 * Render the persistent AI indicator. Inline styled and self contained so it
 * drops into a raw HTML page or a worker built string with no CSS plumbing.
 *
 * Must remain visible for the whole session, not just on open. A dismissible
 * badge does not satisfy "persistent" under the Commission guidance.
 *
 * @param {Object} [options] - Presentation overrides.
 * @param {string} [options.label] - Badge text. Defaults to the canonical copy.
 * @param {string} [options.position] - CSS position value. Defaults to "absolute".
 * @param {string} [options.placement] - Corner offsets. Defaults to top left.
 * @param {string} [options.zIndex] - Stacking order above the video surface.
 * @returns {string} HTML for the indicator.
 */
export function renderAiBadge(options = {}) {
  const {
    label = AI_DISCLOSURE_COPY.badge,
    position = "absolute",
    placement = "top: 10px; left: 10px;",
    zIndex = "40",
  } = options;
  const style = [
    `position: ${position}`,
    placement.replace(/;\s*$/, ""),
    `z-index: ${zIndex}`,
    "display: inline-flex",
    "align-items: center",
    "gap: 6px",
    "padding: 4px 9px",
    "border-radius: 999px",
    "background: rgba(8, 12, 10, 0.72)",
    "border: 1px solid rgba(255, 255, 255, 0.28)",
    "color: #f4f6f5",
    "font: 600 11px/1.2 system-ui, sans-serif",
    "letter-spacing: 0.02em",
    "pointer-events: none",
    "white-space: nowrap",
  ].join("; ");
  return (
    `<span class="ai-disclosure-badge" role="note" aria-label="${AI_DISCLOSURE_COPY.beforeInteraction}" style="${style}">` +
    `<span aria-hidden="true" style="width:6px;height:6px;border-radius:50%;background:#7ee0b8;flex:none"></span>` +
    `${label}</span>`
  );
}

/**
 * Render the synthetic media label for a generated video clip.
 *
 * Applies to clips generated and published on or after 2026-08-02. Anything
 * both generated and published before that date needs no retroactive label.
 *
 * @param {Object} [options] - Presentation overrides.
 * @param {string} [options.text] - Label text. Defaults to the canonical copy.
 * @param {string} [options.placement] - Corner offsets. Defaults to bottom right.
 * @returns {string} HTML for the label.
 */
export function renderSyntheticMediaLabel(options = {}) {
  const { text = AI_DISCLOSURE_COPY.syntheticMedia, placement = "bottom: 10px; right: 10px;" } = options;
  return renderAiBadge({ label: text, placement, zIndex: "41" });
}
