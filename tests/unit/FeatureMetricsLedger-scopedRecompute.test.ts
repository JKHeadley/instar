/**
 * FeatureMetricsLedger — the bucket recompute ranks only its own bucket's outcomes.
 *
 * Every graded decision recomputes its (decision_point, day) rollup bucket. Joining
 * the `decision_winning_grade` view for that ranked the WHOLE outcomes table first,
 * so the cost of one annotation grew with the table (about 100 ms a query at 62,000
 * outcomes, twice per annotation, up to 200 annotations in one synchronous grading
 * pass: over a minute on the server's event loop, 2026-11-13).
 *
 * These tests hold the scoped recompute to two things: it gives exactly the answer
 * the view gives, and it does not scan the outcomes table.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import {
  FeatureMetricsLedger, BUCKET_WINNING_GRADE_SQL, WINNING_GRADE_RANK_SQL,
  type DecisionGrade, type GradingRung,
} from '../../src/monitoring/FeatureMetricsLedger.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-07-01T12:00:00.000Z');
const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
const DAY_START = Date.parse('2026-07-01T00:00:00.000Z');

let ledger: FeatureMetricsLedger | null = null;
let raw: BetterSqliteDatabase | null = null;
function newLedger(): FeatureMetricsLedger {
  ledger = new FeatureMetricsLedger({ dbPath: ':memory:', now: () => T0 + 10 * DAY, databaseFactory: () => { raw = new Database(':memory:'); return raw; } });
  return ledger;
}
afterEach(() => { ledger?.close(); ledger = null; raw = null; });

/** A small deterministic generator, so a failure reproduces. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0x100000000; };
}
const POINTS = ['external-hog-kill', 'messaging-tone-gate', 'completion-claim-verify'];
const RUNGS: GradingRung[] = ['deterministic-ground-truth', 'recurrence', 'llm-interpreter', 'self-report'];
const GRADES: DecisionGrade[] = ['right', 'wrong', 'unknown'];
const MODELS = ['claude-haiku-4-5', 'gpt-6-astra', ''];

function seed(l: FeatureMetricsLedger, decisions: number, rand: () => number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < decisions; i++) {
    const id = `corr-${i}`;
    ids.push(id);
    l.recordDecision({
      correlationId: id, decisionPoint: POINTS[Math.floor(rand() * POINTS.length)], feature: 'F', verdictClass: 'v',
      mintedBy: 'router', volumeClass: 'full', contentClass: 'metadata', machineId: 'abcd1234',
      model: MODELS[Math.floor(rand() * MODELS.length)], framework: 'claude-code', promptId: rand() < 0.5 ? 'p1' : 'p2',
      // Anywhere in the day, the first and last milliseconds included, so a bucket edge that is off is seen.
      ts: DAY_START + Math.floor(rand() * 3) * DAY + (i % 40 === 0 ? 0 : i % 40 === 1 ? DAY - 1 : Math.floor(rand() * DAY)),
    });
  }
  return ids;
}
function grade(l: FeatureMetricsLedger, id: string, rand: () => number): void {
  l.upsertOutcome({
    correlationId: id, gradedBy: `grader-${Math.floor(rand() * 3)}`, ruleId: 'rule-v1',
    rung: RUNGS[Math.floor(rand() * RUNGS.length)], evidenceStrength: 'deterministic-proof',
    grade: GRADES[Math.floor(rand() * GRADES.length)], ts: T0 + 4 * DAY + Math.floor(rand() * 1_000_000),
  });
}

/** The rollup rows as the VIEW says they should be: the reference the recompute must match. */
function expectedFromView(db: BetterSqliteDatabase): { daily: unknown[]; byModel: unknown[] } {
  const daily = db.prepare(
    `SELECT q.decision_point AS decisionPoint, strftime('%Y-%m-%d', q.ts / 1000, 'unixepoch') AS day,
            SUM(CASE WHEN w.grade='right' THEN 1 ELSE 0 END) AS rightCount,
            SUM(CASE WHEN w.grade='wrong' THEN 1 ELSE 0 END) AS wrongCount,
            SUM(CASE WHEN w.grade='unknown' THEN 1 ELSE 0 END) AS unknownCount
       FROM decision_quality q JOIN decision_winning_grade w ON w.correlation_id = q.correlation_id
      GROUP BY 1, 2 ORDER BY 1, 2`).all();
  const byModel = db.prepare(
    `SELECT q.decision_point AS decisionPoint, COALESCE(NULLIF(TRIM(COALESCE(q.model, '')), ''), '__missing__') AS model,
            strftime('%Y-%m-%d', q.ts / 1000, 'unixepoch') AS day,
            SUM(CASE WHEN w.grade='right' THEN 1 ELSE 0 END) AS rightN,
            SUM(CASE WHEN w.grade='wrong' THEN 1 ELSE 0 END) AS wrongN,
            SUM(CASE WHEN w.grade='unknown' THEN 1 ELSE 0 END) AS unknownN,
            COUNT(*) AS decidedTotal
       FROM decision_quality q LEFT JOIN decision_winning_grade w ON w.correlation_id = q.correlation_id
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`).all();
  return { daily, byModel };
}
function actualRollups(db: BetterSqliteDatabase, gradedBuckets: Set<string>): { daily: unknown[]; byModel: unknown[] } {
  const daily = db.prepare(
    `SELECT decision_point AS decisionPoint, day, right_count AS rightCount, wrong_count AS wrongCount, unknown_count AS unknownCount
       FROM decision_quality_rollup ORDER BY 1, 2`).all();
  const byModel = (db.prepare(
    `SELECT decision_point AS decisionPoint, model, day, right_n AS rightN, wrong_n AS wrongN, unknown_n AS unknownN, decided_total AS decidedTotal
       FROM decision_quality_rollup_by_model ORDER BY 1, 2, 3`).all() as Array<{ decisionPoint: string; day: string }>)
    .filter((row) => gradedBuckets.has(`${row.decisionPoint}|${row.day}`));
  return { daily, byModel };
}

