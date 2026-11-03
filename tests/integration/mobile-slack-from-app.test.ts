/**
 * Slack conversations from the app over the real HTTP pipeline (docs/specs/mobile-native-
 * conversations.md §4.9, increment 4), with a stub Slack adapter (nothing is posted to Slack) and
 * a real conversation registry, request store, device authentication and signed records:
 * the unified list (and what it does with no owner id), a send that is stored first with a v2
 * receipt and reads "verified", the dispatch as the operator, the mirror with credential spans
 * hidden, retry replay, the 503/404/409 cases, a failed dispatch and a failed mirror, an
 * emergency stop over the rate limit, token removal, the device allowlist, and a dispatched
 * message recovered from the store after slack-messages.jsonl rotates away.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { buildMobileSlackBridge, createMobileSlackRouter, slackListRows, slackOwnerUserId, type SlackAdapterLike, type SlackDispatchOutcome } from '../../src/server/mobileSlackRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import type { Message } from '../../src/core/types.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const OWNER = 'U0OWNER1';
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-slack-from-app.test.ts' });
});

async function setup(opts: { owner?: string | null; slack?: boolean; holdsLease?: boolean; peerUrls?: string[] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mslack-'));
  dirs.push(dir);
  await new MachineIdentityManager(dir).generateIdentity({ name: 'test machine' });
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false }, ...(opts.owner === null ? {} : { slackOwnerUserId: opts.owner ?? OWNER }) },
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' },
  };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const channelId = registry.mintForInbound('C0123ABC').id!;
  const threadId = registry.mintForInbound('C0123ABC:1793600000.000100').id!;
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const signer = loadMachineSigner(dir)!;
  const keyLookup = identityKeyLookup(dir);
  const keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup });
  pairing.keyLedger = keyLedger;
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Justin',
    signer, keyLookup, keyLedger, dispatch: () => null,
  });
  cleanups.push(() => svc.stop());

  // The stub Slack adapter: never talks to Slack; records what would have been posted.
  const logPath = path.join(dir, 'slack-messages.jsonl');
  const posted: Array<{ channelId: string; text: string; threadTs?: string }> = [];
  const mirrorFailures: number[] = [];
  const adapter: SlackAdapterLike = {
    getChannelMessages: () => [],
    getBotUserId: () => 'UBOT',
    getLogPath: () => logPath,
    logMessage: (e) => fs.appendFileSync(logPath, `${JSON.stringify({ ...e, timestamp: new Date().toISOString(), platform: 'slack', ...(e.eventId ? { via: 'mobile-device' } : {}) })}\n`),
    sendToChannel: async (ch, text, o) => {
      if (mirrorFailures.shift()) throw new Error('slack down');
      posted.push({ channelId: ch, text, threadTs: o?.thread_ts }); return '1793615401.000001';
    },
    getSessionForChannel: () => 'sess-slack',
    isAuthorized: (u) => u === OWNER,
  };
  const dispatched: Message[] = [];
  const outcomes: Array<SlackDispatchOutcome | Error> = [];
  let killed = 0;
  const bridge = buildMobileSlackBridge({
    adapter, registry,
    dispatch: () => async (m) => { dispatched.push(m); const o = outcomes.shift(); if (o instanceof Error) throw o; return o ?? 'delivered'; },
    killAllSessions: () => { killed++; return true; }, sendEscape: () => undefined, holdsLease: () => opts.holdsLease ?? true,
  });
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createMobileSlackRouter({ config: config as never, pairing, service: svc, slack: opts.slack === false ? null : () => bridge, machineId: () => 'm1' }));
  app.use(createMobileConversationRouter({
    config: config as never, pairing, service: svc, machineId: () => 'm1',
    pool: { config: config as never, resolvePeerUrls: () => (opts.peerUrls ?? []).map((url, i) => ({ machineId: `m_peer${i}`, url, kind: 'lan' })) } as never,
    slackConversations: opts.slack === false ? undefined : () => (slackOwnerUserId(config as never) ? slackListRows(bridge) : null),
  }));
  app.use(createMobilePairingRouter(pairing, deps, { config } as never));

  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('setup');
  const code = pairing.confirm.issue(c.device.id, Date.now() + 60_000);
  const e = { app, dir, svc, dev, deviceId: c.device.id, dispatched, outcomes, posted, mirrorFailures, logPath, channelId, threadId, kills: () => killed, registry };
  const confirmed = await signed(e, 'POST', '/mobile/device/confirm', { code });
  expect(confirmed.body.status).toBe('active');
  return e;
}

type Env = Awaited<ReturnType<typeof setup>>;
let tick = 0;
function signed(e: Pick<Env, 'app' | 'dev' | 'deviceId'>, method: 'GET' | 'POST', p: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = e.dev.sign(canonicalString(e.deviceId, HOST, method, p, time, raw));
  const base = method === 'GET' ? request(e.app).get(p) : request(e.app).post(p);
  const q = base.set('X-Instar-Device', e.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? q.set('Content-Type', 'application/json').send(raw.toString()) : q;
}
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;
const bearer = (e: Env, method: 'get' | 'post', p: string) => request(e.app)[method](p).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');

describe('Slack from the app — list and history', () => {
  it('lists the local Slack channel and thread beside nothing else, and withholds them with no owner id', async () => {
    const e = await setup();
    const list = await signed(e, 'GET', '/mobile/conversations');
    expect(list.status).toBe(200);
    const slack = list.body.conversations.filter((c: { platform: string }) => c.platform === 'slack');
    expect(slack.map((c: { id: number }) => c.id).sort()).toEqual([e.channelId, e.threadId].sort());
    expect(slack.find((c: { id: number }) => c.id === e.threadId).title).toBe('#C0123ABC (thread)');

    const none = await setup({ owner: null });
    const l2 = await signed(none, 'GET', '/mobile/conversations');
    expect(l2.body.slackOwnerUnset).toBe(true);
    expect(l2.body.conversations.filter((c: { platform: string }) => c.platform === 'slack')).toHaveLength(0);
    expect((await signed(none, 'GET', `/mobile/chat/slack/${none.channelId}/messages?machine=m1`)).body.error).toBe('slack-owner-unset');
  });

  it('with Slack not configured the list has no Slack rows and the routes say so', async () => {
    const e = await setup({ slack: false });
    const list = await signed(e, 'GET', '/mobile/conversations');
    expect(list.body.conversations).toHaveLength(0);
    expect(list.body.slackOwnerUnset).toBeUndefined();
    const r = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: 'hi', requestId: rid() });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('slack-not-configured');
  });

  it('history merges Slack rows (none) with app-sent rows (verified), and the agent can read it by token', async () => {
    const e = await setup();
    fs.appendFileSync(e.logPath, `${JSON.stringify({ messageId: '1793615300.000000', channelId: 'C0123ABC', text: 'typed in Slack', fromUser: true, timestamp: new Date(Date.now() - 60_000).toISOString(), senderName: 'Ada' })}\n`);
    fs.appendFileSync(e.logPath, `${JSON.stringify({ messageId: '1793615310.000000', channelId: 'C0123ABC', text: 'agent reply', fromUser: false, timestamp: new Date(Date.now() - 30_000).toISOString() })}\n`);
    const sent = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: 'from the app into Slack', requestId: rid() });
    expect(sent.status).toBe(200);
    const hist = await signed(e, 'GET', `/mobile/chat/slack/${e.channelId}/messages?machine=m1`);
    expect(hist.status).toBe(200);
    expect(hist.body.messages.map((m: { text: string; originVerified: string; role: string }) => [m.text, m.role, m.originVerified])).toEqual([
      ['typed in Slack', 'participant', 'none'], ['agent reply', 'agent', 'none'], ['from the app into Slack', 'operator', 'verified'],
    ]);
    const tok = await bearer(e, 'get', `/mobile/chat/slack/${e.channelId}/messages?machine=m1`);
    expect(tok.status).toBe(200);
    // The thread conversation shows none of the channel's rows.
    expect((await signed(e, 'GET', `/mobile/chat/slack/${e.threadId}/messages?machine=m1`)).body.messages).toHaveLength(0);
  });

  it('a dispatched message is still returned from the store after slack-messages.jsonl rotates away', async () => {
    const e = await setup();
    await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: 'survives rotation', requestId: rid() });
    fs.writeFileSync(e.logPath, '');
    const hist = await signed(e, 'GET', `/mobile/chat/slack/${e.channelId}/messages?machine=m1`);
    expect(hist.body.messages).toHaveLength(1);
    expect(hist.body.messages[0]).toMatchObject({ text: 'survives rotation', deliveryState: 'delivered', originVerified: 'verified' });
  });
});

function listen(app: express.Express): Promise<Server> {
  return new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
}
const urlOf = (sv: Server) => `http://127.0.0.1:${(sv.address() as { port: number }).port}`;

describe('Slack from the app — conversation ids are local to one machine', () => {
  it('a pool list shows only this machine\'s Slack rows, never a peer\'s row that shares the number', async () => {
    let channelIdHere = 0;
    const peer = express();
    // The peer's own Slack conversation happens to carry the SAME negative id as one here, with
    // newer activity (so a naive merge would replace this machine's row with the peer's).
    peer.get('/mobile/conversations', (_req, res) => {
      res.json({ conversations: [{ id: channelIdHere, platform: 'slack', title: '#C0PEERCHAN', lastActivity: '2031-01-01T00:00:00.000Z', lastPreview: 'peer secret' }], nextCursor: null });
    });
    const server = await listen(peer);
    try {
      const e = await setup({ peerUrls: [urlOf(server)] });
      channelIdHere = e.channelId;
      const r = await signed(e, 'GET', '/mobile/conversations?scope=pool');
      expect(r.status).toBe(200);
      const slack = r.body.conversations.filter((c: { platform: string }) => c.platform === 'slack');
      expect(slack.map((c: { id: number; machine: string; title: string }) => [c.machine, c.id, c.title]).sort()).toEqual(
        [['m1', e.channelId, '#C0123ABC'], ['m1', e.threadId, '#C0123ABC (thread)']].sort(),
      );
      expect(JSON.stringify(r.body)).not.toContain('peer secret');
      // The plain list names the machine on every Slack row too.
      const plain = await signed(e, 'GET', '/mobile/conversations');
      expect(plain.body.conversations.every((c: { machine?: string }) => c.machine === 'm1')).toBe(true);
    } finally { server.close(); }
  });

  it('a request naming another machine, or none, is refused before anything is read, saved or sent', async () => {
    const e = await setup();
    const other = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm_peer0', text: 'meant for the laptop', requestId: rid() });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ error: 'wrong-machine', servedBy: 'm1' });
    const none = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { text: 'which machine?', requestId: rid() });
    expect(none.status).toBe(400);
    expect(none.body.error).toBe('machine-required');
    expect(e.dispatched).toHaveLength(0);
    expect(e.posted).toHaveLength(0);
    expect(fs.existsSync(e.logPath) ? fs.readFileSync(e.logPath, 'utf8') : '').not.toContain('meant for the laptop');
    const key = (e.registry.resolve(e.channelId) as { key: string }).key;
    expect(e.svc.store.browseMessages(key, null, 10).messages).toHaveLength(0);
    expect((await signed(e, 'GET', `/mobile/chat/slack/${e.channelId}/messages?machine=m_peer0`)).body).toMatchObject({ error: 'wrong-machine', servedBy: 'm1' });
    expect((await signed(e, 'GET', `/mobile/chat/slack/${e.channelId}/messages`)).status).toBe(400);
  });
});

describe('Slack from the app — send', () => {
  it('stores first with a v2 receipt, dispatches as the operator, mirrors with credential spans hidden, and replays a retry', async () => {
    const e = await setup();
    const requestId = rid();
    const text = 'deploy with sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH please';
    const sent = await signed(e, 'POST', `/mobile/chat/slack/${e.threadId}`, { machine: 'm1', text, requestId });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, outcome: 'delivered', deliveryState: 'delivered', mirror: 'sent', credentialShaped: true });
    // The store holds the message under the canonical thread key, with a v2 receipt naming it.
    const key = (e.registry.resolve(e.threadId) as { key: string }).key;
    expect(key).toMatch(/^slack:_:C0123ABC:1793600000\.000100$/);
    const ev = e.svc.store.getEvent(key, sent.body.eventId as string) as { text: string; receipt?: { v?: number; conversationKey?: string } };
    expect(ev.text).toBe(text); // the operator sent it as written; the server does not alter it
    expect(ev.receipt).toMatchObject({ v: 2, conversationKey: key });
    // Dispatched once, as the operator, into the thread, tagged signed.
    expect(e.dispatched).toHaveLength(1);
    expect(e.dispatched[0]).toMatchObject({ userId: OWNER, content: text, channel: { type: 'slack', identifier: 'C0123ABC' } });
    expect(e.dispatched[0]!.metadata).toMatchObject({ senderName: 'Justin', threadTs: '1793600000.000100', appOrigin: 'verified' });
    // The mirror hides the credential-shaped span.
    expect(e.posted).toHaveLength(1);
    expect(e.posted[0]!.threadTs).toBe('1793600000.000100');
    expect(e.posted[0]!.text.startsWith('📱 Justin (from the app): deploy with ')).toBe(true);
    expect(e.posted[0]!.text).not.toContain('sk-ant-api03');
    // A retry answers the recorded result and dispatches nothing.
    const again = await signed(e, 'POST', `/mobile/chat/slack/${e.threadId}`, { machine: 'm1', text, requestId });
    expect(again.status).toBe(200);
    expect(again.body.eventId).toBe(sent.body.eventId);
    expect(e.dispatched).toHaveLength(1);
    expect(e.posted).toHaveLength(1);
    // Same id, other text: a payload conflict.
    expect((await signed(e, 'POST', `/mobile/chat/slack/${e.threadId}`, { machine: 'm1', text: 'other', requestId })).body.error).toBe('payload-conflict');
  });

  it('refuses before saving anything: unknown id, owner not authorized, not serving', async () => {
    const e = await setup();
    expect((await signed(e, 'POST', '/mobile/chat/slack/-77', { machine: 'm1', text: 'x', requestId: rid() })).status).toBe(404);
    const notServing = await setup({ holdsLease: false });
    const r = await signed(notServing, 'POST', `/mobile/chat/slack/${notServing.channelId}`, { machine: 'm1', text: 'x', requestId: rid() });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('not-serving');
    expect(notServing.svc.store.browseMessages((notServing.registry.resolve(notServing.channelId) as { key: string }).key, null, 10).messages).toHaveLength(0);
    const other = await setup({ owner: 'U0STRANGER' });
    expect((await signed(other, 'POST', `/mobile/chat/slack/${other.channelId}`, { machine: 'm1', text: 'x', requestId: rid() })).body.error).toBe('slack-owner-not-authorized');
  });

  it('a dispatch that throws is outcome-unknown; a refused one is an honest 503; a failed mirror never repeats the dispatch', async () => {
    const e = await setup();
    e.outcomes.push(new Error('tmux gone'));
    const a = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: 'first', requestId: rid() });
    expect(a.status).toBe(409);
    expect(a.body.error).toBe('outcome-unknown');
    expect(e.svc.store.deliveryState(a.body.messageId as string)).toBe('unknown');

    e.outcomes.push('refused');
    const b = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: 'second', requestId: rid() });
    expect(b.status).toBe(503);
    expect(b.body).toMatchObject({ error: 'chat-unavailable', deliveryState: 'refused' });

    e.mirrorFailures.push(1);
    const requestId = rid();
    const c = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: 'third', requestId });
    expect(c.body).toMatchObject({ ok: true, deliveryState: 'delivered', mirror: 'failed' });
    const before = e.dispatched.length;
    expect((await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: 'third', requestId })).body.mirror).toBe('failed');
    expect(e.dispatched.length).toBe(before);
  });

  it('an emergency stop gets through over the send rate limit and is recorded intercepted', async () => {
    const e = await setup();
    for (let i = 0; i < 20; i++) await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: `msg ${i}`, requestId: rid() });
    expect((await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: 'one more', requestId: rid() })).status).toBe(429);
    const stop = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: 'stop everything', requestId: rid() });
    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ outcome: 'sentinel-kill', deliveryState: 'intercepted', stopped: true });
    expect(e.kills()).toBe(1);
  });

  it('a pairing invite is removed and the message reads "redacted"', async () => {
    const e = await setup();
    const token = `tlinv1:${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(12).toString('base64url')}`;
    const sent = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: `pair with ${token} now`, requestId: rid() });
    expect(sent.body.redacted).toBe(true);
    expect(e.dispatched[0]!.content).toBe('pair with [pairing invite removed] now');
    const hist = await signed(e, 'GET', `/mobile/chat/slack/${e.channelId}/messages?machine=m1`);
    expect(hist.body.messages[0]).toMatchObject({ text: 'pair with [pairing invite removed] now', originVerified: 'redacted' });
  });

  it('the device allowlist: a Bearer send is refused, a malformed id is not a device route, an empty file list is refused', async () => {
    const e = await setup();
    expect((await bearer(e, 'post', `/mobile/chat/slack/${e.channelId}`).send({ machine: 'm1', text: 'x', requestId: rid() })).status).toBe(403);
    expect((await signed(e, 'POST', '/mobile/chat/slack/042', { machine: 'm1', text: 'x', requestId: rid() })).status).toBeGreaterThanOrEqual(400);
    const f = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: 'x', requestId: rid(), attachments: [] });
    // Media is read live and this development agent has it on, so an empty list is malformed; the
    // media-off refusal (media-target-unsupported) is covered in mobile-media-to-platform.test.ts.
    expect(f.status).toBe(400);
    expect(f.body.error).toBe('bad-attachments');
  });
});
