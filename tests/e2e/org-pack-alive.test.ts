/**
 * Feature-is-alive proof for the organization pack (docs/specs/org-pack-and-join.md, Acceptance 5)
 * on the production AgentServer boot path: /org/draft and /org/invitations answer the bearer,
 * /mobile/org/publish answers an owner device and refuses the bearer, /org/pack/current is public.
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

const HOST = 'org-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/org-pack-alive.test.ts' });
});

describe('org-pack-and-join is alive on the production boot path', () => {
  it('routes are mounted with the right principals', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'org-e2e-'));
    dirs.push(dir);
    const stateDir = path.join(dir, '.instar');
    for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
    const dev = makeDevice();
    fs.writeFileSync(path.join(stateDir, 'state', 'mobile-devices.json'), JSON.stringify({ devices: [{
      id: 'dev-e2e', deviceName: 'Mac', label: null, pairedAt: new Date().toISOString(), status: 'active',
      publicKey: dev.publicKey, fingerprint: deviceFingerprint(dev.publicKey), host: HOST, approvedAt: new Date().toISOString(), approvedVia: 'dashboard-pin',
    }] }));
    const config = {
      projectName: 'scout', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token',
      mobilePairing: { enabled: true, multiRoute: { enabled: false }, native: { enabled: true } },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    } as unknown as InstarConfig;
    const sessionManager = createMockSessionManager() as any;
    sessionManager.on = () => undefined;
    const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir) });
    servers.push(server);
    const app = server.getApp();
    const bearer = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token');

    const draft = await bearer(request(app).post('/org/draft')).send({ orgName: 'Monroe Institute', policyMarkdown: '## Never\n- Spend organization money\n' });
    expect(draft.status).toBe(200);
    expect((await bearer(request(app).post('/mobile/org/publish')).send({ draftId: draft.body.draftId })).status).toBe(403);
    const body = Buffer.from(JSON.stringify({ draftId: draft.body.draftId, readBackConfirmed: true, shareUpdates: true }));
    const time = String(Date.now());
    const pub = await request(app).post('/mobile/org/publish').set('Host', HOST).set('Content-Type', 'application/json')
      .set('X-Instar-Device', 'dev-e2e').set('X-Instar-Device-Time', time)
      .set('X-Instar-Device-Sig', dev.sign(canonicalString('dev-e2e', HOST, 'POST', '/mobile/org/publish', time, body)))
      .send(body.toString());
    expect(pub.status).toBe(200);
    expect((await bearer(request(app).post('/org/invitations')).send({})).status).toBe(200);
    expect((await request(app).get('/org/pack/current')).status).toBe(200);
    expect((await bearer(request(app).get('/org/status'))).body.published.version).toBe(1);
  });
});
