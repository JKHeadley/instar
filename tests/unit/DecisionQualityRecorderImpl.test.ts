/**
 * Unit tests for DecisionQualityRecorderImpl — the settlement recorder +
 * annotate write-integrity chokepoint (llm-decision-quality-meter §5.2/§5.4/
 * §5.5/§5.7).
 *
 * Covers: dev-gate + dryRun config resolution; enrolled-vs-not; census
 * validation (unknown decision point counted but the decision_quality row is
 * still written); ALL THREE volume classes incl. the budget boundary via
 * injected clock + UTC-day rollover; dryRun suppresses BOTH durable writes
 * with metadata-only logging; the §5.4 annotate rejections (enum-invalid /
 * rung-mismatch incl. unregistered ruleId / owner-mismatch /
 * unknown-decision-point), rung derivation from the registry, upsert
 * convergence, evidence-note clamp, and the served-shape redaction additions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { JudgmentProvenanceLog, fnv1aSampleBucket } from '../../src/core/JudgmentProvenanceLog.js';
import type { ProvenanceRow } from '../../src/core/JudgmentProvenanceLog.js';
import {
  DecisionQualityRecorderImpl,
  installDecisionQualityRecorder,
  annotateDecisionOutcome,
  getDecisionAnnotationRejectionCounters,
  _resetDecisionAnnotationRejectionCountersForTest,
  machineIdSegmentOf,
  EVIDENCE_NOTE_CLAMP,
  type DecisionQualityCensus,
} from '../../src/core/DecisionQualityRecorderImpl.js';
import { getDecisionQualityRecorder, type DecisionSettlement } from '../../src/core/decisionQualityTypes.js';
import type { ProvenanceCoverageEntry, VolumeClass } from '../../src/data/provenanceCoverage.js';
import { RULE_REGISTRY } from '../../src/data/provenanceCoverage.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DAY = 86_400_000;
/** Mid-day UTC so ±hours never cross a UTC-day boundary by accident. */
const T0 = Date.parse('2026-07-01T12:00:00.000Z'); // day '2026-07-01'
const SECRET = 'sk-ant-oat01-abcdefghijklmnopqrstuvwx';

let tmpDir: string;
let fakeNow: number;
let ledger: FeatureMetricsLedger | null = null;
let raw: BetterSqliteDatabase | null = null;
let jpl: JudgmentProvenanceLog | null = null;
let logs: string[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dqr-test-'));
  fakeNow = T0;
  logs = [];
  _resetDecisionAnnotationRejectionCountersForTest();
});

afterEach(async () => {
  installDecisionQualityRecorder(null);
  await jpl?.close();
  jpl = null;
  ledger?.close();
  ledger = null;
  raw = null;
  _resetDecisionAnnotationRejectionCountersForTest();
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/DecisionQualityRecorderImpl.test.ts:afterEach',
  });
});

function newLedger(): FeatureMetricsLedger {
  ledger = new FeatureMetricsLedger({
    dbPath: ':memory:',
    now: () => fakeNow,
    databaseFactory: () => {
      raw = new Database(':memory:');
      return raw;
    },
  });
  return ledger;
}

function newJpl(opts: { sampling?: number } = {}): JudgmentProvenanceLog {
  jpl = new JudgmentProvenanceLog({ dir: tmpDir, now: () => fakeNow, sampling: opts.sampling });
  return jpl;
}

/** Census stub — the injected §5.6 lookup seam. */
function stubCensus(
  map: Record<string, { component: string; volumeClass?: string; status?: string; contentClass?: string }>,
): DecisionQualityCensus {
  return {
    getCensusEntry: (dp: string) =>
      map[dp]
        ? ({
            decisionPoint: dp,
            component: map[dp].component,
            status: (map[dp].status ?? 'wired') as ProvenanceCoverageEntry['status'],
            volumeClass: map[dp].volumeClass as VolumeClass | undefined,
            contentClass: (map[dp].contentClass ?? 'metadata') as ProvenanceCoverageEntry['contentClass'],
          } as ProvenanceCoverageEntry)
        : undefined,
    getVolumeClass: (dp: string) =>
      map[dp] && (map[dp].status ?? 'wired') === 'wired' ? (map[dp].volumeClass as VolumeClass | undefined) : undefined,
  };
}

