/**
 * OutputPrivacyRouter — evaluates response sensitivity and routes to DM or shared topic.
 *
 * Implements Gap 10 from the User-Agent Topology Spec:
 *   "In a public topic, a sensitive reply is visible to all group members.
 *    The agent has no mechanism to route sensitive responses to DM instead
 *    of the shared topic."
 *
 * Routing rules:
 *   1. If response contains user-specific sensitive content → route to DM
 *   2. If sensitivity assessment is uncertain → default to DM (fail-closed)
 *   3. If response is clearly non-sensitive → allow shared topic
 *
 * Sensitivity signals (heuristic-based, no LLM needed):
 *   - Contains patterns matching credentials, keys, tokens, passwords
 *   - Contains personal data (emails, phone numbers, SSNs)
 *   - Response was generated from private-scoped memory
 *   - Explicit privacy markers from the chat planner
 *
 * Design:
 *   - Fail-closed: uncertain → DM
 *   - No false-negative tolerance: better to over-route to DM than expose sensitive data
 *   - Deterministic: same input always produces same routing decision
 *   - Fast: heuristic-only, no async operations
 */
import type { PrivacyScopeType } from '../core/types.js';
export type RoutingDecision = 'dm' | 'shared';
export interface RoutingResult {
    /** Where to send the response */
    route: RoutingDecision;
    /** Why this routing was chosen */
    reason: string;
    /** Specific patterns that triggered DM routing (for audit) */
    triggers: string[];
    /** Overall confidence in the routing decision (0-1) */
    confidence: number;
}
export interface RoutingContext {
    /** The response text to evaluate */
    responseText: string;
    /** Whether the response was generated using private-scoped memory */
    usedPrivateMemory?: boolean;
    /** The privacy scope of the source data, if known */
    sourceScopes?: PrivacyScopeType[];
    /** Whether the planner explicitly marked this as sensitive */
    explicitlySensitive?: boolean;
    /** Whether the response is going to a shared topic (vs already a DM) */
    isSharedTopic?: boolean;
}
/**
 * Evaluate a response for sensitivity and determine routing.
 *
 * This is the main entry point. Returns a RoutingResult with the decision,
 * reasoning, and triggering patterns.
 */
export declare function evaluateResponseSensitivity(ctx: RoutingContext): RoutingResult;
/**
 * Quick check: does a response need DM routing?
 * Convenience wrapper for the full evaluateResponseSensitivity.
 */
export declare function shouldRouteToDm(responseText: string, opts?: {
    usedPrivateMemory?: boolean;
    isSharedTopic?: boolean;
}): boolean;
//# sourceMappingURL=OutputPrivacyRouter.d.ts.map