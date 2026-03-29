/**
 * CaffeinateManager - Prevent macOS system sleep for Instar server lifetime.
 *
 * Maintains a `caffeinate -s` child process that prevents system sleep.
 * A watchdog verifies it's alive every 30s and restarts if dead.
 * PID is written to <stateDir>/caffeinate.pid for crash recovery.
 *
 * Only activates on macOS (process.platform === 'darwin').
 * Uses EventEmitter pattern consistent with Instar conventions.
 */
import { EventEmitter } from 'node:events';
export interface CaffeinateManagerConfig {
    /** State directory for PID file storage */
    stateDir: string;
}
export interface CaffeinateStatus {
    running: boolean;
    pid: number | null;
    startedAt: string | null;
    restartCount: number;
    lastWatchdogCheck: string;
}
export declare class CaffeinateManager extends EventEmitter {
    private process;
    private watchdogInterval;
    private pid;
    private startedAt;
    private restartCount;
    private lastWatchdogCheck;
    private stopping;
    private pidFile;
    constructor(config: CaffeinateManagerConfig);
    /**
     * Start caffeinate and the watchdog.
     * Only activates on macOS.
     */
    start(): void;
    /**
     * Stop caffeinate and the watchdog cleanly.
     */
    stop(): void;
    getStatus(): CaffeinateStatus;
    private spawnCaffeinate;
    private killCaffeinate;
    private watchdog;
    private cleanupStale;
    private writePidFile;
    private removePidFile;
}
//# sourceMappingURL=CaffeinateManager.d.ts.map