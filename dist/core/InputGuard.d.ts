/**
 * InputGuard — Input-side defense against cross-topic injection.
 *
 * Complements the output-side CoherenceGate. Validates message provenance
 * before messages reach sessions, using three layers:
 *
 *   Layer 1: Provenance Check — deterministic tag matching (<1ms)
 *   Layer 1.5: Injection Pattern Filter — regex detection (<1ms)
 *   Layer 2: Topic Coherence Review — async LLM check (~1s, background)
 *
 * Design principle: warn, don't block. Suspicious messages still reach
 * the session, but with a system-reminder warning that gives the LLM
 * context to make an informed decision.
 *
 * Hard requirement: NEVER fail silently. Every fallback, timeout, or
 * degradation must be logged and surfaced via the attention queue.
 */
export interface InputGuardConfig {
    /** Whether the Input Guard is enabled */
    enabled: boolean;
    /** Enable Layer 1 provenance checking */
    provenanceCheck?: boolean;
    /** Enable Layer 1.5 injection pattern detection */
    injectionPatterns?: boolean;
    /** Enable Layer 2 LLM topic coherence review */
    topicCoherenceReview?: boolean;
    /** Action on suspicious messages: 'warn' (default), 'block', 'log' */
    action?: 'warn' | 'block' | 'log';
    /** Timeout for LLM review in ms (default: 3000) */
    reviewTimeout?: number;
}
export interface TopicBinding {
    topicId: number;
    topicName: string;
    channel: 'telegram' | 'whatsapp';
    sessionName: string;
}
export type ProvenanceResult = 'verified' | 'mismatched-tag' | 'untagged' | 'unbound';
export interface InputReviewResult {
    verdict: 'coherent' | 'suspicious';
    reason: string;
    confidence: number;
    layer: 'provenance' | 'injection-pattern' | 'topic-coherence';
}
interface SecurityEventData {
    event: string;
    session: string;
    boundTopic?: number;
    [key: string]: unknown;
}
export declare class InputGuard {
    private config;
    private stateDir;
    private securityLogPath;
    private apiKey;
    private attentionQueueFn;
    private topicMemoryFn;
    private sessionCreationTimes;
    private errorCount;
    private errorWindowStart;
    constructor(options: {
        config: InputGuardConfig;
        stateDir: string;
        apiKey?: string;
    });
    /** Set the attention queue callback for surfacing degradation */
    setAttentionQueue(fn: (title: string, body: string) => void): void;
    /** Set the topic memory callback for getting recent messages */
    setTopicMemory(fn: (topicId: number, limit: number) => Promise<string[]>): void;
    /** Track session creation time (for CONTINUATION restriction) */
    trackSessionCreation(sessionName: string): void;
    /**
     * Deterministic provenance check. Returns the classification of the
     * message based on its source tag.
     */
    checkProvenance(text: string, binding: TopicBinding): ProvenanceResult;
    /**
     * Check for known injection patterns in the message text.
     * Returns the matched pattern name or null.
     */
    checkInjectionPatterns(text: string): string | null;
    /**
     * Async LLM-based topic coherence check. Returns the review result.
     * Uses Haiku for fast, low-cost classification.
     */
    reviewTopicCoherence(text: string, binding: TopicBinding): Promise<InputReviewResult>;
    /**
     * Build a system-reminder warning for suspicious messages.
     * Uses <system-reminder> tags which occupy a structurally privileged
     * position in Claude's context.
     */
    buildWarning(binding: TopicBinding, reason: string): string;
    logSecurityEvent(data: SecurityEventData): void;
    private logDegradation;
    private trackErrors;
}
export {};
//# sourceMappingURL=InputGuard.d.ts.map