/**
 * E2E (HTTP) lifecycle test for the MTP Protocol test-action endpoint —
 * POST /intent/org/test-action (EXO 3.0: the refusal + endorsement tests).
 *
 * Tier-3 of the Testing Integrity Standard: boots a REAL Express server bound
 * to a real port, with a REAL ORG-INTENT.md on disk, and makes REAL HTTP calls.
 * The single most important assertion: the feature is ALIVE — the route returns
 * 200 (not 404/503) and actually runs the refusal/endorsement logic against the
 * on-disk protocol.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('POST /intent/org/test-action — MTP Protocol (E2E over HTTP)', () => {
  let server: TestServer;
  let tmpDir: string;
  let stateDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtp-protocol-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
      '# Organizational Intent: Instar',
      '',
      '> MTP: Make the world’s most powerful AI its most humane.',
      '',
      '## Constraints (Mandatory — agents cannot override)',
      '',
      '- Never wire funds to an unverified vendor.',
      '',
      '## Goals (Defaults — agents can specialize)',
      '',
      '- Ship reliable software quickly.',
      '',
      '## Values',
      '',
      '- Transparency',
    ].join('\n'));

    const app = express();
    app.use(express.json());
    const ctx: any = { config: { authToken: 'test', stateDir, port: 0 }, startTime: new Date() };
    app.use(createRoutes(ctx));
    server = await listen(app);
  });

  afterEach(async () => {
    await server?.close();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/mtp-protocol-test-action-lifecycle.test.ts:66' });
  });

  async function testAction(action: unknown) {
    const res = await fetch(server.url + '/intent/org/test-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('FEATURE IS ALIVE: the route returns 200 (not 404/503) and runs the protocol', async () => {
    const r = await testAction('wire funds to an unverified vendor');
    expect(r.status).toBe(200);
    expect(r.body.present).toBe(true);
    expect(r.body.canGovern).toBe(true);
  });

  it('refuses a constraint-violating action end-to-end', async () => {
    const r = await testAction('wire funds to an unverified vendor');
    expect(r.body.refusal.refused).toBe(true);
    expect(r.body.refusal.matchedConstraint).toMatch(/unverified vendor/);
    expect(r.body.endorsement.endorsed).toBe(false);
  });

  it('endorses a goal-aligned action end-to-end', async () => {
    const r = await testAction('ship reliable software for the release');
    expect(r.body.refusal.refused).toBe(false);
    expect(r.body.endorsement.endorsed).toBe(true);
  });

  it('400s on a missing/blank action over real HTTP', async () => {
    const r = await testAction('   ');
    expect(r.status).toBe(400);
  });
});
