/**
 * HTTP pipeline for people and roles (docs/specs/mobile-app-people-and-roles.md): every route
 * through the PRODUCTION auth middleware with the device authenticator. Mint/redeem carry the
 * person; the owner's code message names it; an MSP phone's message reaches the REAL inbound core
 * with the MSP's name and no Telegram id; Slack is owner-only; an MSP sees only its own app
 * conversations; reassign is bearer-only and never raises to owner; an unassigned phone is refused.
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
import {
  MobilePairingService, createMobilePairingRouter, deviceAuthenticator, mountPublicMobilePairingRoutes, type MobilePairingDeps,
} from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { createMobileSlackRouter } from '../../src/server/mobileSlackRoutes.js';
import { createMobileMediaRouter } from '../../src/server/mobileMediaRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import type { AppDispatchInput } from '../../src/core/appInboundDispatch.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const TOPIC = 4242;
const OWNER = 7812716706;
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-app-people-roles.test.ts' });
});

const USERS = [
  { id: 'justin', name: 'Justin', channels: [], permissions: ['user'], telegramUserId: 555 },
  { id: 'ann', name: 'Ann Client', channels: [], permissions: ['user'], telegramUserId: OWNER },
];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpr-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(USERS));
  fs.writeFileSync(path.join(dir, 'topic-session-registry.json'), JSON.stringify({ topicToSession: { [String(TOPIC)]: 'sess-a' } }));
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Ann' },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    mobilePairing: { multiRoute: { enabled: false }, slackOwnerUserId: 'U0OWNER' },
  };
  const spies = { routed: [] as Array<{ content: string; metadata: Record<string, unknown>; userId: string }>, logged: [] as Array<Record<string, unknown>>, mirrors: [] as string[], dms: [] as string[] };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  const fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const deps: MobilePairingDeps = {
    config: config as never, stateDir: dir, holdsLease: () => true, selfMachineId: 'm1', fetchFn,
    tunnel: () => ({ lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' } }),
    ownerDM: async (text) => { spies.dms.push(text); return 1; },
    telegramOwnerId: () => OWNER,
  };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const dispatched: AppDispatchInput[] = [];
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Ann',
    killSession: () => true, onEmergencyStop: () => undefined,
    dispatch: () => async (input) => { dispatched.push(input); svc.channels.register(String(input.alias), 'sess-app'); return 'delivered'; },
  });
  pairing.useAppConversationStore(svc.store);
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: 'm1',
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    sentinel: { decideInboundDisposition: async () => ({ disposition: 'route-through', category: 'normal' }) },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined },
    topicOperatorStore: { setAuthenticatedOperator: () => undefined },
    conversationRegistry: registry, appConversations: svc,
    telegram: {
      getOwnerUserId: () => OWNER,
      getTopicHistory: () => [],
      getAllTopicMappings: () => [{ topicId: TOPIC, topicName: 'Ops', sessionName: 'sess-a' }],
      isAuthorizedSender: () => true,
      logInboundMessage: (e: Record<string, unknown>) => { spies.logged.push(e); },
      getSessionForTopic: () => 'sess-a',
      onTopicMessage: async (m: { content: string; metadata: Record<string, unknown>; userId: string }) => { spies.routed.push(m); },
      sendToTopic: async (_t: number, text: string, o: Record<string, unknown> = {}) => { if (o.operatorMirror) spies.mirrors.push(text); return { messageId: 1, topicId: TOPIC }; },
    },
  } as unknown as RouteContext;
  mountPublicMobilePairingRoutes(app, pairing);
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createRoutes(ctx));
  app.use(createMobileConversationRouter({
    config: config as never, pairing, service: svc, machineId: () => 'm1',
    telegramTopics: () => [{ topicId: TOPIC, topicName: 'Ops', lastActivity: null, lastPreview: null }],
    slackConversations: () => [{ id: -5, title: 'Owner Slack DM', lastActivity: null, lastPreview: null }],
  }));
  app.use(createMobileMediaRouter({ pairing, service: svc, mediaEnabled: true, telegramTopicExists: () => true }));
  app.use(createMobileSlackRouter({ config: config as never, pairing, service: svc, machineId: () => 'm1' } as never));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  return { app, pairing, svc, spies, dispatched, dir };
}
type Env = ReturnType<typeof setup>;

/** Pair a phone straight into the registry (owner, or MSP for a person). */
function phone(e: Env, person?: { userId: string; role: 'msp' }) {
  const dev = makeDevice();
  const c = e.pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
  if (!c.ok) throw new Error('setup');
  e.pairing.devices.applyConfirm(c.device.id, { ok: true });
  return { dev, deviceId: c.device.id };
}

