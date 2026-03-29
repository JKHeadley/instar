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
import fs from 'node:fs';
import path from 'node:path';
// ── Default Config ────────────────────────────────────────────────
export const DEFAULT_SYSTEM_REVIEWER_CONFIG = {
    enabled: true,
    scheduleMs: 6 * 60 * 60 * 1000, // 6 hours
    scheduledTiers: [1, 2, 3],
    probeTimeoutMs: 30_000,
    reviewTimeoutMs: 300_000,
    historyLimit: 50,
    autoSubmitFeedback: false,
    feedbackConsentGiven: false,
    alertOnCritical: true,
    alertCooldownMs: 3_600_000, // 1 hour
    disabledProbes: [],
};
/**
 * Translate doctor probe failures into human-readable, actionable messages.
 */
function formatDoctorAlert(result) {
    const error = result.error ?? 'unknown error';
    const remediations = result.remediation;
    // Map probe names to friendly descriptions
    const friendlyDescriptions = {
        'Lifeline Supervisor': `My auto-restart safety net stopped working — if I crash, I won't come back on my own. Reply "fix lifeline" to get it running again.`,
        'Lifeline Process': `My crash-recovery process isn't running. If I stop unexpectedly, I won't restart automatically. Reply "fix lifeline" to fix this.`,
        'Session Health': `One of my sessions might be stuck. Reply "restart sessions" and I'll check and fix them.`,
        'Scheduler': `The job scheduler isn't working properly, so scheduled tasks might not run. Reply "fix scheduler" to investigate.`,
        'Telegram Messaging': `Having trouble with the Telegram connection — messages might not be going through. Reply "fix telegram" to reconnect.`,
    };
    const description = friendlyDescriptions[result.name];
    if (description) {
        return description;
    }
    // Fallback for unknown probes — still include the error for context
    let msg = `Something went wrong with the "${result.name}" check: ${error}`;
    if (remediations && remediations.length > 0) {
        msg += ` ${remediations[0]}`;
    }
    return msg;
}
// ── Implementation ────────────────────────────────────────────────
export class SystemReviewer extends EventEmitter {
    probes = [];
    history = [];
    config;
    deps;
    historyFile;
    deadLetterFile;
    reviewInProgress = false;
    timer = null;
    lastAlertTimes = new Map();
    constructor(config, deps) {
        super();
        // Strip undefined values so DEFAULT_SYSTEM_REVIEWER_CONFIG defaults are preserved.
        // Spreading { disabledProbes: undefined } would override the default [] causing TypeError.
        const cleanConfig = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
        this.config = { ...DEFAULT_SYSTEM_REVIEWER_CONFIG, ...cleanConfig };
        this.deps = deps;
        this.historyFile = path.join(deps.stateDir, 'review-history.jsonl');
        this.deadLetterFile = path.join(deps.stateDir, 'doctor-dead-letter.jsonl');
        // Load persisted history
        this.loadHistory();
    }
    // ── Probe Registration ──────────────────────────────────────────
    /** Register a probe */
    register(probe) {
        if (this.probes.some(p => p.id === probe.id)) {
            throw new Error(`Probe already registered: ${probe.id}`);
        }
        this.probes.push(probe);
    }
    /** Register multiple probes */
    registerAll(probes) {
        for (const probe of probes) {
            this.register(probe);
        }
    }
    /** Get all registered probes with their status */
    getProbes() {
        return this.probes.map(p => ({
            id: p.id,
            name: p.name,
            tier: p.tier,
            feature: p.feature,
            disabled: this.config.disabledProbes.includes(p.id),
            prerequisitesMet: p.prerequisites(),
        }));
    }
    // ── Review Execution ────────────────────────────────────────────
    /**
     * Run a review. Returns the report.
     *
     * Probes within a tier run concurrently (via Promise.allSettled),
     * except probes sharing a serialGroup which run sequentially.
     * Tiers run in order (1 → 2 → 3 → 4 → 5).
     */
    async review(options = {}) {
        if (this.reviewInProgress) {
            throw new Error('Review already in progress. Use getHistory() to see past results.');
        }
        this.reviewInProgress = true;
        const reviewStart = Date.now();
        try {
            const results = [];
            const skipped = [];
            // Determine which probes to run
            const eligibleProbes = this.getEligibleProbes(options);
            if (options.dryRun) {
                return this.buildDryRunReport(eligibleProbes);
            }
            // Group probes by tier
            const tiers = this.groupByTier(eligibleProbes);
            const tierKeys = Array.from(tiers.keys()).sort();
            for (const tier of tierKeys) {
                // Check review timeout
                if (Date.now() - reviewStart > this.config.reviewTimeoutMs) {
                    // Mark remaining probes as timed out
                    for (const remainingTier of tierKeys.filter(t => t >= tier)) {
                        const remaining = tiers.get(remainingTier) ?? [];
                        for (const probe of remaining) {
                            if (!results.some(r => r.probeId === probe.id)) {
                                results.push(this.buildTimeoutResult(probe, 'Review timeout exceeded'));
                            }
                        }
                    }
                    break;
                }
                const tierProbes = tiers.get(tier) ?? [];
                const tierResults = await this.runTier(tierProbes);
                for (const result of tierResults) {
                    if (result.type === 'result') {
                        results.push(result.value);
                    }
                    else {
                        skipped.push(result.value);
                    }
                }
            }
            const report = this.buildReport(results, skipped, reviewStart);
            // Persist and process
            this.addToHistory(report);
            this.persistHistory();
            await this.processFailures(report);
            this.emit('review:complete', report);
            return report;
        }
        catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.writeDeadLetter('review-error', error.message, error.stack);
            this.emit('review:error', error);
            throw error;
        }
        finally {
            this.reviewInProgress = false;
        }
    }
    // ── Tier Execution ──────────────────────────────────────────────
    async runTier(probes) {
        const output = [];
        // Separate probes by serialGroup
        const groups = new Map();
        const ungrouped = [];
        for (const probe of probes) {
            if (this.config.disabledProbes.includes(probe.id)) {
                output.push({ type: 'skipped', value: { probeId: probe.id, reason: 'Disabled in config' } });
                continue;
            }
            if (!probe.prerequisites()) {
                output.push({ type: 'skipped', value: { probeId: probe.id, reason: 'Prerequisites not met' } });
                continue;
            }
            if (probe.serialGroup) {
                const group = groups.get(probe.serialGroup) ?? [];
                group.push(probe);
                groups.set(probe.serialGroup, group);
            }
            else {
                ungrouped.push(probe);
            }
        }
        // Build concurrent execution units:
        // - Each ungrouped probe is its own unit
        // - Each serial group is one unit (probes run sequentially within)
        const units = [];
        // Ungrouped probes: each runs independently
        for (const probe of ungrouped) {
            units.push(async () => [await this.runProbe(probe)]);
        }
        // Serial groups: probes within a group run sequentially
        for (const [, groupProbes] of groups) {
            units.push(async () => {
                const groupResults = [];
                for (const probe of groupProbes) {
                    groupResults.push(await this.runProbe(probe));
                }
                return groupResults;
            });
        }
        // Run all units concurrently
        const settled = await Promise.allSettled(units.map(fn => fn()));
        for (const result of settled) {
            if (result.status === 'fulfilled') {
                for (const probeResult of result.value) {
                    output.push({ type: 'result', value: probeResult });
                }
            }
            else {
                // Unit-level failure — should be rare (probe-level errors are caught in runProbe)
                this.writeDeadLetter('unit-error', result.reason?.message ?? 'Unknown unit error');
            }
        }
        return output;
    }
    // ── Individual Probe Execution ──────────────────────────────────
    async runProbe(probe) {
        const timeoutMs = probe.timeoutMs ?? this.config.probeTimeoutMs;
        const start = Date.now();
        try {
            const result = await Promise.race([
                probe.run(),
                this.createTimeout(timeoutMs, probe.id),
            ]);
            // Ensure probe returned a valid result
            if (!result || typeof result.passed !== 'boolean') {
                return {
                    probeId: probe.id,
                    name: probe.name,
                    tier: probe.tier,
                    passed: false,
                    description: `Probe returned invalid result`,
                    durationMs: Date.now() - start,
                    error: 'Probe run() did not return a valid ProbeResult',
                    remediation: ['Check probe implementation — run() must return a ProbeResult with a boolean `passed` field'],
                };
            }
            // Override duration with our measurement (more accurate)
            result.durationMs = Date.now() - start;
            if (!result.passed) {
                this.emit('review:probe-failed', result);
            }
            return result;
        }
        catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            const result = {
                probeId: probe.id,
                name: probe.name,
                tier: probe.tier,
                passed: false,
                description: `Probe threw an exception`,
                durationMs: Date.now() - start,
                error: error.message,
                stack: error.stack,
                remediation: ['Check probe implementation for unhandled exceptions'],
            };
            this.emit('review:probe-failed', result);
            return result;
        }
    }
    createTimeout(ms, probeId) {
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve({
                    probeId,
                    name: probeId,
                    tier: 1, // Will be overridden by caller context
                    passed: false,
                    description: 'Probe timed out',
                    durationMs: ms,
                    error: `Probe exceeded timeout of ${ms}ms`,
                    remediation: [
                        `Increase probeTimeoutMs in config (currently ${ms}ms)`,
                        'Check if the feature being probed is hung or extremely slow',
                    ],
                });
            }, ms);
        });
    }
    // ── History & Trend ─────────────────────────────────────────────
    /** Get the last N review reports */
    getHistory(limit) {
        const n = limit ?? this.config.historyLimit;
        return this.history.slice(-n);
    }
    /** Get the number of registered probes */
    getProbeCount() {
        return this.probes.length;
    }
    /** Get the most recent review report */
    getLatest() {
        return this.history.length > 0 ? this.history[this.history.length - 1] : null;
    }
    /** Analyze trend across recent reviews */
    getTrend() {
        const recent = this.history.slice(-10);
        if (recent.length < 2) {
            return {
                window: recent.length,
                direction: 'stable',
                persistentFailures: [],
                newFailures: [],
                recovered: [],
            };
        }
        // Track per-probe pass/fail across recent reviews
        const probeHistory = new Map();
        for (const report of recent) {
            for (const result of report.results) {
                const hist = probeHistory.get(result.probeId) ?? [];
                hist.push(result.passed);
                probeHistory.set(result.probeId, hist);
            }
        }
        const persistentFailures = [];
        const newFailures = [];
        const recovered = [];
        for (const [probeId, results] of probeHistory) {
            if (results.length < 2)
                continue;
            const last3 = results.slice(-3);
            const allFailing = last3.length >= 3 && last3.every(r => !r);
            const justStartedFailing = results.length >= 2
                && results[results.length - 1] === false
                && results[results.length - 2] === true;
            const justRecovered = results.length >= 2
                && results[results.length - 1] === true
                && results[results.length - 2] === false;
            if (allFailing)
                persistentFailures.push(probeId);
            if (justStartedFailing)
                newFailures.push(probeId);
            if (justRecovered)
                recovered.push(probeId);
        }
        // Direction: compare pass rates of first half vs second half
        const mid = Math.floor(recent.length / 2);
        const firstHalf = recent.slice(0, mid);
        const secondHalf = recent.slice(mid);
        const passRate = (reports) => {
            const total = reports.reduce((sum, r) => sum + r.stats.total, 0);
            const passed = reports.reduce((sum, r) => sum + r.stats.passed, 0);
            return total > 0 ? passed / total : 1;
        };
        const firstRate = passRate(firstHalf);
        const secondRate = passRate(secondHalf);
        const delta = secondRate - firstRate;
        let direction = 'stable';
        if (delta > 0.1)
            direction = 'improving';
        else if (delta < -0.1)
            direction = 'declining';
        return {
            window: recent.length,
            direction,
            persistentFailures,
            newFailures,
            recovered,
        };
    }
    // ── Scheduling ──────────────────────────────────────────────────
    /** Start the independent review timer (does NOT use the job scheduler) */
    start() {
        if (!this.config.enabled)
            return;
        if (this.timer)
            return;
        this.timer = setInterval(async () => {
            try {
                await this.review({ tiers: this.config.scheduledTiers });
            }
            catch (err) { // @silent-fallback-ok — dead-letter file IS the degradation path (independent of DegradationReporter by design)
                const error = err instanceof Error ? err : new Error(String(err));
                this.writeDeadLetter('scheduled-review-error', error.message, error.stack);
            }
        }, this.config.scheduleMs);
        // Don't prevent process exit
        if (this.timer.unref)
            this.timer.unref();
    }
    /** Stop the review timer */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /** Whether a review is currently in progress */
    isReviewing() {
        return this.reviewInProgress;
    }
    // ── Startup Sweep ───────────────────────────────────────────────
    /**
     * Clean up orphaned probe artifacts from all state stores.
     * Called on construction and before each review run.
     *
     * Uses the `cleanupProbeArtifacts` callback if provided.
     * Falls back to no-op if no cleanup mechanism is available.
     */
    cleanupCallbacks = [];
    /** Register a cleanup callback for probe artifacts */
    registerCleanup(fn) {
        this.cleanupCallbacks.push(fn);
    }
    async runStartupSweep() {
        let cleaned = 0;
        for (const fn of this.cleanupCallbacks) {
            try {
                await fn();
                cleaned++;
            }
            catch (err) {
                this.writeDeadLetter('startup-sweep-error', err instanceof Error ? err.message : String(err));
            }
        }
        return cleaned;
    }
    // ── HealthChecker Integration ───────────────────────────────────
    /** Get health status for HealthChecker integration */
    getHealthStatus() {
        const latest = this.getLatest();
        if (!latest) {
            return {
                status: 'healthy',
                message: 'No reviews run yet',
                lastCheck: new Date().toISOString(),
            };
        }
        return {
            status: latest.status === 'all-clear' ? 'healthy'
                : latest.status === 'degraded' ? 'degraded'
                    : 'unhealthy',
            message: `${latest.stats.passed}/${latest.stats.total} probes passed`,
            lastCheck: latest.timestamp,
        };
    }
    // ── Private Helpers ─────────────────────────────────────────────
    getEligibleProbes(options) {
        let probes = [...this.probes];
        if (options.probeIds && options.probeIds.length > 0) {
            probes = probes.filter(p => options.probeIds.includes(p.id));
        }
        else if (options.tiers && options.tiers.length > 0) {
            probes = probes.filter(p => options.tiers.includes(p.tier));
        }
        return probes;
    }
    groupByTier(probes) {
        const groups = new Map();
        for (const probe of probes) {
            const tier = groups.get(probe.tier) ?? [];
            tier.push(probe);
            groups.set(probe.tier, tier);
        }
        return groups;
    }
    buildReport(results, skipped, startTime) {
        const passed = results.filter(r => r.passed).length;
        const failed = results.filter(r => !r.passed).length;
        const durationMs = Date.now() - startTime;
        let status = 'all-clear';
        const tier1Failed = results.some(r => !r.passed && r.tier === 1);
        const anyFailed = results.some(r => !r.passed);
        if (tier1Failed)
            status = 'critical';
        else if (anyFailed)
            status = 'degraded';
        const failedResults = results.filter(r => !r.passed);
        const failureSummary = failedResults.length > 0
            ? failedResults.map(r => `[T${r.tier}] ${r.probeId}: ${r.error ?? 'failed'}`).join('\n')
            : undefined;
        return {
            timestamp: new Date().toISOString(),
            status,
            results,
            skipped,
            stats: {
                total: results.length,
                passed,
                failed,
                skipped: skipped.length,
                durationMs,
            },
            failureSummary,
        };
    }
    buildDryRunReport(probes) {
        return {
            timestamp: new Date().toISOString(),
            status: 'all-clear',
            results: [],
            skipped: probes.map(p => ({
                probeId: p.id,
                reason: `Dry run — would ${p.prerequisites() ? 'run' : 'skip (prerequisites not met)'}`,
            })),
            stats: { total: 0, passed: 0, failed: 0, skipped: probes.length, durationMs: 0 },
        };
    }
    buildTimeoutResult(probe, reason) {
        return {
            probeId: probe.id,
            name: probe.name,
            tier: probe.tier,
            passed: false,
            description: 'Skipped — review timeout exceeded',
            durationMs: 0,
            error: reason,
            remediation: ['Increase reviewTimeoutMs or reduce the number of probes per review run'],
        };
    }
    // ── History Persistence ─────────────────────────────────────────
    loadHistory() {
        try {
            if (!fs.existsSync(this.historyFile))
                return;
            const content = fs.readFileSync(this.historyFile, 'utf-8');
            const lines = content.trim().split('\n').filter(Boolean);
            // Load only the last N entries
            const limit = this.config.historyLimit;
            const start = Math.max(0, lines.length - limit);
            for (let i = start; i < lines.length; i++) {
                try {
                    this.history.push(JSON.parse(lines[i]));
                }
                catch {
                    // Skip malformed lines
                }
            }
        }
        catch {
            // History file doesn't exist or can't be read — start fresh
        }
    }
    addToHistory(report) {
        this.history.push(report);
        // Trim to limit
        while (this.history.length > this.config.historyLimit) {
            this.history.shift();
        }
    }
    persistHistory() {
        try {
            // Append the latest report only
            const latest = this.history[this.history.length - 1];
            if (!latest)
                return;
            fs.appendFileSync(this.historyFile, JSON.stringify(latest) + '\n');
            // Periodically compact the file (when it exceeds 2x limit)
            const lineCount = fs.readFileSync(this.historyFile, 'utf-8').trim().split('\n').length;
            if (lineCount > this.config.historyLimit * 2) {
                this.compactHistory();
            }
        }
        catch (err) {
            this.writeDeadLetter('history-persist-error', err instanceof Error ? err.message : String(err));
        }
    }
    compactHistory() {
        try {
            const content = this.history.map(r => JSON.stringify(r)).join('\n') + '\n';
            fs.writeFileSync(this.historyFile, content);
        }
        catch (err) { // @silent-fallback-ok — dead-letter file IS the degradation path
            this.writeDeadLetter('history-compact-error', err instanceof Error ? err.message : String(err));
        }
    }
    // ── Dead Letter Fallback ────────────────────────────────────────
    /**
     * Write to the dead-letter file. This is the ONE error path that
     * does not depend on any monitored infrastructure. Uses only
     * fs.appendFileSync — no Telegram, no feedback, no SQLite.
     */
    writeDeadLetter(type, message, stack) {
        try {
            // Inline size-based rotation — no imports, sync fs only (by design).
            // 10MB cap, keep last 25% (error log — aggressive trim is fine).
            try {
                const stat = fs.statSync(this.deadLetterFile);
                if (stat.size > 10 * 1024 * 1024) {
                    const content = fs.readFileSync(this.deadLetterFile, 'utf-8');
                    const lines = content.split('\n').filter(Boolean);
                    const keep = lines.slice(-Math.max(1, Math.ceil(lines.length * 0.25)));
                    const tmp = this.deadLetterFile + '.rotation-tmp';
                    fs.writeFileSync(tmp, keep.join('\n') + '\n');
                    fs.renameSync(tmp, this.deadLetterFile);
                }
            }
            catch {
                // Rotation failure is non-fatal — continue to append
            }
            const entry = JSON.stringify({
                timestamp: new Date().toISOString(),
                type,
                message,
                stack,
            });
            fs.appendFileSync(this.deadLetterFile, entry + '\n');
        }
        catch {
            // If even file-append fails, the filesystem is gone. Nothing we can do.
            // eslint-disable-next-line no-console
            console.error(`[DOCTOR-DEAD-LETTER] ${type}: ${message}`);
        }
    }
    // ── Failure Processing ──────────────────────────────────────────
    async processFailures(report) {
        const failed = report.results.filter(r => !r.passed);
        if (failed.length === 0)
            return;
        // Telegram alerts for Tier 1/2 failures
        if (this.config.alertOnCritical && this.deps.sendAlert) {
            const alertable = failed.filter(r => r.tier <= 2);
            for (const result of alertable) {
                if (this.isAlertCoolingDown(result.probeId))
                    continue;
                // Format as a narrative, actionable message
                const alertText = formatDoctorAlert(result);
                try {
                    await this.deps.sendAlert(undefined, alertText);
                    this.lastAlertTimes.set(result.probeId, Date.now());
                }
                catch (err) {
                    this.writeDeadLetter('alert-send-error', err instanceof Error ? err.message : String(err));
                }
            }
        }
        // Feedback submission (opt-in only)
        if (this.config.autoSubmitFeedback
            && this.config.feedbackConsentGiven
            && this.deps.submitFeedback) {
            for (const result of failed) {
                // Dedup: only one feedback per probe per 24h
                // (Tracked via probe history — if the probe failed in the previous review too, skip)
                if (this.wasRecentlyReported(result.probeId))
                    continue;
                let description = `Probe: ${result.probeId} (Tier ${result.tier})\n` +
                    `Feature: ${result.name}\n` +
                    `Error: ${result.error ?? 'unknown'}\n`;
                if (result.remediation) {
                    description += `Remediation:\n${result.remediation.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n`;
                }
                // Sanitize through SecretRedactor if available
                if (this.deps.redactSecrets) {
                    description = this.deps.redactSecrets(description);
                }
                try {
                    await this.deps.submitFeedback({
                        type: 'bug',
                        title: `[DOCTOR] ${result.probeId} FAILED`,
                        description,
                        agentName: 'system-reviewer',
                        instarVersion: process.env.npm_package_version ?? 'unknown',
                        nodeVersion: process.version,
                    });
                }
                catch (err) { // @silent-fallback-ok — dead-letter file IS the degradation path
                    this.writeDeadLetter('feedback-submit-error', err instanceof Error ? err.message : String(err));
                }
            }
        }
    }
    isAlertCoolingDown(probeId) {
        const lastAlert = this.lastAlertTimes.get(probeId);
        if (!lastAlert)
            return false;
        return Date.now() - lastAlert < this.config.alertCooldownMs;
    }
    wasRecentlyReported(probeId) {
        // Check if this probe failed in the previous review (24h dedup)
        if (this.history.length < 2)
            return false;
        const previous = this.history[this.history.length - 2];
        return previous.results.some(r => r.probeId === probeId && !r.passed);
    }
}
//# sourceMappingURL=SystemReviewer.js.map