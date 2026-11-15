/**
 * HTTP pipeline for conversation-list pins (docs/specs/conversation-list-pins.md): the production auth
 * middleware with the device authenticator, the real conversation routes and the real pin store. A
 * phone pins; its first list page carries pinnedRefs and full pinnedRows, including a conversation
 * older than the page; a repeat is idempotent; a later page carries no pin fields; an MSP phone cannot
 * pin the owner's conversation (the same 404 as a missing one) and has pins of its own; a Bearer call
 * must name `reader=` and then acts for that person; the cap answers 409; the off switch answers 503
 * and removes the fields.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { ConversationListPinStore } from '../../src/core/ConversationListPins.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const TOPIC = 4242;
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/conversation-list-pins.test.ts' });
});

const USERS = [{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'], telegramUserId: 555 }];

function setup(opts: { maxPerReader?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listpins-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(USERS));
  const config: Record<string, unknown> = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Ann' },
    mobilePairing: { multiRoute: { enabled: false }, native: {} },
  };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true, selfMachineId: 'm1', telegramOwnerId: () => 42 } as MobilePairingDeps;
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Ann',
    killSession: () => true, onEmergencyStop: () => undefined,
    dispatch: () => async (input) => { svc.channels.register(String(input.alias), 'sess-app'); return 'delivered'; },
  });
  cleanups.push(() => svc.stop());
  pairing.useAppConversationStore(svc.store);
  const pins = new ConversationListPinStore({ stateDir: dir, maxPerReader: opts.maxPerReader });
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: 'm1',
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined },
    conversationRegistry: registry, appConversations: svc, mobilePairingService: pairing,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createRoutes(ctx));
  app.use(createMobileConversationRouter({
    config: config as never, pairing, service: svc, machineId: () => 'm1', listPins: pins,
    telegramTopics: () => [{ topicId: TOPIC, topicName: 'Ops', lastActivity: '2020-01-01T00:00:00.000Z', lastPreview: 'old topic' }],
  }));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  return { app, pairing, svc, pins, config };
}
type Env = ReturnType<typeof setup>;

function phone(e: Env, person?: { userId: string; role: 'msp' }) {
  const dev = makeDevice();
  const c = e.pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
  if (!c.ok) throw new Error('setup');
  e.pairing.devices.applyConfirm(c.device.id, { ok: true });
  return { dev, deviceId: c.device.id };
}
let tick = 0;
function signed(e: Env, p: ReturnType<typeof phone>, method: 'GET' | 'POST', url: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = p.dev.sign(canonicalString(p.deviceId, HOST, method, url, time, raw));
  const q = (method === 'GET' ? request(e.app).get(url) : request(e.app).post(url)).set('X-Instar-Device', p.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? q.set('Content-Type', 'application/json').send(raw.toString()) : q;
}
const bearer = (e: Env, method: 'get' | 'post', url: string) => request(e.app)[method](url).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;
async function create(e: Env, p: ReturnType<typeof phone>, title: string) {
  const r = await signed(e, p, 'POST', '/mobile/conversations', { title, requestId: rid() });
  expect(r.status).toBe(200);
  await new Promise((res) => setTimeout(res, 5)); // distinct activity times, so the list order is fixed
  return r.body.conversationKey as string;
}

describe('conversation-list pins — HTTP', () => {
  it('a phone pins; the first page carries pinnedRefs and pinnedRows, even for a conversation older than the page', async () => {
    const e = setup();
    const owner = phone(e);
    const oldest = await create(e, owner, 'Oldest');
    await create(e, owner, 'Middle');
    const newest = await create(e, owner, 'Newest');

    const pin = await signed(e, owner, 'POST', '/mobile/conversations/pins', { ref: `app:${oldest}`, pinned: true });
    expect(pin.status).toBe(200);
    expect(pin.body).toMatchObject({ ok: true, changed: true, pinned: [{ ref: `app:${oldest}`, atMs: expect.any(Number) }] });
    // Idempotent: a repeat writes nothing.
    const again = await signed(e, owner, 'POST', '/mobile/conversations/pins', { ref: `app:${oldest}`, pinned: true });
    expect(again.body).toMatchObject({ ok: true, changed: false });
    expect(e.pins.rows()).toHaveLength(1);
    // A Telegram topic too, pinned later: it leads.
    expect((await signed(e, owner, 'POST', '/mobile/conversations/pins', { ref: `telegram:${TOPIC}`, pinned: true })).status).toBe(200);

    const list = await signed(e, owner, 'GET', '/mobile/conversations?limit=1');
    expect(list.status).toBe(200);
    expect(list.body.conversations.map((r: { id: string }) => r.id)).toEqual([newest]);
    expect(list.body.pinnedRefs.map((p: { ref: string }) => p.ref)).toEqual([`telegram:${TOPIC}`, `app:${oldest}`]);
    expect(list.body.pinnedRows).toMatchObject([
      { id: TOPIC, platform: 'telegram', title: 'Ops', lastPreview: 'old topic' },
      { id: oldest, platform: 'app', title: 'Oldest' },
    ]);
    // A later page carries no pin fields.
    const next = await signed(e, owner, 'GET', `/mobile/conversations?limit=1&cursor=${encodeURIComponent(list.body.nextCursor)}`);
    expect(next.body.pinnedRefs).toBeUndefined();
    expect(next.body.pinnedRows).toBeUndefined();

    // Unpin; a deleted conversation stays in pinnedRefs but has no row.
    expect((await signed(e, owner, 'POST', '/mobile/conversations/pins', { ref: `telegram:${TOPIC}`, pinned: false })).body.pinned).toHaveLength(1);
    e.svc.applyDelete(owner.deviceId, rid(), oldest);
    const after = await signed(e, owner, 'GET', '/mobile/conversations');
    expect(after.body.pinnedRefs.map((p: { ref: string }) => p.ref)).toEqual([`app:${oldest}`]);
    expect(after.body.pinnedRows).toEqual([]);
  });

  it('bad bodies are refused; a missing app conversation is 404', async () => {
    const e = setup();
    const owner = phone(e);
    expect((await signed(e, owner, 'POST', '/mobile/conversations/pins', { ref: 'nonsense', pinned: true })).body.error).toBe('bad-pin');
    expect((await signed(e, owner, 'POST', '/mobile/conversations/pins', { ref: `telegram:${TOPIC}`, pinned: 'yes' })).body.error).toBe('bad-pin');
    const missing = await signed(e, owner, 'POST', '/mobile/conversations/pins', { ref: `app:${crypto.randomUUID()}`, pinned: true });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('unknown-conversation');
  });

  it('a shared person cannot pin a conversation that is not shared with them, and their pins are their own', async () => {
    const e = setup();
    const owner = phone(e);
    const msp = phone(e, { userId: 'justin', role: 'msp' });
    const ownerKey = await create(e, owner, 'Owner only');
    const mspKey = await create(e, msp, 'Justin own');
    const refused = await signed(e, msp, 'POST', '/mobile/conversations/pins', { ref: `app:${ownerKey}`, pinned: true });
    expect(refused.status).toBe(404);
    expect(refused.body.error).toBe('unknown-conversation');
    expect((await signed(e, msp, 'POST', '/mobile/conversations/pins', { ref: `app:${mspKey}`, pinned: true })).status).toBe(200);
    const mine = await signed(e, msp, 'GET', '/mobile/conversations');
    expect(mine.body.pinnedRows.map((r: { id: string }) => r.id)).toEqual([mspKey]);
    // The owner's list is not affected by Justin's pin.
    expect((await signed(e, owner, 'GET', '/mobile/conversations')).body.pinnedRefs).toEqual([]);
    expect(e.pins.pinnedFor('msp:m1:justin')).toHaveLength(1);
  });

  it('a Bearer call must name the reader; then it acts for that person and its list carries their pins', async () => {
    const e = setup();
    const owner = phone(e);
    const key = await create(e, owner, 'Agent pins');
    const noReader = await bearer(e, 'post', '/mobile/conversations/pins').send({ ref: `app:${key}`, pinned: true });
    expect(noReader.status).toBe(400);
    expect(noReader.body.error).toBe('reader-required');
    const ok = await bearer(e, 'post', '/mobile/conversations/pins?reader=owner').send({ ref: `app:${key}`, pinned: true });
    expect(ok.status).toBe(200);
    expect((await signed(e, owner, 'GET', '/mobile/conversations')).body.pinnedRefs.map((p: { ref: string }) => p.ref)).toEqual([`app:${key}`]);
    // The agent's own list read: pin fields only for a named reader.
    expect((await bearer(e, 'get', '/mobile/conversations')).body.pinnedRefs).toBeUndefined();
    expect((await bearer(e, 'get', '/mobile/conversations?reader=owner')).body.pinnedRows.map((r: { id: string }) => r.id)).toEqual([key]);
    // A named person who may not see the conversation gets nothing for it.
    expect((await bearer(e, 'post', '/mobile/conversations/pins?reader=msp:m1:justin').send({ ref: `app:${key}`, pinned: true })).status).toBe(404);
  });

  it('the cap answers 409 pin-limit', async () => {
    const e = setup({ maxPerReader: 1 });
    const owner = phone(e);
    const a = await create(e, owner, 'A');
    const b = await create(e, owner, 'B');
    expect((await signed(e, owner, 'POST', '/mobile/conversations/pins', { ref: `app:${a}`, pinned: true })).status).toBe(200);
    const full = await signed(e, owner, 'POST', '/mobile/conversations/pins', { ref: `app:${b}`, pinned: true });
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({ error: 'pin-limit', pinned: [{ ref: `app:${a}` }] });
  });

  it('the off switch: the pin route answers 503 list-pins-off and the list carries no pin fields', async () => {
    const e = setup();
    const owner = phone(e);
    const key = await create(e, owner, 'Switch');
    expect((await signed(e, owner, 'POST', '/mobile/conversations/pins', { ref: `app:${key}`, pinned: true })).status).toBe(200);
    (e.config.mobilePairing as { native: Record<string, unknown> }).native.listPins = { enabled: false };
    const offPin = await signed(e, owner, 'POST', '/mobile/conversations/pins', { ref: `app:${key}`, pinned: false });
    expect(offPin.status).toBe(503);
    expect(offPin.body.error).toBe('list-pins-off');
    const list = await signed(e, owner, 'GET', '/mobile/conversations');
    expect(list.status).toBe(200);
    expect(list.body.pinnedRefs).toBeUndefined();
    expect(list.body.pinnedRows).toBeUndefined();
  });
});
