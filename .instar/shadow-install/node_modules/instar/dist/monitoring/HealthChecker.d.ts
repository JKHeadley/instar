/**
 * Health Checker — aggregates component health into a single status.
 *
 * Checks tmux availability, session state, scheduler health,
 * and disk space. Returns a HealthStatus object.
 */
import type { SessionManager } from '../core/SessionManager.js';
import type { JobScheduler } from '../scheduler/JobScheduler.js';
import type { HealthStatus, InstarConfig } from '../core/types.js';
import type { SessionWatchdog } from './SessionWatchdog.js';
import type { StallTriageNurse } from './StallTriageNurse.js';
import type { MemoryPressureMonitor } from './MemoryPressureMonitor.js';
export declare class HealthChecker {
    private config;
    private sessionManager;
    private scheduler;
    private watchdog;
    private triageNurse;
    private memoryMonitor;
    private checkInterval;
    private lastStatus;
    constructor(config: InstarConfig, sessionManager: SessionManager, scheduler?: JobScheduler | null, watchdog?: SessionWatchdog | null, triageNurse?: StallTriageNurse | null, memoryMonitor?: MemoryPressureMonitor | null);
    /**
     * Run all health checks and return aggregated status.
     */
    check(): HealthStatus;
    /**
     * Get the last computed health status without re-checking.
     */
    getLastStatus(): HealthStatus | null;
    /**
     * Start periodic health checks.
     */
    startPeriodicChecks(intervalMs?: number): void;
    /**
     * Stop periodic health checks.
     */
    stopPeriodicChecks(): void;
    private checkTmux;
    private checkSessions;
    private checkScheduler;
    private checkMemory;
    private checkStateDir;
}
//# sourceMappingURL=HealthChecker.d.ts.map