// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" test for document decisions (docs/specs/document-decisions.md).
 *
 * Boots the REAL AgentServer on the production init path and proves, on a development agent:
 *   - the agent asks with decision:{question}, the real store writes the ask row, GET /docs/:id/decision
 *     reads it back (200, not 503), the waiting list names the document, and the session-context block
 *     says "waiting for the owner's decision";
 *   - the phone routes are mounted behind the device signature (a bare call is refused, never 500);
 *   - the agent withdraws the question; nothing waits on the owner;
 * and on a fleet config every decision route is 503 documents-off.
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

const AUTH = 'e2e-document-decisions';
const dirs: string[] = [];
const servers: AgentServer[] = [];

async function boot(extra: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-decisions-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'doc-decisions-e2e', projectDir: dir, stateDir, port: 0, authToken: AUTH,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
    ...extra,
  } as unknown as InstarConfig;
  const server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null } as never, state: new StateManager(stateDir) });
  await server.start();
  servers.push(server);
  return { app: server.getApp(), server };
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/documents-decisions-alive.test.ts' });
});

const auth = () => ({ Authorization: `Bearer ${AUTH}` });

describe('Document decisions — feature is alive', () => {
  it('asks, reads back and withdraws through the production init path', async () => {
    const { app, server } = await boot({ developmentAgent: true, tunnel: { enabled: false, type: 'named', hostname: 'docs-e2e.example.dev' } });
    const created = await request(app).post('/docs').set(auth()).send({ title: 'Hardening', markdown: '# Hardening\n\nShip it?\n', primary: 'telegram:7', decision: { question: 'Ship the hardening?' } });
    expect(created.status).toBe(201);
    expect(created.body.askId).toMatch(/^[0-9a-f-]{36}$/);
    const id = created.body.id as string;
    const d = await request(app).get(`/docs/${id}/decision`).set(auth());
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ ask: { askId: created.body.askId, question: 'Ship the hardening?' }, decision: null, waitingOnOwner: true });
    expect((await request(app).get('/docs/decisions/waiting').set(auth())).body.documents.map((x: { id: string }) => x.id)).toEqual([id]);
    const ctx = await request(app).get('/docs/session-context?conversation=telegram:7').set(auth());
    expect(ctx.body.text).toContain("waiting for the owner's decision");
    // Wiring: the page deps are the real implementations, not no-ops.
    expect(server.documentDecisionWritesBlockedBy()).toBeNull();
    expect(server.documentDecisionRoot('no-such-device')).toBeNull();
    // The phone routes are mounted behind the device signature: a bare call is refused, never 500.
    for (const p of [`/mobile/docs/${id}/decision/challenge`, `/mobile/docs/${id}/decision`, `/mobile/docs/${id}/decision/delivered`]) {
      const r = await request(app).post(p).send({});
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    expect((await request(app).post(`/docs/${id}/w/decide-on-phone`).set('X-Instar-Request', '1').send({})).status).toBe(401);
    const closed = await request(app).post(`/docs/${id}/decision-ask/close`).set(auth()).send({});
    expect(closed.status).toBe(200);
    expect((await request(app).get(`/docs/${id}/decision`).set(auth())).body.ask).toBeNull();
    expect((await request(app).get('/docs/decisions/waiting').set(auth())).body.documents).toEqual([]);
  });

  it('is dark on a fleet config: 503 documents-off', async () => {
    const { app } = await boot({});
    expect((await request(app).get('/docs/decisions/waiting').set(auth())).status).toBe(503);
    expect((await request(app).post('/docs/00000000-0000-4000-8000-000000000000/decision-ask').set(auth()).send({ question: 'x' })).status).toBe(503);
  });
});
