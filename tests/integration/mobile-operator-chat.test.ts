/**
 * HTTP pipeline for native operator chat (docs/specs/mobile-operator-chat.md): a device-signed
 * message goes through the REAL shared inbound core (createRoutes' telegram-forward handler)
 * with the owner's identity, is recorded once per requestId, and never binds the topic operator.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const TOPIC = 4242;
const OWNER = 7812716706;
const dirs: string[] = [];
const services: MobilePairingService[] = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-operator-chat.test.ts' });
});

interface Spies { routed: Array<{ content: string; metadata: Record<string, unknown>; userId: string }>; logged: Array<Record<string, unknown>>; mirrors: Array<{ text: string; opts: Record<string, unknown> }>; killed: string[]; bound: unknown[] }

function setup(opts: { peerUrl?: string; history?: Array<Record<string, unknown>>; chatEnabled?: boolean; lease?: { held: boolean }; mirrorFails?: boolean; deliverDelayMs?: number; deliverThrows?: boolean; noRouting?: boolean; sentinel?: 'kill' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mchat-'));
  dirs.push(dir);
  const spies: Spies = { routed: [], logged: [], mirrors: [], killed: [], bound: [] };
  fs.writeFileSync(path.join(dir, 'topic-session-registry.json'), JSON.stringify({ topicToSession: { [String(TOPIC)]: 'sess-a' } }));
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' },
    mobilePairing: { ...(opts.chatEnabled === false ? { chat: { enabled: false } } : {}), multiRoute: { enabled: false } },
  };
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: 'm_self',
    resolvePeerUrls: () => (opts.peerUrl ? [{ machineId: 'm_peer', url: opts.peerUrl, kind: 'lan' }] : []),
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    sentinel: { decideInboundDisposition: async (m: string) => (opts.sentinel === 'kill' && /stop everything/i.test(m) ? { disposition: 'kill', category: 'emergency-stop' } : { disposition: 'route-through', category: 'normal' }) },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined },
    topicOperatorStore: { setAuthenticatedOperator: (...a: unknown[]) => { spies.bound.push(a); } },
    telegram: {
      getOwnerUserId: () => OWNER,
      getTopicHistory: () => opts.history ?? [],
      getAllTopicMappings: () => [{ topicId: TOPIC, topicName: 'Instar App', sessionName: 'sess-a' }],
      isAuthorizedSender: () => true,
      logInboundMessage: (e: Record<string, unknown>) => { spies.logged.push(e); },
      getSessionForTopic: () => 'sess-a',
      onSentinelKillSession: (n: string) => { spies.killed.push(n); return true; },
      onSentinelPauseSession: () => undefined,
      onTopicMessage: async (m: { content: string; metadata: Record<string, unknown>; userId: string }) => {
        if (opts.deliverDelayMs) await new Promise((r) => setTimeout(r, opts.deliverDelayMs));
        if (opts.deliverThrows) throw new Error('session refused');
        spies.routed.push(m);
      },
      sendToTopic: async (_t: number, text: string, o: Record<string, unknown> = {}) => {
        if (o.operatorMirror && opts.mirrorFails) throw new Error('telegram down');
        if (o.operatorMirror) spies.mirrors.push({ text, opts: o });
        return { messageId: 1, topicId: TOPIC };
      },
    },
  } as unknown as RouteContext;
  if (opts.noRouting) {
    delete (ctx.telegram as unknown as Record<string, unknown>).onTopicMessage;
    (ctx as unknown as Record<string, unknown>).sessionManager = null;
  }
  const lease = opts.lease ?? { held: true };
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => lease.held };
  const svc = new MobilePairingService(deps);
  services.push(svc);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  app.use(createRoutes(ctx));
  app.use(createMobilePairingRouter(svc, deps, ctx));
  const dev = makeDevice();
  const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!created.ok) throw new Error('setup');
  svc.devices.applyConfirm(created.device.id, { ok: true });
  return { app, svc, dev, deviceId: created.device.id, spies, dir, lease };
}

let tick = 0;
function chat(c: ReturnType<typeof setup>, body: Record<string, unknown>, topic = TOPIC) {
  const p = `/mobile/chat/${topic}`;
  const raw = Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000)); // distinct signatures for simultaneous retries
  const sig = c.dev.sign(canonicalString(c.deviceId, HOST, 'POST', p, time, raw));
  return request(c.app).post(p).set('Content-Type', 'application/json')
    .set('X-Instar-Device', c.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).send(raw.toString());
}
const rid = (t = Date.now()) => `${t}-${crypto.randomUUID()}`;

describe('mobile operator chat', () => {
  it('delivers an app message through the inbound core as the owner, labelled, with one history row and a mirror', async () => {
    const c = setup();
    const r = await chat(c, { text: 'hello from the phone', requestId: rid() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, outcome: 'delivered', mirrored: true });
    expect(r.body.eventId).toMatch(/^mobile:/);
    expect(c.spies.routed).toHaveLength(1);
    const m = c.spies.routed[0]!;
    expect(m.content).toBe('hello from the phone');
    expect(m.userId).toBe(String(OWNER));
    expect(m.metadata).toMatchObject({ viaMobileDevice: true, deviceId: c.deviceId, viaLifeline: false, telegramMessageId: '', firstName: 'Justin' });
    expect(c.spies.logged).toHaveLength(1);
    expect(c.spies.logged[0]).toMatchObject({ via: 'mobile-device', forwarded: undefined, telegramUserId: OWNER });
    expect(Number(c.spies.logged[0]!.messageId)).toBeGreaterThan(2 ** 52);
    expect(c.spies.mirrors[0]!.text).toBe('📱 Justin (from the app): hello from the phone');
    expect(c.spies.mirrors[0]!.opts).toMatchObject({ operatorMirror: true, skipStallClear: true });
    expect(c.spies.bound).toHaveLength(0); // never binds the topic operator
    expect(fs.existsSync(path.join(c.dir, 'serve-progress.json'))).toBe(false);
  });

  it('a retried requestId gets the stored answer and is delivered once; a different payload is refused', async () => {
    const c = setup();
    const id = rid();
    const a = await chat(c, { text: 'once', requestId: id });
    const b = await chat(c, { text: 'once', requestId: id });
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(c.spies.routed).toHaveLength(1);
    expect((await chat(c, { text: 'other', requestId: id })).body.error).toBe('request-id-reused');
  });

  it('two simultaneous identical requests: one delivery, one 202', async () => {
    const c = setup({ deliverDelayMs: 150 });
    const id = rid();
    const [a, b] = await Promise.all([chat(c, { text: 'race', requestId: id }), chat(c, { text: 'race', requestId: id })]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(c.spies.routed).toHaveLength(1);
  });

  it('an emergency stop from the app reaches the sentinel intercept once', async () => {
    const c = setup({ sentinel: 'kill' });
    const id = rid();
    const [a, b] = await Promise.all([chat(c, { text: 'stop everything', requestId: id }), chat(c, { text: 'stop everything', requestId: id })]);
    expect([a.status, b.status]).toContain(200);
    const ok = a.status === 200 ? a : b;
    expect(ok.body.outcome).toBe('sentinel-kill');
    expect(c.spies.killed).toEqual(['sess-a']);
    expect(c.spies.routed).toHaveLength(0);
  });

  it('a delivery failure after the core started is outcome-unknown and never re-run', async () => {
    const c = setup({ deliverThrows: true });
    const id = rid();
    const a = await chat(c, { text: 'maybe', requestId: id });
    expect(a.status).toBe(409);
    expect(a.body.error).toBe('outcome-unknown');
    const b = await chat(c, { text: 'maybe', requestId: id });
    expect(b.body.error).toBe('outcome-unknown');
    expect(c.spies.logged).toHaveLength(1); // the core ran once
  });

  it('a core failure after the history row is outcome-unknown, never released for a resend', async () => {
    const c = setup({ noRouting: true });
    const id = rid();
    const a = await chat(c, { text: 'nowhere to go', requestId: id });
    expect(a.status).toBe(409);
    expect(a.body.error).toBe('outcome-unknown');
    expect((await chat(c, { text: 'nowhere to go', requestId: id })).body.error).toBe('outcome-unknown');
    expect(c.spies.logged).toHaveLength(1);
  });

  it('refuses invites, /desktop codes and credential-shaped text with nothing logged, and the id stays usable', async () => {
    const c = setup();
    const id = rid();
    expect((await chat(c, { text: 'tlinv1:abcDEF123.ghiJKL456', requestId: id })).body.error).toBe('not-from-the-app');
    expect((await chat(c, { text: '/desktop abc 123456', requestId: rid() })).body.error).toBe('not-from-the-app');
    const cred = await chat(c, { text: `key ghp_${'a'.repeat(36)}`, requestId: rid() });
    expect(cred.status).toBe(422);
    expect(cred.body.error).toBe('credential-refused');
    expect(c.spies.logged).toHaveLength(0);
    expect(c.spies.routed).toHaveLength(0);
    expect((await chat(c, { text: 'fine now', requestId: id })).status).toBe(200);
  });

  it('bearer → 403; unknown topic → 404; bad request id → 400; old id → 400; gate off → 503; not serving → 409', async () => {
    const c = setup();
    expect((await request(c.app).post(`/mobile/chat/${TOPIC}`).set('Authorization', 'Bearer tok-1').send({ text: 'x', requestId: rid() })).body.error).toBe('operator-device-required');
    expect((await chat(c, { text: 'x', requestId: rid() }, 999)).status).toBe(404);
    expect((await chat(c, { text: 'x', requestId: 'nope' })).status).toBe(400);
    expect((await chat(c, { text: 'x', requestId: rid(Date.now() - 25 * 3600_000) })).body.error).toBe('request-id-too-old');
    expect((await chat(setup({ chatEnabled: false }), { text: 'x', requestId: rid() })).status).toBe(503);
    const off = setup({ lease: { held: false } });
    const r = await chat(off, { text: 'x', requestId: rid() });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('not-serving');
    expect(off.spies.logged).toHaveLength(0);
  });

  it('a recorded request answers its stored result even after the lease moved', async () => {
    const c = setup();
    const id = rid();
    expect((await chat(c, { text: 'kept', requestId: id })).status).toBe(200);
    c.lease.held = false;
    expect((await chat(c, { text: 'kept', requestId: id })).status).toBe(200);
  });

  it('a mirror failure still delivers, with mirrored: false', async () => {
    const c = setup({ mirrorFails: true });
    const r = await chat(c, { text: 'no mirror', requestId: rid() });
    expect(r.body).toMatchObject({ outcome: 'delivered', mirrored: false });
    expect(c.spies.routed).toHaveLength(1);
  });

  it('20 messages per minute per device, then 429', async () => {
    const c = setup();
    for (let i = 0; i < 20; i++) expect((await chat(c, { text: `m${i}`, requestId: rid() })).status).toBe(200);
    expect((await chat(c, { text: 'one more', requestId: rid() })).status).toBe(429);
  });

  it('the lifeline path is unchanged: still binds the operator and stamps viaLifeline', async () => {
    const c = setup();
    const r = await request(c.app).post('/internal/telegram-forward').set('Authorization', 'Bearer tok-1')
      .send({ topicId: TOPIC, text: 'from telegram', fromUserId: OWNER, fromFirstName: 'Justin', messageId: 77 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, forwarded: true });
    expect(c.spies.routed[0]!.metadata).toMatchObject({ viaLifeline: true, telegramMessageId: '77' });
    expect(c.spies.routed[0]!.metadata.viaMobileDevice).toBeUndefined();
    expect(c.spies.logged[0]).toMatchObject({ forwarded: false });
    expect(c.spies.logged[0]!.via).toBeUndefined();
  });

  it('history ?scope=pool merges machines, one row per event, and lists an unreachable machine', async () => {
    const peer = express();
    peer.get('/telegram/topics/:id/messages', (_req, res) => {
      res.json({ messages: [
        { messageId: 5, text: 'from the app', fromUser: true, timestamp: '2026-10-31T10:00:00.000Z', eventId: 'mobile:d:1', via: 'mobile-device' },
        { messageId: 9, text: 'reply on the peer', fromUser: false, timestamp: '2026-10-31T10:01:00.000Z' },
      ] });
    });
    const server = await new Promise<import('node:http').Server>((r) => { const sv = peer.listen(0, '127.0.0.1', () => r(sv)); });
    try {
      const port = (server.address() as { port: number }).port;
      const c = setup({ peerUrl: `http://127.0.0.1:${port}`, history: [
        { messageId: 2 ** 52 + 1, text: 'from the app', fromUser: true, timestamp: '2026-10-31T10:00:00.000Z', eventId: 'mobile:d:1', via: 'mobile-device' },
      ] });
      const r = await request(c.app).get(`/telegram/topics/${TOPIC}/messages?scope=pool`).set('Authorization', 'Bearer tok-1');
      expect(r.status).toBe(200);
      expect(r.body.messages.map((m: { text: string; machine: string }) => `${m.machine}:${m.text}`)).toEqual(['m_self:from the app', 'm_peer:reply on the peer']);
      expect(r.body.pool.failed).toEqual([]);
      const dead = setup({ peerUrl: 'http://127.0.0.1:1' });
      const d = await request(dead.app).get(`/telegram/topics/${TOPIC}/messages?scope=pool`).set('Authorization', 'Bearer tok-1');
      expect(d.body.pool.failed[0].machineId).toBe('m_peer');
    } finally { server.close(); }
  });
});
