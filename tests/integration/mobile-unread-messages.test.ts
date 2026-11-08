/**
 * HTTP pipeline for unread messages (docs/specs/mobile-unread-messages.md §3.5, §10 integration):
 * the production auth middleware with the device authenticator, the real conversation routes and the
 * real marker store. A phone's list carries counts and the page total; the agent's Bearer list carries
 * none; the read route advances, limits, refuses unknown and forbidden conversations with the same
 * answer, accepts a repeat, uses its own bucket, and forwards a mark for a Telegram topic held only on
 * a peer, which lowers that peer's count; the catch-up route is Bearer only and pages to the end; the
 * browse read carries `readUpTo`; a pool list forwards the reader and keeps a peer's Telegram count;
 * unread off ⇒ 503 and no fields.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, personOfReaderKey, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ConversationReadMarkerStore } from '../../src/core/ConversationReadMarkers.js';
import { ConversationUnreadService, type TelegramRowLike } from '../../src/core/ConversationUnreadService.js';
import type { PoolPeerTarget } from '../../src/server/poolPeerFetch.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
const servers: http.Server[] = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(async () => {
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-unread-messages.test.ts' });
});

const t = (ms: number) => new Date(ms).toISOString();
interface Opts { machine?: string; telegram?: TelegramRowLike[]; topics?: number[]; peers?: () => PoolPeerTarget[]; unreadOff?: boolean; unreadEnabled?: { on: boolean } }

function setup(opts: Opts = {}) {
  const machine = opts.machine ?? 'm1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'munread-'));
  dirs.push(dir);
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' },
    mobilePairing: { multiRoute: { enabled: false }, ...(opts.unreadOff ? { native: { unread: { enabled: false } } } : {}) },
  };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => machine, isRecordingEnabled: () => true });
  const bindAuth = createConversationBindAuth(dir);
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true, telegramOwnerId: () => 42 } as MobilePairingDeps;
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const requests = pairing.chatRequests()!;
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => machine, registry, requests, holdsLease: () => true, ownerName: () => 'Justin',
    killSession: () => true, onEmergencyStop: () => undefined,
    dispatch: () => async (input) => { svc.channels.register(String(input.alias), 'sess-app'); return 'delivered'; },
  });
  cleanups.push(() => svc.stop());
  const tgRows: TelegramRowLike[] = opts.telegram ?? [];
  const topics = opts.topics ?? (tgRows.length ? [7] : []);
  const store = new ConversationReadMarkerStore({ stateDir: dir, flushIntervalMs: 5 });
  store.markCatchUpSettled();
  const enabled = opts.unreadEnabled ?? { on: !opts.unreadOff };
  const unread = new ConversationUnreadService({
    store, enabled: () => enabled.on, machineId: () => machine, app: svc.store,
    telegram: topics.length ? { history: (id, limit) => (id === 7 ? tgRows.slice(-limit) : []), version: () => tgRows.length, exists: (id) => topics.includes(id) } : null,
    ownerIdentity: () => pairing.ownerIdentity(), personOfReaderKey: (key) => personOfReaderKey(pairing, key),
    mayUse: (p, ref, op) => pairing.mayUse(p, ref, op ?? 'read'),
    peers: opts.peers, authToken: () => 'tok-1', now: () => 5_000_000,
  });
  cleanups.push(() => unread.stop());
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: machine,
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined },
    conversationRegistry: registry, conversationBindAuth: bindAuth, appConversations: svc, conversationUnread: unread, mobilePairingService: pairing,
    resolvePeerUrls: opts.peers, recordRopeResult: undefined,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createRoutes(ctx));
  app.use(createMobileConversationRouter({
    config: config as never, pairing, service: svc, machineId: () => machine, unread, pool: opts.peers ? (ctx as unknown as { resolvePeerUrls: () => PoolPeerTarget[]; config: typeof config; recordRopeResult: undefined }) as never : undefined,
    telegramTopics: topics.length ? () => topics.map((topicId) => { const last = tgRows[tgRows.length - 1]; return { topicId, topicName: `Topic ${topicId}`, lastActivity: last?.timestamp ?? null, lastPreview: null }; }) : undefined,
  }));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('setup');
  pairing.devices.applyConfirm(c.device.id, { ok: true });
  return { app, dir, svc, store, unread, dev, deviceId: c.device.id, pairing, tgRows, enabled, machine };
}

let tick = 0;
type Env = ReturnType<typeof setup>;
function signed(e: Env, method: 'GET' | 'POST', p: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = e.dev.sign(canonicalString(e.deviceId, HOST, method, p, time, raw));
  const base = method === 'GET' ? request(e.app).get(p) : request(e.app).post(p);
  const q = base.set('X-Instar-Device', e.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? q.set('Content-Type', 'application/json').send(raw.toString()) : q;
}
const bearer = (e: Env, method: 'get' | 'post', p: string) => request(e.app)[method](p).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;
async function create(e: Env, title = 'Weekend plans') {
  const r = await signed(e, 'POST', '/mobile/conversations', { title, requestId: rid() });
  expect(r.status).toBe(200);
  return r.body.conversationKey as string;
}
/** An agent reply appended straight to the store (what POST /app/session-reply does after dispatch). */
function agentReply(e: Env, key: string, text: string, atMs: number) {
  const eventId = `ag-${crypto.randomUUID()}`;
  e.svc.store.append({ kind: 'message', eventId, conversationKey: key, messageId: eventId, role: 'agent', text, at: t(atMs), machineId: e.machine } as never);
  e.unread.invalidate();
  return eventId;
}
function listen(e: Env): Promise<string> {
  return new Promise((resolve) => {
    const s = http.createServer(e.app);
    servers.push(s);
    s.listen(0, '127.0.0.1', () => { const a = s.address() as { port: number }; resolve(`http://localhost:${a.port}`); });
  });
}

