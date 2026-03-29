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
import fs from 'node:fs';
import path from 'node:path';
const PROFILE_DEFAULTS = {
    cautious: {
        evolutionApprovalMode: 'ai-assisted',
        safetyLevel: 1,
        agentAutonomyLevel: 'supervised',
        autoApplyUpdates: false,
        autoRestart: false,
        trustAutoElevate: false,
        discoveryAggressiveness: 'passive', // Only on user request (pull-only)
    },
    supervised: {
        evolutionApprovalMode: 'ai-assisted',
        safetyLevel: 1,
        agentAutonomyLevel: 'supervised',
        autoApplyUpdates: true,
        autoRestart: false,
        trustAutoElevate: true,
        discoveryAggressiveness: 'contextual', // Surface when problem matches
    },
    collaborative: {
        evolutionApprovalMode: 'ai-assisted',
        safetyLevel: 1,
        agentAutonomyLevel: 'collaborative',
        autoApplyUpdates: true,
        autoRestart: true,
        trustAutoElevate: true,
        discoveryAggressiveness: 'proactive', // Full evaluator triggers
    },
    autonomous: {
        evolutionApprovalMode: 'autonomous',
        safetyLevel: 2,
        agentAutonomyLevel: 'autonomous',
        autoApplyUpdates: true,
        autoRestart: true,
        trustAutoElevate: true,
        discoveryAggressiveness: 'proactive', // Full evaluator triggers
    },
};
// ── Manager ──────────────────────────────────────────────────────────
export class AutonomyProfileManager {
    stateDir;
    statePath;
    state;
    config;
    adaptiveTrust;
    evolution;
    constructor(opts) {
        this.stateDir = opts.stateDir;
        this.statePath = path.join(opts.stateDir, 'state', 'autonomy-profile.json');
        this.config = opts.config;
        this.adaptiveTrust = opts.adaptiveTrust ?? null;
        this.evolution = opts.evolution ?? null;
        this.state = this.loadOrCreate();
    }
    // ── Public API ───────────────────────────────────────────────────
    /**
     * Get the current autonomy profile level.
     */
    getProfile() {
        return this.state.profile;
    }
    /**
     * Get the fully resolved autonomy state (profile defaults + config overrides).
     */
    getResolvedState() {
        const defaults = PROFILE_DEFAULTS[this.state.profile];
        return {
            profile: this.state.profile,
            // Config overrides take precedence over profile defaults
            evolutionApprovalMode: this.config.evolution?.approvalMode
                ?? defaults.evolutionApprovalMode,
            safetyLevel: this.config.safety?.level ?? defaults.safetyLevel,
            agentAutonomyLevel: this.config.agentAutonomy?.level ?? defaults.agentAutonomyLevel,
            autoApplyUpdates: this.config.updates?.autoApply ?? defaults.autoApplyUpdates,
            autoRestart: this.config.updates?.autoRestart
                ?? defaults.autoRestart,
            trustAutoElevate: this.config.externalOperations?.trust?.autoElevateEnabled ?? defaults.trustAutoElevate,
            discoveryAggressiveness: this.config.discoveryAggressiveness
                ?? defaults.discoveryAggressiveness,
        };
    }
    /**
     * Set the autonomy profile. Returns the new resolved state.
     * This is the main entry point for conversational autonomy changes.
     */
    setProfile(level, reason) {
        const oldProfile = this.state.profile;
        this.state.history.push({
            from: oldProfile,
            to: level,
            at: new Date().toISOString(),
            reason,
        });
        // Keep history manageable
        if (this.state.history.length > 50) {
            this.state.history = this.state.history.slice(-50);
        }
        this.state.profile = level;
        this.state.setAt = new Date().toISOString();
        this.state.setBy = 'user';
        this.save();
        // Apply profile defaults to config file
        this.applyProfileToConfig(level);
        return this.getResolvedState();
    }
    /**
     * Get a natural language summary of the current autonomy state.
     * This is what the agent shows when users ask "what's my autonomy setup?"
     */
    getNaturalLanguageSummary() {
        const resolved = this.getResolvedState();
        const lines = [];
        lines.push(`Profile: ${resolved.profile}`);
        // Evolution
        const evoLabel = resolved.evolutionApprovalMode === 'autonomous'
            ? 'autonomous (I approve my own evolution proposals, you get notified)'
            : 'ai-assisted (I propose, you approve)';
        lines.push(`Evolution: ${evoLabel}`);
        // Safety
        const safetyLabel = resolved.safetyLevel === 2
            ? 'self-verifying (I reason about risky commands before running them)'
            : 'ask-first (I check with you before risky commands)';
        lines.push(`Safety: ${safetyLabel}`);
        // Updates
        const updateParts = [];
        updateParts.push(resolved.autoApplyUpdates ? 'auto-apply on' : 'manual updates');
        updateParts.push(resolved.autoRestart ? 'auto-restart on' : 'manual restart');
        lines.push(`Updates: ${updateParts.join(', ')}`);
        // Discovery
        const discoveryLabel = resolved.discoveryAggressiveness === 'passive'
            ? 'passive (only on user request)'
            : resolved.discoveryAggressiveness === 'contextual'
                ? 'contextual (surface when problem matches)'
                : 'proactive (full evaluator triggers)';
        lines.push(`Feature discovery: ${discoveryLabel}`);
        // Trust
        if (this.adaptiveTrust) {
            const summary = this.adaptiveTrust.getSummary();
            lines.push('');
            lines.push('Trust status:');
            lines.push(summary);
        }
        // Pending elevations
        const elevations = this.getPendingElevations();
        if (elevations.length > 0) {
            lines.push('');
            lines.push('Elevation opportunities:');
            for (const e of elevations) {
                lines.push(`  ${e.service} ${e.operation}: ${e.currentLevel} -> ${e.suggestedLevel} (${e.reason})`);
            }
        }
        // Evolution stats
        if (this.evolution) {
            const dashboard = this.evolution.getDashboard();
            const proposed = dashboard.evolution.byStatus['proposed'] ?? 0;
            if (proposed > 0) {
                lines.push('');
                lines.push(`Pending evolution proposals: ${proposed}`);
            }
        }
        return lines.join('\n');
    }
    /**
     * Get all pending trust elevation suggestions.
     */
    getPendingElevations() {
        if (!this.adaptiveTrust)
            return [];
        return this.adaptiveTrust.getPendingElevations();
    }
    /**
     * Get the notification preferences.
     */
    getNotificationPreferences() {
        return { ...this.state.notifications };
    }
    /**
     * Update notification preferences.
     */
    setNotificationPreferences(prefs) {
        this.state.notifications = { ...this.state.notifications, ...prefs };
        this.save();
    }
    /**
     * Get the profile change history.
     */
    getHistory() {
        return [...this.state.history];
    }
    /**
     * Get a complete dashboard view suitable for API responses.
     */
    getDashboard() {
        return {
            profile: this.state.profile,
            resolved: this.getResolvedState(),
            summary: this.getNaturalLanguageSummary(),
            elevations: this.getPendingElevations(),
            notifications: this.getNotificationPreferences(),
            history: this.state.history.slice(-10),
            availableProfiles: [
                { level: 'cautious', description: 'I want to see and approve everything' },
                { level: 'supervised', description: 'Handle routine stuff, ask me about important things' },
                { level: 'collaborative', description: 'Work together — I trust your judgment on most things' },
                { level: 'autonomous', description: 'Handle everything yourself, just keep me informed' },
            ],
        };
    }
    // ── Private ──────────────────────────────────────────────────────
    /**
     * Apply profile defaults to the config.json file.
     * Only sets values that aren't already explicitly overridden.
     */
    applyProfileToConfig(level) {
        const configPath = path.join(this.stateDir, 'config.json');
        if (!fs.existsSync(configPath))
            return;
        try {
            const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            const defaults = PROFILE_DEFAULTS[level];
            // Set the profile itself
            raw.autonomyProfile = level;
            // Apply defaults where not explicitly set
            // Safety
            if (!raw.safety)
                raw.safety = {};
            raw.safety.level = raw.safety.level ?? defaults.safetyLevel;
            // Updates
            if (!raw.updates)
                raw.updates = {};
            raw.updates.autoApply = raw.updates.autoApply ?? defaults.autoApplyUpdates;
            raw.updates.autoRestart = raw.updates.autoRestart ?? defaults.autoRestart;
            // Agent autonomy
            if (!raw.agentAutonomy)
                raw.agentAutonomy = {};
            raw.agentAutonomy.level = raw.agentAutonomy.level ?? defaults.agentAutonomyLevel;
            // External operations trust
            if (raw.externalOperations) {
                if (!raw.externalOperations.trust)
                    raw.externalOperations.trust = {};
                raw.externalOperations.trust.autoElevateEnabled =
                    raw.externalOperations.trust.autoElevateEnabled ?? defaults.trustAutoElevate;
            }
            fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
        }
        catch {
            // Config write failure is non-fatal — state file still tracks the profile
        }
    }
    loadOrCreate() {
        if (fs.existsSync(this.statePath)) {
            try {
                return JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
            }
            catch {
                // Corrupt — recreate
            }
        }
        // Derive initial profile from existing config
        const initial = this.deriveProfileFromConfig();
        return {
            profile: initial,
            setAt: new Date().toISOString(),
            setBy: 'system',
            notifications: {
                evolutionDigest: 'immediate',
                trustElevationSuggestions: true,
                migrationNotifications: true,
            },
            history: [],
        };
    }
    /**
     * Infer the autonomy profile from existing config settings.
     * Used when first creating the autonomy state (backward compatibility).
     */
    deriveProfileFromConfig() {
        // If explicitly set in config, use it
        if (this.config.autonomyProfile)
            return this.config.autonomyProfile;
        // Otherwise infer from existing settings
        const safety = this.config.safety?.level ?? 1;
        const autonomy = this.config.agentAutonomy?.level ?? 'collaborative';
        const autoApply = this.config.updates?.autoApply ?? true;
        if (safety === 2 && autonomy === 'autonomous')
            return 'autonomous';
        if (autonomy === 'collaborative' && autoApply)
            return 'collaborative';
        if (autonomy === 'supervised')
            return 'supervised';
        if (!autoApply)
            return 'cautious';
        return 'collaborative'; // sensible default
    }
    save() {
        try {
            const dir = path.dirname(this.statePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
        }
        catch {
            // Non-fatal — state save should never break the system
        }
    }
}
//# sourceMappingURL=AutonomyProfileManager.js.map