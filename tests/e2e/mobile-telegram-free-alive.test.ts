/**
 * Feature-is-alive proof for pairing and push WITHOUT Telegram (docs/specs/mobile-native-
 * conversations.md §4.4, §4.7 — increment 3, and the spec's E2E): an AgentServer booted on a
 * development agent with NO Telegram and NO Slack. The operator unlocks the dashboard with the
 * PIN (a real operator session), a phone redeems a pairing link and is told to confirm on the
 * dashboard, the dashboard's operator-only route shows the code, the phone confirms with it
 * (`approvedVia: "dashboard-pin"`), registers for push, creates a conversation and sends a signed
 * message; the session's `app-reply.sh` answer is accepted, a push goes out for it, and history
 * shows both with `originVerified: "verified"` and the dashboard approval method.
 * Wiring integrity: the push service is the real one built on the production path; the app
 * conversation service's push hook delegates to it.
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
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { MobilePushService } from '../../src/core/MobilePush.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';

const HOST = 'echo-notelegram-e2e.example.dev';
const PIN = '482913';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-telegram-free-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'notg-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'notg-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
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
  // No `telegram` option at all: this agent has no Telegram.
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  return { server, stateDir, spawned };
}

describe('pairing and push without Telegram — production wiring', () => {
  it('pairs through the dashboard, chats, and pushes the reply on an agent with no Telegram', async () => {
    const { server, stateDir, spawned } = await boot();
    const app = server.getApp();
    const mp = server.mobilePairing!;
    // Wiring integrity: real components, no Telegram anywhere.
    expect(mp).not.toBeNull();
    expect(mp.nativeOn).toBe(true);
    expect(mp.deps.ownerDM).toBeTypeOf('function'); // built, but it has no adapter to send through
    expect(mp.deps.telegramOwnerPresent!()).toBe(false);
    expect(mp.approvalPath()).toBe('dashboard');
    expect(mp.push).toBeInstanceOf(MobilePushService);
    expect(server.appConversations!.pushHook).toBeTypeOf('function');

    mp.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'notg-e2e');

    // 1. The operator unlocks the dashboard with the PIN: a real operator session.
    const unlock = await request(app).post('/dashboard/unlock').send({ pin: PIN });
    expect(unlock.status).toBe(200);
    const session = unlock.body.operatorSessionToken as string;
    expect(session).toBeTruthy();

    // 2. Mint a link; the phone redeems and is told to confirm on the dashboard.
    const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const dev = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'pending', approval: 'dashboard' });
    const deviceId = r.body.deviceId as string;

    // 3. The code is on the dashboard only behind the operator session.
    expect((await auth(request(app).get('/mobile/pairing-approvals'))).status).toBe(403);
    const approvals = await auth(request(app).get('/mobile/pairing-approvals')).set('X-Instar-Operator-Session', session);
    expect(approvals.status).toBe(200);
    expect(approvals.body.approvals).toHaveLength(1);
    const code = approvals.body.approvals[0].code as string;
    expect(code).toMatch(/^\d{6}$/);

    let lastTime = 0;
    const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      lastTime = Math.max(Date.now(), lastTime + 1);
      const time = String(lastTime);
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.send(raw.toString()) : q;
    };
    expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
    expect(mp.devices.get(deviceId)!.approvedVia).toBe('dashboard-pin');
    expect(mp.keyLedger!.rows().find((row) => row.type === 'activation')).toMatchObject({ approvedVia: 'dashboard-pin' });

    // 4. The phone registers for push through the real route.
    const reg = await send('POST', '/mobile/device/push', { token: 'c'.repeat(64), environment: 'sandbox', notifyTokenHash: 'd'.repeat(64), revision: 1 });
    expect(reg.status).toBe(200);

    // The production push service has no APNs key in this throwaway vault. Swap in one with a
    // recording transport over the SAME device registry, so the real hook → service → APNs path
    // is exercised end to end (the hook reads `pairing.push` at call time).
    const apns: Array<Record<string, any>> = [];
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    mp.push = new MobilePushService({
      stateDir, registry: mp.devices, agentId: 'notg-e2e', agentName: 'Notg-e2e', machineId: 'local', enabled: () => true,
      credentials: () => ({ keyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), keyId: 'K1', teamId: 'T1' }),
      transport: async (_env, _token, _headers, body) => { apns.push(JSON.parse(body)); return { status: 200 }; },
    });

    // 5. Create a conversation, send a signed message, the session answers.
    const created = await send('POST', '/mobile/conversations', { title: 'Plans', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(created.status).toBe(200);
    const key = created.body.conversationKey as string;
    const sent = await send('POST', `/mobile/chat/app/${key}`, { text: 'What is on for Saturday?', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(sent.status).toBe(200);
    expect(spawned).toHaveLength(1);
    const alias = Number(/\[app:(-\d+) /.exec(spawned[0]!)![1]);
    expect(spawned[0]).toContain('(📱 signed)] What is on for Saturday?');
    const token = createConversationBindAuth(stateDir).mint('app-session-1', [alias]);
    const reply = await auth(request(app).post('/app/session-reply')).set('X-Instar-Bind-Token', token)
      .send({ conversationId: alias, text: 'Saturday is the farmers market at nine.' });
    expect(reply.status).toBe(200);

    // 6. The reply produced exactly one push naming the conversation, without its text.
    await new Promise((res) => setTimeout(res, 50));
    expect(apns).toHaveLength(1);
    expect(apns[0]!.aps.alert.body).toBe('New reply');
    expect(apns[0]!.instar).toMatchObject({ kind: 'reply', conversationKey: key, deviceId });
    expect(JSON.stringify(apns[0])).not.toContain('farmers market');

    // 7. History shows both, the operator message verified with the dashboard approval method.
    const hist = await send('GET', `/mobile/chat/app/${key}/messages`);
    expect(hist.status).toBe(200);
    expect(hist.body.messages.map((x: { role: string }) => x.role)).toEqual(['operator', 'agent']);
    expect(hist.body.messages[0].originVerified).toBe('verified');
    expect(hist.body.messages[0].originApprovedVia).toBe('dashboard-pin');
  });
});
