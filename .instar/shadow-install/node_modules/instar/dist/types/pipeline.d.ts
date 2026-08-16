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
/**
 * The sender's identity as provided by Telegram.
 * Every field here MUST flow through to the session.
 */
export interface TelegramSender {
    /** Telegram numeric user ID */
    telegramUserId: number;
    /** Display name (first_name from Telegram) */
    firstName: string;
    /** @username (optional — not all users have one) */
    username?: string;
}
/**
 * Raw inbound message from Telegram, normalized from TelegramUpdate.
 * This is the "source of truth" — all downstream stages derive from this.
 */
export interface TelegramInbound {
    /** Telegram message ID */
    messageId: number;
    /** The sender's identity — NEVER optional, always extracted from Telegram API */
    sender: TelegramSender;
    /** Topic thread ID (GENERAL_TOPIC_ID=1 for General) */
    topicId: number;
    /** Topic name (from forum_topic_created or registry) */
    topicName?: string;
    /** Message content */
    content: string;
    /** Message type */
    type: 'text' | 'voice' | 'photo' | 'document';
    /** When the message was sent (Telegram date) */
    timestamp: string;
    /** Type-specific metadata */
    media?: {
        /** Path to downloaded voice/photo file */
        filePath?: string;
        /** Voice duration in seconds */
        voiceDuration?: number;
        /** Photo caption */
        caption?: string;
    };
}
/**
 * Normalized internal message — the common format used by routing,
 * stall detection, sentinel intercept, and topic callbacks.
 *
 * Every field from TelegramInbound is preserved or explicitly
 * transformed (e.g., voice → "[voice] transcript").
 */
export interface PipelineMessage {
    /** Unique message ID (format: "tg-{telegramMessageId}") */
    id: string;
    /** Sender identity — carried from TelegramInbound, never dropped */
    sender: TelegramSender;
    /** Topic ID */
    topicId: number;
    /** Topic name (if known from registry) */
    topicName?: string;
    /** Processed text content (voice → transcript, photo → [image:path]) */
    content: string;
    /** Original message type */
    type: 'text' | 'voice' | 'photo' | 'document';
    /** ISO 8601 timestamp */
    timestamp: string;
    /** The tmux session this message is routed to (set during routing) */
    targetSession?: string;
}
/**
 * What gets injected into a Claude tmux session.
 * The final transformation — all context must be embedded in the text.
 *
 * Format: [telegram:42 "Topic Name" from Justin (uid:12345)] message text
 *
 * The UID is the authoritative identity — display names are for readability.
 * Sanitization is applied at this boundary (see toInjection()).
 */
export interface InjectionPayload {
    /** Target tmux session name */
    tmuxSession: string;
    /** Topic ID (for tracking/stall detection) */
    topicId: number;
    /** Fully tagged text ready for injection.
     * Includes topic name, sender identity, and UID in the tag. */
    taggedText: string;
    /** Sender name (for delivery confirmation, stall tracking) */
    senderName?: string;
    /** Telegram user ID (for identity tracking) */
    telegramUserId?: number;
}
/**
 * What gets persisted to the JSONL message log.
 * Includes all identity fields for historical search and replay.
 */
export interface PipelineLogEntry {
    messageId: number;
    topicId: number | null;
    text: string;
    fromUser: boolean;
    timestamp: string;
    sessionName: string | null;
    /** Sender identity — NEVER omitted for user messages */
    senderName?: string;
    senderUsername?: string;
    telegramUserId?: number;
}
/**
 * Convert a raw Telegram message to a TelegramInbound.
 * This is the entry point — where we first capture all identity data.
 */
export declare function toInbound(msg: {
    message_id: number;
    from: {
        id: number;
        first_name: string;
        username?: string;
    };
    message_thread_id?: number;
    date: number;
    text?: string;
    reply_to_message?: {
        forum_topic_created?: {
            name: string;
        };
    };
}, opts: {
    topicName?: string;
    content: string;
    type: 'text' | 'voice' | 'photo' | 'document';
    media?: TelegramInbound['media'];
}): TelegramInbound;
/**
 * Convert a TelegramInbound to a PipelineMessage.
 * Identity is carried through — this is where the "Available But Dropped" pattern
 * used to strike. Now the types enforce it.
 */
export declare function toPipeline(inbound: TelegramInbound): PipelineMessage;
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
export declare function toInjection(pipeline: PipelineMessage, tmuxSession: string): InjectionPayload;
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
export declare function buildInjectionTag(topicId: number, topicName?: string, senderName?: string, telegramUserId?: number): string;
/**
 * Convert a PipelineMessage to a log entry.
 * All identity fields are preserved for historical search.
 */
export declare function toLogEntry(pipeline: PipelineMessage, sessionName: string | null): PipelineLogEntry;
/**
 * Build a session history line from a log entry.
 * Uses the actual sender name instead of generic "User".
 */
export declare function formatHistoryLine(entry: PipelineLogEntry): string;
//# sourceMappingURL=pipeline.d.ts.map