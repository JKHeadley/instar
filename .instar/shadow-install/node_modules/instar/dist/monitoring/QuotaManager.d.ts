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
import type { QuotaTracker } from './QuotaTracker.js';
import type { QuotaCollector, CollectionResult } from './QuotaCollector.js';
import type { SessionMigrator } from './SessionMigrator.js';
import type { QuotaNotifier } from './QuotaNotifier.js';
import type { AccountSwitcher } from './AccountSwitcher.js';
import { SessionCredentialManager } from './SessionCredentialManager.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { JobScheduler } from '../scheduler/JobScheduler.js';
export interface QuotaThresholdEvent {
    level: 'warning' | 'critical' | 'limit';
    metric: 'weekly' | 'fiveHour';
    value: number;
    threshold: number;
    account: string;
    dataSource: 'oauth' | 'jsonl-fallback';
    timestamp: string;
}
export interface QuotaMigrationEvent {
    type: 'started' | 'complete' | 'failed' | 'partial' | 'no_target';
    sourceAccount: string;
    targetAccount?: string;
    sessionsAffected: number;
    error?: string;
    duration?: number;
    timestamp: string;
}
export interface AccountSwitchEvent {
    fromAccount: string;
    toAccount: string;
    reason: 'migration' | 'manual';
    sessionsReassigned: string[];
    timestamp: string;
}
export interface PollingStatus {
    running: boolean;
    currentIntervalMs: number;
    nextCollectionAt: string | null;
    lastCollectionAt: string | null;
    lastCollectionDurationMs: number;
    requestBudget: {
        used: number;
        limit: number;
        remaining: number;
        windowResetsAt: string;
    };
    hysteresisState: {
        consecutiveBelowThreshold: number;
        currentTier: string;
    };
}
export interface QuotaManagerConfig {
    stateDir: string;
    /** Enable the collector-driven adaptive polling loop (default: true) */
    adaptivePolling?: boolean;
    /** If true, migration check runs after each collection (default: true) */
    autoMigrate?: boolean;
    /** Allow JSONL-estimated data to trigger migration (default: false) */
    jsonlCanTriggerMigration?: boolean;
}
export declare class QuotaManager extends EventEmitter {
    readonly tracker: QuotaTracker;
    readonly collector: QuotaCollector | null;
    readonly switcher: AccountSwitcher | null;
    readonly migrator: SessionMigrator | null;
    readonly notifier: QuotaNotifier;
    readonly credentialManager: SessionCredentialManager;
    private config;
    private pollingTimer;
    private running;
    private lastCollectionAt;
    private nextCollectionAt;
    private pendingNotifications;
    private notificationRetryTimer;
    private sendNotification;
    private sessionManager;
    private scheduler;
    constructor(config: QuotaManagerConfig, components: {
        tracker: QuotaTracker;
        collector?: QuotaCollector | null;
        switcher?: AccountSwitcher | null;
        migrator?: SessionMigrator | null;
        notifier: QuotaNotifier;
        credentialManager?: SessionCredentialManager;
    });
    /**
     * Set the SessionManager for wiring migrator deps.
     */
    setSessionManager(sm: SessionManager): void;
    /**
     * Set the JobScheduler for spawn gating and migration respawns.
     * Also replaces scheduler.canRunJob with quota-aware version.
     */
    setScheduler(sched: JobScheduler): void;
    /**
     * Set the notification send function (e.g., Telegram relay).
     */
    setNotificationSender(fn: (message: string) => Promise<void>): void;
    /**
     * Wire migrator deps once both sessionManager and scheduler are available.
     */
    private wireMigratorDeps;
    /**
     * Start the adaptive polling loop. Collector drives the interval.
     */
    start(): void;
    /**
     * Stop polling and clean up.
     */
    stop(): void;
    /**
     * Force an immediate collection + migration check + notification check.
     */
    refresh(): Promise<CollectionResult | null>;
    /**
     * Check if a session can be spawned at a given priority.
     * Considers both quota thresholds and migration state.
     *
     * Order matters: check quota thresholds FIRST, then migration state.
     * A stale migration state (e.g., from a crash) should not block jobs
     * when quota is healthy. Migration is a quota-saving measure — if
     * quota is fine, migration concerns are irrelevant.
     */
    canSpawnSession(priority?: string): {
        allowed: boolean;
        reason: string;
    };
    private scheduleNextCollection;
    /**
     * Fallback: when no collector, poll the tracker file every 5 minutes.
     */
    private scheduleTrackerPoll;
    private runCollectionCycle;
    private postCollectionChecks;
    private emitThresholdEvents;
    private enqueueNotification;
    private processNotificationRetries;
    /**
     * Get polling status for the /quota/polling endpoint.
     */
    getPollingStatus(): PollingStatus;
    /**
     * Get migration status for the /quota/migration endpoint.
     */
    getMigrationStatus(): {
        status: "not_configured";
        currentMigration: null;
        history: never[];
        config: {
            enabled: boolean;
            fiveHourThreshold: number;
            weeklyThreshold: number;
            cooldownMinutes: number;
        };
        cooldownUntil: null;
    } | {
        status: import("./SessionMigrator.js").MigrationState | null;
        currentMigration: import("./SessionMigrator.js").MigrationEvent | null;
        history: import("./SessionMigrator.js").MigrationEvent[];
        config: {
            enabled: boolean;
            fiveHourThreshold: number;
            weeklyThreshold: number;
            cooldownMinutes: number;
        };
        cooldownUntil: string | null;
    };
    /**
     * Manually trigger a migration (for the POST /quota/migration/trigger endpoint).
     */
    triggerMigration(options?: {
        targetAccount?: string;
        bypassCooldown?: boolean;
    }): Promise<{
        triggered: boolean;
        reason?: string;
    }>;
}
//# sourceMappingURL=QuotaManager.d.ts.map