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
export class UpdateGate {
    config;
    deferralStartedAt = null;
    deferralReason = null;
    firstWarningSent = false;
    firstWarningPending = false;
    finalWarningSent = false;
    finalWarningPending = false;
    constructor(config) {
        this.config = {
            maxDeferralHours: config?.maxDeferralHours ?? 4,
            firstWarningMinutes: config?.firstWarningMinutes ?? 30,
            finalWarningMinutes: config?.finalWarningMinutes ?? 5,
            retryIntervalMs: config?.retryIntervalMs ?? 5 * 60_000,
        };
    }
    /**
     * Check if it's safe to restart now.
     *
     * Returns { allowed: true } if restart can proceed.
     * Returns { allowed: false, retryInMs, reason } if sessions are blocking.
     */
    canRestart(sessionManager, sessionMonitor) {
        const sessions = sessionManager.listRunningSessions();
        // No sessions → restart immediately
        if (sessions.length === 0) {
            this.reset();
            return { allowed: true };
        }
        // Check session health if monitor is available
        const health = sessionMonitor?.getStatus().sessionHealth ?? [];
        const healthMap = new Map(health.map(h => [h.sessionName, h]));
        const activeSessions = [];
        const unresponsiveSessions = [];
        for (const session of sessions) {
            const h = healthMap.get(session.name);
            if (!h) {
                // No health data — be conservative, treat as active
                activeSessions.push(session.name);
            }
            else if (h.status === 'healthy') {
                activeSessions.push(session.name);
            }
            else if (h.status === 'unresponsive') {
                unresponsiveSessions.push(session.name);
            }
            // 'idle' and 'dead' sessions don't block
        }
        // No active sessions → restart (idle/dead/unresponsive don't block)
        if (activeSessions.length === 0) {
            this.reset();
            return {
                allowed: true,
                unresponsiveSessions: unresponsiveSessions.length > 0 ? unresponsiveSessions : undefined,
            };
        }
        // Active sessions exist — start or continue deferral
        if (!this.deferralStartedAt) {
            this.deferralStartedAt = Date.now();
        }
        const elapsedMs = Date.now() - this.deferralStartedAt;
        const maxDeferralMs = this.config.maxDeferralHours * 60 * 60_000;
        const remainingMs = maxDeferralMs - elapsedMs;
        this.deferralReason = `${activeSessions.length} active session(s): ${activeSessions.join(', ')}`;
        // Max deferral exceeded — but only force restart if no HEALTHY sessions.
        // Active, healthy sessions should NEVER be killed for an update.
        // The update can wait — the user's work cannot.
        if (remainingMs <= 0) {
            console.log(`[UpdateGate] Max deferral (${this.config.maxDeferralHours}h) exceeded, but ${activeSessions.length} healthy session(s) still running — continuing to defer`);
        }
        // Check warning thresholds
        const remainingMinutes = remainingMs / 60_000;
        if (remainingMinutes <= this.config.finalWarningMinutes && !this.finalWarningSent) {
            this.finalWarningSent = true;
            this.finalWarningPending = true;
        }
        if (remainingMinutes <= this.config.firstWarningMinutes && !this.firstWarningSent) {
            this.firstWarningSent = true;
            this.firstWarningPending = true;
        }
        return {
            allowed: false,
            reason: this.deferralReason,
            retryInMs: this.config.retryIntervalMs,
            blockingSessions: activeSessions,
            unresponsiveSessions: unresponsiveSessions.length > 0 ? unresponsiveSessions : undefined,
        };
    }
    /**
     * Get current gate status for observability.
     */
    getStatus() {
        const elapsedMs = this.deferralStartedAt ? Date.now() - this.deferralStartedAt : 0;
        return {
            deferring: this.deferralStartedAt !== null,
            deferralStartedAt: this.deferralStartedAt ? new Date(this.deferralStartedAt).toISOString() : null,
            deferralElapsedMinutes: Math.round(elapsedMs / 60_000),
            maxDeferralHours: this.config.maxDeferralHours,
            deferralReason: this.deferralReason,
            firstWarningSent: this.firstWarningSent,
            finalWarningSent: this.finalWarningSent,
        };
    }
    /**
     * Whether the first warning (T-30min before forced restart) should fire.
     * Returns true exactly once — consumes the flag on read.
     */
    shouldSendFirstWarning() {
        if (this.firstWarningPending) {
            this.firstWarningPending = false;
            return true;
        }
        return false;
    }
    /**
     * Whether the final warning (T-5min before forced restart) should fire.
     * Returns true exactly once — consumes the flag on read.
     */
    shouldSendFinalWarning() {
        if (this.finalWarningPending) {
            this.finalWarningPending = false;
            return true;
        }
        return false;
    }
    /**
     * Reset deferral state (called after restart proceeds or update is cancelled).
     */
    reset() {
        this.deferralStartedAt = null;
        this.deferralReason = null;
        this.firstWarningSent = false;
        this.firstWarningPending = false;
        this.finalWarningSent = false;
        this.finalWarningPending = false;
    }
}
//# sourceMappingURL=UpdateGate.js.map