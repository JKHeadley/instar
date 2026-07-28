/**
 * Tier-3 E2E lifecycle for Operator Authorization Request — boots the REAL AgentServer
 * (the path server.ts uses) and proves:
 *   1. The routes are ALIVE (200/201, not 503) under the dev gate, and Bearer-gated.
 *   2. requester ≠ authorizer: a Bearer agent proposes but CANNOT approve (PIN required).
 *   3. Approval issues a real signed grant via the existing MandateStore path.
 *   4. Display integrity: the operator's card headline is SERVER-authored from the
 *      structured proposal + the registered name — never the agent's free-text reason.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { allowTestIdentities } from '../helpers/allow-test-identities.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] };
}

const AUTH = 'test-e2e-authreq';
const PIN = '424242';
const MIA = 'U0B9SFJ7QAK';

describe('Operator Authorization Request E2E — feature is alive + requester≠authorizer', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'authreq-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    // MIA (U0B9SFJ7QAK) is a known test-identity id; enable the double-keyed escape.
    allowTestIdentities(stateDir);

    const config = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      dashboardPin: PIN,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      // Mia is a registered user so the grantee resolves in the principal registry.
      users: [{ id: 'mia', name: 'Mia', slackUserId: MIA, channels: [{ type: 'slack', identifier: MIA }], permissions: [] }],
      // Explicitly enable the dev-gated feature for the alive test.
      messaging: [], monitoring: { authorizationRequests: { enabled: true } }, updates: {},
    } as unknown as InstarConfig;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/authorization-request-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /authorization-requests is ALIVE (200, not 503) and Bearer-gated', async () => {
    expect((await request(app).get('/authorization-requests')).status).toBe(401);
    const res = await request(app).get('/authorization-requests').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.requests)).toBe(true);
  });

  it('full lifecycle: propose (Bearer) → approve-without-PIN denied → PIN-approve → real signed grant', async () => {
    // 1. Propose (Bearer; confers no authority).
    const proposed = await request(app).post('/authorization-requests').set(auth()).send({
      createdByAgent: 'echo',
      proposal: { floorAction: 'prod-deploy', grantedToSlackUserId: MIA, durationMs: 3_600_000 },
      reason: 'totally harmless read-only peek', // a misleading reason…
    });
    expect(proposed.status).toBe(201);
    const id = proposed.body.id;

    // 2. The operator's card headline is SERVER-authored — never the agent's reason.
    const pending = await request(app).get('/authorization-requests?status=pending').set(auth());
    const card = pending.body.requests.find((r: any) => r.id === id);
    expect(card.headline).toBe('Let Mia deploy to production for 1 hour.');
    expect(card.headline).not.toMatch(/harmless|read-only|peek/);

    // 3. Approve WITHOUT the PIN — refused (Bearer alone cannot approve).
    const noPin = await request(app).post(`/authorization-requests/${id}/approve`).set(auth()).send({});
    expect(noPin.status).toBe(403);

    // 4. Approve WITH the PIN — issues a real signed grant.
    const ok = await request(app).post(`/authorization-requests/${id}/approve`).set(auth()).send({ pin: PIN });
    expect(ok.status).toBe(201);
    expect(ok.body.request.status).toBe('approved');
    expect(ok.body.request.resultMandateId).toBeTruthy();

    // 5. The grant is now live in the mandate store (the carrier mandate verifies).
    const mandates = await request(app).get('/mandate').set(auth());
    const carrier = mandates.body.mandates.find((m: any) => (m.grants ?? []).some((g: any) => g.grantedTo === MIA));
    expect(carrier).toBeTruthy();
    expect(carrier.authorshipValid).toBe(true);
  });

  it('SECURITY: proposing the excluded grant-authority meta-action is refused (400)', async () => {
    const res = await request(app).post('/authorization-requests').set(auth()).send({
      proposal: { floorAction: 'grant-authority', grantedToSlackUserId: MIA, durationMs: 3_600_000 },
    });
    expect(res.status).toBe(400);
  });
});
