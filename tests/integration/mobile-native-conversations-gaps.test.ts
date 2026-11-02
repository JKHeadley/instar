/**
 * Gaps found by an app builder against a real server with no Telegram configured
 * (docs/specs/mobile-native-conversations.md), over the real HTTP pipeline:
 *  1. GET /mobile/conversations pages losslessly across app conversations and Telegram topics
 *     (one cursor for every kind; nothing cut and never reached).
 *  2. `?scope=pool` on the list and the browse read merges every answering machine and names a
 *     dark one in `pool.failed`; a row only a peer holds reads `originVerified: "unknown"`.
 *  3. POST /mobile/chat/:topicId with native conversations on removes invite / desktop tokens and
 *     only signals credential-shaped text (§4.2, §4.9), instead of refusing; the mirror hides it.
 *  5. History says how the signing phone was approved (`originApprovedVia`), so the app can show
 *     "approved on dashboard" (§4.6).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Server } from 'node:http';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const TOPIC = 77;
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-native-conversations-gaps.test.ts' });
});

interface Opts { topics?: Array<{ topicId: number; topicName: string; lastActivity: string | null }>; peerUrls?: string[]; nativeOff?: boolean }

async function setup(opts: Opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgaps-'));
  dirs.push(dir);
  await new MachineIdentityManager(dir).generateIdentity({ name: 'test machine' });
  const config = { projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } }, sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' } };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = !opts.nativeOff;
  cleanups.push(() => pairing.stop());
  const signer = loadMachineSigner(dir)!;
  const keyLookup = identityKeyLookup(dir);
  const keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup });
  pairing.keyLedger = keyLedger;
  const svc: AppConversationService = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Justin',
    signer, keyLookup, keyLedger,
    dispatch: () => async (input) => { svc.channels.register(String(input.alias), 'sess-app'); return 'delivered'; },
  });
  const tgRows: Array<Record<string, unknown>> = [];
  const mirrors: string[] = [];
  const ingested: string[] = [];
  const topics = opts.topics ?? [{ topicId: TOPIC, topicName: 'Lifeline', lastActivity: null }];
  const telegram = {
    getOwnerUserId: () => 4242,
    getAllTopicMappings: () => topics.map((t) => ({ topicId: t.topicId, topicName: t.topicName })),
    getTopicHistory: (id: number, limit: number) => tgRows.filter((r) => r.topicId === id).slice(-limit),
    sendToTopic: async (_id: number, text: string) => { mirrors.push(text); },
  };
  const resolvePeerUrls = () => (opts.peerUrls ?? []).map((url, i) => ({ machineId: `m_peer${i}`, url, kind: 'lan' }));
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: 'm1', resolvePeerUrls,
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined },
    conversationRegistry: registry, conversationBindAuth: createConversationBindAuth(dir), appConversations: svc, telegram,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createRoutes(ctx));
  app.use(createMobileConversationRouter({
    config: config as never, pairing, service: svc, machineId: () => 'm1', pool: { config: config as never, resolvePeerUrls } as never,
    telegramTopics: () => topics.map((t) => ({ topicId: t.topicId, topicName: t.topicName, lastActivity: t.lastActivity, lastPreview: null })),
  }));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  ctx.mobileInbound = {
    ingest: async (req: { body: Record<string, unknown> }, res: { status(c: number): { json(b: unknown): unknown } }, trust: { deviceId: string; eventId: string }) => {
      ingested.push(String(req.body.text));
      tgRows.push({ messageId: req.body.messageId, topicId: req.body.topicId, text: req.body.text, fromUser: true, timestamp: req.body.timestamp, sessionName: null, via: 'mobile-device', deviceId: trust.deviceId, eventId: trust.eventId });
      res.status(200).json({ ok: true });
    },
  };
  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('setup');
  const code = pairing.confirm.issue(c.device.id, Date.now() + 60_000);
  const e = { app, dir, svc, dev, deviceId: c.device.id, tgRows, mirrors, ingested, pairing, keyLedger };
  expect((await signed(e, 'POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
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
const bearer = (e: Env, p: string) => request(e.app).get(p).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

function listen(app: express.Express): Promise<Server> {
  return new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
}
const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as { port: number }).port}`;

describe('gap 1 — the list pages losslessly across app conversations and Telegram topics', () => {
  it('250 newer Telegram topics never push the app conversations out of reach', async () => {
    const topics = Array.from({ length: 250 }, (_, i) => ({ topicId: 1000 + i, topicName: `T${i}`, lastActivity: new Date(Date.UTC(2030, 0, 1, 0, 0, i)).toISOString() }));
    const e = await setup({ topics });
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) keys.push((await signed(e, 'POST', '/mobile/conversations', { title: `App ${i}`, requestId: rid() })).body.conversationKey);
    const seen: Array<string | number> = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const q = `/mobile/conversations?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const r = await bearer(e, q);
      expect(r.status).toBe(200);
      seen.push(...r.body.conversations.map((c: { id: string | number }) => c.id));
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(255);
    expect(new Set(seen).size).toBe(255);
    for (const k of keys) expect(seen).toContain(k);
    // Newest first: every Telegram topic (2030) before the app conversations (now).
    expect(seen.slice(0, 250).every((x) => typeof x === 'number')).toBe(true);
  });

  it('pages interleaved kinds in one total order, with small pages', async () => {
    const now = Date.now();
    const topics = Array.from({ length: 7 }, (_, i) => ({ topicId: 10 + i, topicName: `T${i}`, lastActivity: new Date(now + (i % 2 ? 1 : -1) * 60_000 * (i + 1)).toISOString() }));
    topics.push({ topicId: 99, topicName: 'never used', lastActivity: null });
    const e = await setup({ topics });
    for (let i = 0; i < 6; i++) await signed(e, 'POST', '/mobile/conversations', { title: `App ${i}`, requestId: rid() });
    const all = (await bearer(e, '/mobile/conversations?limit=200')).body.conversations as Array<{ id: string | number; lastActivity: string | null }>;
    expect(all).toHaveLength(14);
    const seen: Array<string | number> = [];
    let cursor: string | null = null;
    do {
      const r = await bearer(e, `/mobile/conversations?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...r.body.conversations.map((c: { id: string | number }) => c.id));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.map((c) => c.id));
    expect(all[all.length - 1]!.id).toBe(99); // no activity sorts last
  });
});

describe('gap 2 — scope=pool on the list and the browse read', () => {
  it('merges a peer\'s rows, tags machines, collapses duplicates and names a dark peer', async () => {
    const peerKey = crypto.randomUUID();
    const peer = express();
    let seenAuth = '';
    peer.get('/mobile/conversations', (req, res) => {
      seenAuth = String(req.headers.authorization);
      res.json({ conversations: [
        { id: peerKey, platform: 'app', title: 'Made on the laptop', lastActivity: '2031-01-01T00:00:00.000Z', lastPreview: 'hi' },
        { id: TOPIC, platform: 'telegram', title: 'Lifeline', lastActivity: '2031-01-02T00:00:00.000Z', lastPreview: null },
        { id: 'not-a-key', platform: 'app', title: 'junk', lastActivity: null, lastPreview: null },
      ], nextCursor: null });
    });
    const server = await listen(peer);
    try {
      const e = await setup({ peerUrls: [urlOf(server), 'http://127.0.0.1:1'] });
      const mine = (await signed(e, 'POST', '/mobile/conversations', { title: 'Mine', requestId: rid() })).body.conversationKey;
      const r = await signed(e, 'GET', '/mobile/conversations?scope=pool');
      expect(r.status).toBe(200);
      expect(seenAuth).toBe('Bearer tok-1');
      const rows = r.body.conversations as Array<{ id: string | number; machine: string }>;
      expect(rows.map((x) => `${x.machine}:${x.id}`)).toEqual([`m_peer0:${TOPIC}`, `m_peer0:${peerKey}`, `m1:${mine}`]);
      expect(r.body.pool.failed.map((f: { machineId: string }) => f.machineId)).toEqual(['m_peer1']);
      expect((await bearer(e, '/mobile/conversations?scope=everything')).status).toBe(400);
    } finally { server.close(); }
  });

  it('browse with scope=pool merges by eventId; a peer-only row reads "unknown", never the peer\'s verdict', async () => {
    const e0 = await setup();
    const key = (await signed(e0, 'POST', '/mobile/conversations', { title: 'Plans', requestId: rid() })).body.conversationKey as string;
    const sent = await signed(e0, 'POST', `/mobile/chat/app/${key}`, { text: 'local message', requestId: rid() });
    expect(sent.status).toBe(200);
    const peer = express();
    peer.get('/mobile/chat/app/:key/messages', (_req, res) => {
      res.json({ messages: [
        { eventId: sent.body.eventId, messageId: sent.body.messageId, role: 'operator', text: 'tampered copy', at: '2000-01-01T00:00:00.000Z', machineId: 'mx', deliveryState: 'delivered', originVerified: 'verified' },
        { eventId: 'agent-ev-1', messageId: 'agent-msg-1', role: 'agent', text: 'reply written on the laptop', at: '2099-01-01T00:00:00.000Z', machineId: 'm_peer0', deliveryState: 'delivered', originVerified: 'verified' },
      ], nextBefore: null });
    });
    const server = await listen(peer);
    try {
      // A second router over the same store, with the peer list pointing at the stub (the peer
      // URL is only known once the stub listens).
      const e = e0;
      const app2 = express();
      app2.use(express.json());
      app2.use((req, _res, next) => { (req as unknown as { instarPrincipal: unknown }).instarPrincipal = { kind: 'token' }; next(); });
      app2.use(createMobileConversationRouter({
        config: { authToken: 'tok-1' } as never, pairing: e.pairing, service: e.svc, machineId: () => 'm1',
        pool: { config: { authToken: 'tok-1' }, resolvePeerUrls: () => [{ machineId: 'm_peer0', url: urlOf(server), kind: 'lan' }, { machineId: 'm_dark', url: 'http://127.0.0.1:1', kind: 'lan' }] } as never,
      }));
      const r = await request(app2).get(`/mobile/chat/app/${key}/messages?scope=pool`);
      expect(r.status).toBe(200);
      const msgs = r.body.messages as Array<{ text: string; originVerified: string; machine: string }>;
      expect(msgs.map((m) => [m.machine, m.text, m.originVerified])).toEqual([
        ['m1', 'local message', 'verified'],
        ['m_peer0', 'reply written on the laptop', 'unknown'],
      ]);
      expect(r.body.pool.failed.map((f: { machineId: string }) => f.machineId)).toEqual(['m_dark']);
      // Without scope the read is unchanged (this machine only, no pool block).
      const plain = await request(app2).get(`/mobile/chat/app/${key}/messages`);
      expect(plain.body.messages).toHaveLength(1);
      expect(plain.body.pool).toBeUndefined();
    } finally { server.close(); }
  });
});

describe('gap 3 — the Telegram send route removes tokens and signals credentials (native on)', () => {
  it('delivers an invite or desktop code with the token removed, reads "redacted", and keeps the token off disk', async () => {
    const e = await setup();
    const token = `tlinv1:${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(12).toString('base64url')}`;
    const r = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: `pair with ${token} please`, requestId: rid() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, outcome: 'delivered', redacted: true, removed: ['pairing-invite'] });
    expect(e.ingested).toEqual(['pair with [pairing invite removed] please']);
    expect(e.mirrors[0]).toContain('[pairing invite removed]');
    const hist = await signed(e, 'GET', `/telegram/topics/${TOPIC}/messages`);
    expect(hist.body.messages[0]).toMatchObject({ text: 'pair with [pairing invite removed] please', originVerified: 'redacted' });
    const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? files(path.join(d, x.name)) : [path.join(d, x.name)]));
    for (const f of files(e.dir)) expect(fs.readFileSync(f).includes(Buffer.from(token)), f).toBe(false);
    const d = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: '/desktop abc 123456', requestId: rid() });
    expect(d.body).toMatchObject({ ok: true, redacted: true, removed: ['desktop-code'] });
    expect(e.ingested[1]).toBe('[desktop code removed]');
  });

  it('delivers credential-shaped text unchanged with a signal, and the mirror hides it', async () => {
    const e = await setup();
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
    const r = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: `my key is ${secret}`, requestId: rid() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, outcome: 'delivered', credentialShaped: true });
    expect(r.body.redacted).toBeUndefined();
    expect(e.ingested).toEqual([`my key is ${secret}`]);
    expect(e.mirrors[0]).toContain('[credential hidden]');
    expect(e.mirrors[0]).not.toContain(secret);
    const hist = await signed(e, 'GET', `/telegram/topics/${TOPIC}/messages`);
    expect(hist.body.messages[0].originVerified).toBe('verified');
  });

  it('with native conversations off the route still refuses, exactly as before', async () => {
    const e = await setup({ nativeOff: true });
    expect((await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'tlinv1:abcDEF123.ghiJKL456', requestId: rid() })).body.error).toBe('not-from-the-app');
    expect((await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH', requestId: rid() })).body.error).toBe('credential-refused');
    expect(e.ingested).toEqual([]);
  });
});

describe('gap 5 — history says how the signing phone was approved', () => {
  it('a Telegram-approved phone reads telegram-dm; a dashboard-approved phone reads dashboard-pin', async () => {
    const e = await setup();
    const key = (await signed(e, 'POST', '/mobile/conversations', { title: 'Plans', requestId: rid() })).body.conversationKey as string;
    await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'from the first phone', requestId: rid() });

    const dev2 = makeDevice();
    const c = e.pairing.devices.createPending({ deviceName: 'iPad', label: null, publicKey: dev2.publicKey, host: HOST });
    if (!c.ok) throw new Error('setup');
    const approvedAt = new Date(Date.now() - 1000).toISOString();
    const active = e.pairing.devices.applyConfirm(c.device.id, { ok: true, approvedVia: 'dashboard-pin', approvedAt })!;
    e.keyLedger.recordActivation(active, 'dashboard-pin', approvedAt);
    const e2 = { app: e.app, dev: dev2, deviceId: c.device.id };
    expect((await signed(e2, 'POST', `/mobile/chat/app/${key}`, { text: 'from the dashboard-approved phone', requestId: rid() })).status).toBe(200);

    const hist = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    const by = Object.fromEntries(hist.body.messages.map((m: { text: string; originVerified: string; originApprovedVia?: string }) => [m.text, [m.originVerified, m.originApprovedVia]]));
    expect(by).toEqual({
      'from the first phone': ['verified', 'telegram-dm'],
      'from the dashboard-approved phone': ['verified', 'dashboard-pin'],
    });
    const sync = await signed(e, 'GET', `/mobile/chat/app/${key}/events`);
    const vias = sync.body.events.filter((x: { kind: string }) => x.kind === 'message').map((x: { originApprovedVia?: string }) => x.originApprovedVia);
    expect(vias.sort()).toEqual(['dashboard-pin', 'telegram-dm']);

    // A Telegram send from the app carries it on the device's history read too.
    await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'into Telegram', requestId: rid() });
    const tg = await signed(e, 'GET', `/telegram/topics/${TOPIC}/messages`);
    expect(tg.body.messages[0]).toMatchObject({ originVerified: 'verified', originApprovedVia: 'telegram-dm' });
  });

  it('a record that does not check out carries no approval method', async () => {
    const e = await setup();
    const key = (await signed(e, 'POST', '/mobile/conversations', { title: 'Plans', requestId: rid() })).body.conversationKey as string;
    await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'Transfer the files on Monday', requestId: rid() });
    const dir = path.join(e.dir, 'app-conversations');
    const file = fs.readdirSync(dir).map((n) => path.join(dir, n)).find((f) => f.endsWith('.jsonl') && fs.readFileSync(f, 'utf8').includes('Transfer the files'))!;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Transfer the files on Monday', 'Delete the files on Monday'));
    e.svc.store.rebuildIndex();
    const hist = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    expect(hist.body.messages[0].originVerified).toBe('failed');
    expect(hist.body.messages[0].originApprovedVia).toBeUndefined();
  });
});
