// =============================================================================
// contracts/nexus-callbacks.js -- the versioned Nexus <-> bot wire contract.
//
// Single source of truth for the payload shapes Nexus POSTs to a bot worker's
// /api/internal/* callback routes. Validators are pure functions returning an
// array of error strings (empty array === valid), so they run unchanged under
// node:test, Vitest, vitest-pool-workers, and the nexus-app sim with zero
// tooling. Both sides validate against this: Nexus asserts it EMITS conforming
// payloads; bot workers assert they ACCEPT conforming payloads.
//
// Hard rule (do not "fix"): modal-submit carries submitted field values under
// `values` (an object map), NOT `fields`. A consumer that reads `fields`
// silently no-ops -- the exact drift this contract exists to catch.
// =============================================================================

export const CONTRACT_VERSION = "1.0.0";

const isString = (v) => typeof v === "string";
const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Validate a chat-message / @mention callback payload.
 * @param {object} p
 * @returns {string[]} error messages (empty === valid)
 */
export function validateChatMessage(p) {
  if (!isPlainObject(p)) return ["payload must be an object"];
  const errs = [];
  if (!isNonEmptyString(p.user_id)) errs.push("user_id: required non-empty string");
  if (!isNonEmptyString(p.channel_slug)) errs.push("channel_slug: required non-empty string");

  const hasBody = isNonEmptyString(p.body);
  const hasAttachments = Array.isArray(p.attachments) && p.attachments.length > 0;
  if (!hasBody && !hasAttachments) errs.push("body or attachments: at least one required");

  if (p.trigger_type !== undefined && p.trigger_type !== "mention" && p.trigger_type !== "ambient") {
    errs.push(`trigger_type: must be "mention" or "ambient" (got ${JSON.stringify(p.trigger_type)})`);
  }
  if (p.trigger_type === "mention" && !isNonEmptyString(p.mentioned_bot_id)) {
    errs.push('mentioned_bot_id: required non-empty string when trigger_type is "mention"');
  }
  if (Array.isArray(p.attachments)) {
    p.attachments.forEach((a, i) => {
      if (!isPlainObject(a)) { errs.push(`attachments[${i}]: must be an object`); return; }
      if (!isNonEmptyString(a.id)) errs.push(`attachments[${i}].id: required non-empty string`);
      if (!isString(a.filename)) errs.push(`attachments[${i}].filename: required string`);
    });
  }
  return errs;
}

/**
 * Validate a button-click callback payload.
 * @param {object} p
 * @returns {string[]} error messages (empty === valid)
 */
export function validateButtonClick(p) {
  if (!isPlainObject(p)) return ["payload must be an object"];
  const errs = [];
  if (!isNonEmptyString(p.message_id)) errs.push("message_id: required non-empty string");
  if (!isNonEmptyString(p.button_id)) errs.push("button_id: required non-empty string");
  if (!isNonEmptyString(p.user_id)) errs.push("user_id: required non-empty string");
  return errs;
}

/**
 * Validate a modal-submit callback payload.
 * @param {object} p
 * @returns {string[]} error messages (empty === valid)
 */
export function validateModalSubmit(p) {
  if (!isPlainObject(p)) return ["payload must be an object"];
  const errs = [];
  if (!isNonEmptyString(p.message_id)) errs.push("message_id: required non-empty string");
  if (!isNonEmptyString(p.modal_id)) errs.push("modal_id: required non-empty string");
  if (!isNonEmptyString(p.user_id)) errs.push("user_id: required non-empty string");
  // The wire contract carries submitted field values under `values`. A payload
  // keyed `fields` is non-conforming and would silently no-op on the receiver.
  if (!isPlainObject(p.values)) errs.push('values: required object map of field name -> value (NOT "fields")');
  return errs;
}

/** Map of callback type -> validator, for table-driven checks. */
export const VALIDATORS = {
  "chat-message": validateChatMessage,
  "button-click": validateButtonClick,
  "modal-submit": validateModalSubmit,
};
