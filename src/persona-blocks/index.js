// =============================================================================
// persona-blocks: canonical text blocks injected into each bot's system prompt.
//
// FLEET_OUTPUT_STYLE: fleet-wide output formatting style guide.
// FLEET_CLIENT_CODES: convention for resolving 3-4 letter acronyms to CRM
//   client codes (e.g. "SEP" -> SEP Construction's Nexus channel + org).
//
// Personas import these and concatenate them into the system prompt so
// chat/persona replies follow the same rules as cron-built reports.
//
// Loading mechanism: wrangler's [[rules]] type = "Text" globs = ["**/*.md"]
// turns .md files into string imports at bundle time. Each consuming bot's
// wrangler.toml must declare this rule (most already do; see courtney-worker
// and moxie-worker for the canonical pattern).
//
// Node tests do NOT exercise this entry point; .md imports are wrangler-only.
// Tests import directly from src/lib/*.js.
// =============================================================================

import FLEET_OUTPUT_STYLE from "./FLEET_OUTPUT_STYLE.md";
import FLEET_CLIENT_CODES from "./FLEET_CLIENT_CODES.md";
// Canonical who-owns-what across the fleet. Every persona imports this. Without
// it a bot asked for a capability it lacks invents a teammate who has it, which
// is how a Dehashed request got bounced Courtney -> Dexter -> Robert in August
// 2026 and landed on the one bot with no breach tooling at all. Update this file
// whenever a bot gains or loses a capability domain; do not restate ownership
// inside individual personas.
import FLEET_CAPABILITY_MAP from "./FLEET_CAPABILITY_MAP.md";
// Confidence + grace block for the women on the fleet (Courtney, Kate, Moxie,
// Wren). Opt-in named export: only those personas import it, so the male bots'
// prompts are untouched.
import SELF_ASSURED_CHARM from "./SELF_ASSURED_CHARM.md";
// Mandatory for any persona that renders to an audience with a synthetic face
// or voice: discloses the AI at turn one, refuses to claim humanity, and blocks
// first hand product testimonials. Required from 2026-08-02 by EU AI Act
// Article 50 and already live under NY synthetic performer rules; the FTC
// testimonial exposure (16 CFR 465) has no start date. Pair it with the visible
// indicator from lib/aiDisclosure.js, which carries the full citation notes.
import AI_DISCLOSURE from "./AI_DISCLOSURE.md";
// Appended AFTER AI_DISCLOSURE, and only on a surface where the rendering
// platform speaks the disclosure itself before the persona's first word. It
// cancels exactly one instruction, "open your first turn by disclosing", and
// leaves every other rule in that block standing. Without it the platform and
// the persona both disclose and she says it twice in ten seconds.
import AI_DISCLOSURE_PLATFORM from "./AI_DISCLOSURE_PLATFORM.md";

export {
  FLEET_OUTPUT_STYLE,
  FLEET_CLIENT_CODES,
  FLEET_CAPABILITY_MAP,
  SELF_ASSURED_CHARM,
  AI_DISCLOSURE,
  AI_DISCLOSURE_PLATFORM,
};
