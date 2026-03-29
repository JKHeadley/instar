/**
 * SessionMigrator — Orchestrates session halt, account switch, and restart
 * when quota approaches reserve thresholds.
 *
 * Ported from Dawn's dawn-server equivalent for general Instar use.
 * Adapted to use Instar's SessionManager, StateManager, and EventEmitter.
 *
 * Migration flow:
 * 1. Pause scheduler (prevent new spawns)
 * 2. Find best alternative account
 * 3. Gracefully halt running sessions (Ctrl+C → wait → kill)
 * 4. Switch account credentials
 * 5. Restart halted sessions on new account
 * 6. Resume scheduler
 *
 * Part of the Instar Quota Migration spec (Phase 3).
 */
import { EventEmitter } from 'node:events';
export interface MigrationThresholds {
    /** 5-hour rate limit trigger (default 88%) */
    fiveHourPercent: number;
    /** Weekly budget trigger (default 92%) */
    weeklyPercent: number;
    /** Cooldown between migrations in ms (default 10 min) */
    cooldownMs: number;
    /** Minimum weekly headroom required on target account (default 20) */
    minimumHeadroom: number;
    /** Grace period for session shutdown in ms (default 5000) */
    gracePeriodMs: number;
}
export interface MigrationEvent {
    triggeredAt: string;
    reason: string;
    previousAccount: string | null;
    newAccount: string | null;
    sessionsHalted: string[];
    sessionsRestarted: string[];
    result: 'success' | 'partial' | 'failed' | 'no_alternative' | 'rolled_back' | 'enforced_pause' | 'enforced_kill';
    completedAt: string;
    durationMs: number;
    error?: string;
}
export interface MigrationState {
    status: 'idle' | 'halting' | 'switching' | 'restarting' | 'complete' | 'failed' | 'rolling_back';
    startedAt?: string;
    sourceAccount: string;
    targetAccount: string;
    haltedSessions: Array<{
        sessionId: string;
        jobSlug: string;
        haltedAt: string;
    }>;
    restartedSessions: Array<{
        sessionId: string;
        jobSlug: string;
        startedAt: string;
    }>;
    error?: string;
}
export interface MigrationHistory {
    lastMigration: MigrationEvent | null;
    migrations: MigrationEvent[];
}
export interface AccountSnapshot {
    email: string;
    name: string | null;
    isActive: boolean;
    hasToken: boolean;
    tokenExpired: boolean;
    isStale: boolean;
    weeklyPercent: number;
    fiveHourPercent: number | null;
    weeklyResetsAt?: string | null;
}
export interface HaltableSession {
    id: string;
    tmuxSession: string;
    jobSlug?: string;
    name: string;
}
/** Callbacks for integration with JobScheduler and SessionManager */
export interface SessionMigratorDeps {
    /** List running sessions that can be halted */
    listRunningSessions: () => HaltableSession[];
    /** Send Ctrl+C to a session for graceful shutdown */
    sendKey: (tmuxSession: string, key: string) => boolean;
    /** Kill a session by its ID */
    killSession: (sessionId: string) => boolean;
    /** Check if a session is still alive */
    isSessionAlive: (tmuxSession: string) => boolean;
    /** Pause the scheduler to prevent new spawns */
    pauseScheduler: () => void;
    /** Resume the scheduler */
    resumeScheduler: () => void;
    /** Respawn a job by slug */
    respawnJob: (slug: string) => Promise<void>;
    /** Get all account statuses from the account switcher */
    getAccountStatuses: () => AccountSnapshot[];
    /** Switch to a target account */
    switchAccount: (email: string) => Promise<{
        success: boolean;
        message: string;
    }>;
}
export interface SessionMigratorConfig {
    /** Directory for state persistence (migration state, lock file, history) */
    stateDir: string;
    /** Migration thresholds (all optional, has defaults) */
    thresholds?: Partial<MigrationThresholds>;
}
export interface SessionMigratorEvents {
    /** Migration started */
    migration_started: [event: {
        reason: string;
        sourceAccount: string;
        targetAccount: string;
    }];
    /** Migration completed successfully */
    migration_complete: [event: MigrationEvent];
    /** Migration partially succeeded (some sessions failed to restart) */
    migration_partial: [event: MigrationEvent];
    /** Migration failed */
    migration_failed: [event: MigrationEvent];
    /** No alternative account available */
    migration_no_target: [event: {
        reason: string;
        sourceAccount: string;
    }];
    /** Quota enforcement: sessions warned to pause (90%+) */
    enforced_pause: [event: {
        reason: string;
        fiveHourPercent: number;
        sessionsSignaled: number;
    }];
    /** Quota enforcement: all sessions killed (95%+) */
    enforced_kill: [event: {
        reason: string;
        fiveHourPercent: number;
        sessionsKilled: string[];
    }];
    /** Migration was rolled back */
    migration_rollback: [event: MigrationEvent];
    /** State changed (for external monitoring) */
    state_changed: [state: MigrationState];
}
export declare class SessionMigrator extends EventEmitter {
    private deps;
    private thresholds;
    private stateDir;
    private lockPath;
    private statePath;
    private historyPath;
    private migrationState;
    constructor(config: SessionMigratorConfig);
    /**
     * Set dependencies for integration with SessionManager and JobScheduler.
     * Must be called before checkAndMigrate().
     */
    setDeps(deps: SessionMigratorDeps): void;
    /**
     * Main entry point — called after each quota refresh.
     * Checks if migration is needed and triggers it if so.
     */
    checkAndMigrate(quotaState: {
        percentUsed: number;
        fiveHourPercent?: number | null;
        activeAccountEmail?: string | null;
    }): Promise<boolean>;
    /**
     * Determine if migration should be triggered.
     */
    private shouldMigrate;
    /**
     * Execute the full migration flow with rollback support.
     */
    private executeMigration;
    /**
     * Gracefully halt running sessions:
     * 1. Send Ctrl+C to each session
     * 2. Wait grace period for them to flush state
     * 3. Kill any that are still alive
     */
    private haltRunningSessions;
    /**
     * Rollback: restart sessions on the original account after a failed switch.
     */
    private rollbackRestartSessions;
    /**
     * Select the best account to migrate to.
     *
     * Algorithm:
     * 1. Filter: Exclude stale, expired, current, and accounts without tokens
     * 2. Filter: Must have minimum headroom (default 20%)
     * 3. Score: 100 - weeklyPercent (lower usage = higher score)
     * 4. Tiebreak: Prefer account with later weeklyResetsAt
     */
    selectMigrationTarget(): AccountSnapshot | null;
    private acquireLock;
    private releaseLock;
    /**
     * On startup, check for incomplete migration state.
     * If found, attempt rollback by restarting halted sessions on the source account.
     */
    private recoverFromCrash;
    /**
     * Called after deps are set to complete crash recovery if needed.
     * Should be called once after setDeps().
     */
    completeRecovery(): Promise<void>;
    private saveMigrationState;
    private loadMigrationState;
    private loadHistory;
    private recordMigration;
    /**
     * Get current migration status for API/monitoring.
     */
    getMigrationStatus(): {
        inProgress: boolean;
        state: MigrationState | null;
        lastMigration: MigrationEvent | null;
        history: MigrationEvent[];
        config: MigrationThresholds;
    };
    /**
     * Is migration currently in progress?
     */
    isMigrating(): boolean;
    /**
     * Get thresholds (for external monitoring/display).
     */
    getThresholds(): MigrationThresholds;
    private sleep;
}
//# sourceMappingURL=SessionMigrator.d.ts.map