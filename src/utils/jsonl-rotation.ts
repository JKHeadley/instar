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

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

// ── Types ────────────────────────────────────────────────────────────

export interface RotationOptions {
  /** Maximum file size in bytes before rotation triggers. Default: 10MB */
  maxBytes?: number;
  /** Fraction of lines to keep after rotation (0.0–1.0). Default: 0.75 */
  keepRatio?: number;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_KEEP_RATIO = 0.75;
const DEFAULT_KEEP_SEGMENTS = 4;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Check if a JSONL file exceeds its size limit, and if so, rotate it
 * by keeping only the most recent lines.
 *
 * NON-CONFORMANT to the Bounded Accumulation standard (§3.5): this rotates by
 * `readFileSync` (whole file) + `split` + `writeFileSync`, which blocks the event
 * loop for hundreds of ms on a multi-MB file — the exact stall the standard exists
 * to kill. Prefer {@link maybeRotateJsonlSegment} (constant-time rename) for any
 * store registered `access: 'streamed'`. Retained for back-compat callers pending
 * their migration (Bounded Accumulation Increment 2).
 *
 * @returns true if rotation occurred, false otherwise
 */
export function maybeRotateJsonl(filePath: string, options?: RotationOptions): boolean {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const keepRatio = Math.max(0, Math.min(1, options?.keepRatio ?? DEFAULT_KEEP_RATIO));

  try {
    // O(1) size check — no file read
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) {
      return false;
    }

    // File is over the limit — read, truncate, write atomically
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    if (lines.length === 0) {
      return false;
    }

    const keepCount = Math.max(1, Math.ceil(lines.length * keepRatio));
    const keptLines = lines.slice(-keepCount);

    // Atomic write: tmp file + rename
    const tmpPath = filePath + '.rotation-tmp';
    fs.writeFileSync(tmpPath, keptLines.join('\n') + '\n');
    fs.renameSync(tmpPath, filePath);

    return true;
  } catch {
    // Rotation failure is non-fatal — the file continues to grow until
    // the next successful rotation attempt. Clean up tmp if it exists.
    try {
      const tmpPath = filePath + '.rotation-tmp';
      if (fs.existsSync(tmpPath)) {
        SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/utils/jsonl-rotation.ts:75' });
      }
    } catch {
      // Best effort cleanup
    }
    return false;
  }
}

// ── Segment rotation (Bounded Accumulation §3.5) ─────────────────────

export interface SegmentRotationOptions {
  /** Maximum active-file size in bytes before a segment is cut. Default: 10MB */
  maxBytes?: number;
  /** Number of rotated segments to retain (oldest beyond this are unlinked). Default: 4 */
  keepSegments?: number;
  /**
   * Compliance-hold mode: rotated segments are NEVER unlinked. An audit/forensic
   * trail (security.jsonl, destructive-ops.jsonl) must not lose its oldest entries —
   * it is bounded by archive policy, never by drop. Default: false.
   */
  archive?: boolean;
}

/**
 * Segment-based JSONL rotation — the event-loop-SAFE alternative to
 * {@link maybeRotateJsonl}'s read-filter-rewrite (Bounded Accumulation standard §3.5).
 *
 * When the active file exceeds `maxBytes`, the active file is RENAMED to a numbered
 * segment `<name>.<seq>` (a constant-time metadata op — NO file read, NO whole-file
 * rewrite) and a fresh empty active file is opened. Oldest segments beyond
 * `keepSegments` are unlinked — UNLESS `archive: true`, which retains every segment
 * (compliance/audit trails that must never drop their oldest entries).
 *
 * Why it exists: rotating a 14MB hot log via the old read+split+rewrite path froze the
 * event loop for hundreds of ms on the append path; renaming a segment is O(1). Callers
 * SHOULD gate the size-check behind a cached byte-counter (see `JsonlStore`) so even the
 * O(1) `statSync` is not paid on every append.
 *
 * @returns true if a segment was cut, false otherwise. Never throws.
 */
export function maybeRotateJsonlSegment(filePath: string, options?: SegmentRotationOptions): boolean {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const keepSegments = Math.max(1, options?.keepSegments ?? DEFAULT_KEEP_SEGMENTS);
  const archive = options?.archive ?? false;

  try {
    let size: number;
    try {
      size = fs.statSync(filePath).size; // O(1) — no file read
    } catch {
      return false; // no active file yet → nothing to rotate
    }
    if (size <= maxBytes) return false;

    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    // Rotated segments are "<base>.<seq>" (optionally ".gz"); seq is monotonic.
    const segRe = new RegExp('^' + escapeRegExp(base) + '\\.(\\d+)(?:\\.gz)?$');
    const segments: Array<{ seq: number; name: string }> = [];
    let maxSeq = 0;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(segRe);
      if (!m) continue;
      const seq = parseInt(m[1], 10);
      if (!Number.isFinite(seq)) continue;
      segments.push({ seq, name: f });
      if (seq > maxSeq) maxSeq = seq;
    }
    const nextSeq = maxSeq + 1;

    // Cut the segment: rename active → segment (constant-time), open a fresh active.
    fs.renameSync(filePath, path.join(dir, base + '.' + nextSeq));
    fs.writeFileSync(filePath, '');

    // Prune oldest segments beyond keepSegments — NEVER in archive (compliance) mode.
    if (!archive) {
      const cutoff = nextSeq - keepSegments; // segments with seq <= cutoff are dropped
      for (const s of segments) {
        if (s.seq <= cutoff) {
          try {
            SafeFsExecutor.safeUnlinkSync(path.join(dir, s.name), {
              operation: 'src/utils/jsonl-rotation.ts:maybeRotateJsonlSegment',
            });
          } catch {
            // best effort — a failed unlink just leaves an extra old segment
          }
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}
