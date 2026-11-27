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
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Server } from 'node:http';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware, buildRequestTimeoutOverrides, requestTimeout, resolveRequestTimeout, MOBILE_MEDIA_TIMEOUT_MS } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { attachmentIdFor } from '../../src/core/appMediaTypes.js';
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

interface Opts { topics?: Array<{ topicId: number; topicName: string; lastActivity: string | null }>; peerUrls?: string[]; nativeOff?: boolean; attachmentBrowse?: boolean; mediaOff?: boolean; beforeRoutes?: express.RequestHandler }

async function setup(opts: Opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgaps-'));
  dirs.push(dir);
  await new MachineIdentityManager(dir).generateIdentity({ name: 'test machine' });
  const config = { projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false }, native: {
    ...(opts.attachmentBrowse === undefined ? {} : { attachmentBrowse: { enabled: opts.attachmentBrowse } }),
    ...(opts.mediaOff ? { media: { enabled: false } } : {}),
  } }, sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' } };
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
    sendToTopic: async (_id: number, text: string) => { mirrors.push(text);  return { messageId: 1, topicId: Number(_id) }; },
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
  app.use(requestTimeout(30_000, buildRequestTimeoutOverrides()));
  if (opts.beforeRoutes) app.use(opts.beforeRoutes);
  app.use(createRoutes(ctx));
  app.use(createMobileConversationRouter({
    config: config as never, pairing, service: svc, mediaEnabled: !opts.mediaOff, machineId: () => 'm1', pool: { config: config as never, resolvePeerUrls } as never,
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
function signed(e: Pick<Env, 'app' | 'dev' | 'deviceId'>, method: 'GET' | 'POST' | 'DELETE', p: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = e.dev.sign(canonicalString(e.deviceId, HOST, method, p, time, raw));
  const base = method === 'GET' ? request(e.app).get(p) : method === 'POST' ? request(e.app).post(p) : request(e.app).delete(p);
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

describe('review follow-ups — peer rows are re-validated, and pool browse covers unreplicated conversations', () => {
  /** A router over an env's store whose pool points at the given peers, read with the Bearer principal. */
  function poolApp(e: Env, peers: Array<{ machineId: string; url: string }>) {
    const app2 = express();
    app2.use(express.json());
    app2.use((req, _res, next) => { (req as unknown as { instarPrincipal: unknown }).instarPrincipal = { kind: 'token' }; next(); });
    app2.use(createMobileConversationRouter({
      config: { authToken: 'tok-1' } as never, pairing: e.pairing, service: e.svc, machineId: () => 'm1',
      pool: { config: { authToken: 'tok-1' }, resolvePeerUrls: () => peers.map((p) => ({ ...p, kind: 'lan' })) } as never,
    }));
    return app2;
  }

  it('a peer row\'s odd lastActivity ("0") is dropped, so it cannot become a cursor that ends paging early', async () => {
    const e = await setup({ topics: [] });
    const keys: string[] = [];
    for (let i = 0; i < 4; i++) keys.push((await signed(e, 'POST', '/mobile/conversations', { title: `App ${i}`, requestId: rid() })).body.conversationKey);
    const peer = express();
    peer.get('/mobile/conversations', (_req, res) => {
      res.json({ conversations: [
        { id: crypto.randomUUID(), platform: 'app', title: 'offset', lastActivity: '2035-01-01T02:00:00+02:00', lastPreview: null },
        { id: crypto.randomUUID(), platform: 'app', title: 'odd', lastActivity: '0', lastPreview: null },
        { id: crypto.randomUUID(), platform: 'app', title: 'loose date', lastActivity: 'Mon, 01 Jan 2035 00:00:00 GMT', lastPreview: null },
      ], nextCursor: null });
    });
    const server = await listen(peer);
    try {
      const app2 = poolApp(e, [{ machineId: 'm_peer0', url: urlOf(server) }]);
      const seen: Array<{ id: string; title: string; lastActivity: string | null }> = [];
      let cursor: string | null = null;
      do {
        const r = await request(app2).get(`/mobile/conversations?scope=pool&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        seen.push(...r.body.conversations);
        cursor = r.body.nextCursor;
        if (cursor) expect(cursor).toMatch(/^\d{4}-\d{2}-\d{2}T[^|]*Z\|/);
      } while (cursor);
      expect(seen.map((x) => x.title)).not.toContain('odd');
      expect(seen.map((x) => x.title)).not.toContain('loose date');
      expect(seen.find((x) => x.title === 'offset')!.lastActivity).toBe('2035-01-01T00:00:00.000Z');
      for (const k of keys) expect(seen.map((x) => x.id)).toContain(k); // every local conversation reached
    } finally { server.close(); }
  });

  it('a peer-only browse row carries no peer attachment data and a strict ISO time', async () => {
    const e = await setup();
    const key = (await signed(e, 'POST', '/mobile/conversations', { title: 'Plans', requestId: rid() })).body.conversationKey as string;
    const peer = express();
    peer.get('/mobile/chat/app/:key/messages', (_req, res) => {
      res.json({ messages: [
        { eventId: 'agent-ev-1', messageId: 'agent-msg-1', role: 'agent', text: 'here is the file', at: '2099-01-01T01:00:00+01:00', machineId: 'm_peer0', deliveryState: 'delivered',
          attachments: [{ attachmentId: '../../etc/passwd', sha256: 'x', size: -1, filename: '<script>', url: 'http://evil.example/' }, { junk: true }] },
        { eventId: 'agent-ev-2', messageId: 'agent-msg-2', role: 'agent', text: 'bad time', at: '0', machineId: 'm_peer0', deliveryState: 'delivered' },
        { eventId: 'agent-ev-3', messageId: 'agent-msg-3', role: 'agent', text: 'odd state', at: '2099-01-02T00:00:00.000Z', machineId: 'm_peer0', deliveryState: '<b>' },
      ], nextBefore: null });
    });
    const server = await listen(peer);
    try {
      const r = await request(poolApp(e, [{ machineId: 'm_peer0', url: urlOf(server) }])).get(`/mobile/chat/app/${key}/messages?scope=pool`);
      expect(r.status).toBe(200);
      const byText = Object.fromEntries(r.body.messages.map((m: Record<string, unknown>) => [m.text, m]));
      expect(byText['bad time']).toBeUndefined();
      expect(byText['here is the file'].at).toBe('2099-01-01T00:00:00.000Z');
      expect(byText['here is the file'].attachments).toBeUndefined();
      expect(byText['here is the file'].filesOnOtherMachine).toBe(2);
      expect(JSON.stringify(r.body)).not.toContain('passwd');
      expect(byText['odd state'].deliveryState).toBe('unknown');
    } finally { server.close(); }
  });

  it('pool browse reads a conversation this machine has not seen yet from the peers; a deleted one stays 404', async () => {
    const e = await setup();
    const unseen = crypto.randomUUID();
    const peer = express();
    peer.get('/mobile/chat/app/:key/messages', (req, res) => {
      if (req.params.key !== unseen) { res.status(404).json({ error: 'unknown-conversation' }); return; }
      res.json({ messages: [{ eventId: 'ev-x', messageId: 'msg-x', role: 'operator', text: 'made on the laptop', at: '2030-01-01T00:00:00.000Z', machineId: 'm_peer0', deliveryState: 'delivered' }], nextBefore: null });
    });
    const server = await listen(peer);
    try {
      const app2 = poolApp(e, [{ machineId: 'm_peer0', url: urlOf(server) }]);
      const r = await request(app2).get(`/mobile/chat/app/${unseen}/messages?scope=pool`);
      expect(r.status).toBe(200);
      expect(r.body.messages).toEqual([expect.objectContaining({ text: 'made on the laptop', originVerified: 'unknown', machine: 'm_peer0' })]);
      // Without scope=pool it is still unknown here.
      expect((await request(app2).get(`/mobile/chat/app/${unseen}/messages`)).status).toBe(404);
      // Nobody has it: 404.
      expect((await request(app2).get(`/mobile/chat/app/${crypto.randomUUID()}/messages?scope=pool`)).status).toBe(404);
      // A machine did not answer: not a 404, the gap is named.
      const dark = poolApp(e, [{ machineId: 'm_dark', url: 'http://127.0.0.1:1' }]);
      const d = await request(dark).get(`/mobile/chat/app/${crypto.randomUUID()}/messages?scope=pool`);
      expect(d.status).toBe(200);
      expect(d.body.pool.failed.map((f: { machineId: string }) => f.machineId)).toEqual(['m_dark']);
      // A conversation this machine knows is deleted stays 404 even in a pool read.
      const key = (await signed(e, 'POST', '/mobile/conversations', { title: 'Gone', requestId: rid() })).body.conversationKey as string;
      expect((await signed(e, 'DELETE', `/mobile/conversations/${key}`, { requestId: rid() })).status).toBe(200);
      expect((await request(app2).get(`/mobile/chat/app/${key}/messages?scope=pool`)).status).toBe(404);
      // A key that is not an app conversation key is never forwarded.
      expect((await request(app2).get('/mobile/chat/app/..%2F..%2Fhealth/messages?scope=pool')).status).toBe(404);
    } finally { server.close(); }
  });

  it('the Telegram route: a key with a zero-width space is flagged and the mirror shows none of it; a later-line desktop code is removed', async () => {
    const e = await setup();
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
    const split = `${key.slice(0, 20)}\u200B${key.slice(20)}`;
    const r = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: `use ${split} for now`, requestId: rid() });
    expect(r.body).toMatchObject({ ok: true, credentialShaped: true });
    expect(e.mirrors[0]).toBe('📱 Justin (from the app): [credential hidden]');
    const d = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'approve this one\n/desktop\u00A0abc 123456', requestId: rid() });
    expect(d.body).toMatchObject({ ok: true, redacted: true, removed: ['desktop-code'] });
    expect(e.ingested[1]).toBe('approve this one\n[desktop code removed]');
  });
});


function appendBrowseFile(e: Env, conversationKey: string, i: number, sha256 = 'b'.repeat(64), size = 123): string {
  const messageId = 'attachment-message-' + i;
  const attachmentId = attachmentIdFor(messageId, 0);
  e.svc.store.append({
    kind: 'media-message', eventId: 'attachment-event-' + i, conversationKey, messageId,
    role: 'operator', text: 'private caption', at: new Date(Date.UTC(2026, 10, 23, 5, 0, i)).toISOString(), machineId: 'm1',
    attachments: [{
      attachmentId, index: 0, sha256, size,
      kind: 'photo', declaredKind: 'photo', mediaType: 'image/jpeg', declaredType: 'image/jpeg', filename: 'photo.jpg',
    }],
  });
  return attachmentId;
}

describe('attachment browse signed route', () => {
  it('is dark by default and respects existing media-off and bearer boundaries', async () => {
    const dark = await setup();
    const darkKey = (await signed(dark, 'POST', '/mobile/conversations', { title: 'Dark', requestId: rid() })).body.conversationKey;
    const url = (key: string) => '/mobile/chat/app/' + key + '/attachments?kind=photo';
    expect((await signed(dark, 'GET', url(darkKey))).body.error).toBe('attachment-browse-off');

    const off = await setup({ attachmentBrowse: true, mediaOff: true });
    const offKey = (await signed(off, 'POST', '/mobile/conversations', { title: 'Files off', requestId: rid() })).body.conversationKey;
    expect((await signed(off, 'GET', url(offKey))).body.error).toBe('media-off');
    expect((await bearer(off, url(offKey))).body.error).toBe('owner-device-required');
  });

  it('serves exact local metadata and binds continuation to the signed scope', async () => {
    const e = await setup({ attachmentBrowse: true });
    const key = (await signed(e, 'POST', '/mobile/conversations', { title: 'Photos', requestId: rid() })).body.conversationKey;
    for (let i = 0; i < 16; i++) appendBrowseFile(e, key, i);
    const route = '/mobile/chat/app/' + key + '/attachments';
    const first = await signed(e, 'GET', route + '?kind=photo');
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.body).toMatchObject({ v: 1, scope: 'local', kind: 'photo', coverage: 'local' });
    expect(first.body.rows).toHaveLength(15);
    expect(first.body.rows[0]).toMatchObject({ eventId: 'attachment-event-15', attachments: [{ kind: 'photo', filename: 'photo.jpg' }] });
    expect(JSON.stringify(first.body)).not.toMatch(/private caption|sha256|declaredType/);
    const tail = '&cursor=' + first.body.nextCursor;
    expect((await signed(e, 'GET', route + '?kind=file' + tail)).body.error).toBe('invalid-cursor');
    const older = await signed(e, 'GET', route + '?kind=photo' + tail);
    expect(older.body).toMatchObject({ rows: [{ eventId: 'attachment-event-0' }], nextCursor: null });
    const browser = makeDevice();
    const pending = e.pairing.devices.createPendingBrowser({
      browserPublicKey: browser.publicKey, host: HOST, deviceName: 'Browser', enrollmentId: rid(),
      session: 'browser-approval', maxBrowsers: 10, maxSetupsPerHour: 6,
    });
    if (!pending.ok) throw new Error('test browser setup refused');
    const approvedAt = new Date().toISOString();
    expect(e.pairing.devices.setActivating(pending.device.id, {
      approvedVia: 'dashboard-pin', at: approvedAt, effects: [],
    }, { ownRequest: true })).toBe(true);
    e.keyLedger.recordActivation(pending.device, 'dashboard-pin', approvedAt);
    expect(e.pairing.devices.activateBrowser(pending.device.id)?.status).toBe('active');
    const browserEnv = { app: e.app, dev: browser, deviceId: pending.device.id };
    expect((await signed(browserEnv, 'GET', route + '?kind=photo')).status).toBe(200);
    expect((await signed(browserEnv, 'GET', route + '?kind=photo' + tail)).body.error).toBe('invalid-cursor');
    for (const query of ['kind=PHOTO', 'kind=photo&kind=voice', 'kind%5B%5D=photo', 'kind=photo&scope=pool']) {
      expect((await signed(e, 'GET', route + '?' + query)).body.error).toBe('invalid-attachment-query');
    }
  });

  it('withholds private results when the signed owner is revoked during a read', async () => {
    const e = await setup({ attachmentBrowse: true });
    const key = (await signed(e, 'POST', '/mobile/conversations', { title: 'Photos', requestId: rid() })).body.conversationKey;
    appendBrowseFile(e, key, 0);
    const original = e.svc.store.readExactAttachmentEvent.bind(e.svc.store);
    const reader = vi.spyOn(e.svc.store, 'readExactAttachmentEvent').mockImplementationOnce(async (...args) => {
      const event = await original(...args);
      e.pairing.devices.revoke(e.deviceId, new Date().toISOString());
      return event;
    });
    try {
      const response = await signed(e, 'GET', '/mobile/chat/app/' + key + '/attachments?kind=photo');
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'owner-device-required' });
      expect(reader).toHaveBeenCalledTimes(1);
    } finally {
      reader.mockRestore();
    }
  });

  it('returns retryable index pending without starting a scan or repairing the index', async () => {
    const e = await setup({ attachmentBrowse: true });
    const key = (await signed(e, 'POST', '/mobile/conversations', { title: 'Photos', requestId: rid() })).body.conversationKey;
    appendBrowseFile(e, key, 0);
    const name = crypto.createHash('sha256').update('app:' + key).digest('hex') + '.jsonl';
    fs.appendFileSync(path.join(e.dir, 'app-conversations', name), 'unindexed committed frame\n');
    const scan = vi.spyOn(e.svc.store, 'attachmentIndexWindow');
    const repair = vi.spyOn(e.svc.store, 'catchUp');
    try {
      const url = '/mobile/chat/app/' + key + '/attachments?kind=photo';
      const pending = await signed(e, 'GET', url);
      expect(pending.status).toBe(503);
      expect(pending.body).toEqual({ error: 'attachment-index-pending' });
      expect(scan).not.toHaveBeenCalled();
      expect(repair).not.toHaveBeenCalled();
      await e.svc.store.reconcileAttachmentIndexBatch(new AbortController().signal);
      expect(repair).not.toHaveBeenCalled();
      const recovered = await signed(e, 'GET', url);
      expect(recovered.status).toBe(200);
      expect(recovered.body.coverage).toBe('incomplete');
      expect(scan).toHaveBeenCalledTimes(1);
    } finally {
      scan.mockRestore();
      repair.mockRestore();
    }
  });

  it('withholds an assembled page if an earlier match is purged during a later read', async () => {
    const e = await setup({ attachmentBrowse: true });
    const key = (await signed(e, 'POST', '/mobile/conversations', { title: 'Photos', requestId: rid() })).body.conversationKey;
    appendBrowseFile(e, key, 0);
    const firstMatch = appendBrowseFile(e, key, 1);
    const original = e.svc.store.readExactAttachmentEvent.bind(e.svc.store);
    let reads = 0;
    const reader = vi.spyOn(e.svc.store, 'readExactAttachmentEvent').mockImplementation(async (...args) => {
      const event = await original(...args);
      if (++reads === 2) e.svc.store.append({
        kind: 'purge', conversationKey: 'app:' + key, eventId: 'held-page-purge',
        at: new Date().toISOString(), machineId: 'local', attachmentIds: [firstMatch],
      });
      return event;
    });
    try {
      const page = await signed(e, 'GET', '/mobile/chat/app/' + key + '/attachments?kind=photo');
      expect(page.status).toBe(503);
      expect(page.body).toEqual({ error: 'attachment-page-changed' });
      expect(reads).toBeGreaterThanOrEqual(2);
    } finally {
      reader.mockRestore();
    }
  });

  it('keeps a timed-out device slot through a late descriptor close', async () => {
    const e = await setup({ attachmentBrowse: true });
    const key = (await signed(e, 'POST', '/mobile/conversations', { title: 'Photos', requestId: rid() })).body.conversationKey;
    appendBrowseFile(e, key, 0);
    const url = '/mobile/chat/app/' + key + '/attachments?kind=photo';
    const filename = crypto.createHash('sha256').update('app:' + key).digest('hex') + '.jsonl';
    const exactPath = path.join(e.dir, 'app-conversations', filename);
    let entered!: () => void;
    let release!: () => void;
    let closed!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const lateClosed = new Promise<void>(resolve => { closed = resolve; });
    const original = fs.promises.open.bind(fs.promises);
    let holdFirstOpen = true;
    let closeCount = 0;
    const opener = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) !== exactPath || !holdFirstOpen) return original(...args);
      holdFirstOpen = false;
      entered();
      await blocked;
      const handle = await original(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close();
        closeCount++;
        closed();
      });
      return handle;
    });
    try {
      const held = signed(e, 'GET', url).then(response => response);
      await started;
      expect((await signed(e, 'GET', url)).body.error).toBe('attachment-browse-busy');
      expect((await held).body.error).toBe('attachment-browse-unavailable');
      expect((await signed(e, 'GET', url)).body.error).toBe('attachment-browse-busy');
      release();
      await lateClosed;
      expect(closeCount).toBe(1);
      expect((await signed(e, 'GET', url)).status).toBe(200);
    } finally {
      release();
      opener.mockRestore();
    }
  });
});


async function contentFixture(beforeRoutes?: express.RequestHandler) {
  const e = await setup({ attachmentBrowse: true, beforeRoutes });
  const created = await signed(e, 'POST', '/mobile/conversations', { title: 'Photos', requestId: rid() });
  const key = created.body.conversationKey as string;
  const bytes = Buffer.from('local attachment bytes\n', 'utf8');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const first = appendBrowseFile(e, key, 0, sha, bytes.length);
  const second = appendBrowseFile(e, key, 1, sha, bytes.length);
  const temp = path.join(e.dir, 'fixture-blob');
  fs.writeFileSync(temp, bytes);
  expect(e.svc.media.publishPulled(temp, sha)).toBe(true);
  const contentFor = async (owner: Pick<Env, 'app' | 'dev' | 'deviceId'>) => {
    const page = await signed(owner, 'GET', '/mobile/chat/app/' + key + '/attachments?kind=photo');
    expect(page.status).toBe(200);
    const tokens = new Map<string, string>();
    for (const row of page.body.rows) {
      for (const item of row.attachments) tokens.set(item.attachmentId, item.openToken);
    }
    return (id: string) => '/mobile/chat/app/' + key + '/attachments/' + id + '/content?'
      + new URLSearchParams({ replicaBinding: page.body.replicaBinding, openToken: tokens.get(id)! });
  };
  const content = await contentFor(e);
  return { e, key, bytes, sha, first, second, content, contentFor };
}

describe('exact attachment content signed route', () => {
  it('withholds a previously listed attachment when a durable purge is waiting to be indexed', async () => {
    const { e, key, first, content, bytes } = await contentFixture();
    const name = crypto.createHash('sha256').update('app:' + key).digest('hex') + '.jsonl';
    const purge = JSON.stringify({
      kind: 'purge', eventId: 'pending-exact-purge', conversationKey: key, machineId: 'm1',
      at: new Date().toISOString(), attachmentIds: [first], ingestSeq: 4,
    }) + '\n';
    const verify = e.svc.media.openExactLocalAttachment.bind(e.svc.media);
    const open = vi.spyOn(e.svc.media, 'openExactLocalAttachment').mockImplementationOnce(async (...args) => {
      const descriptor = await verify(...args);
      fs.appendFileSync(path.join(e.dir, 'app-conversations', name), purge);
      return descriptor;
    });
    try {
      const route = content(first);
      const late = await signed(e, 'GET', route).set('Range', `bytes=${bytes.length}-`);
      expect(late.status).toBe(503);
      expect(late.body.error).toBe('attachment-open-retry');
      expect(late.header['content-range']).toBeUndefined();
      expect((await signed(e, 'GET', route)).body.error).toBe('attachment-open-retry');
      expect(open).toHaveBeenCalledTimes(1);
      await e.svc.store.reconcileAttachmentIndexBatch(new AbortController().signal);
      expect((await signed(e, 'GET', route)).body.error).toBe('attachment-unavailable');
    } finally {
      open.mockRestore();
    }
  });

  it('rejects a missing replica binding and a valid token for a different occurrence before opening bytes', async () => {
    const { e, first, second, content } = await contentFixture();
    const url = content(first);
    const raw = url.split('?')[0];
    const otherOccurrence = content(second).replace('/' + second + '/content', '/' + first + '/content');
    const open = vi.spyOn(e.svc.media, 'openExactLocalAttachment');
    try {
      expect((await signed(e, 'GET', raw)).body.error).toBe('attachment-replica-changed');
      expect((await signed(e, 'GET', otherOccurrence)).body.error).toBe('attachment-unavailable');
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  it('serves the exact verified bytes and a signed single range, without broadening history timeout', async () => {
    const { e, content, first, bytes } = await contentFixture();
    const route = content(first);
    const response = await signed(e, 'GET', route);
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes',
      'content-length': String(bytes.length),
    });
    expect(response.body).toEqual(bytes);
    const part = await signed(e, 'GET', route).set('Range', 'bytes=2-7');
    expect(part.status).toBe(206);
    expect(part.header['content-range']).toBe('bytes 2-7/' + bytes.length);
    expect(part.body).toEqual(bytes.subarray(2, 8));
    const overrides = buildRequestTimeoutOverrides();
    const routePath = route.split('?')[0];
    expect(resolveRequestTimeout(routePath, 30_000, overrides)).toBe(MOBILE_MEDIA_TIMEOUT_MS);
    expect(resolveRequestTimeout(route.replace(/\/attachments\/.*/, '/messages'), 30_000, overrides)).toBe(30_000);
    expect(resolveRequestTimeout(routePath, 30_000, overrides, 'POST')).toBe(30_000);
    const open = vi.spyOn(e.svc.media, 'openExactLocalAttachment');
    try {
      expect((await signed(e, 'GET', route).set('Range', 'bytes=0-1,4-5')).status).toBe(416);
      expect(open).not.toHaveBeenCalled();
      const unsatisfied = await signed(e, 'GET', route).set('Range', `bytes=${bytes.length}-`);
      expect(unsatisfied.status).toBe(416);
      expect(unsatisfied.header['content-range']).toBe(`bytes */${bytes.length}`);
      expect(open).toHaveBeenCalledTimes(1);

      open.mockResolvedValueOnce(null);
      const missing = await signed(e, 'GET', route).set('Range', `bytes=${bytes.length}-`);
      expect(missing.status).toBe(404);
      expect(missing.header['content-range']).toBeUndefined();
    } finally {
      open.mockRestore();
    }
  });

  it.each([
    ['owner revoked', 403, 'owner-device-required'],
    ['conversation deleted', 404, 'unknown-conversation'],
    ['attachment purged', 404, 'attachment-unavailable'],
  ])('withholds size for an unsatisfiable range when %s during the record read', async (change, status, error) => {
    const { e, key, content, first, bytes } = await contentFixture();
    let markHeld!: () => void;
    let resumeRead!: () => void;
    const held = new Promise<void>(resolve => { markHeld = resolve; });
    const resume = new Promise<void>(resolve => { resumeRead = resolve; });
    const readRecord = e.svc.store.readExactAttachmentEvent.bind(e.svc.store);
    const reader = vi.spyOn(e.svc.store, 'readExactAttachmentEvent').mockImplementationOnce(async (...args) => {
      const event = await readRecord(...args);
      markHeld();
      await resume;
      return event;
    });
    const open = vi.spyOn(e.svc.media, 'openExactLocalAttachment');
    try {
      const response = signed(e, 'GET', content(first)).set('Range', `bytes=${bytes.length}-`).then(result => result);
      await held;
      const at = new Date().toISOString();
      if (change === 'owner revoked') e.pairing.devices.revoke(e.deviceId, at);
      else if (change === 'conversation deleted') {
        e.svc.store.append({ kind: 'tombstone', eventId: 'exact-content-delete', conversationKey: key, machineId: 'm1', at });
      } else {
        e.svc.store.append({ kind: 'purge', eventId: 'exact-content-held-purge', conversationKey: key, machineId: 'm1', at, attachmentIds: [first] });
      }
      resumeRead();
      const denied = await response;
      expect(denied.status).toBe(status);
      expect(denied.body).toEqual({ error });
      expect(denied.header['content-range']).toBeUndefined();
      expect(open).not.toHaveBeenCalled();
    } finally {
      resumeRead();
      open.mockRestore();
      reader.mockRestore();
    }
  });

  it('does not substitute another same-hash message for a purged reference or trust stale verification', async () => {
    const { e, key, content, first, second, sha, bytes } = await contentFixture();
    const fetchPeer = vi.spyOn(e.svc.replicator, 'want');
    e.svc.store.append({
      kind: 'purge', eventId: 'exact-content-purge', conversationKey: key, machineId: 'm1',
      attachmentIds: [first], at: new Date().toISOString(),
    });
    try {
      expect((await signed(e, 'GET', content(first))).body).toEqual({ error: 'attachment-unavailable' });
      expect((await signed(e, 'GET', content(second))).status).toBe(200);
      expect((await bearer(e, content(second))).status).toBe(403);
      const file = e.svc.media.locateBlob(sha)!;
      fs.writeFileSync(file, Buffer.alloc(bytes.length, 'X'));
      expect((await signed(e, 'GET', content(second))).body).toEqual({ error: 'attachment-unavailable' });
      expect(e.svc.media.locateBlob(sha)).toBe(file);
      expect(fetchPeer).not.toHaveBeenCalled();
    } finally {
      fetchPeer.mockRestore();
    }
  });

  it('closes the verified descriptor once when device admission disappears during hashing', async () => {
    const { e, content, first } = await contentFixture();
    const original = e.svc.media.openExactLocalAttachment.bind(e.svc.media);
    let closeCount = 0;
    const open = vi.spyOn(e.svc.media, 'openExactLocalAttachment').mockImplementationOnce(async (...args) => {
      const verified = await original(...args);
      if (!verified) throw new Error('fixture descriptor unavailable');
      const close = verified.handle.close.bind(verified.handle);
      vi.spyOn(verified.handle, 'close').mockImplementation(async () => { await close(); closeCount++; });
      e.pairing.devices.revoke(e.deviceId, new Date().toISOString());
      return verified;
    });
    try {
      const denied = await signed(e, 'GET', content(first));
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ error: 'owner-device-required' });
      await vi.waitFor(() => expect(closeCount).toBe(1));
    } finally {
      open.mockRestore();
    }
  });

  it('keeps the content slot through a late local open after its response deadline', async () => {
    const { e, content, first, sha } = await contentFixture();
    const url = content(first);
    const expected = fs.realpathSync(e.svc.media.locateBlob(sha)!);
    const realOpen = fs.promises.open.bind(fs.promises);
    const realTimer = globalThis.setTimeout;
    let triggerDeadline!: () => void;
    let started!: () => void;
    let release!: () => void;
    const opened = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    let heldOnce = false;
    let closeCount = 0;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 120_000) triggerDeadline = () => callback(...args);
      return realTimer(callback, delay, ...args);
    });
    const open = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) !== expected || heldOnce) return realOpen(...args);
      heldOnce = true;
      started();
      await hold;
      const handle = await realOpen(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); closeCount++; });
      return handle;
    });
    try {
      const firstResponse = signed(e, 'GET', url).then(response => response);
      await opened;
      triggerDeadline();
      expect((await firstResponse).body).toEqual({ error: 'attachment-open-retry' });
      expect((await signed(e, 'GET', url)).body).toEqual({ error: 'attachment-open-busy' });
      release();
      await vi.waitFor(() => expect(closeCount).toBe(1));
      expect((await signed(e, 'GET', url)).status).toBe(200);
    } finally {
      release();
      open.mockRestore();
      timer.mockRestore();
    }
  });

  it('interrupts a stalled published response and reclaims the descriptor and device slot', async () => {
    let entered!: () => void;
    const backingUp = new Promise<void>(resolve => { entered = resolve; });
    let stallFirstContent = true;
    const { e, content, first } = await contentFixture((req, res, next) => {
      if (req.path.endsWith('/content') && stallFirstContent) {
        stallFirstContent = false;
        // The mounted route sees a socket that never drains its first chunk.
        res.write = () => { entered(); return false; };
      }
      next();
    });
    let triggerDeadline!: () => void;
    let closes = 0;
    const realTimer = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 120_000) triggerDeadline = () => callback(...args);
      return realTimer(callback, delay, ...args);
    });
    const realVerify = e.svc.media.openExactLocalAttachment.bind(e.svc.media);
    const verify = vi.spyOn(e.svc.media, 'openExactLocalAttachment').mockImplementationOnce(async (...args) => {
      const descriptor = await realVerify(...args);
      if (!descriptor) throw new Error('test expected verified attachment');
      const close = descriptor.handle.close.bind(descriptor.handle);
      vi.spyOn(descriptor.handle, 'close').mockImplementation(async () => { await close(); closes++; });
      return descriptor;
    });
    const url = content(first);
    try {
      const stalled = signed(e, 'GET', url).then(() => null, (failure: Error) => failure);
      await backingUp;
      expect((await signed(e, 'GET', url)).body).toEqual({ error: 'attachment-open-busy' });
      triggerDeadline();
      expect(await stalled).toBeInstanceOf(Error);
      await vi.waitFor(() => expect(closes).toBe(1));
      expect((await signed(e, 'GET', url)).status).toBe(200);
    } finally {
      verify.mockRestore();
      timer.mockRestore();
    }
  });

  it('rejects a fifth distinct signed device before opening a file', async () => {
    const { e, contentFor, first } = await contentFixture();
    const owners = [e];
    for (let i = 0; i < 4; i++) {
      const dev = makeDevice();
      const pending = e.pairing.devices.createPending({ deviceName: 'Owner ' + i, label: null, publicKey: dev.publicKey, host: HOST });
      if (!pending.ok) throw new Error('test device setup refused');
      const confirmed = e.pairing.devices.applyConfirm(pending.device.id, { ok: true });
      if (!confirmed) throw new Error('test device missing');
      e.keyLedger.recordActivation(confirmed, 'telegram-dm', new Date().toISOString());
      owners.push({ ...e, dev, deviceId: pending.device.id });
    }
    const realOpen = e.svc.media.openExactLocalAttachment.bind(e.svc.media);
    const releases: Array<() => void> = [];
    let closes = 0;
    let allFourEntered!: () => void;
    const allFour = new Promise<void>(resolve => { allFourEntered = resolve; });
    const file = vi.spyOn(e.svc.media, 'openExactLocalAttachment').mockImplementation(async (...args) => {
      if (releases.length < 4) {
        await new Promise<void>(resolve => {
          releases.push(resolve);
          if (releases.length === 4) allFourEntered();
        });
      }
      const opened = await realOpen(...args);
      if (!opened) throw new Error('test expected a verified attachment');
      const close = opened.handle.close.bind(opened.handle);
      vi.spyOn(opened.handle, 'close').mockImplementation(async () => { await close(); closes++; });
      return opened;
    });
    const urls: string[] = [];
    for (const owner of owners) urls.push((await contentFor(owner))(first));
    const running = owners.slice(0, 4).map((owner, index) => signed(owner, 'GET', urls[index]).then(response => response));
    try {
      await allFour;
      expect((await signed(owners[4], 'GET', urls[4])).body).toEqual({ error: 'attachment-open-busy' });
      expect(file).toHaveBeenCalledTimes(4);
      releases[0]();
      expect((await Promise.race(running)).status).toBe(200);
      await vi.waitFor(() => expect(closes).toBe(1));
      expect((await signed(owners[4], 'GET', urls[4])).status).toBe(200);
    } finally {
      for (const release of releases) release();
      await Promise.all(running);
      file.mockRestore();
    }
  });
});
