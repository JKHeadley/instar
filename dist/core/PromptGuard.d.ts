/**
 * PromptGuard — Prompt injection defense for LLM conflict resolution.
 *
 * Mitigations:
 *   1. System prompt boundary enforcement (clear delimiters)
 *   2. Content filtering (blocks known injection patterns)
 *   3. Output validation (structured JSON expected → reject freeform)
 *   4. Deterministic fallback (if output is suspect, fall back to Tier 0)
 *
 * From INTELLIGENT_SYNC_SPEC Section 5.1.1 (Prompt Injection Defenses).
 */
export type InjectionThreatLevel = 'none' | 'low' | 'medium' | 'high';
export interface ContentScanResult {
    /** Whether injection was detected. */
    detected: boolean;
    /** Threat level. */
    threatLevel: InjectionThreatLevel;
    /** Matched patterns. */
    matches: InjectionMatch[];
    /** Whether the content should be blocked from LLM submission. */
    shouldBlock: boolean;
}
export interface InjectionMatch {
    /** The pattern that matched. */
    patternName: string;
    /** Where in the content. */
    offset: number;
    /** The matched text (truncated for safety). */
    matchedText: string;
    /** Severity of this specific match. */
    severity: InjectionThreatLevel;
}
export interface OutputValidationResult {
    /** Whether the output appears valid. */
    valid: boolean;
    /** Reason for rejection, if invalid. */
    reason?: string;
    /** Whether to fall back to deterministic resolution (Tier 0). */
    fallbackRecommended: boolean;
}
export interface PromptBoundary {
    /** System instruction delimiter. */
    systemStart: string;
    /** End of system instructions. */
    systemEnd: string;
    /** User content delimiter. */
    contentStart: string;
    /** End of user content. */
    contentEnd: string;
}
export interface PromptGuardConfig {
    /** Custom injection patterns. */
    customPatterns?: InjectionPattern[];
    /** Prompt boundary markers. */
    boundary?: Partial<PromptBoundary>;
    /** Threat level that triggers blocking (default: 'high'). */
    blockThreshold?: InjectionThreatLevel;
    /** Maximum output length before suspicion (default: 10000). */
    maxOutputLength?: number;
    /** Whether to enable output structure validation (default: true). */
    validateOutputStructure?: boolean;
}
export interface InjectionPattern {
    /** Human-readable name. */
    name: string;
    /** Regex to detect. */
    pattern: RegExp;
    /** Severity if matched. */
    severity: InjectionThreatLevel;
}
export declare class PromptGuard {
    private patterns;
    private boundary;
    private blockThreshold;
    private maxOutputLength;
    private validateOutputStructure;
    constructor(config?: PromptGuardConfig);
    /**
     * Scan content for prompt injection attempts.
     * Run this on file content before including it in an LLM prompt.
     */
    scanContent(content: string): ContentScanResult;
    /**
     * Wrap system instructions and content with clear boundary markers.
     * This makes it harder for injected content to escape the content zone.
     */
    wrapPrompt(opts: {
        systemInstructions: string;
        mergeContent: string;
        responseFormat?: string;
    }): string;
    /**
     * Validate LLM output for signs of injection success.
     *
     * Checks:
     * 1. Output length (unexpectedly long → suspicious)
     * 2. JSON structure (if structured output expected)
     * 3. Instruction leakage (system prompt repeated in output)
     * 4. Unexpected content patterns
     */
    validateOutput(output: string, opts?: {
        /** Expected output to be valid JSON. */
        expectJson?: boolean;
        /** Fragments of the system prompt (to detect leakage). */
        systemPromptFragments?: string[];
    }): OutputValidationResult;
    /**
     * Sanitize content before including in a prompt.
     * Escapes delimiter patterns and neutralizes common injection vectors.
     */
    sanitizeContent(content: string): string;
    /**
     * Get the configured prompt boundary markers.
     */
    getBoundary(): PromptBoundary;
    /**
     * Compute overall threat level from matches.
     */
    private computeThreatLevel;
}
//# sourceMappingURL=PromptGuard.d.ts.map