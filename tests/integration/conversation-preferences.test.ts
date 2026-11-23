/** Signed HTTP preference writes, immutable retries, personal archive selection and current-reader boundaries. */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf } from '../../src/core/AppRecordSignatures.js';
import { ConversationPreferencesStore } from '../../src/core/ConversationPreferences.js';
import { canonicalPreferenceRef } from '../../src/core/ConversationPreferences.js';
import { ConversationListPinStore } from '../../src/core/ConversationListPins.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const TOPIC = 4242;
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
const servers: http.Server[] = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(async () => {
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/conversation-list-pins.test.ts' });
});

const USERS = [{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'], telegramUserId: 555 }];

function setup(opts: { maxPerReader?: number; pool?: boolean; knownTelegramPeer?: boolean; machine?: string; topicIds?: number[]; telegramChat?: string; poolUrl?: string; poolMachine?: string; poolPeers?: Array<{ machineId: string; url: string; kind: 'lan' }> } = {}) {
  const machine = opts.machine ?? 'm1';
  const topicIds = opts.topicIds ?? [TOPIC];
  const chat = opts.telegramChat ?? '-100';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listpins-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(USERS));
  const config: Record<string, unknown> = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Ann' },
    mobilePairing: { multiRoute: { enabled: false }, native: {} },
  };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => machine, isRecordingEnabled: () => true });
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true, selfMachineId: machine, telegramOwnerId: () => 42 } as MobilePairingDeps;
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => machine, registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Ann',
    killSession: () => true, onEmergencyStop: () => undefined,
    dispatch: () => async (input) => { svc.channels.register(String(input.alias), 'sess-app'); return 'delivered'; },
  });
  cleanups.push(() => svc.stop());
  pairing.useAppConversationStore(svc.store);
  const preferences = new ConversationPreferencesStore({ stateDir: dir });
  const pins = new ConversationListPinStore({ stateDir: dir, maxPerReader: opts.maxPerReader });
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: machine,
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined },
    conversationRegistry: registry, appConversations: svc, mobilePairingService: pairing,
  } as unknown as RouteContext;
  const identityState = { available: true };
  const chief = { pinnedKey: null as string | null, parents: new Map<string, string | null>() };
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createRoutes(ctx));
  app.use(createMobileConversationRouter({
    config: config as never, pairing, service: svc, machineId: () => machine, listPins: pins, preferences, chiefOfStaff: () => chief,
    ...(opts.pool ? { pool: { config: config as never, resolvePeerUrls: () => opts.poolPeers ?? [{ machineId: opts.poolMachine ?? 'm2', url: opts.poolUrl ?? 'http://127.0.0.1:4041', kind: 'lan' as const }] } } : {}),
    preferenceIdentity: () => ({ version: '1', resolve: (raw, row) => {
      if (!identityState.available) return null;
      if (opts.knownTelegramPeer && row?.platform === 'telegram' && row.machine === (opts.poolMachine ?? 'm2') && raw === `telegram:-200:${TOPIC}`) return { ref: raw, accessRef: `telegram:${TOPIC}` };
      if (row?.platform === 'telegram' && raw.startsWith(`telegram:${chat}:`) && topicIds.includes(Number(raw.split(':')[2]))) return { ref: raw, accessRef: `telegram:${raw.split(':')[2]}` };
      if (row?.machine && row.machine !== machine && row.platform !== 'app') return null;
      const match = /^telegram:([1-9][0-9]*)$/.exec(raw);
      const ref = match && topicIds.includes(Number(match[1])) ? `telegram:${chat}:${match[1]}` : canonicalPreferenceRef(raw);
      return ref ? { ref, accessRef: ref.startsWith('app:') ? ref.slice(4) : ref.startsWith('telegram:') ? `telegram:${TOPIC}` : 'slack:' } : null;
    } }),
    telegramTopics: () => topicIds.map((topicId) => ({ topicId, topicName: 'Ops', lastActivity: '2020-01-01T00:00:00.000Z', lastPreview: 'old topic' })),
  }));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  return { app, pairing, svc, pins, config, preferences, chief, identityState, dir };
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
  const q = (method === 'GET' ? request(e.app).get(url) : request(e.app).post(url)).set('Host', HOST).set('X-Instar-Device', p.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
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

describe('personal conversation preferences HTTP', () => {
  it('saves both fields once and retries retain receipt while emission changes independently', async () => {
    const e = setup(); const owner = phone(e); const child = await create(e, owner, 'Personal');
    const body = { requestId: rid(), ref: `app:${child}`, muted: true, archived: true };
    const first = await signed(e, owner, 'POST', '/mobile/conversations/preferences', body);
    expect(first.status).toBe(200); expect(first.body.emission).toEqual({ muted: 'pending', archived: 'pending' });
    e.preferences.applyReserved(e.preferences.prepareOperation('owner', `app:${child}`, { muted: false }));
    const mixed = await signed(e, owner, 'POST', '/mobile/conversations/preferences', body);
    expect(mixed.body.saveReceipt).toEqual(first.body.saveReceipt); expect(mixed.body.emission).toEqual({ muted: 'superseded', archived: 'pending' });
    e.preferences.setReplicationHook(() => 'emitted');
    const eventCount = e.preferences.rows().length;
    const second = await signed(e, owner, 'POST', '/mobile/conversations/preferences', body);
    expect(second.status).toBe(200); expect(second.body.saveReceipt).toEqual(first.body.saveReceipt);
    expect(second.body.emission).toEqual({ muted: 'superseded', archived: 'emitted' });
    expect(second.body.preferences).toEqual({ muted: false, archived: true });
    expect(e.preferences.rows()).toHaveLength(eventCount);
    expect((await signed(e, owner, 'POST', '/mobile/conversations/preferences', { ...body, archived: false })).status).toBe(409);
    fs.writeFileSync(e.preferences.filePath, 'broken'); e.preferences.reload();
    const unavailable = await signed(e, owner, 'POST', '/mobile/conversations/preferences', body);
    expect(unavailable.status).toBe(200); expect(unavailable.body.saveReceipt).toEqual(first.body.saveReceipt);
    expect(unavailable.body.preferences).toBeUndefined(); expect(unavailable.body.emission).toEqual({ muted: 'unavailable', archived: 'unavailable' });
  });
  it('archive selection is reversible, does not escape through ordinary pins and preserves canonical Chief metadata', async () => {
    const e = setup(); const owner = phone(e); const old = await create(e, owner, 'Old'); const fresh = await create(e, owner, 'Fresh'); e.chief.pinnedKey = `app:${fresh}`;
    await signed(e, owner, 'POST', '/mobile/conversations/pins', { ref: `app:${fresh}`, pinned: true });
    expect((await signed(e, owner, 'POST', '/mobile/conversations/preferences', { requestId: rid(), ref: `app:${fresh}`, archived: true })).status).toBe(200);
    const ordinary = await signed(e, owner, 'GET', '/mobile/conversations?limit=1');
    expect(ordinary.body.conversations.map((r: { id: string }) => r.id)).toEqual([old]); expect(ordinary.body.pinnedRows).toEqual([]); expect(ordinary.body.pinnedRefs).toEqual([]); expect(ordinary.body.pinned).toMatchObject({ id: fresh, archived: true });
    const archived = await signed(e, owner, 'GET', '/mobile/conversations?archive=only&limit=1');
    expect(archived.body.conversations).toMatchObject([{ id: fresh, archived: true, muted: false }]);
    expect(e.svc.liveConversation(fresh)).toBeTruthy();
    await signed(e, owner, 'POST', '/mobile/conversations/preferences', { requestId: rid(), ref: `app:${fresh}`, archived: false });
    const restored = await signed(e, owner, 'GET', '/mobile/conversations?limit=1');
    expect(restored.body.conversations[0].id).toBe(fresh); expect(restored.body.pinnedRows[0].id).toBe(fresh);
  });
  it('lost access clearing is checked per field and a mixed request changes neither', async () => {
    const e = setup(); const owner = phone(e); const key = await create(e, owner, 'Mine');
    const person = phone(e, { userId: 'justin', role: 'msp' });
    const reader = 'msp:m1:justin';
    e.preferences.applyReserved(e.preferences.prepareOperation(reader, `app:${key}`, { muted: true }));
    const mixed = await signed(e, person, 'POST', '/mobile/conversations/preferences', { requestId: rid(), ref: `app:${key}`, muted: false, archived: true });
    expect(mixed.status).toBe(404); expect(e.preferences.get(reader, `app:${key}`)).toEqual({ muted: true, archived: false });
    expect((await signed(e, person, 'POST', '/mobile/conversations/preferences', { requestId: rid(), ref: `app:${key}`, muted: false })).status).toBe(200);
  });
  it('the answering pool server selects its captured preferences, never stale peer archive flags', async () => {
    const e = setup({ pool: true }); const owner = phone(e); const key = await create(e, owner, 'Shared');
    e.preferences.applyReserved(e.preferences.prepareOperation('owner', `app:${key}`, { archived: true }));
    const urls: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ conversations: [{ id: key, platform: 'app', title: 'Shared', lastActivity: e.svc.store.getConversation(key)!.createdAt, lastPreview: null, archived: false, muted: true }], nextCursor: null }), { status: 200 });
    });
    try {
      const archived = await signed(e, owner, 'GET', '/mobile/conversations?scope=pool&archive=only');
      expect(archived.status).toBe(200); expect(archived.body.conversations).toMatchObject([{ id: key, archived: true, muted: false }]);
      const ordinary = await signed(e, owner, 'GET', '/mobile/conversations?scope=pool&archive=exclude');
      expect(ordinary.body.conversations.some((r: { id: string }) => r.id === key)).toBe(false);
      expect(urls.every((url) => url.includes('archive=all') && url.includes('reader=owner'))).toBe(true);
    } finally { spy.mockRestore(); }
  });
  it('an unreadable store preserves ordinary authorized chats without inventing current preference values', async () => {
    const e = setup(); const owner = phone(e); const key = await create(e, owner, 'Available history');
    fs.writeFileSync(e.preferences.filePath, 'broken'); e.preferences.reload();
    const list = await signed(e, owner, 'GET', '/mobile/conversations');
    expect(list.status).toBe(200); const row = list.body.conversations.find((r: { id: string }) => r.id === key);
    expect(row).toBeTruthy(); expect(row.archived).toBeUndefined(); expect(row.muted).toBeUndefined();
    expect(list.body).toMatchObject({ preferencesState: 'unavailable', archiveSelectionComplete: false });
    const archived = await signed(e, owner, 'GET', '/mobile/conversations?archive=only'); expect(archived.body.conversations).toEqual([]);
  });
  it('clears a recorded true preference after identity evidence disappears without allowing new settings', async () => {
    const e = setup(); const owner = phone(e); const key = await create(e, owner, 'Formerly readable');
    e.preferences.applyReserved(e.preferences.prepareOperation('owner', `app:${key}`, { muted: true })); e.identityState.available = false;
    expect((await signed(e, owner, 'POST', '/mobile/conversations/preferences', { requestId: rid(), ref: `app:${key}`, muted: false, archived: true })).status).toBe(409);
    expect(e.preferences.get('owner', `app:${key}`)?.muted).toBe(true);
    expect((await signed(e, owner, 'POST', '/mobile/conversations/preferences', { requestId: rid(), ref: `app:${key}`, muted: false })).status).toBe(200);
  });
  it('a reassigned device cannot replay the former reader receipt', async () => {
    const e = setup(); const owner = phone(e); const key = await create(e, owner, 'Personal');
    const body = { requestId: rid(), ref: `app:${key}`, muted: true };
    expect((await signed(e, owner, 'POST', '/mobile/conversations/preferences', body)).status).toBe(200);
    e.pairing.devices.setPerson(owner.deviceId, { userId: 'justin', role: 'msp' });
    const replay = await signed(e, owner, 'POST', '/mobile/conversations/preferences', body);
    expect(replay.status).toBe(409); expect(replay.body.saveReceipt).toBeUndefined();
  });
  it('overlapping physical Telegram topics keep distinct merge identities, opposite archives and cursors', async () => {
    const e = setup({ pool: true, knownTelegramPeer: true }); const owner = phone(e);
    e.preferences.applyReserved(e.preferences.prepareOperation('owner', `telegram:-100:${TOPIC}`, { archived: false }));
    e.preferences.applyReserved(e.preferences.prepareOperation('owner', `telegram:-200:${TOPIC}`, { archived: true }));
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ conversations: [{ id: TOPIC, platform: 'telegram', title: 'Other Forum', lastActivity: '2020-01-01T00:00:00.000Z', lastPreview: null, preferenceRef: `telegram:-200:${TOPIC}` }], nextCursor: null }), { status: 200 }));
    try {
      const all = await signed(e, owner, 'GET', '/mobile/conversations?scope=pool&archive=all');
      expect(all.body.conversations).toHaveLength(2);
      expect(all.body.conversations.map((r: { preferenceRef: string }) => r.preferenceRef).sort()).toEqual([`telegram:-100:${TOPIC}`, `telegram:-200:${TOPIC}`].sort());
      const archived = await signed(e, owner, 'GET', '/mobile/conversations?scope=pool&archive=only');
      expect(archived.body.conversations).toMatchObject([{ machine: 'm2', preferenceRef: `telegram:-200:${TOPIC}`, archived: true }]);
      const ordinary = await signed(e, owner, 'GET', '/mobile/conversations?scope=pool&archive=exclude');
      expect(ordinary.body.conversations).toMatchObject([{ machine: 'm1', preferenceRef: `telegram:-100:${TOPIC}`, archived: false }]);
      const page = await signed(e, owner, 'GET', '/mobile/conversations?scope=pool&archive=all&limit=1');
      const next = await signed(e, owner, 'GET', `/mobile/conversations?scope=pool&archive=all&limit=1&cursor=${encodeURIComponent(page.body.nextCursor)}`);
      expect(next.body.conversations).toHaveLength(1); expect(next.body.conversations[0].preferenceRef).not.toBe(page.body.conversations[0].preferenceRef);
    } finally { spy.mockRestore(); }
  });
  it('an upgraded unknown-namespace peer advances its own equal-time topic cursor across requests', async () => {
    const peer = setup({ machine: 'm2', telegramChat: '-200', topicIds: [43, 42] });
    const server = http.createServer(peer.app); servers.push(server);
    const url = await new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
    const here = setup({ pool: true, poolUrl: url, topicIds: [] }); const owner = phone(here);
    const first = await signed(here, owner, 'GET', '/mobile/conversations?scope=pool&archive=exclude&limit=1');
    expect(first.status).toBe(200); expect(first.body.conversations.map((r: { id: number }) => r.id)).toEqual([43]);
    expect(first.body.conversations[0].archived).toBeUndefined(); expect(first.body.preferencesState).toBe('partial');
    expect(first.body.nextCursor).toContain('telegram:-200:43!holder:m2');
    const second = await signed(here, owner, 'GET', `/mobile/conversations?scope=pool&archive=exclude&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.status).toBe(200); expect(second.body.conversations.map((r: { id: number }) => r.id)).toEqual([42]);
    expect(second.body.nextCursor).toBeNull();
  });
  it('verified shared physical topics are not repeated when local Z wins a tie over peer B', async () => {
    const peer = setup({ machine: 'B', telegramChat: '-200', topicIds: [43, 42] });
    const server = http.createServer(peer.app); servers.push(server);
    const url = await new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
    const here = setup({ machine: 'Z', pool: true, poolMachine: 'B', poolUrl: url, telegramChat: '-200', topicIds: [43, 42] }); const owner = phone(here);
    // Here knows this same forum locally; its independently verified canonical
    // namespaced refs therefore identify both holders as copies, not two chats.
    const peerNamespace = here.identityState;
    expect(peerNamespace.available).toBe(true);
    const first = await signed(here, owner, 'GET', '/mobile/conversations?scope=pool&archive=all&limit=1');
    expect(first.body.conversations.map((r: { id: number }) => r.id)).toEqual([43]);
    expect(first.body.nextCursor).toContain('telegram:-200:43!');
    const second = await signed(here, owner, 'GET', `/mobile/conversations?scope=pool&archive=all&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.conversations.map((r: { id: number }) => r.id)).toEqual([42]); expect(second.body.nextCursor).toBeNull();
  });
  it('unknown holders with identical sort hints retain separate advancing positions', async () => {
    const peers: Array<{ machineId: string; url: string; kind: 'lan' }> = [];
    for (const machineId of ['B', 'C']) {
      const peer = setup({ machine: machineId, telegramChat: '-200', topicIds: [43, 42, 4] });
      const server = http.createServer(peer.app); servers.push(server);
      const url = await new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
      peers.push({ machineId, url, kind: 'lan' });
    }
    const here = setup({ pool: true, poolPeers: peers, topicIds: [] }); const owner = phone(here);
    const seen: string[] = []; let cursor: string | null = null;
    for (let i = 0; i < 6; i++) {
      const result = await signed(here, owner, 'GET', `/mobile/conversations?scope=pool&archive=all&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(result.status).toBe(200); expect(result.body.conversations).toHaveLength(1);
      const row = result.body.conversations[0]; expect(row.preferenceRef).toBeUndefined();
      seen.push(`${row.machine}:${row.id}`); cursor = result.body.nextCursor;
    }
    expect(seen).toEqual(['C:43', 'B:43', 'C:42', 'B:42', 'C:4', 'B:4']); expect(cursor).toBeNull();
  });
  it('a held peer response cannot disclose the former reader settings after device reassignment', async () => {
    const e = setup({ pool: true }); const owner = phone(e);
    const ref = `telegram:-100:${TOPIC}`;
    e.preferences.applyReserved(e.preferences.prepareOperation('owner', ref, { muted: true, archived: true }));
    e.preferences.applyReserved(e.preferences.prepareOperation('msp:m1:justin', ref, { muted: false, archived: false }));
    let entered!: () => void; const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (response: Response) => void; const held = new Promise<Response>((resolve) => { release = resolve; });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { entered(); return held; });
    try {
      const pending = signed(e, owner, 'GET', '/mobile/conversations?scope=pool&archive=all').then((result) => result);
      await waiting;
      e.pairing.devices.setPerson(owner.deviceId, { userId: 'justin', role: 'msp' });
      release(new Response(JSON.stringify({ conversations: [], nextCursor: null }), { status: 200 }));
      const result = await pending;
      expect(result.status).toBe(409); expect(result.body.error).toBe('reader-changed');
      expect(result.body.conversations).toBeUndefined(); expect(result.body.pinnedRows).toBeUndefined(); expect(result.body.preferences).toBeUndefined();
    } finally { spy.mockRestore(); }
  });
  it('an approved browser can use the exact signed preference route and no adjacent path', async () => {
    const e = setup(); const owner = phone(e); const key = await create(e, owner, 'Browser choice');
    const kp = generateSigningKeyPair(); const hash = signerKeyHashOf(kp.publicKey);
    e.pairing.keyLedger = new MobileDeviceKeyLedger({ stateDir: e.dir, signer: { machineId: () => 'm1', signerKeyHash: () => hash, sign: (payload) => ({ machineId: 'm1', signerKeyHash: hash, sig: edSign(payload, kp.privateKey) }) }, keyLookup: (machine, key) => machine === 'm1' && key === hash ? { status: 'ok', publicKeyPem: kp.publicKey } : { status: 'unknown' } });
    const dev = makeDevice(); const pending = e.pairing.devices.createPendingBrowser({ browserPublicKey: dev.publicKey, host: HOST, deviceName: 'Browser', enrollmentId: crypto.randomUUID(), session: crypto.randomUUID(), maxBrowsers: 4, maxSetupsPerHour: 4 });
    if (!pending.ok) throw new Error('browser fixture failed');
    e.pairing.devices.setSetupState(pending.device.id, 'awaiting', 'notifying');
    expect(e.pairing.browser.activate(pending.device.id, 'telegram-dm')).toBe('activated');
    const browser = { dev, deviceId: pending.device.id };
    const result = await signed(e, browser, 'POST', '/mobile/conversations/preferences', { requestId: rid(), ref: `app:${key}`, muted: true });
    expect(result.status).toBe(200); expect(result.body.preferences.muted).toBe(true);
    expect((await signed(e, browser, 'POST', '/mobile/conversations/preferences/extra', { requestId: rid(), ref: `app:${key}`, muted: false })).status).toBe(403);
  });
  it('requires a represented Bearer reader and rejects unknown fields or ambiguous identity', async () => {
    const e = setup(); const owner = phone(e); const key = await create(e, owner, 'Mine');
    expect((await bearer(e, 'post', '/mobile/conversations/preferences').send({ requestId: rid(), ref: `app:${key}`, muted: true })).status).toBe(400);
    expect((await signed(e, owner, 'POST', '/mobile/conversations/preferences', { requestId: rid(), ref: `app:${key}`, muted: true, reader: 'other' })).status).toBe(400);
    expect((await signed(e, owner, 'POST', '/mobile/conversations/preferences', { requestId: rid(), ref: 'slack:m2:-55', archived: true })).status).toBe(409);
    expect((await signed(e, owner, 'GET', '/mobile/conversations?archive=bad')).status).toBe(400);
  });
});
