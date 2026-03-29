/**
 * Lifeline Probe — Tier 1 (Core Survival)
 *
 * Verifies the lifeline process (crash recovery) is alive and functional.
 * Checks the supervisor, queue, and lock file without modifying state.
 */
import type { Probe } from '../SystemReviewer.js';
export interface LifelineProbeDeps {
    /** Get supervisor status */
    getSupervisorStatus: () => {
        running: boolean;
        healthy: boolean;
        restartAttempts: number;
        lastHealthy: number;
        coolingDown: boolean;
        cooldownRemainingMs: number;
        circuitBroken: boolean;
        totalFailures: number;
        lastCrashOutput: string;
        circuitBreakerRetryCount: number;
        maxCircuitBreakerRetries: number;
        inMaintenanceWait: boolean;
        maintenanceWaitElapsedMs: number;
    };
    /** Get current queue length */
    getQueueLength: () => number;
    /** Peek at queued messages (non-destructive) */
    peekQueue: () => Array<{
        id: string;
        timestamp: string;
    }>;
    /** Path to the lifeline lock file */
    lockFilePath: string;
    /** Whether lifeline mode is enabled */
    isEnabled: () => boolean;
}
export declare function createLifelineProbes(deps: LifelineProbeDeps): Probe[];
//# sourceMappingURL=LifelineProbe.d.ts.map