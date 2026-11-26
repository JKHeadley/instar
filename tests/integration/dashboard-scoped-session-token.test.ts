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

const TUNNEL_HOST = 'scoped-token.trycloudflare.test';

function server(enabled: boolean, opts: { tunnel?: boolean } = {}) {
  const s = new AgentServer({ config: makeConfig(project.stateDir, enabled), sessionManager: mockSM as any, state: project.state,
    ...(opts.tunnel ? { tunnel: { url: `https://${TUNNEL_HOST}` } } : {}) } as any);
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

  it('step-up is rate-limited like unlock — it is not an unthrottled PIN oracle (one public budget)', async () => {
    // identity-security-piece1c: step-up uses the same public-budget helpers as unlock. A loopback
    // caller that is neither this machine's own address nor behind the agent's own tunnel header is
    // unattributable, so it is charged to the shared unmarked budget only (20 per window).
    const app = server(true);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await request(app).post('/dashboard/session/step-up').send({ pin: '000000' })).status);
    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(403));
    expect(statuses[20]).toBe(429);
    // Step-up guesses drain the SAME budget as sign-in: an unmarked unlock is refused too, even with the right PIN.
    expect((await request(app).post('/dashboard/unlock').send({ pin: PIN })).status).toBe(429);
  });

  it('step-up keys a tunnel caller on its real client: one client backs off, another is unaffected', async () => {
    const app = server(true, { tunnel: true });
    const stepUp = (ip: string) => request(app).post('/dashboard/session/step-up')
      .set('Host', TUNNEL_HOST).set('cf-connecting-ip', ip).set('x-forwarded-proto', 'https');
    for (let i = 0; i < 3; i++) expect((await stepUp('198.51.100.7').send({ pin: '000000' })).status).toBe(403);
    // Past the 3 soft failures this client is backed off, even with the right PIN…
    expect((await stepUp('198.51.100.7').send({ pin: PIN })).status).toBe(429);
    // …while a different client (not the shared 127.0.0.1 socket bucket) still steps up.
    const other = await stepUp('203.0.113.9').send({ pin: PIN });
    expect(other.status).toBe(200);
    expect(typeof other.body.stepUpToken).toBe('string');
  });
});
