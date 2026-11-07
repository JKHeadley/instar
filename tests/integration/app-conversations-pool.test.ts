// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration (docs/specs/app-conversations-in-the-pool.md §6): the production auth middleware, the
 * real routes and the real conversation service, with the pool's own seams driven per case.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
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
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { STOP_NOT_CONFIRMED, NEEDS_UPDATE, createAppOwnerReceiver, parseAppForward, type AppPoolHandle } from '../../src/core/appConversationPool.js';
import { runAppMove, setAppPoolMoves, type AppMoveDeps } from '../../src/core/appConversationMove.js';
import { createDeliverMessageHandler } from '../../src/core/DeliverMessageHandler.js';
import { applyOwnershipAction, type SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';
import type { InboundMessage, RouteOutcome } from '../../src/core/SessionRouter.js';
import type { AppDispatchInput } from '../../src/core/appInboundDispatch.js';
import type { MachineCapacity } from '../../src/core/types.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterEach(() => setAppPoolMoves(null));
afterAll(() => {
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/app-conversations-pool.test.ts' });
});

function setup(opts: { machine?: string; holds?: boolean; route?: (m: InboundMessage) => Promise<RouteOutcome> } = {}) {
  const machine = opts.machine ?? 'm_holder';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-pool-int-'));
  dirs.push(dir);
  const config = { projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true, sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' }, mobilePairing: { multiRoute: { enabled: false } } };
  const v = { holds: opts.holds ?? true, records: new Map<string, SessionOwnershipRecord>(), draining: false };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => machine, isRecordingEnabled: () => true });
  const bindAuth = createConversationBindAuth(dir);
  const holdsLease = () => v.holds;
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const dispatched: AppDispatchInput[] = [];
  const routed: InboundMessage[] = [];
  const killed: string[] = [];
  const dropped: string[] = [];
  const pool: AppPoolHandle = {
    active: () => true,
    read: (k) => v.records.get(k) ?? null,
    gateOpenFor: () => true,
    drainRunning: () => v.draining,
    sessionRunning: () => false,
    closeLostSession: async () => ({ closed: true }),
    leaseHeldElsewhere: () => true,
    dropHeld: (k) => { dropped.push(k); },
    hasHeld: () => false,
    route: async (m) => {
      routed.push(m);
      if (opts.route) return opts.route(m);
      return { action: 'handled-locally', acked: true };
    },
  };
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => machine, registry, requests: pairing.chatRequests()!, holdsLease, ownerName: () => 'Justin', pool: () => pool,
    killSession: (n) => { killed.push(n); return true; },
    dispatch: () => async (input) => { dispatched.push(input); svc.channels.register(String(input.alias), 'sess-app'); return 'delivered'; },
  });
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: machine,
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined },
    conversationRegistry: registry, conversationBindAuth: bindAuth, appConversations: svc,
    sessionOwnershipRegistry: { read: (k: string) => v.records.get(k) ?? null, ownerOf: () => null }, topicPinStore: { get: () => null },
    machinePoolRegistry: { getCapacities: () => [] }, resolveRouterUrl: () => null,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createRoutes(ctx));
  app.use(createMobileConversationRouter({ config: config as never, pairing, service: svc, machineId: () => machine }));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('setup');
  pairing.devices.applyConfirm(c.device.id, { ok: true });
  return { app, svc, registry, bindAuth, dev, deviceId: c.device.id, dispatched, routed, killed, dropped, v, pairing, pool };
}
type Env = ReturnType<typeof setup>;
let tick = 0;
function signed(e: Env, method: 'POST', p: string, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = e.dev.sign(canonicalString(e.deviceId, HOST, method, p, time, raw));
  return request(e.app).post(p).set('X-Instar-Device', e.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).set('Content-Type', 'application/json').send(raw.toString());
}
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;
const bearer = (e: Env, p: string) => request(e.app).post(p).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');
async function create(e: Env) {
  const r = await signed(e, 'POST', '/mobile/conversations', { title: 'Trip', requestId: rid() });
  expect(r.status).toBe(200);
  return r.body.conversationKey as string;
}
const record = (key: string, over: Partial<SessionOwnershipRecord> = {}): SessionOwnershipRecord => ({ sessionKey: `app:${key}`, ownerMachineId: 'm_owner', ownershipEpoch: 5, status: 'active', nonce: 'n', timestamp: Date.now(), updatedAt: new Date().toISOString(), ...over });

