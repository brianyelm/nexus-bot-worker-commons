/**
 * Put every fleet Tavus persona on the same AI disclosure footing.
 *
 *   node scripts/sync-tavus-disclosure.mjs <TAVUS_API_KEY> [--dry]
 *
 * Why this is a fleet script and not per repo: the personas are spread across
 * five apps, three of them provision their persona in code and two were typed
 * into the Tavus dashboard by hand. The disclosure settings are the same on all
 * of them, they are the settings with a regulator attached, and every one of
 * them was silently wrong in the same way, so they get one owner.
 *
 * What was wrong: disclosure_type and emotion_recognition both sat on "auto".
 * "auto" resolves from a policy flag on the conversation, nothing in this fleet
 * has ever sent one, so the platform disclosure had never fired anywhere and
 * emotion inference ran full for everyone by default rather than by decision.
 *
 * This script does NOT own prompts. Each app owns its own brain. The two hand
 * maintained personas below carry a `prompt` patch only because their prompt
 * lives nowhere but in the Tavus dashboard, and one of them was naming a second
 * company on a customer facing surface.
 */
import { AI_DISCLOSURE_COPY } from "../src/lib/aiDisclosure.js";

const API = "https://tavusapi.com/v2";
const key = process.argv[2];
const dryRun = process.argv.includes("--dry");
if (!key) throw new Error("usage: node sync-tavus-disclosure.mjs <TAVUS_API_KEY> [--dry]");

const H = { "x-api-key": key, "content-type": "application/json" };

/** The settings every audience facing fleet persona gets. */
const DISCLOSURE = {
  disclosure_type: "always",
  verbal_disclosure: AI_DISCLOSURE_COPY.spokenOpening,
  visual_disclosure: AI_DISCLOSURE_COPY.visualBanner,
};

/**
 * Emotion inference, pinned rather than left to resolve from a policy flag.
 *
 * "full" is a decision, not a default. The Act restricts inferring emotion from
 * biometrics in WORKPLACE and EDUCATION deployments, meaning an employer
 * reading its own staff or a school its students. A sales conversation, a
 * support conversation and a conference host talking to attendees who chose to
 * join are none of those. Where it is permitted the remaining duty is notice,
 * and no vendor ships a banner for it, so the notice is ours to place.
 *
 * A persona that ever points at an employee facing or training surface must be
 * moved to "limited" here.
 */
const EMOTION = "full";

/**
 * Personas whose prompts live in code, in the app that owns them. Disclosure
 * settings only: touching their prompt here would be overwritten by their own
 * sync on the next run.
 *
 * The two website Lunas are deliberately absent. blackravenit-site owns them
 * and applies the same constants from its own sync, because its prompt and its
 * disclosure have to move together (the prompt stands down from opening with
 * the disclosure only when the platform is really set to say it).
 */
const CODE_OWNED = [
  { id: "p58373bbfb43", label: "Luna video trained (luna-demo recorder)", skip: true,
    // Skipped on purpose. This persona exists to PRE RENDER clips. Switching on
    // a spoken disclosure would prepend it to every recorded clip and bill the
    // minutes for it. The demo stage carries the visible badge instead.
    why: "pre-render only, disclosure would be baked into every clip" },
  { id: "p4760a22e886", label: "Jacob ElevenLabs voice test", skip: true,
    why: "voice test rig, never faces an audience" },
];

/**
 * Personas typed into the dashboard by hand, with no code that owns them.
 * These carry prompt edits because there is nowhere else for the text to live.
 *
 * @type {{id: string, label: string, edits: Array<[RegExp|string, string]>}[]}
 */
