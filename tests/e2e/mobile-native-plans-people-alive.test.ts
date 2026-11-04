/**
 * Feature-is-alive proof for the phone's native Plans, What I've learned about you and Other agents
 * reads (docs/specs/mobile-native-plans-people.md): an AgentServer booted on its production path
 * (development agent), a phone paired through the existing redeem/confirm path, then
 * GET /mobile/plans, /mobile/learned and /mobile/agents answer 200 (not 403/503) for that owner
 * phone, built from the server's real wiring. An initiative created through the real tracker shows
 * up; the channel rows match /channels one for one. The raw Bearer routes stay closed to the phone;
 * the bearer token reads the same summaries.
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

const HOST = 'echo-plans-people-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-native-plans-people-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'plans-people-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'plans-people-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const initiativeTracker = new InitiativeTracker(stateDir);
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker, tunnel });
  servers.push(server);
  return { server, initiativeTracker };
}

describe('native plans and people screens — production wiring', () => {
  it('is alive: an owner phone reads plans, learned and agents; the raw routes stay closed', async () => {
    const { server, initiativeTracker } = await boot();
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'plans-people-e2e');
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

    await initiativeTracker.create({ id: 'e2e-plan', title: 'Phone screens proof', description: 'e2e', phases: [{ id: 'p1', name: 'Build' }] });
    const plans = await send('GET', '/mobile/plans');
    expect(plans.status).toBe(200);
    expect(plans.body).toMatchObject({ schemaVersion: 1, enabled: true, selfState: 'ok' });
    const rows = [...plans.body.sections.needsYou, ...plans.body.sections.inFlight, ...plans.body.sections.idle];
    expect(rows.map((p: { title: string }) => p.title)).toContain('Phone screens proof');
    expect(JSON.stringify(plans.body)).not.toContain('e2e-plan');

    const learned = await send('GET', '/mobile/learned');
    expect(learned.status).toBe(200);
    expect(typeof learned.body.headline).toBe('string');
    // Wiring integrity: the phone's preference state agrees with the server's own route.
    const rawPrefs = await auth(request(app).get('/preferences/session-context'));
    expect(learned.body.preferences.state === 'off').toBe(rawPrefs.status === 503);

    const agents = await send('GET', '/mobile/agents');
    expect(agents.status).toBe(200);
    const rawChannels = await auth(request(app).get('/channels'));
    expect(rawChannels.status).toBe(200);
    expect(agents.body.channels.map((c: { key: string }) => c.key)).toEqual(rawChannels.body.channels.map((c: { id: string }) => c.id));
    expect(agents.body.channelSummary).toEqual(rawChannels.body.summary);

    // The raw Bearer routes stay closed to the phone.
    for (const p of ['/initiatives', '/projects', '/preferences/session-context', '/corrections', '/channels']) {
      const res = await send('GET', p);
      expect(res.status, p).toBe(403);
      expect(res.body.error).toBe('device-not-allowed');
    }
    // The bearer token reads the same summaries.
    for (const p of ['/mobile/plans', '/mobile/learned', '/mobile/agents']) expect((await auth(request(app).get(p))).status, p).toBe(200);
  });
});
