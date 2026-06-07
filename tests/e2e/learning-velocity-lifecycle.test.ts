/**
 * E2E (HTTP) lifecycle test for GET /metrics/learning-velocity (EXO 3.0 KPI
 * inversion). Tier-3: boots a REAL server on a real port with a REAL
 * learning-registry.json and makes a REAL HTTP call. Key assertion: alive (200,
 * not 404/503) and the metric computes end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DAY = 24 * 60 * 60 * 1000;
const agoIso = (days: number) => new Date(Date.now() - days * DAY).toISOString();

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('GET /metrics/learning-velocity — (E2E over HTTP)', () => {
  let server: TestServer, tmpDir: string, stateDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnvel-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    // Seed the REAL learnings source the live agent writes: state/evolution/
    // learning-registry.json with the timestamp at source.discoveredAt (not a
    // top-level field, not stateDir root). Mirrors the route + integration test.
    const evoDir = path.join(stateDir, 'state', 'evolution');
    fs.mkdirSync(evoDir, { recursive: true });
    fs.writeFileSync(path.join(evoDir, 'learning-registry.json'), JSON.stringify({
      learnings: [
        { source: { discoveredAt: agoIso(18) } }, { source: { discoveredAt: agoIso(12) } },
        { source: { discoveredAt: agoIso(6) } }, { source: { discoveredAt: agoIso(2) } },
      ],
    }));
    const app = express();
    app.use(express.json());
    const ctx: any = { config: { projectName: 'echo', authToken: 'test', stateDir, port: 0 }, startTime: new Date() };
    app.use(createRoutes(ctx));
    server = await listen(app);
  });

  afterEach(async () => { await server?.close(); SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/learning-velocity-lifecycle.test.ts:49' }); });

  it('FEATURE IS ALIVE: returns 200 and a computed learning-velocity metric', async () => {
    const res = await fetch(server.url + '/metrics/learning-velocity?windowDays=30');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalEvents).toBe(4);
    expect(body.byType.learning).toBe(4);
    expect(typeof body.adaptabilityScore).toBe('number');
    expect(body.windowDays).toBe(30);
  });
});