const TEST_CENSUS = stubCensus({
  'test-point': { component: 'TestGate', volumeClass: 'full', contentClass: 'content-bearing' },
});

function makeRecorder(opts: {
  config?: { developmentAgent?: boolean; provenance?: { uniformSeam?: { enabled?: boolean; dryRun?: boolean } } };
  census?: DecisionQualityCensus;
  withLedger?: boolean;
  withJpl?: boolean;
  jplSampling?: number;
} = {}): DecisionQualityRecorderImpl {
  return new DecisionQualityRecorderImpl({
    ledger: opts.withLedger === false ? null : newLedger(),
    judgmentProvenance: opts.withJpl === false ? null : newJpl({ sampling: opts.jplSampling }),
    config: opts.config ?? { developmentAgent: true, provenance: { uniformSeam: { dryRun: false } } },
    census: opts.census ?? TEST_CENSUS,
    log: (m) => logs.push(m),
    now: () => fakeNow,
  });
}

let seq = 0;
function uuidIsh(): string {
  const n = String(seq++).padStart(12, '0');
  return `00000000-0000-4000-8000-${n}`;
}

function settlement(over: Partial<DecisionSettlement> = {}): DecisionSettlement {
  return {
    correlationId: `d-${uuidIsh()}`,
    mintedBy: 'router',
    enrolled: true,
    provenance: {
      decisionPoint: 'test-point',
      context: { commandHash: 'abc123', cpuPercent: 220 },
      optionsPresented: ['kill', 'leave'],
      promptId: 'test-prompt-v1',
    },
    settledAttempt: {
      model: 'claude-haiku-4-5',
      framework: 'claude-code',
      usage: { inputTokens: 10, outputTokens: 5 },
    },
    verdictClass: 'fired',
    mintedAtMs: T0 - 50,
    settledAtMs: T0,
    ...over,
  };
}

function qualityRows(): Array<Record<string, unknown>> {
  return raw!.prepare(`SELECT * FROM decision_quality ORDER BY ts ASC`).all() as Array<Record<string, unknown>>;
}