describe('the phone\'s send (§2.4)', () => {
  it('no record: delivered on the lease holder, as today', async () => {
    const e = setup();
    const key = await create(e);
    const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'hello', requestId: rid() });
    expect(r.body).toMatchObject({ ok: true, outcome: 'delivered', deliveryState: 'delivered' });
    expect(e.dispatched).toHaveLength(1);
    expect(e.routed[0].sessionKey).toBe(`app:${key}`);
    expect(parseAppForward(e.routed[0].payload)?.event.text).toBe('hello'); // the stored event, not just its id
  });

  it('an active record elsewhere: forwarded on the acknowledgement, not claimed delivered, not dispatched here', async () => {
    const e = setup({ route: async () => ({ action: 'forwarded', owner: 'm_owner', acked: true }) });
    const key = await create(e);
    const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'to the owner', requestId: rid() });
    expect(r.body).toMatchObject({ ok: true, outcome: 'forwarded', deliveryState: 'pending', forwarded: true });
    expect(e.svc.store.deliveryState(r.body.messageId)).toBe('pending');
    expect(e.dispatched).toEqual([]);
    expect(e.routed[0].senderEnvelope).toMatchObject({ via: 'mobile-device', deviceId: e.deviceId });
  });

  it('held (mid-move, or the gate closed): the phone hears waiting, and a later delivery wins', async () => {
    const e = setup({ route: async () => ({ action: 'queued', detail: 'transferring', acked: true }) });
    const key = await create(e);
    const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'wait', requestId: rid() });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ ok: true, outcome: 'waiting', deliveryState: 'pending' });
    expect(e.dispatched).toEqual([]);
    e.svc.finishExpiredForward(key, r.body.messageId, 'The machine running this conversation didn\'t answer.');
    expect(e.svc.store.deliveryState(r.body.messageId)).toBe('refused');
  });

  it('the owner refused the sender: refused, not forwarded', async () => {
    const e = setup({ route: async () => ({ action: 'rejected', detail: 'sender-deauthorized', acked: true }) });
    const key = await create(e);
    expect((await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'x', requestId: rid() })).body).toMatchObject({ outcome: 'refused', deliveryState: 'refused' });
  });

  it('a machine that isn\'t the lease holder answers as today: saved, 503', async () => {
    const e = setup();
    const key = await create(e);
    e.v.holds = false;
    const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'x', requestId: rid() });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('owner-unavailable');
    expect(e.routed).toEqual([]);
  });
});

