/**
 * Conversation-list pins are alive in a production-booted AgentServer (docs/specs/conversation-list-pins.md):
 * built with no list-pin store passed (the server builds a local one), an owner phone pins a conversation
 * through POST /mobile/conversations/pins, and the owner's dashboard browser (a separate device, the same
 * person) sees it in pinnedRefs and pinnedRows of GET /mobile/conversations. Returns 200, not 503.
 */
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
import { canonicalString, keyHashOf } from '../../src/core/MobileDeviceKeys.js';
import { enrollProofMessage } from '../../src/server/mobileBrowserDevices.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';

const HOST = 'echo-browser-e2e.example.dev';
const PIN = '482915';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/conversation-list-pins-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'listpins-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'browser-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const spawned: string[] = [];
  sessionManager.spawnInteractiveSession = async (message: string) => { spawned.push(message); return 'app-session-1'; };
  sessionManager.injectMessage = () => true;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  return { server, spawned, config, stateDir };
}

describe('conversation-list pins — production wiring', () => {
  it('a phone pins a conversation and the same person\'s browser sees it pinned', async () => {
    const { server } = await boot();
    const app = server.getApp();
    const mp = server.mobilePairing!;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'browser-e2e');
    const phone = makeDevice();
    const c = mp.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: phone.publicKey, host: HOST });
    if (!c.ok) throw new Error('phone pending');
    mp.keyLedger!.recordActivation(c.device, 'dashboard-pin', new Date().toISOString());
    mp.devices.applyConfirm(c.device.id, { ok: true, approvedVia: 'dashboard-pin' });
    const unlock = await request(app).post('/dashboard/unlock').send({ pin: PIN });
    const browser = makeDevice();
    const enrollmentId = `${Date.now()}-${crypto.randomUUID()}`;
    const timeMs = String(Date.now());
    const setup = await auth(request(app).post('/mobile/browser-devices').set('Host', HOST)).set('X-Instar-Operator-Session', unlock.body.operatorSessionToken)
      .send({ publicKey: browser.publicKey, enrollmentId, timeMs, deviceName: 'e2e browser', proof: browser.sign(enrollProofMessage(HOST, browser.publicKey, enrollmentId, timeMs)) });
    expect(setup.status).toBe(201);
    const signed = (dev: ReturnType<typeof makeDevice>, id: string) => (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(Date.now() + Math.floor(Math.random() * 1000));
      const sig = dev.sign(canonicalString(id, HOST, method, p, time, raw));
      const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      q.set('Host', HOST).set('X-Instar-Device', id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.send(raw.toString()) : q;
    };
    const asPhone = signed(phone, c.device.id);
    const asBrowser = signed(browser, setup.body.deviceId as string);
    const created = await asPhone('POST', '/mobile/conversations', { title: 'Keep on top', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    const key = created.body.conversationKey as string;
    const pin = await asPhone('POST', '/mobile/conversations/pins', { ref: `app:${key}`, pinned: true });
    expect(pin.status).toBe(200);
    expect(pin.body).toMatchObject({ ok: true, changed: true });
    const list = await asBrowser('GET', '/mobile/conversations?scope=pool&limit=50');
    expect(list.status).toBe(200);
    expect(list.body.pinnedRefs.map((p: { ref: string }) => p.ref)).toEqual([`app:${key}`]);
    expect(list.body.pinnedRows).toMatchObject([{ id: key, platform: 'app', title: 'Keep on top' }]);
    // The browser unpins through the same route (open to browser devices).
    expect((await asBrowser('POST', '/mobile/conversations/pins', { ref: `app:${key}`, pinned: false })).body).toMatchObject({ ok: true, changed: true, pinned: [] });
    expect((await asPhone('GET', '/mobile/conversations')).body.pinnedRefs).toEqual([]);
  });
});
