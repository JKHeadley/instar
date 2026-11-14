/**
 * Feature-is-alive proof for the phone's native Passwords & keys screen
 * (docs/specs/mobile-native-secrets.md): an AgentServer booted on its production path, a phone paired
 * through the existing redeem/confirm path, then GET /mobile/secrets answers 200 (not 403/503) built from
 * the server's real wiring; a real Secret Drop request reaches the phone without its token; the raw routes
 * stay closed to the phone; and the bearer reads the same summary.
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

const HOST = 'echo-secrets-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-native-secrets-alive.test.ts' });
});

async function boot(developmentAgent = true) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'secrets-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'secrets-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, getExternalUrl: (p: string) => `https://${HOST}${p}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), tunnel });
  servers.push(server);
  return { server, stateDir };
}

describe('native passwords and keys screen — production wiring', () => {
  it('is alive: an owner phone reads passwords and keys', async () => {
    const { server, stateDir } = await boot();
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'secrets-e2e');
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

    // A real Secret Drop request reaches the phone by label, without its token.
    const asked = await auth(request(app).post('/secrets/request')).send({ label: 'E2E key', fields: [{ name: 'value', label: 'Value', masked: true }] });
    expect(asked.status, JSON.stringify(asked.body)).toBeLessThan(300);
    const pending = await auth(request(app).get('/secrets/pending'));
    const token = pending.body.pending[0].token as string;
    const secrets = await phone.send('GET', '/mobile/secrets');
    expect(secrets.status).toBe(200);
    expect(secrets.body).toMatchObject({ schemaVersion: 1, state: 'ok', requests: { state: 'ok', waitingCount: 1 } });
    expect(secrets.body.requests.waiting[0].label).toBe('E2E key');
    expect(JSON.stringify(secrets.body)).not.toContain(token);
    // Wiring integrity: the key section agrees with the server's own raw route.
    const raw = await auth(request(app).get('/self-knowledge/session-context?full=1'));
    expect(raw.status).toBe(200);
    expect(secrets.body.keys.state).toBe(raw.body.vaultState === 'decrypt-failed' ? 'decrypt-failed' : 'ok');

    // The raw routes stay closed to the phone.
    for (const p of ['/secrets/pending', '/secrets/sync-status', '/self-knowledge/session-context']) {
      const res = await phone.send('GET', p);
      expect(res.status, p).toBe(403);
      expect(res.body.error).toBe('device-not-allowed');
    }
    // The bearer token reads the same summary.
    expect((await auth(request(app).get('/mobile/secrets'))).status).toBe(200);
  });

  it('off the dev-agent gate with no Secret Sync, the key list says off and the route still answers', async () => {
    const { server } = await boot(false);
    const app = server.getApp();
    const r = await request(app).get('/mobile/secrets').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'secrets-e2e');
    expect(r.status).toBe(200);
    expect(r.body.keys.state).toBe('off');
    expect(r.body.headline).toContain('off on this agent');
  });
});
