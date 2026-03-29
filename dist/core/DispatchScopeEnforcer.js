/**
 * DispatchScopeEnforcer — scope limits for dispatch execution.
 *
 * Part of Phase 4 of the Adaptive Autonomy System (Improvement 3).
 *
 * Dispatch types have different scope tiers controlling what they can modify:
 *   - lesson/strategy: Context only (always eligible for auto-execute)
 *   - configuration: Config files only (when profile >= collaborative)
 *   - action: Project files + shell (when profile >= autonomous)
 *   - behavioral: Agent behavior (CLAUDE.md, hooks) — always requires human
 *   - security: Security settings — always requires human
 *
 * At collaborative profile, action dispatches queue for approval with summary.
 * At autonomous profile, they auto-execute with Telegram notification.
 */
// ── Scope Tier Mapping ───────────────────────────────────────────────
/** Map dispatch type to its scope tier */
const TYPE_TO_SCOPE = {
    lesson: 'context',
    strategy: 'context',
    configuration: 'config',
    action: 'project',
    behavioral: 'behavior',
    security: 'security',
};
/** Minimum autonomy profile required for each scope tier */
const SCOPE_MIN_PROFILE = {
    context: 'cautious', // Always eligible
    config: 'collaborative', // Needs collaborative+
    project: 'autonomous', // Needs autonomous for auto-execute
    behavior: 'never', // Always human
    security: 'never', // Always human
};
/** Profile order for comparison */
const PROFILE_ORDER = {
    cautious: 0,
    supervised: 1,
    collaborative: 2,
    autonomous: 3,
};
/** Config file patterns — paths allowed for 'config' scope */
const CONFIG_PATH_PATTERNS = [
    /^\.instar\/config\.json$/,
    /^\.instar\/.*\.json$/,
    /^\.env(\..+)?$/,
    /^config\//,
];
/** Behavioral file patterns — paths that always require human approval */
const BEHAVIORAL_PATH_PATTERNS = [
    /CLAUDE\.md$/i,
    /\.instar\/hooks\//,
    /\.claude\//,
];
// ── Enforcer ──────────────────────────────────────────────────────────
export class DispatchScopeEnforcer {
    /**
     * Check whether a dispatch is allowed to execute at the given autonomy profile.
     */
    checkScope(dispatch, profile) {
        const tier = TYPE_TO_SCOPE[dispatch.type] ?? 'security';
        const minProfile = SCOPE_MIN_PROFILE[tier];
        // Hard floors: behavior and security always need human
        if (minProfile === 'never') {
            return {
                allowed: false,
                tier,
                reason: `${dispatch.type} dispatches always require human approval`,
                requiresApproval: true,
            };
        }
        const profileLevel = PROFILE_ORDER[profile];
        const requiredLevel = PROFILE_ORDER[minProfile];
        // Action dispatches at collaborative queue for approval (special case)
        if (tier === 'project' && profile === 'collaborative') {
            return {
                allowed: false,
                tier,
                reason: 'action dispatches at collaborative profile queue for human approval',
                requiresApproval: true,
            };
        }
        if (profileLevel < requiredLevel) {
            return {
                allowed: false,
                tier,
                reason: `${dispatch.type} dispatches require ${minProfile} profile or higher (current: ${profile})`,
                requiresApproval: true,
            };
        }
        return {
            allowed: true,
            tier,
            reason: `${dispatch.type} dispatch allowed at ${profile} profile`,
            requiresApproval: false,
        };
    }
    /**
     * Validate that action steps stay within their scope tier.
     * Returns invalid steps if any escape the allowed scope.
     */
    validateSteps(steps, tier) {
        const violations = [];
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const violation = this.checkStepScope(step, tier, i);
            if (violation) {
                violations.push(violation);
            }
        }
        return {
            valid: violations.length === 0,
            violations,
        };
    }
    /**
     * Get the scope tier for a dispatch type.
     */
    getScopeTier(type) {
        return TYPE_TO_SCOPE[type] ?? 'security';
    }
    /**
     * Check if a file path is within config scope.
     */
    isConfigPath(filePath) {
        return CONFIG_PATH_PATTERNS.some(pattern => pattern.test(filePath));
    }
    /**
     * Check if a file path is a behavioral file (always requires human).
     */
    isBehavioralPath(filePath) {
        return BEHAVIORAL_PATH_PATTERNS.some(pattern => pattern.test(filePath));
    }
    // ── Private ─────────────────────────────────────────────────────────
    checkStepScope(step, tier, index) {
        // Context-only scope: no file or shell operations allowed
        if (tier === 'context') {
            if (step.type === 'shell' || step.type === 'file_write' || step.type === 'file_patch') {
                return `Step ${index}: ${step.type} not allowed in context-only scope`;
            }
            if (step.type === 'config_merge') {
                return `Step ${index}: config_merge not allowed in context-only scope`;
            }
            if (step.type === 'agentic') {
                return `Step ${index}: agentic execution not allowed in context-only scope`;
            }
        }
        // Config scope: only config file operations
        if (tier === 'config') {
            if (step.type === 'shell') {
                return `Step ${index}: shell commands not allowed in config scope`;
            }
            if (step.type === 'agentic') {
                return `Step ${index}: agentic execution not allowed in config scope`;
            }
            if (step.path) {
                if (this.isBehavioralPath(step.path)) {
                    return `Step ${index}: cannot modify behavioral file ${step.path} in config scope`;
                }
                if (!this.isConfigPath(step.path)) {
                    return `Step ${index}: path ${step.path} is outside config scope`;
                }
            }
        }
        // Project scope: all operations allowed except behavioral files
        if (tier === 'project') {
            if (step.path && this.isBehavioralPath(step.path)) {
                return `Step ${index}: cannot modify behavioral file ${step.path} — requires human approval`;
            }
        }
        return null;
    }
}
//# sourceMappingURL=DispatchScopeEnforcer.js.map