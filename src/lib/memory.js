// lib/memory.js
// STUB. See SPEC.md.

function _unimplemented(name) {
  throw new Error("[nexus-bot-worker-commons] " + name + " is a stub. Implementation pending.");
}

export async function rememberFact(env, userId, text, options = {}) { _unimplemented("rememberFact"); }
export async function forgetFact(env, userId, text, options = {}) { _unimplemented("forgetFact"); }
export async function listFacts(env, userId, options = {}) { _unimplemented("listFacts"); }
export async function buildFactsBlock(env, userId, options = {}) { _unimplemented("buildFactsBlock"); }
