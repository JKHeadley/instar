/**
 * Feature-is-alive proof for machine care from the owner's phone (machine-self-maintenance Part F,
 * CMT-1203): an AgentServer on its production path with mobile pairing on, a phone paired through the
 * real redeem/confirm path, then device-signed GET /mobile/machine-care and
 * POST /mobile/machine-care/:machineId/:action. Wiring integrity: both routes are on the production
 * device allowlist (not 403 device-not-allowed), mounted (not 404), and wired to the real rehearsal
 * (not 503); a skip from the phone shows in the status and is recorded as `mobile-device:<id>`; another
 * machine's id is refused; the agent's own bearer token is refused on both routes.
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
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { allowTestIdentities } from '../helpers/allow-test-identities.js';
import { DrainRehearsal, setActiveDrainRehearsal } from '../../src/monitoring/machineMaintenance/DrainRehearsal.js';
import { HostMaintenanceStore } from '../../src/monitoring/machineMaintenance/HostMaintenanceStore.js';
import { DEFAULT_MACHINE_MAINTENANCE } from '../../src/monitoring/machineMaintenance/planner.js';

const HOST = 'echo-machine-care-e2e.example.dev';
const SELF = 'm_self_e2e';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  setActiveDrainRehearsal(null);
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/machine-care-app-alive.test.ts' });
});

describe('machine care from the owner\'s phone — production wiring', () => {
  it('is alive: a paired owner phone reads the status, skips and sets the window for this machine only; the bearer is refused', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'machine-care-app-e2e-'));
    dirs.push(dir);
    const stateDir = path.join(dir, '.instar');
    for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    allowTestIdentities(stateDir);
    await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
    const config = {
      projectName: 'machine-care-e2e', projectDir: dir, stateDir, host: '127.0.0.1', port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: '424242',
      mobilePairing: { multiRoute: { enabled: false } },
      tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
      threadline: { ownerName: 'Justin' },
    } as unknown as InstarConfig;
    const sessionManager = createMockSessionManager() as any;
    sessionManager.on = () => undefined;
    const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
    const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel, meshSelfId: SELF } as never);
    servers.push(server);
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();

    const store = new HostMaintenanceStore({ dir: path.join(dir, 'host') });
    setActiveDrainRehearsal(new DrainRehearsal({
      agentName: 'machine-care-e2e', version: '1', stateDir, logPath: path.join(stateDir, 'logs', 'machine-drain.jsonl'),
      store, controls: () => store.readControls(), enabled: () => true, settings: () => DEFAULT_MACHINE_MAINTENANCE,
      readSignals: async () => { throw new Error('no read'); }, census: async () => { throw new Error('no read'); },
      resumeQueue: () => null, coResidentAgents: () => [], holdsLease: () => null, ownUser: 'me',
    }));

    // Pair a phone through the real path.
    const bearer = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'machine-care-e2e');
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const m = await bearer(request(app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
    const dev = makeDevice();
    const redeemed = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(redeemed.status).toBe(200);
    const deviceId = redeemed.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    let t = Date.now();
    const post = (p: string, body: unknown) => {
      const raw = Buffer.from(JSON.stringify(body));
      const time = String(++t);
      return request(app).post(p).set('Content-Type', 'application/json').set('Host', HOST)
        .set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', dev.sign(canonicalString(deviceId, HOST, 'POST', p, time, raw))).send(raw.toString());
    };
    const get = (p: string) => {
      const time = String(++t);
      return request(app).get(p).set('Host', HOST)
        .set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', dev.sign(canonicalString(deviceId, HOST, 'GET', p, time, undefined)));
    };
    expect((await post('/mobile/device/confirm', { code })).body.status).toBe('active');

    // The status from the phone.
    const st = await get('/mobile/machine-care');
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    expect(JSON.stringify(st.body)).toContain('"controls"');

    // Skip from the phone: shown in the status, recorded as the phone.
    const skip = await post(`/mobile/machine-care/${SELF}/skip`, {});
    expect(skip.status, JSON.stringify(skip.body)).toBe(200);
    expect(skip.body).toMatchObject({ ok: true, viaMobileDevice: true });
    expect(store.readControls()!.history.at(-1)).toMatchObject({ action: 'skip', by: `mobile-device:${deviceId}` });
    const after = await bearer(request(app).get('/machine-maintenance'));
    expect(after.body.controls).toMatchObject({ skipped: true });

    // Window: `self` names this machine; a short window is refused and changes nothing.
    expect((await post('/mobile/machine-care/self/window', { window: { start: '01:00', end: '02:00' } })).status).toBe(400);
    const win = await post('/mobile/machine-care/self/window', { window: { start: '01:00', end: '04:00' } });
    expect(win.body).toMatchObject({ ok: true, effectiveWindow: { start: '01:00', end: '04:00' } });

    // Another machine's id is refused; the agent's bearer cannot use either route.
    const other = await post('/mobile/machine-care/m_other/unskip', {});
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('other-machine');
    expect((await bearer(request(app).post(`/mobile/machine-care/${SELF}/unskip`)).send({})).status).toBe(403);
    expect((await bearer(request(app).get('/mobile/machine-care'))).status).toBe(403);
    expect(store.readControls()!.history.map((h) => h.action)).toEqual(['skip', 'window']);
  });
});
