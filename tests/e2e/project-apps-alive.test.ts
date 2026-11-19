/**
 * Feature-is-alive proof for project apps (docs/specs/project-apps.md): an AgentServer booted on its
 * production path with a real ProjectAppsRuntime mounts the routes; the agent's Bearer can offer but
 * never attach; the owner's dashboard unlock (operator session) attaches; the switch off answers 503;
 * and the Work read carries the app for the project.
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
import { ProjectAppsRuntime } from '../../src/server/ProjectAppsRuntime.js';
import { projectAppRecordStoreSchema, type UnionEntry } from '../../src/core/ProjectAppStore.js';
import { projectAppsLog } from '../../src/server/projectAppsLog.js';
import type { InstarConfig } from '../../src/core/types.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/project-apps-alive.test.ts' });
});

const CK = 'telegram:128732';
const REF = 'builtin:maturation-board';

function boot(extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'project-apps-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const config = {
    projectName: 'project-apps-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', dashboardPin: '246810', developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, ...extra,
  } as unknown as InstarConfig;
  const union: UnionEntry[] = [];
  let t = 1_700_000_000_000;
  const runtime = new ProjectAppsRuntime({
    emit: (_k, build) => {
      const data = build({ physical: t++, logical: 0, node: 'm_e2e' }, 'm_e2e');
      if (!data || !projectAppRecordStoreSchema.validate(data, { countDroppedField() {}, countJailReject() {} })) return { outcome: 'dropped:invalid' };
      union.push({ data, origin: 'm_e2e' });
      return { outcome: 'emitted' };
    },
    loadUnion: () => union, now: () => t, machineId: 'm_e2e',
    isActingMachine: () => false, holdsLease: () => true, projectKeys: () => [CK], publicBase: () => null, platformFor: () => null,
    builtinSummary: () => ({ state: 'pending', why: 'Reading the board…' }), builtinAvailable: () => true,
    log: (entry) => projectAppsLog(stateDir, entry),
  });
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), projectAppsRuntime: () => runtime } as any);
  servers.push(server);
  return { app: server.getApp(), stateDir };
}

const enc = encodeURIComponent;

describe('project apps — production wiring', () => {
  it('offers with the Bearer, refuses a Bearer attach, attaches with the owner unlock, and logs an Open', async () => {
    const { app, stateDir } = boot();
    const auth = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'project-apps-e2e');

    expect((await request(app).post(`/work/projects/${enc(CK)}/app-offers`).send({ appRef: REF, why: 'x' })).status).toBe(401);
    const offer = await auth(request(app).post(`/work/projects/${enc(CK)}/app-offers`)).send({ appRef: REF, why: 'Four same-shaped status messages.' });
    expect(offer.status, JSON.stringify(offer.body)).toBe(200);
    const again = await auth(request(app).post(`/work/projects/${enc(CK)}/app-offers`)).send({ appRef: REF, why: 'again' });
    expect(again.body.error).toBe('already-offered');

    const bearerAttach = await auth(request(app).post(`/work/projects/${enc(CK)}/apps/${enc(REF)}/answer`)).send({ answer: 'attach' });
    expect(bearerAttach.status).toBe(403);
    expect(bearerAttach.body.error).toBe('owner-proof-required');

    const unlock = await request(app).post('/dashboard/unlock').send({ pin: '246810' });
    const session = unlock.body.operatorSessionToken as string | undefined;
    expect(typeof session, JSON.stringify(unlock.body)).toBe('string');
    const ownerAttach = await auth(request(app).post(`/work/projects/${enc(CK)}/apps/${enc(REF)}/answer`)).set('x-instar-operator-session', session!).send({ answer: 'attach', requestId: 'req-e2e-0001' });
    expect(ownerAttach.status, JSON.stringify(ownerAttach.body)).toBe(200);

    const opened = await auth(request(app).post(`/work/projects/${enc(CK)}/apps/${enc(REF)}/opened`)).send({});
    expect(opened.status).toBe(200);
    expect(fs.readFileSync(path.join(stateDir, 'logs', 'project-apps.jsonl'), 'utf8')).toContain('"event":"opened"');
    const stats = await auth(request(app).get('/work/projects/apps/stats'));
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ attached: 1, offers: 1, opens: 1 });
  });

  it('answers 503 project-apps-off when the switch is off', async () => {
    const { app } = boot({ projectApps: { enabled: false } });
    const r = await request(app).post(`/work/projects/${enc(CK)}/app-offers`).set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'project-apps-e2e').send({ appRef: REF, why: 'x' });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('project-apps-off');
  });
});
