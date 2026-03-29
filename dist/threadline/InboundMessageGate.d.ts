/**
 * InboundMessageGate — Pre-filter for relay inbound messages.
 *
 * Gates on sender identity, trust level, rate limits, payload size, and replay.
 * Does NOT determine delivery mode — that's AutonomyGate's job.
 *
 * Part of PROP-relay-auto-connect.
 */
import type { AgentTrustManager, AgentTrustLevel } from './AgentTrustManager.js';
import type { ThreadlineRouter } from './ThreadlineRouter.js';
import type { ReceivedMessage } from './client/ThreadlineClient.js';
export interface InboundGateConfig {
    /** Max payload size in bytes (default: 64KB) */
    maxPayloadBytes?: number;
    /** Per-trust-level rate limits */
    rateLimits?: Partial<Record<AgentTrustLevel, {
        probesPerHour: number;
        messagesPerHour: number;
        messagesPerDay: number;
    }>>;
}
export interface GateDecision {
    action: 'pass' | 'block';
    reason?: string;
    fingerprint?: string;
    message?: ReceivedMessage;
    trustLevel?: AgentTrustLevel;
}
export declare class InboundMessageGate {
    private readonly trustManager;
    private router;
    private readonly config;
    private readonly rateLimiter;
    private readonly maxPayloadBytes;
    private cleanupTimer;
    /** Seen messageId cache for replay protection */
    private readonly seenMessageIds;
    private metrics;
    constructor(trustManager: AgentTrustManager, router: ThreadlineRouter | null, config?: InboundGateConfig);
    /**
     * Late-bind the router after server initialization.
     * The router isn't available at bootstrap time — it's created in server.ts
     * after the Threadline bootstrap completes.
     */
    setRouter(router: ThreadlineRouter): void;
    /**
     * Evaluate an inbound relay message.
     * Returns 'pass' to route to ThreadlineRouter/AutonomyGate,
     * or 'block' with reason.
     */
    evaluate(message: ReceivedMessage): Promise<GateDecision>;
    /**
     * Get gate metrics for observability.
     */
    getMetrics(): {
        passed: number;
        blocked: number;
        blockedByTrust: number;
        blockedByRate: number;
        blockedBySize: number;
        blockedByReplay: number;
        probesHandled: number;
    };
    /**
     * Shutdown: cleanup timers.
     */
    shutdown(): void;
    private classifyOperation;
    private estimatePayloadSize;
    private getRateLimits;
    /**
     * Extract messageId from a ReceivedMessage.
     */
    private extractMessageId;
    /**
     * Prune expired entries from the seen-messageId cache.
     */
    private pruneSeenMessageIds;
}
//# sourceMappingURL=InboundMessageGate.d.ts.map