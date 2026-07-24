/**
 * Unit tests for BenchmarkDivergenceAnalyzer (benchmark-divergence-detector
 * FD7/FD8/FD9/FD13): lease-gating (cadence AND manual), dryRun = zero
 * detector-owned durable writes, the rolling-window recompute (a late grade
 * flip updates the finding on the next pass), offline-peer partial + the
 * local-prune-advances-with-all-peers-offline decoupling, chronic streak
 * seeding from the pool-merged view (survives holder churn), FD9 clamps on
 * peer envelopes, the unmapped-flood ceiling, window intersection, and the
 * serving-side rollup-aggregates range clamp. Injected clocks throughout.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { BenchmarkDivergenceAnalyzer } from '../../src/monitoring/BenchmarkDivergenceAnalyzer.js';
import { liveTemplateHash } from '../../src/data/benchmarkDivergenceRegistry.js';
import { DP_MESSAGING_TONE_GATE } from '../../src/data/provenanceCoverage.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-07-10T12:00:00.000Z'); // today '2026-07-10'; matured toDay '2026-07-08'

let tmpDir: string;
let ledger: FeatureMetricsLedger;
let nowMs: number;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-analyzer-'));
  nowMs = T0;
  ledger = new FeatureMetricsLedger({ dbPath: ':memory:', now: () => nowMs });
});

afterEach(() => {
  ledger.close();
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/BenchmarkDivergenceAnalyzer.test.ts' });
});

function config(overrides: Record<string, unknown> = {}): InstarConfig {
  return {
    projectName: 't', projectDir: tmpDir, stateDir: path.join(tmpDir, '.instar'), port: 0,
    authToken: 'tok', version: '0.0.0', developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 5, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
    ...overrides,
    // AFTER the spread, so an `overrides.benchmarkDivergence` cannot drop it.
    // ABSOLUTE mirrorPath inside tmpDir: an explicit path is honored verbatim and
    // never falls back to the installed package (2026-07-23). Without this, the
    // real SHIPPED baseline leaks in and "missing mirror" becomes untestable.
    benchmarkDivergence: {
      dryRun: false,
      mirrorPath: path.join(tmpDir, 'src', 'data', 'benchmarkPredictions.json'),
      ...((overrides.benchmarkDivergence as Record<string, unknown>) ?? {}),
    },
  } as unknown as InstarConfig;
}

/** Write a FRESH mirror whose tone-gate benched hash matches the live template. */
function writeMatchingMirror(opts: { hashOverride?: string; capturedAt?: string; passRate?: number; passes?: number; deterministic?: number } = {}): void {
  const mirrorPath = path.join(tmpDir, 'src', 'data', 'benchmarkPredictions.json');
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
  const p = opts.passes ?? 190;
  const d = opts.deterministic ?? 200;
  fs.writeFileSync(mirrorPath, JSON.stringify({
    capturedAt: opts.capturedAt ?? '2026-07-08T00:00:00.000Z',
    tasks: {
      'tone-gate': {
        perModel: { 'claude-opus-4-8': { passRate: opts.passRate ?? p / d, passes: p, deterministic: d } },
        benchedPromptSource: 'src/core/MessagingToneGate.ts#TONE_GATE_PROMPT_TEMPLATE',
        benchedPromptHash: opts.hashOverride ?? liveTemplateHash('tone-gate'),
        capturedAt: opts.capturedAt ?? '2026-07-08T00:00:00.000Z',
      },
    },
  }));
}

/** Record `n` decisions (+ optional grades) on the tone-gate point for one UTC day. */
function seedDecisions(day: string, n: number, opts: { right?: number; wrong?: number; model?: string; promptId?: string } = {}): void {
  const ts = Date.parse(`${day}T10:00:00.000Z`);
  for (let i = 0; i < n; i++) {
    const id = `c-${day}-${opts.model ?? 'opus'}-${i}`;
    ledger.recordDecision({
      correlationId: id, decisionPoint: DP_MESSAGING_TONE_GATE, feature: 'MessagingToneGate',
      verdictClass: 'pass', mintedBy: 'router', volumeClass: 'full', contentClass: 'metadata',
      machineId: 'abcd1234', model: opts.model ?? 'claude-opus-4-8', framework: 'claude-code',
      promptId: opts.promptId ?? 'tone-gate-v1', ts: ts + i,
    });
    const right = opts.right ?? n; // default: every decision graded right
    const wrong = opts.wrong ?? 0;
    if (i < right) {
      ledger.upsertOutcome({ correlationId: id, gradedBy: 'g', ruleId: 'r', rung: 'deterministic-ground-truth', evidenceStrength: 'deterministic-proof', grade: 'right', ts: ts + i });
    } else if (i < right + wrong) {
      ledger.upsertOutcome({ correlationId: id, gradedBy: 'g', ruleId: 'r', rung: 'deterministic-ground-truth', evidenceStrength: 'deterministic-proof', grade: 'wrong', ts: ts + i });
    }
  }
}