describe('stop (§2.4)', () => {
  it('forwarded to the owner: "intercepted" only on its acknowledgement', async () => {
    const e = setup({ route: async () => ({ action: 'forwarded', owner: 'm_owner', acked: true }) });
    const key = await create(e);
    e.v.records.set(`app:${key}`, record(key));
    const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'stop', requestId: rid() });
    expect(r.body).toMatchObject({ ok: true, deliveryState: 'intercepted', forwarded: true });
    expect(e.routed[0].appUrgent).toBe('stop');
    expect(e.killed).toEqual([]);
    expect(e.dropped).toEqual([`app:${key}`]); // messages held behind it don't run after the stop
  });

  it('the owner did not answer: said plainly, never "intercepted"', async () => {
    const e = setup({ route: async () => ({ action: 'queued', detail: 'app-owner-unreachable', acked: true }) });
    const key = await create(e);
    e.v.records.set(`app:${key}`, record(key));
    const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'stop', requestId: rid() });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: 'stop-not-confirmed', detail: STOP_NOT_CONFIRMED });
    expect(e.svc.store.deliveryState(r.body.messageId)).not.toBe('intercepted');
  });

  it('a stop on a non-owner, non-holder: never "intercepted"', async () => {
    const e = setup();
    const key = await create(e);
    e.v.records.set(`app:${key}`, record(key));
    e.v.holds = false;
    const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'stop', requestId: rid() });
    expect(r.status).toBe(503);
    expect(r.body.detail).toBe(STOP_NOT_CONFIRMED);
  });

  it('a stop reaching the owner itself while a drain runs acts here and marks the drain', async () => {
    const e = setup({ machine: 'm_owner', holds: false });
    const key = await create(e);
    e.svc.channels.register(String(e.registry.appAliasFor(key)), 'sess-app');
    e.v.records.set(`app:${key}`, record(key, { status: 'transferring', transferTo: 'm_t' }));
    e.v.draining = true;
    const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'stop', requestId: rid() });
    expect(r.body).toMatchObject({ ok: true, deliveryState: 'intercepted' });
    expect(e.killed).toEqual(['sess-app']);
    expect(e.svc.emergencyMarked(`app:${key}`)).toBe(true);
    e.svc.clearEmergency(`app:${key}`);
    expect(e.svc.emergencyMarked(`app:${key}`)).toBe(false);
  });
});

describe('/app/session-reply, per conversation (§2.1)', () => {
  const reply = (e: Env, alias: number, text: string) => bearer(e, '/app/session-reply')
    .set('X-Instar-Bind-Token', e.bindAuth.mint('sess-app', [alias])).send({ conversationId: alias, text });
  const aliasOf = async (e: Env) => { const key = await create(e); const alias = e.registry.appAliasFor(key)!; e.svc.leaseTick(); return { key, alias }; };

  it('accepted on the owner off the lease; refused on the holder once the record names another machine', async () => {
    const owner = setup({ machine: 'm_owner', holds: true });
    const { key, alias } = await aliasOf(owner);
    owner.v.holds = false;
    owner.v.records.set(`app:${key}`, record(key));
    owner.svc.leaseTick();
    expect((await reply(owner, alias, 'from the owner')).status).toBe(200);

    const holder = setup();
    const h = await aliasOf(holder);
    holder.v.records.set(`app:${h.key}`, record(h.key));
    holder.svc.leaseTick();
    const refused = await reply(holder, h.alias, 'stale copy');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('not-owner');
  });

  it('the drain\'s last turn lands from the draining owner; once the runner ends it does not', async () => {
    const e = setup({ machine: 'm_owner', holds: false });
    e.v.holds = true;
    const { key, alias } = await aliasOf(e);
    e.v.holds = false;
    e.v.records.set(`app:${key}`, record(key, { status: 'transferring', transferTo: 'm_t' }));
    e.v.draining = true;
    e.svc.leaseTick();
    expect((await reply(e, alias, 'last turn')).status).toBe(200);
    e.v.draining = false;
    e.svc.leaseTick();
    expect((await reply(e, alias, 'too late')).status).toBe(409);
  });
});

