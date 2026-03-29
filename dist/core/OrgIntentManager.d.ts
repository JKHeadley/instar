/**
 * OrgIntentManager — Parses and validates ORG-INTENT.md for organizational intent.
 *
 * The organizational intent layer sits above individual agent intent (AGENT.md).
 * Three-rule contract:
 *   1. Org constraints are mandatory — agents cannot override
 *   2. Org goals are defaults — agents can specialize
 *   3. Agent identity fills the rest — personality, style, domain expertise
 *
 * Storage: ORG-INTENT.md in the project's .instar/ directory.
 */
export interface OrgConstraint {
    text: string;
    source: 'org-intent';
}
export interface OrgGoal {
    text: string;
    source: 'org-intent';
    specializable: boolean;
}
export interface ParsedOrgIntent {
    name: string;
    constraints: OrgConstraint[];
    goals: OrgGoal[];
    values: string[];
    tradeoffHierarchy: string[];
    raw: string;
}
export interface IntentConflict {
    orgConstraint: string;
    agentStatement: string;
    severity: 'error' | 'warning';
    description: string;
}
export interface IntentValidationResult {
    valid: boolean;
    conflicts: IntentConflict[];
    warnings: string[];
}
export declare class OrgIntentManager {
    private stateDir;
    private orgIntentPath;
    constructor(stateDir: string);
    /** Check if ORG-INTENT.md exists */
    exists(): boolean;
    /** Read and return raw content */
    readRaw(): string | null;
    /** Parse ORG-INTENT.md into structured data */
    parse(): ParsedOrgIntent | null;
    /** Validate agent intent against org constraints (structural/heuristic) */
    validateAgentIntent(agentIntentContent: string): IntentValidationResult;
    /**
     * Extract actionable statements from agent intent content.
     * Finds list items and sentences containing "never", "always", etc.
     */
    private extractStatements;
}
//# sourceMappingURL=OrgIntentManager.d.ts.map