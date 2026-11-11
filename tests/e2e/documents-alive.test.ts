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
    const { app, stateDir } = await boot({ developmentAgent: true });
    const created = await request(app).post('/docs').set(auth()).send({ title: 'Plan', markdown: '# Plan\n\nWe ship in steps.\n', primary: 'telegram:7' });
    expect(created.status).toBe(201);
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
  });

  it('is dark on a fleet config: 503 documents-off', async () => {
    const { app } = await boot({});
    const r = await request(app).post('/docs').set(auth()).send({ title: 'x', markdown: 'y' });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('documents-off');
    expect((await request(app).get('/docs/health').set(auth())).status).toBe(503);
  });
});
