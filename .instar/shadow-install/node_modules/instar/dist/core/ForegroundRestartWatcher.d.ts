/**
 * ForegroundRestartWatcher — Detects restart-requested signals in foreground mode.
 *
 * ROOT CAUSE (v0.9.71 investigation):
 * The AutoUpdater writes `restart-requested.json` after installing an update.
 * The ServerSupervisor (lifeline) polls this file and performs the restart.
 * BUT: when the server runs in `--foreground` mode (which ALL agents currently do),
 * there IS no supervisor — nobody picks up the restart signal, it expires after
 * the TTL, and the process runs forever on old code.
 *
 * This module fills that gap for foreground mode:
 * 1. Polls for `restart-requested.json` every 10 seconds (matching supervisor cadence)
 * 2. When detected: sends IMMEDIATE notification, logs loudly, exits cleanly
 * 3. The process exit allows the tmux session or wrapper to respawn
 *
 * This module is ONLY used in foreground mode. When a supervisor is running,
 * it handles restarts and this watcher should not be started.
 */
import { EventEmitter } from 'node:events';
export interface RestartRequest {
    requestedAt: string;
    requestedBy: string;
    targetVersion: string;
    previousVersion: string;
    plannedRestart?: boolean;
    expiresAt?: string;
    pid?: number;
}
export interface ForegroundRestartWatcherConfig {
    stateDir: string;
    /** Callback to send a notification before exiting. */
    onRestartDetected?: (request: RestartRequest) => void | Promise<void>;
    /** Poll interval in ms. Default: 10_000 (10 seconds). */
    pollIntervalMs?: number;
    /** Graceful shutdown delay in ms after notification. Default: 3_000 (3 seconds). */
    shutdownDelayMs?: number;
    /** If true, exit the process after detecting restart. Default: true. */
    exitOnRestart?: boolean;
    /** Process exit code. Default: 0. */
    exitCode?: number;
}
export declare class ForegroundRestartWatcher extends EventEmitter {
    private config;
    private interval;
    private flagPath;
    private isShuttingDown;
    constructor(config: ForegroundRestartWatcherConfig);
    start(): void;
    stop(): void;
    /**
     * Check for a restart-requested signal. If found and valid, trigger shutdown.
     */
    private check;
}
//# sourceMappingURL=ForegroundRestartWatcher.d.ts.map