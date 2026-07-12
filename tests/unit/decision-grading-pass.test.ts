import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import {
  ExternalHogDecisionStore,
  HOG_SUSTAINED_RIGHT_RULE_ID,
  type HogEvidenceScanView,
} from '../../src/monitoring/ExternalHogDecisionStore.js';
import type { HogDecisionSeed } from '../../src/monitoring/ExternalHogScanTick.js';
import { DP_EXTERNAL_HOG_KILL_LEAVE } from '../../src/data/provenanceCoverage.js';
import {
  DecisionQualityRecorderImpl,
  installDecisionQualityRecorder,
  annotateDecisionOutcome,
  _resetDecisionAnnotationRejectionCountersForTest,
} from '../../src/core/DecisionQualityRecorderImpl.js';
import { _resetDecisionQualityForTest } from '../../src/core/decisionQualityTypes.js';
import {
  runDecisionGradingPass,
  DECISION_GRADING_COMPONENT,
  perPointSubBudget,
  GRADE_PASS_POINTS,
} from '../../src/core/decisionGradingPass.js';
import { CompletionEvaluator, type CompletionCorrelationSink } from '../../src/core/CompletionEvaluator.js';

/**
 * Unit tests for the P9 deterministic grade-pass (llm-decision-quality-meter
 * §5.5): the hog-sustained-right-v1 window-close rule driven over the durable
 * store + the ledger's keyset cursor — bounded per run, idempotent, injected
 * clock throughout. Plus the P8 wiring-integrity assertions (recorder singleton
 * delegates to the real ledger; the CompletionEvaluator's runCorrelationSink is
 * a real sink, not a no-op).
 */

const T0 = 1_750_000_000_000; // fixed epoch base — never the real clock
const HOUR = 60 * 60 * 1000;
const WINDOW = 6 * HOUR;

let dir: string;
let storeWall: number;

function makeStore(): ExternalHogDecisionStore {
  return new ExternalHogDecisionStore({
    stateDir: dir,
    config: { provenance: { quality: { evidenceWindowHours: 6, gradingSlackHours: 2 } } },
    killLedgerBreakerWindowMs: HOUR,
    nowMs: () => storeWall,
  });
}

function killSeed(over: Partial<HogDecisionSeed> = {}): HogDecisionSeed {
  return {
    ledgerKey: 'vscode-exthost:hashA',
    classId: 'vscode-exthost',
    commandHash: 'hashA',
    verdict: 'kill',
    enacted: 'killed',
    correlationId: 'd-kill-1',
    targetTuple: { pid: 900, startTimeMs: T0 - HOUR },
    ownerTuple: { parentPid: 400 },
    floorPermitted: true,
    ...over,
  };
}

const emptyView = (): HogEvidenceScanView => ({ candidates: [], aliveStartTimeMs: () => undefined });

/** A live recorder wired to the ledger, seam ENABLED + dryRun OFF (durable writes). */
function installLiveRecorder(ledger: FeatureMetricsLedger): void {
  installDecisionQualityRecorder(
    new DecisionQualityRecorderImpl({
      ledger,
      config: { developmentAgent: true, provenance: { uniformSeam: { enabled: true, dryRun: false } } },
    }),
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-grading-pass-'));
  storeWall = T0;
  _resetDecisionQualityForTest();
  _resetDecisionAnnotationRejectionCountersForTest();
});
afterEach(() => {
  installDecisionQualityRecorder(null);
  _resetDecisionQualityForTest();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/decision-grading-pass.test.ts' });
});

