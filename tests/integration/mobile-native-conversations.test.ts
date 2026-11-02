/**
 * HTTP pipeline for native app conversations (docs/specs/mobile-native-conversations.md,
 * increment 1): every route through the PRODUCTION auth middleware with the device
 * authenticator (allowlist + signature), MobileChatRequestStore idempotency (replay,
 * payload-conflict, outcome-unknown), the emergency stop getting through after the device spent
 * its read allowance, a dispatch failure after persist, token removal, the reply route's
 * 409 not-owner vs accepted, 404s and the recording-disabled 503.
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
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import type { AppDispatchInput } from '../../src/core/appInboundDispatch.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-native-conversations.test.ts' });
});

interface Opts { lease?: { held: boolean }; recording?: { on: boolean }; dispatchThrows?: boolean; nativeOff?: boolean; dispatchDelayMs?: number }

function setup(opts: Opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnative-'));
  dirs.push(dir);
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' },
    // Multi-route off: these tests cover the single paired host (mobile-multi-route.md, flag off).
    mobilePairing: { ...(opts.nativeOff ? { native: { enabled: false } } : {}), multiRoute: { enabled: false } },
  };
  const lease = opts.lease ?? { held: true };
  const recording = opts.recording ?? { on: true };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => recording.on });
  const bindAuth = createConversationBindAuth(dir);
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => lease.held };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = !opts.nativeOff;
  cleanups.push(() => pairing.stop());
  const dispatched: AppDispatchInput[] = [];
  const killed: string[] = [];
  const stopEffects: number[] = [];
  const requests = pairing.chatRequests()!;
  const svc = opts.nativeOff ? null : new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry, requests, holdsLease: () => lease.held, ownerName: () => 'Justin',
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
  app.use(createRoutes(ctx));
  app.use(createMobileConversationRouter({ config: config as never, pairing, service: svc, machineId: () => 'm1' }));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('setup');
  pairing.devices.applyConfirm(c.device.id, { ok: true });
  return { app, dir, svc: svc!, registry, bindAuth, dev, deviceId: c.device.id, dispatched, killed, stopEffects, lease, recording, pairing };
}

let tick = 0;
type Env = ReturnType<typeof setup>;
function signed(e: Env, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', p: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = e.dev.sign(canonicalString(e.deviceId, HOST, method, p, time, raw));
  const base = method === 'GET' ? request(e.app).get(p) : method === 'POST' ? request(e.app).post(p) : method === 'PATCH' ? request(e.app).patch(p) : request(e.app).delete(p);
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

  it('is 503 everywhere when native conversations are off, and the Telegram chat route is untouched', async () => {
    const e = setup({ nativeOff: true });
    expect((await signed(e, 'GET', '/mobile/conversations')).status).toBe(503);
    expect((await signed(e, 'POST', '/mobile/conversations', { title: 'x', requestId: rid() })).status).toBe(503);
    expect((await bearer(e, 'post', '/app/session-reply').send({ conversationId: -5, text: 'x' })).status).toBe(503);
    expect((await signed(e, 'POST', '/mobile/chat/1', { text: 'x', requestId: rid() })).body.error).toBe('chat-unavailable');
  });
});