type PeerBody = { aggregates?: unknown; findings?: unknown[] };
function mockFetch(peerBodies: Record<string, PeerBody | 'down'>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const m = url.match(/^https?:\/\/([^/]+)/);
    const host = m ? m[1] : '';
    const body = peerBodies[host];
    if (!body || body === 'down') throw Object.assign(new Error('down'), { name: 'TypeError' });
    if (url.includes('/rollup-aggregates')) {
      return { ok: true, status: 200, json: async () => body.aggregates ?? { rows: [], orphanRows: [] } } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ findings: body.findings ?? [] }) } as unknown as Response;
  }) as typeof fetch;
}

function analyzer(opts: {
  cfg?: InstarConfig;
  isHolder?: () => boolean;
  peers?: Array<{ machineId: string; url: string }>;
  fetchImpl?: typeof fetch;
} = {}): BenchmarkDivergenceAnalyzer {
  return new BenchmarkDivergenceAnalyzer({
    ledger,
    config: opts.cfg ?? config(),
    machineId: 'm-self',
    isHolder: opts.isHolder ?? (() => true),
    holderMachineId: () => 'm-holder',
    resolvePeerUrls: () => opts.peers ?? [],
    isPeerUrlAllowed: () => true,
    authToken: 'tok',
    fetchImpl: opts.fetchImpl ?? mockFetch({}),
    now: () => nowMs,
    jitterMs: () => 0,
    log: () => {},
  });
}

describe('lease gating (FD8)', () => {
  it('a non-holder refuses BOTH the cadence tick and the manual trigger, naming the holder', async () => {
    const a = analyzer({ isHolder: () => false });
    const manual = await a.analyze('manual');
    expect(manual).toMatchObject({ ran: false, reason: 'not-holder', holderMachineId: 'm-holder' });
    const cadence = await a.analyze('cadence');
    expect(cadence).toMatchObject({ ran: false, reason: 'not-holder', holderMachineId: 'm-holder' });
    expect(ledger.listBenchmarkFindings()).toHaveLength(0); // no duplicate findings from a non-holder
  });

  it('a mid-pass lease flap aborts the findings upsert (re-checked once before writes)', async () => {
    writeMatchingMirror();
    seedDecisions('2026-07-05', 30);
    let holder = true;
    let checks = 0;
    const a = analyzer({ isHolder: () => { checks++; if (checks > 1) holder = false; return holder; } });
    const r = await a.analyze('manual');
    expect(r).toMatchObject({ ran: false, reason: 'lease-lost' });
    expect(ledger.listBenchmarkFindings()).toHaveLength(0);
  });

  it('disabled (dark) refuses before anything else', async () => {
    const cfg = config({ benchmarkDivergence: { enabled: false } });
    const a = analyzer({ cfg });
    expect(await a.analyze('manual')).toEqual({ ran: false, reason: 'disabled' });
  });

  it('rate-limited within the min interval; single-flight refuses a concurrent pass', async () => {
    writeMatchingMirror();
    const a = analyzer();
    expect((await a.analyze('manual')).ran).toBe(true);
    expect((await a.analyze('manual')).reason).toBe('rate-limited');
    nowMs += 6 * 60_000; // past the 5-min rate limit
    expect((await a.analyze('manual')).ran).toBe(true);
  });

  it('cadence trigger rides the jitter delay (scheduled, single-flight)', async () => {
    writeMatchingMirror();
    const a = new BenchmarkDivergenceAnalyzer({
      ledger, config: config(), machineId: 'm-self',
      isHolder: () => true, holderMachineId: () => 'm-self',
      resolvePeerUrls: () => [], authToken: 'tok', fetchImpl: mockFetch({}),
      now: () => nowMs, jitterMs: () => 60_000, log: () => {},
    });
    const r = await a.analyze('cadence');
    expect(r).toMatchObject({ ran: true, scheduled: true, delayMs: 60_000 });
    expect((await a.analyze('cadence')).reason).toBe('already-running'); // pending timer = in flight
    a.stop();
  });
});

