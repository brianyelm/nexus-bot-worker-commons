// =============================================================================
// handlers/handleChatMessage.js -- Nexus chat callback entry
//
// STUB. Implementation pending. See SPEC.md for the full contract.
//
// Exported surface (documented in SPEC.md):
//   handleChatMessage(request, env, ctx, config) -> Promise<Response>
//   config: { botName, persona, tools, commands, nexusKeyEnvVar, triggers, dbBinding, cacheBinding, workerBaseUrlEnvVar, callbackSecretEnvVar, actionRegex, historyMaxTurns } -- see SPEC.md
//
// Implementation rules:
//   - ES modules only
//   - No global-scope I/O (no top-level fetch/Response/setTimeout/crypto;
//     CF Workers reject deploy with error 10021)
//   - Tool handler signature is (input, env, ctx). Always.
//   - No em dashes or en dashes anywhere
// =============================================================================

function _unimplemented(name) {
  throw new Error("[nexus-bot-worker-commons] " + name + " is a stub. Implementation pending.");
}

export async function handleChatMessage(request, env, ctx, config) {
  _unimplemented("handleChatMessage");
}
