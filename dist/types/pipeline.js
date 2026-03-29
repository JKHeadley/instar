/**
 * Pipeline Types — typed contracts for the Telegram message flow.
 *
 * The Meta-Lesson: "Available But Dropped" bugs happen when data flows
 * through loosely-typed handoffs. Adding a field at layer N doesn't
 * surface all the places at layers N+1, N+2, N+3 that need to handle it.
 *
 * These types make every handoff explicit. If you add a field to
 * TelegramInbound, TypeScript will force you to carry it through
 * to PipelineMessage and InjectionPayload — or explicitly acknowledge
 * the drop with a comment.
 *
 * Pipeline stages:
 *   1. TelegramInbound — raw data from Telegram Bot API (processUpdate)
 *   2. PipelineMessage — normalized internal message (wireTelegramRouting)
 *   3. InjectionPayload — what gets injected into a Claude session
 *   4. LogEntry — what gets persisted to the message log
 *
 * Conversion functions:
 *   toInbound()     → TelegramInbound    (from TelegramUpdate)
 *   toPipeline()    → PipelineMessage     (from TelegramInbound)
 *   toInjection()   → InjectionPayload   (from PipelineMessage)
 *   toLogEntry()    → PipelineLogEntry    (from PipelineMessage)
 *
 * Security: Input sanitization (User-Agent Topology Spec, Gap 12)
 *   toInjection() applies sanitizeSenderName() and sanitizeTopicName() at
 *   the injection boundary — the point where untrusted user-controlled
 *   content enters the LLM session context.
 */
import { sanitizeSenderName, sanitizeTopicName } from '../utils/sanitize.js';
// ── Conversion Functions ──────────────────────────────────────────
/**
 * Convert a raw Telegram message to a TelegramInbound.
 * This is the entry point — where we first capture all identity data.
 */
export function toInbound(msg, opts) {
    return {
        messageId: msg.message_id,
        sender: {
            telegramUserId: msg.from.id,
            firstName: msg.from.first_name,
            username: msg.from.username,
        },
        topicId: msg.message_thread_id ?? 1,
        topicName: opts.topicName || msg.reply_to_message?.forum_topic_created?.name,
        content: opts.content,
        type: opts.type,
        timestamp: new Date(msg.date * 1000).toISOString(),
        media: opts.media,
    };
}
/**
 * Convert a TelegramInbound to a PipelineMessage.
 * Identity is carried through — this is where the "Available But Dropped" pattern
 * used to strike. Now the types enforce it.
 */
export function toPipeline(inbound) {
    return {
        id: `tg-${inbound.messageId}`,
        sender: inbound.sender, // Explicit carry-through
        topicId: inbound.topicId,
        topicName: inbound.topicName,
        content: inbound.content,
        type: inbound.type,
        timestamp: inbound.timestamp,
    };
}
/**
 * Convert a PipelineMessage to an InjectionPayload.
 * This is where identity becomes embedded in the text tag.
 *
 * Format: [telegram:42 "Topic Name" from Justin (uid:12345)] message text
 *
 * Security: This is the injection boundary — user-controlled content (display
 * names, topic names) enters the LLM session context here. Sanitization is
 * applied per User-Agent Topology Spec, Gap 12.
 *
 * The UID is the authoritative identity. Display names are for readability
 * but MUST NOT be trusted for authorization decisions.
 */
export function toInjection(pipeline, tmuxSession) {
    const { topicId, topicName, sender, content } = pipeline;
    // Sanitize user-controlled content at the injection boundary
    const safeName = sanitizeSenderName(sender.firstName);
    const safeTopic = topicName ? sanitizeTopicName(topicName) : undefined;
    const uid = sender.telegramUserId;
    // Build the tag — always includes sender when available, UID when known
    const topicTag = buildInjectionTag(topicId, safeTopic, safeName, uid);
    return {
        tmuxSession,
        topicId,
        taggedText: `${topicTag} ${content}`,
        senderName: safeName !== 'Unknown' ? safeName : sender.firstName,
        telegramUserId: uid,
    };
}
/**
 * Build the injection tag string.
 *
 * Exported for use by SessionManager.injectTelegramMessage() to avoid
 * duplicating the tag-building logic.
 *
 * Tag format variants:
 *   [telegram:42 "Topic Name" from Justin (uid:12345)]
 *   [telegram:42 "Topic Name" from Justin]           — when UID unknown
 *   [telegram:42 "Topic Name"]                       — when sender unknown
 *   [telegram:42 from Justin (uid:12345)]             — when no topic name
 *   [telegram:42]                                     — bare minimum
 */
export function buildInjectionTag(topicId, topicName, senderName, telegramUserId) {
    const uidSuffix = telegramUserId ? ` (uid:${telegramUserId})` : '';
    if (topicName && senderName) {
        return `[telegram:${topicId} "${topicName}" from ${senderName}${uidSuffix}]`;
    }
    else if (topicName) {
        return `[telegram:${topicId} "${topicName}"]`;
    }
    else if (senderName) {
        return `[telegram:${topicId} from ${senderName}${uidSuffix}]`;
    }
    else {
        return `[telegram:${topicId}]`;
    }
}
/**
 * Convert a PipelineMessage to a log entry.
 * All identity fields are preserved for historical search.
 */
export function toLogEntry(pipeline, sessionName) {
    return {
        messageId: parseInt(pipeline.id.replace('tg-', ''), 10),
        topicId: pipeline.topicId,
        text: pipeline.content,
        fromUser: true,
        timestamp: pipeline.timestamp,
        sessionName,
        senderName: pipeline.sender.firstName,
        senderUsername: pipeline.sender.username,
        telegramUserId: pipeline.sender.telegramUserId,
    };
}
/**
 * Build a session history line from a log entry.
 * Uses the actual sender name instead of generic "User".
 */
export function formatHistoryLine(entry) {
    const sender = entry.fromUser
        ? (entry.senderName || 'User')
        : 'Agent';
    return `${sender}: ${entry.text}`;
}
//# sourceMappingURL=pipeline.js.map