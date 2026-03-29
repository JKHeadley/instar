/**
 * OrphanProcessReaper — Detect and clean up orphaned Claude processes.
 *
 * Addresses the critical gap where Claude processes spawned outside
 * SessionManager (setup-wizard, login flow, corrupted state) are invisible
 * to the watchdog and accumulate indefinitely.
 *
 * Classification strategy:
 *   1. "tracked" — In a tmux session managed by SessionManager → leave alone
 *   2. "instar-orphan" — In a tmux session matching project naming but not tracked → auto-clean
 *   3. "external" — Not in a project-prefixed tmux session (user's own Claude, VS Code, etc.) → report only
 *
 * Safety: NEVER auto-kills user Claude sessions outside Instar.
 * External processes are only reported via Telegram for user decision.
 */
import { EventEmitter } from 'node:events';
import type { SessionManager } from '../core/SessionManager.js';
import type { InstarConfig } from '../core/types.js';
export interface ClaudeProcess {
    pid: number;
    ppid: number;
    rssKB: number;
    elapsedMs: number;
    command: string;
    tmuxSession: string | null;
}
export type ProcessClassification = 'tracked' | 'instar-orphan' | 'external';
export interface ClassifiedProcess extends ClaudeProcess {
    classification: ProcessClassification;
    reason: string;
}
export interface ReaperReport {
    timestamp: string;
    tracked: ClassifiedProcess[];
    orphans: ClassifiedProcess[];
    external: ClassifiedProcess[];
    totalMemoryMB: number;
    orphanMemoryMB: number;
    externalMemoryMB: number;
    actionsPerformed: string[];
}
export interface OrphanReaperConfig {
    /** Poll interval in ms (default: 60000 — 1 minute) */
    pollIntervalMs?: number;
    /** Max age in ms before an orphan is auto-killed (default: 3600000 — 1 hour) */
    orphanMaxAgeMs?: number;
    /** Max age in ms before external processes are reported (default: 14400000 — 4 hours) */
    externalReportAgeMs?: number;
    /** Per-process RSS threshold in MB to flag as high-memory (default: 500) */
    highMemoryThresholdMB?: number;
    /** Whether to auto-kill instar orphans (default: true; false = report only) */
    autoKillOrphans?: boolean;
    /** Whether to report external (non-instar) Claude processes to the user (default: true) */
    reportExternalProcesses?: boolean;
    /** Callback to send alerts (e.g., Telegram) */
    alertCallback?: (message: string) => Promise<void>;
}
export declare class OrphanProcessReaper extends EventEmitter {
    private config;
    private reaperConfig;
    private sessionManager;
    private interval;
    private projectPrefix;
    private lastReport;
    private reportedExternalPids;
    private lastExternalAlertTime;
    private static EXTERNAL_ALERT_COOLDOWN_MS;
    constructor(config: InstarConfig, sessionManager: SessionManager, reaperConfig?: OrphanReaperConfig);
    start(): void;
    stop(): void;
    getLastReport(): ReaperReport | null;
    /**
     * Run a scan immediately and return the report.
     * Can be called on-demand via API endpoints.
     */
    scan(): Promise<ReaperReport>;
    private poll;
    /**
     * Find ALL Claude processes owned by the current user.
     * Uses `ps` to get PID, PPID, RSS, elapsed time, and command.
     */
    private findAllClaudeProcesses;
    /**
     * Determine if a command is an actual Claude Code session (not an MCP server, etc.)
     */
    private isClaudeCodeProcess;
    /**
     * List all tmux sessions and map pane PIDs to session names.
     */
    private listAllTmuxSessions;
    /**
     * Get tmux session names tracked by SessionManager.
     */
    private getTrackedSessionNames;
    /**
     * Classify each Claude process:
     *   - tracked: In a tmux session managed by SessionManager
     *   - instar-orphan: In a project-prefixed tmux session NOT tracked by SessionManager
     *   - external: Everything else (user sessions, VS Code, etc.)
     */
    private classifyProcesses;
    private getParentPid;
    private getProcessCommand;
    private killProcess;
    private killTmuxSession;
    /**
     * Manually kill an external process by PID.
     * Called via user command (e.g., "clean 12345").
     */
    killExternalProcess(pid: number): {
        success: boolean;
        message: string;
    };
    /**
     * Kill all external processes. User-initiated only.
     */
    killAllExternal(): {
        killed: number;
        freedMB: number;
        details: string[];
    };
    private parseElapsed;
    private formatDuration;
}
//# sourceMappingURL=OrphanProcessReaper.d.ts.map