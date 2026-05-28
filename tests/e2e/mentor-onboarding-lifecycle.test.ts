/**
 * Tier-3 E2E "feature is alive" test for the mentor-onboarding job (§19.4).
 *
 * Boots the REAL AgentServer and verifies the mentor surface is alive on the
 * production init path AND ships dormant: GET /mentor/status is 200 (not 503)
 * and reports enabled=false; POST /mentor/tick returns {ran:false,
 * reason:'disabled'} — the loop never spawns or spends until a human promotes
 * it. Also asserts the built-in job template ships off by default.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('Mentor-onboarding E2E lifecycle (alive + dormant)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-mentor-onboarding';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-e2e-'));
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

    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/mentor-onboarding-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /mentor/status is alive (200, not 503) and reports dormant', async () => {
    const res = await request(app).get('/mentor/status').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.mode).toBe('off');
  });

  it('POST /mentor/tick is dormant on the production init path (no spawn/spend)', async () => {
    const res = await request(app).post('/mentor/tick').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ran: false, reason: 'disabled' });
  });

  it('surfaces the mentor capability in /capabilities', async () => {
    const res = await request(app).get('/capabilities').set(auth());
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toMatch(/\/mentor/);
  });

  it('mentor routes require auth like every non-/health route', async () => {
    expect((await request(app).get('/mentor/status')).status).toBe(401);
  });

  it('boots clean with the Stage-B forensics wiring (server alive, mentor dormant)', async () => {
    // PR B wires real Stage-B forensics (rollout/log reading + LLM classify) into
    // the runner. This asserts that wiring doesn't break boot and the mentor stays
    // dormant on the production init path.
    const status = await request(app).get('/mentor/status').set(auth());
    expect(status.status).toBe(200);
    expect(status.body.enabled).toBe(false);
    // A dormant tick still returns disabled — the forensics path is never reached.
    const tick = await request(app).post('/mentor/tick').set(auth());
    expect(tick.status).toBe(200);
    expect(tick.body).toEqual({ ran: false, reason: 'disabled' });
  });

  it('the built-in mentor job template ships OFF by default', () => {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(thisDir, '..', '..');
    const jobPath = path.join(repoRoot, 'src', 'scaffold', 'templates', 'jobs', 'instar', 'mentor-onboarding.md');
    expect(fs.existsSync(jobPath)).toBe(true);
    const body = fs.readFileSync(jobPath, 'utf-8');
    expect(body).toMatch(/^enabled:\s*false\s*$/m);
  });
});

describe('Mentor ledger survives a broken TokenLedger (regression: production cascade)', () => {
  // Reproduces the exact production bug: an agent whose TokenLedger init throws
  // (Echo's `no such column: attribution_key`) must NOT have the mentor ledger +
  // runner taken down with it. Before the decoupling fix, both lived in one try
  // block and a TokenLedger throw → /mentor + /framework-issues all 503.
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-mentor-tokenledger-cascade';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-cascade-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    const serverDataDir = path.join(stateDir, 'server-data');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(serverDataDir, { recursive: true });
    // Pre-plant a CORRUPT token-ledger.db so the real TokenLedger constructor
    // throws on open — standing in for Echo's stale-schema failure.
    fs.writeFileSync(path.join(serverDataDir, 'token-ledger.db'), 'this is not a sqlite database — corrupt on purpose');
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
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
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/mentor-onboarding-lifecycle.test.ts:cascade' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('a corrupt token-ledger.db (TokenLedger fails) does NOT 503 the mentor surface', async () => {
    // TokenLedger should be down, but the mentor ledger + runner are independent.
    const status = await request(app).get('/mentor/status').set(auth());
    expect(status.status).toBe(200); // NOT 503 — the cascade is broken
    expect(status.body.enabled).toBe(false);

    const fi = await request(app).get('/framework-issues').set(auth());
    expect(fi.status).toBe(200); // ledger alive despite TokenLedger failure
    expect(Array.isArray(fi.body.issues)).toBe(true);
  });
});
