// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" test for Instar Documents (docs/specs/instar-document-viewer.md).
 *
 * Boots the REAL AgentServer on the production init path and proves:
 *   - on a development agent the routes are alive (200/201), backed by the real on-disk store
 *     signed with the machine's own identity;
 *   - a created document reads back, its comment list answers, the machine-to-machine page serves
 *     its rows, and the session-context block names it;
 *   - on a fleet config (no developmentAgent, documents.enabled omitted) every route is 503 documents-off.
 */
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'e2e-documents';
const dirs: string[] = [];
const servers: AgentServer[] = [];

async function boot(extra: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'documents-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'documents-e2e', projectDir: dir, stateDir, port: 0, authToken: AUTH,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
    ...extra,
  } as unknown as InstarConfig;
  const server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null } as never, state: new StateManager(stateDir) });
  await server.start();
  servers.push(server);
  return { app: server.getApp(), stateDir };
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/documents-alive.test.ts' });
});

const auth = () => ({ Authorization: `Bearer ${AUTH}` });

describe('Instar Documents — feature is alive', () => {
  it('serves on a development agent through the production init path', async () => {
    const { app, stateDir } = await boot({ developmentAgent: true, tunnel: { enabled: false, type: 'named', hostname: 'docs-e2e.example.dev' } });
    const created = await request(app).post('/docs').set(auth()).send({ title: 'Plan', markdown: '# Plan\n\nWe ship in steps.\n', primary: 'telegram:7' });
    expect(created.status).toBe(201);
    expect(created.body.url).toBe(`https://docs-e2e.example.dev/docs/${created.body.id}`);
    const id = created.body.id as string;
    const read = await request(app).get(`/docs/${id}/data`).set(auth());
    expect(read.status).toBe(200);
    expect(read.body.markdown).toBe('# Plan\n\nWe ship in steps.\n');
    expect((await request(app).get(`/docs/${id}/comments`).set(auth())).body.comments).toEqual([]);
    const ctx = await request(app).get('/docs/session-context?conversation=telegram:7').set(auth());
    expect(ctx.status).toBe(200);
    expect(ctx.body.text).toContain(`/docs/${id}`);
    // The real store wrote signed rows to disk under the documents directory.
    expect(fs.readdirSync(path.join(stateDir, 'documents', 'rows')).length).toBe(1);
    expect((await request(app).get('/docs/health').set(auth())).body).toMatchObject({ ok: true, pending: 0 });
    // The document page (§3.6) is mounted on the real server: the shell and its script load with no
    // bearer token and a strict CSP, and its data needs the page's own read pass.
    const shell = await request(app).get(`/docs/${id}`);
    expect(shell.status).toBe(200);
    expect(shell.headers['content-security-policy']).toContain("script-src 'self'");
    expect(shell.text).not.toContain('We ship in steps');
    const js = await request(app).get('/docs/_assets/doc-page.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    expect((await request(app).get(`/docs/${id}/page-data`)).status).toBe(401);
    // Writes need a device signature: a bare request is refused, never 500.
    expect((await request(app).post(`/docs/${id}/w/comment`).set('X-Instar-Request', '1').send({})).status).toBe(401);
    // The link graph answers from the document.
    const graph = await request(app).get(`/docs/graph?from=doc:${id}`).set(auth());
    expect(graph.status).toBe(200);
    expect(graph.body.edges).toContainEqual({ from: `doc:${id}`, to: 'telegram:7', kind: 'primary' });
  });

  it('without a permanent address, a create says so instead of handing out a link nobody can open', async () => {
    const { app } = await boot({ developmentAgent: true });
    const r = await request(app).post('/docs').set(auth()).send({ title: 'x', markdown: 'y', primary: 'telegram:7' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('documents-need-a-named-tunnel');
  });

  it('is dark on a fleet config: 503 documents-off', async () => {
    const { app } = await boot({});
    const r = await request(app).post('/docs').set(auth()).send({ title: 'x', markdown: 'y' });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('documents-off');
    expect((await request(app).get('/docs/health').set(auth())).status).toBe(503);
    expect((await request(app).get('/docs/_assets/doc-page.js')).status).toBe(503);
  });
});
