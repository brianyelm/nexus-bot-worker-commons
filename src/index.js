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

export { handleChatMessage } from "./handlers/handleChatMessage.js";
export { callAnthropic, callAnthropicWithTools } from "./lib/anthropic.js";
export { verifyNexusSignature, timingSafeEqual } from "./lib/callbackSign.js";
export { parseCommand } from "./lib/commandParser.js";
export { loadHistory, appendHistory } from "./lib/history.js";
export { rememberFact, forgetFact, listFacts, buildFactsBlock } from "./lib/memory.js";
export { postToNexus, attachButtons, editNexusMessage, sendNexusHeartbeat, sendTyping, pingBotPresence } from "./lib/nexus.js";
export { reportFleetError } from "./lib/fleetError.js";
export { postApprovalCard, processButtonClick } from "./lib/hitl.js";
export { makeShouldRespond } from "./lib/triggers.js";
export {
  asEmbedCard,
  asRichEmbedCard,
  parseMultiSection,
  wrapCommandReply,
  prettifyVerb,
  buildCommandTitle,
  colorForBot,
  BOT_COMMAND_COLORS,
  DEFAULT_COMMAND_COLOR,
} from "./lib/embedCard.js";
export { buildAttachmentContentBlocks } from "./lib/attachments.js";
export {
  postHmacSigned,
  makeJoinCommand,
  makeLeaveCommand,
} from "./lib/voiceJoin.js";
