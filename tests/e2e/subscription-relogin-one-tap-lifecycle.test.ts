// spec docs/specs/one-tap-unattended-repair.md — the production AgentServer path: the routes are
// alive (not 404/503), the read carries `config`, and the console section ships.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const roots: string[] = [];
const servers: AgentServer[] = [];

function config(root: string): InstarConfig {
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  return {
    projectName: 'one-tap-e2e', projectDir: root, stateDir, port: 0,
    authToken: 'one-tap-token', dashboardPin: '123456', requestTimeoutMs: 10_000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    subscriptionPool: { assistedRelogin: { enabled: true, mode: 'unattended', dryRun: false,
      unattendedPolicy: { identities: ['echo@sagemindai.io'], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 } } },
  } as InstarConfig;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'one-tap e2e cleanup' });
});

describe('one-tap repair setting through the production AgentServer', () => {
  it('serves config on the read, keeps both new routes alive behind real auth, and ships the console section', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-tap-e2e-')); roots.push(root);
    const cfg = config(root);
    fs.writeFileSync(path.join(cfg.stateDir, 'config.json'), JSON.stringify(cfg, null, 2));
    const server = new AgentServer({ config: cfg, sessionManager: { listRunningSessions: () => [], getSession: () => null, on: vi.fn() } as never,
      state: new StateManager(cfg.stateDir) });
    servers.push(server);
    await server.start();
    const app = server.getApp();

    // The read: runtime absent here, so 503 — but the body carries this machine's setting.
    const read = await request(app).get('/subscription-relogin').set('Authorization', 'Bearer one-tap-token');
    expect(read.status).toBe(503);
    expect(read.body.config).toMatchObject({ mode: 'unattended', identities: ['echo@sagemindai.io'], activationPending: false });
    const revision = read.body.config.revision as string;
    expect(revision).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Fronting route: alive, and refuses without a recent unlock.
    const denied = await request(app).post('/subscription-relogin/configure-pool').set('Authorization', 'Bearer one-tap-token')
      .send({ mode: 'approval', targets: [{ machineId: 'local', expectedRevision: revision }] });
    expect(denied.status).toBe(401);

    // With a real PIN unlock: switch this machine back to asking first.
    const unlock = await request(app).post('/dashboard/unlock').send({ pin: '123456' });
    expect(unlock.status).toBe(200);
    const selfId = read.body.config.machineId as string;
    const back = await request(app).post('/subscription-relogin/configure-pool').set('Authorization', 'Bearer one-tap-token')
      .set('X-Instar-Operator-Session', unlock.body.operatorSessionToken)
      .send({ mode: 'approval', targets: [{ machineId: selfId, expectedRevision: revision, identities: ['echo@sagemindai.io'], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 }] });
    expect(back.status).toBe(200);
    expect(back.body.results).toEqual([expect.objectContaining({ machineId: selfId, ok: true, mode: 'approval', changed: true })]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(cfg.stateDir, 'config.json'), 'utf8')).subscriptionPool.assistedRelogin;
    expect(onDisk).toMatchObject({ mode: 'approval', generation: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(cfg.stateDir, 'state', 'restart-requested.json'), 'utf8')).targetVersion).toBeUndefined();

    // Target route: alive behind Bearer auth; an unknown mandate is refused, not 404.
    const target = await request(app).post('/subscription-relogin/configure-with-mandate').set('Authorization', 'Bearer one-tap-token')
      .send({ mandateId: 'nope', action: 'finish-restart', expectedRevision: revision });
    expect(target.status).toBe(403);

    // The console section ships.
    const dash = fs.readFileSync(path.join(process.cwd(), 'dashboard', 'console', 'accounts.js'), 'utf8');
    expect(dash).toContain('Automatic sign-in repair');
    expect(dash).toContain('/subscription-relogin/configure-pool');
  });
});
