/**
 * ProbeRegistry — Allowlisted probe functions for self-knowledge tree.
 *
 * Replaces arbitrary script execution with named, registered TypeScript
 * functions. Each probe is read-only, timeout-enforced, and output-capped.
 *
 * Security:
 *   - No shell access — probes are TypeScript functions only
 *   - Timeout enforcement prevents resource exhaustion
 *   - Output cap prevents context overflow
 *   - Unregistered probe names are rejected
 *
 * Born from: PROP-XXX cross-review security fix (all 3 models flagged RCE risk)
 */
import type { ProbeFn, ProbeResult, ProbeRegistration } from './types.js';
export declare class ProbeRegistry {
    private probes;
    /**
     * Register a named probe function.
     */
    register(name: string, fn: ProbeFn, options?: {
        timeoutMs?: number;
        maxOutputChars?: number;
        description?: string;
    }): void;
    /**
     * Execute a registered probe by name.
     * Throws if the probe is not registered.
     */
    execute(name: string, args?: Record<string, string>): Promise<ProbeResult>;
    /**
     * List all registered probe names.
     */
    list(): string[];
    /**
     * Check if a probe is registered.
     */
    has(name: string): boolean;
    /**
     * Get probe registration details (for validation/display).
     */
    get(name: string): ProbeRegistration | undefined;
    private timeout;
}
export declare class ProbeExecutionError extends Error {
    readonly probeName: string;
    readonly reason: string;
    readonly elapsedMs: number;
    constructor(probeName: string, reason: string, elapsedMs: number);
}
export declare class ProbeTimeoutError extends ProbeExecutionError {
    constructor(probeName: string, timeoutMs: number);
}
//# sourceMappingURL=ProbeRegistry.d.ts.map