/**
 * RealCheckOutcomeBinder — the ONE wired annotateOutcome seam (ACT-562 §3.3).
 *
 * Binds the Real-Check verification result (the autonomous stop-hook's
 * `verification_command` exit, appended to `logs/autonomous-realcheck.jsonl`) as
 * GROUND TRUTH for a CompletionEvaluator continue/stop decision on a run that
 * declared a `verification_command`.
 *
 * WHY THIS SIGNAL (§3.3 independence bar): the Real-Check outcome is an EXTERNAL
 * command exit (a test suite / build / grep the agent runs), INDEPENDENT of the
 * CompletionEvaluator's OWN LLM verdict — so it is genuine ground truth, not an
 * outcome derived from the very decision being graded. A CompletionEvaluator
 * `met:true` verdict is "correct" iff the external check also passed.
 *
 * CORRELATION (§3.3): each realcheck row carries `{topic, iteration}`. The
 * Real-Check command runs ONLY on a `met:true` verdict, so the realcheck row
 * for a topic corresponds to the LATEST continue-stop decision registered for
 * that topic (the one that produced the met:true it is verifying). We remember
 * the `decisionId` of the latest continue-stop decision per `topicId`; when a
 * realcheck row for that topic appears, we `annotateOutcome(decisionId, ...)`.
 * `annotateOutcome` is itself idempotent (exactly one terminal outcome per
 * decisionId), so a second realcheck row for the same decision is a no-op, and
 * a NEW decision (a later attempt) replaces the pending target so its own
 * realcheck row binds to it — never a smeared/ambiguous outcome across attempts.
 *
 * The binder is OBSERVABILITY-ONLY: it reads a JSONL tail + writes an outcome
 * row; it NEVER feeds back into any decision input (§3.5). It is invoked from
 * the `/autonomous/evaluate-completion` route on each call (best-effort; a
 * failure is swallowed).
 */

import fs from 'node:fs';
import path from 'node:path';

/** The subset of a realcheck row we consume (all other fields ignored). */
interface RealCheckRow {
  topic?: string | number;
  iteration?: string | number;
  outcome?: string;
  exitCode?: number | null;
  ts?: string;
}

/** The provenance sink the binder needs — just annotateOutcome. */
export interface RealCheckOutcomeSink {
  annotateOutcome(decisionId: string, component: string, outcome: Record<string, unknown>): boolean;
}

export class RealCheckOutcomeBinder {
  private readonly logFile: string;
  private readonly sink: RealCheckOutcomeSink;
  /** `topicId` → the LATEST continue-stop decisionId awaiting ground truth. */
  private readonly pending = new Map<string, string>();
  /** How far into the JSONL we have already scanned (byte offset), so re-reads are cheap. */
  private scanOffset = 0;
  /** decisionIds already bound — a repeat realcheck row for the same decision is a no-op. */
  private readonly boundDecisionIds = new Set<string>();

  constructor(opts: { stateDir: string; sink: RealCheckOutcomeSink; logFile?: string }) {
    this.logFile = opts.logFile ?? path.join(opts.stateDir, 'logs', 'autonomous-realcheck.jsonl');
    this.sink = opts.sink;
  }

  /**
   * Register the continue-stop decision that gated this run's latest attempt, so
   * a subsequent Real-Check outcome can be bound to it. Called with the id
   * `recordDecision` returned. A null id (sampled out / write failed) or a
   * missing topicId is ignored. A newer decision for the same topic REPLACES the
   * pending target (a later attempt's realcheck binds to the later decision).
   */
  registerDecision(decisionId: string | null, correlation: { topicId?: string }): void {
    if (!decisionId || !correlation.topicId) return;
    this.pending.set(String(correlation.topicId), decisionId);
  }

  /**
   * Scan new realcheck rows and bind any that match a pending decision. Bounded,
   * best-effort, total (never throws into the caller). Returns the number of
   * outcomes bound this pass (for tests/observability).
   */
  bindNewOutcomes(): number {
    let bound = 0;
    try {
      if (!fs.existsSync(this.logFile)) return 0;
      const size = fs.statSync(this.logFile).size;
      // Handle rotation/truncation: if the file shrank, rescan from the top.
      if (size < this.scanOffset) this.scanOffset = 0;
      if (size === this.scanOffset) return 0;
      const fd = fs.openSync(this.logFile, 'r');
      try {
        const len = size - this.scanOffset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, this.scanOffset);
        const text = buf.toString('utf8');
        // Only advance past the last complete line (a partial trailing line is
        // re-read next pass).
        const lastNl = text.lastIndexOf('\n');
        if (lastNl < 0) return 0;
        this.scanOffset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
        for (const line of text.slice(0, lastNl).split('\n')) {
          if (!line.trim()) continue;
          let row: RealCheckRow;
          try {
            row = JSON.parse(line) as RealCheckRow;
          } catch {
            continue; // @silent-fallback-ok: a torn row is skipped — observability read.
          }
          if (row.topic == null) continue;
          const topicKey = String(row.topic);
          const decisionId = this.pending.get(topicKey);
          if (!decisionId) continue; // no continue-stop decision registered for this topic yet
          if (this.boundDecisionIds.has(decisionId)) continue; // already annotated this decision
          // The check passed iff the hook reported outcome 'pass' (exit 0). A
          // null exitCode with a 'pass' outcome is the hook's shape; treat any
          // non-'pass' outcome as a failed check.
          const passed = row.outcome === 'pass';
          const ok = this.sink.annotateOutcome(decisionId, 'CompletionEvaluator', {
            // §3.5 — this is an INDEPENDENT external-command outcome (Real-Check),
            // never derived from the graded LLM verdict.
            source: 'real-check-verification',
            groundTruthIndependent: true,
            passed,
            outcome: row.outcome ?? null,
            exitCode: row.exitCode ?? null,
            realCheckTs: row.ts ?? null,
          });
          if (ok) {
            this.boundDecisionIds.add(decisionId);
            this.pending.delete(topicKey);
            bound++;
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* @silent-fallback-ok: binding is observability — a read failure must never affect the caller. */
    }
    return bound;
  }
}
