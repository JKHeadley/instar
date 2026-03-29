/**
 * TelemetryHeartbeat — Opt-in anonymous usage telemetry for Instar.
 *
 * Two telemetry channels:
 *   1. Heartbeat (legacy) — Basic version/uptime/usage counts
 *   2. Baseline — Rich job metrics for cross-agent intelligence
 *
 * Both are default OFF. No PII. No conversation content. Agent owners opt in explicitly.
 *
 * What is NEVER sent:
 *   - Agent names, prompts, or configuration
 *   - Conversation content or memory data
 *   - File paths, environment variables, or secrets
 *   - IP addresses (not logged server-side)
 *   - Security-posture feature flags
 */
import { EventEmitter } from 'node:events';
import type { TelemetryConfig, TelemetryLevel, BaselineSubmission } from '../core/types.js';
import { TelemetryAuth } from './TelemetryAuth.js';
import type { TelemetryCollector } from './TelemetryCollector.js';
export interface TelemetryHeartbeatConfig {
    enabled: boolean;
    level: TelemetryLevel;
    intervalMs: number;
    endpoint: string;
    stateDir: string;
    projectDir: string;
    version: string;
}
export interface HeartbeatPayload {
    v: number;
    id: string;
    ts: string;
    instar: string;
    node: string;
    os: string;
    arch: string;
    agents: number;
    uptime_hours: number;
    jobs_run_24h?: number;
    sessions_spawned_24h?: number;
    skills_invoked_24h?: number;
}
interface UsageCounters {
    jobsRun: number;
    sessionsSpawned: number;
    skillsInvoked: number;
    lastReset: number;
}
export declare class TelemetryHeartbeat extends EventEmitter {
    private config;
    private interval;
    private baselineInterval;
    private installId;
    private startTime;
    private counters;
    private agentCountFn;
    private auth;
    private collector;
    private lastBaselineSubmission;
    private lastBaselineError;
    private consentChecker;
    constructor(telemetryConfig: TelemetryConfig, stateDir: string, projectDir: string, version: string);
    /**
     * Set the TelemetryCollector for Baseline submissions.
     * Must be called after construction when scheduler/ledger are available.
     */
    setCollector(collector: TelemetryCollector): void;
    /**
     * Set a consent checker for Baseline submissions.
     * When set, Baseline submissions only proceed if the checker returns true.
     * This integrates with the FeatureRegistry consent framework.
     */
    setConsentChecker(checker: () => boolean): void;
    /**
     * Start the periodic heartbeat and Baseline submission cycles.
     * Sends first heartbeat after a short delay (not immediately on boot).
     */
    start(): void;
    stop(): void;
    /**
     * Register a function that returns the current agent count.
     * Called lazily at heartbeat time.
     */
    setAgentCountProvider(fn: () => number): void;
    recordJobRun(): void;
    recordSessionSpawned(): void;
    recordSkillInvoked(): void;
    buildPayload(): HeartbeatPayload;
    sendHeartbeat(): Promise<boolean>;
    /**
     * Send a Baseline telemetry submission with HMAC signing.
     * Fire-and-forget — failure never affects agent operation.
     */
    sendBaselineSubmission(): Promise<boolean>;
    /**
     * Log full Baseline submission payload for user transparency.
     * 30-day rolling retention.
     */
    private logBaselineSubmission;
    /**
     * Remove submission log entries older than 30 days.
     */
    private rotateBaselineLog;
    /**
     * Get Baseline-specific status for the /telemetry/status endpoint.
     */
    getBaselineStatus(): {
        provisioned: boolean;
        installationIdPrefix: string | null;
        lastSubmission: string | null;
        nextWindow: string | null;
        lastErrorCode: string | null;
        hasCollector: boolean;
    };
    /**
     * Read the latest Baseline submission from the transparency log.
     */
    getLatestBaselineSubmission(): {
        timestamp: string;
        payload: BaselineSubmission;
        endpoint: string;
        responseStatus: number;
    } | null;
    /**
     * Read all Baseline submissions from the transparency log.
     */
    getBaselineSubmissions(limit?: number, offset?: number): Array<{
        timestamp: string;
        payload: BaselineSubmission;
        endpoint: string;
        responseStatus: number;
    }>;
    /**
     * Get the TelemetryAuth instance (for enable/disable operations).
     */
    getAuth(): TelemetryAuth;
    /**
     * Compute a stable, anonymous installation ID.
     * Hash of machine ID + project directory = unique per install, not reversible.
     */
    private computeInstallId;
    private getMachineId;
    /**
     * Log heartbeats locally so users can verify exactly what's being sent.
     * Transparency is a core design principle.
     */
    private logHeartbeat;
    getStatus(): {
        enabled: boolean;
        level: TelemetryLevel;
        installId: string;
        intervalMs: number;
        endpoint: string;
        counters: UsageCounters;
        baseline: ReturnType<TelemetryHeartbeat['getBaselineStatus']>;
    };
}
export {};
//# sourceMappingURL=TelemetryHeartbeat.d.ts.map