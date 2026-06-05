/**
 * Tests for the parity-pass request-timeout fix (2026-06-05 live finding: a real
 * pass takes ~3.5 min — full live cluster fetch — so the 30s default 408'd every
 * trigger, and a late failure's 409 crashed into ERR_HTTP_HEADERS_SENT with no
 * trace of the outcome).
 *
 * Three layers: (1) the override resolves for the route (and ONLY the route —
 * the read-only sibling keeps the default); (2) over real HTTP with a tiny
 * timeout, a slow SUCCESSFUL pass still RECORDS and the outcome is logged with
 * no double-respond crash; (3) a slow FAILED pass records nothing and logs the
 * reason.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRequestTimeoutOverrides,
  resolveRequestTimeout,
  requestTimeout,
  PARITY_PASS_TIMEOUT_MS,
} from '../../src/server/middleware.js';
import { createRoutes } from '../../src/server/routes.js';
import { CutoverReadiness } from '../../src/feedback-factory/cutoverReadiness.js';
import { DurableParityMonitor, JsonlPassPersistence } from '../../src/feedback-factory/monitor/parityMonitorStore.js';
import type { ParityResult } from '../../src/feedback-factory/processor/parity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DEFAULT_MS = 30_000;

const CLEAN: ParityResult = {
  clustersCompared: 1346, clustersWithFingerprint: 746, outcomesCompared: 0,
  fingerprintDivergences: [], outcomeDivergences: [], divergent: false,
};

describe('parity-pass timeout override (wiring)', () => {
  const overrides = buildRequestTimeoutOverrides();

  it('resolves /cutover-readiness/parity-pass to the extended budget', () => {
    expect(resolveRequestTimeout('/cutover-readiness/parity-pass', DEFAULT_MS, overrides)).toBe(PARITY_PASS_TIMEOUT_MS);
    expect(PARITY_PASS_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000); // ≥ the measured ~3.5min real pass
  });

  it('the read-only readiness sibling keeps the default (only the trigger is extended)', () => {
    expect(resolveRequestTimeout('/cutover-readiness', DEFAULT_MS, overrides)).toBe(DEFAULT_MS);
  });
});

describe('parity-pass outcome survives a timed-out response', () => {
  let dir: string;
  let server: { url: string; close: () => Promise<void> };
  let monitor: DurableParityMonitor;
  let check: () => Promise<ParityResult>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-timeout-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    monitor = new DurableParityMonitor(new JsonlPassPersistence(path.join(dir, 'passes.jsonl')));
    const readiness = new CutoverReadiness({
      parityMonitor: monitor,
      integrityReportPath: path.join(dir, 'integrity.json'),
      runParityCheck: () => check(),
    });
    const app = express();
    app.use(express.json());
    // A 50ms budget so the 408 fires long before the 150ms "slow" check finishes.
    app.use(requestTimeout(50, {}));
    const ctx: any = { cutoverReadiness: readiness, config: { authToken: 't', stateDir: '/tmp', port: 0 }, stateDir: '/tmp' };
    app.use(createRoutes(ctx));
    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => resolve({
        url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      }));
    });
  });
  afterEach(async () => {
    await server.close();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/parity-pass-timeout.test.ts' });
  });

  it('a slow SUCCESSFUL pass: client gets 408, the pass still RECORDS, outcome logged, no crash', async () => {
    check = () => new Promise((r) => setTimeout(() => r(CLEAN), 150));
    const res = await fetch(`${server.url}/cutover-readiness/parity-pass`, { method: 'POST' });
    expect(res.status).toBe(408); // the middleware's timeout response
    await new Promise((r) => setTimeout(r, 250)); // let the handler finish
    expect(monitor.passes.length).toBe(1); // RECORDED despite the timed-out response
    expect(monitor.passes[0].divergent).toBe(false);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('parity pass recorded'))).toBe(true);
  });

  it('a slow FAILED pass: client gets 408, nothing recorded, reason logged, no crash', async () => {
    check = () => new Promise((_, rej) => setTimeout(() => rej(new Error('Portal 503')), 150));
    const res = await fetch(`${server.url}/cutover-readiness/parity-pass`, { method: 'POST' });
    expect(res.status).toBe(408);
    await new Promise((r) => setTimeout(r, 250));
    expect(monitor.passes.length).toBe(0);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('parity pass FAILED'))).toBe(true);
  });

  it('a FAST pass still gets the normal 200 with the gate snapshot', async () => {
    check = async () => CLEAN;
    const res = await fetch(`${server.url}/cutover-readiness/parity-pass`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recorded).toBe(true);
    expect(body.pass.clustersCompared).toBe(1346);
  });
});
