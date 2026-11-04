/**
 * Feature-is-alive proof for the phone's native Phones, Messages to you and Insights screens
 * (docs/specs/mobile-native-phones-messages.md): an AgentServer booted on its production path
 * (development agent), two phones paired through the existing redeem/confirm path, then
 * GET /mobile/messages and /mobile/insights answer 200 (not 403/503) for the owner phone, built from
 * the server's real wiring; the insight state agrees with the server's own /insights route; the raw
 * routes stay closed to the phone; the bearer reads the same summaries; and the owner phone lists the
 * phones and removes the second one, which is then refused.
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
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';

const HOST = 'echo-phones-messages-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-native-phones-messages-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'phones-messages-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'phones-messages-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), tunnel });
  servers.push(server);
  return { server };
}

describe('native phones, messages and insights screens — production wiring', () => {
  it('is alive: an owner phone reads messages and insights, lists phones and removes another one', async () => {
    const { server } = await boot();
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'phones-messages-e2e');
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
    let t = Date.now();
    const pairPhone = async (name: string) => {
      const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
      expect(m.status).toBe(200);
      const dev = makeDevice();
      const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: name, devicePublicKey: dev.publicKey });
      expect(r.status).toBe(200);
      const deviceId = r.body.deviceId as string;
      const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
        const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const time = String(++t);
        const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
        const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
        q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
        return raw ? q.send(raw.toString()) : q;
      };
      const code = /is (\d{3}) (\d{3})\./.exec(dms[dms.length - 1]!)!.slice(1).join('');
      expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
      return { deviceId, send };
    };
    const phone = await pairPhone('e2e phone');
    const other = await pairPhone('second phone');

    const messages = await phone.send('GET', '/mobile/messages');
    expect(messages.status).toBe(200);
    expect(messages.body).toMatchObject({ schemaVersion: 1 });
    expect(['ok', 'off', 'unavailable']).toContain(messages.body.state);
    expect(typeof messages.body.headline).toBe('string');

    const insights = await phone.send('GET', '/mobile/insights');
    expect(insights.status).toBe(200);
    // Wiring integrity: the phone's insight state agrees with the server's own route.
    const rawInsights = await auth(request(app).get('/insights'));
    expect(insights.body.selfState === 'off').toBe(rawInsights.status === 503);

    // The raw routes stay closed to the phone.
    for (const p of ['/telegram/origins/status', '/telegram/origins', '/telegram/origin-display', '/insights']) {
      const res = await phone.send('GET', p);
      expect(res.status, p).toBe(403);
      expect(res.body.error).toBe('device-not-allowed');
    }
    // The bearer token reads the same summaries.
    for (const p of ['/mobile/messages', '/mobile/insights']) expect((await auth(request(app).get(p))).status, p).toBe(200);

    // Phones: the owner phone lists both and removes the second one.
    const list = await phone.send('GET', '/mobile/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.map((d: { id: string }) => d.id)).toEqual(expect.arrayContaining([phone.deviceId, other.deviceId]));
    const removed = await phone.send('POST', `/mobile/devices/${other.deviceId}/revoke`, {});
    expect(removed.status).toBe(200);
    expect(removed.body.revoked).toBe(true);
    expect((await other.send('GET', '/mobile/devices')).status).toBe(401);
    expect((await phone.send('GET', '/mobile/devices')).status).toBe(200);
  });
});
