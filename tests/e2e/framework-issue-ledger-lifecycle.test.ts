/**
 * Tier-3 E2E "feature is alive" lifecycle test for the Framework-Onboarding
 * Mentor System issue ledger (FRAMEWORK-ONBOARDING-MENTOR-SPEC §14, §18).
 *
 * Per TESTING-INTEGRITY-SPEC: the single most important test for any feature
 * with API routes — is it actually alive on the production init path (returns
 * 200, not 503)? This boots the REAL AgentServer (the same path server.ts uses),
 * and verifies:
 *   1. The FrameworkIssueLedger is instantiated at startup (wiring integrity).
 *   2. Its SQLite DB auto-creates under server-data/ on first boot (§14.3 — no
 *      schema migration needed).
 *   3. GET /framework-issues returns 200, not 503.
 *   4. A written observation surfaces end-to-end through the live HTTP route.
 *   5. GET /framework-issues/playbook is alive.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { FrameworkIssueLedger } from '../../src/monitoring/FrameworkIssueLedger.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('FrameworkIssueLedger E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-framework-issue-ledger';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwledger-e2e-'));
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
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/framework-issue-ledger-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });
  const dbPath = () => path.join(stateDir, 'server-data', 'framework-issue-ledger.db');

  it('instantiates the ledger DB on the production init path (no schema migration needed)', () => {
    expect(fs.existsSync(dbPath())).toBe(true);
  });

  it('GET /framework-issues is alive — returns 200, not 503', async () => {
    const res = await request(app).get('/framework-issues').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it('GET /framework-issues/playbook is alive — returns 200, not 503', async () => {
    const res = await request(app).get('/framework-issues/playbook?targetFramework=cursor').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.playbook)).toBe(true);
  });

  it('a written observation surfaces end-to-end through the live route', async () => {
    // Open a second handle on the SAME db the server created (WAL allows
    // concurrent readers) and write an observation — standing in for Stage B
    // (the auto-capture call site ships in the next PR, §19.2).
    const writer = new FrameworkIssueLedger({ dbPath: dbPath() });
    writer.recordObservation({
      framework: 'codex-cli',
      bucket: 'instar-integration-gap',
      title: 'intelligence provider loaded full identity on every judgment call',
      dedupKey: 'codex::identity-load::judgment',
      severity: 'high',
      observedVersion: '1.3.2',
      evidence: 'rollout-2026-05-26.jsonl:142',
    });
    writer.close();

    const res = await request(app).get('/framework-issues?framework=codex-cli').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0].title).toMatch(/identity/);
    expect(res.body.issues[0].generalizable).toBe(true);
  });

  it('POST /framework-issues/observe is alive — writes an engineering finding through the live route (200, not 503)', async () => {
    // The durable write path (§5): an agent records a discovered issue directly,
    // not just what a mentor tick trips over. Proves the route on the production
    // init path — strictly better than the side-channel writes above.
    const res = await request(app)
      .post('/framework-issues/observe')
      .set(auth())
      .send({
        framework: 'codex-cli',
        bucket: 'instar-integration-gap',
        severity: 'high',
        title: 'SessionWatchdog was blind to codex exec --json',
        dedupKey: 'codex::watchdog::exec-json-blind',
        evidence: 'PR #574',
        status: 'fixed',
        fixedInVersion: '1.3.122',
      });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(true);
    expect(res.body.issue.status).toBe('fixed');
    expect(res.body.issue.fixedInVersion).toBe('1.3.122');
    const list = await request(app).get('/framework-issues?framework=codex-cli&status=fixed').set(auth());
    expect(list.body.issues.some((i: { dedupKey: string }) => i.dedupKey === 'codex::watchdog::exec-json-blind')).toBe(true);
  });

  it('requires auth (Bearer token) like every non-/health route', async () => {
    const res = await request(app).get('/framework-issues'); // no auth header
    expect(res.status).toBe(401);
  });

  it('surfaces the framework-issues capability in /capabilities (discoverability)', async () => {
    const res = await request(app).get('/capabilities').set(auth());
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    // The CapabilityIndex entry must appear and be enabled (ledger is wired in this boot).
    expect(body).toMatch(/framework-issues/);
  });

  it('Stage-B auto-capture is alive: a capture run surfaces in the funnel route', async () => {
    // Open a handle on the SAME db the server created, run a Stage-B capture
    // (stands in for the mentor tick, §19.4), then verify the funnel route on
    // the live server reflects it — proving the capture path is wired end-to-end.
    const writer = new FrameworkIssueLedger({ dbPath: dbPath() });
    writer.captureRun({
      framework: 'codex-cli',
      tickId: 'e2e-tick',
      findings: [{ bucket: 'framework-limitation', title: 'observed in e2e', dedupKey: 'e2e::cap::1', severity: 'medium' }],
    });
    writer.captureRun({ framework: 'codex-cli', tickId: 'e2e-tick-2', findings: [] }); // ran, found nothing
    writer.close();

    const res = await request(app).get('/framework-issues/capture-stats').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.totalRuns).toBeGreaterThanOrEqual(2);
    expect(res.body.totalObservationsWritten).toBeGreaterThanOrEqual(1);
  });
});
