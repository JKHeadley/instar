/**
 * TruncationDetector — detects when Telegram messages appear truncated.
 *
 * Runs as server-side middleware in the Telegram message ingestion path.
 * Detects near-limit messages, rapid multi-part sends, and structurally
 * incomplete code/log content. Returns metadata that the session can use
 * to suggest the Drop Zone.
 */
export interface TruncationResult {
    truncationSuspected: boolean;
    reason?: string;
    confidence?: 'high' | 'medium' | 'low';
}
export declare class TruncationDetector {
    private recentMessages;
    /** Track which topics have already been nudged to avoid repetition */
    private nudgedTopics;
    private nudgeCooldownMs;
    /**
     * Analyze a Telegram message for truncation signals.
     */
    detect(topicId: number, userId: string, text: string): TruncationResult;
    /**
     * Heuristic 1: Message is within NEAR_LIMIT_THRESHOLD chars of the
     * Telegram limit AND ends in a way that suggests manual chopping.
     */
    private checkNearLimit;
    /**
     * Heuristic 2: Multiple messages from same user in same topic
     * within a short window, suggesting manual splitting.
     */
    private checkRapidMultiPart;
    /**
     * Heuristic 3: Content looks like code/logs but is structurally incomplete.
     */
    private checkStructuralIncompleteness;
    /**
     * Check if text has significantly more opening than closing delimiters.
     */
    private hasUnclosedDelimiters;
    /**
     * Heuristic: does this text look like code or log output?
     */
    private looksLikeCode;
    private countChar;
    /**
     * Clear nudge cooldowns (useful for testing).
     */
    clearCooldowns(): void;
}
//# sourceMappingURL=TruncationDetector.d.ts.map