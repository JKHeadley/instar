/**
 * Feature-is-alive proof for Remote Desktop with Face ID and the PIN page
 * (docs/specs/mobile-owner-presence-pin.md) on the production AgentServer path: a development agent with
 * mobile pairing on and a dashboard PIN, a phone paired through the real redeem/confirm path, its presence
 * key enrolled through the real route. Unlock answers 200 with a desktop session (routes mounted, on the
 * production device allowlist, live); the phone's signed desktop call carrying it passes the allowlist and
 * the caller binding, while the bearer carrying the same session is refused; the reveal returns the PIN
 * after a confirmed private notice that does not contain it. On a fleet config the routes answer 503.
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
import { presenceEnrollMessage } from '../../src/server/mobileConsoleTicket.js';
import { ownerPresenceMessage, DESKTOP_UNLOCK_VERSION, PIN_REVEAL_VERSION } from '../../src/server/mobileOwnerPresenceRoutes.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { allowTestIdentities } from '../helpers/allow-test-identities.js';

const HOST = 'echo-owner-presence-e2e.example.dev';
const PIN = '424242';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-owner-presence-alive.test.ts' });
});

async function boot(developmentAgent: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'owner-presence-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  allowTestIdentities(stateDir);
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'owner-presence-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent, dashboardPin: PIN,
    // A fleet agent opts into pairing itself, so only this feature's own switch is left at its default.
    mobilePairing: { multiRoute: { enabled: false }, ...(developmentAgent ? {} : { enabled: true }) },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), tunnel } as never);
  servers.push(server);
  const app = server.getApp();
  const bearer = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'owner-presence-e2e');
  server.mobilePairing!.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const dms: string[] = [];
  server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
  server.mobilePairing!.deps.telegramOwnerPresent = () => true;
  const m = await bearer(request(app).post('/mobile/pairing-codes')).send({});
  expect(m.status, JSON.stringify(m.body)).toBe(200);
  const dev = makeDevice();
  const presence = makeDevice();
  const redeemed = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
  expect(redeemed.status).toBe(200);
  const deviceId = redeemed.body.deviceId as string;
  const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
  let t = Date.now();
  const signed = (method: 'GET' | 'POST', p: string, body?: unknown, extra: Record<string, string> = {}) => {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const time = String(++t);
    const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
    let r = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
    r = r.set('Host', HOST).set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    for (const [k, v] of Object.entries(extra)) r = r.set(k, v);
    return raw ? r.send(raw.toString()) : r;
  };
  expect((await signed('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
  expect((await signed('POST', '/mobile/device/presence-key', { publicKey: presence.publicKey, proof: presence.sign(presenceEnrollMessage(deviceId, HOST, presence.publicKey)) })).status).toBe(200);
  return { app, bearer, signed, presence, deviceId, dms };
}

describe('owner presence — production wiring', () => {
  it('is alive on a development agent: unlock, a bound desktop call, and a reveal after a confirmed notice', async () => {
    const { app, bearer, signed, presence, deviceId, dms } = await boot(true);
    const ch = await signed('POST', '/mobile/desktop-unlock/challenge', {});
    expect(ch.status, JSON.stringify(ch.body)).toBe(200);
    const un = await signed('POST', '/mobile/desktop-unlock', { challenge: ch.body.challenge, presenceSig: presence.sign(ownerPresenceMessage(DESKTOP_UNLOCK_VERSION, deviceId, HOST, ch.body.challenge)) });
    expect(un.status, JSON.stringify(un.body)).toBe(200);
    const session = un.body.operatorSessionToken as string;
    // The phone's signed desktop call passes the allowlist and the binding (whatever the desktop itself answers here).
    const mine = await signed('GET', '/desktop/targets', undefined, { 'X-Instar-Operator-Session': session });
    expect([401, 403]).not.toContain(mine.status);
    // The same session on the bearer is refused by the caller binding.
    expect((await bearer(request(app).get('/desktop/targets')).set('X-Instar-Operator-Session', session)).status).toBe(403);
    // The PIN, after a notice that doesn't contain it.
    const before = dms.length;
    const pc = await signed('POST', '/mobile/dashboard-pin/challenge', {});
    const rv = await signed('POST', '/mobile/dashboard-pin/reveal', { challenge: pc.body.challenge, presenceSig: presence.sign(ownerPresenceMessage(PIN_REVEAL_VERSION, deviceId, HOST, pc.body.challenge)) });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    expect(rv.body.pin).toBe(PIN);
    expect(dms.length).toBe(before + 1);
    expect(dms[dms.length - 1]).not.toContain(PIN);
  });

  it('is dark on a fleet agent', async () => {
    const { signed } = await boot(false);
    const r = await signed('POST', '/mobile/desktop-unlock/challenge', {});
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('owner-presence-off');
  });
});
