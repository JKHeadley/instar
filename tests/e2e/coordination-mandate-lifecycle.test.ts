// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the Coordination Mandate
 * enforcement (docs/specs/coordination-mandate.md §4).
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer (the path server.ts uses)
 * and proves, on the production init path:
 *   1. The routes are alive (200, not 503) and Bearer-gated.
 *   2. DENY-BY-DEFAULT: a fresh boot denies every evaluation (inert until issued).
 *   3. The full lifecycle: PIN-gated issue → in-bounds allow → undelegated
 *      execute-cutover deny → PIN-gated revoke → post-revoke deny — with every
 *      decision in the hash-chained audit (chain verifies).
 *   4. SECURITY wiring-integrity: Bearer alone CANNOT issue (PIN refused), and the
 *      persisted mandate's authProof verifies against an independently
 *      reconstructed production signer (HMAC over authToken) — not a no-op.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { MandateStore } from '../../src/coordination/MandateStore.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] };
}

const AUTH = 'test-e2e-coordination-mandate';
const PIN = '424242';
const ECHO = 'fp-echo';
const DAWN = 'fp-dawn';
const FUTURE = '2999-01-01T00:00:00Z';

describe('Coordination Mandate E2E lifecycle — feature is alive + deny-by-default', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandate-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    const config = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      dashboardPin: PIN,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/coordination-mandate-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /mandate is alive (200, not 503) and Bearer-gated', async () => {
    expect((await request(app).get('/mandate')).status).toBe(401);
    const res = await request(app).get('/mandate').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.mandates).toEqual([]);
  });

  it('DENY-BY-DEFAULT: a fresh boot denies every evaluation', async () => {
    const res = await request(app).post('/mandate/evaluate').set(auth()).send({
      action: 'exchange-read-credential', params: { credentialScope: 'read-only' }, agentFp: ECHO, mandateId: 'anything',
    });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('deny');
  });

  it('SECURITY: Bearer alone cannot issue — the PIN is required on the production path', async () => {
    const res = await request(app).post('/mandate/issue').set(auth()).send({
      scope: 'feedback-migration', agents: [ECHO, DAWN],
      authorities: [{ action: 'sign-code-review', bounds: {} }], expiresAt: FUTURE,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/PIN required/i);
  });

  it('full lifecycle: PIN-issue → allow → undelegated deny → PIN-revoke → deny, audit chain intact', async () => {
    // Issue the A/A/B first mandate (PIN-gated).
    const issued = await request(app).post('/mandate/issue').set(auth()).send({
      pin: PIN, scope: 'feedback-migration', agents: [ECHO, DAWN],
      authorities: [
        { action: 'exchange-read-credential', bounds: { credentialScope: 'read-only', onMachine: true } },
        { action: 'sign-code-review', bounds: { artifact: 'migration-port', mutual: true } },
      ],
      expiresAt: FUTURE,
    });
    expect(issued.status).toBe(201);
    const id = issued.body.mandate.id;

    // In-bounds action by a named party → allow.
    const allow = await request(app).post('/mandate/evaluate').set(auth()).send({
      action: 'sign-code-review', params: { artifact: 'migration-port', mutual: true }, agentFp: DAWN, mandateId: id,
    });
    expect(allow.body.decision).toBe('allow');

    // execute-cutover is NOT delegated in the first mandate (decision 1A/3B) → deny.
    const cutover = await request(app).post('/mandate/evaluate').set(auth()).send({
      action: 'execute-cutover', params: {}, agentFp: ECHO, mandateId: id,
    });
    expect(cutover.body.decision).toBe('deny');

    // Revoke (PIN-gated kill switch) → subsequent evaluation denies.
    const revoked = await request(app).post(`/mandate/${id}/revoke`).set(auth()).send({ pin: PIN, reason: 'e2e kill-switch' });
    expect(revoked.status).toBe(200);
    const after = await request(app).post('/mandate/evaluate').set(auth()).send({
      action: 'sign-code-review', params: { artifact: 'migration-port', mutual: true }, agentFp: DAWN, mandateId: id,
    });
    expect(after.body.decision).toBe('deny');
    expect(after.body.reason).toMatch(/revoked/);

    // Every decision audited; the hash chain verifies.
    const audit = await request(app).get('/mandate/audit').set(auth());
    expect(audit.body.total).toBeGreaterThanOrEqual(4);
    expect(audit.body.chain).toEqual({ ok: true });
  });

  it('user→agent grants: PIN-issue → PIN-grant alive (201) → grant signed in, authProof still verifies via the production signer', async () => {
    // Issue a fresh mandate.
    const issued = await request(app).post('/mandate/issue').set(auth()).send({
      pin: PIN, scope: 'slack-floor', agents: [ECHO, DAWN],
      authorities: [{ action: 'sign-code-review', bounds: {} }], expiresAt: FUTURE,
    });
    expect(issued.status).toBe(201);
    const id = issued.body.mandate.id;

    // SECURITY: Bearer alone cannot add a grant — the PIN is required on the prod path.
    const noPin = await request(app).post(`/mandate/${id}/grants`).set(auth()).send({
      grants: [{ floorAction: 'prod-deploy', grantedTo: 'U_AMIR', authorizedBy: 'justin', expiresAt: '2998-01-01T00:00:00Z' }],
    });
    expect(noPin.status).toBe(403);

    // PIN-gated grant lands (201) and re-signs the mandate.
    const granted = await request(app).post(`/mandate/${id}/grants`).set(auth()).send({
      pin: PIN, grants: [{ floorAction: 'prod-deploy', grantedTo: 'U_AMIR', authorizedBy: 'justin', expiresAt: '2998-01-01T00:00:00Z' }],
    });
    expect(granted.status).toBe(201);
    expect(granted.body.mandate.authorshipValid).toBe(true);
    expect(granted.body.mandate.grants).toHaveLength(1);

    // The persisted, grant-bearing mandate verifies against an INDEPENDENT production
    // signer (HMAC over authToken) — the re-sign is real, not a no-op.
    const file = path.join(stateDir, 'state', 'coordination-mandates.json');
    const sign = (c: string) => createHmac('sha256', AUTH).update(c).digest('hex');
    const verifySig = (c: string, p: string) => {
      const e = sign(c);
      try { return e.length === p.length && timingSafeEqual(Buffer.from(e), Buffer.from(p)); } catch { return false; }
    };
    const independent = new MandateStore({ filePath: file, sign, verifySig });
    const m = independent.get(id)!;
    expect(m.grants).toHaveLength(1);
    expect(independent.verifyAuthorship(m)).toBe(true);
    // Tampering the grant's grantee breaks the proof.
    const tampered = { ...m, grants: [{ ...m.grants![0], grantedTo: 'U_ATTACKER' }] };
    expect(independent.verifyAuthorship(tampered)).toBe(false);
  });

  it('WIRING-INTEGRITY: the production issuance signer is real — the persisted authProof verifies, a widened mandate fails', async () => {
    const file = path.join(stateDir, 'state', 'coordination-mandates.json');
    const sign = (c: string) => createHmac('sha256', AUTH).update(c).digest('hex');
    const verifySig = (c: string, p: string) => {
      const e = sign(c);
      try { return e.length === p.length && timingSafeEqual(Buffer.from(e), Buffer.from(p)); } catch { return false; }
    };
    const independent = new MandateStore({ filePath: file, sign, verifySig });
    const mandates = independent.list();
    expect(mandates.length).toBeGreaterThanOrEqual(1);
    expect(independent.verifyAuthorship(mandates[0])).toBe(true);
    // Widening the authorities (the T2 attack) breaks the proof.
    const widened = { ...mandates[0], authorities: [...mandates[0].authorities, { action: 'execute-cutover', bounds: {} }] };
    expect(independent.verifyAuthorship(widened)).toBe(false);
  });
});

