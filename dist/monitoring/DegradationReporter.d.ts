/**
 * DegradationReporter — makes fallback activations LOUD, not silent.
 *
 * When a feature falls back to a secondary path, that's a bug. The fallback
 * keeps the system running, but someone needs to know the primary path failed.
 * Silent fallbacks are almost as bad as silent failures — the user gets a
 * degraded experience and nobody knows about it.
 *
 * This reporter:
 *   1. Logs visibly to console with [DEGRADATION] prefix
 *   2. Queues reports until downstream systems (feedback, telegram) are ready
 *   3. Drains to FeedbackManager (files bug report back to Instar)
 *   4. Sends Telegram alert to agent-attention topic
 *   5. Stores all degradations in a structured file for health checks
 *
 * Usage:
 *   const reporter = DegradationReporter.getInstance();
 *   reporter.report({
 *     feature: 'TopicMemory',
 *     primary: 'SQLite-backed context with summaries',
 *     fallback: 'JSONL-based last 20 messages',
 *     reason: 'better-sqlite3 failed to load',
 *     impact: 'Sessions start without conversation summaries',
 *   });
 *
 * Born from the insight: "Fallbacks should only and always be associated
 * with a bug report back to Instar." — Justin, 2026-02-25
 */
export interface DegradationEvent {
    /** Which feature degraded */
    feature: string;
    /** What the primary path does */
    primary: string;
    /** What the fallback does (the degraded path) */
    fallback: string;
    /** Why the primary path failed */
    reason: string;
    /** User-facing impact of the degradation */
    impact: string;
    /** When the degradation was detected */
    timestamp: string;
    /** Whether this was reported to the feedback system */
    reported: boolean;
    /** Whether this was sent as a Telegram alert */
    alerted: boolean;
}
type TelegramSender = (topicId: number, text: string) => Promise<unknown>;
type FeedbackSubmitter = (item: {
    type: 'bug';
    title: string;
    description: string;
    agentName: string;
    instarVersion: string;
    nodeVersion: string;
    os: string;
    context?: string;
}) => Promise<unknown>;
export declare class DegradationReporter {
    private static instance;
    private events;
    private stateDir;
    private agentName;
    private instarVersion;
    private feedbackSubmitter;
    private telegramSender;
    private alertTopicId;
    private lastAlertTime;
    private constructor();
    static getInstance(): DegradationReporter;
    /**
     * Reset singleton for testing.
     */
    static resetForTesting(): void;
    /**
     * Configure with agent identity and storage.
     * Called during server startup before features initialize.
     */
    configure(opts: {
        stateDir: string;
        agentName: string;
        instarVersion: string;
    }): void;
    /**
     * Connect downstream reporting systems.
     * Called once the server is fully started and feedback/telegram are available.
     * Drains any queued events that were reported before downstream was ready.
     */
    connectDownstream(opts: {
        feedbackSubmitter?: FeedbackSubmitter;
        telegramSender?: TelegramSender;
        alertTopicId?: number | null;
    }): void;
    /**
     * Report a degradation event.
     *
     * This is the primary API. Call this whenever a fallback activates.
     * If downstream systems aren't ready yet, the event is queued.
     */
    report(event: Omit<DegradationEvent, 'timestamp' | 'reported' | 'alerted'>): void;
    /**
     * Get all degradation events (for health check API).
     */
    getEvents(): DegradationEvent[];
    /**
     * Generate a human-readable narrative for a degradation event.
     * Used for Telegram alerts and health endpoint summaries.
     * No technical identifiers, no structured fields — just plain language.
     */
    static narrativeFor(event: DegradationEvent): string;
    /**
     * Get unreported events (for monitoring).
     */
    getUnreportedEvents(): DegradationEvent[];
    /**
     * Check if any degradations have occurred.
     */
    hasDegradations(): boolean;
    private reportEvent;
    private drainQueue;
    private persistToDisk;
}
export {};
//# sourceMappingURL=DegradationReporter.d.ts.map