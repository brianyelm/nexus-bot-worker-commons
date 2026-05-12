// =============================================================================
// lib/attachments.js -- Multimodal attachment loader for Nexus bot callbacks.
//
// Nexus's dispatchBotCallback (worker/src/lib/message-insert.js) hydrates the
// payload it sends to each bot with an `attachments` array of the form:
//
//   [{
//     id:         <attachment uuid>,
//     filename:   <display name>,
//     mime_type:  <e.g. application/pdf, image/png>,
//     size_bytes: <integer>,
//     url:        "/api/internal/attachments/<id>"   // server-relative
//   }, ...]
//
// This module turns that list into Anthropic Messages API content blocks:
//
//   PDFs   -> { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
//   Images -> { type: "image",    source: { type: "base64", media_type: <mime>, data } }
//
// Fetch auth: GET <NEXUS_BASE_URL><url> with X-Internal-Token = INTERNAL_ADMIN_TOKEN.
// The Nexus worker exposes /api/internal/attachments/:id behind that same token
// (see nexus-app/worker/src/routes/attachments.js handleInternalDownloadAttachment).
//
// Hard caps:
//   - Per-file:  10 MB (skip oversized; the caller can surface the warning)
//   - Aggregate: 32 MB (Anthropic absolute) AND a soft 3 MB working budget;
//                we honor whichever limit hits first, dropping later files
//                once the budget is spent.
//
// Per-file failures (404, 502, decode errors) are skipped with a console.warn
// and a warning text returned to the caller; they never abort the LLM call.
// =============================================================================

const PER_FILE_MAX_BYTES = 10 * 1024 * 1024;
const TOTAL_SOFT_BYTES = 3 * 1024 * 1024;
const TOTAL_HARD_BYTES = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

const IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

const PDF_MIME = "application/pdf";

/**
 * Base64-encode an ArrayBuffer using btoa via Latin1 chunked conversion.
 * Workers expose btoa but not Buffer; chunking avoids "too many arguments"
 * on apply() for multi-MB buffers.
 *
 * @param {ArrayBuffer} buf
 * @returns {string}
 */
function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
    );
  }
  return btoa(binary);
}

/**
 * Fetch one attachment from Nexus and convert to an Anthropic content block.
 * Returns null if the file is over the per-file cap, the mime is unsupported,
 * or the fetch fails.
 *
 * @param {object} env
 * @param {string} baseUrl
 * @param {string} token
 * @param {object} att
 * @returns {Promise<{ block: object, bytes: number } | null>}
 */
async function fetchOne(env, baseUrl, token, att) {
  if (!att || !att.url || !att.mime_type) return null;

  const mime = String(att.mime_type).toLowerCase();
  const isPdf = mime === PDF_MIME;
  const isImage = IMAGE_MIME.has(mime);
  if (!isPdf && !isImage) {
    console.log(`[attachments] skipping unsupported mime ${mime} (${att.filename})`);
    return null;
  }

  if (typeof att.size_bytes === "number" && att.size_bytes > PER_FILE_MAX_BYTES) {
    console.warn(
      `[attachments] skipping ${att.filename} -- ${att.size_bytes} bytes exceeds per-file cap ${PER_FILE_MAX_BYTES}`
    );
    return null;
  }

  const fetchUrl = `${baseUrl.replace(/\/$/, "")}${att.url}`;
  let resp;
  try {
    resp = await fetch(fetchUrl, {
      method: "GET",
      headers: { "X-Internal-Token": token },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`[attachments] fetch failed for ${att.id}:`, err?.message);
    return null;
  }
  if (!resp.ok) {
    console.warn(`[attachments] non-2xx for ${att.id}: ${resp.status}`);
    return null;
  }

  let buf;
  try {
    buf = await resp.arrayBuffer();
  } catch (err) {
    console.warn(`[attachments] body read failed for ${att.id}:`, err?.message);
    return null;
  }

  if (buf.byteLength > PER_FILE_MAX_BYTES) {
    console.warn(
      `[attachments] ${att.filename} exceeded per-file cap after fetch (${buf.byteLength} bytes)`
    );
    return null;
  }

  const data = bufferToBase64(buf);
  const block = isPdf
    ? {
        type: "document",
        source: { type: "base64", media_type: PDF_MIME, data },
      }
    : {
        type: "image",
        source: { type: "base64", media_type: mime, data },
      };

  return { block, bytes: buf.byteLength };
}

/**
 * Convert the inbound `attachments` array (from the Nexus callback payload)
 * into Anthropic Messages API content blocks. Returns the blocks ready to
 * prepend in front of the user's text turn, plus a human-readable warning
 * for any files that were skipped.
 *
 * Bot workers should pass these blocks into the user-turn content array
 * BEFORE the text body. They will be the first thing Claude sees, which
 * matters for documents (the OUTPUT CONTRACT pattern relies on text last).
 *
 * @param {object} env -- worker env (reads INTERNAL_ADMIN_TOKEN, NEXUS_BASE_URL)
 * @param {Array<object>} attachments -- payload.attachments from Nexus
 * @param {object} [options]
 * @param {string} [options.tokenEnvVar=NEXUS_INTERNAL_TOKEN]
 *   Override the env var name carrying the X-Internal-Token. Falls back to
 *   INTERNAL_ADMIN_TOKEN for parity with Nexus's own internal-route gates.
 * @param {string} [options.baseUrlEnvVar=NEXUS_BASE_URL]
 *   Override the env var name carrying the Nexus base URL.
 * @returns {Promise<{ blocks: Array<object>, warnings: string[] }>}
 */
export async function buildAttachmentContentBlocks(env, attachments, options = {}) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { blocks: [], warnings: [] };
  }

  const tokenEnvVar = options.tokenEnvVar || "NEXUS_INTERNAL_TOKEN";
  const baseUrlEnvVar = options.baseUrlEnvVar || "NEXUS_BASE_URL";
  const token = env[tokenEnvVar] || env.INTERNAL_ADMIN_TOKEN;
  const baseUrl = env[baseUrlEnvVar];

  if (!token || !baseUrl) {
    console.warn(
      `[attachments] missing ${tokenEnvVar}/INTERNAL_ADMIN_TOKEN or ${baseUrlEnvVar}, skipping ${attachments.length} attachment(s)`
    );
    return {
      blocks: [],
      warnings: [
        `Could not load ${attachments.length} attachment(s): bot worker is missing Nexus internal access credentials. Ask Brian to set ${tokenEnvVar} and ${baseUrlEnvVar}.`,
      ],
    };
  }

  const blocks = [];
  const warnings = [];
  let totalBytes = 0;

  for (const att of attachments) {
    if (totalBytes >= TOTAL_SOFT_BYTES) {
      warnings.push(
        `Skipped ${att.filename || att.id} -- attachment budget (${TOTAL_SOFT_BYTES} bytes) already spent.`
      );
      continue;
    }
    const result = await fetchOne(env, baseUrl, token, att);
    if (!result) {
      warnings.push(`Could not read ${att.filename || att.id} (mime ${att.mime_type || "?"}).`);
      continue;
    }
    if (totalBytes + result.bytes > TOTAL_HARD_BYTES) {
      warnings.push(
        `Skipped ${att.filename || att.id} -- would exceed Anthropic 32 MB cap.`
      );
      continue;
    }
    blocks.push(result.block);
    totalBytes += result.bytes;
  }

  return { blocks, warnings };
}
