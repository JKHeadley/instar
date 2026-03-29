/**
 * CoherenceReviewer — Base class for all response review pipeline reviewers.
 *
 * Each reviewer is a focused LLM call checking one dimension of response quality.
 * Reviewers use prompt injection hardening (randomized boundaries, anti-injection
 * preambles, structured message passing) and fail-open semantics.
 */
export interface ReviewResult {
    pass: boolean;
    severity: 'block' | 'warn';
    issue: string;
    suggestion: string;
    /** Reviewer name */
    reviewer: string;
    /** Latency in ms */
    latencyMs: number;
}
export interface ReviewContext {
    message: string;
    channel: string;
    isExternalFacing: boolean;
    recipientType: 'primary-user' | 'secondary-user' | 'agent' | 'external-contact';
    /** Truncated tool output summary (~500 tokens) */
    toolOutputContext?: string;
    /** Extracted URLs from message */
    extractedUrls?: string[];
    /** Agent values summary from AGENT.md Intent section */
    agentValues?: string;
    /** User values summary from USER.md */
    userValues?: string;
    /** Org values from ORG-INTENT.md */
    orgValues?: string;
    /** Trust level for agent recipients */
    trustLevel?: string;
    /** Relationship context (communicationStyle, formality - no free-text fields) */
    relationshipContext?: {
        communicationStyle?: string;
        formality?: string;
        themes?: string[];
    };
}
export interface ReviewerOptions {
    /** Model to use (full ID or tier name) */
    model?: string;
    /** Timeout in ms */
    timeoutMs?: number;
    /** Mode: block, warn, or observe */
    mode?: 'block' | 'warn' | 'observe';
}
export interface ReviewerHealthMetrics {
    passCount: number;
    failCount: number;
    errorCount: number;
    totalLatencyMs: number;
    jsonParseErrors: number;
}
export declare abstract class CoherenceReviewer {
    readonly name: string;
    protected readonly apiKey: string;
    protected readonly options: ReviewerOptions;
    readonly metrics: ReviewerHealthMetrics;
    constructor(name: string, apiKey: string, options?: ReviewerOptions);
    /**
     * Run this reviewer against the given context.
     * Handles timing, API call, parsing, and fail-open semantics.
     */
    review(context: ReviewContext): Promise<ReviewResult>;
    /**
     * Each reviewer overrides this to build its specific prompt.
     */
    protected abstract buildPrompt(context: ReviewContext): string;
    /**
     * Generate a randomized boundary token for prompt injection hardening.
     */
    protected generateBoundary(): string;
    /**
     * Standard anti-injection preamble included at the top of every reviewer prompt.
     */
    protected buildAntiInjectionPreamble(): string;
    /**
     * Wrap a message in boundary markers, JSON-stringified for safety.
     */
    protected wrapMessage(message: string, boundary: string): string;
    /**
     * Parse a reviewer's raw response into the standard result shape.
     * Strict validation — malformed output triggers fail-open.
     */
    protected parseResponse(raw: string, name: string): {
        pass: boolean;
        severity: string;
        issue: string;
        suggestion: string;
    };
    /**
     * Call the Anthropic Messages API directly (same pattern as AnthropicIntelligenceProvider).
     *
     * Uses AbortController to enforce the reviewer's timeoutMs so the underlying
     * fetch is cancelled when a Promise.race timeout fires in callers like GateReviewer.
     * Without cancellation, timed-out fetches keep running, pile up, and eventually
     * cause the HTTP request timeout middleware to return 408 after 30s.
     */
    protected callApi(prompt: string): Promise<string>;
}
//# sourceMappingURL=CoherenceReviewer.d.ts.map