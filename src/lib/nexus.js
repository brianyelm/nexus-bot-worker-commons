// lib/nexus.js
// STUB. See SPEC.md.

function _unimplemented(name) {
  throw new Error("[nexus-bot-worker-commons] " + name + " is a stub. Implementation pending.");
}

export async function postToNexus(env, slug, content, options = {}) { _unimplemented("postToNexus"); }
export async function attachButtons(env, messageId, buttons, options = {}) { _unimplemented("attachButtons"); }
export async function sendNexusHeartbeat(env, meta = {}, options = {}) { _unimplemented("sendNexusHeartbeat"); }