describe('the bucket recompute gives exactly what the winning-grade view gives', () => {
  for (const seedValue of [1, 7, 20261113]) {
    it(`over random decisions, graders, rungs, grades and regrades (seed ${seedValue})`, () => {
      const l = newLedger();
      const rand = prng(seedValue);
      const ids = seed(l, 240, rand);
      const graded = new Set<string>();
      // Several passes: later outcomes supersede or outrank earlier ones for the same decision.
      for (let pass = 0; pass < 3; pass++) {
        for (const id of ids) if (rand() < 0.6) { grade(l, id, rand); graded.add(id); }
      }
      const gradedBuckets = new Set((raw!.prepare(
        `SELECT DISTINCT decision_point AS p, strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS d FROM decision_quality
          WHERE correlation_id IN (${[...graded].map(() => '?').join(',')})`).all(...graded) as Array<{ p: string; d: string }>).map((row) => `${row.p}|${row.d}`));
      const expected = expectedFromView(raw!);
      const actual = actualRollups(raw!, gradedBuckets);
      expect(actual.daily).toEqual(expected.daily);
      const expectedByModel = (expected.byModel as Array<{ decisionPoint: string; day: string }>).filter((row) => gradedBuckets.has(`${row.decisionPoint}|${row.day}`));
      expect(actual.byModel).toEqual(expectedByModel);
      expect(actual.daily.length).toBeGreaterThan(5);
      expect(actual.byModel.length).toBeGreaterThan(10);
    });
  }

  it('the strongest rung wins inside the bucket, and a weaker later grade does not displace it', () => {
    const l = newLedger();
    l.recordDecision({ correlationId: 'c1', decisionPoint: 'external-hog-kill', feature: 'F', verdictClass: 'v', mintedBy: 'router', volumeClass: 'full', contentClass: 'metadata', machineId: 'abcd1234', model: 'm', framework: 'claude-code', promptId: 'p', ts: T0 });
    l.upsertOutcome({ correlationId: 'c1', gradedBy: 'a', ruleId: 'r', rung: 'self-report', evidenceStrength: 'self-report', grade: 'right', ts: T0 + 1000 });
    l.upsertOutcome({ correlationId: 'c1', gradedBy: 'b', ruleId: 'r', rung: 'deterministic-ground-truth', evidenceStrength: 'deterministic-proof', grade: 'wrong', ts: T0 + 2000 });
    l.upsertOutcome({ correlationId: 'c1', gradedBy: 'c', ruleId: 'r', rung: 'llm-interpreter', evidenceStrength: 'self-report', grade: 'right', ts: T0 + 3000 });
    const bucket = l.decisionQualityRollupDaily().find((row) => row.decisionPoint === 'external-hog-kill' && row.day === dayOf(T0));
    expect(bucket).toMatchObject({ right: 0, wrong: 1, unknown: 0 });
  });
});

describe('the bucket recompute does not rank the whole outcomes table', () => {
  it('its query plan reaches outcomes through the correlation index, never by a scan', () => {
    newLedger();
    const plan = (raw!.prepare(
      `EXPLAIN QUERY PLAN
       SELECT COUNT(*) FROM decision_quality q
         JOIN ${BUCKET_WINNING_GRADE_SQL} w ON w.correlation_id = q.correlation_id
        WHERE q.decision_point = @decisionPoint AND q.ts >= @start AND q.ts < @end`,
    ).all({ decisionPoint: 'external-hog-kill', start: T0, end: T0 + DAY }) as Array<{ detail: string }>).map((row) => row.detail);
    expect(plan.some((detail) => /^SCAN o\b/.test(detail)), plan.join(' | ')).toBe(false);
    expect(plan.some((detail) => /^SEARCH o USING (COVERING )?INDEX/.test(detail)), plan.join(' | ')).toBe(true);
    // The control: the same join through the view does scan it.
    const viaView = (raw!.prepare(
      `EXPLAIN QUERY PLAN
       SELECT COUNT(*) FROM decision_quality q
         JOIN decision_winning_grade w ON w.correlation_id = q.correlation_id
        WHERE q.decision_point = ? AND q.ts >= ? AND q.ts < ?`,
    ).all('external-hog-kill', T0, T0 + DAY) as Array<{ detail: string }>).map((row) => row.detail);
    expect(viaView.some((detail) => /^SCAN o\b/.test(detail)), viaView.join(' | ')).toBe(true);
  });

  it('the view and the scoped recompute are built from the same precedence text', () => {
    newLedger();
    const view = (raw!.prepare(`SELECT sql FROM sqlite_master WHERE name = 'decision_winning_grade'`).get() as { sql: string }).sql;
    expect(view).toContain(WINNING_GRADE_RANK_SQL);
    expect(BUCKET_WINNING_GRADE_SQL).toContain(WINNING_GRADE_RANK_SQL);
    expect(WINNING_GRADE_RANK_SQL).toContain("WHEN 'deterministic-ground-truth' THEN 0");
  });

  it('the recompute source no longer joins the view', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('../../src/monitoring/FeatureMetricsLedger.ts', import.meta.url), 'utf8');
    for (const name of ['recomputeQualityBucketInTx', 'recomputeByModelBucketInTx']) {
      const at = source.indexOf(`private ${name}(`);
      const body = source.slice(at, source.indexOf('\n  }\n', at));
      expect(body, name).toContain('${BUCKET_WINNING_GRADE_SQL}');
      expect(body, name).not.toContain('JOIN decision_winning_grade');
    }
  });
});
