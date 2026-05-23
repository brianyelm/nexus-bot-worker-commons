// =============================================================================
// persona-blocks -- canonical text blocks injected into each bot's system prompt.
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
// Node tests do NOT exercise this entry point -- .md imports are wrangler-only.
// Tests import directly from src/lib/*.js.
// =============================================================================

import FLEET_OUTPUT_STYLE from "./FLEET_OUTPUT_STYLE.md";
import FLEET_CLIENT_CODES from "./FLEET_CLIENT_CODES.md";

export { FLEET_OUTPUT_STYLE, FLEET_CLIENT_CODES };
