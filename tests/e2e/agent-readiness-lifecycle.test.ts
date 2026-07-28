/**
 * E2E (HTTP) lifecycle test for POST /agent-readiness/score (EXO 3.0 task
 * decomposition matrix). Tier-3: boots a REAL Express server on a real port and
 * makes REAL HTTP calls. Key assertion: the feature is ALIVE — 200, not 404/503,
 * and the scoring actually runs end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('POST /agent-readiness/score — (E2E over HTTP)', () => {
  let server: TestServer;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    const ctx: any = { config: { authToken: 'test', stateDir: '/tmp/.instar', port: 0 }, startTime: new Date() };
    app.use(createRoutes(ctx));
    server = await listen(app);
  });

  afterEach(async () => { await server?.close(); });

  async function score(body: object) {
    const res = await fetch(server.url + '/agent-readiness/score', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('FEATURE IS ALIVE: returns 200 (not 404/503) and scores a task', async () => {
    const r = await score({ task: { description: 'Route invoices and schedule approvals and track status.' } });
    expect(r.status).toBe(200);
    expect(typeof r.body.overallReadiness).toBe('number');
    expect(r.body.recommendation).toBeDefined();
  });

  it('recommends deploy-agent for coordination-dominant work end-to-end', async () => {
    const r = await score({ task: { description: 'Route, schedule, track status, compile a report, notify. Standardized and repetitive.' } });
    expect(r.body.recommendation).toBe('deploy-agent');
  });

  it('400s when the body has neither task nor workflow', async () => {
    const r = await score({ nonsense: true });
    expect(r.status).toBe(400);
  });
});
