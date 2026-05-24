// =============================================================================
// nexus-bot-worker-commons -- barrel re-export
//
// Public API. Per-bot workers import from this entry point:
//
//   import {
//     handleChatMessage,
//     postToNexus,
//     attachButtons,
//     postApprovalCard,
//     processButtonClick,
//     verifyNexusSignature,
//     parseCommand,
//     loadHistory,
//     appendHistory,
//     rememberFact,
//     forgetFact,
//     listFacts,
//     buildFactsBlock,
//     callAnthropic,
//     callAnthropicWithTools,
//     makeShouldRespond,
//   } from "nexus-bot-worker-commons";
//
// All implementations live under src/lib and src/handlers.
// =============================================================================

export { handleChatMessage, runLlmPipeline, buildFoundationHandlers } from "./handlers/handleChatMessage.js";
export { LlmRoomBase } from "./durable/LlmRoom.js";
export { handleCommandList, FOUNDATION_COMMAND_META } from "./handlers/handleCommandList.js";
export { callAnthropic, callAnthropicWithTools } from "./lib/anthropic.js";
export { verifyNexusSignature, timingSafeEqual } from "./lib/callbackSign.js";
export { parseCommand } from "./lib/commandParser.js";
export { loadHistory, appendHistory } from "./lib/history.js";
export { rememberFact, forgetFact, listFacts, buildFactsBlock } from "./lib/memory.js";
export { postToNexus, uploadBotAttachment, attachButtons, attachModals, editNexusMessage, sendNexusHeartbeat, sendTyping, pingBotPresence } from "./lib/nexus.js";
export { withProvenance, getProvenanceContext } from "./lib/provenanceContext.js";
export { scrubFleetDashes } from "./lib/sanitize.js";
export { reportFleetError } from "./lib/fleetError.js";
export { postApprovalCard, processButtonClick } from "./lib/hitl.js";
export { makeShouldRespond } from "./lib/triggers.js";
export { shouldChimeIn } from "./lib/watercooler.js";
export {
  safeEmbedTitle,
  bangReport,
  bangAlert,
  buildReport,
  previewOf,
  BANG_REPORT_RULES,
} from "./lib/embedCard.js";
export {
  fmtDate,
  fmtTime,
  fmtDateTime,
  fmtRelative,
  nexusTimestamp,
  fmtCurrency,
  fmtNumber,
  fmtPercent,
  fmtBytes,
  truncate,
  pluralize,
  pluralizeBare,
  fmtList,
  fmtKv,
  fmtTable,
  fmtFixedTable,
  joinOxford,
  stripMarkdown,
  mention,
  mentionMany,
  channelLink,
  codeSpan,
  linkLabel,
  PALETTE,
} from "./lib/format.js";
export { buildAttachmentContentBlocks } from "./lib/attachments.js";
export {
  postHmacSigned,
  makeJoinCommand,
  makeLeaveCommand,
} from "./lib/voiceJoin.js";
export { createBangCommandTool } from "./lib/voiceBangCommand.js";
export { buildMimeMessage, sendMimeEmail } from "./lib/mimeEmail.js";
