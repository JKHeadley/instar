/**
 * Session Stall Detector — JSONL Tail Analysis
 *
 * Detects when a Claude Code session has stalled mid-tool-call by analyzing
 * the conversation JSONL file. A stall occurs when:
 * 1. The last assistant message has stop_reason: "tool_use"
 * 2. No subsequent tool_result has been received
 * 3. The time since the tool_use exceeds the threshold for that tool type
 *
 * Part of PROP-XXX: Session Stall Detection & Auto-Recovery
 */
export interface StallInfo {
    jsonlPath: string;
    sessionUuid: string;
    stalledAt: string;
    stallDurationMs: number;
    lastToolName: string;
    lastToolInput: Record<string, unknown>;
    lastToolUseId: string;
}
/**
 * Per-tool stall thresholds in milliseconds.
 * Tools that legitimately take longer get higher thresholds.
 */
export declare const DEFAULT_TOOL_THRESHOLDS: Record<string, number>;
/**
 * Detect if a Claude Code session has stalled mid-tool-call.
 *
 * @param jsonlPath - Path to the conversation JSONL file
 * @param maxAgeMs - Optional global override for stall threshold (overrides per-tool thresholds)
 * @returns StallInfo if stalled, null otherwise
 */
export declare function detectToolCallStall(jsonlPath: string, maxAgeMs?: number): StallInfo | null;
//# sourceMappingURL=stall-detector.d.ts.map