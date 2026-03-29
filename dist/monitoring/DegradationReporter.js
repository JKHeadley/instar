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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// How long before the same feature can trigger another Telegram alert (ms)
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
export class DegradationReporter {
    static instance = null;
    events = [];
    stateDir = null;
    agentName = 'unknown';
    instarVersion = '0.0.0';
    // Downstream systems — connected once the server is fully up
    feedbackSubmitter = null;
    telegramSender = null;
    alertTopicId = null;
    // Dedup: track last alert time per feature to avoid spamming Telegram
    lastAlertTime = new Map();
    constructor() { }
    static getInstance() {
        if (!DegradationReporter.instance) {
            DegradationReporter.instance = new DegradationReporter();
        }
        return DegradationReporter.instance;
    }
    /**
     * Reset singleton for testing.
     */
    static resetForTesting() {
        DegradationReporter.instance = null;
    }
    /**
     * Configure with agent identity and storage.
     * Called during server startup before features initialize.
     */
    configure(opts) {
        this.stateDir = opts.stateDir;
        this.agentName = opts.agentName;
        this.instarVersion = opts.instarVersion;
    }
    /**
     * Connect downstream reporting systems.
     * Called once the server is fully started and feedback/telegram are available.
     * Drains any queued events that were reported before downstream was ready.
     */
    connectDownstream(opts) {
        this.feedbackSubmitter = opts.feedbackSubmitter ?? null;
        this.telegramSender = opts.telegramSender ?? null;
        this.alertTopicId = opts.alertTopicId ?? null;
        // Drain queued events that weren't reported yet
        this.drainQueue();
    }
    /**
     * Report a degradation event.
     *
     * This is the primary API. Call this whenever a fallback activates.
     * If downstream systems aren't ready yet, the event is queued.
     */
    report(event) {
        const full = {
            ...event,
            timestamp: new Date().toISOString(),
            reported: false,
            alerted: false,
        };
        // Always log to console — never silent
        console.warn(`[DEGRADATION] ${event.feature}: ${event.reason}\n` +
            `  Primary: ${event.primary}\n` +
            `  Fallback: ${event.fallback}\n` +
            `  Impact: ${event.impact}`);
        this.events.push(full);
        this.persistToDisk(full);
        // Try to report immediately if downstream is connected
        this.reportEvent(full);
    }
    /**
     * Get all degradation events (for health check API).
     */
    getEvents() {
        return [...this.events];
    }
    /**
     * Generate a human-readable narrative for a degradation event.
     * Used for Telegram alerts and health endpoint summaries.
     * No technical identifiers, no structured fields — just plain language.
     */
    static narrativeFor(event) {
        const impact = event.impact.replace(/\.$/, '');
        const fallbackLower = event.fallback.toLowerCase();
        // Detect failure-state fallbacks (no real alternative, just broken)
        // These describe what ISN'T working, not what IS being used instead
        const isFailureState = /^no |unavailable|never |lost|undiagnosed|unreachable|not running|not delivered|cannot|won't/i.test(fallbackLower)
            || /goes undiagnosed|left halted|in memory only|only in memory|never delivered/i.test(fallbackLower);
        if (isFailureState) {
            return `${impact}. I'll keep trying, but this may need a restart to fully resolve.`;
        }
        // Positive fallback — describe the backup approach being used
        // Strip prefixes like "Falling back to", "Message only in", etc.
        let fallback = event.fallback
            .replace(/^Falling back to /i, '')
            .replace(/^Message only in /i, 'the ')
            .replace(/\.$/, '');
        // Strip parenthetical caveats — the user doesn't need "(no search, no summary updates)"
        fallback = fallback.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
        return `${impact}. Using ${fallback} in the meantime — everything else is working fine.`;
    }
    /**
     * Get unreported events (for monitoring).
     */
    getUnreportedEvents() {
        return this.events.filter(e => !e.reported);
    }
    /**
     * Check if any degradations have occurred.
     */
    hasDegradations() {
        return this.events.length > 0;
    }
    // ── Internal ──────────────────────────────────────────────
    async reportEvent(event) {
        // Submit to feedback system
        if (this.feedbackSubmitter && !event.reported) {
            try {
                await this.feedbackSubmitter({
                    type: 'bug',
                    title: `[DEGRADATION] ${event.feature}: ${event.reason}`,
                    description: [
                        `A feature fallback was activated, indicating the primary path is broken.`,
                        ``,
                        `**Feature**: ${event.feature}`,
                        `**Primary path**: ${event.primary}`,
                        `**Fallback used**: ${event.fallback}`,
                        `**Reason**: ${event.reason}`,
                        `**Impact**: ${event.impact}`,
                        `**Timestamp**: ${event.timestamp}`,
                    ].join('\n'),
                    agentName: this.agentName,
                    instarVersion: this.instarVersion,
                    nodeVersion: process.version,
                    os: `${os.platform()} ${os.release()}`,
                    context: JSON.stringify({
                        feature: event.feature,
                        reason: event.reason,
                        nodeArch: process.arch,
                        nodeVersion: process.version,
                    }),
                });
                event.reported = true;
            }
            catch (err) {
                // @silent-fallback-ok — self-referential (cannot report own failures)
                // Don't fail on reporting failures — the console log is the safety net
                console.error(`[DEGRADATION] Failed to submit feedback: ${err instanceof Error ? err.message : err}`);
            }
        }
        // Send Telegram alert (with per-feature cooldown to avoid spam)
        if (this.telegramSender && this.alertTopicId && !event.alerted) {
            const lastAlert = this.lastAlertTime.get(event.feature) ?? 0;
            const now = Date.now();
            if (now - lastAlert >= ALERT_COOLDOWN_MS) {
                try {
                    await this.telegramSender(this.alertTopicId, DegradationReporter.narrativeFor(event));
                    event.alerted = true;
                    this.lastAlertTime.set(event.feature, now);
                }
                catch {
                    // Don't fail on alerting failures
                }
            }
            else {
                // Within cooldown — suppress the alert but mark as handled
                event.alerted = true;
            }
        }
        // Update persisted state
        this.persistToDisk(event);
    }
    drainQueue() {
        for (const event of this.events) {
            if (!event.reported || !event.alerted) {
                this.reportEvent(event);
            }
        }
    }
    persistToDisk(event) {
        if (!this.stateDir)
            return;
        try {
            const filePath = path.join(this.stateDir, 'degradations.json');
            let existing = [];
            try {
                existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            }
            catch { /* first write */ }
            // Update or append
            const idx = existing.findIndex(e => e.feature === event.feature && e.timestamp === event.timestamp);
            if (idx >= 0) {
                existing[idx] = event;
            }
            else {
                existing.push(event);
            }
            // Keep only last 100 events
            if (existing.length > 100) {
                existing = existing.slice(-100);
            }
            fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
        }
        catch {
            // Disk persistence is best-effort
        }
    }
}
//# sourceMappingURL=DegradationReporter.js.map