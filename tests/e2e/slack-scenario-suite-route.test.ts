/**
 * E2E (HTTP) lifecycle test for the test-as-self-for-Slack demonstration routes
 * (Pillar 4, §8.4). Tier-3: boots a REAL Express server on a real port and makes
 * REAL HTTP calls over the production route surface (createRoutes — the same path
 * server.ts wires). Key assertion: the demonstration is ALIVE — 200, not 404/503 —
 * and the full green report (decision AND audit entry per row) actually comes back.
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

describe('Slack permission demonstration routes — (E2E over HTTP)', () => {
  let server: TestServer;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    const ctx: any = { config: { authToken: 'test', stateDir: '/tmp/.instar-slack-e2e', port: 0 }, startTime: new Date() };
    app.use(createRoutes(ctx));
    server = await listen(app);
  });

  afterEach(async () => { await server?.close(); });

  it('FEATURE IS ALIVE: GET /permissions/scenario-suite returns 200 with a full green report', async () => {
    const res = await fetch(server.url + '/permissions/scenario-suite');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.total).toBe(8);
    expect(body.summary.failed).toBe(0);
    expect(body.rows).toHaveLength(8);
  });

  it('FEATURE IS ALIVE: POST /permissions/scenario-suite/run returns 200 and asserts verdict AND audit per row', async () => {
    const res = await fetch(server.url + '/permissions/scenario-suite/run', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.total).toBe(8);
    expect(body.summary.passed).toBe(8);
    expect(body.summary.failed).toBe(0);
    // Every row green on BOTH dimensions — "verified, not narrated".
    for (const row of body.rows) {
      expect(row.verdictOk).toBe(true);
      expect(row.auditOk).toBe(true);
      expect(row.pass).toBe(true);
    }
    // The step-up + the two added deterministic rows are present and pass.
    const ids = body.rows.map((r: any) => r.id);
    expect(ids).toContain('5-spoofed-ceo');
    expect(ids).toContain('7-granted-member-floor');
    expect(ids).toContain('8-unregistered-outsider');
  });
});