async function jplRows(day = '2026-07-01'): Promise<ProvenanceRow[]> {
  await jpl!.flush();
  const file = path.join(tmpDir, `${day}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ProvenanceRow);
}

/* ── Config resolution (§5.7/FD6) ─────────────────────────────────────── */

describe('gate resolution', () => {
  it('resolves LIVE on a development agent with dryRun defaulting TRUE', () => {
    const r = makeRecorder({ config: { developmentAgent: true } });
    expect(r.gateState()).toEqual({ enabled: true, dryRun: true });
  });

  it('resolves DARK on the fleet (enabled omitted, no developmentAgent)', () => {
    const r = makeRecorder({ config: {} });
    expect(r.gateState()).toEqual({ enabled: false, dryRun: true });
  });

  it('an explicit enabled always wins in both directions', () => {
    expect(makeRecorder({ config: { provenance: { uniformSeam: { enabled: true } } } }).gateState().enabled).toBe(true);
    ledger?.close();
    expect(
      makeRecorder({ config: { developmentAgent: true, provenance: { uniformSeam: { enabled: false } } } }).gateState()
        .enabled,
    ).toBe(false);
  });

  it('DARK seam writes nothing even with dryRun:false', async () => {
    const r = makeRecorder({ config: { provenance: { uniformSeam: { dryRun: false } } } });
    r.recordSettlement(settlement());
    expect(qualityRows()).toHaveLength(0);
    expect(await jplRows()).toHaveLength(0);
  });
});

/* ── Settlement writes (§5.1.4/§5.5) ──────────────────────────────────── */

describe('recordSettlement', () => {
  it('writes nothing for an unenrolled settlement (Layer A only)', async () => {
    const r = makeRecorder();
    r.recordSettlement(settlement({ enrolled: false, provenance: undefined }));
    expect(qualityRows()).toHaveLength(0);
    expect(await jplRows()).toHaveLength(0);
  });

  it('enrolled full-class settlement writes BOTH the decision_quality row and the JSONL row', async () => {
    const r = makeRecorder();
    const s = settlement();
    r.recordSettlement(s);
    const rows = qualityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].correlation_id).toBe(s.correlationId);
    expect(rows[0].decision_point).toBe('test-point');
    expect(rows[0].feature).toBe('TestGate'); // the census 1:1 component key
    expect(rows[0].verdict_class).toBe('fired');
    expect(rows[0].minted_by).toBe('router');
    expect(rows[0].volume_class).toBe('full');
    expect(rows[0].content_class).toBe('content-bearing');
    expect(rows[0].model).toBe('claude-haiku-4-5');
    expect(rows[0].framework).toBe('claude-code');
    expect(rows[0].prompt_id).toBe('test-prompt-v1');
    expect(rows[0].ts).toBe(T0);
    const prows = await jplRows();
    expect(prows).toHaveLength(1);
    expect(prows[0].correlationId).toBe(s.correlationId);
    expect(prows[0].decision).toBe('fired');
    expect(prows[0].component).toBe('TestGate');
    expect(prows[0].mintedBy).toBe('router');
    expect(prows[0].contentClass).toBe('content-bearing');
    expect(prows[0].promptId).toBe('test-prompt-v1');
    expect(prows[0].tokensIn).toBe(10);
    expect(prows[0].latencyMs).toBe(50);
  });

  it('unknown decision point: counted, decision_quality row STILL written with the raw id, no JSONL row', async () => {
    const r = makeRecorder(); // census only knows 'test-point'
    r.recordSettlement(
      settlement({ provenance: { decisionPoint: 'never-declared-point', context: {}, optionsPresented: [] } }),
    );
    expect(getDecisionAnnotationRejectionCounters().unknownDecisionPoint).toBe(1);
    const rows = qualityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].decision_point).toBe('never-declared-point');
    expect(rows[0].feature).toBeNull(); // no census entry to bridge the component key
    expect(rows[0].volume_class).toBeNull();
    expect(await jplRows()).toHaveLength(0); // no declared volume class → no provenance archive
  });

  it('an errored settlement records the fixed marker + error class in context (§5.1.5)', async () => {
    const r = makeRecorder();
    r.recordSettlement(settlement({ verdictClass: '<errored>', errorClass: 'TimeoutError' }));
    expect(qualityRows()[0].verdict_class).toBe('<errored>'); // fixed seam marker passes the clamp
    const prows = await jplRows();
    expect(prows[0].decision).toBe('<errored>');
    expect((prows[0].contextFull as Record<string, unknown>).errorClass).toBe('TimeoutError');
  });

  it('callerRef relocates INSIDE context (FD8) — never a top-level served field', async () => {
    const r = makeRecorder();
    r.recordSettlement(settlement({ callerRef: 'CMT-99' }));
    const prows = await jplRows();
    expect((prows[0].contextFull as Record<string, unknown>).callerRef).toBe('CMT-99');
    expect((prows[0] as Record<string, unknown>).callerRef).toBeUndefined();
    const redacted = await jpl!.readRedacted();
    expect(JSON.parse(redacted[0].contextRedacted ?? '{}').callerRef).toBe('CMT-99');
  });

  it('a raw-response head enters context scrubbed + 300-clamped — NEVER the decision field', async () => {
    const r = makeRecorder();
    const rawHead = `${SECRET} ` + 'x'.repeat(500);
    r.recordSettlement(settlement({ verdictClass: 'unclassified', rawResponseHead: rawHead }));
    const prows = await jplRows();
    expect(prows[0].decision).toBe('unclassified');
    const head = (prows[0].contextFull as Record<string, unknown>).rawResponseHead as string;
    expect(head.length).toBeLessThanOrEqual(300);
    expect(head).not.toContain(SECRET);
    // The served row never carries contextFull at all (redaction by omission).
    const redacted = await jpl!.readRedacted();
    expect(redacted[0]).not.toHaveProperty('contextFull');
    expect(redacted[0].decision).toBe('unclassified');
  });

  it('a violating caller-authored verdict class is clamped in BOTH stores + counted', async () => {
    const r = makeRecorder();
    r.recordSettlement(settlement({ verdictClass: 'weird verdict with spaces!' }));
    expect(qualityRows()[0].verdict_class).toBe('unclassified');
    const prows = await jplRows();
    expect(prows[0].decision).toBe('unclassified');
    expect((jpl!.status().counters as Record<string, number>).labelClampViolations).toBeGreaterThanOrEqual(1);
  });
});

/* ── Volume classes (§5.6/FD4) ────────────────────────────────────────── */

describe('volume classes', () => {
  it('full-class rows bypass the JPL global sampling knob (the census valve is the ONE valve)', async () => {
    const r = makeRecorder({ jplSampling: 0 }); // legacy rows would ALL be sampled out
    r.recordSettlement(settlement());
    expect(await jplRows()).toHaveLength(1);
  });

  it('sampled:<rate> rides the deterministic FNV-1a convention on the correlation id', async () => {
    const census = stubCensus({ 'test-point': { component: 'TestGate', volumeClass: 'sampled:0.5' } });
    const r = makeRecorder({ census });
    const ids: string[] = [];
    for (let i = 0; i < 24; i++) {
      const id = `d-${uuidIsh()}`;
      ids.push(id);
      r.recordSettlement(settlement({ correlationId: id, settledAtMs: T0 + i }));
    }
    const expectedWrites = ids.filter((id) => fnv1aSampleBucket(id) < 0.5).length;
    expect(expectedWrites).toBeGreaterThan(0); // sanity: both sides exercised
    expect(expectedWrites).toBeLessThan(24);
    expect(await jplRows()).toHaveLength(expectedWrites);
    // The decision_quality row is written for EVERY enrolled settlement regardless.
    expect(qualityRows()).toHaveLength(24);
  });

  it('sampled:1 always writes; sampled:0 never writes JSONL (both sides of the valve)', async () => {
    const censusOn = stubCensus({ 'test-point': { component: 'TestGate', volumeClass: 'sampled:1' } });
    const r1 = makeRecorder({ census: censusOn });
    r1.recordSettlement(settlement());
    expect(await jplRows()).toHaveLength(1);
    expect(qualityRows()).toHaveLength(1);
    await jpl!.close();
    ledger!.close();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/DecisionQualityRecorderImpl.test.ts:sampled-reset' });
    fs.mkdirSync(tmpDir, { recursive: true });

    const censusOff = stubCensus({ 'test-point': { component: 'TestGate', volumeClass: 'sampled:0' } });
    const r0 = makeRecorder({ census: censusOff });
    r0.recordSettlement(settlement());
    expect(await jplRows()).toHaveLength(0);
    expect(qualityRows()).toHaveLength(1); // quality row still written
  });

  it('budget:<rows/day> enforces the UTC-day boundary via the indexed count (injected clock)', async () => {
    const census = stubCensus({ 'test-point': { component: 'TestGate', volumeClass: 'budget:2' } });
    const r = makeRecorder({ census });
    r.recordSettlement(settlement({ settledAtMs: T0 }));
    r.recordSettlement(settlement({ settledAtMs: T0 + 1_000 }));
    r.recordSettlement(settlement({ settledAtMs: T0 + 2_000 })); // over budget → dropped, loud
    expect(qualityRows()).toHaveLength(3); // counts stay complete (DC2-M3)
    expect(await jplRows('2026-07-01')).toHaveLength(2);
    const buckets = ledger!.decisionQualityRollupDaily({ decisionPoint: 'test-point' });
    expect(buckets.find((b) => b.day === '2026-07-01')?.droppedByBudget).toBe(1);

    // Next UTC day: the budget resets (COUNT since UTC-day start, restart-safe).
    fakeNow = T0 + DAY;
    r.recordSettlement(settlement({ settledAtMs: T0 + DAY }));
    expect(await jplRows('2026-07-02')).toHaveLength(1);
    expect(qualityRows()).toHaveLength(4);
  });
});

/* ── Dry-run stage (§5.2/§5.7) ────────────────────────────────────────── */

describe('dryRun', () => {
  it('suppresses BOTH durable writes and logs metadata-only would-write lines', async () => {
    const r = makeRecorder({ config: { developmentAgent: true } }); // dryRun defaults TRUE
    expect(r.gateState().dryRun).toBe(true);
    r.recordSettlement(
      settlement({
        provenance: {
          decisionPoint: 'test-point',
          context: { leaked: SECRET },
          optionsPresented: ['kill', 'leave'],
          promptId: 'test-prompt-v1',
        },
      }),
    );
    expect(qualityRows()).toHaveLength(0);
    expect(await jplRows()).toHaveLength(0);
    const line = logs.find((l) => l.includes('would-write'));
    expect(line).toBeDefined();
    expect(line).toContain('decisionPoint=test-point');
    expect(line).toContain('component=TestGate');
    expect(line).toContain('qualityRowBytes=');
    expect(line).toContain('provenanceRowBytes=');
    expect(line).toContain('jsonl=write');
    // Metadata ONLY — context content never reaches server.log.
    for (const l of logs) expect(l).not.toContain(SECRET);
  });

  it('suppresses the outcome write too (would-annotate, no rows)', () => {
    const r = makeRecorder({ config: { developmentAgent: true } });
    const res = r.annotateOutcome({
      correlationId: 'd-abc',
      ruleId: 'hog-respawn-wrong-v1',
      gradedBy: { component: 'ExternalHogSentinel' },
      grade: 'wrong',
    });
    expect(res).toEqual({ applied: false, dryRun: true });
    expect(raw!.prepare(`SELECT COUNT(*) AS n FROM decision_outcomes`).get()).toEqual({ n: 0 });
    expect(logs.some((l) => l.includes('would-annotate'))).toBe(true);
  });
});

/* ── Annotate write-integrity chokepoint (§5.4) ───────────────────────── */

describe('annotateOutcome', () => {
  function liveRecorder(): DecisionQualityRecorderImpl {
    return makeRecorder(); // dev agent, dryRun:false, TEST_CENSUS, real RULE_REGISTRY
  }

  it('rejects + counts an enum-invalid grade', () => {
    const r = liveRecorder();
    const res = r.annotateOutcome({
      correlationId: 'd-x',
      ruleId: 'hog-respawn-wrong-v1',
      gradedBy: { component: 'ExternalHogSentinel' },
      grade: 'maybe',
    });
    expect(res).toEqual({ applied: false, rejected: 'enum-invalid' });
    expect(getDecisionAnnotationRejectionCounters().enumInvalid).toBe(1);
  });

  it('rejects + counts an unregistered ruleId under rung-mismatch (DC r7)', () => {
    const r = liveRecorder();
    const res = r.annotateOutcome({
      correlationId: 'd-x',
      ruleId: 'no-such-rule-v9',
      gradedBy: { component: 'ExternalHogSentinel' },
      grade: 'wrong',
    });
    expect(res).toEqual({ applied: false, rejected: 'rung-mismatch' });
    expect(getDecisionAnnotationRejectionCounters().rungMismatch).toBe(1);
  });

  it('rejects + counts a claimed rung that disagrees with the registry', () => {
    const r = liveRecorder();
    const res = r.annotateOutcome({
      correlationId: 'd-x',
      ruleId: 'hog-respawn-wrong-v1', // registered deterministic-ground-truth
      claimedRung: 'self-report',
      gradedBy: { component: 'ExternalHogSentinel' },
      grade: 'wrong',
    });
    expect(res).toEqual({ applied: false, rejected: 'rung-mismatch' });
    expect(getDecisionAnnotationRejectionCounters().rungMismatch).toBe(1);
  });

  it('rejects + counts an owner mismatch (gradedBy.component ≠ registered owner)', () => {
    const r = liveRecorder();
    const res = r.annotateOutcome({
      correlationId: 'd-x',
      ruleId: 'hog-respawn-wrong-v1', // owner: ExternalHogSentinel
      gradedBy: { component: 'SomeOtherComponent' },
      grade: 'wrong',
    });
    expect(res).toEqual({ applied: false, rejected: 'owner-mismatch' });
    expect(getDecisionAnnotationRejectionCounters().ownerMismatch).toBe(1);
  });

  it('rejects + counts an unknown decision-point hint', () => {
    const r = liveRecorder();
    const res = r.annotateOutcome({
      correlationId: 'd-x',
      ruleId: 'hog-respawn-wrong-v1',
      gradedBy: { component: 'ExternalHogSentinel' },
      grade: 'wrong',
      decisionPoint: 'never-declared-point',
    });
    expect(res).toEqual({ applied: false, rejected: 'unknown-decision-point' });
    expect(getDecisionAnnotationRejectionCounters().unknownDecisionPoint).toBe(1);
  });

  it('accepts a clean annotation: rung + strength + window DERIVED from the registry', async () => {
    const r = liveRecorder();
    const s = settlement();
    r.recordSettlement(s);
    const res = r.annotateOutcome({
      correlationId: s.correlationId,
      ruleId: 'hog-respawn-wrong-v1',
      gradedBy: { component: 'ExternalHogSentinel' },
      grade: 'wrong',
      evidence: { respawnPid: 4242 },
      decisionPoint: 'test-point',
    });
    expect(res).toEqual({ applied: true, orphan: false });
    const grades = ledger!.getWinningGrades([s.correlationId]);
    expect(grades).toHaveLength(1);
    expect(grades[0].grade).toBe('wrong');
    expect(grades[0].rung).toBe('deterministic-ground-truth'); // derived, never claimed
    expect(grades[0].evidenceStrength).toBe('deterministic-proof');
    const rawRow = raw!
      .prepare(`SELECT effective_window_ms AS w FROM decision_outcomes WHERE correlation_id = ?`)
      .get(s.correlationId) as { w: number };
    expect(rawRow.w).toBe(RULE_REGISTRY['hog-respawn-wrong-v1'].windowMs);
    // The JPL outcome trail row carries the correlation keying + grading fields.
    const prows = await jplRows();
    const outcomeRow = prows.find((p) => p.kind === 'outcome');
    expect(outcomeRow?.correlationId).toBe(s.correlationId);
    expect(outcomeRow?.grade).toBe('wrong');
    expect(outcomeRow?.ruleId).toBe('hog-respawn-wrong-v1');
    expect(outcomeRow?.gradedBy).toBe('ExternalHogSentinel');
  });

  it('upsert convergence: a re-run supersedes its own prior grade, never multiplies', () => {
    const r = liveRecorder();
    const s = settlement();
    r.recordSettlement(s);
    const annotate = (grade: string) =>
      r.annotateOutcome({
        correlationId: s.correlationId,
        ruleId: 'hog-respawn-wrong-v1',
        gradedBy: { component: 'ExternalHogSentinel' },
        grade,
      });
    expect(annotate('wrong').applied).toBe(true);
    expect(annotate('unknown').applied).toBe(true);
    const n = raw!.prepare(`SELECT COUNT(*) AS n FROM decision_outcomes WHERE correlation_id = ?`).get(s.correlationId) as { n: number };
    expect(n.n).toBe(1);
    expect(ledger!.getWinningGrades([s.correlationId])[0].grade).toBe('unknown');
  });

  it('clamps the evidence note to ≤500 scrubbed chars BEFORE storage', () => {
    const r = liveRecorder();
    const s = settlement();
    r.recordSettlement(s);
    r.annotateOutcome({
      correlationId: s.correlationId,
      ruleId: 'hog-respawn-wrong-v1',
      gradedBy: { component: 'ExternalHogSentinel' },
      grade: 'wrong',
      evidenceNote: `${SECRET} ` + 'e'.repeat(700),
    });
    const rowNote = raw!
      .prepare(`SELECT evidence_note AS note FROM decision_outcomes WHERE correlation_id = ?`)
      .get(s.correlationId) as { note: string };
    expect(rowNote.note.length).toBeLessThanOrEqual(EVIDENCE_NOTE_CLAMP);
    expect(rowNote.note).not.toContain(SECRET);
  });

  it('evidence_note is absent from every served ledger shape (redaction addition)', () => {
    const r = liveRecorder();
    const s = settlement();
    r.recordSettlement(s);
    r.annotateOutcome({
      correlationId: s.correlationId,
      ruleId: 'hog-respawn-wrong-v1',
      gradedBy: { component: 'ExternalHogSentinel' },
      grade: 'wrong',
      evidenceNote: 'pointer-only note',
    });
    for (const g of ledger!.getWinningGrades([s.correlationId])) {
      expect(Object.keys(g).join(',')).not.toMatch(/evidence_?[nN]ote/);
    }
    for (const b of ledger!.decisionQualityRollupDaily()) {
      expect(Object.keys(b).join(',')).not.toMatch(/evidence_?[nN]ote/);
    }
  });

  it('an orphan outcome (no local parent) is stored + counted under the hint point (FD10)', () => {
    const r = liveRecorder();
    const res = r.annotateOutcome({
      correlationId: 'd-never-settled-here',
      ruleId: 'hog-respawn-wrong-v1',
      gradedBy: { component: 'ExternalHogSentinel' },
      grade: 'wrong',
      decisionPoint: 'test-point',
    });
    expect(res).toEqual({ applied: true, orphan: true });
    const buckets = ledger!.decisionQualityRollupDaily({ decisionPoint: 'test-point' });
    expect(buckets.some((b) => b.orphanOutcomes >= 1)).toBe(true);
  });

  it('a DARK seam is a clean disabled no-op (nothing counted)', () => {
    const r = makeRecorder({ config: {} });
    const res = r.annotateOutcome({
      correlationId: 'd-x',
      ruleId: 'hog-respawn-wrong-v1',
      gradedBy: { component: 'ExternalHogSentinel' },
      grade: 'maybe', // would be enum-invalid if the seam were live
    });
    expect(res).toEqual({ applied: false, disabled: true });
    expect(getDecisionAnnotationRejectionCounters().enumInvalid).toBe(0);
  });
});

/* ── Module singleton wiring ──────────────────────────────────────────── */

describe('installDecisionQualityRecorder + annotateDecisionOutcome', () => {
  it('installs BOTH the router settlement singleton and the annotate target', () => {
    const impl = makeRecorder();
    installDecisionQualityRecorder(impl);
    expect(getDecisionQualityRecorder()).toBe(impl);
    const s = settlement();
    impl.recordSettlement(s);
    const res = annotateDecisionOutcome({
      correlationId: s.correlationId,
      ruleId: 'hog-respawn-wrong-v1',
      gradedBy: { component: 'ExternalHogSentinel' },
      grade: 'right',
    });
    expect(res.applied).toBe(true);
    installDecisionQualityRecorder(null);
    expect(getDecisionQualityRecorder()).toBeNull();
    expect(annotateDecisionOutcome({
      correlationId: s.correlationId,
      ruleId: 'hog-respawn-wrong-v1',
      gradedBy: { component: 'ExternalHogSentinel' },
      grade: 'right',
    })).toEqual({ applied: false, disabled: true });
  });
});

/* ── machineId segment parsing (§5.1.1/FD10) ──────────────────────────── */

describe('machineIdSegmentOf', () => {
  it('parses the machine segment when present and yields null for bare-uuid mints', () => {
    expect(machineIdSegmentOf('d-abcd1234-00000000-0000-4000-8000-000000000001')).toBe('abcd1234');
    expect(machineIdSegmentOf('b-abcd1234-00000000-0000-4000-8000-000000000001')).toBe('abcd1234');
    expect(machineIdSegmentOf('d-01234567-89ab-4cde-8f01-23456789abcd')).toBeNull();
    expect(machineIdSegmentOf('not-a-mint')).toBeNull();
  });

  it('stamps the parsed segment into the decision_quality machine_id column', () => {
    const r = makeRecorder();
    r.recordSettlement(settlement({ correlationId: 'd-abcd1234-00000000-0000-4000-8000-000000000042' }));
    expect(qualityRows()[0].machine_id).toBe('abcd1234');
  });
});
