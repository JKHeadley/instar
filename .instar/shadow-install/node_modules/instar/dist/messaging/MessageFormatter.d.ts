/**
 * MessageFormatter — formats messages for tmux delivery.
 *
 * Produces formatted text blocks that are injected into Claude sessions
 * via tmux send-keys. Handles inline delivery, pointer delivery (context-limited),
 * and delimiter sanitization to prevent injection attacks.
 */
import type { AgentMessage, MessageThread } from './types.js';
export declare class MessageFormatter {
    /**
     * Format a message for inline delivery (standard case).
     * Includes full body, reply/ack instructions, and optional thread context.
     */
    formatInline(message: AgentMessage, thread?: MessageThread): string;
    /**
     * Format a message as a pointer (context-limited delivery).
     * Shows subject and commands but not the full body.
     */
    formatPointer(message: AgentMessage): string;
    /**
     * Sanitize message content to prevent delimiter injection.
     * Strips patterns that could mimic our message format.
     */
    private sanitize;
    /**
     * Truncate subject to MAX_SUBJECT_LENGTH.
     */
    private truncateSubject;
}
//# sourceMappingURL=MessageFormatter.d.ts.map