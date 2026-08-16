/**
 * HomeostasisMonitor — Work-velocity awareness for agent sessions.
 *
 * Tracks the rhythm of work (commits, tool calls, elapsed time) and suggests
 * brief awareness pauses when velocity thresholds are exceeded. This prevents
 * tunnel vision during extended autonomous sessions.
 *
 * Ported from Dawn's battle-tested homeostasis-check.sh:
 * - Commit-count trigger: N commits without a pause
 * - Time-based trigger: N minutes without a pause
 * - Pre-commit awareness: suggests pause before commits when thresholds crossed
 *
 * Key insight: ReflectionMetrics tracks deep reflection intervals (50 tool calls,
 * 120 minutes). HomeostasisMonitor tracks quick awareness checks (3 commits,
 * 15 minutes). They complement each other — homeostasis is the heartbeat,
 * reflection is the deep breath.
 *
 * Storage: {stateDir}/state/homeostasis.json
 * API: GET /homeostasis/check, POST /homeostasis/pause, POST /homeostasis/reset
 */
export interface HomeostasisThresholds {
    /** Suggest pause after this many commits without a pause */
    commits: number;
    /** Suggest pause after this many minutes without a pause */
    minutes: number;
}
export interface HomeostasisData {
    /** Commits since last pause */
    commitsSincePause: number;
    /** Timestamp of last pause (or session start) */
    lastPauseTimestamp: string;
    /** Timestamp of session start */
    sessionStartTimestamp: string;
    /** Total pauses this session */
    totalPauses: number;
    /** Total commits this session */
    totalCommits: number;
    /** Self-tunable thresholds */
    thresholds: HomeostasisThresholds;
    /** Pause history (most recent 20) */
    history: HomeostasisPauseEntry[];
}
export interface HomeostasisPauseEntry {
    timestamp: string;
    commitsSincePrevious: number;
    minutesSincePrevious: number;
    /** What the agent was doing (optional context) */
    context?: string;
}
export interface HomeostasisCheck {
    /** Whether a pause is suggested */
    pauseSuggested: boolean;
    /** Which thresholds were exceeded */
    exceededThresholds: string[];
    /** Current metrics */
    metrics: {
        commitsSincePause: number;
        minutesSincePause: number;
        totalCommits: number;
        totalPauses: number;
        sessionMinutes: number;
    };
    /** Current thresholds */
    thresholds: HomeostasisThresholds;
    /** Human-readable suggestion */
    suggestion: string;
}
export declare class HomeostasisMonitor {
    private file;
    private data;
    constructor(stateDir: string);
    /**
     * Record that a commit was made. Called on PostToolUse for git commit.
     */
    recordCommit(): void;
    /**
     * Check if a pause is suggested based on current metrics.
     * Pure check — doesn't modify state.
     */
    check(): HomeostasisCheck;
    /**
     * Record that a pause occurred. Resets commit counter and pause timestamp.
     */
    recordPause(context?: string): void;
    /**
     * Reset for a new session. Preserves thresholds and history.
     */
    resetSession(): void;
    /**
     * Update thresholds (self-tuning by the agent).
     */
    updateThresholds(thresholds: Partial<HomeostasisThresholds>): void;
    /**
     * Get current data (for API/display).
     */
    getData(): HomeostasisData;
    private minutesSincePause;
    private sessionMinutes;
    private load;
    private save;
}
//# sourceMappingURL=HomeostasisMonitor.d.ts.map