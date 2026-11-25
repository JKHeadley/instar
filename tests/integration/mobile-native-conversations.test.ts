/**
 * HTTP pipeline for native app conversations (docs/specs/mobile-native-conversations.md,
 * increment 1): every route through the PRODUCTION auth middleware with the device
 * authenticator (allowlist + signature), MobileChatRequestStore idempotency (replay,
 * payload-conflict, outcome-unknown), the emergency stop getting through after the device spent
 * its read allowance, a dispatch failure after persist, token removal, the reply route's
 * 409 not-owner vs accepted, 404s and the recording-disabled 503.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
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
import { admitAppMessageRemoval } from '../../src/server/mobileAppMessageRemovalAdmission.js';
import { MobileChatRequestStore } from '../../src/core/MobileChatRequests.js';
import { AppConversationService, STRANDED_REQUEST_AGE_MS } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import type { AppDispatchInput } from '../../src/core/appInboundDispatch.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { originLeaseDependencyFixture } from '../helpers/originLeaseDependency.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-native-conversations.test.ts' });
});

interface Opts { removalAdmissionProbe?: boolean; forwards?: boolean; reactions?: boolean; machineId?: string; links?: boolean; replies?: boolean; sentinel?: { decideInboundDisposition: () => Promise<{ disposition: string }> }; lease?: { held: boolean }; holdsLease?: () => boolean; recording?: { on: boolean }; dispatchThrows?: boolean; nativeOff?: boolean; dispatchDelayMs?: number }

function setup(opts: Opts = {}) {
  const machineId = opts.machineId ?? 'm1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnative-'));
  dirs.push(dir);
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' },
    // Multi-route off: these tests cover the single paired host (mobile-multi-route.md, flag off).
    mobilePairing: { native: { enabled: !opts.nativeOff, messageLinks: { enabled: opts.links }, quotedReplies: { enabled: opts.replies }, reactions: { enabled: opts.reactions }, forwards: { enabled: opts.forwards } }, multiRoute: { enabled: false } },
  };
  const lease = opts.lease ?? { held: true };
  const recording = opts.recording ?? { on: true };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => machineId, isRecordingEnabled: () => recording.on });
  const bindAuth = createConversationBindAuth(dir);
  const holdsLease = opts.holdsLease ?? (() => lease.held);
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease,
    ...(opts.removalAdmissionProbe ? { peopleMachineId: () => machineId, telegramOwnerId: () => 9000 } : {}) };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = !opts.nativeOff;
  cleanups.push(() => pairing.stop());
  const dispatched: AppDispatchInput[] = [];
  const killed: string[] = [];
  const stopEffects: number[] = [];
  const requests = pairing.chatRequests()!;
  const svc = opts.nativeOff ? null : new AppConversationService({
    stateDir: dir, machineId: () => machineId, registry, requests, holdsLease, ownerName: () => 'Justin',
    killSession: (n) => { killed.push(n); return true; },
    onEmergencyStop: (alias) => { stopEffects.push(alias); },
    dispatch: () => async (input) => {
      if (opts.dispatchDelayMs) await new Promise((r) => setTimeout(r, opts.dispatchDelayMs));
      if (opts.dispatchThrows) throw new Error('spawn exploded');
      dispatched.push(input);
      svc!.channels.register(String(input.alias), 'sess-app');
      return 'delivered';
    },
  });
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: 'm1',
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined },
    conversationRegistry: registry, conversationBindAuth: bindAuth, appConversations: svc,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  // Private harness only: exercise production request authentication on an already allowlisted
  // JSON path. No application router advertises or mounts Delete at this checkpoint.
  if (opts.removalAdmissionProbe && svc) {
    app.post('/mobile/chat/app/:key/forward', (req, res) => {
      const admission = admitAppMessageRemoval(req, pairing, svc);
      res.status(admission.ok ? 200 : admission.status).json(admission);
    });
  }
  app.use(createRoutes(ctx));
  app.use(createMobileConversationRouter({ config: config as never, pairing, service: svc, machineId: () => machineId, sentinel: opts.sentinel, messageLinkOrigin: () => `https://${HOST}` }));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('setup');
  pairing.devices.applyConfirm(c.device.id, { ok: true });
  return { app, dir, svc: svc!, registry, bindAuth, dev, deviceId: c.device.id, dispatched, killed, stopEffects, lease, recording, pairing };
}

let tick = 0;
type Env = ReturnType<typeof setup>;
function signed(e: Env, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', p: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = e.dev.sign(canonicalString(e.deviceId, HOST, method, p, time, raw));
  const base = method === 'GET' ? request(e.app).get(p) : method === 'POST' ? request(e.app).post(p) : method === 'PUT' ? request(e.app).put(p) : method === 'PATCH' ? request(e.app).patch(p) : request(e.app).delete(p);
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

describe('native app conversations — routes', () => {
  it('creates idempotently, refuses a reused id with another payload, lists, renames and deletes', async () => {
    const e = setup();
    const id = rid();
    const a = await signed(e, 'POST', '/mobile/conversations', { title: ' Weekend  "plans" ', requestId: id });
    expect(a.status).toBe(200);
    expect(a.body.title).toBe('Weekend plans');
    const b = await signed(e, 'POST', '/mobile/conversations', { title: 'Weekend "plans"', requestId: id });
    expect(b.body).toEqual(a.body); // same conversation, not a second one
    expect((await signed(e, 'POST', '/mobile/conversations', { title: 'Other', requestId: id })).body.error).toBe('payload-conflict');
    const key = a.body.conversationKey as string;
    expect(e.svc.store.listConversations().conversations).toHaveLength(1);
    const list = await signed(e, 'GET', '/mobile/conversations');
    expect(list.body.conversations[0]).toMatchObject({ id: key, platform: 'app', title: 'Weekend plans' });
    const ren = await signed(e, 'PATCH', `/mobile/conversations/${key}`, { title: 'Trip', requestId: rid() });
    expect(ren.body).toEqual({ conversationKey: key, title: 'Trip' });
    const del = await signed(e, 'DELETE', `/mobile/conversations/${key}`, { requestId: rid() });
    expect(del.body).toEqual({ conversationKey: key, deleted: true });
    expect((await signed(e, 'GET', '/mobile/conversations')).body.conversations).toHaveLength(0);
    expect((await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'hi', requestId: rid() })).status).toBe(404);
  });

  it('enforces the device allowlist (strict UUID) and keeps writes device-only', async () => {
    const e = setup();
    const key = await create(e);
    expect((await signed(e, 'PATCH', '/mobile/conversations/not-a-uuid', { title: 'x', requestId: rid() })).status).toBe(403);
    expect((await signed(e, 'POST', '/mobile/chat/app/abc', { text: 'x', requestId: rid() })).status).toBe(403);
    expect((await bearer(e, 'post', '/mobile/conversations').send({ title: 'x', requestId: rid() })).body.error).toBe('operator-device-required');
    expect((await bearer(e, 'post', `/mobile/chat/app/${key}`).send({ text: 'x', requestId: rid() })).body.error).toBe('operator-device-required');
    expect((await bearer(e, 'get', '/mobile/conversations')).status).toBe(200); // the agent may read
    expect((await bearer(e, 'get', `/mobile/chat/app/${key}/messages`)).status).toBe(200);
    expect((await signed(e, 'PATCH', `/mobile/conversations/${crypto.randomUUID()}`, { title: 'x', requestId: rid() })).status).toBe(404);
  });

  it('sends: persists with the signed origin, dispatches the tagged message, replays the recorded answer', async () => {
    const e = setup();
    const key = await create(e);
    const id = rid();
    const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'hello from the phone', requestId: id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, outcome: 'delivered', deliveryState: 'delivered', conversationKey: key });
    expect(e.dispatched).toHaveLength(1);
    expect(e.dispatched[0]).toMatchObject({ conversationKey: key, title: 'Weekend plans', text: 'hello from the phone', ownerName: 'Justin', originVerdict: 'unknown' });
    expect(e.dispatched[0]!.alias).toBe(e.registry.appAliasFor(key));
    const again = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'hello from the phone', requestId: id });
    expect(again.body).toMatchObject({ ok: true, eventId: r.body.eventId, deliveryState: 'delivered' });
    expect(e.dispatched).toHaveLength(1);
    expect((await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'different', requestId: id })).body.error).toBe('payload-conflict');
    const hist = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    expect(hist.body.messages).toEqual([expect.objectContaining({ role: 'operator', text: 'hello from the phone', deliveryState: 'delivered', originVerified: 'unknown' })]);
    // The stored origin carries what increment 2 needs to re-check the signature.
    const ev = e.svc.store.browseMessages(key, null, 10).messages[0]!;
    expect(ev.origin).toMatchObject({ kind: 'device-signed', deviceId: e.deviceId, host: HOST, method: 'POST', pathWithQuery: `/mobile/chat/app/${key}` });
    expect(Buffer.from(ev.origin!.bodyB64!, 'base64').toString()).toContain('hello from the phone');
    expect(ev.origin!.bodySha256).toBe(crypto.createHash('sha256').update(Buffer.from(ev.origin!.bodyB64!, 'base64')).digest('hex'));
    // The sync read is reachable through the production device authentication.
    const sync = await signed(e, 'GET', `/mobile/chat/app/${key}/events`);
    expect(sync.body.events.map((x: { kind: string }) => x.kind)).toEqual(['created', 'message', 'delivery']);
  });

  it('removes invite/desktop tokens (redacted, never stored) and only signals credential-shaped text', async () => {
    const e = setup();
    const key = await create(e);
    const token = 'tlinv1:secretpartABC.signature_XYZ';
    const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: `join me ${token}`, requestId: rid() });
    expect(r.body).toMatchObject({ ok: true, redacted: true, removed: ['pairing-invite'] });
    expect(e.dispatched[0]!.text).toBe('join me [pairing invite removed]');
    const onDisk = fs.readdirSync(path.join(e.dir, 'app-conversations')).filter((n) => n.endsWith('.jsonl'))
      .map((n) => fs.readFileSync(path.join(e.dir, 'app-conversations', n), 'utf8')).join('');
    expect(onDisk).not.toContain('secretpartABC');
    expect(onDisk).toContain('"redaction"');
    const cred = 'my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
    const c = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: cred, requestId: rid() });
    expect(c.body).toMatchObject({ ok: true, credentialShaped: true });
    expect(e.dispatched[1]!.text).toBe(cred);
  });

  it('an exact emergency stop gets through after the device spent its read allowance, and runs once', async () => {
    const e = setup();
    const key = await create(e);
    await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'start', requestId: rid() });
    let limited = false;
    for (let i = 0; i < 130 && !limited; i++) limited = (await signed(e, 'GET', '/mobile/conversations')).status === 429;
    expect(limited).toBe(true);
    const id = rid();
    const [a, b] = await Promise.all([
      signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'stop everything', requestId: id }),
      signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'stop everything', requestId: id }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect([200, 202]).toContain(statuses[1]);
    expect(e.killed).toEqual(['sess-app']);
    expect(e.stopEffects).toEqual([e.registry.appAliasFor(key)]); // resume queue / autonomous run / operator stop
    const again = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'stop everything', requestId: id });
    expect(again.body).toMatchObject({ outcome: 'sentinel-kill', deliveryState: 'intercepted' });
    expect(e.killed).toEqual(['sess-app']);
  });

  it('a failure after persist is outcome-unknown with the message kept; a later delivery event is read back', async () => {
    const e = setup({ dispatchThrows: true });
    const key = await create(e);
    const id = rid();
    const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'are you there', requestId: id });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('outcome-unknown');
    const msgs = e.svc.store.browseMessages(key, null, 10).messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ text: 'are you there', deliveryState: 'unknown' });
    expect(msgs[0]!.origin?.sig).toBeTruthy();
    expect((await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'are you there', requestId: id })).body.error).toBe('outcome-unknown');
    // A late definite delivery event (e.g. from the owner) makes the lookup stop reading unknown.
    e.svc.appendDelivery(key, msgs[0]!.messageId, 'delivered', 'late');
    const later = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'are you there', requestId: id });
    expect(later.body).toMatchObject({ ok: true, deliveryState: 'delivered' });
  });

  it('a non-owner persists then answers 503 owner-unavailable; recording off refuses create with 503', async () => {
    const e = setup({ lease: { held: false } });
    const key = await create(e);
    const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'hello', requestId: rid() });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('owner-unavailable');
    expect(e.svc.store.browseMessages(key, null, 10).messages).toHaveLength(1);
    expect(e.dispatched).toHaveLength(0);
    e.recording.on = false;
    const c = await signed(e, 'POST', '/mobile/conversations', { title: 'x', requestId: rid() });
    expect(c.status).toBe(503);
    expect(c.body.error).toBe('conversation-recording-disabled');
  });

  it('reply: 409 not-owner without the bind-app binding, accepted on the owner, idempotent by delivery id', async () => {
    const e = setup({ lease: { held: false } });
    const key = await create(e);
    const alias = e.registry.appAliasFor(key)!;
    const token = e.bindAuth.mint('sess-app', [alias]);
    const reply = (deliveryId?: string, text = 'Here is my answer to your question about the weekend.') => {
      const q = bearer(e, 'post', '/app/session-reply').set('X-Instar-Bind-Token', token);
      if (deliveryId) q.set('X-Instar-DeliveryId', deliveryId);
      return q.send({ conversationId: alias, text });
    };
    expect((await reply()).status).toBe(409);
    expect((await bearer(e, 'post', '/app/session-reply').send({ conversationId: alias, text: 'x' })).status).toBe(403); // no bind token
    expect((await bearer(e, 'post', '/app/session-reply').set('X-Instar-Bind-Token', token).send({ conversationId: alias, text: 'x', channelId: 'C1' })).status).toBe(400);
    e.lease.held = true; e.svc.leaseTick(); // acquiring the lease journals bind-app
    const did = crypto.randomUUID();
    const ok = await reply(did);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, conversationKey: key });
    expect((await reply(did)).body).toMatchObject({ ok: true, idempotent: true });
    expect((await reply(crypto.randomUUID())).body).toMatchObject({ suppressed: true }); // exact repeat
    const hist = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    expect(hist.body.messages).toEqual([expect.objectContaining({ role: 'agent', originVerified: 'none' })]);
  });

  it('reply notification preview: the reply text for the device, its notification read token and the agent; nothing else', async () => {
    const e = setup();
    const key = await create(e);
    const alias = e.registry.appAliasFor(key)!;
    e.svc.leaseTick();
    const token = e.bindAuth.mint('sess-app', [alias]);
    const text = 'Here is the plan for Saturday: we leave at nine, stop for breakfast, and are at the lake by noon. Bring a jacket.';
    const r = await bearer(e, 'post', '/app/session-reply').set('X-Instar-Bind-Token', token).send({ conversationId: alias, text });
    expect(r.status).toBe(200);
    const path = `/mobile/chat/app/${key}/preview/${r.body.messageId as string}`;
    const dev = await signed(e, 'GET', path);
    expect(dev.status).toBe(200);
    expect(dev.body.title).toBe('Echo');
    expect(dev.body.body).toBe(`${text.slice(0, 99)}…`);
    // The notification extension has only the read token, never the signing key.
    const read = crypto.randomBytes(32).toString('hex');
    expect(e.pairing.devices.setPush(e.deviceId, { token: 'a'.repeat(64), environment: 'sandbox', notifyTokenHash: crypto.createHash('sha256').update(read).digest('hex'), revision: 1 }).ok).toBe(true);
    const viaRead = await request(e.app).get(path).set('X-Instar-Device', e.deviceId).set('X-Instar-Notify-Token', read);
    expect(viaRead.status).toBe(200);
    expect(viaRead.body.body).toBe(dev.body.body);
    expect((await request(e.app).get(path).set('X-Instar-Device', e.deviceId).set('X-Instar-Notify-Token', 'nope')).status).toBe(401);
    // The read token opens no history and no other conversation route.
    expect((await request(e.app).get(`/mobile/chat/app/${key}/messages`).set('X-Instar-Device', e.deviceId).set('X-Instar-Notify-Token', read)).status).toBe(403);
    expect((await bearer(e, 'get', path)).status).toBe(200);
    // An operator message, an unknown id, a bad key: no preview (the phone keeps "New reply").
    expect((await signed(e, 'GET', `/mobile/chat/app/${key}/preview/am-0000`)).status).toBe(404);
    expect((await bearer(e, 'get', `/mobile/chat/app/not-a-key/preview/am-1`)).status).toBe(400);
  });

  it('is 503 everywhere when native conversations are off, and the Telegram chat route is untouched', async () => {
    const e = setup({ nativeOff: true });
    expect((await signed(e, 'GET', '/mobile/conversations')).status).toBe(503);
    expect((await signed(e, 'POST', '/mobile/conversations', { title: 'x', requestId: rid() })).status).toBe(503);
    expect((await bearer(e, 'post', '/app/session-reply').send({ conversationId: -5, text: 'x' })).status).toBe(503);
    expect((await signed(e, 'POST', '/mobile/chat/1', { text: 'x', requestId: rid() })).body.error).toBe('chat-unavailable');
  });
});

describe('native app conversations — a Telegram-free agent keeps its own lease', () => {
  // A real fenced lease on a single-machine, non-development agent with no Telegram config:
  // only the app-conversations dependency (or nothing) keeps it renewed.
  async function leased(dependency: string | undefined) {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const clock = { value: Date.now() };
    const h = await originLeaseDependencyFixture({ clock, ...(dependency ? { dependency } : { enroll: false, sharedStore: true }) });
    const advance = async (ms: number) => { clock.value += ms; await vi.advanceTimersByTimeAsync(ms); };
    return { h, advance };
  }

  it('accepts an app message after the lease TTL has passed', async () => {
    const { h, advance } = await leased('app-conversations');
    try {
      const e = setup({ holdsLease: () => h.coordinator.holdsLease() });
      const key = await create(e);
      await advance(30_000); await advance(30_000); await advance(10_000); // past the 60 s TTL
      const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'hello without telegram', requestId: rid() });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, outcome: 'delivered' });
      expect(h.lc.currentEpoch()).toBe(1);
    } finally { await h.close(); vi.useRealTimers(); }
  });

  it('REPRODUCTION: on a shared store with no renewal dependency the same message gets 503 owner-unavailable', async () => {
    const { h, advance } = await leased(undefined);
    try {
      const e = setup({ holdsLease: () => h.coordinator.holdsLease() });
      const key = await create(e);
      await advance(30_000); await advance(30_000); await advance(10_000);
      const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'hello without telegram', requestId: rid() });
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('owner-unavailable');
    } finally { await h.close(); vi.useRealTimers(); }
  });
});


describe('signed exact App message links', () => {
  it('returns recent and off-page fixtures, masking denied and removed targets alike', async () => {
    const e = setup({ links: true });
    await new MachineIdentityManager(e.dir).generateIdentity({ name: 'exact link test machine' });
    e.pairing.keyLedger = new MobileDeviceKeyLedger({ stateDir: e.dir, signer: loadMachineSigner(e.dir)!, keyLookup: identityKeyLookup(e.dir) });
    const key = await create(e);
    const lookup = (id: string) => signed(e, 'GET', `/mobile/conversations/message-link?ref=app%3A${key}&messageId=${id}&targetKind=event`);
    const context = (id: string) => signed(e, 'GET', `/mobile/chat/app/${key}/message-context?target=${id}&targetKind=event&limit=2`);
    for (let i = 0; i < 55; i++) {
      const n = String(i).padStart(2, '0');
      e.svc.store.append({ kind: 'message', eventId: `event-${n}`, messageId: `message-${n}`, conversationKey: key,
        machineId: 'm1', at: new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString(), role: 'agent', text: `Message ${n}` });
    }
    const automatic = await signed(e, 'GET', `/mobile/chat/app/${key}/messages?limit=50`);
    expect(automatic.body.messages.some((m: { eventId: string }) => m.eventId === 'event-02')).toBe(false);
    const list = await signed(e, 'GET', '/mobile/conversations');
    expect(list.body.conversations[0].messageActions).toMatchObject({ copyLink: true, exactContext: true, visibility: expect.any(String) });
    for (const n of ['54', '02']) {
      const link = await lookup(`event-${n}`);
      expect(link.status, JSON.stringify(link.body)).toBe(200);
      expect(link.body).toMatchObject({ ref: `app:${key}`, messageId: `message-${n}`, servedBy: 'm1',
        url: `https://${HOST}/dashboard/console/message-link-v1/#/work/chats?c=app%3A${key}&e=event-${n}`,
        position: { eventId: `event-${n}` } });
      const page = await context(`event-${n}`);
      expect(page.status).toBe(200);
      expect(page.body.anchorApplied).toEqual({ requestedTarget: `event-${n}`, messageId: `message-${n}`, eventId: `event-${n}` });
      expect(page.body.messages.at(-1).eventId).toBe(`event-${n}`);
      expect(page.body.nextBefore).toBeNull();
      const { at, eventId } = page.body.nextContextBefore;
      const continued = await signed(e, 'GET', `/mobile/chat/app/${key}/message-context?beforeAt=${encodeURIComponent(at)}&beforeEventId=${eventId}`);
      expect(continued.status).toBe(200);
      expect(continued.body.contextApplied).toEqual({ at, eventId });
    }
    const canRead = e.pairing.mayReadStored.bind(e.pairing);
    const spy = vi.spyOn(e.pairing, 'mayReadStored').mockImplementation((person, ref, row) =>
      (row as { eventId?: string }).eventId !== 'event-20' && canRead(person, ref, row));
    try {
      for (const id of ['event-20', 'event-removed']) {
        for (const response of [await lookup(id), await context(id)]) {
          expect(response.status).toBe(409);
          expect(response.body).toEqual({ error: 'message-not-available-here', retryable: true, scope: 'held-source' });
        }
      }
    } finally { spy.mockRestore(); }
  });

  it('keeps both exact routes dark by default and leaves ordinary history available', async () => {
    const e = setup();
    const key = await create(e);
    const r = await signed(e, 'GET', `/mobile/conversations/message-link?ref=app%3A${key}&messageId=event-a`);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('message-link-unavailable');
    expect((await signed(e, 'GET', `/mobile/chat/app/${key}/message-context?target=event-a`)).status).toBe(503);
    expect((await signed(e, 'GET', `/mobile/chat/app/${key}/messages`)).status).toBe(200);
  });
});

it('keeps stored Reply relation and machine proof out of ordinary native history and sync', async () => {
  const e = setup();
  const key = await create(e);
  const at = new Date().toISOString();
  const replyTo = { conversationKey: `app:${key}`, eventId: 'private-original-event', messageId: 'private-original-message' };
  const base = { conversationKey: key, eventId: 'reply-event', messageId: 'reply-message', kind: 'message',
    role: 'operator', text: 'Visible reply text', at, machineId: 'm1', receivedAt: at, replyTo } as const;
  expect(e.svc.store.append({ ...base, receipt: { v: 3, machineId: 'm1', sig: 'opaque', signerKeyHash: '0'.repeat(64),
    conversationKey: `app:${key}`, eventId: base.eventId, messageId: base.messageId, replyTo } }).appended).toBe(true);
  for (const route of ['messages', 'events']) {
    const result = await signed(e, 'GET', `/mobile/chat/app/${key}/${route}`);
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).toContain('Visible reply text');
    expect(JSON.stringify(result.body)).not.toContain('private-original');
    expect(JSON.stringify(result.body)).not.toContain('"receipt"');
  }
});


async function enableReplyProof(e: Env) {
  await new MachineIdentityManager(e.dir).generateIdentity({ name: 'quoted reply test machine' });
  const signer = loadMachineSigner(e.dir)!;
  const keyLookup = identityKeyLookup(e.dir);
  const ledger = new MobileDeviceKeyLedger({ stateDir: e.dir, signer, keyLookup });
  e.pairing.keyLedger = ledger;
  e.svc.deps.signer = signer;
  e.svc.deps.keyLedger = ledger;
  e.svc.deps.keyLookup = keyLookup;
  ledger.recordActivation(e.pairing.devices.get(e.deviceId)!, 'telegram-dm', new Date(Date.now() - 1000).toISOString());
}

describe('signed native App Reply admission', () => {
  it('keeps the route off by default and the ordinary send path rejects the quote field', async () => {
    const e = setup();
    const key = await create(e);
    const body = { text: 'Reply text', requestId: rid(), replyTo: { eventId: 'original-event' } };
    expect((await signed(e, 'POST', `/mobile/chat/app/${key}/reply`, body)).body.error).toBe('quoted-replies-unavailable');
    expect((await signed(e, 'POST', `/mobile/chat/app/${key}`, body)).body.error).toBe('invalid-reply-reference');
    expect(e.dispatched).toHaveLength(0);
  });

  it('accepts a signed quote exactly once, verifies its receipt, and masks an absent original', async () => {
    const e = setup({ replies: true, links: true });
    await enableReplyProof(e);
    const key = await create(e);
    e.svc.store.append({ conversationKey: key, eventId: 'original-event', messageId: 'original-message', kind: 'message',
      role: 'agent', text: 'Original', at: new Date().toISOString(), machineId: 'm1' });
    const list = await signed(e, 'GET', '/mobile/conversations');
    expect(list.body.conversations[0].messageActions).toMatchObject({ reply: true });
    const route = `/mobile/chat/app/${key}/reply`;
    const send = (body: unknown) => signed(e, 'POST', route, body);
    const body = { text: 'Reply text', requestId: rid(), replyTo: { eventId: 'original-event' } };
    const missing = await send({ ...body, requestId: rid(), replyTo: { eventId: 'missing-event' } });
    expect(missing.status).toBe(409);
    expect(missing.body).toEqual({ error: 'reply-source-unavailable', retryable: true });
    const result = await send(body);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.replyMirror).toEqual({ state: 'not-applicable', reason: 'app-only' });
    const duplicate = await send(body);
    expect(duplicate.body).toEqual(result.body);
    const different = await send({ ...body, replyTo: { eventId: 'different-original' } });
    expect(different.status).toBe(409);
    expect(different.body.error).toBe('payload-conflict');
    const changedText = await send({ ...body, text: 'Different text' });
    expect(changedText.status).toBe(409);
    expect(changedText.body.error).toBe('payload-conflict');
    expect(e.dispatched).toHaveLength(1);
    const stored = e.svc.store.getEvent(key, result.body.eventId);
    expect(stored).toMatchObject({ replyTo: { eventId: 'original-event', messageId: 'original-message' }, receipt: { v: 3 } });
    if (stored?.kind !== 'message') throw new Error('quoted reply not stored');
    expect(e.svc.verify(stored)).toBe('verified');
    if (!stored.replyTo) throw new Error('quoted reply relation not stored');
    expect(e.svc.verify({ ...stored, replyTo: { ...stored.replyTo, eventId: 'different-original' } })).toBe('failed');
    const refreshPath = `/mobile/chat/app/${key}/reply-previews?eventId=${encodeURIComponent(result.body.eventId)}`;
    const available = { state: 'available', eventId: 'original-event', messageId: 'original-message', preview: 'Original', senderName: null };
    const refresh = await signed(e, 'GET', refreshPath);
    expect(refresh.status).toBe(200);
    expect(refresh.body).toEqual({ conversationKey: key, messages: [{ eventId: result.body.eventId, reply: available }] });
    expect(refresh.headers['cache-control']).toBe('no-store');
    const batch = await signed(e, 'GET', refreshPath + '&eventId=unknown-reply-base');
    expect(batch.body.messages).toEqual([{ eventId: result.body.eventId, reply: available }, { eventId: 'unknown-reply-base' }]);
    expect((await signed(e, 'GET', refreshPath + '&eventId=' + encodeURIComponent(result.body.eventId))).status).toBe(400);
    expect((await bearer(e, 'get', refreshPath)).status).toBe(403);
    const context = await signed(e, 'GET', `/mobile/chat/app/${key}/message-context?target=${encodeURIComponent(result.body.eventId)}&targetKind=event`);
    expect(context.body.messages.find((row: { eventId: string }) => row.eventId === result.body.eventId).reply).toEqual(available);
    const history = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    expect(history.body.messages.find((row: { eventId: string }) => row.eventId === result.body.eventId).reply).toEqual(available);
    const exactRead = e.svc.store.exactMessageCandidates.bind(e.svc.store);
    const altered = vi.spyOn(e.svc.store, 'exactMessageCandidates').mockImplementation((ref, id, kind) =>
      exactRead(ref, id, kind).map((row) => id === 'original-event' ? { ...row, origin: stored.origin } : row));
    try {
      expect((await signed(e, 'GET', refreshPath)).body.messages)
        .toEqual([{ eventId: result.body.eventId, reply: { state: 'unavailable' } }]);
    } finally { altered.mockRestore(); }
    const currentPolicy = e.pairing.mayReadStored.bind(e.pairing);
    const revokeOriginal = vi.spyOn(e.pairing, 'mayReadStored').mockImplementation((person, ref, row) =>
      (row as { eventId?: string }).eventId !== 'original-event' && currentPolicy(person, ref, row));
    try {
      const denied = await send({ ...body, requestId: rid() });
      expect(denied.status).toBe(missing.status);
      expect(denied.body).toEqual(missing.body);
      expect((await send(body)).body).toEqual(result.body);
      const privatePreview = await signed(e, 'GET', refreshPath);
      expect(privatePreview.body.messages).toEqual([{ eventId: result.body.eventId, reply: { state: 'unavailable' } }]);
      expect(JSON.stringify(privatePreview.body)).not.toContain('original-event');
      expect(e.dispatched).toHaveLength(1);
    } finally { revokeOriginal.mockRestore(); }
    e.pairing.deps.config.mobilePairing!.chat = { enabled: false };
    expect((await signed(e, 'GET', '/mobile/conversations')).body.conversations[0].messageActions?.reply).toBeUndefined();
    expect((await signed(e, 'GET', refreshPath)).body.messages[0].reply).toEqual(available);
    e.pairing.deps.config.mobilePairing!.native!.quotedReplies!.enabled = false;
    const disabled = await signed(e, 'GET', refreshPath);
    expect(disabled.status).toBe(503);
    expect(disabled.body.error).toBe('quoted-replies-unavailable');
    const disabledHistory = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    expect(disabledHistory.body.messages.find((row: { eventId: string }) => row.eventId === result.body.eventId)).not.toHaveProperty('reply');
    expect((await signed(e, 'GET', '/mobile/conversations')).body.conversations[0].messageActions?.reply).toBeUndefined();

  });

  it('refuses a fresh serving machine before it can claim or classify a replicated conversation Reply', async () => {
    const origin = setup({ replies: true });
    let classified = 0;
    const peer = setup({ replies: true, machineId: 'm2', sentinel: { decideInboundDisposition: async () => {
      classified++; return { disposition: 'kill' };
    } } });
    await enableReplyProof(origin);
    await enableReplyProof(peer);
    const key = await create(origin);
    const created = origin.svc.store.getCreationRecord(key)!;
    expect(created.machineId).toBe('m1');
    peer.svc.ingestReplicated([created]);
    expect(peer.svc.deps.holdsLease()).toBe(true);
    expect(peer.svc.currentOwner(key)).toBe(true);
    const requestId = rid();
    const response = await signed(peer, 'POST', `/mobile/chat/app/${key}/reply`,
      { text: 'Stop this task', requestId, replyTo: { eventId: 'original-event' } });
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('reply-custody-unavailable');
    expect(classified).toBe(0);
    expect(peer.stopEffects).toHaveLength(0);
    expect(peer.dispatched).toHaveLength(0);
  });

  it('blocks a fresh request on the creation machine after lease loss before classification', async () => {
    let classified = 0;
    const e = setup({ replies: true, sentinel: { decideInboundDisposition: async () => {
      classified++; return { disposition: 'kill' };
    } } });
    await enableReplyProof(e);
    const key = await create(e);
    e.lease.held = false;
    const response = await signed(e, 'POST', `/mobile/chat/app/${key}/reply`,
      { text: 'Stop this task', requestId: rid(), replyTo: { eventId: 'original-event' } });
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('owner-unavailable');
    expect(classified).toBe(0);
    expect(e.stopEffects).toHaveLength(0);
  });

  it.each([true, false, null, 'read-failure'])('stops live work and reports held-work confirmation only when cleared (%s)', async (clears) => {
    const e = setup({ replies: true });
    await enableReplyProof(e);
    const key = await create(e);
    const held = new Set([`app:${key}`]);
    let dropCount = 0;
    if (clears !== null) e.svc.deps.stopHeldConfirmed = (ref) => {
      dropCount++;
      if (clears === true || clears === 'read-failure') held.delete(ref);
      if (clears === 'read-failure') throw new Error('injected durable queue read failure');
      return !held.has(ref);
    };
    const route = `/mobile/chat/app/${key}/reply`;
    const requestId = rid();
    const body = { text: 'stop', requestId, replyTo: { malformed: 'ignored for Stop' } };
    const response = await signed(e, 'POST', route, body);
    expect(response.status).toBe(clears === true ? 200 : 503);
    expect(response.body.outcome ?? response.body.error).toBe(clears === true ? 'sentinel-kill' : 'stop-not-confirmed');
    expect(held.has(`app:${key}`)).toBe(clears === false || clears === null);
    expect(response.body).not.toHaveProperty('messageId');
    expect(e.stopEffects).toHaveLength(1);
    expect((await signed(e, 'POST', route, body)).body).toEqual(response.body);
    expect(dropCount).toBe(clears === null ? 0 : 1);
    expect(e.stopEffects).toHaveLength(1);
    expect(e.svc.store.browseMessages(key, null).messages).toHaveLength(0);
  });

  it.each(['reserved', 'queue-stopped', 'live-stopped'])('recovers an interrupted quoted Stop without replaying effects (%s)', async (phase) => {
    const e = setup({ replies: true });
    const key = await create(e);
    const requestId = rid();
    const hash = 'request-hash';
    let time = Date.now();
    const initial = new MobileChatRequestStore(e.dir, () => time);
    expect(initial.reserve(e.deviceId, requestId, hash, 0,
      { op: 'app-reply-stop', conversationKey: key, messageId: 'never-appended' }).kind).toBe('reserved');
    let queueEffects = 0;
    e.svc.deps.stopHeldConfirmed = () => { queueEffects++; return true; };
    if (phase !== 'reserved') e.svc.deps.stopHeldConfirmed(`app:${key}`);
    if (phase === 'live-stopped') e.svc.emergencyStop(key);
    time += STRANDED_REQUEST_AGE_MS + 1;
    e.svc.deps.requests = new MobileChatRequestStore(e.dir, () => time);
    e.svc.recoverStranded();
    expect(e.svc.deps.requests.lookup(e.deviceId, requestId, hash)).toMatchObject({
      kind: 'done', status: 503, body: { error: 'stop-not-confirmed' },
    });
    expect(e.stopEffects).toHaveLength(phase === 'live-stopped' ? 1 : 0);
    expect(queueEffects).toBe(phase === 'reserved' ? 0 : 1);
  });

  it('claims the request before semantic Stop and refuses its effect after the device is revoked', async () => {
    let release!: (value: { disposition: string }) => void;
    let entered!: () => void;
    const classifying = new Promise<void>((resolve) => { entered = resolve; });
    const e = setup({ replies: true, sentinel: { decideInboundDisposition: () => {
      entered();
      return new Promise((resolve) => { release = resolve; });
    } } });
    await enableReplyProof(e);
    const key = await create(e);
    const route = `/mobile/chat/app/${key}/reply`;
    const body = { text: 'Please stop running this task', requestId: rid(), replyTo: { eventId: 'missing-event' } };
    const pending = signed(e, 'POST', route, body).then((result) => result);
    await classifying;
    try {
      const conflict = await signed(e, 'POST', route, { ...body, text: 'Conflicting text' });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toBe('payload-conflict');
      e.pairing.devices.revoke(e.deviceId, new Date().toISOString());
    } finally { release({ disposition: 'kill' }); }
    expect((await pending).status).toBe(403);
    expect(e.stopEffects).toHaveLength(0);
    expect(e.dispatched).toHaveLength(0);
  });
});


describe('signed App message reactions', () => {
  it('is off by default', async () => {
    const e = setup();
    const key = await create(e);
    const r = await signed(e, 'PUT', `/mobile/chat/app/${key}/reactions`,
      { eventId: 'base', emoji: '👍', expectedRevision: 0, requestId: rid() });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('reactions-unavailable');
  });

  it('serializes one actor across devices and recovers terminal and appended retries', async () => {
    const e = setup({ reactions: true });
    await enableReplyProof(e);
    const key = await create(e);
    const second = makeDevice();
    const pending = e.pairing.devices.createPending({ deviceName: 'Second phone', label: null, publicKey: second.publicKey, host: HOST });
    if (!pending.ok) throw new Error('second pairing');
    e.pairing.devices.applyConfirm(pending.device.id, { ok: true });
    e.pairing.keyLedger!.recordActivation(e.pairing.devices.get(pending.device.id)!, 'telegram-dm', new Date(Date.now() - 1000).toISOString());
    const other = { ...e, deviceId: pending.device.id, dev: second };
    for (const eventId of ['base', 'other-base']) e.svc.store.append({
      conversationKey: key, eventId, messageId: 'msg-' + eventId, kind: 'message', role: 'agent',
      text: 'Original', at: new Date().toISOString(), machineId: 'm1',
    });
    const route = `/mobile/chat/app/${key}/reactions`;
    const change = (env: Env, fields: { eventId?: string; emoji: string | null; expectedRevision: number; requestId: string }) =>
      signed(env, 'PUT', route, { eventId: 'base', ...fields });
    const exactRead = e.svc.store.exactMessageCandidates.bind(e.svc.store);
    const ambiguous = vi.spyOn(e.svc.store, 'exactMessageCandidates').mockImplementation((ref, id, kind) =>
      id === 'base' ? [...exactRead(ref, id, kind), ...exactRead(ref, 'other-base', kind)] : exactRead(ref, id, kind));
    try {
      expect((await change(e, { emoji: '👍', expectedRevision: 0, requestId: rid() })).body)
        .toEqual({ error: 'reaction-target-unavailable' });
    } finally { ambiguous.mockRestore(); }
    const noop = { emoji: null, expectedRevision: 0, requestId: rid() };
    expect((await change(e, noop)).body.own).toEqual({ emoji: null, revision: 0 });
    const candidates = [ { emoji: '👍', expectedRevision: 0, requestId: rid() }, { emoji: '❤️', expectedRevision: 0, requestId: rid() } ];
    const results = await Promise.all([change(e, candidates[0]!), change(other, candidates[1]!)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)!;
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body).toMatchObject({ error: 'reaction-revision-conflict', own: winner.body.own });
    expect((await change(other, noop)).body.own).toEqual({ emoji: null, revision: 0 });
    const clear = { emoji: null, expectedRevision: 1, requestId: rid() };
    const finish = vi.spyOn(e.svc.deps.requests, 'finish').mockImplementation((actor, requestId) => {
      e.svc.deps.requests.markUnknown(actor, requestId);
      return false;
    });
    try { expect((await change(e, clear)).body.own).toEqual({ emoji: null, revision: 2 }); }
    finally { finish.mockRestore(); }
    e.svc.deps.requests = new MobileChatRequestStore(e.dir);
    expect((await change(other, clear)).body.own).toEqual({ emoji: null, revision: 2 });
    const sharedId = rid();
    const cross = await Promise.all([
      change(e, { eventId: 'base', emoji: '🎉', expectedRevision: 2, requestId: sharedId }),
      change(other, { eventId: 'other-base', emoji: '🎉', expectedRevision: 0, requestId: sharedId }),
    ]);
    expect(cross.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(cross.find((r) => r.status === 409)!.body.error).toBe('payload-conflict');
    const held = await signed(other, 'GET', route + '?eventId=base');
    expect(held.status).toBe(200);
    expect(held.body).toEqual({ eventId: 'base', own: e.svc.store.ownReaction(key, 'base', 'owner') });
    const facts = e.svc.store.syncEvents(key, null).events.filter((row) => row.kind === 'reaction');
    expect(facts).toHaveLength(3);
    const history = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    expect(history.body.messages).toHaveLength(2);
    expect(history.body.messages.find((m: { eventId: string }) => m.eventId === 'base').reaction.own.revision).toBeGreaterThanOrEqual(2);
    const sync = await signed(e, 'GET', `/mobile/chat/app/${key}/events`);
    expect(JSON.stringify(sync.body)).not.toContain('reactionActor');
    expect(e.dispatched).toHaveLength(0);
  });
});


describe('signed App message forwarding', () => {
  it('starts disabled', async () => {
    const e = setup();
    const sourceConversationKey = await create(e);
    const destination = await create(e);
    const r = await signed(e, 'POST', `/mobile/chat/app/${destination}/forward`,
      { custodianMachineId: 'm1', sourceConversationKey, sourceEventId: 'original', requestId: rid() });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('forwards-unavailable');
  });

  it('copies Stop text once without invoking agent or control paths, including after restart', async () => {
    const classifier = vi.fn(async () => ({ disposition: 'kill' }));
    const e = setup({ forwards: true, sentinel: { decideInboundDisposition: classifier } });
    await enableReplyProof(e);
    const sourceConversationKey = await create(e);
    const destination = await create(e);
    const alternate = await create(e);
    const sourceEventId = 'exact-original';
    e.svc.store.append({ kind: 'message', conversationKey: sourceConversationKey, eventId: sourceEventId,
      messageId: 'original-msg', role: 'agent', text: 'Stop', at: new Date().toISOString(), machineId: 'm1' });
    const body = { custodianMachineId: 'm1', sourceConversationKey, sourceEventId, requestId: rid() };
    const forward = (key = destination, params = body) =>
      signed(e, 'POST', `/mobile/chat/app/${key}/forward`, params);
    const pending = vi.spyOn(e.svc, 'pendingContext');
    const finish = vi.spyOn(e.svc.deps.requests, 'finish').mockImplementationOnce(() => {
      throw new Error('interrupted receipt write');
    });
    const first = await forward();
    expect(first.status).toBe(200);
    finish.mockRestore();
    expect(first.body).toEqual({ eventId: expect.any(String), messageId: expect.any(String) });
    e.svc.deps.requests = new MobileChatRequestStore(e.dir);
    const proof = vi.spyOn(e.svc.store, 'getEvent').mockImplementationOnce(() => { throw new Error('proof unreadable'); });
    expect((await forward()).body).toMatchObject({ error: 'outcome-unknown' });
    proof.mockRestore();
    const retries = await Promise.all([forward(), forward()]);
    expect(retries.map((retry) => retry.body)).toEqual([first.body, first.body]);
    expect((await forward(destination, { ...body, custodianMachineId: 'different-machine' })).body)
      .toEqual({ error: 'forward-custody-unavailable' });
    expect((await forward(alternate)).body).toMatchObject({ error: 'payload-conflict' });
    expect((await forward(destination, { ...body, sourceEventId: 'absent' })).body)
      .toMatchObject({ error: 'payload-conflict' });
    expect((await forward(destination, { ...body, sourceEventId: 'absent', requestId: rid() })).body)
      .toMatchObject({ error: 'forward-source-unavailable' });
    const mayUse = e.pairing.mayUse.bind(e.pairing);
    const readOnly = vi.spyOn(e.pairing, 'mayUse').mockImplementation((person, ref, op) =>
      (ref !== destination || op !== 'send') && mayUse(person, ref, op));
    try {
      expect((await forward()).body).toEqual(first.body);
      for (const id of [sourceEventId, 'absent']) {
        expect((await forward(destination, { ...body, sourceEventId: id, requestId: rid() })).body)
          .toEqual({ error: 'unknown-conversation' });
      }
    } finally { readOnly.mockRestore(); }
    let sendChecks = 0;
    const revoked = vi.spyOn(e.pairing, 'mayUse').mockImplementation((person, ref, op) => {
      if (ref === destination && op === 'send') return ++sendChecks === 1;
      return mayUse(person, ref, op);
    });
    try {
      expect((await forward(destination, { ...body, requestId: rid() })).body)
        .toEqual({ error: 'unknown-conversation' });
    } finally { revoked.mockRestore(); }
    let readChecks = 0;
    const revokedRead = vi.spyOn(e.pairing, 'mayUse').mockImplementation((person, ref, op) => {
      if (ref === destination && op === 'read') return ++readChecks === 1;
      return mayUse(person, ref, op);
    });
    try {
      expect((await forward(destination, { ...body, requestId: rid() })).body)
        .toEqual({ error: 'unknown-conversation' });
    } finally { revokedRead.mockRestore(); }
    const interrupted = { ...body, requestId: rid() };
    const reserve = e.svc.deps.requests.reserve.bind(e.svc.deps.requests);
    const crash = vi.spyOn(e.svc.deps.requests, 'reserve').mockImplementationOnce((...args) => {
      expect(reserve(...args).kind).toBe('reserved');
      throw new Error('process stopped after reservation');
    });
    expect((await forward(destination, interrupted)).status).toBe(503);
    crash.mockRestore();
    e.svc.deps.requests = new MobileChatRequestStore(e.dir);
    expect((await forward(destination, interrupted)).body).toMatchObject({ error: 'outcome-unknown' });
    expect(e.svc.store.browseMessages(destination, null, 10).messages).toEqual([
      expect.objectContaining({ ...first.body, text: 'Stop', forwarded: true }),
    ]);
    const second = makeDevice();
    const paired = e.pairing.devices.createPending({ deviceName: 'Destination reader', label: null, publicKey: second.publicKey, host: HOST });
    if (!paired.ok) throw new Error('destination reader pairing');
    e.pairing.devices.applyConfirm(paired.device.id, { ok: true });
    e.pairing.keyLedger!.recordActivation(e.pairing.devices.get(paired.device.id)!, 'telegram-dm', new Date(Date.now() - 1000).toISOString());
    const destinationReader = { ...e, deviceId: paired.device.id, dev: second };
    const destinationOnly = vi.spyOn(e.pairing, 'mayUse').mockImplementation((person, ref, op) =>
      ref !== sourceConversationKey && mayUse(person, ref, op));
    try {
      const originalPath = `/mobile/chat/app/${sourceConversationKey}/messages`;
      const copiedPath = `/mobile/chat/app/${destination}/messages`;
      expect((await signed(destinationReader, 'GET', originalPath)).status).toBe(404);
      const copied = await signed(destinationReader, 'GET', copiedPath);
      expect(copied.status).toBe(200);
      expect(copied.body.messages).toEqual([expect.objectContaining({ text: 'Stop', forwarded: true })]);
      expect(JSON.stringify(copied.body)).not.toContain(sourceConversationKey);
      expect(JSON.stringify(copied.body)).not.toContain(sourceEventId);
      expect(JSON.stringify(copied.body)).not.toContain('forwardBinding');
      for (const id of [sourceEventId, 'absent']) {
        expect((await forward(destination, { ...body, sourceEventId: id, requestId: rid() })).body)
          .toEqual({ error: 'forward-source-unavailable' });
      }
    } finally { destinationOnly.mockRestore(); }
    const fresh = { ...body, requestId: rid() };
    const raced = await Promise.all([forward(alternate, fresh), forward(alternate, fresh)]);
    expect(raced.map((r) => r.status)).toEqual([200, 200]);
    expect(raced[0]!.body).toEqual(raced[1]!.body);
    expect(e.svc.store.browseMessages(alternate, null, 10).messages).toHaveLength(1);
    expect(e.svc.store.browseMessages(sourceConversationKey, null, 10).messages).toHaveLength(1);
    expect(e.dispatched).toEqual([]);
    expect(e.killed).toEqual([]);
    expect(e.stopEffects).toEqual([]);
    expect(classifier).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
    pending.mockRestore();
  });
});


describe('signed App message removal admission checkpoint', () => {
  it('binds the signed owner, custodian, exact occurrence and request without mutating history', async () => {
    const e = setup({ removalAdmissionProbe: true });
    await enableReplyProof(e);
    const key = await create(e);
    const endpoint = `/mobile/chat/app/${key}/forward`;
    for (const id of ['one', 'two']) {
      e.svc.store.append({ kind: 'message', role: 'agent', conversationKey: key, eventId: id,
        messageId: `msg-${id}`, text: 'Retained text', at: new Date().toISOString(), machineId: 'm1' });
    }
    const intent = { custodianMachineId: 'm1', eventId: 'one', requestId: rid() };
    const admitted = await signed(e, 'POST', endpoint, intent);
    expect(admitted.status).toBe(200);
    expect(admitted.body).toMatchObject({ ok: true, targetEventId: 'one', targetMessageId: 'msg-one', requestId: intent.requestId });
    expect((await signed(e, 'POST', endpoint, intent)).body).toEqual(admitted.body);
    const changed = await signed(e, 'POST', endpoint, { ...intent, eventId: 'two' });
    expect(changed.status).toBe(200);
    expect(changed.body.removalEventId).toBe(admitted.body.removalEventId);
    expect(changed.body.intentHash).not.toBe(admitted.body.intentHash);
    for (const eventId of ['one', 'absent']) {
      expect((await signed(e, 'POST', endpoint, { ...intent, eventId, custodianMachineId: 'm2' })).status).toBe(503);
    }
    expect((await signed(e, 'POST', endpoint, { ...intent, eventId: 'msg-one' })).status).toBe(404);
    expect((await signed(e, 'POST', endpoint, { ...intent, eventId: 'absent' })).body.error).toBe('message-removal-target-unavailable');
    expect((await signed(e, 'POST', endpoint, { ...intent, text: 'wrong' })).status).toBe(400);
    expect((await bearer(e, 'post', endpoint).send(intent)).status).toBe(403);
    const acl = vi.spyOn(e.pairing, 'mayReadStored').mockReturnValue(false);
    expect((await signed(e, 'POST', endpoint, intent)).body.error).toBe('message-removal-target-unavailable');
    acl.mockRestore();
    e.lease.held = false;
    expect((await signed(e, 'POST', endpoint, intent)).status).toBe(503);
    e.lease.held = true;
    const pairingOwner = e.pairing.ownerIdentity();
    const unidentifiedOwner = vi.spyOn(e.pairing, 'ownerIdentity')
      .mockReturnValue({ ...pairingOwner, telegramOwnerId: null, slackOwnerUserId: null });
    try { expect((await signed(e, 'POST', endpoint, intent)).status).toBe(404); }
    finally { unidentifiedOwner.mockRestore(); }
    const changedOwner = vi.spyOn(e.pairing, 'ownerIdentity').mockReturnValue({ ...pairingOwner, telegramOwnerId: 9001 });
    try {
      const other = await signed(e, 'POST', endpoint, intent);
      expect(other.status).toBe(200);
      expect(other.body.requestActor).not.toBe(admitted.body.requestActor);
      expect(other.body.removalEventId).not.toBe(admitted.body.removalEventId);
    } finally { changedOwner.mockRestore(); }
    expect(e.svc.store.browseMessages(key, null, 10).messages).toHaveLength(2);
    expect(e.svc.store.messageRemoval(key, 'one', 'msg-one')).toEqual({ eventId: null });
  });
});
