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
// Headings written for US, not for a customer. On a public surface these are
// worse than useless: ask the right question and you get our qualifying script
// read back at you, or our pricing posture.
const INTERNAL_HEADINGS = [
  "Qualifying Questions",
  "Additional Objection Handling",
  "Objection Handling",
  "How We Price",
  "Anti-patterns",
];

/**
 * Drop markdown sections whose heading is written for internal use.
 *
 * @param {string} md
 * @returns {string}
 */
function stripInternalSections(md) {
  const out = [];
  let skipping = false;
  for (const line of md.split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const title = heading[2].trim().toLowerCase();
      if (INTERNAL_HEADINGS.some((h) => title.startsWith(h.toLowerCase()))) {
        skipping = true;
        continue;
      }
      // Any heading at h1 or h2 ends the skip; deeper ones are subsections of it.
      if (skipping && heading[1].length <= 2) skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").trim();
}

export function fleetKnowledge({ publicSafe = false } = {}) {
  if (publicSafe) {
    // COMPETITOR_DISPLACEMENT is omitted ENTIRELY. It is a step by step internal
    // process for turning a competitor's invoice into a priced opportunity, with
    // a competitor crosswalk and a worked example naming a real client. There is
    // no public-safe subset of it.
    //
    // Luna caught this on the live site and refused: "this actually looks like
    // an internal pricing and mapping workflow for a Black Raven sales
    // opportunity, not something I'd walk a guest through". She was right, and
    // she should never have been holding it.
    //
    // TEAM_AND_CONTACTS stays out for the reason it always did: real names.
    return [
      stripInternalSections(COMPANY_KNOWLEDGE),
      stripInternalSections(SERVICE_OFFERINGS),
    ].join("\n\n");
  }
  return [
    COMPANY_KNOWLEDGE,
    SERVICE_OFFERINGS,
    TEAM_AND_CONTACTS,
    COMPETITOR_DISPLACEMENT,
  ].join("\n\n");
}
