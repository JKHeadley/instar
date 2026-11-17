/**
 * Project apps part 2 serving, through the real AgentServer HTTP pipeline
 * (docs/specs/project-apps-sandbox.md §3.6-3.7, §8 integration): ticket + key need the console
 * credential; the frame needs a single-use ticket and refuses a top-level open; its headers are
 * exact; the app api's only gate is the narrow key; the narrow key reaches NO owner route; the
 * CORS branch covers the api paths only; the wrapper page carries its own frame-src.
 * Storage and approvals are an in-memory fake (FakeCustomAppSource).
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ProjectAppSandbox, frameCsp } from '../../src/server/ProjectAppSandbox.js';
import { FakeCustomAppSource } from '../helpers/fakeCustomAppSource.js';
import type { InstarConfig } from '../../src/core/types.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/project-app-sandbox-routes.test.ts' });
});

const TOKEN = 'pa-sandbox-token';
const AGENT = 'pa-sandbox';
const A = 'pa_0123456789abcdef';
const B = 'pa_fedcba9876543210';
const HTML_A = '<!doctype html><p>sales pipeline v1</p>';
const SECRET = Buffer.alloc(32, 9);

function boot(extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'pa-sandbox-int-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const config = {
    projectName: AGENT, projectDir: dir, stateDir, port: 0, authToken: TOKEN, dashboardPin: '246810', developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, ...extra,
  } as unknown as InstarConfig;
  const source = new FakeCustomAppSource();
  source.add(A, HTML_A);
  source.add(B, '<p>other app</p>', { title: 'Course tracker' });
  const sandbox = new ProjectAppSandbox({ source, hmacSecret: () => SECRET });
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), projectAppSandbox: () => sandbox } as any);
  servers.push(server);
  return { app: server.getApp(), source, sandbox };
}

const owner = (r: request.Test) => r.set('Authorization', `Bearer ${TOKEN}`).set('X-Instar-AgentId', AGENT);

async function ticket(app: ReturnType<typeof boot>['app'], appId = A) {
  const r = await owner(request(app).post(`/project-apps/${appId}/ticket`)).send({});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { ticket: string; contentSha: string; frameUrl: string; meta: { title: string } };
}
async function key(app: ReturnType<typeof boot>['app'], contentSha: string, appId = A) {
  const r = await owner(request(app).post(`/project-apps/${appId}/key`)).send({ contentSha });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.key as string;
}

describe('project app sandbox — ticket and frame', () => {
  const { app, source } = boot();

  it('ticket and key routes need the console credential', async () => {
    expect((await request(app).post(`/project-apps/${A}/ticket`).send({})).status).toBe(401);
    expect((await request(app).post(`/project-apps/${A}/key`).send({ contentSha: 'a'.repeat(64) })).status).toBe(401);
    const t = await ticket(app);
    expect(t.meta.title).toBe('Sales pipeline');
    expect(t.frameUrl).toBe(`/project-apps/${A}/frame?t=${encodeURIComponent(t.ticket)}`);
  });

  it('serves the frame once with the exact headers, and never redirects', async () => {
    const t = await ticket(app);
    const r = await request(app).get(t.frameUrl).set('Sec-Fetch-Dest', 'iframe');
    expect(r.status).toBe(200);
    expect(r.text).toBe(HTML_A);
    const origin = `http://${r.req.getHeader('host')}`;
    expect(r.headers['content-security-policy']).toBe(frameCsp(origin, A));
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['etag']).toBe(`"${t.contentSha}"`);
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['location']).toBeUndefined();
    // single use
    const again = await request(app).get(t.frameUrl).set('Sec-Fetch-Dest', 'iframe');
    expect(again.status).toBe(403);
    expect(again.headers['content-security-policy']).toMatch(/^sandbox;/);
  });

  it('a browser that omits Sec-Fetch-Dest is covered by the ticket alone', async () => {
    const t = await ticket(app);
    expect((await request(app).get(t.frameUrl)).status).toBe(200);
  });

  it('refuses no ticket, a top-level open (Sec-Fetch-Dest: document), another app\'s ticket, and an unknown host', async () => {
    expect((await request(app).get(`/project-apps/${A}/frame`)).status).toBe(403);
    const t1 = await ticket(app);
    expect((await request(app).get(t1.frameUrl).set('Sec-Fetch-Dest', 'document')).status).toBe(403);
    const tb = await ticket(app, B);
    expect((await request(app).get(`/project-apps/${A}/frame?t=${encodeURIComponent(tb.ticket)}`).set('Sec-Fetch-Dest', 'iframe')).status).toBe(403);
    const t2 = await ticket(app);
    expect((await request(app).get(t2.frameUrl).set('Host', 'evil.example')).status).toBe(400);
  });

  it('a ticket for an older version is refused after a new version is served', async () => {
    const t = await ticket(app);
    source.serve(A, '<p>v2</p>');
    expect((await request(app).get(t.frameUrl).set('Sec-Fetch-Dest', 'iframe')).status).toBe(403);
    const fresh = await ticket(app);
    const r = await request(app).get(fresh.frameUrl).set('Sec-Fetch-Dest', 'iframe');
    expect(r.status).toBe(200);
    expect(r.text).toBe('<p>v2</p>');
  });
});

describe('project app sandbox — the narrow key', () => {
  const { app, source } = boot();

  it('reads and writes its own data and summary; refuses no key and the agent Bearer alone', async () => {
    const t = await ticket(app);
    const k = await key(app, t.contentSha);
    expect((await request(app).get(`/project-apps/${A}/api/data`)).status).toBe(401);
    expect((await owner(request(app).get(`/project-apps/${A}/api/data`))).status).toBe(401);
    const put = await request(app).put(`/project-apps/${A}/api/data`).set('X-Project-App-Key', k).send({ body: { deals: 10 }, base: null });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const stale = await request(app).put(`/project-apps/${A}/api/data`).set('X-Project-App-Key', k).send({ body: { deals: 11 }, base: null });
    expect(stale.status).toBe(409);
    const get = await request(app).get(`/project-apps/${A}/api/data`).set('X-Project-App-Key', k);
    expect(get.body).toEqual({ body: { deals: 10 }, revision: put.body.revision });
    expect((await request(app).put(`/project-apps/${A}/api/summary`).set('X-Project-App-Key', k).send({ headline: '10 deals' })).status).toBe(200);
    expect((await request(app).get(`/project-apps/${A}/api/summary`).set('X-Project-App-Key', k)).body).toEqual({ summary: { headline: '10 deals' } });
  });

  it('never reaches an owner route (401 on every class)', async () => {
    const t = await ticket(app);
    const k = await key(app, t.contentSha);
    const ROUTES: Array<[string, string]> = [
      ['post', '/work-board/cards/x/tap'],
      ['post', `/work/projects/${encodeURIComponent('telegram:1')}/apps/${encodeURIComponent('builtin:maturation-board')}/answer`],
      ['post', '/team/people/x/lower'],
      ['post', '/dashboard/pin'],
      ['patch', '/owner-policy'],
      ['post', '/messages/send'],
      ['post', '/sessions/spawn'],
      ['post', '/telegram/reply/1'],
      ['post', `/project-apps/${A}/key`],
      ['post', `/project-apps/${A}/ticket`],
      ['get', `/project-apps/${B}/api/data`],
      ['put', `/project-apps/${B}/api/data`],
      ['put', `/project-apps/${B}/api/summary`],
    ];
    for (const [m, p] of ROUTES) {
      const viaHeader = await (request(app) as any)[m](p).set('X-Project-App-Key', k).send({ answer: 'attach', text: 'x' });
      expect(viaHeader.status, `${m} ${p} (header) → ${viaHeader.status} ${JSON.stringify(viaHeader.body)}`).toBe(401);
      const viaBearer = await (request(app) as any)[m](p).set('Authorization', `Bearer ${k}`).set('X-Instar-AgentId', AGENT).send({});
      expect(viaBearer.status, `${m} ${p} (bearer) → ${viaBearer.status}`).toBe(401);
    }
  });

  it('is revoked by an epoch bump, a disable and a new served version; renewal is refused for the old version', async () => {
    let t = await ticket(app);
    let k = await key(app, t.contentSha);
    source.bumpEpoch(A);
    expect((await request(app).get(`/project-apps/${A}/api/data`).set('X-Project-App-Key', k)).body.reason).toBe('revoked');

    t = await ticket(app);
    k = await key(app, t.contentSha);
    const sha2 = source.serve(A, '<p>v-next</p>');
    expect((await request(app).get(`/project-apps/${A}/api/data`).set('X-Project-App-Key', k)).status).toBe(401);
    const renew = await owner(request(app).post(`/project-apps/${A}/key`)).send({ contentSha: t.contentSha });
    expect(renew.status).toBe(409);
    expect(renew.body).toEqual({ error: 'version-changed', contentSha: sha2 });

    t = await ticket(app);
    k = await key(app, t.contentSha);
    source.disable(A);
    expect((await request(app).get(`/project-apps/${A}/api/data`).set('X-Project-App-Key', k)).status).toBe(401);
    const mint = await owner(request(app).post(`/project-apps/${A}/key`)).send({ contentSha: t.contentSha });
    expect(mint.body).toEqual({ error: 'not-served', state: 'disabled' });
    expect((await owner(request(app).post(`/project-apps/${A}/ticket`)).send({})).status).toBe(409);
  });
});

describe('project app sandbox — CORS and the wrapper page', () => {
  const { app } = boot();

  it('preflight on the api paths allows Origin null with the key header; nowhere else', async () => {
    const pre = await request(app).options(`/project-apps/${A}/api/data`).set('Origin', 'null')
      .set('Access-Control-Request-Method', 'PUT').set('Access-Control-Request-Headers', 'x-project-app-key, content-type');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('null');
    expect(pre.headers['access-control-allow-methods']).toBe('GET, PUT, OPTIONS');
    expect(pre.headers['access-control-allow-headers']).toBe('X-Project-App-Key, Content-Type');
    expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
    for (const p of ['/work-board/cards/x/tap', `/project-apps/${A}/key`, `/project-apps/${A}/frame`, '/messages/send']) {
      const other = await request(app).options(p).set('Origin', 'null').set('Access-Control-Request-Method', 'POST');
      expect(other.headers['access-control-allow-origin'], p).toBeUndefined();
      expect(other.headers['access-control-allow-headers'], p).toBe('Content-Type, Authorization');
    }
  });

  it('the wrapper page carries its own frame-src for this app on this origin; an unknown host is 400', async () => {
    const r = await request(app).get(`/dashboard/project-app/?app=${A}`);
    expect(r.status).toBe(200);
    const origin = `http://${r.req.getHeader('host')}`;
    expect(r.headers['content-security-policy']).toContain(`frame-src ${origin}/project-apps/${A}/frame;`);
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.text).toContain('anything you type here goes to your agent');
    expect(r.text).toContain('sandbox="allow-scripts allow-forms"');
    expect(r.text).toContain('referrerpolicy="no-referrer"');
    expect((await request(app).get(`/dashboard/project-app/?app=${A}`).set('Host', 'evil.example')).status).toBe(400);
    expect((await request(app).get('/dashboard/project-app/?app=nope')).status).toBe(400);
  });
});

describe('project app sandbox — switch off', () => {
  const { app } = boot({ projectApps: { custom: { enabled: false } } });
  it('ticket, key, frame and api answer 503', async () => {
    expect((await owner(request(app).post(`/project-apps/${A}/ticket`)).send({})).status).toBe(503);
    expect((await owner(request(app).post(`/project-apps/${A}/key`)).send({ contentSha: 'a'.repeat(64) })).status).toBe(503);
    expect((await request(app).get(`/project-apps/${A}/frame?t=x`)).status).toBe(503);
    expect((await request(app).get(`/project-apps/${A}/api/data`).set('X-Project-App-Key', 'pak_x')).status).toBe(503);
  });
});

describe('project app sandbox — the per-app request rate (§3.7)', () => {
  it('a burst past the bucket answers 429 with a plain error; another app is unaffected', async () => {
    const { app } = boot();
    const t = await ticket(app);
    const k = await key(app, t.contentSha);
    const tb = await ticket(app, B);
    const kb = await key(app, tb.contentSha, B);
    const res = await Promise.all(Array.from({ length: 80 }, () => request(app).get(`/project-apps/${A}/api/data`).set('X-Project-App-Key', k)));
    const statuses = res.map((r) => r.status);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(30); // the burst
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);
    const limited = res.find((r) => r.status === 429)!;
    expect(limited.headers['retry-after']).toBe('1');
    expect(limited.body).toEqual({ error: 'too-many-requests', detail: 'This app is asking too often. Wait a moment and try again.' });
    expect((await request(app).get(`/project-apps/${B}/api/data`).set('X-Project-App-Key', kb)).status).toBe(200);
    // a caller without the key cannot spend the app's allowance: it gets 401, never 429
    expect((await request(app).get(`/project-apps/${B}/api/data`).set('X-Project-App-Key', 'pak_nope')).status).toBe(401);
  });
});