describe('dryRun (FD13) — zero detector-owned durable writes', () => {
  it('a dryRun pass writes NO findings, NO watermark, NO history — and reports wouldUpsert', async () => {
    writeMatchingMirror();
    seedDecisions('2026-07-05', 30);
    const a = analyzer({ cfg: config({ benchmarkDivergence: { dryRun: true } }) });
    const r = await a.analyze('manual');
    expect(r.ran).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.wouldUpsert).toBeGreaterThan(0);
    expect(ledger.listBenchmarkFindings()).toHaveLength(0);
    expect(ledger.listBenchmarkWatermarks()).toHaveLength(0);
    expect(ledger.listBenchmarkFindingHistory('tone-gate', DP_MESSAGING_TONE_GATE, 'claude-opus-4-8')).toHaveLength(0);
  });
});

describe('the pass — verdicts over the pool-merged window', () => {
  it('healthy aligned: matching hash + fresh mirror + enough grades ⇒ aligned finding with real fields', async () => {
    writeMatchingMirror(); // bench 190/200 = 0.95
    seedDecisions('2026-07-05', 30); // 30/30 right ⇒ real 1.0; delta 0.05 < 0.15
    const a = analyzer();
    const r = await a.analyze('manual');
    expect(r.ran).toBe(true);
    expect(r.byVerdict?.aligned).toBe(1);
    const f = ledger.listBenchmarkFindings()[0];
    expect(f).toMatchObject({ taskId: 'tone-gate', decisionPointId: DP_MESSAGING_TONE_GATE, model: 'claude-opus-4-8', verdict: 'aligned' });
    expect(f.gradedN).toBe(30);
  });

  it('missing mirror ⇒ precondition-failed / stale-mirror (an operational failure, never no-benched-baseline)', async () => {
    seedDecisions('2026-07-05', 30);
    const a = analyzer();
    await a.analyze('manual');
    const f = ledger.listBenchmarkFindings()[0];
    expect(f.verdict).toBe('precondition-failed');
    expect(f.preconditionReason).toBe('stale-mirror');
    expect(a.mirrorStatus()).toMatchObject({ present: false, stale: true });
  });

  it('drifted benched hash ⇒ precondition-failed / prompt-drifted (a benchmark bug, never a model verdict)', async () => {
    writeMatchingMirror({ hashOverride: 'b'.repeat(64) });
    seedDecisions('2026-07-05', 30, { right: 5, wrong: 25 }); // would be divergent-worse — suppressed
    const a = analyzer();
    await a.analyze('manual');
    expect(ledger.listBenchmarkFindings()[0]).toMatchObject({ verdict: 'precondition-failed', preconditionReason: 'prompt-drifted' });
  });

  it('a fully-ungraded window ⇒ insufficient-evidence (decisions-only buckets materialize via the reconcile arm)', async () => {
    writeMatchingMirror();
    seedDecisions('2026-07-05', 40, { right: 0, wrong: 0 });
    // With ZERO outcomes the annotate chokepoint never fires — the RECONCILE
    // (boot + 6h cadence, always within the 2-day maturity lag) is the arm
    // that materializes decisions-only buckets (spec §Durable schema).
    ledger.reconcileQualityRollup(30);
    const a = analyzer();
    await a.analyze('manual');
    const f = ledger.listBenchmarkFindings()[0];
    expect(f.verdict).toBe('insufficient-evidence');
    expect(f.gradedN).toBe(0);
  });

  it('an unmapped production model ⇒ no-benched-baseline (unmapped:true) — never a foreign baseline', async () => {
    writeMatchingMirror();
    seedDecisions('2026-07-05', 30, { model: 'mystery-model-9000' });
    const a = analyzer();
    await a.analyze('manual');
    const f = ledger.listBenchmarkFindings().find((x) => x.model === 'mystery-model-9000')!;
    expect(f.verdict).toBe('no-benched-baseline');
    expect(f.unmapped).toBe(1);
  });

  it('rolling window (FD7): a late grade flip after day-close updates the finding on the next pass', async () => {
    writeMatchingMirror(); // bench 0.95
    seedDecisions('2026-07-05', 30); // all right ⇒ aligned
    const a = analyzer();
    await a.analyze('manual');
    expect(ledger.listBenchmarkFindings()[0].verdict).toBe('aligned');
    // Late evidence: a sentinel supersedes 25 of the grades to WRONG days later.
    for (let i = 0; i < 25; i++) {
      ledger.upsertOutcome({
        correlationId: `c-2026-07-05-opus-${i}`, gradedBy: 'sentinel', ruleId: 'r2',
        rung: 'deterministic-ground-truth', evidenceStrength: 'deterministic-proof', grade: 'wrong',
      });
    }
    nowMs += 6 * 60_000;
    await a.analyze('manual');
    const f = ledger.listBenchmarkFindings()[0];
    expect(f.verdict).toBe('divergent-worse'); // real ≈ 0.167 vs 0.95
    expect(ledger.listBenchmarkFindings()).toHaveLength(1); // upserted, not duplicated
  });

  it('replayed pass = no finding drift (idempotent upserts)', async () => {
    writeMatchingMirror();
    seedDecisions('2026-07-05', 30);
    const a = analyzer();
    await a.analyze('manual');
    const first = ledger.listBenchmarkFindings();
    nowMs += 6 * 60_000;
    await a.analyze('manual');
    const second = ledger.listBenchmarkFindings();
    expect(second).toHaveLength(first.length);
    expect(second[0]).toMatchObject({ verdict: first[0].verdict, gradedN: first[0].gradedN });
  });
});

