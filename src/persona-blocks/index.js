// =============================================================================
// persona-blocks — canonical text blocks injected into each bot's system prompt.
//
// FLEET_OUTPUT_STYLE is the fleet-wide output formatting style guide. Personas
// import it and concatenate it into the system prompt so chat/persona replies
// follow the same rules as cron-built reports.
//
// Loading mechanism: wrangler's [[rules]] type = "Text" globs = ["**/*.md"]
// turns .md files into string imports at bundle time. Each consuming bot's
// wrangler.toml must declare this rule (most already do; see courtney-worker
// and moxie-worker for the canonical pattern).
//
// Node tests do NOT exercise this entry point — .md imports are wrangler-only.
// Tests import directly from src/lib/*.js.
// =============================================================================

import FLEET_OUTPUT_STYLE from "./FLEET_OUTPUT_STYLE.md";

export { FLEET_OUTPUT_STYLE };
