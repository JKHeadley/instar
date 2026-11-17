/**
 * Feature-is-alive proof for org-recovery-copy (Acceptance 5): on the production boot path the
 * recovery routes are mounted, refuse the bearer, and recover without `retired: true` answers 400.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString, deviceFingerprint } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';

const HOST = 'org-rc-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/org-recovery-copy-alive.test.ts' });
});

describe('org-recovery-copy is alive', () => {
  it('routes are mounted with the right principals', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'orc-e2e-'));
    dirs.push(dir);
    const stateDir = path.join(dir, '.instar');
    for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
    const dev = makeDevice();
    fs.writeFileSync(path.join(stateDir, 'state', 'mobile-devices.json'), JSON.stringify({ devices: [{
      id: 'device-e2e-rc', deviceName: 'Mac', label: null, pairedAt: new Date().toISOString(), status: 'active',
      publicKey: dev.publicKey, fingerprint: deviceFingerprint(dev.publicKey), host: HOST, approvedAt: new Date().toISOString(), approvedVia: 'dashboard-pin',
    }] }));
    const config = {
      projectName: 'e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
      mobilePairing: { enabled: true, multiRoute: { enabled: false }, native: { enabled: true } },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    } as unknown as InstarConfig;
    const sessionManager = createMockSessionManager() as any;
    sessionManager.on = () => undefined;
    const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir) });
    servers.push(server);
    const app = server.getApp();
    expect((await request(app).post('/mobile/org/recovery-copy').set('Authorization', 'Bearer e2e-token').send({})).status).toBe(403);
    expect((await request(app).post('/mobile/org/recover').set('Authorization', 'Bearer e2e-token').send({})).status).toBe(403);
    const body = Buffer.from(JSON.stringify({ file: {}, phrase: 'x' }));
    const time = String(Date.now());
    const r = await request(app).post('/mobile/org/recover').set('Host', HOST).set('Content-Type', 'application/json')
      .set('X-Instar-Device', 'device-e2e-rc').set('X-Instar-Device-Time', time)
      .set('X-Instar-Device-Sig', dev.sign(canonicalString('device-e2e-rc', HOST, 'POST', '/mobile/org/recover', time, body)))
      .send(body.toString());
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('retirement-required');
  });
});
