/**
 * Unit tests for the FeatureMetricsLedger decision-quality substrate
 * (llm-decision-quality-meter §5.5): the four additive tables, THE canonical
 * winning-grade derivation (one view, both consumers), rollup mutation
 * semantics (decision-day bucket, decrement-on-supersede, bounded reconcile
 * self-repair), retention prunes, and injected-clock discipline.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import type { DecisionOutcomeUpsert, GradingRung, DecisionGrade } from '../../src/monitoring/FeatureMetricsLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DAY = 86_400_000;
/** Mid-day UTC so ±hours never cross a day boundary by accident. */
const T0 = Date.parse('2026-07-01T12:00:00.000Z'); // day '2026-07-01'

let ledger: FeatureMetricsLedger | null = null;
/** Raw handle onto the SAME in-memory DB the ledger opened (schema assertions). */
let raw: BetterSqliteDatabase | null = null;

function newLedger(now?: () => number): FeatureMetricsLedger {
  ledger = new FeatureMetricsLedger({
    dbPath: ':memory:',
    now,
    databaseFactory: () => {
      raw = new Database(':memory:');
      return raw;
    },
  });
  return ledger;
}

afterEach(() => {
  ledger?.close();
  ledger = null;
  raw = null;
});

function decision(
  l: FeatureMetricsLedger,
  correlationId: string,
  opts: { point?: string; ts?: number } = {},
): void {
  l.recordDecision({
    correlationId,
    decisionPoint: opts.point ?? 'external-hog-kill',
    feature: 'ExternalHogSentinel',
    verdictClass: 'kill',
    mintedBy: 'router',
    volumeClass: 'full',
    contentClass: 'metadata',
    machineId: 'abcd1234',
    model: 'claude-haiku-4-5',
    framework: 'claude-code',
    promptId: 'hog-classify-v1',
    ts: opts.ts,
  });
}

function outcome(
  l: FeatureMetricsLedger,
  correlationId: string,
  gradedBy: string,
  rung: GradingRung,
  grade: DecisionGrade,
  opts: Partial<DecisionOutcomeUpsert> = {},
) {
  return l.upsertOutcome({
    correlationId,
    gradedBy,
    ruleId: opts.ruleId ?? 'hog-respawn-wrong-v1',
    rung,
    evidenceStrength: opts.evidenceStrength ?? 'deterministic-proof',
    grade,
    effectiveWindowMs: opts.effectiveWindowMs,
    evidenceNote: opts.evidenceNote,
    decisionPoint: opts.decisionPoint,
    ts: opts.ts,
  });
}

function bucket(l: FeatureMetricsLedger, point: string, day: string) {
  return l.decisionQualityRollupDaily().find((b) => b.decisionPoint === point && b.day === day);
}

