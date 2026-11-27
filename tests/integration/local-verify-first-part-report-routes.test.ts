// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { afterEach, expect, it } from 'vitest';
import { FirstPartReport, type Observation } from '../../src/localVerify/firstPartReport.js';
import { registerLocalVerifyRoutes } from '../../src/localVerify/localVerifyRoutes.js';
import { inProcessHttp } from '../helpers/localVerifyInProcessHttp.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-first-part-report-routes.test.ts' }); });
it('serves all three authenticated-router endpoints on a non-coordinator without consulting the lease gate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-')); dirs.push(dir);
  let now = Date.now();
  const store = new FirstPartReport(dir, () => now, () => {});
  store.readSetting('alternate');
  const app = express(); app.use(express.json());
  registerLocalVerifyRoutes(app, { service: () => ({ firstPartReport: store, likelyFailingFirst: () => 'alternate' }) as never,
    lease: { holdsLease: () => false, holderMachineId: () => 'other' } });
  const get = () => inProcessHttp(app, 'GET', '/local-verify/first-part-report?evaluate=1');
  expect((await get()).status).toBe(200);
  now++;
  expect((await inProcessHttp(app, 'POST', '/local-verify/first-part-report/new-trial', {})).status).toBe(200);
  for (let i = 0; i < 4; i++) store.observe({ type: 'observation', id: String(i), at: now, startedAt: now, pr: i + 1, head: 'h', base: 'b',
    setting: 'alternate', group: 'with', ran: true, outcome: 'failure', minutes: 2, incomplete: false, completedLanes: ['unit'],
    firstPartFiles: { unit: ['x'] }, failures: [{ file: 'x', lane: 'unit', firstPart: true, own: false, result: 'failed' }], failuresTotal: 1 } satisfies Observation);
  expect((await get()).body.open).toBe(1);
  for (const body of [{ suspect: 'absent', finding: 'unknown', reason: '' }, { suspect: 'x', finding: 'invalid', reason: '' }, { suspect: 'x', finding: 'explained', reason: 'x'.repeat(301) }]) {
    expect((await inProcessHttp(app, 'POST', '/local-verify/first-part-finding', body)).status).toBe(400);
  }
  expect((await inProcessHttp(app, 'POST', '/local-verify/first-part-finding', { suspect: 'x', finding: 'unknown', reason: 'awaiting rig' })).body.suspects[0].unresolved).toBe(true);
  expect((await inProcessHttp(app, 'POST', '/local-verify/first-part-finding', { suspect: 'x', finding: 'explained', reason: 'both arrangements unreliable' })).body.open).toBe(0);
  expect((await get()).body.suspects[0].findings.at(-1).reason).toBe('both arrangements unreliable');
});
