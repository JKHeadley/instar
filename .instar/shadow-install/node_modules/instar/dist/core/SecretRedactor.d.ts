/**
 * SecretRedactor — Redact secrets from content before LLM exposure.
 *
 * Two-layer detection:
 *   1. Pattern matching — known secret formats (API keys, connection strings, etc.)
 *   2. Entropy scanning — high-entropy strings that may be non-standard secrets
 *
 * Replacement is indexed for provenance-aware restoration after LLM resolution.
 *
 * From INTELLIGENT_SYNC_SPEC Section 5.3 (Secret Redaction).
 */
export type SecretType = 'api-key' | 'connection-string' | 'private-key' | 'jwt' | 'high-entropy' | 'env-ref';
export interface RedactionEntry {
    /** Index for replacement tracking. */
    index: number;
    /** The type of secret detected. */
    type: SecretType;
    /** Original value (stored in-memory only, never logged). */
    originalValue: string;
    /** Which file section this was found in (for provenance). */
    fileSection: 'ours' | 'theirs' | 'base' | 'unknown';
    /** Start offset in the original content. */
    startOffset: number;
    /** End offset in the original content. */
    endOffset: number;
}
export interface RedactionResult {
    /** The redacted content. */
    content: string;
    /** The redaction map (for restoration). */
    redactions: RedactionEntry[];
    /** Total number of redactions performed. */
    count: number;
    /** Summary by type (for logging). */
    typeCounts: Record<SecretType, number>;
}
export interface RestorationResult {
    /** The restored content. */
    content: string;
    /** Number of secrets restored. */
    restored: number;
    /** Number of secrets NOT restored (provenance mismatch). */
    blocked: number;
    /** Entries that were blocked. */
    blockedEntries: Array<{
        index: number;
        reason: string;
    }>;
}
export interface FileExclusionResult {
    /** Whether the file should be excluded from LLM resolution. */
    excluded: boolean;
    /** Reason for exclusion. */
    reason?: string;
}
export interface SecretRedactorConfig {
    /** Custom secret patterns to add. */
    customPatterns?: SecretPattern[];
    /** Entropy threshold (default: 4.5 bits/char). */
    entropyThreshold?: number;
    /** Minimum length for entropy scanning (default: 20). */
    entropyMinLength?: number;
    /** Maximum high-entropy strings before excluding file (default: 5). */
    maxEntropyStringsBeforeExclusion?: number;
    /** Additional file patterns to exclude. */
    excludePatterns?: string[];
}
export interface SecretPattern {
    /** Pattern name/type. */
    type: SecretType;
    /** Regex pattern to match. */
    pattern: RegExp;
}
export declare class SecretRedactor {
    private patterns;
    private entropyThreshold;
    private entropyMinLength;
    private maxEntropyStrings;
    private excludePatterns;
    constructor(config?: SecretRedactorConfig);
    /**
     * Check whether a file should be excluded from LLM resolution entirely.
     */
    shouldExcludeFile(filePath: string, content?: string): FileExclusionResult;
    /**
     * Redact secrets from content.
     * Returns the redacted content and a map for later restoration.
     */
    redact(content: string, fileSection?: RedactionEntry['fileSection']): RedactionResult;
    /**
     * Restore redacted secrets in LLM output.
     *
     * Provenance-aware: only restores a secret to a region matching its
     * original file section. If a placeholder appears in a mismatched
     * region, it is NOT restored and flagged for human review.
     */
    restore(content: string, redactions: RedactionEntry[], currentSection?: RedactionEntry['fileSection']): RestorationResult;
    /**
     * Calculate Shannon entropy of a string (bits per character).
     */
    shannonEntropy(str: string): number;
    /**
     * Find high-entropy strings in content (Layer 2).
     */
    private findHighEntropyStrings;
    /**
     * Check if a high-entropy string is likely NOT a secret
     * (URLs, file paths, common code constructs).
     */
    private isLikelyNonSecret;
    /**
     * Check if a position falls inside an already-detected redaction range.
     */
    private isInsideRedaction;
    /**
     * Hash content for audit trail (does NOT contain secrets).
     * Uses SHA-256 truncated to 16 hex chars.
     */
    static hashContent(content: string): string;
}
//# sourceMappingURL=SecretRedactor.d.ts.map