/**
 * MessageRouter — Routes encrypted message envelopes between agents.
 *
 * Part of Threadline Relay Phase 1. Routes by recipient fingerprint.
 * Does NOT read message content (E2E encrypted).
 */
import { RELAY_ERROR_CODES } from './types.js';
/** Set of recently seen message IDs for replay detection */
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
export class MessageRouter {
    deps;
    recentMessages = new Map(); // messageId → timestamp
    cleanupTimer = null;
    constructor(deps) {
        this.deps = deps;
        // Periodic cleanup of replay detection cache
        this.cleanupTimer = setInterval(() => this.cleanupReplayCache(), 60_000);
    }
    /**
     * Route a message envelope from sender to recipient.
     */
    route(envelope, senderAgentId) {
        // 1. Validate sender matches envelope
        if (envelope.from !== senderAgentId) {
            return {
                delivered: false,
                status: 'rejected',
                reason: 'Sender fingerprint mismatch',
                errorCode: RELAY_ERROR_CODES.INVALID_SIGNATURE,
            };
        }
        // 2. Check envelope size
        const envelopeSize = JSON.stringify(envelope).length;
        if (envelopeSize > this.deps.maxEnvelopeSize) {
            return {
                delivered: false,
                status: 'rejected',
                reason: `Envelope too large (${envelopeSize} > ${this.deps.maxEnvelopeSize})`,
                errorCode: RELAY_ERROR_CODES.ENVELOPE_TOO_LARGE,
            };
        }
        // 3. Replay detection
        if (this.recentMessages.has(envelope.messageId)) {
            return {
                delivered: false,
                status: 'rejected',
                reason: 'Duplicate message ID (replay detected)',
                errorCode: RELAY_ERROR_CODES.REPLAY_DETECTED,
            };
        }
        // 4. Rate limiting
        const ip = this.deps.getIP(senderAgentId);
        const rateCheck = this.deps.rateLimiter.checkMessage(senderAgentId, ip);
        if (!rateCheck.allowed) {
            return {
                delivered: false,
                status: 'rejected',
                reason: `Rate limited (${rateCheck.limitType})`,
                errorCode: RELAY_ERROR_CODES.RATE_LIMITED,
            };
        }
        // 5. Check recipient exists
        const recipientPresence = this.deps.presence.get(envelope.to);
        if (!recipientPresence) {
            return {
                delivered: false,
                status: 'rejected',
                reason: 'Recipient not connected',
                errorCode: RELAY_ERROR_CODES.RECIPIENT_OFFLINE,
            };
        }
        // 6. Check recipient's private visibility
        if (recipientPresence.visibility === 'private') {
            // Private agents only accept messages from agents they have prior trust with.
            // For Phase 1, we'll allow all messages to private agents if they know the fingerprint.
            // Trust filtering is handled by the agent itself.
        }
        // 7. Get recipient socket
        const recipientSocket = this.deps.getSocket(envelope.to);
        if (!recipientSocket || recipientSocket.readyState !== 1 /* OPEN */) {
            return {
                delivered: false,
                status: 'rejected',
                reason: 'Recipient socket not available',
                errorCode: RELAY_ERROR_CODES.RECIPIENT_OFFLINE,
            };
        }
        // 8. Record event for rate limiting
        this.deps.rateLimiter.recordMessage(senderAgentId, ip);
        // 9. Record for replay detection
        this.recentMessages.set(envelope.messageId, Date.now());
        // 10. Forward to recipient
        const messageFrame = JSON.stringify({
            type: 'message',
            envelope,
        });
        try {
            recipientSocket.send(messageFrame);
        }
        catch {
            return {
                delivered: false,
                status: 'rejected',
                reason: 'Failed to send to recipient',
                errorCode: RELAY_ERROR_CODES.INTERNAL_ERROR,
            };
        }
        return { delivered: true, status: 'delivered' };
    }
    /**
     * Clean up expired entries in the replay detection cache.
     */
    cleanupReplayCache() {
        const cutoff = Date.now() - REPLAY_WINDOW_MS;
        for (const [id, ts] of this.recentMessages) {
            if (ts < cutoff) {
                this.recentMessages.delete(id);
            }
        }
    }
    /**
     * Destroy the router (clean up timers).
     */
    destroy() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        this.recentMessages.clear();
    }
    /**
     * Get replay cache size (for monitoring).
     */
    get replayCacheSize() {
        return this.recentMessages.size;
    }
}
//# sourceMappingURL=MessageRouter.js.map