describe('FeatureMetricsLedger — decision-quality substrate (§5.5)', () => {
  it('creates the four quality tables + the canonical view + the partial verdict_id index at open', () => {
    newLedger(() => T0);
    const names = (raw!
      .prepare(`SELECT name, type FROM sqlite_master`)
      .all() as Array<{ name: string; type: string }>);
    const tables = new Set(names.filter((n) => n.type === 'table').map((n) => n.name));
    const views = new Set(names.filter((n) => n.type === 'view').map((n) => n.name));
    const indexes = new Set(names.filter((n) => n.type === 'index').map((n) => n.name));
    expect(tables.has('decision_quality')).toBe(true);
    expect(tables.has('decision_outcomes')).toBe(true);
    expect(tables.has('decision_quality_rollup')).toBe(true);
    expect(tables.has('decision_grading_cursor')).toBe(true);
    expect(views.has('decision_winning_grade')).toBe(true);
    expect(indexes.has('idx_decision_quality_point_ts')).toBe(true);
    expect(indexes.has('idx_decision_outcomes_ts')).toBe(true);
    expect(indexes.has('idx_feature_metrics_verdict_id')).toBe(true);
  });

  it('open is idempotent on an existing DB file (re-open never throws, rows survive)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-metrics-quality-'));
    const dbPath = path.join(dir, 'metrics.db');
    try {
      const a = new FeatureMetricsLedger({ dbPath, now: () => T0 });
      decision(a, 'd-abcd1234-one');
      a.close();
      const b = new FeatureMetricsLedger({ dbPath, now: () => T0 }); // second open: all DDL re-runs
      decision(b, 'd-abcd1234-two');
      const res = outcome(b, 'd-abcd1234-one', 'grader', 'deterministic-ground-truth', 'right');
      expect(res).toEqual({ applied: true, orphan: false });
      expect(bucket(b, 'external-hog-kill', '2026-07-01')?.right).toBe(1);
      b.close();
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/FeatureMetricsLedger-quality.test.ts:cleanup' });
    }
  });

  it('recordDecision is write-once per correlation id (a duplicate settle never rewrites)', () => {
    const l = newLedger(() => T0);
    decision(l, 'd-abcd1234-dup', { point: 'first-point', ts: T0 });
    decision(l, 'd-abcd1234-dup', { point: 'second-point', ts: T0 + 1000 });
    const rows = raw!
      .prepare(`SELECT decision_point AS p, ts FROM decision_quality WHERE correlation_id = ?`)
      .all('d-abcd1234-dup') as Array<{ p: string; ts: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].p).toBe('first-point');
    expect(rows[0].ts).toBe(T0);
  });

  it('upsertOutcome is idempotent on (correlation_id, graded_by) — a re-grade supersedes, never multiplies', () => {
    const l = newLedger(() => T0);
    decision(l, 'd-abcd1234-a');
    outcome(l, 'd-abcd1234-a', 'grader-x', 'recurrence', 'right');
    outcome(l, 'd-abcd1234-a', 'grader-x', 'recurrence', 'wrong');
    const rows = raw!
      .prepare(`SELECT grade FROM decision_outcomes WHERE correlation_id = ?`)
      .all('d-abcd1234-a') as Array<{ grade: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].grade).toBe('wrong');
  });

  it('canonical derivation: a higher rung wins regardless of insertion order (self-report never overrides independent)', () => {
    const l = newLedger(() => T0);
    // d1: weak first, strong second.
    decision(l, 'd-abcd1234-r1');
    outcome(l, 'd-abcd1234-r1', 'actor', 'self-report', 'wrong', { ruleId: 'enacted-self-v1', evidenceStrength: 'self-report' });
    outcome(l, 'd-abcd1234-r1', 'grader', 'deterministic-ground-truth', 'right');
    // d2: strong first, weak second (order independence).
    decision(l, 'd-abcd1234-r2');
    outcome(l, 'd-abcd1234-r2', 'grader', 'deterministic-ground-truth', 'right');
    outcome(l, 'd-abcd1234-r2', 'actor', 'self-report', 'wrong', { ruleId: 'enacted-self-v1', evidenceStrength: 'self-report' });
    // d3: an independent recurrence grader beats a MORE conservative self-report.
    decision(l, 'd-abcd1234-r3');
    outcome(l, 'd-abcd1234-r3', 'recur', 'recurrence', 'right', { ruleId: 'hog-leave-recurrence-v1', evidenceStrength: 'recurrence-proxy' });
    outcome(l, 'd-abcd1234-r3', 'actor', 'self-report', 'wrong', { ruleId: 'enacted-self-v1', evidenceStrength: 'self-report' });

    const wins = new Map(l.getWinningGrades(['d-abcd1234-r1', 'd-abcd1234-r2', 'd-abcd1234-r3']).map((w) => [w.correlationId, w]));
    expect(wins.get('d-abcd1234-r1')?.grade).toBe('right');
    expect(wins.get('d-abcd1234-r1')?.rung).toBe('deterministic-ground-truth');
    expect(wins.get('d-abcd1234-r2')?.grade).toBe('right');
    expect(wins.get('d-abcd1234-r3')?.grade).toBe('right');
    expect(wins.get('d-abcd1234-r3')?.rung).toBe('recurrence');
    // Chunking path: a >500-id IN list returns the same graded rows.
    const many = Array.from({ length: 600 }, (_, i) => `d-abcd1234-missing-${i}`).concat(['d-abcd1234-r1']);
    const chunked = l.getWinningGrades(many);
    expect(chunked).toHaveLength(1);
    expect(chunked[0].correlationId).toBe('d-abcd1234-r1');
    // The ROLLUP consumes the same derivation: 3 decisions, all winning 'right'.
    const b = bucket(l, 'external-hog-kill', '2026-07-01')!;
    expect(b.right).toBe(3);
    expect(b.wrong).toBe(0);
    expect(b.unknown).toBe(0);
  });

  it('canonical derivation: within-rung conflicts resolve conservatively (wrong > unknown > right)', () => {
    const l = newLedger(() => T0);
    decision(l, 'd-abcd1234-w1');
    outcome(l, 'd-abcd1234-w1', 'grader-a', 'recurrence', 'right');
    outcome(l, 'd-abcd1234-w1', 'grader-b', 'recurrence', 'unknown');
    expect(l.getWinningGrades(['d-abcd1234-w1'])[0].grade).toBe('unknown');
    outcome(l, 'd-abcd1234-w1', 'grader-c', 'recurrence', 'wrong');
    expect(l.getWinningGrades(['d-abcd1234-w1'])[0].grade).toBe('wrong');
    const b = bucket(l, 'external-hog-kill', '2026-07-01')!;
    expect(b.wrong).toBe(1);
    expect(b.unknown).toBe(0);
    expect(b.right).toBe(0);
  });

  it('rollup: the bucket is the DECISION\'s UTC day, not the outcome\'s (late evidence)', () => {
    const l = newLedger(() => T0);
    decision(l, 'd-abcd1234-late', { ts: T0 }); // 2026-07-01
    const res = outcome(l, 'd-abcd1234-late', 'grader', 'deterministic-ground-truth', 'right', { ts: T0 + 3 * DAY }); // outcome on 07-04
    expect(res.orphan).toBe(false);
    expect(bucket(l, 'external-hog-kill', '2026-07-01')?.right).toBe(1);
    expect(bucket(l, 'external-hog-kill', '2026-07-04')).toBeUndefined();
  });

  it('rollup decrement-on-supersede: a grade flip moves the bucket, never double-counts', () => {
    const l = newLedger(() => T0);
    decision(l, 'd-abcd1234-flip');
    outcome(l, 'd-abcd1234-flip', 'grader', 'deterministic-ground-truth', 'right');
    let b = bucket(l, 'external-hog-kill', '2026-07-01')!;
    expect(b.right).toBe(1);
    expect(b.wrong).toBe(0);
    outcome(l, 'd-abcd1234-flip', 'grader', 'deterministic-ground-truth', 'wrong'); // supersede
    b = bucket(l, 'external-hog-kill', '2026-07-01')!;
    expect(b.right).toBe(0);
    expect(b.wrong).toBe(1);
    expect(b.right + b.wrong + b.unknown).toBe(1); // exactly once under its winning grade
  });

  it('orphan outcome (FD10): stored + counted under the hint point, never a graded decision', () => {
    const l = newLedger(() => T0);
    const res = outcome(l, 'd-ffff0000-elsewhere', 'grader', 'deterministic-ground-truth', 'wrong', {
      decisionPoint: 'external-hog-kill',
      ts: T0,
    });
    expect(res).toEqual({ applied: true, orphan: true });
    const b = bucket(l, 'external-hog-kill', '2026-07-01')!;
    expect(b.orphanOutcomes).toBe(1);
    expect(b.right + b.wrong + b.unknown).toBe(0);
    // The outcome ROW exists (visible loss, never silent).
    const rows = raw!.prepare(`SELECT COUNT(*) AS n FROM decision_outcomes`).get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('bumpQualityCounter increments joinMiss / droppedByBudget and survives bucket recompute', () => {
    const l = newLedger(() => T0);
    l.bumpQualityCounter('external-hog-kill', 'joinMiss');
    l.bumpQualityCounter('external-hog-kill', 'joinMiss');
    l.bumpQualityCounter('external-hog-kill', 'droppedByBudget', { n: 3 });
    let b = bucket(l, 'external-hog-kill', '2026-07-01')!;
    expect(b.joinMiss).toBe(2);
    expect(b.droppedByBudget).toBe(3);
    // A grade landing in the same bucket recomputes grade counts but PRESERVES counters.
    decision(l, 'd-abcd1234-c1');
    outcome(l, 'd-abcd1234-c1', 'grader', 'deterministic-ground-truth', 'right');
    b = bucket(l, 'external-hog-kill', '2026-07-01')!;
    expect(b.right).toBe(1);
    expect(b.joinMiss).toBe(2);
    expect(b.droppedByBudget).toBe(3);
  });

  it('reconcileQualityRollup self-repairs a hand-corrupted bucket + restores a deleted one, preserving event counters', () => {
    const l = newLedger(() => T0);
    decision(l, 'd-abcd1234-h1');
    outcome(l, 'd-abcd1234-h1', 'grader', 'deterministic-ground-truth', 'right');
    l.bumpQualityCounter('external-hog-kill', 'joinMiss');
    // Hand-corrupt the bucket.
    raw!.prepare(`UPDATE decision_quality_rollup SET right_count = 999, wrong_count = 7 WHERE decision_point = ?`).run('external-hog-kill');
    let written = l.reconcileQualityRollup(30);
    expect(written).toBeGreaterThanOrEqual(1);
    let b = bucket(l, 'external-hog-kill', '2026-07-01')!;
    expect(b.right).toBe(1);
    expect(b.wrong).toBe(0);
    expect(b.joinMiss).toBe(1); // event counter preserved
    // Hand-DELETE the bucket entirely — reconcile restores the grade counts.
    raw!.prepare(`DELETE FROM decision_quality_rollup`).run();
    written = l.reconcileQualityRollup(30);
    expect(written).toBeGreaterThanOrEqual(1);
    b = bucket(l, 'external-hog-kill', '2026-07-01')!;
    expect(b.right).toBe(1);
    expect(l.lastQualityReconcileMs()).toBe(T0);
  });

  it('reconcile window is bounded: buckets older than the window are left untouched', () => {
    let t = T0;
    const l = newLedger(() => t);
    decision(l, 'd-abcd1234-old', { ts: T0 - 40 * DAY });
    outcome(l, 'd-abcd1234-old', 'grader', 'deterministic-ground-truth', 'right', { ts: T0 - 40 * DAY });
    const oldDay = new Date(T0 - 40 * DAY).toISOString().slice(0, 10);
    expect(bucket(l, 'external-hog-kill', oldDay)?.right).toBe(1);
    // Corrupt the out-of-window bucket; a 30d reconcile must NOT touch it.
    raw!.prepare(`UPDATE decision_quality_rollup SET right_count = 999 WHERE day = ?`).run(oldDay);
    l.reconcileQualityRollup(30);
    expect(bucket(l, 'external-hog-kill', oldDay)?.right).toBe(999);
  });

  it('evidence_note is clamped to 500 chars and effective_window_ms is recorded', () => {
    const l = newLedger(() => T0);
    decision(l, 'd-abcd1234-n1');
    outcome(l, 'd-abcd1234-n1', 'grader', 'deterministic-ground-truth', 'wrong', {
      evidenceNote: 'x'.repeat(1000),
      effectiveWindowMs: 21_600_000,
    });
    const row = raw!
      .prepare(`SELECT evidence_note AS note, effective_window_ms AS w FROM decision_outcomes WHERE correlation_id = ?`)
      .get('d-abcd1234-n1') as { note: string; w: number };
    expect(row.note).toHaveLength(500);
    expect(row.w).toBe(21_600_000);
  });

  it('refuses invalid grade / rung / missing keys (counted rejection is the chokepoint\'s job — the substrate just never stores garbage)', () => {
    const l = newLedger(() => T0);
    decision(l, 'd-abcd1234-bad');
    expect(
      l.upsertOutcome({
        correlationId: 'd-abcd1234-bad', gradedBy: 'g', ruleId: 'r-v1',
        rung: 'deterministic-ground-truth', evidenceStrength: 'deterministic-proof',
        grade: 'maybe' as never,
      }).reason,
    ).toBe('invalid-grade');
    expect(
      l.upsertOutcome({
        correlationId: 'd-abcd1234-bad', gradedBy: 'g', ruleId: 'r-v1',
        rung: 'vibes' as never, evidenceStrength: 'deterministic-proof', grade: 'right',
      }).reason,
    ).toBe('invalid-rung');
    expect(
      l.upsertOutcome({
        correlationId: '', gradedBy: 'g', ruleId: 'r-v1',
        rung: 'self-report', evidenceStrength: 'self-report', grade: 'right',
      }).reason,
    ).toBe('missing-key');
    const n = (raw!.prepare(`SELECT COUNT(*) AS n FROM decision_outcomes`).get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('grading cursor: set/get roundtrip with recheck-backoff state, stamped by the injected clock', () => {
    let t = T0;
    const l = newLedger(() => t);
    expect(l.getGradingCursor('external-hog-kill')).toBeNull();
    l.setGradingCursor('external-hog-kill', { cursorTs: T0 - DAY, cursorCorrelationId: 'd-abcd1234-x', nextRecheckTs: T0 + DAY, attempts: 2 });
    const c = l.getGradingCursor('external-hog-kill')!;
    expect(c.cursorTs).toBe(T0 - DAY);
    expect(c.cursorCorrelationId).toBe('d-abcd1234-x');
    expect(c.nextRecheckTs).toBe(T0 + DAY);
    expect(c.attempts).toBe(2);
    expect(c.updatedAt).toBe(T0); // injected clock, not wall clock
    t = T0 + 5000;
    l.setGradingCursor('external-hog-kill', { cursorTs: T0, cursorCorrelationId: 'd-abcd1234-y' });
    const c2 = l.getGradingCursor('external-hog-kill')!;
    expect(c2.cursorCorrelationId).toBe('d-abcd1234-y');
    expect(c2.nextRecheckTs).toBeNull();
    expect(c2.updatedAt).toBe(T0 + 5000);
  });

  it('prunes: decision_quality/outcomes/rollup age out on their horizons; outcomes floor at 30d', () => {
    let t = T0;
    const l = newLedger(() => t);
    decision(l, 'd-abcd1234-p-old', { ts: T0 - 100 * DAY });
    decision(l, 'd-abcd1234-p-new', { ts: T0 - DAY });
    expect(l.pruneDecisionQuality(90)).toBe(1);
    const left = raw!.prepare(`SELECT correlation_id AS id FROM decision_quality`).all() as Array<{ id: string }>;
    expect(left.map((r) => r.id)).toEqual(['d-abcd1234-p-new']);

    // Outcomes: retention floors at 30d — a mis-tuned 1d knob prunes only >30d rows.
    outcome(l, 'd-abcd1234-o-old', 'g', 'self-report', 'right', { ts: T0 - 40 * DAY, decisionPoint: 'p', evidenceStrength: 'self-report' });
    outcome(l, 'd-abcd1234-o-new', 'g', 'self-report', 'right', { ts: T0 - 10 * DAY, decisionPoint: 'p', evidenceStrength: 'self-report' });
    expect(l.pruneDecisionOutcomes(1)).toBe(1);
    const oleft = raw!.prepare(`SELECT correlation_id AS id FROM decision_outcomes`).all() as Array<{ id: string }>;
    expect(oleft.map((r) => r.id)).toEqual(['d-abcd1234-o-new']);

    // Rollup: day-keyed horizon.
    l.bumpQualityCounter('p-old-bucket', 'joinMiss', { ts: T0 - 100 * DAY });
    l.bumpQualityCounter('p-new-bucket', 'joinMiss', { ts: T0 });
    expect(l.pruneQualityRollup(90)).toBeGreaterThanOrEqual(1);
    const days = (raw!.prepare(`SELECT DISTINCT day FROM decision_quality_rollup ORDER BY day`).all() as Array<{ day: string }>).map((r) => r.day);
    expect(days).not.toContain(new Date(T0 - 100 * DAY).toISOString().slice(0, 10));
    // Disabled retention (0/negative) prunes nothing.
    expect(l.pruneDecisionQuality(0)).toBe(0);
    expect(l.pruneQualityRollup(-1)).toBe(0);
  });

  it('cursor prune: a registered decision point is NEVER pruned; only stale unknown points age out', () => {
    let t = T0;
    const l = newLedger(() => t);
    l.setGradingCursor('p-registered', { cursorTs: 1, cursorCorrelationId: 'a' });
    l.setGradingCursor('p-abandoned', { cursorTs: 1, cursorCorrelationId: 'b' });
    t = T0 + 100 * DAY;
    l.setGradingCursor('p-fresh', { cursorTs: 1, cursorCorrelationId: 'c' });
    const pruned = l.pruneGradingCursors(90, { registeredDecisionPoints: ['p-registered'] });
    expect(pruned).toBe(1);
    expect(l.getGradingCursor('p-registered')).not.toBeNull(); // registered: held despite staleness
    expect(l.getGradingCursor('p-abandoned')).toBeNull();      // unknown + stale: pruned
    expect(l.getGradingCursor('p-fresh')).not.toBeNull();      // unknown but fresh: held
  });

  it('prune batches are bounded (PRUNE_BATCH × maxBatches per call)', () => {
    let t = T0;
    const l = newLedger(() => t);
    const insert = raw!.prepare(`INSERT INTO decision_quality (correlation_id, decision_point, ts) VALUES (?, ?, ?)`);
    const tx = raw!.transaction(() => {
      for (let i = 0; i < 5001; i++) insert.run(`d-abcd1234-b${i}`, 'p', T0 - 100 * DAY);
    });
    tx();
    t = T0; // cutoff at 90d — all 5001 are older
    expect(l.pruneDecisionQuality(90, { maxBatches: 1 })).toBe(5000); // bounded: one batch
    expect(l.pruneDecisionQuality(90)).toBe(1); // next tick drains the remainder
  });

  it('injected-clock discipline: defaulted timestamps derive from now(), never the wall clock', () => {
    const ancient = Date.parse('2001-01-01T06:00:00.000Z');
    const l = newLedger(() => ancient);
    decision(l, 'd-abcd1234-clock'); // no ts → now()
    outcome(l, 'd-abcd1234-clock', 'grader', 'deterministic-ground-truth', 'right'); // no ts → now()
    const b = l.decisionQualityRollupDaily();
    expect(b).toHaveLength(1);
    expect(b[0].day).toBe('2001-01-01'); // a Date.now() leak would land in the real today
    expect(b[0].right).toBe(1);
  });

  it('never throws into a caller: every quality method is safe after close()', () => {
    const l = newLedger(() => T0);
    decision(l, 'd-abcd1234-z');
    l.close();
    expect(() => decision(l, 'd-abcd1234-z2')).not.toThrow();
    const res = outcome(l, 'd-abcd1234-z', 'g', 'self-report', 'right', { evidenceStrength: 'self-report' });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('closed');
    expect(() => l.bumpQualityCounter('p', 'joinMiss')).not.toThrow();
    expect(l.getWinningGrades(['d-abcd1234-z'])).toEqual([]);
    expect(l.reconcileQualityRollup(30)).toBe(0);
    expect(l.pruneDecisionQuality(90)).toBe(0);
    expect(l.pruneDecisionOutcomes(90)).toBe(0);
    expect(l.pruneQualityRollup(90)).toBe(0);
    expect(l.pruneGradingCursors(90)).toBe(0);
    expect(l.getGradingCursor('p')).toBeNull();
    expect(() => l.setGradingCursor('p', { cursorTs: 1, cursorCorrelationId: 'a' })).not.toThrow();
    expect(l.decisionQualityRollupDaily()).toEqual([]);
  });
});
