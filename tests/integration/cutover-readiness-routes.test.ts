/**
 * Tier-2 integration tests for the /cutover-readiness routes (coordination-mandate
 * spec §7 G2.4) — the full HTTP pipeline over a REAL CutoverReadiness.
 *
 * Load-bearing: the readiness endpoint is read-only truth from durable state, the
 * parity-pass trigger computes server-side (the body contributes nothing), a failed
 * check records nothing (409), and there is NO fire-cutover route.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { CutoverReadiness } from '../../src/feedback-factory/cutoverReadiness.js';
import { DurableParityMonitor, JsonlPassPersistence } from '../../src/feedback-factory/monitor/parityMonitorStore.js';
import type { ImportRunResult } from '../../src/feedback-factory/migration/importRunner.js';
import type { ParityResult } from '../../src/feedback-factory/processor/parity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Server { url: string; close: () => Promise<void>; }

async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

const CLEAN: ParityResult = {
  clustersCompared: 1346, clustersWithFingerprint: 1346, outcomesCompared: 0,
  fingerprintDivergences: [], outcomeDivergences: [], divergent: false,
};

function buildApp(cutoverReadiness: CutoverReadiness | null): express.Express {
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  const ctx: any = {
    cutoverReadiness,
    config: { authToken: 'test', stateDir: '/tmp', port: 0 },
    stateDir: '/tmp',
  };
  app.use(createRoutes(ctx));
  return app;
}

describe('Cutover-readiness routes (spec §7 G2.4)', () => {
  let dir: string;
  let server: Server;
  let monitor: DurableParityMonitor;
  let parityCheck: (() => Promise<ParityResult>) | null;
  let importDryRun: (() => Promise<ImportRunResult>) | null;
  let integrityImport: (() => Promise<ImportRunResult>) | null;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutready-routes-'));
    monitor = new DurableParityMonitor(new JsonlPassPersistence(path.join(dir, 'passes.jsonl')));
    parityCheck = null;
    importDryRun = null;
    integrityImport = null;
    const readiness = new CutoverReadiness({
      parityMonitor: monitor,
      integrityReportPath: path.join(dir, 'integrity-report.json'),
      // Late-bound so each test can choose the server-side check behavior.
      runParityCheck: () => (parityCheck ? parityCheck() : Promise.reject(new Error('no check bound'))),
      importDryRunReportPath: path.join(dir, 'import-dryrun.json'),
      runImportDryRun: () => (importDryRun ? importDryRun() : Promise.reject(new Error('no dry-run bound'))),
      runIntegrityImport: () => (integrityImport ? integrityImport() : Promise.reject(new Error('no integrity import bound'))),
    });
    server = await listen(buildApp(readiness));
  });
  afterEach(async () => {
    await server.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/cutover-readiness-routes.test.ts' });
  });

  it('GET /cutover-readiness returns the composed read-only status with the manual door', async () => {
    const res = await fetch(`${server.url}/cutover-readiness`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.door).toBe('manual-operator-click');
    expect(body.integrity.ran).toBe(false);
    expect(body.parity.cleared).toBe(false);
  });

  it('POST /cutover-readiness/parity-pass triggers the SERVER-SIDE check and records the pass', async () => {
    parityCheck = async () => CLEAN;
    const res = await fetch(`${server.url}/cutover-readiness/parity-pass`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // A hostile body asserting cleanliness — it must contribute NOTHING.
      body: JSON.stringify({ divergent: false, divergences: 0, cleared: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recorded).toBe(true);
    expect(body.pass.clustersCompared).toBe(1346); // from the server-side check, not the body
    expect(monitor.passes.length).toBe(1);
  });

  it('a FAILED server-side check is 409 and records NOTHING', async () => {
    parityCheck = async () => { throw new Error('Portal unreachable'); };
    const res = await fetch(`${server.url}/cutover-readiness/parity-pass`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/parity check failed/);
    expect(monitor.passes.length).toBe(0);
  });


  it('a CONCURRENT trigger is 409 \'already in flight\' over the full pipeline (one live fetch at a time)', async () => {
    // The live 2026-06-05 incident shape: a slow degraded-source pass holds the
    // handler past the client's patience; a second trigger must refuse instantly
    // instead of piling another full fetch onto the source.
    let release!: (v: ParityResult) => void;
    parityCheck = () => new Promise<ParityResult>((res) => { release = res; });

    const first = fetch(`${server.url}/cutover-readiness/parity-pass`, { method: 'POST' });
    // Give the first request time to reach the handler and take the guard.
    await new Promise((r) => setTimeout(r, 150));

    const second = await fetch(`${server.url}/cutover-readiness/parity-pass`, { method: 'POST' });
    expect(second.status).toBe(409);
    const refusal = await second.json();
    expect(refusal.error).toContain('already in flight');

    // The guard is shared with the import dry-run (same live source).
    const dryRun = await fetch(`${server.url}/cutover-readiness/import-dryrun`, { method: 'POST' });
    expect(dryRun.status).toBe(409);
    expect((await dryRun.json()).error).toContain('parity-pass');

    release(CLEAN);
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    expect((await firstRes.json()).recorded).toBe(true);
    expect(monitor.passes.length).toBe(1); // exactly one pass recorded
  });

  it('there is NO fire-cutover route (decision 1A is structural)', async () => {
    for (const p of ['/cutover-readiness/execute', '/cutover-readiness/fire', '/cutover-readiness/cutover']) {
      const res = await fetch(`${server.url}${p}`, { method: 'POST' });
      expect([404].includes(res.status)).toBe(true);
    }
  });

  it('both routes 503 when the checker is unavailable', async () => {
    const s2 = await listen(buildApp(null));
    try {
      expect((await fetch(`${s2.url}/cutover-readiness`)).status).toBe(503);
      expect((await fetch(`${s2.url}/cutover-readiness/parity-pass`, { method: 'POST' })).status).toBe(503);
    } finally {
      await s2.close();
    }
  });

  // ── the import dry-run trigger (rehearsal — informational, never a ready input) ──

  const PASSED_RUN: ImportRunResult = {
    report: {
      fingerprintCollisions: [], schemaDivergences: [], checksumMismatches: [],
      danglingRefs: [], sequenceResetTo: 1347, passed: true,
    },
    imported: { clusters: 1346, feedback: 9000 },
    abortedPreImport: null,
    passed: true,
  };

  it('POST /cutover-readiness/import-dryrun triggers the SERVER-SIDE rehearsal and persists to the dry-run path only', async () => {
    importDryRun = async () => PASSED_RUN;
    const res = await fetch(`${server.url}/cutover-readiness/import-dryrun`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // Hostile body asserting success — must contribute NOTHING (T7).
      body: JSON.stringify({ passed: true, report: { passed: true } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recorded).toBe(true);
    expect(body.mode).toBe('dry-run');
    expect(body.result.imported.clusters).toBe(1346); // from the server-side run, not the body

    // The rehearsal landed at the dry-run path — the canonical integrity report does not exist.
    expect(fs.existsSync(path.join(dir, 'import-dryrun.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'integrity-report.json'))).toBe(false);

    // Readiness honesty over the full HTTP pipeline: status shows the rehearsal, ready stays false.
    const status = await (await fetch(`${server.url}/cutover-readiness`)).json();
    expect(status.importDryRun).toMatchObject({ ran: true, passed: true });
    expect(status.integrity.ran).toBe(false);
    expect(status.ready).toBe(false);
  });

  it('GET /cutover-readiness/import-dryrun serves the last rehearsal verdict (read-only)', async () => {
    expect(await (await fetch(`${server.url}/cutover-readiness/import-dryrun`)).json()).toMatchObject({ ran: false });
    importDryRun = async () => PASSED_RUN;
    await fetch(`${server.url}/cutover-readiness/import-dryrun`, { method: 'POST' });
    const body = await (await fetch(`${server.url}/cutover-readiness/import-dryrun`)).json();
    expect(body).toMatchObject({ ran: true, passed: true, imported: { clusters: 1346, feedback: 9000 } });
  });

  it('a FAILED rehearsal is 409 and records NOTHING', async () => {
    importDryRun = async () => { throw new Error('source unreachable'); };
    const res = await fetch(`${server.url}/cutover-readiness/import-dryrun`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/import dry-run failed/);
    expect(fs.existsSync(path.join(dir, 'import-dryrun.json'))).toBe(false);
  });

  it('import-dryrun routes 503 when the checker is unavailable', async () => {
    const s2 = await listen(buildApp(null));
    try {
      expect((await fetch(`${s2.url}/cutover-readiness/import-dryrun`, { method: 'POST' })).status).toBe(503);
      expect((await fetch(`${s2.url}/cutover-readiness/import-dryrun`)).status).toBe(503);
    } finally {
      await s2.close();
    }
  });

  // ── the REAL integrity pass (LOAD-BEARING: greens/flips the canonical integrity leg) ──

  it('POST /cutover-readiness/integrity-pass records to the CANONICAL path and GREENS the integrity leg', async () => {
    integrityImport = async () => PASSED_RUN;
    const res = await fetch(`${server.url}/cutover-readiness/integrity-pass`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passed: false }), // hostile body — contributes NOTHING (T7)
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recorded).toBe(true);
    expect(body.result.imported.clusters).toBe(1346); // from the server-side run, not the body
    // UNLIKE the dry-run: the canonical integrity report exists + the leg reads green.
    expect(fs.existsSync(path.join(dir, 'integrity-report.json'))).toBe(true);
    const status = await (await fetch(`${server.url}/cutover-readiness`)).json();
    expect(status.integrity).toMatchObject({ ran: true, passed: true });
  });

  it('a FAILED integrity pass records the failing report → integrity leg reads CLOSED, ready stays false', async () => {
    integrityImport = async () => ({
      ...PASSED_RUN,
      report: { ...PASSED_RUN.report!, checksumMismatches: [{ kind: 'cluster', id: 'c1', sourceChecksum: 'a', targetChecksum: 'b' } as any], passed: false },
      passed: false,
    });
    const res = await fetch(`${server.url}/cutover-readiness/integrity-pass`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).recorded).toBe(true);
    const status = await (await fetch(`${server.url}/cutover-readiness`)).json();
    expect(status.integrity).toMatchObject({ ran: true, passed: false });
    expect(status.ready).toBe(false);
  });

  it('a FAILED integrity fetch is 409 and records NOTHING', async () => {
    integrityImport = async () => { throw new Error('portal unreachable'); };
    const res = await fetch(`${server.url}/cutover-readiness/integrity-pass`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/integrity pass failed/);
    expect(fs.existsSync(path.join(dir, 'integrity-report.json'))).toBe(false);
  });

  it('integrity-pass route 503s when the checker is unavailable', async () => {
    const s2 = await listen(buildApp(null));
    try {
      expect((await fetch(`${s2.url}/cutover-readiness/integrity-pass`, { method: 'POST' })).status).toBe(503);
    } finally {
      await s2.close();
    }
  });
});
