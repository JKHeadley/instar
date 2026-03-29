/**
 * Coherence Monitor — runtime self-awareness for agent infrastructure.
 *
 * Prevention stops bugs we've seen. Homeostasis stops bugs we haven't seen yet.
 *
 * This monitor periodically checks the agent's own state for coherence:
 *   1. Config Coherence — do in-memory values match disk?
 *   2. State Durability — did runtime changes survive the last restart?
 *   3. Output Sanity — is user-facing output valid?
 *   4. Feature Readiness — are all expected features properly configured?
 *
 * Where possible, it self-corrects. Where it can't, it notifies.
 * The goal: converge toward natural self-led homeostasis.
 *
 * Integrates with HealthChecker via ComponentHealth results.
 */
import { EventEmitter } from 'node:events';
import type { LiveConfig } from '../config/LiveConfig.js';
import type { ComponentHealth } from '../core/types.js';
export interface CoherenceCheckResult {
    /** Check name */
    name: string;
    /** Did it pass? */
    passed: boolean;
    /** Human-readable description */
    message: string;
    /** Was the issue self-corrected? */
    corrected?: boolean;
    /** Correction details */
    correctionDetail?: string;
}
export interface CoherenceReport {
    /** When the check was run */
    timestamp: string;
    /** Overall status */
    status: 'coherent' | 'corrected' | 'incoherent';
    /** Individual check results */
    checks: CoherenceCheckResult[];
    /** Summary counts */
    passed: number;
    failed: number;
    corrected: number;
}
export interface CoherenceMonitorConfig {
    /** State directory (.instar/) */
    stateDir: string;
    /** LiveConfig instance for dynamic config checking */
    liveConfig: LiveConfig;
    /** Check interval in ms. Default: 300_000 (5 minutes) */
    checkIntervalMs?: number;
    /** Port the server is running on */
    port?: number;
    /** Notification callback — fires when an incoherence can't be self-corrected */
    onIncoherence?: (report: CoherenceReport) => void;
}
export declare class CoherenceMonitor extends EventEmitter {
    private config;
    private interval;
    private lastReport;
    private correctionLog;
    /** Track which failure signatures have already been notified (signature → timestamp ms) */
    private notifiedFailures;
    /** Don't re-notify about the same failure within this window */
    private static readonly NOTIFY_COOLDOWN_MS;
    constructor(config: CoherenceMonitorConfig);
    /**
     * Start periodic coherence monitoring.
     */
    start(): void;
    /**
     * Stop monitoring.
     */
    stop(): void;
    /**
     * Run all coherence checks and return a report.
     */
    runCheck(): CoherenceReport;
    /**
     * Get the last coherence report.
     */
    getLastReport(): CoherenceReport | null;
    /**
     * Get ComponentHealth for integration with HealthChecker.
     */
    getHealth(): ComponentHealth;
    /**
     * Get correction history.
     */
    getCorrectionLog(): Array<{
        timestamp: string;
        check: string;
        detail: string;
    }>;
    /**
     * Check 0: Process Integrity
     * Is this process running the code it claims to be running?
     * Detects the "stale process" bug where npm install -g updates the binary
     * on disk but the running process still has old code in memory.
     */
    private checkProcessIntegrity;
    /**
     * Check 0b: Shadow Installation Detection
     * Is there a local node_modules/instar that shadows the global binary?
     * The Luna Incident (v0.9.70): a local `npm install instar` created a shadow
     * that prevented auto-updates from taking effect. Detect this at runtime.
     */
    private checkShadowInstallation;
    /**
     * Check 1: Config Coherence
     * Do in-memory config values match what's on disk?
     */
    private checkConfigCoherence;
    /**
     * Check 2: State Durability
     * Did runtime changes survive restarts? Are state files intact?
     */
    private checkStateDurability;
    /**
     * Check 3: Output Sanity
     * Scan recent agent messages for known-bad patterns.
     */
    private checkOutputSanity;
    /**
     * Check 4: Feature Readiness
     * Verify features that should be configured actually are.
     */
    private checkFeatureReadiness;
    /** Read the AutoUpdater state file to check if a restart is already pending. */
    private readAutoUpdaterState;
    private logCorrection;
    private persistReport;
}
//# sourceMappingURL=CoherenceMonitor.d.ts.map