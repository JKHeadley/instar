// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E — the Gemini pay-per-use lane is wired on the PRODUCTION init path
 * (docs/specs/gemini-payg-metered-lane.md §1, §2, §6). Boots the real AgentServer the
 * way server.ts does, with the fleet default (money layer OFF, no go-live):
 *   - the routes are ALIVE and answer honestly (503 money-layer-off / not-configured),
 *     never 404 and never a spend;
 *   - the lane runtime exists (the mesh handlers and secret sync read it) and fences:
 *     not the holder ⇒ no lease confirmation; no designation ⇒ metered keys go nowhere.
 * The money-on 200 path (intent applied, release gate satisfied) is pinned by the go-live
 * slice's E2E.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Gemini pay-per-use lane E2E (wired on the production init path, dark by default)', () => {
  let tmpDir: string;
  let server: AgentServer;
  const AUTH = 'test-e2e-gemini-payg';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-payg-e2e-'));
    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    const config = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null } as never, state: new StateManager(stateDir) });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/gemini-payg-lane-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('POST /intelligence/gemini is alive and refuses honestly with the money layer off (503, never a spend)', async () => {
    const r = await request(server.getApp()).post('/intelligence/gemini').set(auth()).send({ prompt: 'q', purpose: 'e2e' });
    expect(r.status).not.toBe(404);
    expect(r.status).toBe(503);
    expect(['money-layer-off', 'no-cap-slice']).toContain(r.body.reason);
  });

  it('the routes sit behind the Bearer middleware', async () => {
    const r = await request(server.getApp()).post('/intelligence/gemini').send({ prompt: 'q', purpose: 'e2e' });
    expect(r.status).toBe(401);
  });

  it('GET /intelligence/gemini/status says not-configured; the review route is alive and validates', async () => {
    const st = await request(server.getApp()).get('/intelligence/gemini/status').set(auth());
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ configured: false, ready: false });
    const rv = await request(server.getApp()).post('/intelligence/gemini/review').set(auth()).send({});
    expect(rv.status).toBe(400);
    expect(rv.body.reason).toBe('bad-request');
  });

  it('the local-only routes refuse a forwarded (tunnel-style) request on the real boot path', async () => {
    // A tunnel connects from loopback too; the forwarded headers (and, for the same-network
    // listener, mayBeLocalArrival) are what keep these routes local-only.
    const st = await request(server.getApp()).get('/intelligence/gemini/status').set(auth()).set('X-Forwarded-For', '203.0.113.9');
    expect(st.status).toBe(403);
    const e2 = await request(server.getApp()).post('/intelligence/gemini').set(auth()).set('X-Forwarded-Host', 'echo.example').send({ prompt: 'q', purpose: 'e2e' });
    expect(e2.status).toBe(403);
  });

  it('the lane runtime is constructed (wiring integrity) and fences when nothing is designated', async () => {
    const rt = server.meteredLaneRuntime;
    expect(rt).not.toBeNull();
    expect(rt!.holder()).toBeNull();
    expect(rt!.isDesignatedHere()).toBe(false);
    expect(rt!.leaseConfirmedAgoMs()).toBeNull();
    expect(rt!.meteredDesignation()).toBeNull();
    const names = (await rt!.handleMesh({ type: 'secret-names' }, 'm_peer')) as { names: string[] };
    expect(Array.isArray(names.names)).toBe(true);
    // A forwarded call to a machine that is not the holder is refused, never run.
    const ack = (await rt!.handleMesh({ type: 'metered-gemini-call', op: 'second-opinion', session: 's', callId: 'a'.repeat(64), requestSha256: 'b', resultTokenHash: 'c'.repeat(64), payload: {} }, 'm_peer')) as { state: string; reason?: string };
    expect(ack).toMatchObject({ state: 'refused', reason: 'no-cap-slice' });
  });
});
