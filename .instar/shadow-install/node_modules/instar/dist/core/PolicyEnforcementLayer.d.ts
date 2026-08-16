/**
 * Policy Enforcement Layer (PEL) — Deterministic hard policy checks for
 * the response review pipeline.
 *
 * Runs BEFORE any LLM-based review. Cannot be overridden. All rules are
 * regex-based and complete in <5ms. Even in observeOnly mode, PEL violations
 * are enforced — they represent non-negotiable safety boundaries.
 *
 * Checks for:
 * - Credential / API key leakage
 * - PII patterns (email, phone, SSN)
 * - Agent auth token leakage
 * - Internal URL exposure on external channels
 * - File path exposure on external channels
 * - Environment variable patterns
 */
export interface PELResult {
    pass: boolean;
    violations: PELViolation[];
    /** 'hard_block' = must block, 'warn' = advisory, 'pass' = clean */
    outcome: 'pass' | 'warn' | 'hard_block';
}
export interface PELViolation {
    rule: string;
    severity: 'hard_block' | 'warn';
    detail: string;
    /** Matched pattern (for debugging, not sent to agent) */
    match?: string;
}
export interface PELContext {
    channel: string;
    isExternalFacing: boolean;
    recipientType: 'primary-user' | 'secondary-user' | 'agent' | 'external-contact';
    stateDir: string;
}
export declare class PolicyEnforcementLayer {
    private stateDir;
    private cachedAuthToken;
    private configWatcher;
    private configPath;
    constructor(stateDir: string);
    /**
     * Enforce all policy rules against a message. Returns within 5ms.
     * No I/O during enforcement — all state is pre-cached.
     */
    enforce(message: string, context: PELContext): PELResult;
    /**
     * Clean up resources (file watcher).
     */
    destroy(): void;
    /**
     * Get the cached auth token (for testing).
     */
    getAuthToken(): string | null;
    private loadAuthToken;
    private watchConfig;
    /**
     * All rules as a flat array. Each rule is a pure function that tests
     * a message and returns a violation or null.
     */
    private rules;
}
//# sourceMappingURL=PolicyEnforcementLayer.d.ts.map