describe('a forwarded send on the owner (§2.4)', () => {
  function ownerSide(e: Env, canTakeOverride?: () => boolean) {
    const receiver = createAppOwnerReceiver({ service: () => e.svc, storedEpoch: (k) => e.v.records.get(k)?.ownershipEpoch ?? null, markInjected: () => undefined });
    return createDeliverMessageHandler({
      ownerEpochOf: (s) => e.v.records.get(s)?.ownershipEpoch ?? null,
      recordReceipt: (() => { const seen = new Set<string>(); return (id: string) => { const f = !seen.has(id); seen.add(id); return f; }; })(),
      onAccepted: (c) => receiver.accepted(c.session, c.messageId, c.payload),
      app: { isApp: (c) => receiver.isApp(c.session), urgentAccepted: (c) => receiver.urgentAccepted(c.session, c.payload, c.ownershipEpoch), canTake: (c) => canTakeOverride?.() ?? receiver.canTake(c.session), ingest: (c) => receiver.ingest(c.session, c.payload) },
    });
  }

  it('a signed event is ingested once and delivered with its verdict; a replay is a duplicate', async () => {
    const holder = setup({ route: async () => ({ action: 'forwarded', acked: true }) });
    const key = await create(holder);
    await signed(holder, 'POST', `/mobile/chat/app/${key}`, { text: 'signed hello', requestId: rid() });
    const forward = parseAppForward(holder.routed[0].payload)!;

    const owner = setup({ machine: 'm_owner', holds: false });
    owner.svc.ingestReplicated(owner === undefined ? [] : [{ eventId: 'cr', kind: 'created', conversationKey: key, title: 'Trip', at: new Date().toISOString(), machineId: 'm_holder' } as never]);
    owner.v.records.set(`app:${key}`, record(key));
    const h = ownerSide(owner);
    const cmd = { type: 'deliverMessage', session: `app:${key}`, messageId: forward.event.messageId, payload: forward, ownershipEpoch: 5 } as never;
    expect((h(cmd, 'm_holder') as { accepted: string }).accepted).toBe('queued');
    await new Promise((r) => setTimeout(r, 20));
    expect(owner.svc.store.hasEvent(key, forward.event.eventId)).toBe(true);
    expect(owner.dispatched).toHaveLength(1);
    expect(owner.dispatched[0].text).toBe('signed hello');
    expect((h(cmd, 'm_holder') as { accepted: string }).accepted).toBe('duplicate');
    expect(owner.dispatched).toHaveLength(1);
  });

  it('refused while this machine does not serve it: `not-yet`, nothing stored', async () => {
    const owner = setup({ machine: 'm_owner', holds: false });
    const key = crypto.randomUUID();
    const forward = { kind: 'app-forward', seed: 's', event: { kind: 'message', eventId: 'e1', conversationKey: key, messageId: 'm1', role: 'operator', text: 'x', at: new Date().toISOString(), machineId: 'm_holder', receivedAt: new Date().toISOString() } };
    const h = ownerSide(owner);
    const a = h({ type: 'deliverMessage', session: `app:${key}`, messageId: 'm1', payload: forward, ownershipEpoch: 5 } as never, 'm_holder') as { accepted: string };
    expect(a.accepted).toBe('not-yet');
    expect(owner.svc.store.hasEvent(key, 'e1')).toBe(false);
  });

  it('a stop is in force by the acknowledgement, and an owner whose epoch rose still takes it', () => {
    const owner = setup({ machine: 'm_owner', holds: true });
    const key = crypto.randomUUID();
    owner.svc.applyCreate('d', 'r', key, 'Trip');
    owner.svc.channels.register(String(owner.registry.appAliasFor(key)), 'sess-app');
    owner.v.holds = false;
    owner.v.records.set(`app:${key}`, record(key, { status: 'transferring', transferTo: 'm_t', ownershipEpoch: 9 }));
    const forward = { kind: 'app-forward', seed: 's', urgent: 'stop', event: { kind: 'message', eventId: 'e1', conversationKey: key, messageId: 'm1', role: 'operator', text: 'stop', at: new Date().toISOString(), machineId: 'm_holder', receivedAt: new Date().toISOString() } };
    const h = ownerSide(owner);
    const a = h({ type: 'deliverMessage', session: `app:${key}`, messageId: 'm1', payload: forward, ownershipEpoch: 7 } as never, 'm_holder') as { accepted: string };
    expect(a.accepted).toBe('queued');
    expect(owner.killed).toEqual(['sess-app']);
    expect(owner.svc.store.deliveryState('m1')).toBe('intercepted');
  });
});

