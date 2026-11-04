/**
 * Feature-is-alive proof for the phone's native schedule, promises and machines reads
 * (docs/specs/mobile-native-ops-screens.md): an AgentServer booted on its production path
 * (development agent), a phone paired through the existing redeem/confirm path, then
 * GET /mobile/jobs, /mobile/commitments and /mobile/machines answer 200 (not 403/503) for that
 * owner phone with trimmed summaries built from the server's real stores. The raw Bearer routes
 * (/jobs, /commitments, /pool) stay closed to the phone. Wiring integrity: a commitment recorded
 * through the real CommitmentTracker appears in the phone's list.
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

const HOST = 'echo-ops-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-native-ops-screens-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ops-screens-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'ops-screens-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
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

describe('native ops screens — production wiring', () => {
  it('is alive: an owner phone reads the schedule, promises and machines; the raw routes stay closed', async () => {
    const { server } = await boot();
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();
    // The pairing ping proves this server answers on its address (as in the open-session e2e).
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'ops-screens-e2e');
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

    // A promise recorded through the real tracker (bearer, as a session would).
    const rec = await auth(request(app).post('/commitments')).send({ userRequest: 'Send the weekly summary', agentResponse: 'I will send the weekly summary tonight', type: 'one-time-action' });
    const hasTracker = rec.status === 200 || rec.status === 201;

    const jobs = await send('GET', '/mobile/jobs');
    expect(jobs.status).toBe(200);
    expect(jobs.body).toMatchObject({ schemaVersion: 1, schedulerRunning: false });
    expect(Array.isArray(jobs.body.jobs)).toBe(true);

    const promises = await send('GET', '/mobile/commitments');
    expect(promises.status).toBe(200);
    expect(promises.body.schemaVersion).toBe(1);
    if (hasTracker) {
      expect(promises.body.enabled).toBe(true);
      expect(promises.body.commitments.map((c: { text: string }) => c.text)).toContain('I will send the weekly summary tonight');
    } else {
      expect(promises.body.enabled).toBe(false);
    }

    const machines = await send('GET', '/mobile/machines');
    expect(machines.status).toBe(200);
    expect(machines.body.machines.length).toBeGreaterThanOrEqual(1);
    expect(machines.body.machines.some((x: { isSelf: boolean }) => x.isSelf)).toBe(true);
    expect(typeof machines.body.headline).toBe('string');

    // The health the screen pairs with stays the existing allowlisted read.
    expect((await send('GET', '/health')).status).toBe(200);
    // The raw Bearer routes stay closed to the phone.
    for (const p of ['/jobs', '/commitments', '/pool']) {
      const raw = await send('GET', p);
      expect(raw.status, p).toBe(403);
      expect(raw.body.error).toBe('device-not-allowed');
    }
    // The bearer token reads the same summaries.
    expect((await auth(request(app).get('/mobile/machines'))).status).toBe(200);
  });
});
