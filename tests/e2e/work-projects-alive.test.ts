/**
 * Feature-is-alive proof for Projects on the Work door (docs/specs/work-front-doors.md stage 2a): an AgentServer
 * booted on its production path answers GET /work/projects for the owner with every source accounted for
 * (ok, off or named as could-not-check, never silently absent), refuses an unknown caller, and the console
 * page that draws it is served.
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
import type { InstarConfig } from '../../src/core/types.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/work-projects-alive.test.ts' });
});

describe('Projects on the Work door — production wiring', () => {
  it('is alive for the owner and honest about each source', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'projects-e2e-'));
    dirs.push(dir);
    const stateDir = path.join(dir, '.instar');
    for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    const config = {
      projectName: 'projects-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    } as unknown as InstarConfig;
    const sessionManager = createMockSessionManager() as any;
    sessionManager.on = () => undefined;
    const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir) });
    servers.push(server);
    const app = server.getApp();

    expect((await request(app).get('/work/projects')).status).toBe(401);
    const r = await request(app).get('/work/projects').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'projects-e2e');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ schemaVersion: 1, viewer: { role: 'owner' } });
    expect(Array.isArray(r.body.projects)).toBe(true);
    expect(r.body.sources.map((s: { id: string }) => s.id)).toEqual(['chiefOfStaff', 'workBoard']);
    for (const s of r.body.sources) expect(['ok', 'off', 'failed']).toContain(s.state);
    expect(r.body.complete).toBe(r.body.couldNotCheck.length === 0);
    for (const s of r.body.sources.filter((x: { state: string }) => x.state === 'failed')) expect(r.body.couldNotCheck).toContain(s.label);
    // Every project row carries its state words and, for "Not known yet", the tracker's reason (null otherwise).
    for (const p of r.body.projects) { expect(typeof p.stateWords).toBe('string'); expect(p).toHaveProperty('why'); }

    // The console page that draws it ships with the server.
    const js = await request(app).get('/dashboard/console/projects.js');
    expect(js.status).toBe(200);
    expect(js.text).toContain('projectsSection');
    const model = await request(app).get('/dashboard/console/projects-model.js');
    expect(model.status).toBe(200);
    expect(model.text).toContain('whyLine');
  }, 60_000);
});