describe('R2 pool semantics (FD8/FD9)', () => {
  const PEER = { machineId: 'm-peer', url: 'http://peer-a' };

  it('an offline peer ⇒ partial verdict + coverage honesty — and the LOCAL watermark still advances (verdict-only coupling)', async () => {
    writeMatchingMirror();
    seedDecisions('2026-07-05', 30);
    const a = analyzer({ peers: [PEER], fetchImpl: mockFetch({ 'peer-a': 'down' }) });
    const r = await a.analyze('manual');
    expect(r.pool).toMatchObject({ peersQueried: 1, peersOk: 0 });
    expect(r.pool!.failed[0]).toMatchObject({ machineId: 'm-peer' });
    const f = ledger.listBenchmarkFindings()[0];
    expect(f.verdict).toBe('partial');
    // R1 decoupling: local analysis + watermark proceed with ALL peers offline.
    const marks = ledger.listBenchmarkWatermarks();
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0].analyzedThroughDay).toBe('2026-07-08');
  });

  it('peer aggregates merge into the pool-merged rates; analysisWindow = intersection of covered days', async () => {
    writeMatchingMirror();
    seedDecisions('2026-07-05', 15); // local alone is under the 20 floor
    const peerRows = Array.from({ length: 1 }, () => ({
      decisionPointId: DP_MESSAGING_TONE_GATE, model: 'claude-opus-4-8', day: '2026-07-05',
      rightN: 15, wrongN: 0, unknownN: 0, decidedTotal: 15, promptId: 'tone-gate-v1',
    }));
    const a = analyzer({
      peers: [PEER],
      fetchImpl: mockFetch({ 'peer-a': { aggregates: { retentionEdgeDay: '2026-07-01', rows: peerRows, orphanRows: [] }, findings: [] } }),
    });
    const r = await a.analyze('manual');
    expect(r.pool).toMatchObject({ peersOk: 1 });
    const f = ledger.listBenchmarkFindings()[0];
    expect(f.gradedN).toBe(30); // 15 local + 15 peer — over the floor now
    expect(f.verdict).toBe('aligned');
    // Window intersection: the peer's retention edge bounds the merged window.
    expect(f.windowFromDay).toBe('2026-07-01');
    expect(f.windowToDay).toBe('2026-07-08');
  });

  it('a hostile peer envelope is clamped: implausible rows excluded + the peer classified suspect', async () => {
    writeMatchingMirror();
    seedDecisions('2026-07-05', 30);
    const a = analyzer({
      peers: [PEER],
      fetchImpl: mockFetch({
        'peer-a': {
          aggregates: {
            retentionEdgeDay: '2026-07-01',
            rows: [
              { decisionPointId: DP_MESSAGING_TONE_GATE, model: 'claude-opus-4-8', day: '2026-07-05', rightN: 999, wrongN: 0, unknownN: 0, decidedTotal: 5, promptId: '' }, // grades > decisions
              { decisionPointId: 'x; DROP TABLE', model: 'claude-opus-4-8', day: '2026-07-05', rightN: 1, wrongN: 0, unknownN: 0, decidedTotal: 1, promptId: '' },
            ],
            orphanRows: [],
          },
          findings: [],
        },
      }),
    });
    const r = await a.analyze('manual');
    expect(r.pool!.suspect[0]).toMatchObject({ machineId: 'm-peer' });
    expect(r.pool!.suspect[0].reasons).toContain('implausible-row');
    // The hostile rows did NOT pollute the merged rate.
    expect(ledger.listBenchmarkFindings()[0].gradedN).toBe(30);
  });

  it('chronic streak seeds from the POOL-MERGED latest view — holder churn cannot reset it (incl. aligned-resets)', async () => {
    // NO mirror ⇒ every pass is precondition-failed (non-actionable).
    seedDecisions('2026-07-05', 30);
    const peerFinding = {
      taskId: 'tone-gate', decisionPointId: DP_MESSAGING_TONE_GATE, model: 'claude-opus-4-8',
      verdict: 'precondition-failed', preconditionReason: 'stale-mirror', realGradeRate: null,
      predictedRate: null, delta: null, gradedN: 0, unknownShare: null, ciHalfWidth: null, benchN: null,
      benchCiHalfWidth: null, orphanTainted: false, chronic: false, chronicStreak: 2,
      coverage: { machinesReporting: 1, machinesKnown: 1, byMachine: {} }, dominantMachineShare: null,
      benchedPromptHash: null, mirrorCapturedAt: null,
      analysisWindow: { fromDay: '2026-06-01', toDay: '2026-07-07' }, firstSeenAt: 1, lastSeenAt: 2,
    };
    // A FRESH holder (this machine has no local findings) — the prior holder's
    // streak of 2 arrives through the pool merge.
    const a = analyzer({
      peers: [PEER],
      fetchImpl: mockFetch({ 'peer-a': { aggregates: { rows: [], orphanRows: [] }, findings: [peerFinding] } }),
      cfg: config({ benchmarkDivergence: { dryRun: false, chronicCycles: 3 } }),
    });
    await a.analyze('manual');
    const f = ledger.listBenchmarkFindings()[0];
    expect(f.chronicStreak).toBe(3); // seeded 2 + this non-actionable pass
    expect(f.chronic).toBe(1);
    expect(f.chronicReason).toBe('mirror-stale');
    // An actionable verdict RESETS: give it a good mirror and re-pass.
    writeMatchingMirror();
    nowMs += 6 * 60_000;
    await a.analyze('manual');
    const f2 = ledger.listBenchmarkFindings()[0];
    expect(f2.verdict).toBe('aligned');
    expect(f2.chronicStreak).toBe(0);
    expect(f2.chronic).toBe(0);
  });

  it('maxOrphanShare is evaluated over the POOL-MERGED aggregate (R2 applies to the honesty gates too)', async () => {
    writeMatchingMirror();
    seedDecisions('2026-07-05', 30); // local: zero orphans, clean
    // The PEER reports orphan outcomes that push the merged share over 0.10:
    // merged decided = 30 local + 10 peer = 40; peer orphans 8 ⇒ share 0.2.
    const a = analyzer({
      peers: [PEER],
      fetchImpl: mockFetch({
        'peer-a': {
          aggregates: {
            retentionEdgeDay: '2026-06-01',
            rows: [{ decisionPointId: DP_MESSAGING_TONE_GATE, model: 'claude-opus-4-8', day: '2026-07-05', rightN: 10, wrongN: 0, unknownN: 0, decidedTotal: 10, promptId: 'tone-gate-v1' }],
            orphanRows: [{ decisionPointId: DP_MESSAGING_TONE_GATE, day: '2026-07-05', orphanOutcomes: 8 }],
          },
          findings: [],
        },
      }),
    });
    await a.analyze('manual');
    const f = ledger.listBenchmarkFindings()[0];
    expect(f.verdict).toBe('partial');
    expect(f.orphanTainted).toBe(1); // holder-local share was 0 — only the pool merge catches it
  });

  it('meter stores are BYTE-IDENTICAL with the detector dark, dryRun, and live (FD7 wiring integrity)', async () => {
    writeMatchingMirror();
    seedDecisions('2026-07-05', 30);
    const rawDb = (ledger as unknown as { db: import('better-sqlite3').Database }).db;
    const meterDump = () => ({
      quality: rawDb.prepare(`SELECT * FROM decision_quality ORDER BY correlation_id`).all(),
      outcomes: rawDb.prepare(`SELECT * FROM decision_outcomes ORDER BY correlation_id, graded_by`).all(),
      rollup: rawDb.prepare(`SELECT * FROM decision_quality_rollup ORDER BY decision_point, day`).all(),
      byModel: rawDb.prepare(`SELECT * FROM decision_quality_rollup_by_model ORDER BY decision_point, model, day`).all(),
    });
    const baseline = meterDump();
    // Dark:
    await analyzer({ cfg: config({ benchmarkDivergence: { enabled: false } }) }).analyze('manual');
    expect(meterDump()).toEqual(baseline);
    // dryRun:
    await analyzer({ cfg: config({ benchmarkDivergence: { dryRun: true } }) }).analyze('manual');
    expect(meterDump()).toEqual(baseline);
    // Live:
    await analyzer().analyze('manual');
    expect(meterDump()).toEqual(baseline); // findings/watermark are DETECTOR tables — the meter's stores unmoved
  });

  it('unmapped-flood ceiling (FD9): new keys beyond maxNewFindingKeysPerPass collapse into ONE deduped finding', async () => {
    writeMatchingMirror();
    // 6 distinct unmapped models ⇒ 6 new finding keys; cap at 3.
    for (let i = 0; i < 6; i++) seedDecisions('2026-07-05', 25, { model: `weird-model-${i}` });
    const a = analyzer({ cfg: config({ benchmarkDivergence: { dryRun: false, maxNewFindingKeysPerPass: 3 } }) });
    await a.analyze('manual');
    const findings = ledger.listBenchmarkFindings();
    const flood = findings.find((f) => f.model === '__unmapped-flood__');
    expect(flood).toBeDefined();
    expect(Number(flood!.gradedN)).toBe(3); // the collapsed-key COUNT (content-free)
    // 3 admitted new keys + 1 flood row.
    expect(findings).toHaveLength(4);
  });
});