let tick = 0;
function signed(e: Env, p: { dev: ReturnType<typeof makeDevice>; deviceId: string }, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = p.dev.sign(canonicalString(p.deviceId, HOST, method, url, time, raw));
  const base = method === 'GET' ? request(e.app).get(url) : method === 'POST' ? request(e.app).post(url) : method === 'PATCH' ? request(e.app).patch(url) : request(e.app).delete(url);
  const q = base.set('X-Instar-Device', p.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? q.set('Content-Type', 'application/json').send(raw.toString()) : q;
}
const bearer = (e: Env) => ({
  post: (url: string, body: unknown) => request(e.app).post(url).set('Authorization', 'Bearer tok-1').send(body as object),
  get: (url: string) => request(e.app).get(url).set('Authorization', 'Bearer tok-1'),
});
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

describe('people and roles — pairing', () => {
  it('mint refuses a bad role or person before anything else', async () => {
    const e = setup();
    expect((await bearer(e).post('/mobile/pairing-codes', { role: 'admin' })).body.error).toBe('bad-role');
    expect((await bearer(e).post('/mobile/pairing-codes', { role: 'msp' })).body.error).toBe('bad-person');
    expect((await bearer(e).post('/mobile/pairing-codes', { userId: 'nobody', role: 'msp' })).body.error).toBe('bad-person');
    expect((await bearer(e).post('/mobile/pairing-codes', { userId: 'ann', role: 'msp' })).body.error).toBe('bad-person'); // the owner
  });

  it('a link minted for the MSP pairs an MSP phone, and the owner\'s code message names the person', async () => {
    const e = setup();
    const m = await bearer(e).post('/mobile/pairing-codes', { userId: 'justin', role: 'msp' });
    expect(m.status).toBe(200);
    expect(m.body.person).toEqual({ name: 'Justin', role: 'msp', userId: 'justin' });
    const dev = makeDevice();
    const r = await request(e.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'Justin iPhone', devicePublicKey: dev.publicKey });
    expect(r.status).toBe(200);
    expect(e.pairing.devices.get(r.body.deviceId)).toMatchObject({ userId: 'justin', role: 'msp' });
    expect(e.spies.dms[0]).toMatch(/^Your code to pair a phone for Justin \(MSP\) with echo is \d{3} \d{3}\./);
  });

  it('a link minted with no person is the owner\'s, exactly as before', async () => {
    const e = setup();
    const m = await bearer(e).post('/mobile/pairing-codes', {});
    expect(m.body.person).toMatchObject({ role: 'owner', userId: null });
    const dev = makeDevice();
    const r = await request(e.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'x', devicePublicKey: dev.publicKey });
    const d = e.pairing.devices.get(r.body.deviceId)!;
    expect(d.role).toBeUndefined();
    expect(d.userId).toBeUndefined();
    expect(e.spies.dms[0]).toMatch(/Your code to pair a phone with echo is /);
  });

  it('GET /mobile/device reports the person; the owner sees every phone, an MSP only its own', async () => {
    const e = setup();
    const own = phone(e);
    const msp = phone(e, { userId: 'justin', role: 'msp' });
    expect((await signed(e, own, 'GET', '/mobile/device')).body.person).toEqual({ name: 'Ann', role: 'owner' });
    expect((await signed(e, msp, 'GET', '/mobile/device')).body.person).toEqual({ name: 'Justin', role: 'msp' });
    const ownerList = await signed(e, own, 'GET', '/mobile/devices');
    expect(ownerList.body.devices).toHaveLength(2);
    expect(ownerList.body.devices.find((d: { id: string }) => d.id === msp.deviceId)).toMatchObject({ role: 'msp', personName: 'Justin' });
    const mspList = await signed(e, msp, 'GET', '/mobile/devices');
    expect(mspList.body.devices.map((d: { id: string }) => d.id)).toEqual([msp.deviceId]);
  });

  it('reassign is bearer-only and MSP-only; a phone is never raised to owner this way', async () => {
    const e = setup();
    const own = phone(e);
    expect((await signed(e, own, 'POST', `/mobile/devices/${own.deviceId}/person`, { userId: 'justin', role: 'msp' })).status).toBe(403); // not on the device allowlist
    expect((await bearer(e).post(`/mobile/devices/${own.deviceId}/person`, { role: 'owner' })).body.error).toBe('owner-needs-pairing');
    expect((await bearer(e).post(`/mobile/devices/${own.deviceId}/person`, { userId: 'ann', role: 'msp' })).body.error).toBe('bad-person');
    const ok = await bearer(e).post(`/mobile/devices/${own.deviceId}/person`, { userId: 'justin', role: 'msp' });
    expect(ok.body).toEqual({ deviceId: own.deviceId, person: { name: 'Justin', role: 'msp' } });
    // Never a sideways move from one MSP to another (that person may hold owner grants).
    expect((await bearer(e).post(`/mobile/devices/${own.deviceId}/person`, { userId: 'justin', role: 'msp' })).body.error).toBe('repair-needed');
    expect((await bearer(e).post('/mobile/devices/nope/person', { userId: 'justin', role: 'msp' })).status).toBe(404);
  });

  it('a phone whose person was removed is refused everywhere except status, confirm and self-revoke', async () => {
    const e = setup();
    const msp = phone(e, { userId: 'justin', role: 'msp' });
    fs.writeFileSync(path.join(e.dir, 'users.json'), JSON.stringify(USERS.filter((u) => u.id !== 'justin')));
    expect((await signed(e, msp, 'GET', '/telegram/topics')).body.error).toBe('person-unknown');
    expect((await signed(e, msp, 'POST', `/mobile/chat/${TOPIC}`, { text: 'hi', requestId: rid() })).body.error).toBe('person-unknown');
    const st = await signed(e, msp, 'GET', '/mobile/device');
    expect(st.status).toBe(200);
    expect(st.body.person).toEqual({ role: 'msp', unassigned: true });
    expect((await signed(e, msp, 'POST', `/mobile/devices/${msp.deviceId}/revoke`, {})).status).toBe(200);
  });
});

