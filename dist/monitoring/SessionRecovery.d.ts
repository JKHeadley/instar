/**
 * SessionRecovery — Mechanical session crash/stall recovery via JSONL analysis.
 *
 * A fast, deterministic layer that runs BEFORE the LLM-powered TriageOrchestrator.
 * Detects three failure modes without any LLM calls:
 * 1. Tool call stalls (process alive but frozen mid-tool)
 * 2. Crashes (process dead with incomplete JSONL)
 * 3. Error loops (same error repeated 3+ times)
 *
 * Recovery strategy: truncate JSONL to safe point + respawn with recovery prompt.
 * Escalation ladder: last_exchange → last_successful_tool → n_exchanges_back → alert human.
 *
 * Self-contained — no Dawn dependencies. Uses only:
 * - stall-detector.ts (pure function)
 * - crash-detector.ts (pure function)
 * - jsonl-truncator.ts (pure function)
 *
 * Part of PROP-session-stall-recovery (Instar integration)
 */
import { EventEmitter } from 'events';
import { type TruncationStrategy } from './jsonl-truncator.js';
export interface SessionRecoveryConfig {
    enabled: boolean;
    /** Max recovery attempts per session before alerting human */
    maxAttempts: number;
    /** Cooldown between recovery attempts (ms) */
    cooldownMs: number;
    /** Project directory (used to find JSONL files) */
    projectDir: string;
}
export interface RecoveryAttempt {
    lastAttempt: number;
    count: number;
}
export interface RecoveryResult {
    recovered: boolean;
    failureType: 'stall' | 'crash' | 'error_loop' | null;
    strategy?: TruncationStrategy;
    attemptNumber?: number;
    message: string;
}
export interface SessionRecoveryDeps {
    /** Check if a tmux session's Claude process is alive */
    isSessionAlive: (sessionName: string) => boolean;
    /** Get the PID of the pane in a tmux session */
    getPanePid?: (sessionName: string) => number | null;
    /** Kill a tmux session */
    killSession: (sessionName: string) => void;
    /** Respawn a session for a topic, optionally with a recovery prompt */
    respawnSession: (topicId: number, sessionName?: string, recoveryPrompt?: string) => Promise<void>;
    /** Send a message to a topic */
    sendToTopic?: (topicId: number, message: string) => Promise<void>;
}
export declare class SessionRecovery extends EventEmitter {
    private config;
    private deps;
    private recoveryAttempts;
    private stateFilePath;
    constructor(config: Partial<SessionRecoveryConfig>, deps: SessionRecoveryDeps);
    /**
     * Check a session for mechanical failures and attempt recovery.
     * Should be called from SessionMonitor.checkSession() before LLM triage.
     *
     * @returns RecoveryResult — if recovered is true, caller should skip LLM triage
     */
    checkAndRecover(topicId: number, sessionName: string): Promise<RecoveryResult>;
    /**
     * Log a recovery event to the JSONL event log for observability.
     */
    logEvent(result: RecoveryResult, topicId: number, sessionName: string): void;
    /**
     * Aggregate recovery stats from the event log since a given timestamp.
     */
    getStats(sinceMs: number): {
        attempts: {
            stall: number;
            crash: number;
            errorLoop: number;
        };
        successes: {
            stall: number;
            crash: number;
            errorLoop: number;
        };
    };
    private recoverFromStall;
    private recoverFromCrash;
    private recoverFromErrorLoop;
    private buildStallRecoveryPrompt;
    private buildCrashRecoveryPrompt;
    private buildErrorLoopRecoveryPrompt;
    private pickTruncationStrategy;
    private shouldAttempt;
    private recordAttempt;
    /**
     * Load recovery state from disk. Prevents infinite kill-respawn loops
     * across dawn-server restarts by preserving attempt counts and cooldowns.
     */
    private loadState;
    /**
     * Persist recovery state to disk so it survives process restarts.
     */
    private saveState;
    /**
     * Find the JSONL file for a session using lsof (Strategy 1) with NO fallback.
     *
     * Previous implementation fell back to most-recently-modified JSONL which
     * could match a DIFFERENT healthy session, leading to cross-session corruption
     * during truncation. Now returns null if lsof can't identify the file —
     * better to skip recovery than corrupt the wrong session.
     */
    private findJsonlForSession;
    /**
     * Clean up old recovery tracking entries and stale .bak files.
     */
    cleanup(): void;
    /**
     * Remove .bak.* files older than maxAge from the Claude projects JSONL directory.
     * Each recovery creates a full backup — without cleanup these accumulate indefinitely,
     * consuming disk and retaining sensitive conversation data.
     */
    private cleanupBackupFiles;
}
/**
 * Sanitize text for injection into a recovery prompt.
 * Strips control characters, Unicode directional overrides, and truncates.
 */
export declare function sanitizeForPrompt(text: string, maxLength?: number): string;
//# sourceMappingURL=SessionRecovery.d.ts.map