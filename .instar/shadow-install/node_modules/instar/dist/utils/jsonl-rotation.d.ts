/**
 * JSONL Size-Based Rotation — prevents unbounded JSONL file growth.
 *
 * Born from a 64GB doctor-dead-letter.jsonl incident: append-only JSONL files
 * with no size limit will eventually fill the disk under sustained failure loops.
 *
 * Design:
 *   - Size check via fs.statSync() — O(1), no file read needed
 *   - When over limit: read lines, keep last N%, atomic write (tmp + rename)
 *   - Never throws — rotation failure is non-fatal (the append that triggered
 *     it will still succeed; we just couldn't trim the file this time)
 *   - Lazy rotation — called before/after append, no background timers
 */
export interface RotationOptions {
    /** Maximum file size in bytes before rotation triggers. Default: 10MB */
    maxBytes?: number;
    /** Fraction of lines to keep after rotation (0.0–1.0). Default: 0.75 */
    keepRatio?: number;
}
/**
 * Check if a JSONL file exceeds its size limit, and if so, rotate it
 * by keeping only the most recent lines.
 *
 * @returns true if rotation occurred, false otherwise
 */
export declare function maybeRotateJsonl(filePath: string, options?: RotationOptions): boolean;
//# sourceMappingURL=jsonl-rotation.d.ts.map