describe('people and roles — messages carry the person', () => {
  it('an owner phone speaks as the owner, unchanged', async () => {
    const e = setup();
    const own = phone(e);
    const r = await signed(e, own, 'POST', `/mobile/chat/${TOPIC}`, { text: 'hello', requestId: rid() });
    expect(r.status).toBe(200);
    expect(e.spies.routed[0]!.userId).toBe(String(OWNER));
    expect(e.spies.routed[0]!.metadata).toMatchObject({ firstName: 'Ann' });
    expect(e.spies.mirrors[0]).toBe('📱 Ann (from the app): hello');
    expect(e.spies.logged[0]).toMatchObject({ telegramUserId: OWNER, senderRole: 'owner' });
  });

  it('an MSP phone speaks with its own name and NO Telegram id — never the owner\'s, never its own', async () => {
    const e = setup();
    const msp = phone(e, { userId: 'justin', role: 'msp' });
    const r = await signed(e, msp, 'POST', `/mobile/chat/${TOPIC}`, { text: 'checking the backups', requestId: rid() });
    expect(r.status).toBe(200);
    const m = e.spies.routed[0]!;
    expect(m.userId).not.toBe(String(OWNER));
    expect(m.userId).not.toBe('555');
    expect(m.metadata).toMatchObject({ firstName: 'Justin' });
    expect(e.spies.mirrors[0]).toBe('📱 Justin (from the app): checking the backups');
    expect(e.spies.logged[0]).toMatchObject({ senderName: 'Justin', senderRole: 'msp', senderPerson: { machineId: 'm1', userId: 'justin' } });
    expect(e.spies.logged[0]!.telegramUserId).toBeUndefined();
    // The stored record carries the sender, so history shows the MSP's name.
    const stored = e.svc.store.browseMessages(`telegram:${TOPIC}`, null, 10).messages;
    expect(stored[0]).toMatchObject({ senderName: 'Justin', senderRole: 'msp' });
  });
});

