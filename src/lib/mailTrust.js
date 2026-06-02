// =============================================================================
// lib/mailTrust.js - Shared inbound-email sender trust gate.
//
// Cross-surface memory recall (buildContactRecall) keys on the sender's email
// address. A raw From header is trivially spoofable, so before treating an
// inbound sender as a known Black Raven user (and unlocking that person's shared
// memory across chat/voice/phone/email), the poller MUST verify the message is
// authentic.
//
// Trust signal: DMARC pass OR Exchange-stamped intra-org authentication.
//   - dmarc=pass  -> the From domain authorized this sender (external mail).
//   - x-ms-exchange-organization-authas: Internal -> stamped by Exchange on
//     genuine intra-tenant mail and STRIPPED from inbound external mail by EOP,
//     so an external spoofer cannot forge it. Intra-org mail legitimately
//     reports dmarc=none, which is why a DMARC-pass-only gate wrongly rejects
//     internal senders like owner@blackravenit.com.
//
// This was previously a per-bot copy in maxwell-worker; promoted here so every
// bot's mail poller enforces the same gate (one source of truth).
// =============================================================================

/**
 * Evaluate whether an inbound message's sender can be trusted as authentic.
 *
 * @param {object|Array} msgOrHeaders - either a Graph message object carrying
 *   `internetMessageHeaders`, or the `internetMessageHeaders` array directly.
 * @returns {{ dmarc: string, authAs: string, trusted: boolean }}
 */
export function senderTrust(msgOrHeaders) {
  const headers = Array.isArray(msgOrHeaders)
    ? msgOrHeaders
    : (msgOrHeaders?.internetMessageHeaders || []);
  const headerValue = (name) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
  const ar = headerValue("authentication-results");
  const dmarc = /dmarc=(\w+)/i.exec(ar)?.[1]?.toLowerCase() || "unknown";
  const authAs = headerValue("x-ms-exchange-organization-authas").toLowerCase();
  return { dmarc, authAs, trusted: dmarc === "pass" || authAs === "internal" };
}
