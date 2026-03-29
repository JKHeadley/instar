/**
 * MessageRouter — Routes encrypted message envelopes between agents.
 *
 * Part of Threadline Relay Phase 1. Routes by recipient fingerprint.
 * Does NOT read message content (E2E encrypted).
 */
import type { WebSocket } from 'ws';
import type { AgentFingerprint, MessageEnvelope } from './types.js';
import type { PresenceRegistry } from './PresenceRegistry.js';
import type { RelayRateLimiter } from './RelayRateLimiter.js';
export interface RouterDeps {
    presence: PresenceRegistry;
    rateLimiter: RelayRateLimiter;
    getSocket: (agentId: AgentFingerprint) => WebSocket | undefined;
    getIP: (agentId: AgentFingerprint) => string;
    maxEnvelopeSize: number;
}
export interface RouteResult {
    delivered: boolean;
    status: 'delivered' | 'queued' | 'rejected';
    reason?: string;
    errorCode?: string;
}
export declare class MessageRouter {
    private readonly deps;
    private readonly recentMessages;
    private cleanupTimer;
    constructor(deps: RouterDeps);
    /**
     * Route a message envelope from sender to recipient.
     */
    route(envelope: MessageEnvelope, senderAgentId: AgentFingerprint): RouteResult;
    /**
     * Clean up expired entries in the replay detection cache.
     */
    private cleanupReplayCache;
    /**
     * Destroy the router (clean up timers).
     */
    destroy(): void;
    /**
     * Get replay cache size (for monitoring).
     */
    get replayCacheSize(): number;
}
//# sourceMappingURL=MessageRouter.d.ts.map