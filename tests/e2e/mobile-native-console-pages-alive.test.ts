/**
 * Feature-is-alive proof for the phone's native console pages and file browser
 * (docs/specs/mobile-native-console-pages.md): an AgentServer booted on its production path and listening,
 * a phone paired through the existing redeem/confirm path, then the routes answer for the owner phone
 * through the real loopback read; a file on disk reaches the phone; secret-shaped and blocked files do not;
 * each page's state agrees with the console route; and the raw routes stay closed to the phone.
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

const HOST = 'echo-console-pages-e2e.example.dev';
const servers: AgentServer[] = [];
const closers: Array<{ close(): void }> = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const c of closers) c.close();
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-native-console-pages-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'console-pages-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'console-pages-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
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
  return { server, stateDir, dir, config };
}

const stateDir = (dir: string): string => path.join(dir, '.instar');

describe('native console pages — production wiring', () => {
  it('is alive: an owner phone reads the pages and a file', async () => {
    const { server, dir, config: configRef } = await boot();
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'console-pages-e2e');
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

    // Real wiring: the routes read the console's own answers over this server's loopback.
    const listener = app.listen(0);
    closers.push(listener);
    configRef.port = (listener.address() as { port: number }).port;

    fs.writeFileSync(path.join(dir, 'notes.md'), 'Hello from the disk\n');
    fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'keys', 'a.txt'), 'hidden');
    fs.writeFileSync(path.join(dir, '.env'), 'NEVER=1');
    fs.writeFileSync(path.join(stateDir(dir), 'credential-locations.json'), '{"hidden":"from-phone"}');
    fs.symlinkSync(path.join(stateDir(dir), 'credential-locations.json'), path.join(dir, 'link.md'));
    fs.symlinkSync('/etc/hosts', path.join(dir, 'outside.md'));
    const folder = await phone.send('GET', '/mobile/files');
    expect(folder.status).toBe(200);
    expect(folder.body.state).toBe('ok');
    const names = folder.body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('notes.md');
    expect(names).not.toContain('keys');
    expect(names).not.toContain('.env');
    expect(names).not.toContain('link.md');
    expect(names).not.toContain('outside.md');
    for (const p of ['link.md', 'outside.md']) {
      const refused = await phone.send('GET', `/mobile/files/read?path=${p}`);
      expect(refused.body.state, p).toBe('refused');
      expect(JSON.stringify(refused.body)).not.toContain('from-phone');
    }
    const file = await phone.send('GET', '/mobile/files/read?path=notes.md');
    expect(file.body).toMatchObject({ state: 'ok', text: 'Hello from the disk\n', cut: false });
    fs.writeFileSync(path.join(dir, 'data.json'), '{"value":"stays-on-the-machine"}');
    const data = await phone.send('GET', '/mobile/files/read?path=data.json');
    expect(data.body).toMatchObject({ state: 'console-only', line: 'Open this one in the console.' });
    expect(JSON.stringify(data.body)).not.toContain('stays-on-the-machine');
    expect((await phone.send('GET', '/mobile/files/read?path=keys%2Fa.txt')).body.state).toBe('refused');
    expect((await phone.send('GET', '/mobile/files/read?path=.env')).body.state).not.toBe('ok');
    expect((await phone.send('GET', '/mobile/files/read?path=..%2F..%2Fetc%2Fpasswd')).body.state).toBe('refused');

    // Each page's state agrees with the console route it mirrors.
    for (const [p, raw] of [['/mobile/ideas', '/ecosystem-ideas'], ['/mobile/pace', '/queue-pace'], ['/mobile/maturation', '/maturation/board']] as const) {
      const page = await phone.send('GET', p);
      expect(page.status, p).toBe(200);
      const source = await auth(request(app).get(raw));
      expect(page.body.state === 'off', p).toBe(source.status === 503);
      expect(page.body.state === 'ok', p).toBe(source.status === 200);
    }
    expect((await phone.send('GET', '/mobile/development')).status).toBe(200);

    // The raw routes stay closed to the phone.
    for (const p of ['/ecosystem-ideas', '/queue-pace', '/maturation/board', '/green-pr-automerge', '/local-verify', '/api/files/list', '/api/files/read?path=notes.md']) {
      const res = await phone.send('GET', p);
      expect(res.status, p).toBe(403);
      expect(res.body.error).toBe('device-not-allowed');
    }
    expect((await auth(request(app).get('/mobile/pace'))).status).toBe(200);
  });
});
