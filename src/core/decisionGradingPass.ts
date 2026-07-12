/**
 * decisionGradingPass — the deterministic grading pass driven by
 * POST /decision-quality/grade-pass (llm-decision-quality-meter §5.5).
 *
 * DETERMINISTIC-ONLY (FD11): the LLM evidence-interpreter rung ships NO code.
 * This pass drives the ONE window-close rule the grading JOB owns —
 * `hog-sustained-right-v1` (owningComponent 'DecisionGrading') — over the
 * durable ExternalHogDecisionStore, plus the durable per-decision-point cursor
 * bookkeeping (keyset (ts, correlation_id), bounded per run, idempotent grade
 * upserts, P19 backoff). Every OTHER evidence rule fires at its own owner (the
 * sentinel's scan-tick / grade-on-supersede for respawn-wrong + leave-recurrence;
 * the completion realcheck arm) — never here.
 *
 * Idempotent BY CONSTRUCTION: grades upsert through the §5.4 annotate chokepoint
 * keyed on (correlationId × gradedBy), so a re-run — a concurrent job-tick +
 * operator curl — converges, never multiplies (§5.5).
 *
 * Cursor semantics (low-water mark over a UNIFORM window): a decision younger
 * than the evidence window is still PENDING (its window-close verdict has not
 * matured). Because every hog decision shares the same window, an older pending
 * row implies every later row is pending too — so the pass stops advancing at
 * the oldest un-terminal row and re-checks it (with P19 backoff) next tick.
 * A row is TERMINAL — the cursor advances past it — once it is graded right/wrong
 * by ANY grader OR its window has closed and no `right` applies (it reads as
 * `unknown`/`expired`). No LLM tokens are spent (deterministic predicates only).
 */

import { DP_EXTERNAL_HOG_KILL_LEAVE } from '../data/provenanceCoverage.js';
import {
  HOG_SUSTAINED_RIGHT_RULE_ID,
  evaluateHogSustainedRight,
  type ExternalHogDecisionStore,
  type HogDecisionRecord,
} from '../monitoring/ExternalHogDecisionStore.js';
import type { FeatureMetricsLedger } from '../monitoring/FeatureMetricsLedger.js';
import type { DecisionOutcomeAnnotationInput, DecisionOutcomeAnnotationResult } from './DecisionQualityRecorderImpl.js';

const HOUR_MS = 60 * 60 * 1000;

/** The DecisionGrading annotator identity — the `hog-sustained-right-v1`
 *  registered owner (§5.4.2). The annotate chokepoint rejects any other
 *  gradedBy.component for this rule, so this constant is load-bearing. */
export const DECISION_GRADING_COMPONENT = 'DecisionGrading';

/** P19 backoff for a point that made no progress (its low-water row is still
 *  within its window): base × 2^n, capped — never a busy re-check loop. */
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

export interface DecisionGradingPassDeps {
  /** The quality substrate (decision_quality/outcomes/rollup/cursor tables). */
  ledger: FeatureMetricsLedger;
  /** The durable hog decision store, or null when the sentinel has not wired it
   *  (the hog point then grades nothing this build — honest). */
  hogStore: ExternalHogDecisionStore | null;
  /** The §5.4 annotate chokepoint (production: `annotateDecisionOutcome`). */
  annotate: (a: DecisionOutcomeAnnotationInput) => DecisionOutcomeAnnotationResult;
  /** Global per-run row ceiling (provenance.quality.maxDecisionsPerPass, default 200). */
  maxDecisionsPerPass: number;
  /** The hog evidence window in ms — a decision younger than this is PENDING
   *  (window open). Provenance.quality.evidenceWindowHours (inline default 6h). */
  evidenceWindowMs: number;
  /** Injected clock (§Testing clock discipline — no bare Date.now() in the walk). */
  now: () => number;
}

export interface DecisionGradingPassResult {
  /** Grades that landed DURABLY this pass (dry-run/suppressed writes count 0). */
  graded: number;
  /** graded-by-rule tally (the job template's sanity-check surface). */
  byRule: Record<string, number>;
  /** decisionPoint → the advanced (ts, correlation_id) boundary. */
  cursors: Record<string, { ts: number; correlationId: string }>;
}

/**
 * Run one deterministic grading pass. See the module doc for cursor semantics.
 * The only DecisionGrading-owned window-close rule in this build is
 * `hog-sustained-right-v1`; adding another enrolls a new point here AND flips
 * `SUBBUDGET_IMPLEMENTED` (the census ratchet enforces the fairness sub-budget
 * before a third enrolled point).
 */