describe('the phone can read a conversation\'s placement when its session has no row (§2.2)', () => {
  it('is on the device allowlist, and says nothing moved while the pool has no moves wired', async () => {
    const e = setup();
    const key = await create(e);
    const time = String(Date.now());
    const p = `/mobile/conversations/${key}/placement`;
    const sig = e.dev.sign(canonicalString(e.deviceId, HOST, 'GET', p, time, undefined));
    const r = await request(e.app).get(p).set('X-Instar-Device', e.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ conversationRef: `app:${key}`, moved: false, bringBack: { can: false } });
  });
});

describe('POST /pool/transfer for an app conversation (§2.5)', () => {
  const cap = (m: string, flags = true): MachineCapacity => ({ machineId: m, nickname: m === 'm_t' ? 'Laptop' : m, online: true, clockSkewStatus: 'ok', seamlessnessFlags: { ws12DrainReceive: true, ...(flags ? { appConversationsPool: true } : {}) } }) as MachineCapacity;
  function wire(e: Env, over: Partial<AppMoveDeps> = {}) {
    const cas = (k: string, a: Parameters<AppMoveDeps['cas']>[1]) => {
      const t = applyOwnershipAction(e.v.records.get(k) ?? null, a, { sessionKey: k, nonce: 'n', now: 1 });
      if (!t.ok) return { ok: false };
      e.v.records.set(k, t.next);
      return { ok: true, record: t.next };
    };
    const deps: AppMoveDeps = {
      selfId: 'm_holder', capacity: (m) => cap(m), resolveMachine: (n) => (n === 'Laptop' ? 'm_t' : n === 'm_holder' ? n : null), validNames: () => ['Laptop'],
      everyMachineFlagged: () => true, selfFlagged: () => true, selfDrainable: () => true,
      conversation: (k) => e.svc.liveConversation(k), read: (k) => e.v.records.get(k) ?? null, cas,
      sendDrain: async (_o, k, target) => { cas(k, { type: 'transfer', to: target, drain: true }); cas(k, { type: 'claim', machineId: target }); return { ok: true, status: 'drained', claimLanded: true }; },
      askOwner: async () => null, autonomousRun: async () => null, setMoveInFlight: () => undefined, leftBehindHere: () => ({ files: 0, notes: 0 }), afterMove: () => undefined,
      lastMoveAt: () => null, noteMoved: () => undefined, now: () => Date.now(), ...over,
    };
    setAppPoolMoves({ active: () => true, move: (i) => runAppMove(deps, i), bringBack: () => ({ status: 500, body: {} }), placement: () => ({}) });
  }

  it('an unmoved conversation moves: no pin; the record names the target', async () => {
    const e = setup();
    const key = await create(e);
    wire(e);
    const r = await bearer(e, '/pool/transfer').send({ topic: `app:${key}`, to: 'Laptop' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, seatMoved: true, pinned: false, targetMachine: 'm_t' });
    expect(e.v.records.get(`app:${key}`)).toMatchObject({ ownerMachineId: 'm_t', status: 'active' });
  });

  it('a moved conversation moves on from its owner', async () => {
    const e = setup();
    const key = await create(e);
    e.v.records.set(`app:${key}`, record(key));
    wire(e);
    expect((await bearer(e, '/pool/transfer').send({ topic: `app:${key}`, to: 'Laptop' })).status).toBe(200);
  });

  it('a target without the flag is refused in words; nothing is written', async () => {
    const e = setup();
    const key = await create(e);
    wire(e, { capacity: (m) => cap(m, false) });
    const r = await bearer(e, '/pool/transfer').send({ topic: `app:${key}`, to: 'Laptop' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'needs-update', error: NEEDS_UPDATE });
    expect(e.v.records.size).toBe(0);
  });

  it('pool off: 503, as for every other conversation', async () => {
    const e = setup();
    const key = await create(e);
    expect((await bearer(e, '/pool/transfer').send({ topic: `app:${key}`, to: 'Laptop' })).status).toBe(503);
  });

  it('bring-back takes only an app reference', async () => {
    const e = setup();
    expect((await bearer(e, '/pool/bring-back').send({ conversation: '7' })).status).toBe(400);
  });
});
