/**
 * Tier-3 "feature is alive" E2E for WS4.1 follow-up durable operator-bound /ack
 * (CMT-1416). Per CLAUDE.md the Tier-3 test is "the single most important test
 * for any feature with API routes": it proves the routes are reachable through
 * the REAL AgentServer stack (auth middleware, error handling) and behave — not
 * 503 because a dep wasn't wired.
 *
 * Drives POST /attention/:id/remote-ack + GET /attention/_remote-ack/pending
 * against a real AgentServer:
 *   - flag ON: the route is ALIVE (not 503-because-unwired); an unreachable
 *     owner produces a durable queued intent visible at the pending route — the
 *     load-bearing "ack survives a dark owner" guarantee, end to end;
 *   - the route sits behind Bearer auth (no token → 401/403);
 *   - flag OFF: the route returns the FEATURE-disabled 503 (gate present).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

function createAttentionAdapter() {
  const items = new Map<string, { id: string; priority: string; status: string }>();
  return {
    getAttentionItems: () => [...items.values()],
    getAttentionItem: (id: string) => items.get(id),
    updateAttentionStatus: async (id: string, status: string) => {
      const it = items.get(id);
      if (!it) return false;
      it.status = status;
      return true;
    },
  };
}

// `enabled`: when a boolean, set the explicit flag value. When 'dev-gated', OMIT the
// flag entirely and rely on the developmentAgent gate (resolveDevAgentGate) to resolve it
// — the heart of mm-pool-seamlessness-devgate: a dev agent runs it live, the fleet stays
// dark, with NO explicit config value present.
async function startServer(
  enabled: boolean | 'dev-gated',
  tmpDir: string,
  auth: string,
  opts: { developmentAgent?: boolean } = {},
): Promise<AgentServer> {
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const config: InstarConfig = {
    projectName: 'remote-ack-alive-e2e',
    projectDir: tmpDir,
    stateDir,
    port: 0,
    authToken: auth,
    requestTimeoutMs: 10000,
    version: '0.0.0',
    developmentAgent: opts.developmentAgent,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [],
    monitoring: {},
    updates: {},
    // 'dev-gated' → OMIT the flag so the dev-gate decides; otherwise set it explicitly.
    multiMachine: { seamlessness: enabled === 'dev-gated' ? {} : { ws41DurableAck: enabled } },
  } as unknown as InstarConfig;

  const server = new AgentServer({
    config,
    sessionManager: createMockSessionManager() as any,
    state: new StateManager(stateDir),
    telegram: createAttentionAdapter() as any,
    meshSelfId: 'm_self_e2e',
    // An owner that is permanently unreachable → the ack queues durably.
    listPoolMachines: () => [{ machineId: 'm_owner', nickname: 'Mac Mini', lastKnownUrl: 'http://127.0.0.1:1' }],
  });
  await server.start();
  return server;
}

describe('E2E: WS4.1 durable remote-ack routes are ALIVE through the real AgentServer', () => {
  let tmpDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH = 'remote-ack-alive-token';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-ack-alive-'));
    server = await startServer(true, tmpDir, AUTH);
    app = server.getApp();
  }, 30000);

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/attention-remote-ack-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('POST /attention/:id/remote-ack is ALIVE: an unreachable owner produces a durable queued intent (not 503-unwired)', async () => {
    const res = await request(app)
      .post('/attention/att-alive/remote-ack')
      .set(auth())
      .send({ machineId: 'm_owner', status: 'DONE' })
      .expect(200);
    expect(res.body).toMatchObject({ ok: true, queued: true });

    // The durable intent is visible end-to-end through the real stack.
    const pending = await request(app).get('/attention/_remote-ack/pending').set(auth()).expect(200);
    expect(pending.body.count).toBe(1);
    expect(pending.body.pending[0]).toMatchObject({ itemId: 'att-alive', targetMachineId: 'm_owner', status: 'DONE' });
  });

  it('the remote-ack route sits behind Bearer auth (no token → 401/403)', async () => {
    const res = await request(app).post('/attention/att-alive/remote-ack').send({ machineId: 'm_owner', status: 'DONE' });
    expect([401, 403]).toContain(res.status);
  });

  it('flag OFF: POST /attention/:id/remote-ack returns the FEATURE-disabled 503 (gate present)', async () => {
    const offDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-ack-off-'));
    const offServer = await startServer(false, offDir, AUTH);
    try {
      const res = await request(offServer.getApp())
        .post('/attention/x/remote-ack')
        .set(auth())
        .send({ machineId: 'm_owner', status: 'DONE' });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/ws41DurableAck/);
    } finally {
      await offServer.stop();
      SafeFsExecutor.safeRmSync(offDir, { recursive: true, force: true, operation: 'tests/e2e/attention-remote-ack-alive.test.ts' });
    }
  });

  // mm-pool-seamlessness-devgate (operator directive topic 13481): with the flag OMITTED
  // (no explicit config value), the developmentAgent gate must flip the route ALIVE on a
  // dev agent and keep it 503 on the fleet — proving the dev-gate actually flips the route,
  // not just shuffles a registry. This is the load-bearing PR2 behavior for ws41DurableAck.
  it('dev-gate: flag OMITTED + developmentAgent:true → route ALIVE (not the dark-fleet 503)', async () => {
    const devDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-ack-dev-'));
    const devServer = await startServer('dev-gated', devDir, AUTH, { developmentAgent: true });
    try {
      const res = await request(devServer.getApp())
        .post('/attention/att-dev/remote-ack')
        .set(auth())
        .send({ machineId: 'm_owner', status: 'DONE' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, queued: true });
    } finally {
      await devServer.stop();
      SafeFsExecutor.safeRmSync(devDir, { recursive: true, force: true, operation: 'tests/e2e/attention-remote-ack-alive.test.ts' });
    }
  });

  it('dev-gate: flag OMITTED + developmentAgent:false (fleet) → 503 (dark by default)', async () => {
    const fleetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-ack-fleet-'));
    const fleetServer = await startServer('dev-gated', fleetDir, AUTH, { developmentAgent: false });
    try {
      const res = await request(fleetServer.getApp())
        .post('/attention/x/remote-ack')
        .set(auth())
        .send({ machineId: 'm_owner', status: 'DONE' });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/ws41DurableAck/);
    } finally {
      await fleetServer.stop();
      SafeFsExecutor.safeRmSync(fleetDir, { recursive: true, force: true, operation: 'tests/e2e/attention-remote-ack-alive.test.ts' });
    }
  });
});
