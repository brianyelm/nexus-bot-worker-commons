// =============================================================================
// lib/memoryService.js - Client for the centralized memory-worker service
//
// Consumed via service binding (env.MEMORY). All calls are best-effort:
// a memory-worker outage must never break the chat pipeline.
//
// If env.MEMORY is not bound, all functions no-op silently.
//
// Usage in handleChatMessage:
//   After appendHistory, call persistTurnPair() to forward the user+assistant
//   turns to the memory service for structured storage and eventual fact
//   extraction.
// =============================================================================

const BOT_HEADER = 'X-Memory-Bot';

async function memoryFetch(env, botId, path, body) {
  if (!env.MEMORY) return null;
  try {
    const resp = await env.MEMORY.fetch(new Request(`https://internal${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [BOT_HEADER]: botId },
      body: JSON.stringify(body),
    }));
    if (!resp.ok) {
      console.warn(`[memoryService] ${path} ${resp.status}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.warn(`[memoryService] ${path}: ${err?.message}`);
    return null;
  }
}

async function memoryGet(env, botId, path) {
  if (!env.MEMORY) return null;
  try {
    const resp = await env.MEMORY.fetch(new Request(`https://internal${path}`, {
      method: 'GET',
      headers: { [BOT_HEADER]: botId },
    }));
    if (!resp.ok) return null;
    return await resp.json();
  } catch (err) {
    console.warn(`[memoryService] GET ${path}: ${err?.message}`);
    return null;
  }
}

/**
 * Persist a user+assistant turn pair to the memory service.
 * Called after appendHistory in the chat pipeline.
 *
 * @param {object} env - Worker env with MEMORY service binding
 * @param {string} botId - Bot identifier (e.g. 'jacob', 'courtney', 'wren')
 * @param {object} params
 * @param {string} params.sessionId - Conversation session identifier
 * @param {string} [params.entityId] - Memory entity ID for the user (if resolved)
 * @param {string} params.userText - The user's message
 * @param {string} params.assistantText - The bot's response
 * @param {string} [params.channel] - Channel name/slug
 */
export async function persistTurnPair(env, botId, { sessionId, entityId, userText, assistantText, channel }) {
  if (!env.MEMORY) return;
  await memoryFetch(env, botId, '/turns', {
    session_id: sessionId,
    entity_id: entityId || null,
    role: 'user',
    content: userText,
    channel,
  });
  await memoryFetch(env, botId, '/turns', {
    session_id: sessionId,
    entity_id: entityId || null,
    role: 'assistant',
    content: assistantText,
    channel,
  });
}

/**
 * Resolve or create a memory entity for a person, keyed by whichever stable
 * identifiers are known on this surface: Nexus user_id (chat), email (email
 * pollers), and/or phone (voice). The memory-worker merges by external_id, so
 * passing more than one id links them onto the SAME entity -- this is what
 * lets an email sender resolve to the entity the chat/voice surfaces built,
 * giving cross-surface recall parity. Returns the entity_id.
 *
 * @param {object} env
 * @param {string} botId
 * @param {object} params
 * @param {string} [params.userId] - Nexus user_id
 * @param {string} [params.email] - sender/author email (lowercased for stable match)
 * @param {string} [params.phone] - caller phone in E.164
 * @param {string} [params.displayName]
 * @param {string} [params.type] - Entity type (default: 'contact')
 * @returns {Promise<string|null>} entity_id or null
 */
export async function resolveEntity(env, botId, { userId, email, phone, displayName, type = 'contact' }) {
  if (!env.MEMORY) return null;
  const externalIds = {};
  if (userId) externalIds.nexus_user_id = userId;
  if (email) externalIds.email = String(email).trim().toLowerCase();
  if (phone) externalIds.phone = phone;
  if (Object.keys(externalIds).length === 0) return null;
  const result = await memoryFetch(env, botId, '/entities', {
    type,
    display_name: displayName || userId || email || phone,
    external_ids: externalIds,
  });
  return result?.id || null;
}

/**
 * Get full context for an entity (facts, recent turns, sessions).
 *
 * @param {object} env
 * @param {string} botId
 * @param {string} entityId
 * @param {string} [query] - Optional query for semantic search
 * @returns {Promise<object|null>}
 */
export async function getEntityContext(env, botId, entityId, query) {
  if (!env.MEMORY) return null;
  return await memoryFetch(env, botId, '/context', {
    entity_id: entityId,
    query: query || undefined,
  });
}

/**
 * Start a memory session.
 *
 * @param {object} env
 * @param {string} botId
 * @param {object} params
 * @param {string} [params.entityId]
 * @param {string} [params.channel]
 * @returns {Promise<string|null>} session_id
 */
export async function startMemorySession(env, botId, { entityId, channel } = {}) {
  if (!env.MEMORY) return null;
  const result = await memoryFetch(env, botId, '/sessions/start', {
    entity_id: entityId || null,
    channel: channel || null,
  });
  return result?.id || null;
}

/**
 * End a memory session with an optional summary.
 */
export async function endMemorySession(env, botId, sessionId, summary) {
  if (!env.MEMORY) return;
  await memoryFetch(env, botId, '/sessions/end', { session_id: sessionId, summary });
}

/**
 * Assert a structured fact about an entity.
 */
export async function assertFact(env, botId, { subjectId, predicate, object, confidence, sourceTurnId, critical, ttlDays }) {
  if (!env.MEMORY) return null;
  return await memoryFetch(env, botId, '/facts', {
    subject_id: subjectId,
    predicate,
    object,
    confidence: confidence || 1.0,
    source_turn_id: sourceTurnId || null,
    // When critical is true the memory-worker stores the fact with no expiry
    // (kept indefinitely); otherwise it applies the default 90-day retention.
    critical: critical === true ? true : undefined,
    ttl_days: Number(ttlDays) > 0 ? Number(ttlDays) : undefined,
  });
}

/**
 * Get active facts for an entity.
 */
export async function getEntityFacts(env, botId, entityId) {
  if (!env.MEMORY) return [];
  const result = await memoryGet(env, botId, `/entities/${entityId}/facts`);
  return result?.facts || [];
}
