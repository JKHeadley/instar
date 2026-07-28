// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the Blocker Ledger (Autonomy
 * Principles Enforcement, Piece 1) — GET/POST /blockers + /blockers/:id +
 * /advance + /settle.
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer (the path server.ts
 * uses) with monitoring.blockerLedger.enabled = true, and verifies:
 *   - the routes are ALIVE on the production path (GET /blockers returns 200,
 *     NOT 503) — i.e. the routeCtx.blockerLedger thread is real, not null;
 *   - the routes are Bearer-gated (401 without);
 *   - dark-by-default integrity: with the flag OFF the route 503s;
 *   - a blocker walked candidate → resolved PERSISTS to disk and reappears after
 *     a simulated restart (a fresh BlockerLedger over the SAME stateDir).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { BlockerLedger } from '../../src/monitoring/BlockerLedger.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] };
}

function bootConfig(tmpDir: string, stateDir: string, auth: string, blockerEnabled: boolean): InstarConfig {
  return {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [],
    // The dark-feature gate: the ledger is built (and the routes go live) ONLY
    // when this is true — mirroring the production AgentServer construction.
    monitoring: { blockerLedger: { enabled: blockerEnabled } },
    updates: {},
  } as InstarConfig;
}

async function bootServer(tmpDir: string, stateDir: string, auth: string, blockerEnabled: boolean): Promise<AgentServer> {
  const config = bootConfig(tmpDir, stateDir, auth, blockerEnabled);
  const server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
  await server.start();
  return server;
}

describe('Blocker Ledger E2E lifecycle — feature is alive', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-blocker-ledger';
  const auth = () => ({ Authorization: `Bearer ${AUTH}` });
  const intent = () => ({ 'X-Instar-Request': '1' });

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-ledger-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    server = await bootServer(tmpDir, stateDir, AUTH, /* blockerEnabled */ true);
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/blocker-ledger-lifecycle.test.ts' });
  });

  it('GET /blockers is ALIVE on the production path (200, not 503)', async () => {
    const res = await request(app).get('/blockers').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('requires Bearer auth', async () => {
    const res = await request(app).get('/blockers');
    expect(res.status).toBe(401);
  });

  it('dark-by-default: with monitoring.blockerLedger.enabled=false the route 503s', async () => {
    const darkTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-ledger-dark-e2e-'));
    const darkState = path.join(darkTmp, '.instar');
    fs.mkdirSync(path.join(darkState, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(darkState, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(darkState, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e-dark', agentName: 'E2E' }));
    const darkServer = await bootServer(darkTmp, darkState, AUTH, /* blockerEnabled */ false);
    try {
      const res = await request(darkServer.getApp()).get('/blockers').set(auth());
      expect(res.status).toBe(503);
      expect(res.body.error).toContain('BlockerLedger not initialized');
    } finally {
      await darkServer.stop();
      SafeFsExecutor.safeRmSync(darkTmp, { recursive: true, force: true, operation: 'tests/e2e/blocker-ledger-lifecycle.test.ts:dark' });
    }
  });

  it('a blocker walked candidate → resolved PERSISTS and reappears after a simulated restart', async () => {
    // 1. open + walk the full pipeline to resolved on the production HTTP path.
    const created = await request(app).post('/blockers').set(auth()).set(intent())
      .send({ detectedText: 'I cannot deploy this — needs a human', origin: 'e2e-session' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    await request(app).post(`/blockers/${id}/advance`).set(auth()).set(intent())
      .send({ origin: 'e2e-session', authorityCheck: { agentHasAuthority: true, userHasAuthority: false, note: 'I have deploy creds' } });
    await request(app).post(`/blockers/${id}/advance`).set(auth()).set(intent())
      .send({ origin: 'e2e-session', accessRequest: { messageRef: 'relay-e2e' } });
    await request(app).post(`/blockers/${id}/advance`).set(auth()).set(intent())
      .send({ origin: 'e2e-session', dryRun: { detail: 'dry-run deploy to staging passed' } });
    await request(app).post(`/blockers/${id}/advance`).set(auth()).set(intent())
      .send({ origin: 'e2e-session', liveRun: { at: new Date().toISOString(), outcome: 'deployed live successfully', succeeded: true } });

    // Resolved needs a confined playbook that references the id. The default
    // confined roots include <stateDir>/playbooks.
    const playbookDir = path.join(stateDir, 'playbooks');
    fs.mkdirSync(playbookDir, { recursive: true });
    const playbookPath = path.join(playbookDir, `${id}.md`);
    fs.writeFileSync(playbookPath, `# How ${id} was resolved\n\nDeployed it directly with the agent's own creds.\n`);

    const settled = await request(app).post(`/blockers/${id}/settle`).set(auth()).set(intent())
      .send({ origin: 'e2e-session', kind: 'resolved', playbookPath });
    expect(settled.status).toBe(200);
    expect(settled.body.state).toBe('resolved');

    // 2. Confirm it persisted to the store file.
    const storePath = path.join(stateDir, 'state', 'blocker-ledger.json');
    expect(fs.existsSync(storePath)).toBe(true);

    // 3. Simulated restart: a fresh BlockerLedger over the SAME stateDir reads
    //    the persisted entry back — survival across process boundaries.
    const restarted = new BlockerLedger({ stateDir });
    const reloaded = restarted.get(id);
    expect(reloaded).toBeTruthy();
    expect(reloaded!.state).toBe('resolved');
    expect(reloaded!.terminal?.kind).toBe('resolved');
    expect(reloaded!.detectedText).toBe('I cannot deploy this — needs a human');
  });
});