describe('unread messages — list fields and totals (§3.5)', () => {
  it('a phone gets counts, readUpTo, the page total; the agent\'s Bearer read gets none; a phone\'s first read sets the baseline', async () => {
    const e = setup();
    const key = await create(e);
    // First phone read: the baseline is set now, so what exists already starts quiet.
    const first = await signed(e, 'GET', '/mobile/conversations');
    expect(first.status).toBe(200);
    expect(e.store.hasBaseline('owner')).toBe(true);
    expect(first.body.conversations[0]).toMatchObject({ id: key, hasUnread: false, unreadCount: 0 });
    expect(first.body).toMatchObject({ unreadTotal: 0, unreadTotalMore: false, unreadBeyondPage: false });
    // Two agent replies after the baseline count; the phone's own message before them does not.
    agentReply(e, key, 'one', 6_000_000);
    agentReply(e, key, 'two', 6_000_001);
    const list = await signed(e, 'GET', '/mobile/conversations');
    expect(list.body.conversations[0]).toMatchObject({ id: key, hasUnread: true, unreadCount: 2, readUpTo: { atMs: 5_000_000, id: '' } });
    expect(list.body).toMatchObject({ unreadTotal: 2, unreadTotalMore: false });
    // The agent reads the same list without read fields.
    const agent = await bearer(e, 'get', '/mobile/conversations');
    expect(agent.status).toBe(200);
    expect(agent.body.conversations[0]).not.toHaveProperty('unreadCount');
    expect(agent.body).not.toHaveProperty('unreadTotal');
    // The browse read carries readUpTo for the phone only.
    const hist = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    expect(hist.body.readUpTo).toEqual({ atMs: 5_000_000, id: '' });
    expect((await bearer(e, 'get', `/mobile/chat/app/${key}/messages`)).body).not.toHaveProperty('readUpTo');
  });

  it('an idle Telegram topic gets a count from the tail the list loads; the owner\'s own Telegram row marks earlier rows read', async () => {
    const tg: TelegramRowLike[] = [
      { messageId: 1, timestamp: t(6_000_000), fromUser: false },
      { messageId: 2, timestamp: t(6_000_100), fromUser: true, telegramUserId: 42 },
      { messageId: 3, timestamp: t(6_000_200), fromUser: false },
      { messageId: 4, timestamp: t(6_000_300), fromUser: true, telegramUserId: 99 },
    ];
    const e = setup({ telegram: tg });
    const list = await signed(e, 'GET', '/mobile/conversations');
    const row = list.body.conversations.find((r: { platform: string }) => r.platform === 'telegram');
    expect(row).toMatchObject({ id: 7, hasUnread: true, unreadCount: 2, readUpTo: { atMs: 6_000_100, id: 'in:2' } });
    expect(list.body.unreadTotal).toBe(2);
  });

  it('unread off: no fields, the read routes answer 503, the list still works', async () => {
    const e = setup({ unreadOff: true });
    const key = await create(e);
    agentReply(e, key, 'one', 6_000_000);
    const list = await signed(e, 'GET', '/mobile/conversations');
    expect(list.status).toBe(200);
    expect(list.body.conversations[0]).not.toHaveProperty('hasUnread');
    expect(list.body).not.toHaveProperty('unreadTotal');
    expect((await signed(e, 'POST', '/mobile/conversations/read', { marks: [{ ref: key, id: 'x', atMs: 1 }] })).status).toBe(503);
    expect((await bearer(e, 'get', '/mobile/conversations/read-markers')).status).toBe(503);
  });
});

