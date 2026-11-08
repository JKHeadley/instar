/**
 * Feature-is-alive proof for Slack conversations from the app (docs/specs/mobile-native-
 * conversations.md §4.9 — increment 4): an AgentServer built on the production path for a
 * development agent with Slack configured (a stub adapter: nothing reaches real Slack) and NO
 * Telegram. A phone pairs through the dashboard path, sees the Slack channel in its conversation
 * list, sends a signed message into it, the server's Slack inbound dispatch (the option server.ts
 * wires) receives it as the operator tagged "signed", the mirror is posted into the channel, the
 * agent's reply through the Slack reply route lands in the log, and the phone's history shows the
 * Slack message, its own message ("verified") and the reply.
 * Wiring integrity: the Slack routes answer 200 (not 503), the bridge delegates to the real
 * dispatch option and the real adapter, and the list carries the registry's minted id.
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
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig, Message } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';

const HOST = 'echo-slack-e2e.example.dev';
const PIN = '583014';
const OWNER = 'U0OWNER1';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-slack-from-app-alive.test.ts' });
});

async function boot(ownerId: string | null) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'slack-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'slack-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
    mobilePairing: { multiRoute: { enabled: false }, ...(ownerId ? { slackOwnerUserId: ownerId } : {}) },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const registry = new ConversationRegistry({ stateDir, machineId: () => 'local', isRecordingEnabled: () => true });
  const conversationId = registry.mintForInbound('C0E2ECHAN').id!;

  // A stub Slack adapter: the methods the server uses, recording instead of calling Slack.
  const logPath = path.join(stateDir, 'slack-messages.jsonl');
  const posted: Array<{ channelId: string; text: string }> = [];
  const slack = {
    // A second person's message, seen in the channel but never logged (fb-4db533fa-9d9).
    getChannelMessages: () => [{ ts: '1730000000.000900', user: 'U0E2EGEAR', text: 'second person here' }],
    cachedUserName: (u: string) => (u === 'U0E2EGEAR' ? 'Gear Test' : null),
    cachedChannelName: (c: string) => (c === 'C0E2ECHAN' ? 'e2e-channel' : null),
    getBotUserId: () => 'UBOT',
    getLogPath: () => logPath,
    logMessage: (e: Record<string, unknown>) => fs.appendFileSync(logPath, `${JSON.stringify({ ...e, timestamp: new Date().toISOString(), platform: 'slack' })}\n`),
    sendToChannel: async (channelId: string, text: string) => { posted.push({ channelId, text }); return `${Math.floor(Date.now() / 1000)}.000${posted.length}00`; },
    getSessionForChannel: () => null,
    isAuthorized: (u: string) => u === OWNER,
    resolveRoutingKey: (c: string) => c,
    onMessageLogged: null,
    trackPromise: undefined,
  };
  const dispatched: Message[] = [];
  const server = new AgentServer({
    config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel,
    conversationRegistry: registry, slack: slack as any,
    slackInboundDispatch: () => async (m) => { dispatched.push(m); return 'delivered'; },
  });
  servers.push(server);
  return { server, stateDir, logPath, posted, dispatched, conversationId };
}

async function pairPhone(app: ReturnType<AgentServer['getApp']>, server: AgentServer) {
  const mp = server.mobilePairing!;
  mp.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'slack-e2e');
  const session = (await request(app).post('/dashboard/unlock').send({ pin: PIN })).body.operatorSessionToken as string;
  const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
  const dev = makeDevice();
  const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
  const deviceId = r.body.deviceId as string;
  const code = (await auth(request(app).get('/mobile/pairing-approvals')).set('X-Instar-Operator-Session', session)).body.approvals[0].code as string;
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
  return { send, auth };
}

describe('Slack from the app — production wiring', () => {
  it('lists, sends, dispatches, mirrors and reads back a Slack conversation from the phone', async () => {
    const { server, posted, dispatched, conversationId } = await boot(OWNER);
    const app = server.getApp();
    const { send, auth } = await pairPhone(app, server);

    // The list carries the registry's minted Slack conversation.
    const list = await send('GET', '/mobile/conversations');
    expect(list.status).toBe(200);
    // Titled with the channel's Slack name, not its id (fb-4db533fa-9d9).
    expect(list.body.conversations).toEqual([expect.objectContaining({ id: conversationId, platform: 'slack', title: '#e2e-channel' })]);
    // Every Slack request names the machine its row came from.
    const machine = list.body.conversations[0].machine as string;
    expect(machine).toBe(server.appConversations!.deps.machineId());

    // A signed send reaches the server's Slack dispatch as the operator, tagged signed.
    const sent = await send('POST', `/mobile/chat/slack/${conversationId}`, { machine, text: 'Can you post the release notes?', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, outcome: 'delivered', mirror: 'sent' });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ userId: OWNER, content: 'Can you post the release notes?', channel: { type: 'slack', identifier: 'C0E2ECHAN' } });
    expect(dispatched[0]!.metadata).toMatchObject({ senderName: 'Justin', appOrigin: 'verified' });
    expect(posted).toEqual([{ channelId: 'C0E2ECHAN', text: '📱 Justin (from the app): Can you post the release notes?' }]);

    // The agent answers through the Slack reply route; its reply is kept in the log.
    const reply = await auth(request(app).post('/slack/reply/C0E2ECHAN')).send({ text: 'Posted them in the release channel.' });
    expect(reply.status).toBe(200);

    // The phone's history shows its own message (verified) and the reply.
    const hist = await send('GET', `/mobile/chat/slack/${conversationId}/messages?machine=${encodeURIComponent(machine)}`);
    expect(hist.status).toBe(200);
    expect(hist.body.messages.map((m: { text: string; role: string; originVerified: string }) => [m.role, m.originVerified, m.text])).toEqual([
      ['participant', 'none', 'second person here'],
      ['operator', 'verified', 'Can you post the release notes?'],
      ['agent', 'none', 'Posted them in the release channel.'],
    ]);
    // The second person is named, not "Someone" or their id (fb-4db533fa-9d9).
    expect(hist.body.messages[0].senderName).toBe('Gear Test');
  });

  it('with no owner id set, Slack rows are withheld and the send route says why', async () => {
    const { server, dispatched, conversationId } = await boot(null);
    const app = server.getApp();
    const { send } = await pairPhone(app, server);
    const list = await send('GET', '/mobile/conversations');
    expect(list.body).toMatchObject({ conversations: [], slackOwnerUnset: true });
    const r = await send('POST', `/mobile/chat/slack/${conversationId}`, { machine: server.appConversations!.deps.machineId(), text: 'hi', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('slack-owner-unset');
    expect(dispatched).toHaveLength(0);
  });
});
