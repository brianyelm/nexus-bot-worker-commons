// lib/callbackSign.js
// STUB. See SPEC.md.

function _unimplemented(name) {
  throw new Error("[nexus-bot-worker-commons] " + name + " is a stub. Implementation pending.");
}

export function timingSafeEqual(a, b) { _unimplemented("timingSafeEqual"); }
export async function verifyNexusSignature(secret, rawBody, headers, options = {}) { _unimplemented("verifyNexusSignature"); }
