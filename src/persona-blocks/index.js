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

export { FLEET_OUTPUT_STYLE, FLEET_CLIENT_CODES, SELF_ASSURED_CHARM, AI_DISCLOSURE };
