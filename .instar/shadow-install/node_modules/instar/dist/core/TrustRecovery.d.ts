/**
 * TrustRecovery — clear recovery path after trust incidents.
 *
 * Part of Phase 4 of the Adaptive Autonomy System (Improvement 10).
 *
 * After an incident drops trust, the system tracks a recovery streak.
 * After N successful operations post-incident (configurable, default: 10),
 * the agent surfaces a recovery message suggesting restoration of
 * the previous trust level.
 *
 * The recovery path is transparent: the agent tells the user exactly
 * what happened, what the track record is since, and what it suggests.
 */
import type { TrustLevel } from './ExternalOperationGate.js';
import type { OperationMutability } from './ExternalOperationGate.js';
export interface IncidentRecord {
    /** Unique incident ID */
    id: string;
    /** Service where the incident occurred */
    service: string;
    /** Operation type */
    operation: OperationMutability;
    /** Trust level before the incident */
    previousLevel: TrustLevel;
    /** Trust level after the incident (dropped to) */
    droppedToLevel: TrustLevel;
    /** When the incident occurred */
    incidentAt: string;
    /** Reason for the incident */
    reason: string;
    /** Whether recovery has been offered */
    recoveryOffered: boolean;
    /** Whether recovery was accepted (trust restored) */
    recovered: boolean;
    /** Whether the user dismissed the recovery suggestion */
    dismissed: boolean;
    /** Successful operations since this incident */
    successesSinceIncident: number;
}
export interface RecoverySuggestion {
    /** The incident that triggered this suggestion */
    incidentId: string;
    /** Service name */
    service: string;
    /** Operation type */
    operation: OperationMutability;
    /** What the trust was before the incident */
    previousLevel: TrustLevel;
    /** Current (dropped) level */
    currentLevel: TrustLevel;
    /** How many successes since the incident */
    successCount: number;
    /** Human-readable message for Telegram */
    message: string;
}
export interface TrustRecoveryConfig {
    /** State directory for persistence */
    stateDir: string;
    /** Consecutive successes needed before recovery suggestion (default: 10) */
    recoveryThreshold?: number;
}
export declare class TrustRecovery {
    private config;
    private incidentsPath;
    private incidents;
    private threshold;
    constructor(config: TrustRecoveryConfig);
    /**
     * Record a new trust incident (called when AdaptiveTrust drops trust).
     */
    recordIncident(service: string, operation: OperationMutability, previousLevel: TrustLevel, droppedToLevel: TrustLevel, reason: string): IncidentRecord;
    /**
     * Record a successful operation for a service — increments recovery counters.
     * Returns a recovery suggestion if the threshold is met.
     */
    recordSuccess(service: string, operation: OperationMutability): RecoverySuggestion | null;
    /**
     * Accept a recovery suggestion — mark the incident as recovered.
     */
    acceptRecovery(incidentId: string): IncidentRecord | null;
    /**
     * Dismiss a recovery suggestion — won't be suggested again.
     */
    dismissRecovery(incidentId: string): IncidentRecord | null;
    /**
     * Get all active incidents (not recovered, not dismissed).
     */
    getActiveIncidents(): IncidentRecord[];
    /**
     * Get all pending recovery suggestions.
     */
    getPendingRecoveries(): RecoverySuggestion[];
    /**
     * Get a specific incident by ID.
     */
    getIncident(id: string): IncidentRecord | null;
    /**
     * Get all incidents for a service.
     */
    getServiceIncidents(service: string): IncidentRecord[];
    /**
     * Get a human-readable summary of the recovery state.
     */
    getSummary(): string;
    private buildSuggestion;
    private load;
    private save;
}
//# sourceMappingURL=TrustRecovery.d.ts.map