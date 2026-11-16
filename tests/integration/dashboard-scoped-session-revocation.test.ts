/**
 * Integration — dashboard scoped-session REVOCATION completeness (SEC-044 + SEC-045;
 * docs/specs/dashboard-scoped-session-revocation.md) over the full HTTP pipeline through a real
 * AgentServer. Proves the revocation promise the dark feature now actually keeps:
 *  - POST /dashboard/session/revoke-all is dark-404, step-up-gated, and ends every session;
 *  - STRICT reuse: refreshing an already-CONSUMED token invalidates the whole family (a thief that
 *    re-presents a stolen-then-rotated token kills the session rather than riding the chain);
 *  - logout (revoke) with the ORIGINAL (now-consumed) token still ends the family (the SEC-045 core).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'itest-master-token-sec044';
const PIN = '135791';

function makeConfig(stateDir: string, enabled: boolean): InstarConfig {
  return {
    projectName: 'dst-revocation-itest', projectDir: '/tmp/dr', stateDir, port: 4042,
    authToken: AUTH, dashboardPin: PIN,
    security: { dashboardScopedToken: { enabled } },
    sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/echo', projectDir: '/tmp/dr', maxSessions: 3, protectedSessions: [], completionPatterns: [] },
    scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
    users: [], messaging: [], monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
  } as InstarConfig;
}

let project: TempProject;
let mockSM: MockSessionManager;

function app(enabled: boolean) {
  const s = new AgentServer({ config: makeConfig(project.stateDir, enabled), sessionManager: mockSM as any, state: project.state } as any);
  return s.getApp();
}

async function unlock(a: ReturnType<typeof app>): Promise<string> {
  const r = await request(a).post('/dashboard/unlock').send({ pin: PIN });
  expect(r.status).toBe(200);
  expect(String(r.body.token).startsWith('dst_')).toBe(true);
  return r.body.token as string;
}

beforeEach(() => { project = createTempProject(); mockSM = createMockSessionManager(); });
afterEach(() => { project.cleanup(); });

describe('dashboard scoped-session revocation (SEC-044 + SEC-045) — integration', () => {
  it('revoke-all is DARK-404 when the feature is off (adds no surface to the master-only config)', async () => {
    const r = await request(app(false)).post('/dashboard/session/revoke-all').set('Authorization', `Bearer ${AUTH}`);
    expect(r.status).toBe(404);
  });

  it('revoke-all WITHOUT a step-up proof is refused (a plain dst_ cannot sign everyone out)', async () => {
    const a = app(true);
    const t = await unlock(a);
    const r = await request(a).post('/dashboard/session/revoke-all').set('Authorization', `Bearer ${t}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('step-up-required');
    // the session is still alive — a failed revoke-all did not end it
    expect((await request(a).get('/jobs').set('Authorization', `Bearer ${t}`)).status).toBe(200);
  });

  it('revoke-all WITH a fresh-PIN step-up proof ends every session on this agent', async () => {
    const a = app(true);
    const t = await unlock(a);
    const su = await request(a).post('/dashboard/session/step-up').send({ pin: PIN });
    expect(su.status).toBe(200);
    const r = await request(a).post('/dashboard/session/revoke-all')
      .set('Authorization', `Bearer ${t}`).set('X-Instar-Step-Up', su.body.stepUpToken);
    expect(r.status).toBe(200);
    expect(r.body.revoked).toBe(true);
    expect(r.body.scope).toBe('this-agent');
    // the session is now dead
    expect((await request(a).get('/jobs').set('Authorization', `Bearer ${t}`)).status).toBe(401);
  });

  it('STRICT reuse: refreshing an already-CONSUMED token invalidates the whole family', async () => {
    const a = app(true);
    const t1 = await unlock(a);
    const ref = await request(a).post('/dashboard/session/refresh').set('Authorization', `Bearer ${t1}`);
    expect(ref.status).toBe(200);
    const t2 = ref.body.token as string;
    expect((await request(a).get('/jobs').set('Authorization', `Bearer ${t2}`)).status).toBe(200);
    // re-present the spent t1 (thief's copy / replay) → fork → family invalidated, 401
    const reuse = await request(a).post('/dashboard/session/refresh').set('Authorization', `Bearer ${t1}`);
    expect(reuse.status).toBe(401);
    // the live successor t2 is killed too (fail-safe)
    expect((await request(a).get('/jobs').set('Authorization', `Bearer ${t2}`)).status).toBe(401);
  });

  it('logout with the ORIGINAL (now-consumed) token still ends the family (SEC-045 core)', async () => {
    const a = app(true);
    const t1 = await unlock(a);
    const ref = await request(a).post('/dashboard/session/refresh').set('Authorization', `Bearer ${t1}`);
    const t2 = ref.body.token as string; // the "thief's" live successor
    // the owner, still holding the original t1, logs out — the family must die despite t1 being consumed
    const rev = await request(a).post('/dashboard/session/revoke').set('Authorization', `Bearer ${t1}`);
    expect(rev.status).toBe(200);
    expect((await request(a).get('/jobs').set('Authorization', `Bearer ${t2}`)).status).toBe(401);
  });
});
