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
export { ReminderDOBase, scheduleReminderAlarm, bootstrapReminderAlarm } from "./durable/ReminderDOBase.js";
export { handleCommandList, FOUNDATION_COMMAND_META } from "./handlers/handleCommandList.js";
export { callAnthropic, callAnthropicWithTools } from "./lib/anthropic.js";
export { buildActionBreadcrumb, summarizeToolCall, isReadonlyToolName, looksLikeUnbackedClaim } from "./lib/actionTrace.js";
export { verifyNexusSignature, timingSafeEqual } from "./lib/callbackSign.js";
export { parseCommand } from "./lib/commandParser.js";
export { loadHistory, appendHistory } from "./lib/history.js";
export { rememberFact, forgetFact, listFacts, buildFactsBlock } from "./lib/memory.js";
export { resolveEntity, getEntityContext, persistTurnPair, assertFact } from "./lib/memoryService.js";
export { buildContactRecall } from "./lib/memoryRecall.js";
export { senderTrust } from "./lib/mailTrust.js";
export { isAutomaticReply } from "./lib/mailSafety.js";
export { stageExternalReply, handleExternalReplyGate } from "./lib/externalReplyGate.js";
export { looksLikeIncomingPayment } from "./lib/incomingPayment.js";
export { memoryHmacHex, buildMemoryAuthHeaders } from "./lib/memoryAuth.js";
export { postToNexus, uploadBotAttachment, attachImagesFromUrls, attachButtons, disableMessageButtons, settleMessageComponents, attachModals, editNexusMessage, fetchChannelMessages, fetchThreadMessages, sendNexusHeartbeat, sendTyping, pingBotPresence } from "./lib/nexus.js";
export { captureQa, captureCronRun, buildQaEntry, isNoopCronResult } from "./lib/qaCapture.js";
export { withProvenance, getProvenanceContext } from "./lib/provenanceContext.js";
export { crmReadTools, crmReadHandlers } from "./lib/crmCodes.js";
export {
  scrubFleetDashes,
  detectEmDashLeak,
  detectBareCapsHeader,
  detectFreelanceEmoji,
  inspectOutboundText,
} from "./lib/sanitize.js";
export { reportFleetError } from "./lib/fleetError.js";
export { notifyEmailDown, BOT_HOME_CHANNELS } from "./lib/emailBackup.js";
export { postApprovalCard, processButtonClick } from "./lib/hitl.js";
export { postHitlCard, renderHitlCard } from "./lib/hitlCard.js";
export {
  linkButton,
  linkButtons,
  linkButtonId,
  attachLinkButtons,
  xeroBankAccountUrl,
  xeroBillUrl,
  xeroInvoiceUrl,
  s1ThreatUrl,
  scCaseUrl,
  ninjaDeviceUrl,
  ninjaTicketUrl,
  crmRecordUrl,
  docusignEnvelopeUrl,
  dattoDeviceUrl,
  boxFileUrl,
  cdwProductUrl,
} from "./lib/appLinks.js";
export {
  BUTTON_LABELS,
  buttonId,
  parseButtonId,
  makeButton,
  isCanonicalLabel,
} from "./lib/buttonId.js";
export {
  parseInteractionPayload,
  isLegacyFieldsPayload,
} from "./lib/interactionPayload.js";
export {
  routeApprovalChannel,
  getApprovalChannelRegistry,
} from "./lib/channelRouter.js";
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
export { buildReportPrompt } from "./lib/reportPrompt.js";
export {
  fmtDate,
  fmtTime,
  fmtDateTime,
  fmtRelative,
  nexusTimestamp,
  phoenixToday,
  todayIso,
  phoenixWeekdayIndex,
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
export { buildEmailAttachmentBlocks, emailAttachmentBlocksByToken } from "./lib/emailAttachments.js";
export {
  postHmacSigned,
  makeJoinCommand,
  makeLeaveCommand,
} from "./lib/voiceJoin.js";
export { createBangCommandTool } from "./lib/voiceBangCommand.js";
export { buildMimeMessage, sendMimeEmail } from "./lib/mimeEmail.js";
