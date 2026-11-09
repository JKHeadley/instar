// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * E2E (docs/specs/dashboard-console-default-and-pair-page.md): on the production initialization
 * path a REAL AgentServer sends /dashboard to the console, serves the legacy page at
 * /dashboard/legacy, and serves the pairing code page with its strict policy; the page's own
 * calls (unlock-check, PIN unlock, pairing approvals with the operator session) answer 200.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PAIR_PAGE_CSP } from '../../src/server/dashboardEntry.js';

describe('Dashboard front door + pairing code page E2E (feature is alive)', () => {
  const AUTH = 'console-default-e2e';
  const PIN = '482915';
  let tmp = '';
  let server: AgentServer;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-default-e2e-'));
    const stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(path.join(stateDir, 'server-data'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    const config = { projectName: 'e2e', projectDir: tmp, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN,
      requestTimeoutMs: 10_000, version: '0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: path.join(stateDir, 'jobs.json'), maxParallelJobs: 1 }, messaging: [], updates: {},
      mobilePairing: { enabled: true } } as unknown as InstarConfig;
    const sessionManager = { listRunningSessions: () => [], getSession: () => null } as never;
    server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir) } as never);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/dashboard-console-default-lifecycle.test.ts' });
  });

  it('/dashboard opens the console; a ?tab= link opens the legacy page', async () => {
    const app = server.getApp();
    const bare = await request(app).get('/dashboard');
    expect(bare.status).toBe(302);
    expect(bare.headers.location).toBe('/dashboard/console/');
    const tab = await request(app).get('/dashboard?tab=files&path=CLAUDE.md');
    expect(tab.status).toBe(302);
    expect(tab.headers.location).toBe('/dashboard/legacy?tab=files&path=CLAUDE.md');
    const console = await request(app).get('/dashboard/console/');
    expect(console.status).toBe(200);
    expect(console.text).toContain('console.js');
  });

  it('/dashboard/legacy serves the legacy page', async () => {
    const r = await request(server.getApp()).get('/dashboard/legacy?tab=phones');
    expect(r.status).toBe(200);
    expect(r.text).toContain('href="/dashboard/console/"');
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('/dashboard/pair and its script are served with the strict policy', async () => {
    const app = server.getApp();
    const page = await request(app).get('/dashboard/pair');
    expect(page.status).toBe(200);
    expect(page.text).toContain('id="pair-root"');
    expect(page.headers['content-security-policy']).toBe(PAIR_PAGE_CSP);
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['cache-control']).toBe('no-store');
    for (const p of ['/dashboard/pair.js', '/dashboard/pair-model.js', '/dashboard/pair.css']) {
      const r = await request(app).get(p);
      expect(r.status).toBe(200);
      expect(r.headers['content-security-policy']).toBe(PAIR_PAGE_CSP);
    }
  });

  it('the page’s own calls work: unlock-check, PIN unlock, approvals only with the operator session', async () => {
    const app = server.getApp();
    expect((await request(app).get('/dashboard/unlock-check')).body).toEqual({ accepted: true });
    const u = await request(app).post('/dashboard/unlock').send({ pin: PIN });
    expect(u.status).toBe(200);
    expect(typeof u.body.operatorSessionToken).toBe('string');
    const bearerOnly = await request(app).get('/mobile/pairing-approvals').set('Authorization', `Bearer ${u.body.token}`);
    expect(bearerOnly.status).toBe(403);
    const ok = await request(app).get('/mobile/pairing-approvals')
      .set('Authorization', `Bearer ${u.body.token}`).set('X-Instar-Operator-Session', u.body.operatorSessionToken);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.approvals)).toBe(true);
  });
});
