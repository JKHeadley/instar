import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { StopGateDb } from '../../src/core/StopGateDb.js';
import { UnjustifiedStopGate, type EvaluateInput } from '../../src/core/UnjustifiedStopGate.js';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const INPUT: EvaluateInput = {
  evidenceMetadata: { artifacts: [], signals: {}, sessionStartTs: null },
  untrustedContent: { stopReason: 'autonomous task complete', recentTurns: [] },
};

async function listen(gate: UnjustifiedStopGate): Promise<{ server: Server; url: string }> {
  const app = express();
  app.post('/internal/stop-gate/evaluate', async (_req, res) => {
    const outcome = await gate.evaluate(INPUT);
    if (outcome.ok) return res.json(outcome.result);
    return res.json({ decision: 'allow', failOpen: outcome.failure.kind, latencyMs: outcome.failure.latencyMs });
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

async function listenProductionAdminRoutes(gate: UnjustifiedStopGate): Promise<{ server: Server; url: string }> {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware('test-token', 'test-agent'));
  app.use(createRoutes({
    config: { authToken: 'test-token', stateDir: os.tmpdir(), port: 0 },
    stateDir: os.tmpdir(),
    startTime: new Date(),
    unjustifiedStopGate: gate,
  } as any));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

describe('Stop-gate breaker restart lifecycle E2E', () => {
  let dir = '';
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/stop-gate-breaker-restart-lifecycle.test.ts' });
  });

  it('HTTP → authority timeout → durable open → five server restarts never re-call provider', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-e2e-'));
    const dbPath = path.join(dir, 'stop-gate.db');
    let calls = 0;
    const intelligence = { evaluate: async () => { calls += 1; throw new Error('provider unavailable'); } };
    const boot = () => {
      const db = new StopGateDb({ dbPath });
      const gate = new UnjustifiedStopGate({
        intelligence,
        breakerThreshold: 3,
        breakerCooldownMs: 60_000,
        breakerStateStore: db,
        breakerKey: 'same-route-across-releases',
      });
      return { db, gate };
    };

    let runtime = boot();
    let http = await listen(runtime.gate);
    servers.push(http.server);
    for (let i = 0; i < 3; i++) await fetch(`${http.url}/internal/stop-gate/evaluate`, { method: 'POST' });
    expect(calls).toBe(3);
    await new Promise<void>((resolve) => http.server.close(() => resolve()));
    servers.pop();
    runtime.db.close();

    for (let restart = 0; restart < 5; restart++) {
      runtime = boot();
      http = await listen(runtime.gate);
      const response = await fetch(`${http.url}/internal/stop-gate/evaluate`, { method: 'POST' });
      expect(await response.json()).toMatchObject({ decision: 'allow', failOpen: 'breakerOpen' });
      await new Promise<void>((resolve) => http.server.close(() => resolve()));
      runtime.db.close();
    }
    expect(calls).toBe(3);
  });

  it('authenticates status/reset and reset admits the next authority probe', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-admin-e2e-'));
    const db = new StopGateDb({ dbPath: path.join(dir, 'stop-gate.db') });
    let calls = 0;
    const gate = new UnjustifiedStopGate({
      intelligence: { evaluate: async () => { calls += 1; throw new Error('provider unavailable'); } },
      breakerThreshold: 1,
      breakerCooldownMs: 60_000,
      breakerStateStore: db,
      breakerKey: 'admin-route',
    });
    await gate.evaluate(INPUT);
    const http = await listenProductionAdminRoutes(gate);
    servers.push(http.server);
    expect((await fetch(`${http.url}/internal/stop-gate/hot-path`)).status).toBe(401);
    const headers = { Authorization: 'Bearer test-token' };
    const status = await fetch(`${http.url}/internal/stop-gate/hot-path`, { headers });
    expect((await status.json()).breaker).toMatchObject({ open: true, consecutiveFailures: 1 });
    const reset = await fetch(`${http.url}/internal/stop-gate/reset-breaker`, { method: 'POST', headers });
    expect(reset.status).toBe(200);
    expect((await reset.json()).breaker).toMatchObject({ open: false, consecutiveFailures: 0 });
    await gate.evaluate(INPUT);
    expect(calls).toBe(2);
    db.close();
  });
});