describe('people and roles — what the MSP may not use', () => {
  it('Slack is owner-only for both routes', async () => {
    const e = setup();
    const msp = phone(e, { userId: 'justin', role: 'msp' });
    expect((await signed(e, msp, 'GET', '/mobile/chat/slack/-5/messages')).body.error).toBe('owner-only');
    const s = await signed(e, msp, 'POST', '/mobile/chat/slack/-5', { text: 'x', requestId: rid() });
    expect(s.status).toBe(403);
    expect(s.body.error).toBe('owner-only');
  });

  it('an MSP sees and uses only its own app conversations; the owner sees both', async () => {
    const e = setup();
    const own = phone(e);
    const msp = phone(e, { userId: 'justin', role: 'msp' });
    const ownerKey = (await signed(e, own, 'POST', '/mobile/conversations', { title: 'Owner private', requestId: rid() })).body.conversationKey as string;
    const mspKey = (await signed(e, msp, 'POST', '/mobile/conversations', { title: 'MSP work', requestId: rid() })).body.conversationKey as string;
    expect(e.svc.store.getConversation(mspKey)!.ownerPerson).toEqual({ machineId: 'm1', userId: 'justin' });
    expect(e.svc.store.getConversation(ownerKey)!.ownerPerson).toBeNull();

    const ids = (r: request.Response) => r.body.conversations.filter((c: { platform: string }) => c.platform === 'app').map((c: { id: string }) => c.id).sort();
    expect(ids(await signed(e, own, 'GET', '/mobile/conversations'))).toEqual([ownerKey, mspKey].sort());
    expect(ids(await signed(e, msp, 'GET', '/mobile/conversations'))).toEqual([mspKey]);
    const platforms = (r: request.Response) => r.body.conversations.map((c: { platform: string }) => c.platform).sort();
    expect(platforms(await signed(e, msp, 'GET', '/mobile/conversations'))).toEqual(['app', 'telegram']); // no Slack row
    expect(platforms(await signed(e, own, 'GET', '/mobile/conversations'))).toEqual(['app', 'app', 'slack', 'telegram']);

    // Every route that names the owner's conversation answers the MSP 404, as for a missing one.
    const refused = [
      await signed(e, msp, 'GET', `/mobile/chat/app/${ownerKey}/messages`),
      await signed(e, msp, 'GET', `/mobile/chat/app/${ownerKey}/events`),
      await signed(e, msp, 'GET', `/mobile/chat/app/${ownerKey}/preview/m1`),
      await signed(e, msp, 'POST', `/mobile/chat/app/${ownerKey}`, { text: 'peek', requestId: rid() }),
      await signed(e, msp, 'PATCH', `/mobile/conversations/${ownerKey}`, { title: 'mine now', requestId: rid() }),
      await signed(e, msp, 'DELETE', `/mobile/conversations/${ownerKey}`, { requestId: rid() }),
      await signed(e, msp, 'GET', `/mobile/media/${'a'.repeat(64)}?ref=app:${ownerKey}`),
      await signed(e, msp, 'POST', '/mobile/media/uploads', { requestId: rid(), conversationRef: `app:${ownerKey}`, size: 3, sha256: 'b'.repeat(64), declaredKind: 'file', declaredType: 'text/plain', filename: 'a.txt' }),
      await signed(e, msp, 'POST', '/mobile/media/uploads', { requestId: rid(), conversationRef: 'slack:T1:C1', size: 3, sha256: 'b'.repeat(64), declaredKind: 'file', declaredType: 'text/plain', filename: 'a.txt' }),
      await signed(e, msp, 'POST', '/mobile/media/purge', { requestId: rid(), conversationKeys: [`telegram:${TOPIC}`, ownerKey] }),
    ];
    for (const r of refused) expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(e.svc.store.getConversation(ownerKey)!.title).toBe('Owner private');

    // The MSP's own conversation works, and its message records the MSP as sender.
    const send = await signed(e, msp, 'POST', `/mobile/chat/app/${mspKey}`, { text: 'patching tonight', requestId: rid() });
    expect(send.status).toBe(200);
    expect(e.dispatched[0]!.ownerName).toBe('Justin');
    const hist = await signed(e, own, 'GET', `/mobile/chat/app/${mspKey}/messages`);
    expect(hist.body.messages[0]).toMatchObject({ text: 'patching tonight', senderName: 'Justin', senderRole: 'msp' });
    expect((await signed(e, own, 'GET', `/mobile/chat/app/${ownerKey}/messages`)).status).toBe(200);
    // The MSP may upload into its own conversation and into a Telegram topic.
    const up = (ref: string) => signed(e, msp, 'POST', '/mobile/media/uploads', { requestId: rid(), conversationRef: ref, size: 3, sha256: 'c'.repeat(64), declaredKind: 'file', declaredType: 'text/plain', filename: 'b.txt' });
    expect((await up(`app:${mspKey}`)).status).toBe(200);
    expect((await up(`telegram:${TOPIC}`)).status).toBe(200);
  });
});

