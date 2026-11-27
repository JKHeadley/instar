/**
 * Feature-is-alive proof for pairing a computer from an owner phone (docs/specs/mac-qr-pairing.md §4)
 * on the production AgentServer boot path: the device route rule is live (200, not 403/503), the code
 * is bound to the computer's key, and the owner phone's Face ID approve activates the computer.
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
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { pairingApproveLine, pairingApproveMessage } from '../../src/server/mobilePairingApproval.js';
import { ensureLifelineIngressSecret, LIFELINE_SECRET_HEADER } from '../../src/core/LifelineIngressSecret.js';

const HOST = 'echo-macqr-e2e.example.dev';
const PIN = '482913';
const OWNER = 4242;
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mac-qr-pairing-alive.test.ts' });
});

async function boot(telegram?: unknown) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'macqr-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'approve-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel, ...(telegram ? { telegram: telegram as any } : {}) });
  servers.push(server);
  const app = server.getApp();
  const mp = server.mobilePairing!;
  mp.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { app, mp, stateDir };
}

const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'approve-e2e');
async function redeemNew(app: ReturnType<AgentServer['getApp']>) {
  const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
  expect(m.status).toBe(200);
  const dev = makeDevice();
  const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
  expect(r.status).toBe(200);
  return { dev, deviceId: r.body.deviceId as string, body: r.body };
}
let lastTime = 0;
function send(app: ReturnType<AgentServer['getApp']>, dev: ReturnType<typeof makeDevice>, deviceId: string, method: 'GET' | 'POST', p: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  lastTime = Math.max(Date.now(), lastTime + 1);
  const time = String(lastTime);
  const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
  const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
  q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? q.send(raw.toString()) : q;
}

describe('Pair a computer from an owner phone — production wiring', () => {
  it('an owner phone mints a key-bound code, the computer redeems it, and Face ID approves it', async () => {
    const { app, mp } = await boot();
    // An owner phone with a presence key, approved the ordinary way.
    const phone = await redeemNew(app);
    expect(mp.approvePending(phone.deviceId, 'dashboard-pin')).toBe('approved');
    const presence = makeDevice();
    expect(mp.devices.setPresenceKey(phone.deviceId, presence.publicKey)).toBe('set');

    const mac = makeDevice();
    const m = await send(app, phone.dev, phone.deviceId, 'POST', '/mobile/pairing-codes', { forDevice: { publicKey: mac.publicKey, name: 'Studio Mac' } });
    expect(m.status).toBe(200);
    expect(m.body.link).toMatch(/^https:\/\/instar\.sh\/pair#v=1&/);
    // Another key cannot use it.
    const other = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'x', devicePublicKey: makeDevice().publicKey });
    expect(other.body.error).toBe('wrong-device');
    const m2 = await send(app, phone.dev, phone.deviceId, 'POST', '/mobile/pairing-codes', { forDevice: { publicKey: mac.publicKey, name: 'Studio Mac' } });
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m2.body.code, deviceName: 'Studio Mac', devicePublicKey: mac.publicKey, deviceKind: 'computer' });
    expect(r.status).toBe(200);
    const id = r.body.deviceId as string;
    const list = await send(app, phone.dev, phone.deviceId, 'GET', '/mobile/pairing-requests');
    const row = list.body.waiting.find((w: { deviceId: string }) => w.deviceId === id);
    expect(row).toMatchObject({ client: 'computer', canApprove: true });
    const c = await send(app, phone.dev, phone.deviceId, 'POST', `/mobile/pairing-requests/${id}/challenge`, { action: 'approve' });
    expect(c.status).toBe(200);
    const presenceSig = presence.sign(pairingApproveMessage(phone.deviceId, HOST, c.body.challenge, pairingApproveLine('approve', id, row.fingerprint)));
    const a = await send(app, phone.dev, phone.deviceId, 'POST', `/mobile/pairing-requests/${id}/approve`, { challenge: c.body.challenge, presenceSig });
    expect(a.status).toBe(200);
    expect((await send(app, mac, id, 'GET', '/mobile/device')).body.status).toBe('active');
  });
});