const HAND_MAINTAINED = [
  {
    id: "pdac8c14acb7",
    label: "Courtney Black Raven",
    edits: [
      // She has no greeting set at all, so "say it in your first sentence" was
      // the ONLY disclosure on this persona and it was left to the model to
      // remember. The platform says it now, before her first word, so this
      // instruction would make her say it twice.
      [
        "Say you are an AI in your first sentence.",
        "Your AI disclosure is spoken for you before your first word, so do not open by " +
          "repeating it. If anyone asks whether you are real, human, or a recording, answer no " +
          "immediately and without qualification. Never claim to have used a product yourself.",
      ],
    ],
  },
  {
    id: "p78505f0a908",
    label: "Luna EO Summit Host",
    edits: [
      // Standing rule: to the customer, Black Raven does it all. This persona
      // stands in front of a paying room and was naming a second company we
      // own, twice, one of them in a scripted answer to "who is behind this".
      [/\s*(?:and|,)\s*Morphora\.ai/gi, ""],
      [/Black Raven IT's/g, "Black Raven's"],
      [/Black Raven IT/g, "Black Raven"],
    ],
  },
];

/**
 * @param {string} path
 * @param {object} [init]
 * @returns {Promise<object>}
 */
async function tavus(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: H });
  const text = await res.text();
  if (!res.ok) throw new Error(`Tavus ${res.status} on ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Patch one persona's disclosure settings, and its prompt if edits are given.
 * @param {{id: string, label: string, edits?: Array}} persona
 * @returns {Promise<void>}
 */
async function sync(persona) {
  const before = await tavus(`/personas/${persona.id}`);
  console.log(`\n=== ${persona.label}  ${persona.id}`);
  console.log(`  was: disclosure=${before.disclosure_type} emotion=${before.layers?.perception?.emotion_recognition}`);

  const ops = [
    { op: "replace", path: "/disclosure_type", value: DISCLOSURE.disclosure_type },
    { op: "replace", path: "/verbal_disclosure", value: DISCLOSURE.verbal_disclosure },
    { op: "replace", path: "/visual_disclosure", value: DISCLOSURE.visual_disclosure },
  ];
  // Only if the persona already has a perception layer. Patching a path into a
  // layer that is not there is a 400, and a persona with no perception layer is
  // not inferring emotion in the first place.
  if (before.layers?.perception) {
    ops.push({ op: "replace", path: "/layers/perception/emotion_recognition", value: EMOTION });
  }

  if (persona.edits) {
    let prompt = before.system_prompt || "";
    for (const [find, replace] of persona.edits) {
      const next = prompt.replace(find, replace);
      if (next === prompt) console.warn(`  WARN no match for ${find}`);
      prompt = next;
    }
    // Collapse any double spacing left behind by a deletion.
    prompt = prompt.replace(/ {2,}/g, " ");
    if (prompt !== before.system_prompt) {
      console.log(`  prompt ${before.system_prompt.length} -> ${prompt.length}`);
      ops.push({ op: "replace", path: "/system_prompt", value: prompt });
    }
  }

  if (dryRun) {
    console.log(`  [dry] would patch ${ops.length} field(s)`);
    return;
  }

  await tavus(`/personas/${persona.id}`, { method: "PATCH", body: JSON.stringify(ops) });

  const after = await tavus(`/personas/${persona.id}`);
  console.log(`  now: disclosure=${after.disclosure_type} emotion=${after.layers?.perception?.emotion_recognition}`);
  // The whole point of the run. A persona that still says "auto" here has not
  // been fixed, whatever the PATCH returned.
  if (after.disclosure_type !== "always") {
    throw new Error(`${persona.id}: disclosure_type is still ${after.disclosure_type}`);
  }
  // Standing rule, checked rather than assumed: one brand to the customer.
  if (/Morphora/i.test(after.system_prompt || "")) {
    throw new Error(`${persona.id}: still names a second company in its prompt`);
  }
}

for (const persona of CODE_OWNED) {
  if (persona.skip) {
    console.log(`\n=== ${persona.label}  ${persona.id}\n  SKIPPED: ${persona.why}`);
    continue;
  }
  await sync(persona);
}
for (const persona of HAND_MAINTAINED) await sync(persona);

console.log("\ndone");
