/**
 * Tier-1 tests for the CutoverReadiness checker (coordination-mandate spec §7 G2.4,
 * decision 1A: everything UP TO the door).
 *
 * Both sides of every boundary: integrity status (never-ran / failed / passed /
 * torn file), parity readiness (no passes / cleared / cleared-but-STALE), the
 * trigger-only parity pass (server-side check recorded clean AND divergent; a
 * FAILED check records NOTHING; no source configured refuses), the composed
 * `ready` signal, and the door being machine-readably manual.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CutoverReadiness } from '../../src/feedback-factory/cutoverReadiness.js';
import { DurableParityMonitor, JsonlPassPersistence } from '../../src/feedback-factory/monitor/parityMonitorStore.js';
import type { IntegrityReport } from '../../src/feedback-factory/migration/importIntegrity.js';
import type { ParityResult } from '../../src/feedback-factory/processor/parity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = Date.parse('2026-06-05T00:00:00Z');
const HOUR = 60 * 60 * 1000;

const PASSED_REPORT: IntegrityReport = {
  fingerprintCollisions: [], schemaDivergences: [], checksumMismatches: [],
  danglingRefs: [], sequenceResetTo: 1347, passed: true,
};
const FAILED_REPORT: IntegrityReport = {
  ...PASSED_REPORT,
  checksumMismatches: [{ kind: 'cluster', id: 'c1', sourceChecksum: 'a', targetChecksum: 'b' } as any],
  passed: false,
};

const CLEAN: ParityResult = {
  clustersCompared: 1346, clustersWithFingerprint: 1346, outcomesCompared: 0,
  fingerprintDivergences: [], outcomeDivergences: [], divergent: false,
};
const DIVERGENT: ParityResult = {
  ...CLEAN,
  fingerprintDivergences: [{ clusterId: 'c9', stored: 'x', recomputed: 'y' } as any],
  divergent: true,
};

describe('CutoverReadiness (spec §7 G2.4)', () => {
  let dir: string;
  let nowMs: number;
  let monitor: DurableParityMonitor;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutready-'));
    nowMs = T0;
    monitor = new DurableParityMonitor(new JsonlPassPersistence(path.join(dir, 'passes.jsonl')));
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/cutover-readiness.test.ts' }));

  function build(runParityCheck: (() => Promise<ParityResult>) | null = null) {
    return new CutoverReadiness({
      parityMonitor: monitor,
      integrityReportPath: path.join(dir, 'integrity-report.json'),
      runParityCheck,
      now: () => nowMs,
    });
  }

  /** Feed enough clean passes (spanning the policy window) to clear the parity gate. */
  function feedCleanWindow() {
    for (let i = 0; i < 3; i++) {
      monitor.record({ at: new Date(T0 + i * HOUR).toISOString(), clustersCompared: 1346, divergences: 0, divergent: false });
    }
    nowMs = T0 + 2 * HOUR + 1; // after the 3rd pass; window > 1h
  }

  // ── integrity side ──

  it('integrity: never-ran → ran:false passed:false (deny-safe); torn file likewise', () => {
    const r = build();
    expect(r.integrityStatus()).toEqual({ ran: false, passed: false, generatedAt: null, summary: null });
    fs.writeFileSync(path.join(dir, 'integrity-report.json'), '{ torn');
    expect(r.integrityStatus().passed).toBe(false);
  });

  it('integrity: recordIntegrityReport persists; passed and failed reports read back faithfully', () => {
    const r = build();
    r.recordIntegrityReport(FAILED_REPORT);
    expect(r.integrityStatus()).toMatchObject({ ran: true, passed: false });
    expect(r.integrityStatus().summary?.checksumMismatches).toBe(1);
    r.recordIntegrityReport(PASSED_REPORT, '2026-06-05T01:00:00Z');
    expect(r.integrityStatus()).toMatchObject({ ran: true, passed: true, generatedAt: '2026-06-05T01:00:00Z' });
  });

  // ── parity side ──

  it('parity: no passes → blocked + stale; a fed clean window → cleared + fresh', () => {
    const r = build();
    expect(r.parityStatus()).toMatchObject({ cleared: false, stale: true, lastPassAt: null });
    feedCleanWindow();
    const p = r.parityStatus();
    expect(p.cleared).toBe(true);
    expect(p.stale).toBe(false);
    expect(p.lastPassAt).toBe(new Date(T0 + 2 * HOUR).toISOString());
  });

  it('parity: a cleared window goes STALE when no pass lands within the freshness bound', () => {
    const r = build();
    feedCleanWindow();
    expect(r.parityStatus().stale).toBe(false);
    nowMs = T0 + 2 * HOUR + 7 * HOUR; // 7h after the last pass (> 6h default)
    const p = r.parityStatus();
    expect(p.cleared).toBe(true);   // the gate itself has no staleness…
    expect(p.stale).toBe(true);     // …the readiness layer adds it
    expect(r.status().ready).toBe(false);
  });

  // ── trigger-only parity pass (T7) ──

  it('runParityPass: no source configured → refuses; nothing recorded', async () => {
    const r = build(null);
    const out = await r.runParityPass();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/no parity source configured/);
    expect(monitor.passes.length).toBe(0);
  });

  it('runParityPass: a FAILED live check records NOTHING (absence of evidence)', async () => {
    feedCleanWindow();
    const before = monitor.passes.length;
    const r = build(async () => { throw new Error('Portal 503'); });
    const out = await r.runParityPass();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/parity check failed: Portal 503/);
    expect(monitor.passes.length).toBe(before); // streak neither extended nor reset
  });

  it('runParityPass: records a clean pass AND a divergent pass faithfully (divergent resets the gate)', async () => {
    feedCleanWindow();
    const clean = build(async () => CLEAN);
    const out1 = await clean.runParityPass();
    expect(out1.ok).toBe(true);
    if (out1.ok) {
      expect(out1.pass.divergent).toBe(false);
      expect(out1.gate.cleared).toBe(true);
    }
    const divergent = build(async () => DIVERGENT);
    const out2 = await divergent.runParityPass();
    expect(out2.ok).toBe(true);
    if (out2.ok) {
      expect(out2.pass.divergent).toBe(true);
      expect(out2.gate.cleared).toBe(false); // a real divergence blocks the gate
    }
  });

  // ── single-flight lock max-hold (#948 regression) ──

  it('runParityPass: a live fetch that NEVER settles hits the max-hold, returns ok:false, and RELEASES the lock so a later pass proceeds (#948)', async () => {
    feedCleanWindow();
    const fed = monitor.passes.length; // 3
    let call = 0;
    const r = new CutoverReadiness({
      parityMonitor: monitor,
      integrityReportPath: path.join(dir, 'integrity-report.json'),
      // First trigger: a fetch that never settles (the #948 stall — an AbortSignal
      // that didn't fire, or a compare with no timeout). Later: a normal clean check.
      runParityCheck: () => (++call === 1 ? new Promise<ParityResult>(() => {}) : Promise.resolve(CLEAN)),
      maxLiveFetchMs: 40,
      now: () => nowMs,
    });
    const stuck = await r.runParityPass();
    expect(stuck.ok).toBe(false);
    if (!stuck.ok) expect(stuck.reason).toMatch(/max-hold budget|#948/);
    expect(monitor.passes.length).toBe(fed); // the stalled pass recorded NOTHING

    // THE FIX: the lock is released, so the next pass is NOT refused with
    // "already in flight" (pre-fix it was stuck for ~85 minutes) — it runs.
    const after = await r.runParityPass();
    expect(after.ok).toBe(true);
    expect(monitor.passes.length).toBe(fed + 1); // the recovered pass actually recorded
  });

  it('runImportDryRunPass: a live fetch that NEVER settles hits the max-hold and releases the lock (#948)', async () => {
    let call = 0;
    const r = new CutoverReadiness({
      parityMonitor: monitor,
      integrityReportPath: path.join(dir, 'integrity-report.json'),
      runParityCheck: null,
      importDryRunReportPath: path.join(dir, 'import-dryrun.json'),
      runImportDryRun: ((): Promise<typeof PASSED_RUN> =>
        (++call === 1 ? new Promise<typeof PASSED_RUN>(() => {}) : Promise.resolve(PASSED_RUN))),
      maxLiveFetchMs: 40,
      now: () => nowMs,
    });
    const stuck = await r.runImportDryRunPass();
    expect(stuck.ok).toBe(false);
    if (!stuck.ok) expect(stuck.reason).toMatch(/max-hold budget|#948/);
    expect(fs.existsSync(path.join(dir, 'import-dryrun.json'))).toBe(false); // nothing recorded

    // Lock released → the next dry-run proceeds (not refused as in-flight).
    const after = await r.runImportDryRunPass();
    expect(after.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'import-dryrun.json'))).toBe(true);
  });

  // ── the composed signal + the door ──

  it('ready ONLY when integrity passed AND parity cleared AND fresh; door is machine-readably manual', () => {
    const r = build();
    expect(r.status().ready).toBe(false);                    // nothing green
    r.recordIntegrityReport(PASSED_REPORT);
    expect(r.status().ready).toBe(false);                    // integrity alone insufficient
    feedCleanWindow();
    const s = r.status();
    expect(s.ready).toBe(true);                              // both green + fresh
    expect(s.door).toBe('manual-operator-click');            // decision 1A, structural
    r.recordIntegrityReport(FAILED_REPORT);
    expect(r.status().ready).toBe(false);                    // integrity regression re-blocks
  });

  it('parity window is DURABLE: a fresh monitor over the same file resumes the streak', () => {
    feedCleanWindow();
    const resumed = new DurableParityMonitor(new JsonlPassPersistence(path.join(dir, 'passes.jsonl')));
    const r = new CutoverReadiness({
      parityMonitor: resumed,
      integrityReportPath: path.join(dir, 'integrity-report.json'),
      runParityCheck: null,
      now: () => nowMs,
    });
    expect(r.parityStatus().cleared).toBe(true);
  });

  // ── the import dry-run leg (rehearsal — informational, NEVER a ready input) ──

  function buildWithDryRun(runImportDryRun: (() => Promise<import('../../src/feedback-factory/migration/importRunner.js').ImportRunResult>) | null) {
    return new CutoverReadiness({
      parityMonitor: monitor,
      integrityReportPath: path.join(dir, 'integrity-report.json'),
      runParityCheck: null,
      importDryRunReportPath: path.join(dir, 'import-dryrun.json'),
      runImportDryRun,
      now: () => nowMs,
    });
  }

  const PASSED_RUN = {
    report: PASSED_REPORT, imported: { clusters: 1346, feedback: 9000 },
    abortedPreImport: null, passed: true,
  };

  it('records a successful dry-run to the SEPARATE path and surfaces it in status()', async () => {
    const r = buildWithDryRun(async () => PASSED_RUN);
    const outcome = await r.runImportDryRunPass();
    expect(outcome.ok).toBe(true);

    const s = r.status();
    expect(s.importDryRun).toMatchObject({ ran: true, passed: true, imported: { clusters: 1346, feedback: 9000 }, abortedPreImport: null });
    // READINESS HONESTY — the heart of the design: a green rehearsal must not
    // touch `ready` or the canonical integrity leg.
    expect(s.ready).toBe(false);
    expect(s.integrity.ran).toBe(false);
    expect(fs.existsSync(path.join(dir, 'integrity-report.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'import-dryrun.json'))).toBe(true);
  });

  it('a FAILED dry-run check records nothing', async () => {
    const r = buildWithDryRun(async () => { throw new Error('source unreachable'); });
    const outcome = await r.runImportDryRunPass();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('source unreachable');
    expect(r.importDryRunStatus().ran).toBe(false);
    expect(fs.existsSync(path.join(dir, 'import-dryrun.json'))).toBe(false);
  });

  it('refuses when no import source is configured', async () => {
    const r = buildWithDryRun(null);
    const outcome = await r.runImportDryRunPass();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('no import source configured');
  });

  it('surfaces a pre-import abort (fingerprint collisions) distinctly', async () => {
    const r = buildWithDryRun(async () => ({
      report: null, imported: { clusters: 0, feedback: 0 },
      abortedPreImport: { reason: 'fingerprint-collision' as const, collisions: [{ fingerprint: 'x', clusterIds: ['a', 'b'] }] },
      passed: false,
    }));
    await r.runImportDryRunPass();
    const s = r.importDryRunStatus();
    expect(s).toMatchObject({ ran: true, passed: false, abortedPreImport: 'fingerprint-collision' });
  });

  it('REFUSES wiring the dry-run report onto the canonical integrity path (structural guard)', () => {
    expect(() => new CutoverReadiness({
      parityMonitor: monitor,
      integrityReportPath: path.join(dir, 'integrity-report.json'),
      runParityCheck: null,
      importDryRunReportPath: path.join(dir, 'integrity-report.json'),
      runImportDryRun: async () => PASSED_RUN,
      now: () => nowMs,
    })).toThrow(/must differ/);
  });

  it('a torn/corrupt dry-run envelope reads as never-ran (deny-safe, informational)', async () => {
    const r = buildWithDryRun(async () => PASSED_RUN);
    await r.runImportDryRunPass();
    fs.writeFileSync(path.join(dir, 'import-dryrun.json'), '{"generatedAt": "2026-');
    expect(r.importDryRunStatus()).toMatchObject({ ran: false, passed: false });
  });
  // ── single-flight guard over the live source fetch ──

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  function buildBoth(runParityCheck: () => Promise<ParityResult>, runImportDryRun: () => Promise<typeof PASSED_RUN>) {
    return new CutoverReadiness({
      parityMonitor: monitor,
      integrityReportPath: path.join(dir, 'integrity-report.json'),
      runParityCheck,
      importDryRunReportPath: path.join(dir, 'import-dryrun.json'),
      runImportDryRun,
      now: () => nowMs,
    });
  }

  it('a concurrent parity pass is REFUSED while one is in flight, and records nothing', async () => {
    // The live 2026-06-05 incident: the route 408s while the handler keeps
    // running, so a retrying feeder piled four CONCURRENT full fetches onto a
    // degraded source. The guard makes the second trigger an immediate refusal.
    const gate = deferred<ParityResult>();
    const r = build(() => gate.promise);

    const first = r.runParityPass();
    const second = await r.runParityPass();
    expect(second.ok).toBe(false);
    expect((second as { ok: false; reason: string }).reason).toContain('already in flight');
    expect((second as { ok: false; reason: string }).reason).toContain('parity-pass');
    expect(monitor.passes.length).toBe(0); // the refusal recorded nothing

    gate.resolve(CLEAN);
    const firstOutcome = await first;
    expect(firstOutcome.ok).toBe(true);
    expect(monitor.passes.length).toBe(1); // only the real pass recorded
  });

  it('the guard RELEASES after a pass completes — the next trigger runs', async () => {
    const r = build(async () => CLEAN);
    expect((await r.runParityPass()).ok).toBe(true);
    expect((await r.runParityPass()).ok).toBe(true);
    expect(monitor.passes.length).toBe(2);
  });

  it('the guard RELEASES after a FAILED check too (no wedged refusals)', async () => {
    let calls = 0;
    const r = build(async () => { calls++; if (calls === 1) throw new Error('page 3 timed out'); return CLEAN; });
    const failed = await r.runParityPass();
    expect(failed.ok).toBe(false);
    expect((failed as { ok: false; reason: string }).reason).toContain('page 3 timed out');
    const next = await r.runParityPass();
    expect(next.ok).toBe(true); // not 'already in flight'
  });

  it('the guard is SHARED across ops: a dry-run is refused while a parity pass is in flight (and names the holder)', async () => {
    const gate = deferred<ParityResult>();
    const r = buildBoth(() => gate.promise, async () => PASSED_RUN);

    const parity = r.runParityPass();
    const dryRun = await r.runImportDryRunPass();
    expect(dryRun.ok).toBe(false);
    expect((dryRun as { ok: false; reason: string }).reason).toContain('parity-pass');
    expect(fs.existsSync(path.join(dir, 'import-dryrun.json'))).toBe(false); // refusal persisted nothing

    gate.resolve(CLEAN);
    await parity;
    expect((await r.runImportDryRunPass()).ok).toBe(true); // released → dry-run runs
  });

  it('and symmetrically: a parity pass is refused while a dry-run is in flight', async () => {
    const gate = deferred<typeof PASSED_RUN>();
    const r = buildBoth(async () => CLEAN, () => gate.promise);

    const dryRun = r.runImportDryRunPass();
    const parity = await r.runParityPass();
    expect(parity.ok).toBe(false);
    expect((parity as { ok: false; reason: string }).reason).toContain('import-dry-run');
    expect(monitor.passes.length).toBe(0);

    gate.resolve(PASSED_RUN);
    await dryRun;
    expect((await r.runParityPass()).ok).toBe(true);
  });
});
