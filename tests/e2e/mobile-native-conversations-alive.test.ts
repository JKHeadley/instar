/**
 * Feature-is-alive proof for native app conversations (docs/specs/mobile-native-conversations.md,
 * increment 1): an AgentServer booted on a development agent with NO Telegram and NO Slack
 * constructs the conversation service on its production path, a phone paired through the existing
 * redeem/confirm path creates a conversation, sends a signed message, the session manager
 * receives the `[app:…]`-tagged bootstrap with a bind token scoped to the conversation, the
 * session's reply through POST /app/session-reply is accepted, and history shows both.
 * Increment 2: the operator message reads `originVerified: "verified"` on a real boot (the
 * machine identity signer, the signing-key history and the device-key ledger are wired), and the
 * session tag carries "📱 signed".
 * Wiring integrity: the service, its store, the dispatch, the request store, the signer and the
 * ledger are real.
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
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';

const HOST = 'echo-native-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-native-conversations-alive.test.ts' });
});

async function boot(developmentAgent: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'native-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  // Every agent gets a machine identity at `instar init`; the receipt signer reads it.
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'native-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent,
    mobilePairing: { multiRoute: { enabled: false } }, // the single-host path; multi-route has its own e2e
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const spawned: Array<{ message: string; options: { bootstrapConversationIds?: number[] } }> = [];
  sessionManager.spawnInteractiveSession = async (message: string, _name: string | undefined, options: { bootstrapConversationIds?: number[] }) => {
    spawned.push({ message, options });
    return 'app-session-1';
  };
  sessionManager.injectMessage = () => true;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  return { server, stateDir, spawned };
}

describe('native app conversations — production wiring', () => {
  it('is alive on a development agent with no Telegram and no Slack: create, send, session tag, reply, history', async () => {
    const { server, stateDir, spawned } = await boot(true);
    const app = server.getApp();
    // Wiring integrity: real, non-null components on the production path.
    expect(server.mobilePairing).not.toBeNull();
    expect(server.mobilePairing!.nativeOn).toBe(true);
    expect(server.appConversations).not.toBeNull();
    expect(server.appConversations!.store).toBeTruthy();
    expect(server.appConversations!.deps.dispatch()).toBeTypeOf('function');
    expect(server.appConversations!.deps.requests).toBe(server.mobilePairing!.chatRequests());
    expect(server.appConversations!.deps.onEmergencyStop).toBeTypeOf('function'); // the Telegram path's stop side effects
    expect(fs.existsSync(path.join(stateDir, 'scripts', 'app-reply.sh'))).toBe(true); // boot-time relay install
    // Signed records (increment 2): the signer, the key history and the ledger are wired, and the
    // pairing service writes activations to the same ledger.
    expect(server.appConversations!.deps.signer).toBeTruthy();
    expect(server.appConversations!.deps.keyLookup).toBeTypeOf('function');
    expect(server.appConversations!.deps.keyLedger).toBeTruthy();
    expect(server.mobilePairing!.keyLedger).toBe(server.appConversations!.deps.keyLedger);

    // Pair through the existing path (mint → redeem → owner code → confirm), owner DM stubbed.
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'native-e2e');
    const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    const dev = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(r.status).toBe(200);
    const deviceId = r.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(Date.now());
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.send(raw.toString()) : q;
    };
    expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');

    // Create a native conversation and send a signed message.
    const created = await send('POST', '/mobile/conversations', { title: 'Plans', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(created.status).toBe(200);
    const key = created.body.conversationKey as string;
    const sent = await send('POST', `/mobile/chat/app/${key}`, { text: 'What is on for Saturday?', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, outcome: 'delivered' });

    // The session manager received the tagged bootstrap with a bind token scoped to the alias.
    expect(spawned).toHaveLength(1);
    const alias = spawned[0]!.options.bootstrapConversationIds![0]!;
    expect(alias).toBeLessThan(0);
    expect(spawned[0]!.message).toContain(`[app:${alias} "Plans" from Justin (📱 signed)] What is on for Saturday?`);
    // The confirm path wrote the activation to the ledger first.
    expect(server.mobilePairing!.keyLedger!.rows().map((r) => r.type)).toEqual(['activation']);

    // The session answers through app-reply.sh's route with its bind token.
    const token = createConversationBindAuth(stateDir).mint('app-session-1', [alias]);
    const reply = await auth(request(app).post('/app/session-reply')).set('X-Instar-Bind-Token', token)
      .send({ conversationId: alias, text: 'Saturday is the farmers market at nine.' });
    expect(reply.status).toBe(200);

    // History shows both, the operator message verified against the ledger and the machine receipt.
    const hist = await send('GET', `/mobile/chat/app/${key}/messages`);
    expect(hist.status).toBe(200);
    expect(hist.body.messages.map((x: { role: string; text: string }) => [x.role, x.text])).toEqual([
      ['operator', 'What is on for Saturday?'],
      ['agent', 'Saturday is the farmers market at nine.'],
    ]);
    expect(hist.body.messages[0].originVerified).toBe('verified');
    expect(hist.body.messages[1].originVerified).toBe('none');
    const health = await auth(request(app).get('/health'));
    expect(health.body.appConversations).toMatchObject({ count: 1 });

    // A ledger revocation alone refuses the phone at once on the production auth path, even if
    // the registry write after it failed (the registry still says active here).
    server.mobilePairing!.keyLedger!.recordRevocation(server.mobilePairing!.devices.get(deviceId)!, new Date().toISOString());
    expect(server.mobilePairing!.devices.get(deviceId)!.status).toBe('active');
    const refused = await send('GET', `/mobile/chat/app/${key}/messages`);
    expect(refused.status).toBe(401);
  });

  it('is off on a fleet agent: the routes answer 503', async () => {
    const { server } = await boot(false);
    expect(server.appConversations).toBeNull();
    const res = await request(server.getApp()).get('/mobile/conversations').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'native-e2e');
    expect(res.status).toBe(503);
  });
});
