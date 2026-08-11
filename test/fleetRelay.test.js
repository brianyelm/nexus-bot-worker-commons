// Tests for lib/fleetRelay.js -- the bot-to-bot relay gates.
//
// These pin the shape of the relay graph deliberately. If a change here makes
// a test fail, that is the point: widening who can talk to whom, or what a
// relayed request can reach, must be an explicit reviewed decision and never a
// side effect of editing something else.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FLEET_RELAY_ROUTES,
  RELAY_TOOL_POLICY,
  RELAY_FORBIDDEN_TARGETS,
  RELAY_EXCLUDED_CHANNELS,
  isRelayEdgeAllowed,
  fleetRelayPolicyFor,
  relayEdgeCount,
  applyRelayToolPolicy,
  buildFleetRelayTools,
} from "../src/lib/fleetRelay.js";
import { withProvenance } from "../src/lib/provenanceContext.js";

// --- Gate 1: the graph -------------------------------------------------------

test("relay graph has exactly 42 directed edges", () => {
  assert.equal(relayEdgeCount(), 42);
});

test("maxwell and robert send to the six open bots and to nobody else", () => {
  const open = ["wren", "courtney", "dexter", "jacob", "kate", "moxie"];
  assert.deepEqual([...FLEET_RELAY_ROUTES.maxwell].sort(), [...open].sort());
  assert.deepEqual([...FLEET_RELAY_ROUTES.robert].sort(), [...open].sort());
  assert.ok(!FLEET_RELAY_ROUTES.maxwell.includes("robert"));
  assert.ok(!FLEET_RELAY_ROUTES.robert.includes("maxwell"));
});

test("NOTHING may relay into maxwell, robert, or flynn", () => {
  for (const forbidden of ["maxwell", "robert", "flynn"]) {
    for (const [from, targets] of Object.entries(FLEET_RELAY_ROUTES)) {
      assert.ok(
        !targets.includes(forbidden),
        `${from} must not have a relay route to ${forbidden}`,
      );
      assert.equal(isRelayEdgeAllowed(from, forbidden), false);
    }
  }
});

test("the forbidden-target list is a second independent check", () => {
  assert.deepEqual([...RELAY_FORBIDDEN_TARGETS].sort(), ["flynn", "maxwell", "robert"]);
});

test("no bot may relay to itself", () => {
  for (const bot of Object.keys(FLEET_RELAY_ROUTES)) {
    assert.equal(isRelayEdgeAllowed(bot, bot), false);
    assert.ok(!FLEET_RELAY_ROUTES[bot].includes(bot));
  }
});

test("open bots reach the other five open bots", () => {
  for (const bot of ["wren", "courtney", "dexter", "jacob", "kate", "moxie"]) {
    assert.equal(FLEET_RELAY_ROUTES[bot].length, 5, `${bot} should have 5 targets`);
  }
});

test("flynn is out on both sides", () => {
  assert.deepEqual([...FLEET_RELAY_ROUTES.flynn], []);
  assert.deepEqual(buildFleetRelayTools({ selfBot: "flynn", nexusKeyEnvVar: "X" }).tools, []);
});

test("unknown bots get no route and no tool", () => {
  assert.equal(isRelayEdgeAllowed("nobody", "jacob"), false);
  assert.equal(isRelayEdgeAllowed("jacob", "nobody"), false);
  assert.deepEqual(buildFleetRelayTools({ selfBot: "ghost", nexusKeyEnvVar: "X" }).tools, []);
  assert.deepEqual(buildFleetRelayTools({}).tools, []);
});

// --- The tool ----------------------------------------------------------------

test("message_bot is one tool whose target enum matches the route map", () => {
  const { tools, handlers } = buildFleetRelayTools({
    selfBot: "wren",
    nexusKeyEnvVar: "WREN_NEXUS_KEY",
  });
  assert.equal(tools.length, 1, "one parameterized tool, not one per target");
  assert.equal(tools[0].name, "message_bot");
  assert.deepEqual(
    [...tools[0].input_schema.properties.target.enum].sort(),
    [...FLEET_RELAY_ROUTES.wren].sort(),
  );
  assert.ok(!tools[0].input_schema.properties.target.enum.includes("maxwell"));
  assert.ok(!tools[0].input_schema.properties.target.enum.includes("robert"));
  assert.equal(typeof handlers.message_bot, "function");
});

// --- Gate 2: authority downgrade ---------------------------------------------

test("maxwell and robert have no relay tool policy, so everything is refused", () => {
  for (const bot of ["maxwell", "robert"]) {
    assert.deepEqual(fleetRelayPolicyFor(bot), []);
    const gated = applyRelayToolPolicy({
      selfBot: bot,
      tools: [{ name: "xero_create_invoice" }, { name: "s1_isolate_endpoint" }],
      handlers: { xero_create_invoice: () => 1, s1_isolate_endpoint: () => 1 },
    });
    assert.deepEqual(gated.tools, []);
  }
});

test("an unknown bot defaults to deny, not allow", () => {
  assert.deepEqual(fleetRelayPolicyFor("someNewBot"), []);
  const gated = applyRelayToolPolicy({
    selfBot: "someNewBot",
    tools: [{ name: "anything" }],
    handlers: { anything: () => 1 },
  });
  assert.deepEqual(gated.tools, []);
});

