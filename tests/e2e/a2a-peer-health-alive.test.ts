// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the A2A peer-health surface
 * (A2A-DURABLE-DELIVERY-SPEC.md): GET /threadline/peers/health and
 * /threadline/peers/:fp/health.
 *
 * Per TESTING-INTEGRITY-SPEC: the single most important test for a feature with
 * API routes — is it actually alive on the production init path (200, not
 * 404/503)? This boots the REAL AgentServer (same path server.ts uses) WITHOUT
 * injecting a tracker, proving AgentServer self-constructs the A2ADeliveryTracker
 * from stateDir so the routes are alive on every entry path — NOT a 503-stub.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('A2A peer-health E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-a2a-peer-health';
  const FP = '8c7928aa9f04fbda947172a2f9b2d81a';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-peer-health-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;

    // NOTE: no a2aDeliveryTracker injected — AgentServer must self-construct it.
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/a2a-peer-health-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /threadline/peers/health is alive (200, not 503) with the real shape', async () => {
    const res = await request(app).get('/threadline/peers/health').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(Array.isArray(res.body.peers)).toBe(true);
    expect(res.body.count).toBe(0); // empty until traffic, but the surface is ALIVE
    expect(res.body.staleCount).toBe(0);
  });

  it('GET /threadline/peers/:fp/health is alive and returns a composed record', async () => {
    const res = await request(app).get(`/threadline/peers/${FP}/health`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.peerFp).toBe(FP);
    expect(res.body.pendingCount).toBe(0);
    expect(res.body.stale).toBe(false);
    // The DB file the route reads was actually created on disk by the prod init.
    expect(fs.existsSync(path.join(stateDir, 'state', 'a2a-delivery.e2e.sqlite'))).toBe(true);
  });

  it('is bearer-gated like every other own-surface /threadline route (fb-829a7161-942)', async () => {
    // Until 2026-10-27 the whole /threadline/ prefix was exempt from the bearer
    // gate, which is how an unauthenticated tunnel request reached
    // /threadline/relay-send. Only the six peer-protocol routes stay public
    // (middleware.ts THREADLINE_PUBLIC_ROUTES); this own-surface read now
    // refuses a token-less request before the handler runs.
    const bare = await request(app).get('/threadline/peers/health');
    expect(bare.status).toBe(401);
    const authed = await request(app).get('/threadline/peers/health').set(auth());
    expect(authed.status).toBe(200);
    expect(Array.isArray(authed.body.peers)).toBe(true);
  });
});
