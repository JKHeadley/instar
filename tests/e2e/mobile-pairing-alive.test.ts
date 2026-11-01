/** Production-path proof (docs/specs/mobile-pairing-link.md): AgentServer constructs the mobile
 * pairing service, registers the public redeem/ping before the bearer gate and the mint/devices
 * routes behind it, gated by the development-agent gate. Wiring integrity: the service is real
 * (not null), reads the live config, and a real mint → redeem round trip works through the
 * server's own app. */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
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

const HOST = 'echo-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

async function boot(developmentAgent: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mp-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const config = {
    projectName: 'mp-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent,
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  return server;
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-pairing-alive.test.ts' });
});

describe('mobile pairing — production wiring', () => {
  it('is alive on a development agent: a real mint → redeem round trip through the server', async () => {
    const server = await boot(true);
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();
    // The named tunnel delivers self-probes to this same server; route them through the app.
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const m = await request(app).post('/mobile/pairing-codes').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'mp-e2e').send({});
    expect(m.status).toBe(200);
    expect(m.body.link).toContain('https://instar.sh/pair#v=1&o=');
    // The link names the agent (config.projectName), so the phone can show "Pair with mp-e2e?".
    expect(m.body.link).toContain('&n=mp-e2e');
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    const dev = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeUndefined();
    const deviceId = r.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0])!.slice(1).join('');
    const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(Date.now());
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.send(raw.toString()) : q;
    };
    // The device authenticator is wired into the production auth middleware.
    expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
    expect((await send('GET', '/sessions')).status).toBe(200);
    // The conversation list's recency read is on the device allowlist (not refused for a device).
    expect([401, 403]).not.toContain((await send('GET', '/topic/list')).status);
    const d = await request(app).get('/mobile/devices').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'mp-e2e');
    expect(d.body.devices[0]).toMatchObject({ deviceName: 'e2e phone', status: 'active' });
    // Operator chat (mobile-operator-chat): the device-only route is mounted and its inbound core is
    // wired (ctx.mobileInbound is real); with no Telegram owner on this boot it answers 503 by name.
    const rid = `${Date.now()}-${crypto.randomUUID()}`;
    const chat = await send('POST', '/mobile/chat/1', { text: 'hello', requestId: rid });
    expect(chat.status).toBe(503);
    expect(chat.body.error).toBe('chat-unavailable');
    const bearer = await request(app).post('/mobile/chat/1').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'mp-e2e').send({ text: 'x', requestId: rid });
    expect(bearer.body.error).toBe('operator-device-required');
  });

  it('is off on a fleet agent: 503', async () => {
    const server = await boot(false);
    const res = await request(server.getApp()).post('/mobile/pairing-codes').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'mp-e2e').send({});
    expect(res.status).toBe(503);
  });
});