export function runDecisionGradingPass(deps: DecisionGradingPassDeps): DecisionGradingPassResult {
  const { ledger, hogStore, annotate, now } = deps;
  const budget = Math.max(1, Math.min(10_000, Math.floor(deps.maxDecisionsPerPass) || 200));
  const evidenceWindowMs = deps.evidenceWindowMs > 0 ? deps.evidenceWindowMs : 6 * HOUR_MS;
  const result: DecisionGradingPassResult = { graded: 0, byRule: {}, cursors: {} };
  const point = DP_EXTERNAL_HOG_KILL_LEAVE;
  const nowMs = now();

  const cursor = ledger.getGradingCursor(point) ?? {
    decisionPoint: point,
    cursorTs: 0,
    cursorCorrelationId: '',
    nextRecheckTs: null,
    attempts: 0,
    updatedAt: 0,
  };

  // P19 backoff: while a point is backing off, no fresh evidence can have
  // matured — skip it entirely this pass (report the frozen boundary honestly).
  if (cursor.nextRecheckTs !== null && nowMs < cursor.nextRecheckTs) {
    result.cursors[point] = { ts: cursor.cursorTs, correlationId: cursor.cursorCorrelationId };
    return result;
  }

  // No durable evidence source wired (the sentinel store is not constructed) →
  // nothing to grade; leave the cursor untouched.
  if (!hogStore) {
    result.cursors[point] = { ts: cursor.cursorTs, correlationId: cursor.cursorCorrelationId };
    return result;
  }

  // correlationId → hog record (bounded: the store retains a handful of slots).
  const byCorr = new Map<string, HogDecisionRecord>();
  for (const { record } of hogStore.list()) {
    if (record.correlationId) byCorr.set(record.correlationId, record);
  }

  const rows = ledger.walkDecisionsForGrading(point, cursor.cursorTs, cursor.cursorCorrelationId, budget);

  let cursorTs = cursor.cursorTs;
  let cursorCorr = cursor.cursorCorrelationId;
  let sawPending = false;

  for (const row of rows) {
    // Already terminally graded (respawn-wrong at the sentinel, or a prior
    // pass' right): advance past it.
    const winning = ledger.getWinningGrades([row.correlationId])[0];
    if (winning && (winning.grade === 'right' || winning.grade === 'wrong')) {
      cursorTs = row.ts;
      cursorCorr = row.correlationId;
      continue;
    }

    const rec = byCorr.get(row.correlationId);
    const decisionAtMs = rec?.atMs ?? row.ts;
    const age = nowMs - decisionAtMs;

    // Within the evidence window → the window-close verdict has not matured.
    // Uniform windows ⇒ every later row is pending too: stop (low-water mark).
    if (age <= evidenceWindowMs) {
      sawPending = true;
      break;
    }

    // Window CLOSED — resolve now.
    if (rec) {
      const grade = evaluateHogSustainedRight(rec, nowMs);
      if (grade === 'right') {
        const res = annotate({
          correlationId: row.correlationId,
          ruleId: HOG_SUSTAINED_RIGHT_RULE_ID,
          gradedBy: { component: DECISION_GRADING_COMPONENT },
          grade: 'right',
          decisionPoint: point,
          evidence: { rule: HOG_SUSTAINED_RIGHT_RULE_ID, windowMs: rec.effectiveWindowMs, sustainedNoReflag: true },
          ts: nowMs,
        });
        if (res.applied) {
          result.graded++;
          result.byRule[HOG_SUSTAINED_RIGHT_RULE_ID] = (result.byRule[HOG_SUSTAINED_RIGHT_RULE_ID] ?? 0) + 1;
          cursorTs = row.ts;
          cursorCorr = row.correlationId;
          continue;
        }
        // dry-run / disabled / rejected: the durable write was suppressed —
        // treat as PENDING (do NOT advance) so a later dryRun:false flip grades
        // it rather than skipping it forever behind an advanced cursor.
        sawPending = true;
        break;
      }
      // Window closed and `right` does not apply (re-flagged / owner alive /
      // un-orderable) → terminal-unknown (reads as unknown/expired); advance.
      cursorTs = row.ts;
      cursorCorr = row.correlationId;
      continue;
    }

    // No hog record AND the window closed → no evidence will arrive → terminal.
    cursorTs = row.ts;
    cursorCorr = row.correlationId;
  }

  // Cursor + P19 backoff bookkeeping.
  const advanced = cursorTs !== cursor.cursorTs || cursorCorr !== cursor.cursorCorrelationId;
  let nextRecheckTs: number | null = null;
  let attempts = 0;
  if (sawPending && !advanced) {
    // No progress AND a pending low-water row: back off before re-checking.
    attempts = (cursor.attempts ?? 0) + 1;
    nextRecheckTs = nowMs + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 4));
  }
  // (A full page that fully resolved leaves nextRecheckTs null so the next pass
  //  continues immediately from the advanced boundary.)
  ledger.setGradingCursor(point, { cursorTs, cursorCorrelationId: cursorCorr, nextRecheckTs, attempts });
  result.cursors[point] = { ts: cursorTs, correlationId: cursorCorr };
  return result;
}
