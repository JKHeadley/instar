/**
 * QuotaManager — Orchestration hub for all quota management components.
 *
 * Owns: QuotaCollector, QuotaTracker, SessionMigrator, QuotaNotifier,
 *       AccountSwitcher, SessionCredentialManager.
 *
 * Drives the adaptive polling loop, auto-triggers migration on threshold
 * crossings, and emits unified events for downstream consumers (Telegram,
 * dashboards, admin UI).
 *
 * Phase 4 of INSTAR_QUOTA_MIGRATION_SPEC.
 */
import { EventEmitter } from 'node:events';
import { SessionCredentialManager } from './SessionCredentialManager.js';
import { DegradationReporter } from './DegradationReporter.js';
const MAX_NOTIFICATION_RETRIES = 3;
const NOTIFICATION_BACKOFF_BASE_MS = 5000;
// ── QuotaManager class ───────────────────────────────────────────────
export class QuotaManager extends EventEmitter {
    tracker;
    collector;
    switcher;
    migrator;
    notifier;
    credentialManager;
    config;
    pollingTimer = null;
    running = false;
    lastCollectionAt = null;
    nextCollectionAt = null;
    pendingNotifications = [];
    notificationRetryTimer = null;
    sendNotification = null;
    // References set via setSessionManager / setScheduler
    sessionManager = null;
    scheduler = null;
    constructor(config, components) {
        super();
        this.config = {
            adaptivePolling: true,
            autoMigrate: true,
            jsonlCanTriggerMigration: false,
            ...config,
        };
        this.tracker = components.tracker;
        this.collector = components.collector ?? null;
        this.switcher = components.switcher ?? null;
        this.migrator = components.migrator ?? null;
        this.notifier = components.notifier;
        this.credentialManager = components.credentialManager ?? new SessionCredentialManager();
        // Forward collector events
        if (this.collector) {
            this.collector.on('token_expired', (ev) => this.emit('token_expired', ev));
            this.collector.on('token_expiring', (ev) => this.emit('token_expiring', ev));
            this.collector.on('jsonl_parse_error', (ev) => this.emit('jsonl_parse_error', ev));
        }
        // Forward migrator events
        if (this.migrator) {
            this.migrator.on('migration_started', (ev) => {
                this.emit('migration_started', {
                    type: 'started',
                    sourceAccount: ev.reason,
                    targetAccount: ev.targetAccount,
                    sessionsAffected: 0,
                    timestamp: new Date().toISOString(),
                });
                this.enqueueNotification(`🔄 Migration started: switching from ${ev.sourceAccount} to ${ev.targetAccount}`);
            });
            this.migrator.on('migration_complete', (ev) => {
                this.emit('migration_complete', {
                    type: 'complete',
                    sourceAccount: ev.previousAccount ?? 'unknown',
                    targetAccount: ev.newAccount ?? undefined,
                    sessionsAffected: ev.sessionsRestarted?.length ?? 0,
                    duration: ev.durationMs,
                    timestamp: ev.completedAt,
                });
                this.enqueueNotification(`✅ Migration complete: switched to ${ev.newAccount}. ` +
                    `${ev.sessionsRestarted?.length ?? 0} sessions restarted in ${Math.round((ev.durationMs ?? 0) / 1000)}s.`);
            });
            this.migrator.on('migration_failed', (ev) => {
                this.emit('migration_failed', {
                    type: 'failed',
                    sourceAccount: ev.previousAccount ?? 'unknown',
                    sessionsAffected: ev.sessionsHalted?.length ?? 0,
                    error: ev.error,
                    duration: ev.durationMs,
                    timestamp: ev.completedAt,
                });
                this.enqueueNotification(`❌ Migration failed: ${ev.error ?? 'unknown error'}`);
            });
            this.migrator.on('migration_partial', (ev) => {
                this.emit('migration_partial', {
                    type: 'partial',
                    sourceAccount: ev.previousAccount ?? 'unknown',
                    targetAccount: ev.newAccount ?? undefined,
                    sessionsAffected: ev.sessionsRestarted?.length ?? 0,
                    duration: ev.durationMs,
                    timestamp: ev.completedAt,
                });
                this.enqueueNotification(`⚠️ Migration partial: ${ev.sessionsRestarted?.length ?? 0}/${ev.sessionsHalted?.length ?? 0} sessions restarted.`);
            });
            this.migrator.on('migration_no_target', (ev) => {
                this.emit('migration_no_target', {
                    type: 'no_target',
                    sourceAccount: ev.sourceAccount ?? 'unknown',
                    sessionsAffected: 0,
                    timestamp: new Date().toISOString(),
                });
                this.enqueueNotification(`⚠️ Quota migration triggered but no alternative account available. ` +
                    `Enforcement will activate at 90% 5-hour rate.`);
            });
            this.migrator.on('enforced_pause', (ev) => {
                this.enqueueNotification(`⚠️ [QUOTA ENFORCEMENT] PAUSE WARNING\n` +
                    `5-hour rate: ${ev.fiveHourPercent}% — no alternative accounts.\n` +
                    `Sent graceful shutdown to ${ev.sessionsSignaled} session(s). Scheduler paused.\n` +
                    `If quota reaches 95%, all sessions will be killed.`);
            });
            this.migrator.on('enforced_kill', (ev) => {
                this.enqueueNotification(`🚨 [QUOTA ENFORCEMENT] EMERGENCY STOP\n` +
                    `5-hour rate: ${ev.fiveHourPercent}% — no alternative accounts.\n` +
                    `Killed ${ev.sessionsKilled.length} session(s): ${ev.sessionsKilled.join(', ') || 'none'}.\n` +
                    `Scheduler paused. Manual intervention required.`);
            });
        }
    }
    // ── Dependency wiring ────────────────────────────────────────────
    /**
     * Set the SessionManager for wiring migrator deps.
     */
    setSessionManager(sm) {
        this.sessionManager = sm;
        this.wireMigratorDeps();
    }
    /**
     * Set the JobScheduler for spawn gating and migration respawns.
     * Also replaces scheduler.canRunJob with quota-aware version.
     */
    setScheduler(sched) {
        this.scheduler = sched;
        // Replace canRunJob with quota-aware gate
        sched.canRunJob = (priority) => this.canSpawnSession(priority).allowed;
        this.wireMigratorDeps();
    }
    /**
     * Set the notification send function (e.g., Telegram relay).
     */
    setNotificationSender(fn) {
        this.sendNotification = fn;
    }
    /**
     * Wire migrator deps once both sessionManager and scheduler are available.
     */
    wireMigratorDeps() {
        if (!this.migrator || !this.sessionManager || !this.scheduler || !this.switcher) {
            return;
        }
        const sm = this.sessionManager;
        const sched = this.scheduler;
        const switcher = this.switcher;
        this.migrator.setDeps({
            listRunningSessions: () => sm.listRunningSessions().map(s => ({
                id: s.id,
                tmuxSession: s.tmuxSession,
                jobSlug: s.jobSlug,
                name: s.name,
            })),
            sendKey: (tmuxSession, key) => sm.sendKey(tmuxSession, key),
            killSession: (sessionId) => sm.killSession(sessionId),
            isSessionAlive: (tmuxSession) => sm.isSessionAlive(tmuxSession),
            pauseScheduler: () => sched.pause(),
            resumeScheduler: () => sched.resume(),
            respawnJob: async (slug) => {
                // Resume scheduler momentarily to allow the trigger
                sched.resume();
                const result = sched.triggerJob(slug, 'migration-respawn');
                if (result === 'skipped') {
                    console.log(`[QuotaManager] Respawn ${slug} skipped (quota/gate check failed)`);
                }
            },
            getAccountStatuses: () => switcher.getAccountStatuses(),
            switchAccount: (email) => switcher.switchAccount(email),
        });
        // Recover from any in-progress migration that was interrupted
        this.migrator.completeRecovery().catch(err => {
            console.error('[QuotaManager] Migration recovery failed:', err);
        });
    }
    // ── Polling loop ─────────────────────────────────────────────────
    /**
     * Start the adaptive polling loop. Collector drives the interval.
     */
    start() {
        if (this.running)
            return;
        this.running = true;
        // Start notification retry processor
        this.notificationRetryTimer = setInterval(() => this.processNotificationRetries(), 10000);
        if (this.collector && this.config.adaptivePolling) {
            // Kick off the first collection immediately
            this.scheduleNextCollection(0);
            console.log('[QuotaManager] Started adaptive polling loop');
        }
        else {
            // No collector — fall back to periodic tracker reads
            this.scheduleTrackerPoll();
            console.log('[QuotaManager] Started (tracker-only mode, no collector)');
        }
        this.emit('started');
    }
    /**
     * Stop polling and clean up.
     */
    stop() {
        if (!this.running)
            return;
        this.running = false;
        if (this.pollingTimer) {
            clearTimeout(this.pollingTimer);
            this.pollingTimer = null;
        }
        if (this.notificationRetryTimer) {
            clearInterval(this.notificationRetryTimer);
            this.notificationRetryTimer = null;
        }
        this.nextCollectionAt = null;
        this.emit('stopped');
        console.log('[QuotaManager] Stopped');
    }
    /**
     * Force an immediate collection + migration check + notification check.
     */
    async refresh() {
        if (this.collector) {
            return this.runCollectionCycle();
        }
        // No collector — just refresh from tracker's file
        const state = this.tracker.getState();
        if (state) {
            await this.postCollectionChecks(state, 'oauth', 'authoritative');
        }
        return null;
    }
    // ── Spawn gating ────────────────────────────────────────────────
    /**
     * Check if a session can be spawned at a given priority.
     * Considers both quota thresholds and migration state.
     *
     * Order matters: check quota thresholds FIRST, then migration state.
     * A stale migration state (e.g., from a crash) should not block jobs
     * when quota is healthy. Migration is a quota-saving measure — if
     * quota is fine, migration concerns are irrelevant.
     */
    canSpawnSession(priority) {
        // Check quota thresholds first
        const trackerResult = this.tracker.shouldSpawnSession(priority);
        if (!trackerResult.allowed) {
            return trackerResult;
        }
        // During migration, block only if there's actual quota pressure.
        // This prevents stale migration state (from crashes) from permanently
        // blocking all jobs when quota is healthy.
        if (this.migrator?.isMigrating()) {
            const state = this.tracker.getState();
            const weeklyPressure = state != null && state.usagePercent >= 50;
            const fiveHourPressure = state != null &&
                typeof state.fiveHourPercent === 'number' &&
                state.fiveHourPercent >= 50;
            if (weeklyPressure || fiveHourPressure) {
                return { allowed: false, reason: 'Migration in progress — session spawning blocked' };
            }
            // Quota is healthy despite "migrating" state — allow spawn
        }
        return trackerResult;
    }
    // ── Internal: collection cycle ───────────────────────────────────
    scheduleNextCollection(delayMs) {
        if (!this.running)
            return;
        if (this.pollingTimer) {
            clearTimeout(this.pollingTimer);
        }
        this.nextCollectionAt = new Date(Date.now() + delayMs);
        this.pollingTimer = setTimeout(async () => {
            try {
                await this.runCollectionCycle();
            }
            catch (err) {
                DegradationReporter.getInstance().report({
                    feature: 'QuotaManager.scheduleNextCollection',
                    primary: 'Run periodic quota collection cycle',
                    fallback: 'Collection skipped, will retry at next interval',
                    reason: `Collection cycle error: ${err instanceof Error ? err.message : String(err)}`,
                    impact: 'Quota data may be stale until next successful collection',
                });
                console.error('[QuotaManager] Collection cycle error:', err);
            }
            // Schedule next based on adaptive interval
            if (this.running && this.collector) {
                const nextInterval = this.collector.getPollingIntervalMs();
                this.scheduleNextCollection(nextInterval);
            }
        }, delayMs);
    }
    /**
     * Fallback: when no collector, poll the tracker file every 5 minutes.
     */
    scheduleTrackerPoll() {
        if (!this.running)
            return;
        const TRACKER_POLL_MS = 5 * 60 * 1000;
        this.nextCollectionAt = new Date(Date.now() + TRACKER_POLL_MS);
        this.pollingTimer = setTimeout(async () => {
            try {
                const state = this.tracker.getState();
                if (state) {
                    await this.postCollectionChecks(state, 'oauth', 'authoritative');
                }
            }
            catch (err) {
                DegradationReporter.getInstance().report({
                    feature: 'QuotaManager.scheduleTrackerPoll',
                    primary: 'Poll quota tracker for state updates',
                    fallback: 'Tracker poll skipped, will retry at next interval',
                    reason: `Tracker poll error: ${err instanceof Error ? err.message : String(err)}`,
                    impact: 'Threshold notifications and migration checks delayed',
                });
                console.error('[QuotaManager] Tracker poll error:', err);
            }
            this.scheduleTrackerPoll();
        }, TRACKER_POLL_MS);
    }
    async runCollectionCycle() {
        if (!this.collector)
            return null;
        const result = await this.collector.collect();
        this.lastCollectionAt = new Date();
        if (result.success && result.state) {
            await this.postCollectionChecks(result.state, result.dataSource, result.dataConfidence);
        }
        else if (result.errors.length > 0) {
            console.warn('[QuotaManager] Collection errors:', result.errors.join('; '));
        }
        return result;
    }
    async postCollectionChecks(state, dataSource, dataConfidence) {
        // 1. Notify on threshold crossings
        try {
            await this.notifier.checkAndNotify(state);
        }
        catch (err) {
            DegradationReporter.getInstance().report({
                feature: 'QuotaManager.postCollectionChecks.notify',
                primary: 'Check quota thresholds and send notifications',
                fallback: 'Notifications skipped for this collection cycle',
                reason: `Notification check failed: ${err instanceof Error ? err.message : String(err)}`,
                impact: 'User may not receive quota threshold alerts',
            });
            console.error('[QuotaManager] Notification check failed:', err);
        }
        // 2. Emit threshold events for subscribers
        this.emitThresholdEvents(state, dataSource);
        // 3. Auto-migrate if enabled and thresholds warrant it
        if (this.config.autoMigrate && this.migrator && !this.migrator.isMigrating()) {
            // Don't trigger migration from JSONL estimates unless explicitly allowed
            if (dataConfidence === 'estimated' && !this.config.jsonlCanTriggerMigration) {
                return;
            }
            try {
                const migrated = await this.migrator.checkAndMigrate({
                    percentUsed: state.usagePercent,
                    fiveHourPercent: state.fiveHourPercent ?? undefined,
                    activeAccountEmail: state.accounts?.find(a => a.isActive)?.email ?? null,
                });
                if (migrated) {
                    console.log('[QuotaManager] Migration triggered after collection');
                }
            }
            catch (err) {
                DegradationReporter.getInstance().report({
                    feature: 'QuotaManager.postCollectionChecks.migrate',
                    primary: 'Check if account migration is needed based on quota thresholds',
                    fallback: 'Migration check skipped, will retry at next collection',
                    reason: `Migration check failed: ${err instanceof Error ? err.message : String(err)}`,
                    impact: 'Auto-migration may be delayed if quota thresholds are breached',
                });
                console.error('[QuotaManager] Migration check failed:', err);
            }
        }
    }
    emitThresholdEvents(state, dataSource) {
        const account = state.accounts?.find(a => a.isActive)?.email ?? 'unknown';
        const ts = new Date().toISOString();
        // Weekly thresholds: 70 (warning), 85 (critical), 95 (limit)
        const weekly = state.usagePercent;
        if (weekly >= 95) {
            this.emit('threshold_crossed', {
                level: 'limit', metric: 'weekly', value: weekly,
                threshold: 95, account, dataSource, timestamp: ts,
            });
        }
        else if (weekly >= 85) {
            this.emit('threshold_crossed', {
                level: 'critical', metric: 'weekly', value: weekly,
                threshold: 85, account, dataSource, timestamp: ts,
            });
        }
        else if (weekly >= 70) {
            this.emit('threshold_crossed', {
                level: 'warning', metric: 'weekly', value: weekly,
                threshold: 70, account, dataSource, timestamp: ts,
            });
        }
        // 5-hour thresholds: 80 (warning), 95 (limit)
        const fiveHour = state.fiveHourPercent;
        if (typeof fiveHour === 'number' && isFinite(fiveHour)) {
            if (fiveHour >= 95) {
                this.emit('threshold_crossed', {
                    level: 'limit', metric: 'fiveHour', value: fiveHour,
                    threshold: 95, account, dataSource, timestamp: ts,
                });
            }
            else if (fiveHour >= 80) {
                this.emit('threshold_crossed', {
                    level: 'warning', metric: 'fiveHour', value: fiveHour,
                    threshold: 80, account, dataSource, timestamp: ts,
                });
            }
        }
    }
    // ── Notification retry queue ───────────────────────────────────
    enqueueNotification(message) {
        // Try immediate send
        if (this.sendNotification) {
            this.sendNotification(message).catch(() => {
                this.pendingNotifications.push({
                    message,
                    retries: 0,
                    nextRetryAt: Date.now() + NOTIFICATION_BACKOFF_BASE_MS,
                    createdAt: Date.now(),
                });
            });
        }
        else {
            console.log(`[QuotaManager] No notification sender, logging: ${message}`);
        }
    }
    async processNotificationRetries() {
        if (!this.sendNotification || this.pendingNotifications.length === 0)
            return;
        const now = Date.now();
        const remaining = [];
        for (const notif of this.pendingNotifications) {
            if (now < notif.nextRetryAt) {
                remaining.push(notif);
                continue;
            }
            try {
                await this.sendNotification(notif.message);
                // Success — drop from queue
            }
            catch {
                notif.retries++;
                if (notif.retries < MAX_NOTIFICATION_RETRIES) {
                    notif.nextRetryAt = now + NOTIFICATION_BACKOFF_BASE_MS * Math.pow(2, notif.retries);
                    remaining.push(notif);
                }
                else {
                    console.error(`[QuotaManager] Notification delivery failed after ${MAX_NOTIFICATION_RETRIES} retries: ${notif.message}`);
                    this.emit('notification_delivery_failed', { message: notif.message });
                }
            }
        }
        this.pendingNotifications = remaining;
    }
    // ── Status / API ─────────────────────────────────────────────────
    /**
     * Get polling status for the /quota/polling endpoint.
     */
    getPollingStatus() {
        const pollingState = this.collector?.getPollingState();
        const budget = this.collector?.getBudgetStatus();
        const lastDuration = this.collector?.getLastCollectionDurationMs() ?? 0;
        return {
            running: this.running,
            currentIntervalMs: this.collector?.getPollingIntervalMs() ?? 0,
            nextCollectionAt: this.nextCollectionAt?.toISOString() ?? null,
            lastCollectionAt: this.lastCollectionAt?.toISOString() ?? null,
            lastCollectionDurationMs: lastDuration,
            requestBudget: budget
                ? {
                    used: budget.used,
                    limit: budget.limit,
                    remaining: budget.remaining,
                    windowResetsAt: new Date(budget.resetsAt).toISOString(),
                }
                : { used: 0, limit: 0, remaining: 0, windowResetsAt: new Date().toISOString() },
            hysteresisState: pollingState
                ? {
                    consecutiveBelowThreshold: pollingState.consecutiveBelowThreshold,
                    currentTier: pollingState.currentTier,
                }
                : { consecutiveBelowThreshold: 0, currentTier: 'unknown' },
        };
    }
    /**
     * Get migration status for the /quota/migration endpoint.
     */
    getMigrationStatus() {
        if (!this.migrator) {
            return {
                status: 'not_configured',
                currentMigration: null,
                history: [],
                config: { enabled: false, fiveHourThreshold: 0, weeklyThreshold: 0, cooldownMinutes: 0 },
                cooldownUntil: null,
            };
        }
        const status = this.migrator.getMigrationStatus();
        const thresholds = this.migrator.getThresholds();
        // Derive cooldownUntil from last migration completion + cooldown threshold
        let cooldownUntil = null;
        if (status.lastMigration?.completedAt) {
            const expiresAt = new Date(status.lastMigration.completedAt).getTime() + thresholds.cooldownMs;
            if (expiresAt > Date.now()) {
                cooldownUntil = new Date(expiresAt).toISOString();
            }
        }
        return {
            status: status.state,
            currentMigration: status.inProgress ? status.lastMigration : null,
            history: status.history,
            config: {
                enabled: true,
                fiveHourThreshold: thresholds.fiveHourPercent,
                weeklyThreshold: thresholds.weeklyPercent,
                cooldownMinutes: Math.round(thresholds.cooldownMs / 60000),
            },
            cooldownUntil,
        };
    }
    /**
     * Manually trigger a migration (for the POST /quota/migration/trigger endpoint).
     */
    async triggerMigration(options) {
        if (!this.migrator) {
            return { triggered: false, reason: 'Migration not configured (no SessionMigrator)' };
        }
        if (this.migrator.isMigrating()) {
            return { triggered: false, reason: 'Migration already in progress' };
        }
        const state = this.tracker.getState();
        if (!state) {
            return { triggered: false, reason: 'No quota data available' };
        }
        try {
            const triggered = await this.migrator.checkAndMigrate({
                percentUsed: state.usagePercent,
                fiveHourPercent: state.fiveHourPercent ?? undefined,
                activeAccountEmail: state.accounts?.find(a => a.isActive)?.email ?? null,
            });
            return {
                triggered,
                reason: triggered ? 'Migration started' : 'Thresholds not met or in cooldown',
            };
        }
        catch (err) {
            return {
                triggered: false,
                reason: `Migration error: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
}
//# sourceMappingURL=QuotaManager.js.map