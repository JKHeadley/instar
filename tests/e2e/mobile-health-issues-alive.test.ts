/**
 * Feature-is-alive proof for the owner's health reading (docs/specs/mobile-health-issues.md): an AgentServer
 * booted on its production path and listening, a phone paired through the real path, then
 * GET /mobile/health-issues answers 200 for that phone, built from this server's real /health over loopback
 * and the real DegradationReporter. /health keeps its shape: `degraded` stays, and this route only explains it.
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
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { HEALTH_READ_CACHE_MS } from '../../src/server/mobileHealthRoutes.js';

const HOST = 'echo-health-issues-e2e.example.dev';
const servers: AgentServer[] = [];
const closers: Array<{ close(): void }> = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const c of closers) c.close();
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-health-issues-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'health-issues-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'health-issues-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
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

describe('owner health reading — production wiring', () => {
  it('is alive: an owner phone reads what degraded means', async () => {
    const { server, dir, config: configRef } = await boot();
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'health-issues-e2e');
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

    const reporter = DegradationReporter.getInstance();
    const r1 = await phone.send('GET', '/mobile/health-issues');
    expect(r1.status).toBe(200);
    expect(r1.body.schemaVersion).toBe(1);
    expect(['healthy', 'running', 'unsure', 'attention']).toContain(r1.body.verdict);

    // Wiring: an event through the real reporter reaches the phone, sorted by the table.
    reporter.report({ feature: 'GitSync.gitHygiene', primary: 'p', fallback: 'Using the last copy', reason: 'r', impact: 'A sync was late.' });
    await new Promise((r) => setTimeout(r, HEALTH_READ_CACHE_MS + 100));
    const r2 = await phone.send('GET', '/mobile/health-issues');
    expect(r2.status).toBe(200);
    const row = r2.body.issues.find((i: { id: string }) => i.id === 'GitSync.gitHygiene');
    expect(row).toMatchObject({ impact: 'internal', title: 'Some files were kept out of sync on purpose' });
    expect(row.ask).toContain('GitSync.gitHygiene');
    expect(r2.body.verdict).not.toBe('healthy');

    // /health is unchanged: it still says degraded for the same event.
    const health = await request(app).get('/health');
    expect(health.body.status).toBe('degraded');
    expect(health.body).not.toHaveProperty('verdict');

    // The console's bearer reads the same answer; no credentials means no answer.
    expect((await auth(request(app).get('/mobile/health-issues'))).status).toBe(200);
    expect((await request(app).get('/mobile/health-issues')).status).toBe(401);
  }, 60000);
});
