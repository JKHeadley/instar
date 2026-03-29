/**
 * SessionWatchdog — Auto-remediation for stuck Claude sessions (Instar port).
 *
 * Detects when a Claude session has a long-running bash command and escalates
 * from gentle (Ctrl+C) to forceful (SIGKILL + session kill). Adapted from
 * Dawn Server's SessionWatchdog for Instar's self-contained architecture.
 *
 * Escalation pipeline:
 *   Level 0: Monitoring (default)
 *   Level 1: Ctrl+C via tmux send-keys
 *   Level 2: SIGTERM the stuck child PID
 *   Level 3: SIGKILL the stuck child PID
 *   Level 4: Kill tmux session
 */
import { EventEmitter } from 'node:events';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { InstarConfig, IntelligenceProvider } from '../core/types.js';
export declare enum EscalationLevel {
    Monitoring = 0,
    CtrlC = 1,
    SigTerm = 2,
    SigKill = 3,
    KillSession = 4
}
interface EscalationState {
    level: EscalationLevel;
    levelEnteredAt: number;
    stuckChildPid: number;
    stuckCommand: string;
    retryCount: number;
}
export interface InterventionEvent {
    sessionName: string;
    level: EscalationLevel;
    action: string;
    stuckCommand: string;
    stuckPid: number;
    timestamp: number;
    /** Outcome tracking — filled in after a delay */
    outcome?: 'recovered' | 'died' | 'unknown';
    /** Time in ms between intervention and outcome determination */
    outcomeDelayMs?: number;
}
/** Aggregated watchdog stats for telemetry */
export interface WatchdogStats {
    interventionsTotal: number;
    interventionsByLevel: Record<string, number>;
    recoveries: number;
    sessionDeaths: number;
    outcomeUnknown: number;
    llmGateOverrides: number;
}
export interface WatchdogEvents {
    intervention: [event: InterventionEvent];
    recovery: [sessionName: string, fromLevel: EscalationLevel];
}
export declare class SessionWatchdog extends EventEmitter {
    private config;
    private sessionManager;
    private state;
    private interval;
    private escalationState;
    private interventionHistory;
    private enabled;
    private running;
    private stuckThresholdMs;
    private pollIntervalMs;
    private logPath;
    /** Intelligence provider — gates escalation entry with LLM command analysis */
    intelligence: IntelligenceProvider | null;
    /** Temporarily exempted commands (LLM confirmed as legitimate long-running) */
    private temporaryExclusions;
    /** Counter for LLM gate overrides (said "legitimate") — for telemetry */
    private llmGateOverrides;
    /** Pending outcome checks — maps sessionName to intervention event */
    private pendingOutcomeChecks;
    constructor(config: InstarConfig, sessionManager: SessionManager, state: StateManager);
    start(): void;
    stop(): void;
    setEnabled(enabled: boolean): void;
    isEnabled(): boolean;
    isManaging(sessionName: string): boolean;
    getStatus(): {
        enabled: boolean;
        sessions: Array<{
            name: string;
            escalation: EscalationState | null;
        }>;
        interventionHistory: InterventionEvent[];
    };
    private poll;
    private checkSession;
    private handleEscalation;
    /**
     * LLM gate: Before entering escalation, ask whether the command is
     * legitimately long-running or actually stuck. This prevents the watchdog
     * from killing legitimate builds, installs, or data processing.
     *
     * Returns true if the command appears stuck and should be escalated.
     * Returns false if the LLM thinks it's a legitimate long-running task.
     * If no LLM is available, returns true (fail-open — stuck commands need recovery).
     */
    private isCommandStuck;
    private getClaudePid;
    private getChildProcesses;
    private isExcluded;
    private parseElapsed;
    private sendSignal;
    private isProcessAlive;
    private killTmuxSession;
    private recordIntervention;
    /**
     * Check session health 60s after an intervention.
     * Did the session recover (still producing output) or die?
     */
    private checkOutcome;
    /**
     * Append an event to the persistent JSONL log.
     * 30-day retention, auto-rotated.
     */
    private persistEvent;
    /**
     * Read persistent intervention log entries since a given time.
     */
    readLog(sinceMs?: number): InterventionEvent[];
    /**
     * Get aggregated watchdog stats for a time window.
     * Used by TelemetryCollector for Baseline submissions.
     */
    getStats(sinceMs?: number): WatchdogStats;
    /**
     * Rotate the persistent log — remove entries older than 30 days.
     */
    rotateLog(): void;
}
export {};
//# sourceMappingURL=SessionWatchdog.d.ts.map