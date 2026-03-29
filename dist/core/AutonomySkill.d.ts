/**
 * AutonomySkill — Conversational interface for autonomy management.
 *
 * Users interact with autonomy through natural language.
 * This module translates between human intent and AutonomyProfileManager
 * operations. The agent calls these functions; the user never types CLI commands.
 *
 * Functions:
 *   - getAutonomyStatus()     → natural language summary of current state
 *   - setAutonomyProfile()    → change profile with confirmation
 *   - getTrustDashboard()     → detailed trust view with elevation opportunities
 *   - handleAutonomyRequest() → parse natural language and dispatch
 *   - notification templates  → formatted strings for Telegram delivery
 *
 * Part of the Adaptive Autonomy System spec.
 */
import type { AutonomyProfileManager } from './AutonomyProfileManager.js';
import type { TrustElevationTracker, RubberStampSignal, ElevationOpportunity } from './TrustElevationTracker.js';
import type { TrustRecovery, RecoverySuggestion } from './TrustRecovery.js';
import type { AutonomyProfileLevel, ResolvedAutonomyState } from './types.js';
export interface AutonomySkillDeps {
    autonomyManager: AutonomyProfileManager;
    trustElevationTracker?: TrustElevationTracker | null;
    trustRecovery?: TrustRecovery | null;
}
export interface AutonomyResponse {
    /** Natural language text to show the user */
    text: string;
    /** What action was taken (for logging / agent context) */
    action: 'status' | 'set-profile' | 'trust-dashboard' | 'suggest-elevation' | 'revert' | 'info';
    /** Profile after the action (if changed) */
    newProfile?: AutonomyProfileLevel;
    /** The resolved state after the action */
    resolved?: ResolvedAutonomyState;
}
export declare class AutonomySkill {
    private deps;
    constructor(deps: AutonomySkillDeps);
    /**
     * Parse a natural language message and dispatch to the appropriate action.
     * This is the main entry point for conversational autonomy management.
     */
    handleAutonomyRequest(userMessage: string): AutonomyResponse;
    /**
     * Get a natural language summary of the current autonomy state.
     */
    getAutonomyStatus(): AutonomyResponse;
    /**
     * Set the autonomy profile and return a confirmation with what changed.
     */
    setAutonomyProfile(profile: AutonomyProfileLevel): AutonomyResponse;
    /**
     * Get the trust dashboard — detailed trust view with per-service levels.
     */
    getTrustDashboard(): AutonomyResponse;
    /**
     * Format a trust elevation suggestion for Telegram delivery.
     */
    static formatElevationSuggestion(opportunity: ElevationOpportunity): string;
    /**
     * Format a rubber-stamp detection message for Telegram delivery.
     */
    static formatRubberStampAlert(signal: RubberStampSignal): string;
    /**
     * Format a trust recovery message for Telegram delivery.
     */
    static formatTrustRecovery(suggestion: RecoverySuggestion): string;
    /**
     * Format a self-evolution notification for Telegram delivery.
     */
    static formatEvolutionApplied(opts: {
        proposalTitle: string;
        proposalId: string;
        affectedArea: string;
        confidence: number;
    }): string;
    /**
     * Format a profile change notification for Telegram delivery.
     */
    static formatProfileChanged(from: AutonomyProfileLevel, to: AutonomyProfileLevel, reason: string): string;
    /**
     * Classify a natural language message into an autonomy intent.
     */
    private classifyIntent;
    /**
     * Suggest the next elevation step based on current profile.
     */
    private suggestElevation;
    /**
     * Revert to the previous profile.
     */
    private revertProfile;
    /**
     * Detect overrides — config values that differ from profile defaults.
     */
    private detectOverrides;
}
//# sourceMappingURL=AutonomySkill.d.ts.map