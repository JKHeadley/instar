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

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutready-routes-'));
    monitor = new DurableParityMonitor(new JsonlPassPersistence(path.join(dir, 'passes.jsonl')));
    parityCheck = null;
    const readiness = new CutoverReadiness({
      parityMonitor: monitor,
      integrityReportPath: path.join(dir, 'integrity-report.json'),
      // Late-bound so each test can choose the server-side check behavior.
      runParityCheck: () => (parityCheck ? parityCheck() : Promise.reject(new Error('no check bound'))),
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
});
