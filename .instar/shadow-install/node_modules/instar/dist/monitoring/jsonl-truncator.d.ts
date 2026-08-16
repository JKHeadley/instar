/**
 * JSONL Truncator — Programmatic Conversation Rewind
 *
 * Claude Code has no programmatic rewind API. But the JSONL file IS the
 * conversation state. Truncating it is equivalent to rewinding.
 *
 * Always creates a backup before truncating. If resume after truncation fails,
 * the backup can be restored.
 *
 * Uses tail-scan to avoid reading entire multi-MB files into memory.
 * Only the tail is parsed to find the truncation point; the file is then
 * truncated at the byte offset without buffering the full content.
 *
 * Part of PROP-session-stall-recovery Phase B
 */
export type TruncationStrategy = 'last_exchange' | 'last_successful_tool' | 'n_exchanges_back';
export interface TruncationResult {
    originalLines: number;
    truncatedLines: number;
    removedLines: number;
    backupPath: string;
    strategy: TruncationStrategy;
}
/**
 * Truncate a JSONL file to a safe point for resume.
 *
 * Uses tail-scan: reads the last ~256KB of the file to find the truncation
 * point, then truncates at the byte offset. Avoids loading the entire file.
 *
 * @param jsonlPath - Path to the JSONL conversation file
 * @param strategy - How far back to truncate
 * @param nExchanges - Number of exchanges to remove (only for 'n_exchanges_back')
 * @returns TruncationResult with details of what was done
 */
export declare function truncateJsonlToSafePoint(jsonlPath: string, strategy?: TruncationStrategy, nExchanges?: number): TruncationResult;
/**
 * Validate that a JSONL file contains valid entries.
 * Uses tail-scan — reads last 256KB rather than the full file.
 */
export declare function validateJsonl(jsonlPath: string): {
    valid: number;
    invalid: number;
};
//# sourceMappingURL=jsonl-truncator.d.ts.map