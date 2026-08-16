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
import type { AutonomyProfileLevel } from './types.js';
import type { Dispatch } from './DispatchManager.js';
import type { ActionStep } from './DispatchExecutor.js';
export type DispatchScopeTier = 'context' | 'config' | 'project' | 'behavior' | 'security';
export interface ScopeCheckResult {
    /** Whether execution is allowed */
    allowed: boolean;
    /** The determined scope tier */
    tier: DispatchScopeTier;
    /** Why it was allowed/denied */
    reason: string;
    /** Whether the dispatch needs human approval */
    requiresApproval: boolean;
}
export declare class DispatchScopeEnforcer {
    /**
     * Check whether a dispatch is allowed to execute at the given autonomy profile.
     */
    checkScope(dispatch: Dispatch, profile: AutonomyProfileLevel): ScopeCheckResult;
    /**
     * Validate that action steps stay within their scope tier.
     * Returns invalid steps if any escape the allowed scope.
     */
    validateSteps(steps: ActionStep[], tier: DispatchScopeTier): {
        valid: boolean;
        violations: string[];
    };
    /**
     * Get the scope tier for a dispatch type.
     */
    getScopeTier(type: Dispatch['type']): DispatchScopeTier;
    /**
     * Check if a file path is within config scope.
     */
    isConfigPath(filePath: string): boolean;
    /**
     * Check if a file path is a behavioral file (always requires human).
     */
    isBehavioralPath(filePath: string): boolean;
    private checkStepScope;
}
//# sourceMappingURL=DispatchScopeEnforcer.d.ts.map