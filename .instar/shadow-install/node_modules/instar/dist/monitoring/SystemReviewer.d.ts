/**
 * System Reviewer (`instar doctor`) — functional verification for agent infrastructure.
 *
 * The existing monitoring (HealthChecker, CoherenceMonitor, etc.) tells us if the
 * engine is running. The SystemReviewer tells us if the car can drive.
 *
 * Runs lightweight probes that verify features work end-to-end at runtime.
 * Distinct from unit tests (build-time), health checks (liveness), and
 * integration tests (wiring). Probes test actual feature functionality.
 *
 * Key design decisions (from spec review):
 *   - Startup sweep: deletes orphaned __probe_* artifacts on init
 *   - Dead-letter fallback: file-append error path independent of all monitored infra
 *   - Own timer: does NOT depend on the scheduler (which it tests)
 *   - History persistence: JSONL file survives restarts for trend analysis
 *   - Concurrency: parallel within tier, serial for same serialGroup
 *   - Feedback: opt-in only (autoSubmitFeedback defaults to false)
 *
 * Born from the insight: "A system can be healthy while being broken."
 */
import { EventEmitter } from 'node:events';
export interface ProbeResult {
    /** Probe identifier */
    probeId: string;
    /** Human-readable name */
    name: string;
    /** Which tier this probe belongs to */
    tier: 1 | 2 | 3 | 4 | 5;
    /** Pass or fail */
    passed: boolean;
    /** What was tested */
    description: string;
    /** How long the probe took (ms) */
    durationMs: number;
    /** On failure: what went wrong */
    error?: string;
    /** On failure: the full error stack */
    stack?: string;
    /** On failure: what was expected vs. what happened */
    expected?: string;
    actual?: string;
    /** On failure: suggested remediation steps */
    remediation?: string[];
    /** Probe-specific diagnostic data */
    diagnostics?: Record<string, unknown>;
}
export interface ReviewReport {
    /** When the review ran */
    timestamp: string;
    /** Overall result */
    status: 'all-clear' | 'degraded' | 'critical';
    /** Probes that ran */
    results: ProbeResult[];
    /** Probes that were skipped (prerequisites not met) */
    skipped: Array<{
        probeId: string;
        reason: string;
    }>;
    /** Aggregate stats */
    stats: {
        total: number;
        passed: number;
        failed: number;
        skipped: number;
        durationMs: number;
    };
    /** For failed probes: structured summary for feedback submission */
    failureSummary?: string;
}
export interface ReviewTrend {
    /** How many reviews in the analysis window */
    window: number;
    /** Is health score improving, stable, or declining? */
    direction: 'improving' | 'stable' | 'declining';
    /** Probes that are consistently failing (3+ consecutive) */
    persistentFailures: string[];
    /** Probes that recently started failing */
    newFailures: string[];
    /** Probes that recently recovered */
    recovered: string[];
}
export interface Probe {
    /** Unique probe identifier (namespaced, e.g., 'instar.session.list') */
    id: string;
    /** Human-readable name */
    name: string;
    /** Criticality tier (1 = most critical) */
    tier: 1 | 2 | 3 | 4 | 5;
    /** Which feature/module this probes */
    feature: string;
    /**
     * Serialization group. Probes in the same group run sequentially
     * to avoid resource contention (e.g., SQLite write locks).
     * Probes in different groups run concurrently within a tier.
     */
    serialGroup?: string;
    /** Per-probe timeout override (ms). Falls back to config.probeTimeoutMs. */
    timeoutMs?: number;
    /**
     * Whether this probe requires specific infrastructure to be active.
     * Probes with unmet prerequisites are skipped (not failed).
     */
    prerequisites: () => boolean;
    /** Run the probe. Must clean up after itself. */
    run: () => Promise<ProbeResult>;
}
export interface SystemReviewerConfig {
    /** Whether the system reviewer is enabled */
    enabled: boolean;
    /** How often to run a full review (ms). Default: 6 hours */
    scheduleMs: number;
    /** Which tiers to include in scheduled runs */
    scheduledTiers: number[];
    /** Maximum time for a single probe (ms) */
    probeTimeoutMs: number;
    /** Maximum time for a full review run (ms) */
    reviewTimeoutMs: number;
    /** How many past reports to keep */
    historyLimit: number;
    /** Whether to auto-submit failures as feedback (requires feedbackConsentGiven) */
    autoSubmitFeedback: boolean;
    /** Whether the operator has explicitly consented to feedback submission */
    feedbackConsentGiven: boolean;
    /** Whether to send Telegram alerts for critical failures */
    alertOnCritical: boolean;
    /** Cooldown between repeated alerts for same probe (ms) */
    alertCooldownMs: number;
    /** Probes to skip (by probe ID) */
    disabledProbes: string[];
}
export interface ReviewOptions {
    tiers?: number[];
    probeIds?: string[];
    dryRun?: boolean;
}
export interface SystemReviewerEvents {
    'review:complete': (report: ReviewReport) => void;
    'review:probe-failed': (result: ProbeResult) => void;
    'review:error': (error: Error) => void;
}
export declare const DEFAULT_SYSTEM_REVIEWER_CONFIG: SystemReviewerConfig;
export interface SystemReviewerDeps {
    stateDir: string;
    /** Optional: submit feedback items */
    submitFeedback?: (item: {
        type: 'bug';
        title: string;
        description: string;
        agentName: string;
        instarVersion: string;
        nodeVersion: string;
    }) => Promise<unknown>;
    /** Optional: send Telegram alert */
    sendAlert?: (topicId: number | undefined, text: string) => Promise<unknown>;
    /** Optional: redact secrets from strings */
    redactSecrets?: (text: string) => string;
}
export declare class SystemReviewer extends EventEmitter {
    private probes;
    private history;
    private config;
    private deps;
    private historyFile;
    private deadLetterFile;
    private reviewInProgress;
    private timer;
    private lastAlertTimes;
    constructor(config: Partial<SystemReviewerConfig>, deps: SystemReviewerDeps);
    /** Register a probe */
    register(probe: Probe): void;
    /** Register multiple probes */
    registerAll(probes: Probe[]): void;
    /** Get all registered probes with their status */
    getProbes(): Array<{
        id: string;
        name: string;
        tier: number;
        feature: string;
        disabled: boolean;
        prerequisitesMet: boolean;
    }>;
    /**
     * Run a review. Returns the report.
     *
     * Probes within a tier run concurrently (via Promise.allSettled),
     * except probes sharing a serialGroup which run sequentially.
     * Tiers run in order (1 → 2 → 3 → 4 → 5).
     */
    review(options?: ReviewOptions): Promise<ReviewReport>;
    private runTier;
    private runProbe;
    private createTimeout;
    /** Get the last N review reports */
    getHistory(limit?: number): ReviewReport[];
    /** Get the number of registered probes */
    getProbeCount(): number;
    /** Get the most recent review report */
    getLatest(): ReviewReport | null;
    /** Analyze trend across recent reviews */
    getTrend(): ReviewTrend;
    /** Start the independent review timer (does NOT use the job scheduler) */
    start(): void;
    /** Stop the review timer */
    stop(): void;
    /** Whether a review is currently in progress */
    isReviewing(): boolean;
    /**
     * Clean up orphaned probe artifacts from all state stores.
     * Called on construction and before each review run.
     *
     * Uses the `cleanupProbeArtifacts` callback if provided.
     * Falls back to no-op if no cleanup mechanism is available.
     */
    private cleanupCallbacks;
    /** Register a cleanup callback for probe artifacts */
    registerCleanup(fn: () => Promise<void>): void;
    runStartupSweep(): Promise<number>;
    /** Get health status for HealthChecker integration */
    getHealthStatus(): {
        status: 'healthy' | 'degraded' | 'unhealthy';
        message: string;
        lastCheck: string;
    };
    private getEligibleProbes;
    private groupByTier;
    private buildReport;
    private buildDryRunReport;
    private buildTimeoutResult;
    private loadHistory;
    private addToHistory;
    private persistHistory;
    private compactHistory;
    /**
     * Write to the dead-letter file. This is the ONE error path that
     * does not depend on any monitored infrastructure. Uses only
     * fs.appendFileSync — no Telegram, no feedback, no SQLite.
     */
    private writeDeadLetter;
    private processFailures;
    private isAlertCoolingDown;
    private wasRecentlyReported;
}
//# sourceMappingURL=SystemReviewer.d.ts.map