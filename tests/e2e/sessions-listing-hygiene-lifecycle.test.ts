// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for session-listing hygiene
 * (CMT-1936): GET /sessions defaults to ACTIVE sessions, ?include=all opens
 * the full registry, and the pool envelope carries pool.duplicateTopics.
 *
 * Boots the REAL AgentServer (the same path server.ts uses) with a REAL
 * StateManager and REAL on-disk session records — the production init path.
 * If the route-level default filter or the additive pool field ever fails to
 * wire, THIS is the test that catches it (a 200 with the wrong rows, not a
 * mocked context).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig, Session } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('Session-listing hygiene E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-listing-hygiene';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-hygiene-e2e-'));
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

    const state = new StateManager(stateDir);
    // REAL on-disk records — the exact production shape of the 2026-07-09
    // "duplicate sessions" misread: one live session next to finished
    // mentor/job background runs.
    const mk = (over: Partial<Session>): Session => ({
      id: `e2e-${over.name}`,
      name: 'x',
      status: 'completed',
      tmuxSession: `instar-${over.name}`,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      ...over,
    } as Session);
    state.saveSession(mk({ name: 'live-task', status: 'running' }));
    state.saveSession(mk({ name: 'mentor-stage-a-1', status: 'completed', launchLane: 'headless', endedAt: new Date().toISOString() }));
    state.saveSession(mk({ name: 'job-health-check-1', status: 'completed', jobSlug: 'health-check', endedAt: new Date().toISOString() }));

    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/sessions-listing-hygiene-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('DEFAULT GET /sessions is alive and shows ONLY the active session', async () => {
    const res = await request(app).get('/sessions').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((s: { name: string }) => s.name)).toEqual(['live-task']);
  });

  it('?include=all is alive and returns the finished background runs too', async () => {
    const res = await request(app).get('/sessions').query({ include: 'all' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.map((s: { name: string }) => s.name).sort())
      .toEqual(['job-health-check-1', 'live-task', 'mentor-stage-a-1']);
  });

  it('?status=completed keeps its pre-change semantics on the production path', async () => {
    const res = await request(app).get('/sessions').query({ status: 'completed' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.map((s: { name: string }) => s.name).sort())
      .toEqual(['job-health-check-1', 'mentor-stage-a-1']);
  });

  it('scope=pool is alive and carries the additive pool.duplicateTopics field (empty — no duplicates)', async () => {
    const res = await request(app).get('/sessions').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s: { name: string }) => s.name)).toEqual(['live-task']);
    expect(Array.isArray(res.body.pool.duplicateTopics)).toBe(true);
    expect(res.body.pool.duplicateTopics).toEqual([]);
  });

  it('requires Bearer auth', async () => {
    expect((await request(app).get('/sessions')).status).toBe(401);
    expect((await request(app).get('/sessions?include=all')).status).toBe(401);
  });
});