describe('people and roles — the owner can open access to the MSP (§3.5)', () => {
  it('only an owner phone may change a grant; the bearer token and the MSP phone are refused', async () => {
    const e = setup();
    const own = phone(e);
    const msp = phone(e, { userId: 'justin', role: 'msp' });
    expect((await bearer(e).post('/mobile/people/justin/grants', { slack: true })).body.error).toBe('owner-phone-required');
    expect((await signed(e, msp, 'POST', '/mobile/people/justin/grants', { slack: true })).body.error).toBe('owner-phone-required');
    expect((await signed(e, own, 'POST', '/mobile/people/ann/grants', { slack: true })).body.error).toBe('bad-person'); // the owner holds no grant
    expect((await signed(e, own, 'POST', '/mobile/people/justin/grants', { slack: 'yes' })).body.error).toBe('bad-grant');
    expect((await bearer(e).get('/mobile/people')).body.people).toEqual([{ userId: 'justin', name: 'Justin', role: 'msp', phones: 1, grants: { ownerConversations: false, slack: false } }]);
    expect((await signed(e, msp, 'GET', '/mobile/people')).status).toBe(403);
  });

  it('with the grants on, the MSP reaches the owner\'s chats and Slack; turning them off closes them again', async () => {
    const e = setup();
    const own = phone(e);
    const msp = phone(e, { userId: 'justin', role: 'msp' });
    const ownerKey = (await signed(e, own, 'POST', '/mobile/conversations', { title: 'Owner private', requestId: rid() })).body.conversationKey as string;
    expect((await signed(e, msp, 'GET', `/mobile/chat/app/${ownerKey}/messages`)).status).toBe(404);
    expect((await signed(e, msp, 'GET', '/mobile/chat/slack/-5/messages')).body.error).toBe('owner-only');

    const on = await signed(e, own, 'POST', '/mobile/people/justin/grants', { ownerConversations: true, slack: true });
    expect(on.body).toEqual({ userId: 'justin', name: 'Justin', grants: { ownerConversations: true, slack: true } });
    expect((await signed(e, msp, 'GET', `/mobile/chat/app/${ownerKey}/messages`)).status).toBe(200);
    const list = await signed(e, msp, 'GET', '/mobile/conversations');
    expect(list.body.conversations.map((c: { platform: string }) => c.platform).sort()).toEqual(['app', 'slack', 'telegram']);
    // Past the role check: this harness has no Slack bridge, so the next answer is "not configured".
    expect((await signed(e, msp, 'GET', '/mobile/chat/slack/-5/messages?machine=m1')).body.error).toBe('slack-not-configured');

    await signed(e, own, 'POST', '/mobile/people/justin/grants', { ownerConversations: false });
    expect((await signed(e, msp, 'GET', `/mobile/chat/app/${ownerKey}/messages`)).status).toBe(404);
    expect((await signed(e, msp, 'GET', '/mobile/chat/slack/-5/messages?machine=m1')).body.error).toBe('slack-not-configured'); // slack still on
  });
});

