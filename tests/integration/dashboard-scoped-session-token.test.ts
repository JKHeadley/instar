/**
 * Integration — dashboard scoped session token (docs/specs/dashboard-scoped-session-token.md, SEC-002b)
 * over the full HTTP pipeline through a real AgentServer. Proves:
 *  - unlock returns a scoped dst_ token (NOT the master) when enabled; the master when dark (rollback);
 *  - the scoped token is admitted on ordinary routes but a credential route needs a fresh-PIN step-up;
 *  - refresh rotates the token and kills the old one; revoke kills the family;
 *  - the master token still works for API/CLI callers (back-compat).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'itest-master-token-sec002b';
const PIN = '246810';

function makeConfig(stateDir: string, enabled: boolean): InstarConfig {
  return {
    projectName: 'scoped-token-itest', projectDir: '/tmp/st', stateDir, port: 4042,
    authToken: AUTH, dashboardPin: PIN,
    security: { dashboardScopedToken: { enabled } },
    sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/echo', projectDir: '/tmp/st', maxSessions: 3, protectedSessions: [], completionPatterns: [] },
    scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
    users: [], messaging: [], monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
  } as InstarConfig;
}

let project: TempProject;
let mockSM: MockSessionManager;

function server(enabled: boolean) {
  const s = new AgentServer({ config: makeConfig(project.stateDir, enabled), sessionManager: mockSM as any, state: project.state } as any);
  return s.getApp();
}

beforeEach(() => { project = createTempProject(); mockSM = createMockSessionManager(); });
afterEach(() => { project.cleanup(); });

describe('dashboard scoped session token (b) — integration', () => {
  it('ENABLED: unlock returns a scoped dst_ token, not the master; it works on an ordinary route', async () => {
    const app = server(true);
    const r = await request(app).post('/dashboard/unlock').send({ pin: PIN });
    expect(r.status).toBe(200);
    expect(typeof r.body.token).toBe('string');
    expect(r.body.token.startsWith('dst_')).toBe(true);
    expect(r.body.token).not.toBe(AUTH);
    expect(typeof r.body.sessionExpiresAt).toBe('string');
    const ok = await request(app).get('/jobs').set('Authorization', 'Bearer ' + r.body.token);
    expect(ok.status).toBe(200);
  });

  it('DARK default: unlock returns the MASTER token (single-switch rollback / back-compat)', async () => {
    const app = server(false);
    const r = await request(app).post('/dashboard/unlock').send({ pin: PIN });
    expect(r.status).toBe(200);
    expect(r.body.token).toBe(AUTH);
    expect(r.body.sessionExpiresAt).toBeUndefined();
  });

  it('a credential route needs a fresh-PIN step-up for a scoped token; the step-up then passes the gate', async () => {
    const app = server(true);
    const dst = (await request(app).post('/dashboard/unlock').send({ pin: PIN })).body.token;
    const denied = await request(app).post('/credentials/swap').set('Authorization', 'Bearer ' + dst).send({});
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('step-up-required');
    const su = await request(app).post('/dashboard/session/step-up').send({ pin: PIN });
    expect(su.status).toBe(200);
    expect(typeof su.body.stepUpToken).toBe('string');
    const past = await request(app).post('/credentials/swap').set('Authorization', 'Bearer ' + dst).set('X-Instar-Step-Up', su.body.stepUpToken).send({});
    expect(past.status).not.toBe(403); // the step-up gate is passed (handler may 4xx/5xx for other reasons)
  });

  it('a wrong PIN at step-up does not mint a proof (403)', async () => {
    const app = server(true);
    const su = await request(app).post('/dashboard/session/step-up').send({ pin: '000000' });
    expect(su.status).toBe(403);
  });

  it('refresh rotates the token and kills the old one; revoke kills the family', async () => {
    const app = server(true);
    const dst = (await request(app).post('/dashboard/unlock').send({ pin: PIN })).body.token;
    const ref = await request(app).post('/dashboard/session/refresh').set('Authorization', 'Bearer ' + dst);
    expect(ref.status).toBe(200);
    expect(ref.body.token.startsWith('dst_')).toBe(true);
    expect(ref.body.token).not.toBe(dst);
    const dst2 = ref.body.token;
    // old token rejected after refresh
    expect((await request(app).get('/jobs').set('Authorization', 'Bearer ' + dst)).status).toBe(401);
    // revoke the family → the current token dies too
    await request(app).post('/dashboard/session/revoke').set('Authorization', 'Bearer ' + dst2);
    expect((await request(app).get('/jobs').set('Authorization', 'Bearer ' + dst2)).status).toBe(401);
  });

  it('the master token still works for API/CLI callers (back-compat)', async () => {
    const app = server(true);
    expect((await request(app).get('/jobs').set('Authorization', 'Bearer ' + AUTH)).status).toBe(200);
  });

  it('DARK: the lifecycle endpoints (step-up/refresh/revoke) are 404 — the feature adds no surface', async () => {
    const app = server(false);
    expect((await request(app).post('/dashboard/session/step-up').send({ pin: PIN })).status).toBe(404);
    expect((await request(app).post('/dashboard/session/refresh').send({})).status).toBe(404);
    expect((await request(app).post('/dashboard/session/revoke').send({})).status).toBe(404);
  });

  it('step-up is rate-limited like unlock — it is not an unthrottled PIN oracle', async () => {
    const app = server(true);
    let last: any;
    for (let i = 0; i < 7; i++) last = await request(app).post('/dashboard/session/step-up').send({ pin: '000000' });
    expect(last.status).toBe(429); // the shared per-client limiter trips after repeated wrong PINs
  });
});
