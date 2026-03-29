/**
 * Session Crash Detector — JSONL Analysis for Dead Sessions
 *
 * Detects when a Claude Code session has crashed by analyzing the JSONL
 * conversation file in combination with process status. A crash occurs when:
 * 1. The Claude process is no longer alive
 * 2. The JSONL ends in a problematic state (tool_use with no result, error pattern)
 *
 * Also detects error loops — repeated identical errors that suggest the session
 * is stuck retrying the same failing approach.
 *
 * Part of PROP-session-stall-recovery Phase B
 */
export interface CrashInfo {
    type: 'crash';
    jsonlPath: string;
    sessionUuid: string;
    detectedAt: string;
    errorMessage?: string;
    errorType: 'tool_use_incomplete' | 'parsing' | 'api' | 'internal' | 'unknown';
    lastToolName?: string;
    lastToolInput?: Record<string, unknown>;
}
export interface ErrorLoopInfo {
    type: 'error_loop';
    jsonlPath: string;
    sessionUuid: string;
    detectedAt: string;
    loopCount: number;
    failingPattern: string;
    failingCommand?: string;
}
/**
 * Detect if a Claude Code session has crashed.
 * A crash = process dead + JSONL ends in a non-terminal state.
 *
 * @param jsonlPath - Path to the conversation JSONL file
 * @param processAlive - Whether the Claude process is still running
 * @returns CrashInfo if crashed, null if clean exit or process still alive
 */
export declare function detectCrashedSession(jsonlPath: string, processAlive: boolean): CrashInfo | null;
/**
 * Detect if a session is stuck in an error loop — repeating the same failing approach.
 *
 * @param jsonlPath - Path to the conversation JSONL file
 * @param minRepetitions - Minimum number of identical errors to count as a loop (default: 3)
 * @returns ErrorLoopInfo if loop detected, null otherwise
 */
export declare function detectErrorLoop(jsonlPath: string, minRepetitions?: number): ErrorLoopInfo | null;
//# sourceMappingURL=crash-detector.d.ts.map