describe('runDecisionGradingPass — hog-sustained-right window-close grading', () => {
  it('grades a window-closed enacted kill `right`, advances the cursor, and is idempotent on re-run', () => {
    const ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    installLiveRecorder(ledger);
    const store = makeStore();
    store.record(killSeed({ correlationId: 'd-kill-1', ledgerKey: 'k1', commandHash: 'h1' }), emptyView());
    ledger.recordDecision({ correlationId: 'd-kill-1', decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE, ts: T0 });

    const gradeNow = T0 + WINDOW + 1000; // window CLOSED
    const r1 = runDecisionGradingPass({
      ledger, hogStore: store, annotate: annotateDecisionOutcome,
      maxDecisionsPerPass: 200, evidenceWindowMs: WINDOW, now: () => gradeNow,
    });

    expect(r1.graded).toBe(1);
    expect(r1.byRule[HOG_SUSTAINED_RIGHT_RULE_ID]).toBe(1);
    expect(r1.cursors[DP_EXTERNAL_HOG_KILL_LEAVE]).toEqual({ ts: T0, correlationId: 'd-kill-1' });
    expect(ledger.getWinningGrades(['d-kill-1'])[0]?.grade).toBe('right');

    // Re-run converges: nothing new past the cursor, still exactly ONE outcome row.
    const r2 = runDecisionGradingPass({
      ledger, hogStore: store, annotate: annotateDecisionOutcome,
      maxDecisionsPerPass: 200, evidenceWindowMs: WINDOW, now: () => gradeNow + 5000,
    });
    expect(r2.graded).toBe(0);
    expect(ledger.getWinningGrades(['d-kill-1'])[0]?.grade).toBe('right'); // still right, not multiplied
    // A full RE-walk from cursor 0 also converges (idempotent upsert by correlationId × gradedBy).
    const r3 = runDecisionGradingPass({
      ledger, hogStore: store, annotate: annotateDecisionOutcome,
      maxDecisionsPerPass: 200, evidenceWindowMs: WINDOW, now: () => gradeNow + 10000,
    });
    expect(r3.graded).toBe(0);
    ledger.close();
  });

  it('leaves a decision within its evidence window PENDING (low-water mark; not graded, cursor not advanced)', () => {
    const ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    installLiveRecorder(ledger);
    const store = makeStore();
    store.record(killSeed({ correlationId: 'd-kill-open', ledgerKey: 'k1', commandHash: 'h1' }), emptyView());
    ledger.recordDecision({ correlationId: 'd-kill-open', decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE, ts: T0 });

    const gradeNow = T0 + HOUR; // window still OPEN (< 6h)
    const r = runDecisionGradingPass({
      ledger, hogStore: store, annotate: annotateDecisionOutcome,
      maxDecisionsPerPass: 200, evidenceWindowMs: WINDOW, now: () => gradeNow,
    });
    expect(r.graded).toBe(0);
    expect(r.cursors[DP_EXTERNAL_HOG_KILL_LEAVE]).toEqual({ ts: 0, correlationId: '' }); // not advanced
    expect(ledger.getWinningGrades(['d-kill-open'])).toHaveLength(0); // ungraded, never guessed
    ledger.close();
  });

  it('keyset cursor handles a same-ms burst without skipping rows (bounded per pass)', () => {
    const ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    installLiveRecorder(ledger);
    const store = makeStore();
    // Three enacted kills at the SAME decision ts (T0), each a distinct correlation id.
    for (const c of ['d-a', 'd-b', 'd-c']) {
      store.record(killSeed({ correlationId: c, ledgerKey: `lk-${c}`, commandHash: `h-${c}` }), emptyView());
      ledger.recordDecision({ correlationId: c, decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE, ts: T0 });
    }
    const gradeNow = T0 + WINDOW + 1000;
    // maxDecisionsPerPass = 2 → the first pass can grade at most two of the same-ms rows.
    const pass = () => runDecisionGradingPass({
      ledger, hogStore: store, annotate: annotateDecisionOutcome,
      maxDecisionsPerPass: 2, evidenceWindowMs: WINDOW, now: () => gradeNow,
    });
    const first = pass();
    expect(first.graded).toBeLessThanOrEqual(2);
    // Drain across passes — the compound (ts, correlation_id) boundary means the
    // same-ms rows are consumed exactly once each, never skipped, never doubled.
    let total = first.graded;
    for (let i = 0; i < 4 && total < 3; i++) total += pass().graded;
    expect(total).toBe(3);
    for (const c of ['d-a', 'd-b', 'd-c']) {
      expect(ledger.getWinningGrades([c])[0]?.grade).toBe('right');
    }
    ledger.close();
  });

  it('grades nothing when the hog store is unwired (null) — honest no-op, cursor untouched', () => {
    const ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    installLiveRecorder(ledger);
    ledger.recordDecision({ correlationId: 'd-x', decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE, ts: T0 });
    const r = runDecisionGradingPass({
      ledger, hogStore: null, annotate: annotateDecisionOutcome,
      maxDecisionsPerPass: 200, evidenceWindowMs: WINDOW, now: () => T0 + WINDOW + 1000,
    });
    expect(r.graded).toBe(0);
    expect(r.cursors[DP_EXTERNAL_HOG_KILL_LEAVE]).toEqual({ ts: 0, correlationId: '' });
    ledger.close();
  });

  it('performance: a not-enrolled empty pass is cheap (no full scan) — bounded work', () => {
    const ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    installLiveRecorder(ledger);
    const store = makeStore();
    const started = process.hrtime.bigint();
    for (let i = 0; i < 50; i++) {
      runDecisionGradingPass({
        ledger, hogStore: store, annotate: annotateDecisionOutcome,
        maxDecisionsPerPass: 200, evidenceWindowMs: WINDOW, now: () => T0 + WINDOW + 1000,
      });
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(500); // 50 empty passes stay well under a wall-clock ceiling
    ledger.close();
  });
});

describe('wiring integrity (P8/P9)', () => {
  it('the recorder singleton is non-null and its annotate chokepoint delegates to the real ledger', () => {
    const ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    installLiveRecorder(ledger);
    ledger.recordDecision({ correlationId: 'd-wire', decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE, ts: T0 });
    const res = annotateDecisionOutcome({
      correlationId: 'd-wire',
      ruleId: HOG_SUSTAINED_RIGHT_RULE_ID,
      gradedBy: { component: DECISION_GRADING_COMPONENT },
      grade: 'right',
      decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE,
      ts: T0 + 1000,
    });
    expect(res.applied).toBe(true); // NOT a no-op — the singleton delegated to the ledger
    expect(ledger.getWinningGrades(['d-wire'])[0]?.grade).toBe('right'); // the write landed in the REAL ledger
    ledger.close();
  });

  it('CompletionEvaluator persists the correlation id through a REAL runCorrelationSink (not null/no-op)', async () => {
    const calls: Array<[string, string, string, string]> = [];
    const sink: CompletionCorrelationSink = {
      recordDecisionCorrelation: (topicId, runId, kind, correlationId) => {
        calls.push([topicId, runId, kind, correlationId]);
      },
    };
    // A fake IntelligenceProvider that fires the router's onCorrelationId callback.
    const fakeIntelligence = {
      evaluate: async (_prompt: string, opts: { provenance?: { onCorrelationId?: (id: string) => void } }) => {
        opts.provenance?.onCorrelationId?.('d-corr-abc');
        return 'MET';
      },
    };
    const evaluator = new CompletionEvaluator({
      intelligence: fakeIntelligence as unknown as ConstructorParameters<typeof CompletionEvaluator>[0]['intelligence'],
      runCorrelationSink: sink,
    });
    await evaluator.evaluate('the goal is met', 'transcript tail', undefined, { topicId: '11960', runId: 'run-7' });
    expect(calls).toEqual([['11960', 'run-7', 'completion', 'd-corr-abc']]);
  });
});

describe('perPointSubBudget — §5.5 fairness sub-budget (the SUBBUDGET_IMPLEMENTED primitive)', () => {
  it('returns the FULL budget for a single point (byte-identical to the pre-sub-budget behavior)', () => {
    expect(perPointSubBudget(200, 1)).toBe(200);
    // Today the pass drives exactly one point → the slice IS the whole budget.
    expect(GRADE_PASS_POINTS.length).toBe(1);
    expect(perPointSubBudget(200, GRADE_PASS_POINTS.length)).toBe(200);
  });

  it('divides the global budget evenly so no point can consume a whole pass (a second point → half each)', () => {
    expect(perPointSubBudget(200, 2)).toBe(100);
    expect(perPointSubBudget(201, 2)).toBe(100); // floored
    expect(perPointSubBudget(10, 3)).toBe(3); // ⌊10/3⌋
  });

  it('floors at 1 so every point always makes some progress (never a zero slice that starves a point)', () => {
    expect(perPointSubBudget(1, 5)).toBe(1);
    expect(perPointSubBudget(0, 1)).toBe(1);
    expect(perPointSubBudget(200, 0)).toBe(200); // degenerate count clamps to 1
  });
});
