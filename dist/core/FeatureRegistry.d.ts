/**
 * FeatureRegistry — Central registry for opt-in features with discovery state tracking.
 *
 * Part of the Consent & Discovery Framework (Phase 1: Feature Registry).
 *
 * Architecture:
 *   - FeatureDefinition: Static metadata defined in code (never changes at runtime)
 *   - FeatureState: Per-user dynamic state stored in SQLite (discovery.db)
 *   - Bootstrap: Existing enabled features start as discoveryState: 'enabled'
 *
 * The registry separates definitions from state following the LaunchDarkly pattern:
 * definitions are always available, state syncs best-effort.
 */
export type FeatureCategory = 'communication' | 'safety' | 'intelligence' | 'infrastructure';
export type ConsentTier = 'informational' | 'local' | 'network' | 'self-governing';
export type DiscoveryState = 'undiscovered' | 'aware' | 'interested' | 'deferred' | 'declined' | 'enabled' | 'disabled';
export type TriggerType = 'problem-match' | 'question-match' | 'usage-pattern' | 'capability-query' | 'explicit-ask';
export interface EnableAction {
    method: 'PATCH' | 'POST';
    path: string;
    body: Record<string, unknown>;
}
export interface DataImplication {
    dataType: string;
    destination: 'local' | 'anthropic-api' | 'cloudflare' | 'custom';
    retention?: string;
    description: string;
}
export interface DiscoveryTrigger {
    type: TriggerType;
    condition: string;
    surfaceAs: 'awareness' | 'suggestion' | 'prompt';
    messageTemplate: string;
    cooldownAfterSurfaceMs: number;
    cooldownAfterDeclineMs: number;
    maxSurfacesBeforeQuiet: number;
}
/** Static — defined in code, never changes at runtime */
export interface FeatureDefinition {
    id: string;
    name: string;
    category: FeatureCategory;
    featureVersion: string;
    configPath: string;
    enableAction: EnableAction;
    disableAction: EnableAction;
    oneLiner: string;
    fullDescription: string;
    prerequisiteFeatures?: string[];
    consentTier: ConsentTier;
    dataImplications: DataImplication[];
    reversibilityNote: string;
    discoveryTriggers: DiscoveryTrigger[];
}
/** Dynamic — per-user, stored in SQLite */
export interface FeatureState {
    userId: string;
    featureId: string;
    enabled: boolean;
    discoveryState: DiscoveryState;
    lastSurfacedAt: string | null;
    surfaceCount: number;
    lastDeclinedAt: string | null;
    consentRecordId: string | null;
    /** Number of times the user has declined this feature */
    declineCount: number;
    /** Feature version at time of last decline (for version-aware re-surfacing) */
    declinedAtVersion: string | null;
}
/** Consent record for high-tier feature activations */
export interface ConsentRecord {
    id: string;
    userId: string;
    featureId: string;
    consentTier: ConsentTier;
    dataImplications: DataImplication[];
    consentedAt: string;
    mechanism: 'explicit-verbal' | 'explicit-written' | 'profile-blanket';
}
/** Discovery event for audit trail */
export interface DiscoveryEvent {
    timestamp: string;
    userId: string;
    featureId: string;
    previousState: DiscoveryState;
    newState: DiscoveryState;
    trigger?: string;
    surfacedAs?: 'awareness' | 'suggestion' | 'prompt';
    context?: string;
}
/** Result of a transition attempt */
export interface TransitionResult {
    success: boolean;
    featureId: string;
    previousState?: DiscoveryState;
    newState?: DiscoveryState;
    timestamp?: string;
    error?: {
        code: string;
        message: string;
        details?: {
            currentState?: DiscoveryState;
            validTransitions?: DiscoveryState[];
        };
    };
}
/** Combined view for API responses */
export interface FeatureInfo {
    definition: FeatureDefinition;
    state: FeatureState;
}
/** Lightweight summary for GET /features/summary */
export interface FeatureSummary {
    id: string;
    name: string;
    category: FeatureCategory;
    consentTier: ConsentTier;
    enabled: boolean;
    discoveryState: DiscoveryState;
}
export declare class FeatureRegistry {
    private db;
    private dbPath;
    private stateDir;
    private definitions;
    private hmacKey;
    constructor(stateDir: string, opts?: {
        hmacKey?: string;
    });
    /**
     * Set the HMAC key for consent record signing (can be set after construction).
     */
    setHmacKey(key: string): void;
    /**
     * Open the database and create schema if needed.
     */
    open(): Promise<void>;
    /**
     * Close the database cleanly.
     */
    close(): void;
    isReady(): boolean;
    /**
     * Register a feature definition. Called at startup to populate the registry.
     */
    register(definition: FeatureDefinition): void;
    /**
     * Get a feature definition by ID.
     */
    getDefinition(id: string): FeatureDefinition | undefined;
    /**
     * Get all registered definitions.
     */
    getAllDefinitions(): FeatureDefinition[];
    /**
     * Get the state for a specific feature and user.
     * Creates a default 'undiscovered' state if none exists.
     */
    getState(featureId: string, userId?: string): FeatureState | null;
    /**
     * Get combined definition + state for a feature.
     */
    getFeatureInfo(featureId: string, userId?: string): FeatureInfo | null;
    /**
     * Get all features with their states for a user.
     */
    getAllFeatures(userId?: string): FeatureInfo[];
    /**
     * Get features filtered by discovery state(s).
     */
    getFeaturesByState(states: DiscoveryState[], userId?: string): FeatureInfo[];
    /**
     * Get lightweight summaries of all features.
     */
    getSummaries(userId?: string): FeatureSummary[];
    /**
     * Get valid transitions for a feature's current state.
     */
    getValidTransitions(featureId: string, userId?: string): DiscoveryState[];
    /**
     * Upsert feature state directly (used for bootstrapping).
     */
    setState(featureId: string, userId: string, updates: Partial<FeatureState>): FeatureState | null;
    /**
     * Execute a validated state transition.
     * Returns a TransitionResult indicating success or failure with details.
     */
    transition(featureId: string, userId: string, to: DiscoveryState, opts?: {
        trigger?: string;
        consentRecord?: ConsentRecord;
        context?: string;
        /** Challenge token for self-governing tier activation */
        activationChallenge?: string;
    }): TransitionResult;
    /**
     * Record that a feature was surfaced to the user.
     * Increments surface count and updates last surfaced timestamp.
     */
    recordSurface(featureId: string, userId: string, opts?: {
        surfacedAs?: 'awareness' | 'suggestion' | 'prompt';
        trigger?: string;
        context?: string;
    }): TransitionResult;
    /**
     * Store a consent record and return its ID.
     */
    storeConsentRecord(record: ConsentRecord): string;
    /**
     * Get consent records for a user.
     */
    getConsentRecords(userId: string): Array<ConsentRecord & {
        integrityVerified?: boolean;
    }>;
    /**
     * Get consent records for a specific feature.
     */
    getConsentRecordsForFeature(featureId: string, userId: string): Array<ConsentRecord & {
        integrityVerified?: boolean;
    }>;
    /**
     * Map a consent record row and verify HMAC signature integrity.
     */
    private mapConsentRow;
    /**
     * Log a discovery event to the JSONL audit trail.
     */
    private logDiscoveryEvent;
    /**
     * Read discovery events, optionally filtered by user and/or feature.
     */
    getDiscoveryEvents(opts?: {
        userId?: string;
        featureId?: string;
        limit?: number;
    }): DiscoveryEvent[];
    /**
     * Delete all discovery data for a user.
     * Consent records are preserved (legal requirement) unless forceDeleteConsent is true.
     */
    eraseDiscoveryData(userId: string, opts?: {
        forceDeleteConsent?: boolean;
    }): {
        deleted: number;
        consentRecordsPreserved: number;
        consentRecordsAnonymized: number;
    };
    /**
     * Get funnel metrics: count of features in each discovery state.
     */
    getFunnelMetrics(userId?: string): Record<DiscoveryState, number>;
    /**
     * Get cooldown status for all features.
     * Returns which features are in cooldown (recently surfaced or declined)
     * and when the cooldown expires.
     */
    getCooldownStatuses(userId?: string): Array<{
        featureId: string;
        featureName: string;
        discoveryState: DiscoveryState;
        surfaceCount: number;
        maxSurfaces: number;
        quieted: boolean;
        lastSurfacedAt: string | null;
        lastDeclinedAt: string | null;
        cooldownExpiresAt: string | null;
    }>;
    /**
     * Get disabled features that have a newer version than when they were disabled.
     * Useful for "features you turned off that have changed" digest.
     */
    getChangedDisabledFeatures(userId?: string): Array<{
        featureId: string;
        featureName: string;
        currentVersion: string;
        disabledAt: string | null;
    }>;
    /**
     * Negative discovery: identify enabled features that haven't been "used"
     * (surfaced or transitioned) in over N days. Suggests disabling unused features.
     */
    getUnusedEnabledFeatures(userId?: string, thresholdDays?: number): Array<{
        featureId: string;
        featureName: string;
        enabledSince: string | null;
        daysSinceActivity: number;
    }>;
    /**
     * Get comprehensive discovery analytics for the dashboard.
     */
    getAnalytics(userId?: string): {
        funnel: Record<DiscoveryState, number>;
        totalFeatures: number;
        enabledCount: number;
        discoveryRate: number;
        cooldowns: ReturnType<FeatureRegistry['getCooldownStatuses']>;
        changedDisabled: ReturnType<FeatureRegistry['getChangedDisabledFeatures']>;
        unusedEnabled: ReturnType<FeatureRegistry['getUnusedEnabledFeatures']>;
        recentEvents: DiscoveryEvent[];
    };
    /**
     * Bootstrap feature states from the current config.
     * Features with enabled: true in config start as discoveryState: 'enabled'.
     * Everything else starts as 'undiscovered'.
     *
     * Note: We read config.json directly because loadConfig() only returns a subset
     * of fields. Features like gitBackup, externalOperations, evolution are read
     * from config.json but not included in the InstarConfig return value.
     */
    bootstrap(config: Record<string, unknown>, userId?: string): void;
    /**
     * Resolve a dot-notation config path to a boolean indicating if the feature is enabled.
     */
    private resolveConfigValue;
    /** Pending challenges: featureId:userId → { token, expiresAt } */
    private activationChallenges;
    /**
     * Generate a time-limited activation challenge for self-governing features.
     * The challenge must be presented back with user confirmation within 10 minutes.
     */
    generateActivationChallenge(featureId: string, userId: string): string;
    /**
     * Verify an activation challenge. Consumes the challenge on success.
     */
    verifyActivationChallenge(featureId: string, userId: string, challenge: string): boolean;
    /**
     * Sign a consent record's canonical fields with HMAC-SHA256.
     * Returns null if no HMAC key is configured.
     */
    private signConsentRecord;
    /**
     * Validate a consent record before storing. Returns error message or null if valid.
     * Server-enforced: prevents empty disclosures, backdated timestamps, invalid mechanisms.
     */
    private validateConsentRecord;
    private createSchema;
}
//# sourceMappingURL=FeatureRegistry.d.ts.map