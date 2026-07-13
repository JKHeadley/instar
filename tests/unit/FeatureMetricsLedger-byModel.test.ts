/**
 * Unit tests for the Benchmark-Divergence Detector's meter-extension (stage 2)
 * substrate in FeatureMetricsLedger (benchmark-divergence-detector §Durable
 * schema): the parallel `decision_quality_rollup_by_model` table maintained in
 * the SAME transaction as the meter's rollup at the annotate chokepoint,
 * `decided_total` recomputed from raw DECISION rows (never outcome rows),
 * decisions-only-day materialization, '__missing__' refusal, freeze-don't-zero
 * beyond the raw floor, the one-time backfill, its own retention knob, the FD7
 * loss-accounting watermark, and the FD11 findings latest-view + capped history.
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
let raw: BetterSqliteDatabase | null = null;

function newLedger(now?: () => number, opts: { rawRetentionDays?: number } = {}): FeatureMetricsLedger {
  ledger = new FeatureMetricsLedger({
    dbPath: ':memory:',
    now,
    databaseFactory: () => {
      raw = new Database(':memory:');
      return raw;
    },
    ...(opts.rawRetentionDays !== undefined ? { rawRetentionDays: opts.rawRetentionDays } : {}),
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
  opts: { point?: string; ts?: number; model?: string; promptId?: string } = {},
): void {
  l.recordDecision({
    correlationId,
    decisionPoint: opts.point ?? 'external-hog-kill-leave',
    feature: 'ExternalHogClassifier',
    verdictClass: 'kill',
    mintedBy: 'router',
    volumeClass: 'full',
    contentClass: 'metadata',
    machineId: 'abcd1234',
    model: opts.model ?? 'claude-haiku-4-5-20251001',
    framework: 'claude-code',
    promptId: opts.promptId ?? 'hog-classify-v1',
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
    ts: opts.ts,
    decisionPoint: opts.decisionPoint,
  });
}

function byModelRow(point: string, model: string, day: string) {
  return raw!
    .prepare(
      `SELECT right_n AS rightN, wrong_n AS wrongN, unknown_n AS unknownN,
              decided_total AS decidedTotal, prompt_id AS promptId
         FROM decision_quality_rollup_by_model
        WHERE decision_point = ? AND model = ? AND day = ?`,
    )
    .get(point, model, day) as
    | { rightN: number; wrongN: number; unknownN: number; decidedTotal: number; promptId: string | null }
    | undefined;
}

describe('decision_quality_rollup_by_model — stage-2 substrate', () => {
  it('creates the parallel table + its day index + the detector tables at open', () => {
    newLedger(() => T0);
    const names = (raw!.prepare(`SELECT name, type FROM sqlite_master`).all() as Array<{ name: string; type: string }>);
    const tables = new Set(names.filter((n) => n.type === 'table').map((n) => n.name));
    const indexes = new Set(names.filter((n) => n.type === 'index').map((n) => n.name));
    expect(tables.has('decision_quality_rollup_by_model')).toBe(true);
    expect(tables.has('benchmark_divergence_findings')).toBe(true);
    expect(tables.has('benchmark_divergence_findings_history')).toBe(true);
    expect(tables.has('benchmark_analysis_watermark')).toBe(true);
    expect(indexes.has('idx_decision_quality_rollup_by_model_day')).toBe(true);
  });

  it('one annotate recomputes BOTH tables in the same transaction (chokepoint arm)', () => {
    const l = newLedger(() => T0);
    decision(l, 'c1');
    decision(l, 'c2');
    decision(l, 'c3'); // never graded — decided_total still counts it
    outcome(l, 'c1', 'grader', 'deterministic-ground-truth', 'right');
    outcome(l, 'c2', 'grader', 'deterministic-ground-truth', 'wrong');
    // The meter's own rollup (existing behavior — byte-identical).
    const meterBucket = l.decisionQualityRollupDaily().find((b) => b.decisionPoint === 'external-hog-kill-leave');
    expect(meterBucket?.right).toBe(1);
    expect(meterBucket?.wrong).toBe(1);
    // The parallel by_model bucket — same transaction, decided_total from the
    // DECISION spine (3 recorded decisions, only 2 graded).
    const row = byModelRow('external-hog-kill-leave', 'claude-haiku-4-5-20251001', '2026-07-01');
    expect(row).toBeDefined();
    expect(row!.rightN).toBe(1);
    expect(row!.wrongN).toBe(1);
    expect(row!.decidedTotal).toBe(3);
    expect(row!.promptId).toBe('hog-classify-v1');
  });

  it('a SENTINEL-landed superseding wrong grade flips the by_model bucket (not just the grading pass)', () => {
    const l = newLedger(() => T0);
    decision(l, 'c1');
    // The grading pass lands a self-report 'right'…
    outcome(l, 'c1', 'grading-pass', 'self-report', 'right');
    expect(byModelRow('external-hog-kill-leave', 'claude-haiku-4-5-20251001', '2026-07-01')!.rightN).toBe(1);
    // …then a SENTINEL lands deterministic ground truth 'wrong' (higher rung).
    outcome(l, 'c1', 'hog-sentinel', 'deterministic-ground-truth', 'wrong');
    const row = byModelRow('external-hog-kill-leave', 'claude-haiku-4-5-20251001', '2026-07-01')!;
    expect(row.rightN).toBe(0); // recompute-from-raw is supersede-correct
    expect(row.wrongN).toBe(1);
    expect(row.decidedTotal).toBe(1);
  });

  it('an unknown→right regrade NETS counts (same grader re-run supersedes, never multiplies)', () => {
    const l = newLedger(() => T0);
    decision(l, 'c1');
    outcome(l, 'c1', 'grader', 'deterministic-ground-truth', 'unknown');
    expect(byModelRow('external-hog-kill-leave', 'claude-haiku-4-5-20251001', '2026-07-01')!.unknownN).toBe(1);
    outcome(l, 'c1', 'grader', 'deterministic-ground-truth', 'right');
    const row = byModelRow('external-hog-kill-leave', 'claude-haiku-4-5-20251001', '2026-07-01')!;
    expect(row.unknownN).toBe(0);
    expect(row.rightN).toBe(1);
    expect(row.decidedTotal).toBe(1); // never double-counted
  });

  it('a decisions-only day materializes a bucket: decided_total > 0, zero grade counts (via reconcile)', () => {
    const l = newLedger(() => T0);
    decision(l, 'c1');
    decision(l, 'c2');
    // No outcome at all — the reconcile arm must still materialize the bucket
    // (the unsettled-stream gate would be decorative otherwise).
    l.reconcileQualityRollup(30);
    const row = byModelRow('external-hog-kill-leave', 'claude-haiku-4-5-20251001', '2026-07-01')!;
    expect(row).toBeDefined();
    expect(row.decidedTotal).toBe(2);
    expect(row.rightN).toBe(0);
    expect(row.wrongN).toBe(0);
    expect(row.unknownN).toBe(0);
  });

  it('decided_total comes from DECISION rows through BOTH arms (chokepoint AND reconcile rebuild)', () => {
    const l = newLedger(() => T0);
    for (let i = 0; i < 5; i++) decision(l, `c${i}`);
    outcome(l, 'c0', 'grader', 'deterministic-ground-truth', 'right');
    // Chokepoint arm:
    expect(byModelRow('external-hog-kill-leave', 'claude-haiku-4-5-20251001', '2026-07-01')!.decidedTotal).toBe(5);
    // Reconcile rebuild arm (DELETE-then-INSERT from raw):
    l.reconcileQualityRollup(30);
    const row = byModelRow('external-hog-kill-leave', 'claude-haiku-4-5-20251001', '2026-07-01')!;
    expect(row.decidedTotal).toBe(5);
    expect(row.rightN).toBe(1);
  });

  it("an empty model id is REFUSED into '' and written under '__missing__'", () => {
    const l = newLedger(() => T0);
    decision(l, 'c1', { model: '' });
    outcome(l, 'c1', 'grader', 'deterministic-ground-truth', 'right');
    const row = byModelRow('external-hog-kill-leave', '__missing__', '2026-07-01')!;
    expect(row).toBeDefined();
    expect(row.rightN).toBe(1);
    expect(byModelRow('external-hog-kill-leave', '', '2026-07-01')).toBeUndefined();
  });

  it("mixed recorded prompt ids within a bucket collapse to '__mixed__'", () => {
    const l = newLedger(() => T0);
    decision(l, 'c1', { promptId: 'tone-gate-v1' });
    decision(l, 'c2', { promptId: 'tone-gate-v2' });
    outcome(l, 'c1', 'grader', 'deterministic-ground-truth', 'right');
    expect(byModelRow('external-hog-kill-leave', 'claude-haiku-4-5-20251001', '2026-07-01')!.promptId).toBe('__mixed__');
  });

  it('replayed reconcile is idempotent — no count/finding drift', () => {
    const l = newLedger(() => T0);
    for (let i = 0; i < 4; i++) decision(l, `c${i}`);
    outcome(l, 'c0', 'grader', 'deterministic-ground-truth', 'right');
    outcome(l, 'c1', 'grader', 'deterministic-ground-truth', 'wrong');
    const snapshot = () =>
      raw!.prepare(`SELECT decision_point, model, day, right_n, wrong_n, unknown_n, decided_total, prompt_id
                      FROM decision_quality_rollup_by_model ORDER BY decision_point, model, day`).all();
    l.reconcileQualityRollup(30);
    const first = snapshot();
    l.reconcileQualityRollup(30);
    l.reconcileQualityRollup(30);
    expect(snapshot()).toEqual(first);
  });

  it('freeze-don\'t-zero: the reconcile never zeroes a by_model day whose raw truth aged out', () => {
    // Raw retention 10 days; reconcile window 30 — days older than the raw
    // floor must be FROZEN at their last-good values, never rebuilt-to-zero.
    let nowMs = T0;
    const l = newLedger(() => nowMs, { rawRetentionDays: 10 });
    // A decision graded 20 days ago (within the 30d reconcile window, but
    // OLDER than the 10d raw retention once we prune).
    const oldTs = T0 - 20 * DAY;
    decision(l, 'c-old', { ts: oldTs });
    outcome(l, 'c-old', 'grader', 'deterministic-ground-truth', 'right', { ts: oldTs });
    const oldDay = new Date(oldTs).toISOString().slice(0, 10);
    expect(byModelRow('external-hog-kill-leave', 'claude-haiku-4-5-20251001', oldDay)!.rightN).toBe(1);
    // Raw ages out (the meter's prune deletes rows past retention).
    l.pruneDecisionQuality(10);
    expect(raw!.prepare(`SELECT COUNT(*) AS n FROM decision_quality`).get()).toEqual({ n: 0 });
    // The reconcile (window 30 > raw floor 10) must NOT zero the frozen day.
    l.reconcileQualityRollup(30);
    const frozen = byModelRow('external-hog-kill-leave', 'claude-haiku-4-5-20251001', oldDay);
    expect(frozen).toBeDefined();
    expect(frozen!.rightN).toBe(1); // counts survive — essence not destroyed
  });

  it('one-time backfill seeds per-model history from raw when the table is empty (post-migration path)', () => {
    const l = newLedger(() => T0);
    decision(l, 'c1');
    outcome(l, 'c1', 'grader', 'deterministic-ground-truth', 'right');
    // Simulate a pre-detector DB: wipe the by_model table, keep raw.
    raw!.prepare(`DELETE FROM decision_quality_rollup_by_model`).run();
    expect(byModelRow('external-hog-kill-leave', 'claude-haiku-4-5-20251001', '2026-07-01')).toBeUndefined();
    const seeded = l.backfillByModelRollupIfEmpty();
    expect(seeded).toBeGreaterThan(0);
    expect(byModelRow('external-hog-kill-leave', 'claude-haiku-4-5-20251001', '2026-07-01')!.rightN).toBe(1);
    // Idempotent: a non-empty table is a no-op.
    expect(l.backfillByModelRollupIfEmpty()).toBe(0);
  });

  it('pruneQualityRollupByModel prunes by its OWN retention knob', () => {
    const l = newLedger(() => T0);
    decision(l, 'c-old', { ts: T0 - 200 * DAY });
    decision(l, 'c-new');
    l.reconcileQualityRollup(365, { rawRetentionDays: 365 });
    expect(raw!.prepare(`SELECT COUNT(*) AS n FROM decision_quality_rollup_by_model`).get()).toEqual({ n: 2 });
    const pruned = l.pruneQualityRollupByModel(180);
    expect(pruned).toBe(1);
    expect(byModelRow('external-hog-kill-leave', 'claude-haiku-4-5-20251001', '2026-07-01')).toBeDefined();
  });

  it('detector reads/writes touch ZERO raw meter tables (wiring integrity: meter stores byte-identical)', () => {
    const l = newLedger(() => T0);
    decision(l, 'c1');
    outcome(l, 'c1', 'grader', 'deterministic-ground-truth', 'right');
    const rawDump = () => ({
      quality: raw!.prepare(`SELECT * FROM decision_quality ORDER BY correlation_id`).all(),
      outcomes: raw!.prepare(`SELECT * FROM decision_outcomes ORDER BY correlation_id, graded_by`).all(),
      rollup: raw!.prepare(`SELECT * FROM decision_quality_rollup ORDER BY decision_point, day`).all(),
    });
    const before = rawDump();
    // Every detector-owned ledger surface:
    l.byModelAggregates('2026-06-01', '2026-07-02');
    l.orphanAggregates('2026-06-01', '2026-07-02');
    l.listBenchmarkFindings();
    l.listBenchmarkWatermarks();
    l.advanceBenchmarkWatermark('m1', 'external-hog-kill-leave', 'claude-haiku-4-5-20251001', '2026-06-29', '2026-05-27');
    l.accrueBenchmarkWatermarkLoss('m1', '2026-06-01');
    l.pruneBenchmarkWatermarks(180);
    l.upsertBenchmarkFinding({
      taskId: 'zombie-classify', decisionPointId: 'external-hog-kill-leave', model: 'claude-haiku-4-5-20251001',
      verdict: 'aligned', realGradeRate: 1, predictedRate: 0.9, delta: 0.1, gradedN: 30, unknownShare: 0.1,
      ciHalfWidth: 0.1, benchN: 100, benchCiHalfWidth: 0.05, orphanTainted: false, chronic: false,
      chronicStreak: 0, coverageJson: '{}', dominantMachineShare: 1, benchedPromptHash: null,
      mirrorCapturedAt: null, windowFromDay: '2026-06-01', windowToDay: '2026-06-29', maxHistoryPerKey: 50,
    });
    expect(rawDump()).toEqual(before);
  });
});

describe('benchmark_analysis_watermark — FD7 loss accounting', () => {
  it('first-seen keys SEED at seedDay (churn-then-age-out: no months-long false-loss drip)', () => {
    const l = newLedger(() => T0);
    // A brand-new (machine, point, model) key with an ANCIENT throughDay must
    // seed at seedDay = today − maxDaysPerAnalysis, not the ancient value.
    l.advanceBenchmarkWatermark('m1', 'p', 'model-a', '2020-01-01', '2026-05-27');
    expect(l.listBenchmarkWatermarks()[0].analyzedThroughDay).toBe('2026-05-27');
    // Churn: the same key advances only FORWARD.
    l.advanceBenchmarkWatermark('m1', 'p', 'model-a', '2026-06-29', '2026-05-27');
    expect(l.listBenchmarkWatermarks()[0].analyzedThroughDay).toBe('2026-06-29');
    l.advanceBenchmarkWatermark('m1', 'p', 'model-a', '2026-06-01', '2026-05-27');
    expect(l.listBenchmarkWatermarks()[0].analyzedThroughDay).toBe('2026-06-29'); // never backward
    // Age-out past the retention edge accrues loss ONCE and advances the mark.
    const accrued = l.accrueBenchmarkWatermarkLoss('m1', '2026-07-04');
    expect(accrued).toBe(5); // 06-30..07-04
    expect(l.listBenchmarkWatermarks()[0].unanalyzedLoss).toBe(5);
    expect(l.listBenchmarkWatermarks()[0].analyzedThroughDay).toBe('2026-07-04');
    // Replay: nothing double-counted.
    expect(l.accrueBenchmarkWatermarkLoss('m1', '2026-07-04')).toBe(0);
    expect(l.listBenchmarkWatermarks()[0].unanalyzedLoss).toBe(5);
  });

  it('hygiene pruning ages out stale watermark rows', () => {
    let nowMs = T0;
    const l = newLedger(() => nowMs);
    l.advanceBenchmarkWatermark('m-stale', 'p', 'model-a', '2026-06-29', '2026-05-27');
    nowMs = T0 + 200 * DAY;
    l.advanceBenchmarkWatermark('m-live', 'p', 'model-a', '2026-12-29', '2026-11-27');
    expect(l.pruneBenchmarkWatermarks(180)).toBe(1);
    expect(l.listBenchmarkWatermarks().map((w) => w.machineId)).toEqual(['m-live']);
  });
});

describe('benchmark_divergence_findings — FD11 latest view + capped history', () => {
  function finding(overrides: Partial<Parameters<FeatureMetricsLedger['upsertBenchmarkFinding']>[0]> = {}) {
    return {
      taskId: 'tone-gate', decisionPointId: 'messaging-tone-gate', model: 'claude-opus-4-8',
      verdict: 'aligned', preconditionReason: null, realGradeRate: 0.9, predictedRate: 0.92, delta: -0.02,
      gradedN: 40, unknownShare: 0.2, ciHalfWidth: 0.08, benchN: 120, benchCiHalfWidth: 0.04,
      orphanTainted: false, chronic: false, chronicStreak: 0, chronicReason: null, coverageJson: '{}',
      dominantMachineShare: 0.6, unmapped: null, benchedPromptHash: 'a'.repeat(64), mirrorCapturedAt: '2026-06-20T00:00:00.000Z',
      windowFromDay: '2026-05-26', windowToDay: '2026-06-29', maxHistoryPerKey: 5,
      ...overrides,
    } as Parameters<FeatureMetricsLedger['upsertBenchmarkFinding']>[0];
  }

  it('latest-view upsert per key; same-day re-analysis UPSERTS history, never appends', () => {
    const l = newLedger(() => T0);
    l.upsertBenchmarkFinding(finding({ verdict: 'aligned' }));
    l.upsertBenchmarkFinding(finding({ verdict: 'divergent-worse' })); // same key + same (toDay, mirrorCapturedAt)
    const latest = l.listBenchmarkFindings();
    expect(latest).toHaveLength(1);
    expect(latest[0].verdict).toBe('divergent-worse');
    const hist = l.listBenchmarkFindingHistory('tone-gate', 'messaging-tone-gate', 'claude-opus-4-8');
    expect(hist).toHaveLength(1); // upserted, not appended
    expect(hist[0].verdict).toBe('divergent-worse');
  });

  it('history cap prunes oldest EXCEPT the first row per key (the first detection is never evicted)', () => {
    let nowMs = T0;
    const l = newLedger(() => nowMs);
    for (let i = 0; i < 9; i++) {
      nowMs = T0 + i * DAY;
      l.upsertBenchmarkFinding(finding({ windowToDay: `2026-07-${String(i + 1).padStart(2, '0')}`, maxHistoryPerKey: 5 }));
    }
    const hist = l.listBenchmarkFindingHistory('tone-gate', 'messaging-tone-gate', 'claude-opus-4-8');
    expect(hist).toHaveLength(5); // capped
    // The FIRST history row (windowToDay 2026-07-01) is retained permanently.
    expect(hist[0].windowToDay).toBe('2026-07-01');
    // The rest are the newest cap-1 rows.
    expect(hist.map((h) => h.windowToDay).slice(1)).toEqual(['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09']);
  });

  it('findings latest view is ordered (window_to_day DESC, last_seen_at DESC)', () => {
    let nowMs = T0;
    const l = newLedger(() => nowMs);
    l.upsertBenchmarkFinding(finding({ model: 'model-old', windowToDay: '2026-06-20' }));
    nowMs = T0 + DAY;
    l.upsertBenchmarkFinding(finding({ model: 'model-new', windowToDay: '2026-06-29' }));
    const rows = l.listBenchmarkFindings();
    expect(rows.map((r) => r.model)).toEqual(['model-new', 'model-old']);
  });
});

describe('backup round-trip (spec §Backup)', () => {
  it('a file-backed DB reopened elsewhere preserves finding + by_model counts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-backup-'));
    const dbPath = path.join(dir, 'feature-metrics.db');
    try {
      const l1 = new FeatureMetricsLedger({ dbPath, now: () => T0 });
      l1.recordDecision({
        correlationId: 'c1', decisionPoint: 'messaging-tone-gate', feature: 'MessagingToneGate',
        verdictClass: 'pass', mintedBy: 'router', volumeClass: 'full', contentClass: 'metadata',
        machineId: 'abcd1234', model: 'claude-opus-4-8', framework: 'claude-code', promptId: 'tone-gate-v1',
      });
      l1.upsertOutcome({
        correlationId: 'c1', gradedBy: 'g', ruleId: 'r', rung: 'deterministic-ground-truth',
        evidenceStrength: 'deterministic-proof', grade: 'right',
      });
      l1.upsertBenchmarkFinding({
        taskId: 'tone-gate', decisionPointId: 'messaging-tone-gate', model: 'claude-opus-4-8',
        verdict: 'aligned', realGradeRate: 1, predictedRate: 0.95, delta: 0.05, gradedN: 25, unknownShare: 0,
        ciHalfWidth: 0.1, benchN: 100, benchCiHalfWidth: 0.05, orphanTainted: false, chronic: false,
        chronicStreak: 0, coverageJson: '{}', dominantMachineShare: 1, benchedPromptHash: null,
        mirrorCapturedAt: null, windowFromDay: '2026-05-26', windowToDay: '2026-06-29', maxHistoryPerKey: 50,
      });
      l1.close();

      // The backup: a byte copy of the DB file, restored + reopened.
      const restoredPath = path.join(dir, 'restored.db');
      fs.copyFileSync(dbPath, restoredPath);
      const l2 = new FeatureMetricsLedger({ dbPath: restoredPath, now: () => T0 });
      expect(l2.listBenchmarkFindings()).toHaveLength(1);
      const agg = l2.byModelAggregates('2026-07-01', '2026-07-01');
      expect(agg).toHaveLength(1);
      expect(agg[0]).toMatchObject({ model: 'claude-opus-4-8', rightN: 1, decidedTotal: 1 });
      l2.close();
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/FeatureMetricsLedger-byModel.test.ts' });
    }
  });
});