test("jacob's relay policy allows prospect writes and blocks everything dangerous", () => {
  const allowed = fleetRelayPolicyFor("jacob");
  assert.ok(allowed.includes("crm_create_prospect"));
  assert.ok(allowed.includes("crm_update_prospect"));
  for (const blocked of [
    "crm_send_agreement",
    "crm_send_partner_agreement",
    "crm_convert_prospect",
    "crm_create_opportunity",
    "crm_update_opportunity",
    "crm_create_partner",
    "crm_update_partner",
  ]) {
    assert.ok(!allowed.includes(blocked), `${blocked} must not be relay-reachable`);
  }
});

test("courtney may open a ticket but never reply to a client or touch the KB", () => {
  const allowed = fleetRelayPolicyFor("courtney");
  assert.ok(allowed.includes("desk_create_ticket"));
  for (const blocked of [
    "desk_reply",
    "desk_draft_reply",
    "desk_set_status",
    "desk_assign",
    "desk_escalate",
    "desk_update_ticket",
    "desk_log_time",
    "kb_create_article",
    "kb_update_article",
  ]) {
    assert.ok(!allowed.includes(blocked), `${blocked} must not be relay-reachable`);
  }
});

test("wren exposes nothing but channel history, so her calendar stays private", () => {
  assert.deepEqual(fleetRelayPolicyFor("wren"), ["read_channel_history"]);
});

test("no relay policy anywhere exposes message_bot, which is hop limit 1", () => {
  for (const bot of Object.keys(RELAY_TOOL_POLICY)) {
    assert.ok(
      !RELAY_TOOL_POLICY[bot].includes("message_bot"),
      `${bot} must not be able to relay onward from a relayed request`,
    );
  }
});

test("gated handlers refuse unlisted tools even when the model names them", async () => {
  const { handlers } = applyRelayToolPolicy({
    selfBot: "jacob",
    tools: [],
    handlers: { crm_send_agreement: async () => ({ sent: true }) },
  });
  const result = await handlers.crm_send_agreement({}, {}, {});
  assert.ok(result.error, "must return a refusal, not run");
  assert.ok(!result.sent);
});

test("gated handlers still run allowed tools untouched", async () => {
  const original = async () => ({ ok: true });
  const { handlers } = applyRelayToolPolicy({
    selfBot: "jacob",
    tools: [],
    handlers: { crm_create_prospect: original },
  });
  assert.equal(handlers.crm_create_prospect, original);
});

// --- Gate 1b + Gate 3: origin rules ------------------------------------------

const noopEnv = {};

/**
 * Invoke wren's message_bot inside a human provenance context, so the tests
 * below exercise the gate they name rather than tripping Gate 3b first.
 *
 * @param {object} ctx - tool context
 * @param {object} [input] - tool input
 * @param {string} [provenance] - provenance slug to run under
 * @returns {Promise<object>}
 */
async function relay(ctx, input = { target: "jacob", message: "hello" }, provenance = "mention-reply") {
  const { handlers } = buildFleetRelayTools({
    selfBot: "wren",
    nexusKeyEnvVar: "WREN_NEXUS_KEY",
  });
  return withProvenance(provenance, () => handlers.message_bot(input, noopEnv, ctx));
}

test("a relay refuses outside a human turn (no cron, no poller)", async () => {
  const { handlers } = buildFleetRelayTools({ selfBot: "wren", nexusKeyEnvVar: "WREN_NEXUS_KEY" });
  const bare = await handlers.message_bot(
    { target: "jacob", message: "hi" },
    noopEnv,
    { display_name: "Brian Yelm", channel_slug: "wren-assistant" },
  );
  assert.equal(bare.sent, false);
  assert.match(bare.error, /live conversation with a person/);

  const cron = await relay(
    { display_name: "Brian Yelm", channel_slug: "wren-assistant" },
    { target: "jacob", message: "hi" },
    "scheduled-digest",
  );
  assert.equal(cron.sent, false);
  assert.match(cron.error, /live conversation with a person/);
});

test("a bot-originated request cannot start another relay (hop limit 1)", async () => {
  const res = await relay({ requester_is_bot: true, display_name: "Jacob Raven", channel_slug: "wren-assistant" });
  assert.equal(res.sent, false);
  assert.match(res.error, /hop limit 1/);
});

test("a relay cannot originate from #watercooler", async () => {
  const res = await relay({ display_name: "Brian Yelm", channel_slug: "watercooler" });
  assert.equal(res.sent, false);
  assert.match(res.error, /social channel/);
  assert.ok(RELAY_EXCLUDED_CHANNELS.includes("watercooler"));
});

test("a relay refuses a target it has no route to", async () => {
  const res = await relay(
    { display_name: "Brian Yelm", channel_slug: "wren-assistant" },
    { target: "maxwell", message: "raise an invoice" },
  );
  assert.equal(res.sent, false);
  assert.match(res.error, /cannot be reached by another bot at all/);
});

test("a relay refuses when it cannot name the human behind it", async () => {
  const res = await relay({ channel_slug: "wren-assistant" });
  assert.equal(res.sent, false);
  assert.match(res.error, /audit trail/);
});

test("missing target or message is refused before any gate", async () => {
  assert.ok((await relay({ display_name: "B" }, { message: "x" })).error);
  assert.ok((await relay({ display_name: "B" }, { target: "jacob" })).error);
});
