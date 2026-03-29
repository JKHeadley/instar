/**
 * UpdateGate — Session-aware restart gating.
 *
 * Checks whether it's safe to restart the server for an update.
 * Only 'healthy' (actively producing output) sessions block restarts.
 * 'unresponsive', 'idle', and 'dead' sessions don't — blocking an update
 * for a broken session serves no user interest.
 *
 * Healthy sessions are NEVER killed for an update. The gate defers indefinitely
 * while healthy sessions exist, sending warnings at the configured thresholds.
 */
export interface SessionInfo {
    name: string;
    topicId?: number;
}
export interface SessionHealthEntry {
    topicId: number;
    sessionName: string;
    status: string;
    idleMinutes: number;
}
export interface GateResult {
    allowed: boolean;
    reason?: string;
    retryInMs?: number;
    /** Sessions that are actively blocking the restart */
    blockingSessions?: string[];
    /** Sessions that are unresponsive (warned but not blocking) */
    unresponsiveSessions?: string[];
}
export interface UpdateGateConfig {
    /** Maximum hours to defer a restart for active sessions. Default: 4 */
    maxDeferralHours?: number;
    /** Minutes before forced restart to send first warning. Default: 30 */
    firstWarningMinutes?: number;
    /** Minutes before forced restart to send final warning. Default: 5 */
    finalWarningMinutes?: number;
    /** How often to re-check sessions during deferral, in ms. Default: 5 * 60_000 (5 min) */
    retryIntervalMs?: number;
}
export interface UpdateGateStatus {
    /** Whether a restart is currently being deferred */
    deferring: boolean;
    /** When deferral started */
    deferralStartedAt: string | null;
    /** How long we've been deferring, in minutes */
    deferralElapsedMinutes: number;
    /** Max deferral before forced restart */
    maxDeferralHours: number;
    /** Reason for current deferral */
    deferralReason: string | null;
    /** Whether the first warning (T-30min) has been sent */
    firstWarningSent: boolean;
    /** Whether the final warning (T-5min) has been sent */
    finalWarningSent: boolean;
}
/** Minimal interface for SessionManager — only what we need */
export interface SessionManagerLike {
    listRunningSessions(): SessionInfo[];
}
/** Minimal interface for SessionMonitor — only what we need */
export interface SessionMonitorLike {
    getStatus(): {
        sessionHealth: SessionHealthEntry[];
    };
}
export declare class UpdateGate {
    private config;
    private deferralStartedAt;
    private deferralReason;
    private firstWarningSent;
    private firstWarningPending;
    private finalWarningSent;
    private finalWarningPending;
    constructor(config?: UpdateGateConfig);
    /**
     * Check if it's safe to restart now.
     *
     * Returns { allowed: true } if restart can proceed.
     * Returns { allowed: false, retryInMs, reason } if sessions are blocking.
     */
    canRestart(sessionManager: SessionManagerLike, sessionMonitor?: SessionMonitorLike | null): GateResult;
    /**
     * Get current gate status for observability.
     */
    getStatus(): UpdateGateStatus;
    /**
     * Whether the first warning (T-30min before forced restart) should fire.
     * Returns true exactly once — consumes the flag on read.
     */
    shouldSendFirstWarning(): boolean;
    /**
     * Whether the final warning (T-5min before forced restart) should fire.
     * Returns true exactly once — consumes the flag on read.
     */
    shouldSendFinalWarning(): boolean;
    /**
     * Reset deferral state (called after restart proceeds or update is cancelled).
     */
    reset(): void;
}
//# sourceMappingURL=UpdateGate.d.ts.map