/**
 * AgentTrustManager — Per-agent trust profiles for inter-agent communication.
 *
 * Part of Threadline Protocol Phase 5. Tracks trust between THIS agent and
 * remote agents it communicates with. Unlike AdaptiveTrust (user→agent trust),
 * this manages agent→agent trust in the Threadline mesh.
 *
 * Trust rules (Section 7.3/7.4):
 * - ALL trust level UPGRADES require source: 'user-granted' — NO auto-escalation
 * - Auto-DOWNGRADE only: circuit breaker (3 activations in 24h → untrusted),
 *   crypto verification failure → untrusted, 90 days no interaction → downgrade one level
 * - All trust changes logged to append-only audit trail
 *
 * Storage:
 * - Profiles: {stateDir}/threadline/trust-profiles.json
 * - Audit trail: {stateDir}/threadline/trust-audit.jsonl
 */
export type AgentTrustLevel = 'untrusted' | 'verified' | 'trusted' | 'autonomous';
export type AgentTrustSource = 'user-granted' | 'paired-machine-granted' | 'setup-default';
export interface AgentTrustHistory {
    messagesReceived: number;
    messagesResponded: number;
    successfulInteractions: number;
    failedInteractions: number;
    lastInteraction: string;
    streakSinceIncident: number;
}
export interface AgentTrustProfile {
    agent: string;
    /** Cryptographic fingerprint (Ed25519-derived). Primary identity key. */
    fingerprint?: string;
    level: AgentTrustLevel;
    source: AgentTrustSource;
    history: AgentTrustHistory;
    allowedOperations: string[];
    blockedOperations: string[];
    createdAt: string;
    updatedAt: string;
}
export interface TrustAuditEntry {
    timestamp: string;
    agent: string;
    previousLevel: AgentTrustLevel;
    newLevel: AgentTrustLevel;
    source: AgentTrustSource | 'system';
    reason: string;
    userInitiated: boolean;
}
export interface TrustChangeNotification {
    agent: string;
    previousLevel: AgentTrustLevel;
    newLevel: AgentTrustLevel;
    reason: string;
    userInitiated: boolean;
}
/** Callback for trust change notifications */
export type TrustChangeCallback = (notification: TrustChangeNotification) => void;
export interface InteractionStats {
    messagesReceived: number;
    messagesResponded: number;
    successfulInteractions: number;
    failedInteractions: number;
    successRate: number;
    streakSinceIncident: number;
    lastInteraction: string | null;
}
export declare class AgentTrustManager {
    private readonly threadlineDir;
    private readonly profilesPath;
    private readonly auditPath;
    private profiles;
    private onTrustChange;
    private saveDirty;
    private saveTimer;
    constructor(options: {
        stateDir: string;
        onTrustChange?: TrustChangeCallback;
    });
    /**
     * Get trust profile for an agent. Returns null if no profile exists.
     */
    getProfile(agentName: string): AgentTrustProfile | null;
    /**
     * Get or create a trust profile for an agent.
     * New agents start as 'untrusted' with 'setup-default' source.
     */
    getOrCreateProfile(agentName: string): AgentTrustProfile;
    /**
     * Get trust profile by cryptographic fingerprint.
     * Used for relay inbound messages where identity is fingerprint-based.
     */
    getProfileByFingerprint(fingerprint: string): AgentTrustProfile | null;
    /**
     * Get or create a trust profile keyed by fingerprint.
     * For relay agents, the fingerprint IS the identity.
     */
    getOrCreateProfileByFingerprint(fingerprint: string, displayName?: string): AgentTrustProfile;
    /**
     * Get trust level by fingerprint. Returns 'untrusted' for unknown agents.
     */
    getTrustLevelByFingerprint(fingerprint: string): AgentTrustLevel;
    /**
     * Get allowed operations by fingerprint.
     */
    getAllowedOperationsByFingerprint(fingerprint: string): string[];
    /**
     * Set trust level by fingerprint.
     */
    setTrustLevelByFingerprint(fingerprint: string, level: AgentTrustLevel, source: AgentTrustSource, reason?: string, displayName?: string): boolean;
    /**
     * Record a received message by fingerprint (debounced save).
     */
    recordMessageReceivedByFingerprint(fingerprint: string): void;
    /**
     * Set trust level for an agent.
     * UPGRADES require source: 'user-granted' or 'paired-machine-granted'.
     * Returns true if the change was applied, false if rejected.
     */
    setTrustLevel(agentName: string, level: AgentTrustLevel, source: AgentTrustSource, reason?: string): boolean;
    /**
     * Record a successful or failed interaction with an agent.
     */
    recordInteraction(agentName: string, success: boolean, details?: string): void;
    /**
     * Record a received message from an agent.
     */
    recordMessageReceived(agentName: string): void;
    /**
     * Record a response sent to an agent.
     */
    recordMessageResponded(agentName: string): void;
    /**
     * Check if an agent is allowed to perform an operation.
     * Checks both trust-level defaults and explicit allowed/blocked lists.
     */
    checkPermission(agentName: string, operation: string): boolean;
    /**
     * Get interaction statistics for an agent.
     */
    getInteractionStats(agentName: string): InteractionStats | null;
    /**
     * Safety-only auto-downgrade. Never auto-upgrades.
     * Called by CircuitBreaker (3 activations in 24h) or on crypto failure.
     */
    autoDowngrade(agentName: string, reason: string): boolean;
    /**
     * Check for staleness-based auto-downgrade.
     * If an agent hasn't interacted in 90 days, downgrade one level.
     * Returns true if a downgrade occurred.
     */
    checkStalenessDowngrade(agentName: string, nowMs?: number): boolean;
    /**
     * List all trust profiles, optionally filtered by trust level.
     */
    listProfiles(filter?: {
        level?: AgentTrustLevel;
        source?: AgentTrustSource;
    }): AgentTrustProfile[];
    /**
     * Block a specific operation for an agent.
     */
    blockOperation(agentName: string, operation: string): void;
    /**
     * Unblock a specific operation for an agent.
     */
    unblockOperation(agentName: string, operation: string): void;
    /**
     * Read audit trail entries. Returns all entries or last N entries.
     */
    readAuditTrail(limit?: number): TrustAuditEntry[];
    /**
     * Force reload profiles from disk.
     */
    reload(): void;
    /**
     * Flush any pending saves and stop the debounce timer.
     * Call on shutdown for clean exit.
     */
    flush(): void;
    /**
     * Schedule a debounced save (dirty-flag + interval flush).
     * Avoids synchronous disk writes on every message received.
     */
    private scheduleSave;
    private loadProfiles;
    private save;
    private writeAudit;
    private compareTrust;
}
//# sourceMappingURL=AgentTrustManager.d.ts.map