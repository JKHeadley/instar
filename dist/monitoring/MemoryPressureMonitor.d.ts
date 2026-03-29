/**
 * MemoryPressureMonitor - Detect and respond to system memory pressure.
 *
 * Platform-aware: uses macOS `vm_stat` or Linux `/proc/meminfo`.
 * EventEmitter pattern consistent with Instar conventions.
 *
 * Thresholds:
 *   - normal   (< 60%): all operations allowed
 *   - warning  (60-75%): log trend, notify
 *   - elevated (75-90%): restrict session spawning
 *   - critical (90%+): block all spawns, alert
 *
 * Includes trend tracking via ring buffer + linear regression.
 */
import { EventEmitter } from 'node:events';
export type MemoryPressureState = 'normal' | 'warning' | 'elevated' | 'critical';
export type MemoryTrend = 'rising' | 'stable' | 'falling';
export interface MemoryState {
    pressurePercent: number;
    freeGB: number;
    totalGB: number;
    state: MemoryPressureState;
    trend: MemoryTrend;
    ratePerMin: number;
    lastChecked: string;
    stateChangedAt: string;
    platform: string;
}
export interface MemoryPressureMonitorConfig {
    /** Thresholds (percent). Defaults: warning=60, elevated=75, critical=90 */
    thresholds?: {
        warning?: number;
        elevated?: number;
        critical?: number;
    };
    /** Base check interval in ms. Default: 30000 */
    checkIntervalMs?: number;
    /** State directory for persisting thresholds across restarts */
    stateDir?: string;
}
export declare class MemoryPressureMonitor extends EventEmitter {
    private timeout;
    private currentState;
    private stateChangedAt;
    private lastChecked;
    private lastPressurePercent;
    private lastFreeGB;
    private lastTotalGB;
    private ringBuffer;
    private currentTrend;
    private currentRatePerMin;
    private thresholds;
    private baseIntervalMs;
    private stateDir;
    constructor(config?: MemoryPressureMonitorConfig);
    start(): void;
    stop(): void;
    /**
     * Update thresholds at runtime (e.g., when a user asks to adjust warning levels).
     * Re-classifies current state immediately after update.
     * Persists to disk so changes survive server restarts.
     */
    updateThresholds(thresholds: Partial<{
        warning: number;
        elevated: number;
        critical: number;
    }>): void;
    private get thresholdsFilePath();
    private persistThresholds;
    private loadPersistedThresholds;
    /**
     * Get current thresholds.
     */
    getThresholds(): {
        warning: number;
        elevated: number;
        critical: number;
    };
    getState(): MemoryState;
    /**
     * Can a new session be spawned?
     */
    canSpawnSession(): {
        allowed: boolean;
        reason?: string;
    };
    private scheduleNext;
    private check;
    private classifyState;
    /**
     * Read system memory — platform-aware.
     */
    private readSystemMemory;
    /**
     * macOS: parse vm_stat
     */
    private parseVmStat;
    /**
     * Linux: parse /proc/meminfo
     */
    private parseProcMeminfo;
    /**
     * Linear regression over recent readings.
     */
    private detectTrend;
}
//# sourceMappingURL=MemoryPressureMonitor.d.ts.map