describe('Phone-first floor-grant path E2E — the dashboard form\'s exact flow is alive (instar#1080)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-form-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    // The cast the person picker offers — production users.json shape.
    fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify([
      { id: 'slack-U_MIA', name: 'Mia Member', channels: [{ type: 'slack', identifier: 'U_MIA' }], permissions: ['member'], preferences: {}, slackUserId: 'U_MIA', orgRole: 'member', createdAt: 'x' },
    ]));
    const config = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      dashboardPin: PIN,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/coordination-mandate-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /permissions/users is alive (200, not 503/404), Bearer-gated, and serves the picker', async () => {
    expect((await request(app).get('/permissions/users')).status).toBe(401);
    const res = await request(app).get('/permissions/users').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([{ slackUserId: 'U_MIA', name: 'Mia Member', orgRole: 'member' }]);
  });

  it('the form\'s exact payload signs a grant: PIN-issue mandate → PIN-grant → grant persisted and authorship-valid', async () => {
    const issued = await request(app).post('/mandate/issue').set(auth()).send({
      pin: PIN, scope: 'slack-live-test', agents: [ECHO, DAWN],
      authorities: [{ action: 'sign-code-review', bounds: {} }],
      expiresAt: FUTURE,
    });
    expect(issued.status).toBe(201);
    const id = issued.body.mandate.id;

    // EXACTLY what dashboard/mandates.js wireGrantButtons() POSTs.
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const granted = await request(app).post(`/mandate/${id}/grants`).set(auth()).send({
      pin: PIN,
      grants: [{ floorAction: 'prod-deploy', grantedTo: 'U_MIA', authorizedBy: 'operator (dashboard PIN)', expiresAt }],
    });
    expect(granted.status).toBe(201);
    expect(granted.body.granted).toBe(true);
    expect(granted.body.mandate.authorshipValid).toBe(true);

    // The grant is durably carried and re-served (what the tab re-renders).
    const listed = await request(app).get('/mandate').set(auth());
    const m = listed.body.mandates.find((x: any) => x.id === id);
    expect(m.grants).toHaveLength(1);
    expect(m.grants[0].grantedTo).toBe('U_MIA');
    expect(m.grants[0].floorAction).toBe('prod-deploy');
  });

  it('Bearer alone cannot grant — the PIN is structurally required (requester ≠ authorizer)', async () => {
    const issued = await request(app).post('/mandate/issue').set(auth()).send({
      pin: PIN, scope: 'no-pin-grant', agents: [ECHO, DAWN],
      authorities: [{ action: 'sign-code-review', bounds: {} }],
      expiresAt: FUTURE,
    });
    const res = await request(app).post(`/mandate/${issued.body.mandate.id}/grants`).set(auth()).send({
      grants: [{ floorAction: 'prod-deploy', grantedTo: 'U_MIA', authorizedBy: 'agent', expiresAt: FUTURE }],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/PIN/i);
  });
});