describe('unread messages — the read route (§3.5)', () => {
  it('advances to a held message, accepts a repeat, limits a position for a message not held, and answers unknown and forbidden alike', async () => {
    const e = setup();
    const key = await create(e);
    await signed(e, 'GET', '/mobile/conversations'); // baseline
    const a1 = agentReply(e, key, 'one', 6_000_000);
    const a2 = agentReply(e, key, 'two', 6_000_500);
    const r = await signed(e, 'POST', '/mobile/conversations/read', { marks: [{ ref: key, id: a1, atMs: 123, machine: 'm1' }] });
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([{ ref: `app:${key}`, ok: true, readUpTo: { atMs: 6_000_000, id: a1 }, unreadCount: 1 }]);
    expect(e.store.markerFor('owner', `app:${key}`)).toEqual({ atMs: 6_000_000, id: a1 });
    // Repeat: safe, the same answer.
    const again = await signed(e, 'POST', '/mobile/conversations/read', { marks: [{ ref: key, id: a1, atMs: 123 }] });
    expect(again.body.results[0]).toMatchObject({ ok: true, readUpTo: { atMs: 6_000_000, id: a1 } });
    // A message not held here, far in the future: limited to the newest message here.
    const fut = await signed(e, 'POST', '/mobile/conversations/read', { marks: [{ ref: key, id: 'not-here', atMs: 9_000_000_000 }] });
    expect(fut.body.results[0]).toMatchObject({ ok: true, readUpTo: { atMs: 6_000_500, id: a2 }, unreadCount: 0 });
    // The list now reads 0 for the phone.
    const list = await signed(e, 'GET', '/mobile/conversations');
    expect(list.body.conversations[0]).toMatchObject({ unreadCount: 0, hasUnread: false });
    // Unknown conversation and a forbidden one answer the same.
    const ghost = crypto.randomUUID();
    const bad = await signed(e, 'POST', '/mobile/conversations/read', { marks: [{ ref: ghost, id: 'x', atMs: 1 }, { ref: key, id: a2, atMs: 6_000_500 }] });
    expect(bad.body.results[0]).toEqual({ ref: `app:${ghost}`, ok: false, error: 'pending' }); // not held, no machine named ⇒ pending
    expect(bad.body.results[1]).toMatchObject({ ok: true });
    const other = await signed(e, 'POST', '/mobile/conversations/read', { marks: [{ ref: ghost, id: 'x', atMs: 1, machine: 'm1' }] });
    expect(other.body.results[0]).toEqual({ ref: `app:${ghost}`, ok: false, error: 'pending' }); // named this machine, but it is not here either
    // Bad bodies.
    expect((await signed(e, 'POST', '/mobile/conversations/read', { marks: [] })).status).toBe(400);
    expect((await signed(e, 'POST', '/mobile/conversations/read', { marks: [{ ref: 'nope', id: 'x', atMs: 1 }] })).status).toBe(400);
    // The agent's own token must name the reader; an unknown key answers reader-unknown-here per mark.
    expect((await bearer(e, 'post', '/mobile/conversations/read').send({ marks: [{ ref: key, id: a1, atMs: 1 }] })).status).toBe(400);
    const fwd = await bearer(e, 'post', '/mobile/conversations/read?reader=msp%3Am9%3Au1').send({ marks: [{ ref: key, id: a1, atMs: 1 }] });
    expect(fwd.status).toBe(200);
    expect(fwd.body.results[0]).toMatchObject({ ok: false, error: 'reader-unknown-here' });
    const fwdOwner = await bearer(e, 'post', '/mobile/conversations/read?reader=owner').send({ marks: [{ ref: key, id: a2, atMs: 6_000_500 }] });
    expect(fwdOwner.body.results[0]).toMatchObject({ ok: true, readUpTo: { atMs: 6_000_500, id: a2 } });
  });

  it('uses its own bucket: 60 reports a minute, and the shared read allowance is untouched', async () => {
    const e = setup();
    const key = await create(e);
    const a1 = agentReply(e, key, 'one', 6_000_000);
    let limited = 0;
    for (let i = 0; i < 70; i++) if ((await signed(e, 'POST', '/mobile/conversations/read', { marks: [{ ref: key, id: a1, atMs: 1 }] })).status === 429) limited++;
    expect(limited).toBe(10);
    expect((await signed(e, 'GET', '/mobile/conversations')).status).toBe(200);
  });

  it('a mark for a Telegram message held only on a peer is forwarded there once and lowers that peer\'s count', async () => {
    const tg: TelegramRowLike[] = [
      { messageId: 1, timestamp: t(6_000_000), fromUser: false },
      { messageId: 2, timestamp: t(6_000_100), fromUser: false },
      { messageId: 3, timestamp: t(6_000_200), fromUser: false },
    ];
    const peer = setup({ machine: 'm2', telegram: tg });
    peer.store.setBaseline('owner', 0);
    const url = await listen(peer);
    const here = setup({ machine: 'm1', peers: () => [{ machineId: 'm2', url, kind: 'lan' }] });
    await signed(here, 'GET', '/mobile/conversations');
    // Before: the peer counts 3 for the owner.
    expect(peer.unread.rowFields({ key: 'owner', person: personOfReaderKey(peer.pairing, 'owner')!, viaDevice: true }, { platform: 'telegram', id: 7, lastActivity: t(6_000_200) })).toMatchObject({ unreadCount: 3 });
    const r = await signed(here, 'POST', '/mobile/conversations/read', { marks: [{ ref: 'telegram:7', id: 'out:2', atMs: 6_000_100, machine: 'm2' }] });
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toEqual({ ref: 'telegram:7', ok: true, readUpTo: { atMs: 6_000_100, id: 'out:2' }, unreadCount: 1 });
    expect(peer.store.markerFor('owner', 'telegram:7')).toEqual({ atMs: 6_000_100, id: 'out:2' });
    // Naming a machine that is not in the pool ⇒ pending, kept on the phone.
    const none = await signed(here, 'POST', '/mobile/conversations/read', { marks: [{ ref: 'telegram:7', id: 'out:3', atMs: 6_000_200, machine: 'm3' }] });
    expect(none.body.results[0]).toEqual({ ref: 'telegram:7', ok: false, error: 'pending' });
  });

  it('a pool list forwards the reader to the peer and keeps the peer\'s Telegram count; app rows are counted here', async () => {
    const tg: TelegramRowLike[] = [{ messageId: 1, timestamp: t(6_000_000), fromUser: false }, { messageId: 2, timestamp: t(6_000_100), fromUser: false }];
    const peer = setup({ machine: 'm2', telegram: tg });
    peer.store.setBaseline('owner', 0);
    const url = await listen(peer);
    const here = setup({ machine: 'm1', peers: () => [{ machineId: 'm2', url, kind: 'lan' }] });
    const key = await create(here);
    await signed(here, 'GET', '/mobile/conversations');
    agentReply(here, key, 'one', 6_000_000);
    const list = await signed(here, 'GET', '/mobile/conversations?scope=pool');
    expect(list.status).toBe(200);
    const tgRow = list.body.conversations.find((r: { platform: string }) => r.platform === 'telegram');
    expect(tgRow).toMatchObject({ id: 7, machine: 'm2', hasUnread: true, unreadCount: 2 });
    const appRow = list.body.conversations.find((r: { platform: string }) => r.platform === 'app');
    expect(appRow).toMatchObject({ id: key, unreadCount: 1 });
    expect(list.body).toMatchObject({ unreadTotal: 3, unreadTotalMore: false, pool: { failed: [] } });
  });
});

