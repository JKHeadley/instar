/**
 * Feature-is-alive proof for browser devices (docs/specs/dashboard-conversations-browser-device.md):
 * an AgentServer booted on a development agent with NO Telegram (the dashboard approval path) — the
 * operator unlocks the dashboard with the PIN, a browser key is set up through
 * POST /mobile/browser-devices, it creates an app conversation and sends a message signed by its
 * own key, the session tag says "💻 signed", history reads `originVerified: "verified"` with
 * `originClient: "browser"`, the ledger activation row carries `client: "browser"`, a route not
 * named for browsers is refused, and the status route answers the key's state.
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
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/dashboard-conversations-browser-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'browser-e2e-'));
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
  return { server, spawned, config };
}

describe('browser devices — production wiring', () => {
  it('sets up a browser by PIN (no Telegram), sends signed, reads back verified + browser, refuses an unnamed route', async () => {
    const { server, spawned, config } = await boot();
    const app = server.getApp();
    const mp = server.mobilePairing!;
    expect(mp.nativeOn).toBe(true);
    expect(mp.browserOn()).toBe(true);
    expect(mp.approvalPath()).toBe('dashboard');
    expect(mp.keyLedger).toBe(server.appConversations!.deps.keyLedger);
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'browser-e2e');

    const status0 = await auth(request(app).get('/mobile/browser-devices/status').set('Host', HOST));
    expect(status0.status).toBe(200);
    // No Telegram owner to speak as: the page is told it cannot send into Telegram here.
    expect(status0.body).toMatchObject({ enabled: true, approvalPath: 'dashboard', telegramSend: false });
    // No Telegram owner: no private chat to name, and no paired owner phone yet (production boot path).
    expect(status0.body).toMatchObject({ approvalChat: null, ownerPhoneApproves: false });

    const unlock = await request(app).post('/dashboard/unlock').send({ pin: PIN });
    expect(unlock.status).toBe(200);
    const session = unlock.body.operatorSessionToken as string;

    const dev = makeDevice();
    const enrollmentId = `${Date.now()}-${crypto.randomUUID()}`;
    const timeMs = String(Date.now());
    const setup = await auth(request(app).post('/mobile/browser-devices').set('Host', HOST)).set('X-Instar-Operator-Session', session)
      .send({ publicKey: dev.publicKey, enrollmentId, timeMs, deviceName: 'e2e browser', proof: dev.sign(enrollProofMessage(HOST, dev.publicKey, enrollmentId, timeMs)) });
    expect(setup.status).toBe(201);
    expect(setup.body).toMatchObject({ status: 'active', approval: 'dashboard', host: HOST });
    const deviceId = setup.body.deviceId as string;
    expect(mp.keyLedger!.activationFor(deviceId)).toMatchObject({ client: 'browser', approvedVia: 'dashboard-pin' });

    const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(Date.now());
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      q.set('Host', HOST).set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.send(raw.toString()) : q;
    };
    expect((await send('GET', '/mobile/device')).body).toMatchObject({ status: 'active', client: 'browser' });

    const created = await send('POST', '/mobile/conversations', { title: 'From the dashboard', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(created.status).toBe(200);
    const key = created.body.conversationKey as string;
    const sent = await send('POST', `/mobile/chat/app/${key}`, { text: 'hello from the browser', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(sent.status).toBe(200);
    expect(spawned.some((m) => m.includes('hello from the browser') && m.includes('💻 signed'))).toBe(true);

    const history = await send('GET', `/mobile/chat/app/${key}/messages`);
    expect(history.status).toBe(200);
    const mine = (history.body.messages as Array<Record<string, unknown>>).find((m) => m.text === 'hello from the browser');
    expect(mine).toMatchObject({ originVerified: 'verified', originClient: 'browser', originApprovedVia: 'dashboard-pin', originDeviceId: deviceId });

    // A route not named for browsers (§4.4), and the switch.
    expect((await send('GET', '/mobile/devices')).body.error).toBe('browser-device-not-allowed');
    const st = await auth(request(app).get(`/mobile/browser-devices/status?keyHash=${keyHashOf(dev.publicKey)}`).set('Host', HOST));
    expect(st.body.key).toMatchObject({ state: 'active' });
    (config as unknown as { mobilePairing: { browser?: { enabled: boolean } } }).mobilePairing.browser = { enabled: false };
    expect((await send('GET', '/mobile/device')).body.error).toBe('browser-devices-off');
  });
});
