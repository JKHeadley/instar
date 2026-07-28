// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for GET /parallel-work/activities
 * (Parallel-Work Awareness Phase A read surface).
 *
 * Boots the REAL AgentServer (the path server.ts uses): the production init's stateDir
 * block constructs the ParallelActivityIndex, so the route is alive (200, not 503),
 * Bearer-auth gated, read-only (POST → 404). With an empty topic-intent dir the index
 * returns an empty list — the point is the wiring is live end-to-end.
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

describe('Parallel-Work Awareness E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-parallel-work';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-work-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'topic-intent'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'topic-intent', '7.json'), JSON.stringify({ topicId: 7, refs: {} }));
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
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/parallel-work-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /parallel-work/activities is alive (200, not 503) with a real shape', async () => {
    const res = await request(app).get('/parallel-work/activities').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(typeof res.body.count).toBe('number');
    expect(Array.isArray(res.body.activities)).toBe(true);
    // topic 7 has an intent file (no qualifying refs) → it still appears with focus null
    const t7 = res.body.activities.find((a: any) => a.topicId === 7);
    expect(t7).toBeDefined();
  });

  it('requires Bearer auth', async () => {
    const res = await request(app).get('/parallel-work/activities');
    expect(res.status).toBe(401);
  });

  it('is read-only — POST is not registered (404)', async () => {
    const res = await request(app).post('/parallel-work/activities').set(auth());
    expect(res.status).toBe(404);
  });
});
