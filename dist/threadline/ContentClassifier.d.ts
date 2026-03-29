/**
 * ContentClassifier — Optional outbound content filter for relay responses.
 *
 * Evaluates outbound messages before they're sent to detect sensitive data:
 *   - API keys, tokens, credentials
 *   - Database queries or internal data
 *   - System prompts or internal instructions
 *   - Personal user information
 *
 * Default: disabled. Operators enable via config for agents handling
 * sensitive data. Layer 4 (grounding preamble) is behavioral guidance;
 * Layer 5 (this) is the actual outbound enforcement.
 *
 * Part of PROP-relay-auto-connect, Layer 5.
 */
export type ContentClassification = 'safe' | 'sensitive' | 'blocked';
export interface ClassificationResult {
    /** Overall classification */
    classification: ContentClassification;
    /** Why it was flagged (if not safe) */
    reason?: string;
    /** Sanitized version (if sensitive and redaction is available) */
    redacted?: string;
}
export interface ContentClassifierConfig {
    /** Enable the classifier (default: false) */
    enabled: boolean;
    /** Block sensitive content outright, or just flag it (default: false — flag only) */
    blockSensitive?: boolean;
    /** Custom patterns to detect (in addition to defaults) */
    customPatterns?: Array<{
        pattern: string;
        label: string;
    }>;
    /** LLM classifier function — if provided, used for deep classification */
    llmClassify?: (content: string, systemPrompt: string) => Promise<string>;
}
export interface ThreadContext {
    /** Trust level of the conversation partner */
    trustLevel: string;
    /** Thread ID */
    threadId?: string;
    /** Remote agent name */
    remoteAgent?: string;
}
export declare class ContentClassifier {
    private readonly config;
    private metrics;
    constructor(config: ContentClassifierConfig);
    /**
     * Whether the classifier is active.
     */
    get enabled(): boolean;
    /**
     * Classify outbound content before sending.
     *
     * Two-stage pipeline:
     *   1. Fast regex pattern matching (catches obvious leaks)
     *   2. LLM classification (catches subtle leaks, if llmClassify is provided)
     *
     * If regex catches something definitive (API key, private key), we skip
     * the LLM call for speed and cost savings.
     */
    classify(content: string, context: ThreadContext): Promise<ClassificationResult>;
    /**
     * Get classifier metrics for observability.
     */
    getMetrics(): {
        classified: number;
        safe: number;
        sensitive: number;
        blocked: number;
        errors: number;
        patternDetections: number;
        llmClassifications: number;
    };
}
/**
 * Create a disabled (no-op) classifier.
 * Used as default when content classification is not configured.
 */
export declare function createDisabledClassifier(): ContentClassifier;
//# sourceMappingURL=ContentClassifier.d.ts.map