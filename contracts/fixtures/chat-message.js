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
