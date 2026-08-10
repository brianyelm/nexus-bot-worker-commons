/**
 * Put the built Courtney brain onto her Tavus persona.
 *
 *   node --import ./testing/register-md.mjs scripts/sync-courtney-face.mjs <TAVUS_API_KEY> [--dry]
 *
 * The --import is not optional: the knowledge modules are .md text imports that
 * only Wrangler resolves natively, and the same loader the test suite uses makes
 * them work under plain node.
 *
 * WHY THIS SCRIPT EXISTS, and why it is a PATCH rather than a clone:
 *
 * Courtney's face persona pdac8c14acb7 is worn by two surfaces that resolve it
 * by id, fleet-luna (COURTNEY_PERSONA_ID) and fleet-video (FLEET_TAVUS_PERSONAS).
 * Cloning her the way fleet-luna clones Luna would mint a new id on every
 * provision, which fleet-luna caches in D1 and fleet-video cannot follow at all,
 * so the two surfaces would drift onto different Courtneys. Patching the one
 * persona keeps them on the same brain by construction.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not give her a custom LLM layer.
 * She stays on the Tavus hosted model. That is a platform limit, not a
 * preference: PATCH cannot write layers.llm at all (an add or replace against it
 * answers 304 and persists nothing, and a replace on /layers/llm/model deletes
 * the whole object), so a Claude brain for her means a NEW persona and a
 * config change in both consumers. The bug this closes is ignorance rather than
 * model quality, and the live website Luna has run an 18k prompt on the same
 * hosted model since January, so the prompt is the part worth shipping first.
 *
 * Disclosure settings are NOT touched here. sync-tavus-disclosure.mjs owns those
 * for the whole fleet and this script must never fight it.
 */
import { buildCourtneyBrain } from "../src/personas/courtney.js";

const API = "https://tavusapi.com/v2";
const PERSONA_ID = "pdac8c14acb7";
const key = process.argv[2];
const dryRun = process.argv.includes("--dry");
if (!key) throw new Error("usage: sync-courtney-face.mjs <TAVUS_API_KEY> [--dry]");

const H = { "x-api-key": key, "content-type": "application/json" };

/**
 * "demo", not "desk".
 *
 * Both surfaces that wear this persona are gated and attended: fleet-luna sits
 * behind LUNA_PIN and fleet-video behind its own PIN, and in both cases someone
 * from our team is holding the screen. That is the surface she is actually on.
 *
 * platformDisclosure is true because her persona carries disclosure_type
 * "always", so Tavus speaks the disclosure before her first word. Building
 * without this flag would have her repeat it inside ten seconds, which reads as
 * a fault. If the disclosure sweep ever moves her off "always", this flips back
 * to false the same day or nobody discloses at all.
 */
const brain = buildCourtneyBrain({
  surface: "demo",
  platformDisclosure: true,
  // The persona shipped carrying the context "Evaluation call.", which was true
  // when she was a face and voice test rig and has been false since she went on
  // a screen in front of people. It is replaced rather than blanked so the next
  // person who opens her in the Builder is told, in the field they are about to
  // type into, that typing there accomplishes nothing.
  context:
    "Live conversation. This persona is provisioned from code: its prompt, context and "
    + "greeting are overwritten by nexus-bot-worker-commons scripts/sync-courtney-face.mjs. "
    + "Edit src/personas/courtney.js and re-run that script. Changes typed here are lost.",
});

/**
 * @param {string} path
 * @param {Object} [init]
 * @returns {Promise<Object>}
 */
async function tavus(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: H });
  // A no-op PATCH answers 304 with an empty body. That is success.
  if (res.status === 304) return {};
  if (!res.ok) throw new Error(`Tavus ${res.status} on ${path}: ${(await res.text()).slice(0, 240)}`);
  return res.json().catch(() => ({}));
}

const before = await tavus(`/personas/${PERSONA_ID}?target=live`);
console.log(`[courtney] ${before.persona_name}`);
console.log(`[courtney] prompt ${(before.system_prompt || "").length} -> ${brain.systemPrompt.length} chars`);
console.log(`[courtney] context ${(before.context || "").length} -> ${brain.context.length} chars`);
console.log(`[courtney] greeting ${JSON.stringify(before.greeting || "")} -> ${JSON.stringify(brain.greeting)}`);

const ops = [
  { op: "replace", path: "/system_prompt", value: brain.systemPrompt },
  { op: "replace", path: "/context", value: brain.context },
  { op: "replace", path: "/greeting", value: brain.greeting },
];

if (dryRun) {
  console.log("[courtney] --dry, nothing sent");
  process.exit(0);
}

// ?target=live is load bearing. Without it the PATCH edits the Builder DRAFT,
// returns a cheerful 200, and the live persona serves the old brain forever.
await tavus(`/personas/${PERSONA_ID}?target=live`, { method: "PATCH", body: JSON.stringify(ops) });

// Never trust the response code. The draft write above returns 200 too, so the
// only proof the live persona changed is reading it back.
const after = await tavus(`/personas/${PERSONA_ID}?target=live`);
const ok =
  after.system_prompt === brain.systemPrompt &&
  after.context === brain.context &&
  after.greeting === brain.greeting;
console.log(`[courtney] live re-read: prompt ${(after.system_prompt || "").length} chars, ${ok ? "MATCHES" : "DOES NOT MATCH"}`);
if (!ok) {
  console.error("[courtney] the live persona did not take the patch. Do not assume it shipped.");
  process.exit(1);
}
console.log("[courtney] done");