describe('rollup-aggregates serving clamp (FD10)', () => {
  it('the SERVING peer clamps the range to min(requested, maxDaysPerAnalysis, retention) and bounds rows', () => {
    seedDecisions('2026-07-05', 3);
    const a = analyzer();
    const out = a.rollupAggregates('2020-01-01', '2030-01-01');
    // toDay clamped to today; fromDay clamped to the 35-day window.
    expect(out.retentionEdgeDay).toBe('2026-01-11'); // today − 180
    expect(out.rows.every((r) => r.day >= '2026-06-06' && r.day <= '2026-07-10')).toBe(true);
    expect(out.machineId).toBe('m-self');
    expect(out.truncated).toBe(false);
  });
});

describe('status surfaces (FD10)', () => {
  it('analyzer.stale is true on a non-holder; summary aggregates byVerdict + unanalyzedLoss by machine', async () => {
    writeMatchingMirror();
    seedDecisions('2026-07-05', 30);
    const holderA = analyzer();
    await holderA.analyze('manual');
    expect(holderA.status()).toMatchObject({ isHolder: true, stale: false });
    expect(holderA.summary().byVerdict.aligned).toBe(1);
    const nonHolder = analyzer({ isHolder: () => false });
    expect(nonHolder.status()).toMatchObject({ isHolder: false, stale: true });
  });

  it("summary.missingModelShare surfaces the '__missing__' share of the matured window", async () => {
    writeMatchingMirror();
    seedDecisions('2026-07-05', 10);
    seedDecisions('2026-07-05', 10, { model: '' }); // refused into __missing__
    const a = analyzer();
    expect(a.summary().missingModelShare).toBeCloseTo(0.5);
  });
});
