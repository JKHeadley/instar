/**
 * ReflectionMetrics — Usage-based reflection trigger.
 *
 * Tracks cumulative metrics (tool calls, sessions, minutes) since the last
 * reflection and suggests reflection when thresholds are crossed.
 *
 * Ported from Dawn's battle-tested two-hook pattern:
 * - Deterministic metrics collection (every PostToolUse event, zero LLM cost)
 * - Threshold-based reflection suggestion (agent decides whether to reflect)
 *
 * The key insight: time-based reflection (every 4 hours) misses busy periods
 * that need reflection and triggers during idle periods that don't.
 * Usage-based reflection triggers when the agent has actually DONE enough
 * to have something worth reflecting on.
 *
 * Storage: {stateDir}/state/reflection-metrics.json
 * Thresholds: self-tunable by the agent (stored in the metrics file)
 */
export interface ReflectionThresholds {
    /** Trigger reflection after this many tool calls */
    toolCalls: number;
    /** Trigger reflection after this many sessions */
    sessions: number;
    /** Trigger reflection after this many minutes */
    minutes: number;
}
export interface ReflectionMetricsData {
    /** Tool calls since last reflection */
    toolCallsSinceReflection: number;
    /** Sessions since last reflection */
    sessionsSinceReflection: number;
    /** Timestamp when metrics tracking started (or last reflection) */
    trackingSince: string;
    /** Timestamp of last reflection */
    lastReflectionTimestamp: string | null;
    /** Type of last reflection (e.g., 'quick', 'deep', 'grounding') */
    lastReflectionType: string | null;
    /** Self-tunable thresholds */
    thresholds: ReflectionThresholds;
    /** Reflection history (most recent 20) */
    history: ReflectionHistoryEntry[];
}
export interface ReflectionHistoryEntry {
    timestamp: string;
    type: string;
    toolCallsAtReflection: number;
    sessionsAtReflection: number;
    minutesAtReflection: number;
}
export interface ReflectionCheck {
    /** Whether reflection is suggested */
    suggested: boolean;
    /** Which thresholds were exceeded */
    exceededThresholds: string[];
    /** Current metrics */
    metrics: {
        toolCalls: number;
        sessions: number;
        minutesSinceReflection: number;
    };
    /** Current thresholds */
    thresholds: ReflectionThresholds;
}
export declare class ReflectionMetrics {
    private file;
    private data;
    constructor(stateDir: string);
    /**
     * Increment tool call counter. Called on every PostToolUse event.
     */
    recordToolCall(): void;
    /**
     * Increment session counter. Called when a new session starts.
     */
    recordSessionStart(): void;
    /**
     * Check if reflection is suggested based on current metrics.
     * This is a pure check — doesn't modify state.
     */
    check(): ReflectionCheck;
    /**
     * Record that reflection occurred. Resets all counters.
     */
    recordReflection(type: string): void;
    /**
     * Update thresholds (self-tuning by the agent).
     */
    updateThresholds(thresholds: Partial<ReflectionThresholds>): void;
    /**
     * Get current metrics data (for API/display).
     */
    getData(): ReflectionMetricsData;
    private minutesSinceReflection;
    private load;
    private save;
}
//# sourceMappingURL=ReflectionMetrics.d.ts.map