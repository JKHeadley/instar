/**
 * AbuseDetector — Pattern-based abuse detection for the relay.
 *
 * Monitors agent behavior for spam, enumeration, flooding, connection churn,
 * and oversized payload attempts. Issues temporary bans by agent fingerprint.
 *
 * Bans are by agent ID (public key fingerprint), not IP — preventing ban
 * evasion by IP rotation while avoiding collateral damage to shared IPs.
 *
 * Also implements Sybil resistance via progressive rate limiting for new agents.
 *
 * Part of Threadline Relay Phase 5.
 */
import type { AgentFingerprint } from './types.js';
export interface AbuseDetectorConfig {
    spamUniqueRecipientsPerMinute: number;
    spamBanDurationMs: number;
    floodingRateMultiplier: number;
    floodingSustainedMinutes: number;
    floodingBanDurationMs: number;
    connectionChurnPerHour: number;
    connectionChurnBanDurationMs: number;
    oversizedPayloadWarnings: number;
    oversizedPayloadBanDurationMs: number;
    sybilFirstHourLimit: number;
    sybilSecondHourLimit: number;
    sybilGraduationMs: number;
    normalRatePerMinute: number;
}
export interface BanInfo {
    agentId: AgentFingerprint;
    reason: string;
    pattern: AbusePattern;
    bannedAt: string;
    expiresAt: string;
    durationMs: number;
}
export type AbusePattern = 'spam' | 'enumeration' | 'flooding' | 'connection_churn' | 'oversized_payload';
export interface AbuseEvent {
    agentId: AgentFingerprint;
    pattern: AbusePattern;
    details: string;
    timestamp: string;
}
export declare class AbuseDetector {
    private readonly config;
    private readonly nowFn;
    /** Active bans by agent ID */
    private readonly bans;
    /** Track unique recipients per agent (for spam detection) */
    private readonly recipientTracker;
    /** Track message rate per agent per minute (for flooding detection) */
    private readonly rateTracker;
    /** Track connection events per agent (for churn detection) */
    private readonly connectionTracker;
    /** Track oversized payload warnings per agent */
    private readonly oversizedWarnings;
    /** Track when agents first connected (for Sybil resistance) */
    private readonly firstSeen;
    /** Track messages sent by new agents (for Sybil limits) */
    private readonly sybilMessageCounts;
    /** Event listeners for abuse events */
    private readonly listeners;
    /** Timer for periodic cleanup */
    private cleanupTimer;
    constructor(config?: Partial<AbuseDetectorConfig>, nowFn?: () => number);
    /**
     * Check if an agent is currently banned.
     */
    isBanned(agentId: AgentFingerprint): BanInfo | null;
    /**
     * Manually ban an agent (admin action).
     */
    ban(agentId: AgentFingerprint, reason: string, durationMs: number, pattern?: AbusePattern): BanInfo;
    /**
     * Manually unban an agent (admin action).
     */
    unban(agentId: AgentFingerprint): boolean;
    /**
     * Get all active bans.
     */
    getActiveBans(): BanInfo[];
    /**
     * Record a message send and check for spam/flooding patterns.
     * Returns a ban if the agent should be banned, null otherwise.
     */
    recordMessage(agentId: AgentFingerprint, recipientId: AgentFingerprint): BanInfo | null;
    /**
     * Record a connection event and check for churn.
     * Returns a ban if the agent should be banned, null otherwise.
     */
    recordConnection(agentId: AgentFingerprint): BanInfo | null;
    /**
     * Record an oversized payload attempt and check for abuse.
     * Returns a ban if warnings exceeded, null otherwise.
     */
    recordOversizedPayload(agentId: AgentFingerprint): BanInfo | null;
    /**
     * Check if a new agent is within its progressive rate limits.
     * Returns { allowed, remaining, reason } indicating whether the message is allowed.
     */
    checkSybilLimit(agentId: AgentFingerprint): {
        allowed: boolean;
        remaining: number;
        reason?: string;
    };
    /**
     * Register a listener for abuse events.
     */
    onAbuse(listener: (event: AbuseEvent) => void): void;
    /**
     * Get abuse detection statistics.
     */
    getStats(): {
        activeBans: number;
        trackedAgents: number;
        newAgents: number;
    };
    /**
     * Clean up expired bans and stale tracking data.
     */
    cleanup(): void;
    /**
     * Destroy the detector (clear timers).
     */
    destroy(): void;
    private checkSpam;
    private checkFlooding;
    private emitEvent;
}
//# sourceMappingURL=AbuseDetector.d.ts.map