describe('unread messages — the catch-up route (§3.3)', () => {
  it('is Bearer only, pages to the end in recordKey order, and a machine started empty merges every record from one peer', async () => {
    const e = setup();
    for (let i = 1; i <= 5; i++) e.store.advance('owner', `telegram:${i}`, { atMs: i, id: `in:${i}` });
    e.store.setBaseline('owner', 10);
    expect((await signed(e, 'GET', '/mobile/conversations/read-markers')).status).toBe(403); // not on the device allowlist
    const p1 = await bearer(e, 'get', '/mobile/conversations/read-markers?limit=4');
    expect(p1.status).toBe(200);
    expect(p1.body.records).toHaveLength(4);
    const p2 = await bearer(e, 'get', `/mobile/conversations/read-markers?limit=4&cursor=${p1.body.nextCursor}`);
    expect(p2.body.records).toHaveLength(2);
    expect(p2.body.nextCursor).toBeNull();
    // A fresh machine catches up from this one and emits nothing for what it learned.
    const url = await listen(e);
    const fresh = setup({ machine: 'm2', peers: () => [{ machineId: 'm1', url, kind: 'lan' }] });
    const r = await fresh.unread.catchUp();
    expect(r).toMatchObject({ peers: 1, landed: 6, failed: [] });
    expect(fresh.store.markerFor('owner', 'telegram:3')).toEqual({ atMs: 3, id: 'in:3' });
    expect(fresh.store.baselineFor('owner')).toBe(10);
    expect(fresh.store.dueCount()).toBe(0);
    expect(fresh.store.catchUpState('m1')).toMatchObject({ done: true, cursor: null });
  });
});
