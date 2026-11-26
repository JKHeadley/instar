/**
 * Independent, deliberately narrow effect proof for a scheduled grading pass.
 * It can prove that every grade-pass point had no decision rows at all.
 * Any nonempty, unreadable, or concurrently changed workset remains ungraded.
 */
import crypto from 'node:crypto';
import type { FeatureMetricsLedger } from '../monitoring/FeatureMetricsLedger.js';
import { GRADE_PASS_POINTS, runDecisionGradingPass, type DecisionGradingPassDeps,
  type DecisionGradingPassResult } from './decisionGradingPass.js';

type IdleSnapshot = ReturnType<FeatureMetricsLedger['strictGradingIdleSnapshot']>;

function emptyWorkset(rows: IdleSnapshot): boolean {
  return rows.length === GRADE_PASS_POINTS.length
    && rows.every(row => row.nextCorrelationId === null && row.totalRows === 0);
}

function sameCursor(before: IdleSnapshot, after: IdleSnapshot): boolean {
  return before.length === after.length && before.every((row, i) =>
    row.decisionPoint === after[i].decisionPoint
    && row.cursorTs === after[i].cursorTs
    && row.cursorCorrelationId === after[i].cursorCorrelationId
    && after[i].nextCorrelationId === null
    && after[i].totalRows === 0);
}

export function runGradePassWithIdleProof(input: {
  deps: DecisionGradingPassDeps;
  runId: string | null;
  allowProof: boolean;
}): { result: DecisionGradingPassResult; idleProofHash: string | null } {
  const { ledger } = input.deps;
  return ledger.withExclusiveGradingPass(() => {
    let before: IdleSnapshot | null = null;
    if (input.runId && input.allowProof) {
      try { before = ledger.strictGradingIdleSnapshot(GRADE_PASS_POINTS); }
      catch {
        // @silent-fallback-ok — a strict read failure denies the positive proof;
        // the ordinary pass still runs and the model outcome stays unknown.
        before = null;
      }
    }
    const result = runDecisionGradingPass(input.deps);
    if (!before || !input.runId) return { result, idleProofHash: null };
    let after: IdleSnapshot;
    try { after = ledger.strictGradingIdleSnapshot(GRADE_PASS_POINTS); }
    catch {
      // @silent-fallback-ok — the pass ran, but an unreadable post-state
      // cannot certify its effect. The outcome remains unknown.
      return { result, idleProofHash: null };
    }
    if (!emptyWorkset(before) || !sameCursor(before, after)
      || result.graded !== 0 || Object.keys(result.byRule).length !== 0
      || Object.keys(result.cursors).length !== GRADE_PASS_POINTS.length) {
      return { result, idleProofHash: null };
    }
    const idleProofHash = crypto.createHash('sha256').update(JSON.stringify({
      rule: 'grade-pass-idle-effects-v1', runId: input.runId, before, after,
    })).digest('hex');
    return { result, idleProofHash };
  });
}
