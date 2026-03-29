/**
 * Detects macOS/Linux sleep/wake events via timer drift.
 *
 * When the system sleeps, setInterval timers stop. On wake, the
 * time elapsed between ticks will be much larger than expected.
 * We detect this drift and fire a callback.
 *
 * Ported from Dawn's infrastructure — battle-tested in production.
 */
import { EventEmitter } from 'node:events';
export interface SleepWakeDetectorConfig {
    /** How often to check for drift (ms). Default: 2000 */
    checkIntervalMs?: number;
    /** How much drift (ms) indicates a sleep event. Default: 10000 */
    driftThresholdMs?: number;
}
export interface WakeEvent {
    sleepDurationSeconds: number;
    timestamp: string;
}
export declare class SleepWakeDetector extends EventEmitter {
    private interval;
    private lastTick;
    private checkIntervalMs;
    private driftThresholdMs;
    private wakeHistory;
    constructor(config?: SleepWakeDetectorConfig);
    start(): void;
    stop(): void;
    /** Get wake event stats for telemetry reporting. */
    getStats(sinceMs?: number): {
        wakeCount: number;
        totalSleepSeconds: number;
        longestSleepSeconds: number;
    };
}
//# sourceMappingURL=SleepWakeDetector.d.ts.map