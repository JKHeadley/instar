/**
 * ResponseReviewDecisionLog — the durable would-block decision log
 * (context-aware-outbound-review spec §D8, the flip-evidence store).
 *
 * The in-memory `CoherenceGate.reviewHistory` is pruned to 1000 entries and
 * erased by every server restart — a data-gated enforcement-flip criterion
 * ("a clean day on real traffic") cannot rest on a store any restart wipes.
 * This append-only JSONL (`logs/response-review-decisions.jsonl`) is the
 * restart-surviving record: one line per `_evaluate` verdict (ALL outcomes,
 * not just would-blocks — the §D9.3 denominator matters), written at the same
 * seam as `logAudit`, plus the two additive soak row types (counterfactual
 * rows, §D9.4; canary/battery rows, §D9.4b — written through this SAME
 * writer so there is exactly one file and one rotation policy).
 *
 * At-rest honesty (§D8): rows persist 200 credential-scrubbed chars of every
 * reviewed turn plus topicId, as a plaintext machine-local file under
 * filesystem permissions — the same posture as sibling JSONLs, NOT the
 * encrypted vault. That is the trade for restart-surviving flip evidence.
 *
 * Failure direction: write failures are swallowed — telemetry must never
 * affect a verdict or delivery (§D5: the D8 write is one of the individually
 * contained context code paths; the HTTP seam above fails OPEN so nothing
 * here may throw into `_evaluate`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10MB, size-rotated like sibling JSONLs

export class ResponseReviewDecisionLog {
  private readonly logPath: string;
  private readonly maxBytes: number;

  constructor(logPath: string, options?: { maxBytes?: number }) {
    this.logPath = logPath;
    this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /** The absolute path of the JSONL file (for tests + observability). */
  getPath(): string {
    return this.logPath;
  }

  /**
   * Append one row. Swallows every failure — the decision log is telemetry;
   * a full disk or unwritable path must never affect a review verdict.
   */
  append(row: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      this.rotateIfNeeded();
      fs.appendFileSync(this.logPath, JSON.stringify(row) + '\n', 'utf8');
    } catch {
      // @silent-fallback-ok — §D8: decision-log write failures are swallowed;
      // the verdict and delivery are unaffected (telemetry never gates).
    }
  }

  /**
   * Size rotation: when the file exceeds maxBytes, rename it to `<path>.1`
   * (replacing the previous archive) and start fresh — the same bounded
   * single-archive policy sibling JSONLs use. Contained; never throws.
   */
  private rotateIfNeeded(): void {
    try {
      const stat = fs.statSync(this.logPath);
      if (stat.size < this.maxBytes) return;
      const archive = `${this.logPath}.1`;
      try {
        SafeFsExecutor.safeRmSync(archive, {
          force: true,
          operation: 'ResponseReviewDecisionLog.rotate (drop the previous single archive)',
        });
      } catch {
        // @silent-fallback-ok — a stale archive that cannot be removed only
        // means renameSync below may fail; that failure is caught too.
      }
      fs.renameSync(this.logPath, archive);
    } catch {
      // @silent-fallback-ok — a missing file (ENOENT on first write) or a
      // failed rotation both degrade to "keep appending"; telemetry never
      // gates and the append itself is separately contained.
    }
  }
}
