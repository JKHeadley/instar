/**
 * MessageFormatter — formats messages for tmux delivery.
 *
 * Produces formatted text blocks that are injected into Claude sessions
 * via tmux send-keys. Handles inline delivery, pointer delivery (context-limited),
 * and delimiter sanitization to prevent injection attacks.
 */
import { MAX_SUBJECT_LENGTH } from './types.js';
const DELIMITER = '━'.repeat(56);
const DELIMITER_PATTERN = /━{10,}/g;
const HEADER_PATTERN = /\[AGENT MESSAGE\]/g;
export class MessageFormatter {
    /**
     * Format a message for inline delivery (standard case).
     * Includes full body, reply/ack instructions, and optional thread context.
     */
    formatInline(message, thread) {
        const sender = `${message.from.agent}/${message.from.session}`;
        const subject = this.truncateSubject(message.subject);
        const sanitizedBody = this.sanitize(message.body);
        const headerParts = [
            `from: ${sender}`,
            `priority: ${message.priority}`,
        ];
        const metaParts = [
            `type: ${message.type}`,
            `id: ${message.id}`,
        ];
        if (message.threadId) {
            const threadInfo = thread ? ` (${thread.messageCount} messages)` : '';
            metaParts.push(`thread: ${message.threadId}${threadInfo}`);
        }
        const lines = [
            DELIMITER,
            `[AGENT MESSAGE] ${headerParts.join(' | ')}`,
            metaParts.join(' | '),
            DELIMITER,
        ];
        // Thread context (if provided)
        if (thread && thread.messageCount > 1) {
            lines.push(`Thread context (${thread.messageCount - 1} prior messages):`);
            lines.push(DELIMITER);
        }
        // Subject + body
        if (subject !== sanitizedBody.slice(0, subject.length)) {
            lines.push(`Subject: ${subject}`);
        }
        lines.push(sanitizedBody);
        // Footer with reply/ack instructions
        lines.push(DELIMITER);
        lines.push(`Reply: Use the threadline_send MCP tool with the sender's agentId and threadId to reply.`);
        lines.push(`Message ID: ${message.id}`);
        lines.push(DELIMITER);
        return lines.join('\n');
    }
    /**
     * Format a message as a pointer (context-limited delivery).
     * Shows subject and commands but not the full body.
     */
    formatPointer(message) {
        const sender = `${message.from.agent}/${message.from.session}`;
        const subject = this.truncateSubject(message.subject);
        const lines = [
            DELIMITER,
            `[AGENT MESSAGE] from: ${sender} | priority: ${message.priority}`,
            `type: ${message.type} | id: ${message.id}`,
            DELIMITER,
            'Message available (context-limited delivery):',
            `  Subject: ${subject}`,
            `  Read full message: /msg read ${message.id}`,
            `  Quick ack: /msg ack ${message.id}`,
            DELIMITER,
        ];
        return lines.join('\n');
    }
    /**
     * Sanitize message content to prevent delimiter injection.
     * Strips patterns that could mimic our message format.
     */
    sanitize(content) {
        let sanitized = content;
        // Replace long runs of ━ with a safe alternative
        sanitized = sanitized.replace(DELIMITER_PATTERN, '---');
        // Replace [AGENT MESSAGE] headers with safe alternative
        sanitized = sanitized.replace(HEADER_PATTERN, '[agent-message]');
        return sanitized;
    }
    /**
     * Truncate subject to MAX_SUBJECT_LENGTH.
     */
    truncateSubject(subject) {
        if (subject.length <= MAX_SUBJECT_LENGTH)
            return subject;
        return subject.slice(0, MAX_SUBJECT_LENGTH - 3) + '...';
    }
}
//# sourceMappingURL=MessageFormatter.js.map