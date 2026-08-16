/**
 * Threadline Protocol Types
 *
 * Canonical protocol contract for all Threadline messages.
 * All inter-agent messages (content, acks, status, errors) conform to this interface.
 *
 * Published as part of SPEC-threadline-responsive-messaging Phase 1.
 */
import type { AgentFingerprint } from './relay/types.js';
export type { AgentFingerprint };
/**
 * ThreadlineMessage — The protocol contract for all Threadline messages.
 *
 * Every message between agents conforms to this interface, including:
 * - Content messages (agent-to-agent conversation)
 * - Status messages (acks, busy signals, session-rotated notifications)
 * - Error messages (capacity limits, delivery failures)
 */
export interface ThreadlineMessage {
    /** Message type discriminator */
    type: 'content' | 'status' | 'error';
    /** Unique message ID (crypto.randomUUID()) */
    messageId: string;
    /** Thread context (assigned on first contact if absent) */
    threadId: string;
    /** Ed25519 fingerprint of sender */
    from: AgentFingerprint;
    /** ISO 8601 timestamp */
    timestamp: string;
    /** Message body */
    text: string;
    /** messageId this responds to */
    inReplyTo?: string;
    /** Status value — present on status-type messages */
    status?: 'processing' | 'busy' | 'session-rotated' | 'delivered';
    /** Seconds until retry — present on 'busy' and 'error' messages */
    retryAfter?: number;
}
//# sourceMappingURL=types.d.ts.map