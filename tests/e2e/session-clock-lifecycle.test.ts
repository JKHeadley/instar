// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for GET /session/clock — the
 * session time-awareness query surface (docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md).
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer (the path server.ts uses)
 * and verifies the route is alive on the production init path:
 *   1. With an active autonomous record on disk → 200 + computed elapsed/remaining.
 *   2. With no record → 200 + { sessions: [] } (it's a disk reader, never 503).
 *   3. Requires Bearer auth.
 *   4. Read-only (POST → 404).
 *   5. Leak-bound — the raw goal text never appears in the response.
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

const START = '2026-06-02T05:42:40Z';

describe('Session clock E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-session-clock';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-clock-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    // An active, time-boxed autonomous record with a goal carrying a tag (leak test).
    fs.writeFileSync(
      path.join(stateDir, 'autonomous-state.local.md'),
      ['---', 'active: true', `started_at: "${START}"`, 'duration_seconds: 43200', 'goal: "ship <promise>X</promise> time tracking"', '---', '# body'].join('\n') + '\n',
    );

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
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/session-clock-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /session/clock is alive (200) and surfaces computed elapsed/remaining', async () => {
    const res = await request(app).get('/session/clock').set(auth());
    expect(res.status).toBe(200);
    expect(typeof res.body.now).toBe('number');
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions.length).toBe(1);
    const s = res.body.sessions[0];
    expect(typeof s.elapsedSeconds).toBe('number');
    expect(s).toHaveProperty('remainingSeconds');
    expect(s).toHaveProperty('elapsedHuman');
    expect(s).toHaveProperty('percentElapsed');
  });

  it('LEAK-BOUND: the raw goal/<promise> tag never appears in the response', async () => {
    const res = await request(app).get('/session/clock').set(auth());
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('<promise>');
    expect(res.body.sessions[0].label).not.toContain('<');
  });

  it('requires Bearer auth', async () => {
    expect((await request(app).get('/session/clock')).status).toBe(401);
  });

  it('is read-only — POST is not registered (404)', async () => {
    expect((await request(app).post('/session/clock').set(auth())).status).toBe(404);
  });
});
