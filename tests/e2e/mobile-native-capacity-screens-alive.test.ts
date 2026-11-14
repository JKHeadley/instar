/**
 * Feature-is-alive proof for the phone's native Accounts, What thinking costs and Resource usage
 * reads (docs/specs/mobile-native-capacity-screens.md): an AgentServer booted on its production
 * path (development agent), a phone paired through the existing redeem/confirm path, then
 * GET /mobile/accounts, /mobile/spend and /mobile/resources answer 200 (not 403/503) for that owner
 * phone, built from the server's real wiring (honest enabled/off states). The raw Bearer routes
 * stay closed to the phone; the bearer token reads the same summaries. Wiring integrity: the spend
 * answer's recorded state agrees with the server's own /routing-spend/summary.
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

const HOST = 'echo-capacity-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-native-capacity-screens-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'capacity-screens-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'capacity-screens-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  return { server };
}

describe('native capacity screens — production wiring', () => {
  it('is alive: an owner phone reads accounts, spend and resources; the raw routes stay closed', async () => {
    const { server } = await boot();
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'capacity-screens-e2e');
    const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
    const dev = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(r.status).toBe(200);
    const deviceId = r.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    let t = Date.now();
    const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(++t);
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.send(raw.toString()) : q;
    };
    expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');

    const accounts = await send('GET', '/mobile/accounts');
    expect(accounts.status).toBe(200);
    expect(accounts.body.schemaVersion).toBe(1);
    expect(typeof accounts.body.headline).toBe('string');
    expect(Array.isArray(accounts.body.notices)).toBe(true);
    expect(Array.isArray(accounts.body.accounts)).toBe(true);

    const spend = await send('GET', '/mobile/spend?window=today');
    expect(spend.status).toBe(200);
    expect(spend.body.window).toMatchObject({ key: 'today', label: 'Today' });
    expect(Date.parse(spend.body.window.costSince)).toBeLessThanOrEqual(Date.parse(spend.body.window.tokensSince));
    expect(['ok', 'off', 'unavailable']).toContain(spend.body.recorded.state);
    // Wiring integrity: the phone's recorded state agrees with the server's own spend view.
    const raw = await auth(request(app).get('/routing-spend/summary?grain=day&sinceHours=24'));
    expect(spend.body.recorded.state === 'ok').toBe(raw.status === 200);
    expect(spend.body.recorded.machines[0]).toMatchObject({ isSelf: true });

    const resources = await send('GET', '/mobile/resources');
    expect(resources.status).toBe(200);
    expect(typeof resources.body.enabled).toBe('boolean');
    expect(typeof resources.body.headline).toBe('string');
    // The pooled answer is wired (resourceMachines + peerResources): with no pool it is this machine's
    // own answer; with one it carries every machine. Either way the peer read (?scope=local) answers.
    if (resources.body.scope === 'pool') expect(Array.isArray(resources.body.machines)).toBe(true);
    else expect(resources.body.machines).toBeUndefined();
    const local = await auth(request(app).get('/mobile/resources?scope=local'));
    expect(local.status).toBe(200);
    expect(local.body.machines).toBeUndefined();
    expect(typeof local.body.headline).toBe('string');
    const rawRes = await auth(request(app).get('/resources/summary'));
    expect(resources.body.enabled).toBe(rawRes.status === 200);

    // The raw Bearer routes stay closed to the phone.
    for (const p of ['/subscription-pool', '/routing-spend/summary', '/routing-spend/caps', '/tokens/summary', '/resources/summary']) {
      const res = await send('GET', p);
      expect(res.status, p).toBe(403);
      expect(res.body.error).toBe('device-not-allowed');
    }
    // The bearer token reads the same summaries.
    for (const p of ['/mobile/accounts', '/mobile/spend', '/mobile/resources']) expect((await auth(request(app).get(p))).status, p).toBe(200);
  });
});
