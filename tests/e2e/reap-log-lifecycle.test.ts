/**
 * Tier-3 E2E "feature is alive" lifecycle test for the reap-log
 * (UNIFIED-SESSION-LIFECYCLE §P4).
 *
 * Per TESTING-INTEGRITY-SPEC: the single most important test for a feature with
 * API routes — is it actually alive on the production init path (returns 200,
 * not 503)? This boots the REAL AgentServer (same path server.ts uses) with a
 * ReapLog wired, and verifies:
 *   1. GET /sessions/reap-log returns 200 (not 503) when the log is wired.
 *   2. A recorded reap surfaces end-to-end through the live HTTP route.
 *   3. The route requires Bearer auth.
 *   4. The route is read-only (POST/DELETE not registered → 404).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ReapLog } from '../../src/monitoring/ReapLog.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('Reap-log E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let reapLog: ReapLog;
  const AUTH = 'test-e2e-reap-log';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaplog-e2e-'));
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

    reapLog = new ReapLog(stateDir, () => 'e2e-machine');
    reapLog.recordReaped({ session: 'sess-x', tmuxSession: 'tx', reason: 'idle-zombie', disposition: 'terminal', origin: 'autonomous' });
    reapLog.recordSkipped({ session: 'sess-y', tmuxSession: 'ty', reason: 'age-limit', skipped: 'not-lease-holder', origin: 'autonomous' });

    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir), reapLog });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/reap-log-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /sessions/reap-log is alive (200, not 503) and surfaces recorded entries', async () => {
    const res = await request(app).get('/sessions/reap-log').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0]).toMatchObject({ type: 'reaped', session: 'sess-x', reason: 'idle-zombie', machine: 'e2e-machine' });
    expect(res.body.entries[1]).toMatchObject({
      type: 'skipped',
      skipped: 'not-lease-holder',
      disposition: 'skipped:not-lease-holder',
    });
  });

  it('requires Bearer auth', async () => {
    const res = await request(app).get('/sessions/reap-log');
    expect(res.status).toBe(401);
  });

  it('is read-only — POST/DELETE are not registered (404)', async () => {
    expect((await request(app).post('/sessions/reap-log').set(auth())).status).toBe(404);
    expect((await request(app).delete('/sessions/reap-log').set(auth())).status).toBe(404);
  });
});
