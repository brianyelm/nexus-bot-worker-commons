// =============================================================================
// knowledge/index.js - Business knowledge shared by every bot that talks about
// Black Raven to an outsider.
//
// These four modules used to live only in jacob-worker/src/personas/skills.
// That was fine while Jacob was the only bot doing outward facing sales, and
// stopped being fine the moment Luna started meeting people at events with a
// single hand written brain.js: the two would answer "what do you actually do"
// differently, and the one with the thinner file would be the one standing in
// front of a prospect.
//
// So they live here now, canonical, and Jacob imports them from here rather
// than keeping his own copy. One brain, one set of facts, one place to correct
// a price or a service line.
//
// What is deliberately NOT here: EMAIL_TEMPLATES, M365_QUOTING, PARTNER_*,
// MORPHORA_PROSPECTING and the per person files. Those are Jacob's working
// machinery for sending mail and building quotes, not knowledge about the
// business, and an ambassador has no use for them.
//
// Consumers need a Text module rule in their wrangler.toml:
//   [[rules]]
//   type = "Text"
//   globs = ["**/*.md"]
//   fallthrough = true
// =============================================================================

import COMPANY_KNOWLEDGE from "./COMPANY_KNOWLEDGE.md";
import SERVICE_OFFERINGS from "./SERVICE_OFFERINGS.md";
import TEAM_AND_CONTACTS from "./TEAM_AND_CONTACTS.md";
import COMPETITOR_DISPLACEMENT from "./COMPETITOR_DISPLACEMENT.md";

export { COMPANY_KNOWLEDGE, SERVICE_OFFERINGS, TEAM_AND_CONTACTS, COMPETITOR_DISPLACEMENT };

/**
 * The outward facing set, in the order a stranger's questions tend to arrive:
 * who are you, what do you sell, who would I be dealing with, why you and not
 * the incumbent.
 *
 * @returns {string}
 */
export function fleetKnowledge() {
  return [
    COMPANY_KNOWLEDGE,
    SERVICE_OFFERINGS,
    TEAM_AND_CONTACTS,
    COMPETITOR_DISPLACEMENT,
  ].join("\n\n");
}
