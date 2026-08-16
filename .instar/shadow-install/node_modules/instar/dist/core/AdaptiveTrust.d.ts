/**
 * Adaptive Trust — Organic trust evolution between agent and user.
 *
 * Trust is not a config value set at install time. It's a living dimension
 * of the relationship that grows through successful interaction and contracts
 * when things go wrong.
 *
 * Trust is tracked per service and per operation type:
 * - "I trust you with reading email but not deleting it"
 * - "You've done 20 calendar operations without issues, I'll stop asking"
 * - "After that incident, always ask before modifying emails"
 *
 * Three ways trust changes:
 * 1. Earned — consistent successful operations build trust automatically
 * 2. Granted — user explicitly says "you don't need to ask me about X"
 * 3. Revoked — incident or user explicit "always ask about X"
 *
 * Design principle: Trust can never auto-escalate to "autonomous."
 * Only explicit user statements can grant that level. The trust floor
 * prevents silent escalation past a safety minimum.
 */
import type { OperationMutability, TrustLevel, TrustSource, AutonomyBehavior } from './ExternalOperationGate.js';
import type { TrustRecovery } from './TrustRecovery.js';
export interface TrustProfile {
    /** Per-service trust scores */
    services: Record<string, ServiceTrust>;
    /** Global trust modifiers */
    global: {
        /** Overall relationship maturity (0-1), grows over time */
        maturity: number;
        /** Last trust-affecting event description */
        lastEvent: string;
        /** Last trust change timestamp */
        lastEventAt: string;
        /** Trust floor — never auto-escalate below this */
        floor: 'supervised' | 'collaborative';
    };
}
export interface ServiceTrust {
    /** Service name */
    service: string;
    /** Per-operation-type trust */
    operations: Record<OperationMutability, TrustEntry>;
    /** Track record */
    history: TrustHistory;
}
export interface TrustEntry {
    /** Current effective trust level */
    level: TrustLevel;
    /** How this level was set */
    source: TrustSource;
    /** When it was last changed */
    changedAt: string;
    /** If user-explicit, what they said */
    userStatement?: string;
}
export interface TrustHistory {
    /** Successful operations without incident */
    successCount: number;
    /** Operations that were stopped or rolled back */
    incidentCount: number;
    /** Last incident timestamp */
    lastIncident?: string;
    /** Consecutive successes since last incident */
    streakSinceIncident: number;
}
export interface TrustChangeEvent {
    /** What changed */
    service: string;
    /** Which operation type */
    operation: OperationMutability;
    /** Previous trust level */
    from: TrustLevel;
    /** New trust level */
    to: TrustLevel;
    /** How the change happened */
    source: TrustSource;
    /** Timestamp */
    timestamp: string;
    /** Context (user statement or automatic reason) */
    reason: string;
}
export interface AdaptiveTrustConfig {
    /** State directory for trust profile persistence */
    stateDir: string;
    /** Trust floor (default: 'collaborative') */
    floor?: 'supervised' | 'collaborative';
    /** Enable automatic trust elevation (default: true) */
    autoElevateEnabled?: boolean;
    /** Consecutive successes before suggesting elevation (default: 5) */
    elevationThreshold?: number;
    /** Trust level to drop to on incident (default: 'approve-always') */
    incidentDropLevel?: TrustLevel;
}
export interface TrustElevationSuggestion {
    /** Service this suggestion is for */
    service: string;
    /** Operation type */
    operation: OperationMutability;
    /** Current level */
    currentLevel: TrustLevel;
    /** Suggested level */
    suggestedLevel: TrustLevel;
    /** Why */
    reason: string;
    /** Track record that justifies this */
    streak: number;
}
export declare class AdaptiveTrust {
    private config;
    private profilePath;
    private profile;
    private changeLog;
    private trustRecovery;
    constructor(config: AdaptiveTrustConfig);
    /**
     * Wire TrustRecovery for incident tracking and recovery streaks.
     * When set, incidents are forwarded for recovery tracking, and
     * successful operations increment recovery counters.
     */
    setTrustRecovery(recovery: TrustRecovery): void;
    /**
     * Get the trust level for a specific service + operation.
     */
    getTrustLevel(service: string, operation: OperationMutability): TrustEntry;
    /**
     * Map a trust level to an autonomy behavior for the ExternalOperationGate.
     */
    trustToAutonomy(trustLevel: TrustLevel): AutonomyBehavior;
    /**
     * Record a successful operation — builds trust over time.
     */
    recordSuccess(service: string, operation: OperationMutability): TrustElevationSuggestion | null;
    /**
     * Record an incident (stop, abort, rollback) — trust drops.
     */
    recordIncident(service: string, operation: OperationMutability, reason: string): TrustChangeEvent | null;
    /**
     * User explicitly grants or revokes trust.
     *
     * Examples:
     * - grantTrust('gmail', 'delete', 'autonomous', "You don't need to ask me about deleting emails")
     * - grantTrust('gmail', 'write', 'approve-always', "Always ask before sending emails")
     */
    grantTrust(service: string, operation: OperationMutability, level: TrustLevel, userStatement: string): TrustChangeEvent;
    /**
     * User grants trust for ALL operations on a service.
     */
    grantServiceTrust(service: string, level: TrustLevel, userStatement: string): TrustChangeEvent[];
    /**
     * Get the full trust profile.
     */
    getProfile(): TrustProfile;
    /**
     * Get trust history for a service.
     */
    getServiceHistory(service: string): TrustHistory | null;
    /**
     * Get all pending elevation suggestions.
     * These are services/operations where the agent has earned enough
     * trust to suggest reducing friction.
     */
    getPendingElevations(): TrustElevationSuggestion[];
    /**
     * Get recent trust change events.
     */
    getChangeLog(): TrustChangeEvent[];
    /**
     * Get a compact summary of the trust state.
     */
    getSummary(): string;
    private ensureServiceTrust;
    private setTrustLevel;
    private checkElevation;
    /**
     * Compare two trust levels.
     * Returns positive if a is LESS restrictive than b,
     * negative if a is MORE restrictive, 0 if equal.
     */
    private compareTrust;
    /**
     * Get the next trust level up (less restrictive).
     */
    private nextTrustLevel;
    private loadOrCreateProfile;
    private save;
}
//# sourceMappingURL=AdaptiveTrust.d.ts.map