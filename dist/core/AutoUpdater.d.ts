/**
 * Auto Updater — built-in periodic update mechanism.
 *
 * Runs inside the server process (no Claude session needed).
 * Periodically checks for updates, auto-applies when available,
 * notifies via Telegram, and handles server restart.
 *
 * This replaces the heavyweight prompt-based update-check job.
 * Updates should never depend on the job scheduler — they're
 * core infrastructure that must run independently.
 *
 * Flow:
 *   check → apply → migrate → notify → restart
 *
 * Restart strategy:
 *   After npm update replaces the CLI on disk, spawn a replacement
 *   server process and exit. The new process binds to the port after
 *   the old one releases it during shutdown.
 */
import type { UpdateChecker } from './UpdateChecker.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { StateManager } from './StateManager.js';
import type { LiveConfig } from '../config/LiveConfig.js';
import type { SessionManagerLike, SessionMonitorLike } from './UpdateGate.js';
export interface AutoUpdaterConfig {
    /** How often to check for updates, in minutes. Default: 30 */
    checkIntervalMinutes?: number;
    /** Whether to auto-apply updates. Default: true */
    autoApply?: boolean;
    /** Telegram topic ID for update notifications (uses Agent Attention if not set) */
    notificationTopicId?: number;
    /** Whether to auto-restart after applying an update. Default: true */
    autoRestart?: boolean;
    /** Delay before applying an update, in minutes. Allows coalescing rapid-fire publishes. Default: 5 */
    applyDelayMinutes?: number;
    /** Seconds to wait after sending pre-restart notification before actually restarting. Default: 60 */
    preRestartDelaySecs?: number;
    /**
     * Preferred restart window (24h format, local time). When set, restarts only
     * happen during this window unless triggered manually via POST /updates/apply.
     * Updates are still downloaded immediately — only the restart is deferred.
     * Example: { start: "02:00", end: "05:00" }
     */
    restartWindow?: {
        start: string;
        end: string;
    } | null;
}
export interface AutoUpdaterStatus {
    /** Whether the auto-updater is running */
    running: boolean;
    /** Last time we checked for updates */
    lastCheck: string | null;
    /** Last time we applied an update */
    lastApply: string | null;
    /** The version that was last successfully applied */
    lastAppliedVersion: string | null;
    /** Current configuration */
    config: Required<AutoUpdaterConfig>;
    /** Any pending update that hasn't been applied yet */
    pendingUpdate: string | null;
    /** Last error if any */
    lastError: string | null;
    /** ISO timestamp: coalescing timer expires at this time (null = not coalescing) */
    coalescingUntil: string | null;
    /** ISO timestamp: when the pending update was first detected */
    pendingUpdateDetectedAt: string | null;
    /** Whether restart is being deferred for active sessions */
    deferralReason: string | null;
    /** How long we've been deferring, in minutes */
    deferralElapsedMinutes: number;
    /** Max deferral before forced restart */
    maxDeferralHours: number;
}
export declare class AutoUpdater {
    private updateChecker;
    private telegram;
    private state;
    private config;
    private interval;
    private lastCheck;
    private lastApply;
    private lastAppliedVersion;
    private lastError;
    private pendingUpdate;
    private isApplying;
    private stateDir;
    private stateFile;
    private liveConfig;
    private applyTimer;
    private pendingUpdateDetectedAt;
    private coalescingUntil;
    private gate;
    private sessionManager;
    private sessionMonitor;
    private deferralTimer;
    private notifiedVersionMismatch;
    private lastNotifiedRestartVersion;
    private lastRestartRequestedAt;
    private lastRestartRequestedVersion;
    private isNpxCached;
    constructor(updateChecker: UpdateChecker, state: StateManager, stateDir: string, config?: AutoUpdaterConfig, telegram?: TelegramAdapter | null, liveConfig?: LiveConfig | null);
    /**
     * Start the periodic update checker.
     * Idempotent — calling start() when already running is a no-op.
     */
    start(): void;
    /**
     * Stop the periodic checker.
     */
    stop(): void;
    /**
     * Get current auto-updater status.
     */
    getStatus(): AutoUpdaterStatus;
    /**
     * Set the Telegram adapter (may be wired after construction).
     */
    setTelegram(telegram: TelegramAdapter): void;
    /**
     * Set session dependencies for session-aware restart gating.
     * May be wired after construction (like Telegram).
     */
    setSessionDeps(sessionManager: SessionManagerLike, sessionMonitor?: SessionMonitorLike | null): void;
    /**
     * Re-read dynamic config values from disk via LiveConfig.
     * Sessions or external edits may have changed them since startup.
     *
     * Uses LiveConfig if available (the preferred path), falls back to
     * direct file read for backward compatibility.
     */
    private reloadDynamicConfig;
    /**
     * One tick of the update loop.
     * Check → detect update → start coalescing timer → apply after delay.
     *
     * The coalescing timer handles rapid-fire publishes: if 0.9.74, 0.9.75,
     * and 0.9.76 are published within 10 minutes, we apply only 0.9.76.
     * Each new version resets the timer.
     */
    private tick;
    /**
     * Apply the pending update after coalescing delay.
     * Extracted from tick() so it can be called by the coalescing timer
     * and by manual trigger (POST /updates/apply).
     */
    applyPendingUpdate(options?: {
        bypassWindow?: boolean;
    }): Promise<void>;
    /**
     * Check if the current local time is within the configured restart window.
     * Returns true if no window is configured (restart anytime).
     */
    private isInRestartWindow;
    /**
     * Calculate milliseconds until the start of the next restart window.
     */
    private msUntilRestartWindow;
    /**
     * Attempt restart with session-aware gating.
     * If sessions are active, defers and retries on a timer.
     * After max deferral, restarts regardless with warnings.
     */
    private gatedRestart;
    /**
     * Request a restart from the supervisor by writing a signal file.
     *
     * The AutoUpdater's job ends here — the supervisor handles the actual restart.
     * This eliminates the entire category of self-restart bugs (PATH mismatch,
     * launchd confusion, binary resolution failures, restart loops).
     *
     * Signal file: state/restart-requested.json
     * The supervisor polls this file during health checks and performs the restart.
     *
     * If no supervisor is running (standalone foreground mode), the server logs
     * a notice that a restart is needed. This is strictly better than attempting
     * self-restart, which can loop or leave the port bound.
     */
    private requestRestart;
    /**
     * Send a notification via Telegram (if configured).
     * Falls back to console logging if Telegram is not available.
     */
    private notify;
    /**
     * Get the topic ID for update notifications.
     * Prefers the dedicated Agent Updates topic (informational), falls back to Agent Attention.
     */
    private getNotificationTopicId;
    private loadState;
    private saveState;
}
//# sourceMappingURL=AutoUpdater.d.ts.map