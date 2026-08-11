// Canonical valid chat-message (@mention) callback payload. Defined as a JS
// object (never a committed .json string) so Git autocrlf can't mutate bytes
// and break the HMAC when it is signed at test time.
export const chatMessageFixture = {
  message_id: "msg-abc123",
  channel_slug: "maxwell-finance",
  user_id: "69276926-7182-4920-a849-fc6f27dc049b",
  user_email: "owner@blackravenit.com",
  display_name: "Brian",
  body: "@maxwell what's our AR aging this week?",
  mentioned_bot_id: "bot_maxwell",
  trigger_type: "mention",
  reply_to: null,
  attachments: [],
  timestamp: 1716740000000,
};

// FleetView dispatch of the same shape. Identical to the Nexus payload plus
// the three routing fields that select webhook delivery. channel_slug is the
// bot's HOME channel: FleetView has no channel of its own, and the home channel
// is where a substantive answer gets mirrored.
export const chatMessageFleetViewFixture = {
  ...chatMessageFixture,
  message_id: "fv-msg-abc123",
  body: "@maxwell what's our AR aging this week?",
  source: "fleetview",
  reply_webhook: "https://fleet.blackravenit.com/api/bot-reply",
  thread_id: "fv-thread-abc123",
};
