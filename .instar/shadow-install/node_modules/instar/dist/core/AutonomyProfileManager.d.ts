/**
 * AutonomyProfileManager — Unified self-evolution governance for Instar.
 *
 * Coordinates all autonomy-related subsystems through a single profile setting.
 * Users interact conversationally ("go autonomous", "supervise everything").
 * The agent translates intent into config changes via this manager.
 *
 * Four profiles: cautious → supervised → collaborative → autonomous
 * Each maps to defaults for: evolution, safety, trust, updates, agent autonomy.
 * Individual overrides take precedence over profile defaults.
 *
 * Part of the Adaptive Autonomy System spec.
 */
import type { AutonomyProfileLevel, ResolvedAutonomyState, NotificationPreferences, InstarConfig } from './types.js';
import type { AdaptiveTrust, TrustElevationSuggestion } from './AdaptiveTrust.js';
import type { EvolutionManager } from './EvolutionManager.js';
/** Discovery aggressiveness: how proactively the agent surfaces features */
export type DiscoveryAggressiveness = 'passive' | 'contextual' | 'proactive';
interface AutonomyStateFile {
    profile: AutonomyProfileLevel;
    setAt: string;
    setBy: 'user' | 'system' | 'earned';
    notifications: NotificationPreferences;
    /** Track profile change history for trust recovery */
    history: Array<{
        from: AutonomyProfileLevel;
        to: AutonomyProfileLevel;
        at: string;
        reason: string;
    }>;
}
export declare class AutonomyProfileManager {
    private stateDir;
    private statePath;
    private state;
    private config;
    private adaptiveTrust;
    private evolution;
    constructor(opts: {
        stateDir: string;
        config: InstarConfig;
        adaptiveTrust?: AdaptiveTrust | null;
        evolution?: EvolutionManager | null;
    });
    /**
     * Get the current autonomy profile level.
     */
    getProfile(): AutonomyProfileLevel;
    /**
     * Get the fully resolved autonomy state (profile defaults + config overrides).
     */
    getResolvedState(): ResolvedAutonomyState;
    /**
     * Set the autonomy profile. Returns the new resolved state.
     * This is the main entry point for conversational autonomy changes.
     */
    setProfile(level: AutonomyProfileLevel, reason: string): ResolvedAutonomyState;
    /**
     * Get a natural language summary of the current autonomy state.
     * This is what the agent shows when users ask "what's my autonomy setup?"
     */
    getNaturalLanguageSummary(): string;
    /**
     * Get all pending trust elevation suggestions.
     */
    getPendingElevations(): TrustElevationSuggestion[];
    /**
     * Get the notification preferences.
     */
    getNotificationPreferences(): NotificationPreferences;
    /**
     * Update notification preferences.
     */
    setNotificationPreferences(prefs: Partial<NotificationPreferences>): void;
    /**
     * Get the profile change history.
     */
    getHistory(): AutonomyStateFile['history'];
    /**
     * Get a complete dashboard view suitable for API responses.
     */
    getDashboard(): {
        profile: AutonomyProfileLevel;
        resolved: ResolvedAutonomyState;
        summary: string;
        elevations: TrustElevationSuggestion[];
        notifications: NotificationPreferences;
        history: AutonomyStateFile['history'];
        availableProfiles: Array<{
            level: AutonomyProfileLevel;
            description: string;
        }>;
    };
    /**
     * Apply profile defaults to the config.json file.
     * Only sets values that aren't already explicitly overridden.
     */
    private applyProfileToConfig;
    private loadOrCreate;
    /**
     * Infer the autonomy profile from existing config settings.
     * Used when first creating the autonomy state (backward compatibility).
     */
    private deriveProfileFromConfig;
    private save;
}
export {};
//# sourceMappingURL=AutonomyProfileManager.d.ts.map