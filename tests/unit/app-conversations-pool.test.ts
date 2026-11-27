// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * App conversations in the pool (docs/specs/app-conversations-in-the-pool.md §6, unit list).
 * Every decision is tested on both sides.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConversationService, WAITING_OVERDUE_MS } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { MobileChatRequestStore } from '../../src/core/MobileChatRequests.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SessionRouter, type DeliverAck, type InboundMessage } from '../../src/core/SessionRouter.js';
import { createDeliverMessageHandler } from '../../src/core/DeliverMessageHandler.js';
import { InMemorySessionOwnershipStore, SessionOwnershipRegistry, isAppTieAdoption } from '../../src/core/SessionOwnershipRegistry.js';
import { LocalSessionOwnershipStore } from '../../src/core/LocalSessionOwnershipStore.js';
import { OwnershipApplier } from '../../src/core/OwnershipApplier.js';
import { applyOwnershipAction, appRowWinsTie, type SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';
import { setPinWithOneHlc } from '../../src/core/TopicPinMutation.js';
import { SessionDrainRunner } from '../../src/core/SessionDrainRunner.js';
import { isSlackConversationKey } from '../../src/core/SlackForwardBridge.js';
import {
  AppFlagTracker, AppLeaseGate, AppPoolEnforcer, BRING_BACK_EPOCH_MARGIN, BROUGHT_HOME_CONDITION, NEEDS_UPDATE, NO_PRIVATE_MEMORY,
  appForwardSenderValid, appLossState, appLossWords, buildAppForward, parseAppForward, parseAppOwned, type AppPoolHandle,
} from '../../src/core/appConversationPool.js';
import { appPlacement, bringBackWarning, runAppMove, runBringBack, type AppMoveDeps } from '../../src/core/appConversationMove.js';
import { summarizeControls, moveAnswer } from '../../src/server/mobileSessionControlsRoutes.js';
import { buildAction, actionLine } from '../../src/server/mobilePermissionsRoutes.js';
import { answerRouted, historyRow } from '../../src/server/mobileConversationRoutes.js';
import type { MachineCapacity } from '../../src/core/types.js';

const KEY = '0f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';
const RK = `app:${KEY}`;
const SELF = 'm_self';
const PEER = 'm_peer';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/app-conversations-pool.test.ts' }); });

function rec(over: Partial<SessionOwnershipRecord> = {}): SessionOwnershipRecord {
  return { sessionKey: RK, ownerMachineId: PEER, ownershipEpoch: 5, status: 'active', nonce: 'n', timestamp: Date.now(), updatedAt: new Date().toISOString(), ...over };
}

function makeService(opts: { holds?: boolean; record?: SessionOwnershipRecord | null; gate?: boolean; draining?: boolean; pool?: boolean; running?: string[]; close?: AppPoolHandle['closeLostSession']; clock?: () => number } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'app-pool-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const registry = new ConversationRegistry({ stateDir: dir } as never);
  const v = { holds: opts.holds ?? true, record: opts.record ?? null, gate: opts.gate ?? true, draining: opts.draining ?? false, active: opts.pool ?? true, leaseElsewhere: true };
  const closed: string[] = [];
  const handle: AppPoolHandle = {
    active: () => v.active,
    read: () => v.record,
    gateOpenFor: () => v.gate,
    drainRunning: () => v.draining,
    sessionRunning: (n) => (opts.running ?? []).includes(n),
    closeLostSession: opts.close ?? (async (_k, t) => { closed.push(t); return { closed: true }; }),
    route: vi.fn(),
    leaseHeldElsewhere: () => v.leaseElsewhere,
    dropHeld: vi.fn(),
    hasHeld: () => false,
  };
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => SELF, registry, requests: new MobileChatRequestStore(dir, opts.clock ?? Date.now),
    holdsLease: () => v.holds, ownerName: () => 'J', dispatch: () => null, pool: () => handle,
  });
  svc.store.append({ eventId: 'cr-1', kind: 'created', conversationKey: KEY, title: 'T', at: new Date().toISOString(), machineId: SELF });
  registry.mintAppAlias(KEY);
  return { svc, v, registry, closed, handle };
}

describe('who serves, who replies, who is the current owner (§2.1)', () => {
  const cases: Array<[string, { holds: boolean; record: SessionOwnershipRecord | null; gate: boolean; draining?: boolean }, boolean, boolean, boolean]> = [
    ['no record, lease here, gate open', { holds: true, record: null, gate: true }, true, true, true],
    ['no record, lease here, gate closed', { holds: true, record: null, gate: false }, false, false, false],
    ['no record, lease elsewhere', { holds: false, record: null, gate: true }, false, false, false],
    ['released record, lease here', { holds: true, record: rec({ status: 'released' }), gate: true }, true, true, true],
    ['active here, no lease', { holds: false, record: rec({ ownerMachineId: SELF }), gate: false }, true, true, true],
    ['active elsewhere, lease here', { holds: true, record: rec(), gate: true }, false, false, false],
    ['draining from here, runner running', { holds: true, record: rec({ ownerMachineId: SELF, status: 'transferring', transferTo: PEER }), gate: true, draining: true }, false, true, true],
    ['draining from here, runner gone', { holds: true, record: rec({ ownerMachineId: SELF, status: 'transferring', transferTo: PEER }), gate: true }, false, false, true],
    ['draining elsewhere toward here', { holds: true, record: rec({ status: 'transferring', transferTo: SELF }), gate: true }, false, false, false],
  ];
  for (const [name, state, serves, mayReply, currentOwner] of cases) {
    it(name, () => {
      const { svc } = makeService(state);
      expect(svc.serves(KEY)).toBe(serves);
      expect(svc.mayReply(KEY)).toBe(mayReply);
      expect(svc.currentOwner(KEY)).toBe(currentOwner);
    });
  }

  it('pool dark: the lease holder serves every conversation, exactly as today', () => {
    const { svc, v } = makeService({ pool: false, record: rec(), gate: false });
    expect(svc.serves(KEY)).toBe(true);
    v.holds = false;
    expect(svc.serves(KEY)).toBe(false);
  });

  it('isOwner is gone, so no caller keeps the all-or-nothing meaning', () => {
    const { svc } = makeService();
    expect((svc as unknown as { isOwner?: unknown }).isOwner).toBeUndefined();
  });

  it('a conversation created here is served while the gate is still closed: nothing else can own it', () => {
    const { svc } = makeService({ gate: false });
    const NEW = '1f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e20';
    svc.applyCreate('d', 'r', NEW, 'New');
    expect(svc.serves(NEW)).toBe(true);
    expect(svc.serves(KEY)).toBe(false);
  });
});

describe('the binding reconcile and close-on-loss (§2.1)', () => {
  it('binds what it may reply to and unbinds the rest, on every tick', () => {
    const { svc, v, registry } = makeService();
    const alias = registry.appAliasFor(KEY)!;
    svc.leaseTick();
    expect(registry.isAppBound(alias)).toBe(true);
    v.record = rec();
    svc.leaseTick();
    expect(registry.isAppBound(alias)).toBe(false);
    v.record = rec({ ownerMachineId: SELF, status: 'transferring', transferTo: PEER });
    v.draining = true;
    svc.leaseTick();
    expect(registry.isAppBound(alias)).toBe(true); // the drain's last turn
    v.draining = false;
    svc.leaseTick();
    expect(registry.isAppBound(alias)).toBe(false);
  });

  it('a record naming another machine closes the local copy; a refusal retries on the next reconcile', async () => {
    let answer = { closed: false, detail: 'open-commitment' };
    const calls: string[] = [];
    const { svc, v, registry } = makeService({ running: ['s1'], close: async (_k, t) => { calls.push(t); return answer; } });
    svc.channels.register(String(registry.appAliasFor(KEY)), 's1', 'T');
    v.record = rec();
    svc.leaseTick();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(['s1']);
    answer = { closed: true, detail: '' };
    svc.leaseTick();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(['s1', 's1']);
  });

  it('the lease moving away from an unmoved conversation closes it; a pool that is dark never does', async () => {
    const on = makeService({ running: ['s1'], holds: false });
    on.svc.channels.register(String(on.registry.appAliasFor(KEY)), 's1', 'T');
    on.svc.leaseTick();
    await new Promise((r) => setImmediate(r));
    expect(on.closed).toEqual(['s1']);
    const dark = makeService({ running: ['s1'], holds: false, pool: false });
    dark.svc.channels.register(String(dark.registry.appAliasFor(KEY)), 's1', 'T');
    dark.svc.leaseTick();
    await new Promise((r) => setImmediate(r));
    expect(dark.closed).toEqual([]);
  });

  it('a suspended lease or a missed renewal is not the lease moving: nothing closes until another machine is named holder', async () => {
    const { svc, v, registry, closed } = makeService({ running: ['s1'], holds: false });
    v.leaseElsewhere = false;
    svc.channels.register(String(registry.appAliasFor(KEY)), 's1', 'T');
    svc.leaseTick();
    await new Promise((r) => setImmediate(r));
    expect(closed).toEqual([]);
    v.leaseElsewhere = true;
    svc.leaseTick();
    await new Promise((r) => setImmediate(r));
    expect(closed).toEqual(['s1']);
  });

  it('a draining owner\'s session is not closed by the rule: the drain owns that close', async () => {
    const { svc, v, registry, closed } = makeService({ running: ['s1'], draining: true });
    svc.channels.register(String(registry.appAliasFor(KEY)), 's1', 'T');
    v.record = rec({ ownerMachineId: SELF, status: 'transferring', transferTo: PEER });
    svc.leaseTick();
    await new Promise((r) => setImmediate(r));
    expect(closed).toEqual([]);
  });
});

describe('a send never stays waiting for good (§2.2)', () => {
  const held = (svc: AppConversationService, id: string, messageId: string) => {
    const requestId = `${Date.now()}-${id}`;
    svc.deps.requests.reserve('dev', requestId, 'h', 0, { op: 'send', conversationKey: KEY, messageId });
    svc.deps.requests.finish('dev', requestId, { status: 202, body: { ok: true, outcome: 'waiting', deliveryState: 'pending', conversationKey: KEY, messageId } });
    return requestId;
  };
  const message = (messageId: string) => ({ eventId: `e-${messageId}`, kind: 'message', conversationKey: KEY, messageId, role: 'operator', text: 'x', at: new Date().toISOString(), machineId: SELF, receivedAt: new Date().toISOString() }) as never;

  it('past the queue\'s limits with no row to report it (a quarantined store): it reads unknown, in words; before then it waits', () => {
    let now = Date.now();
    const { svc } = makeService({ clock: () => now });
    svc.store.append(message('m1'));
    const requestId = held(svc, 'a', 'm1');
    svc.recoverStranded();
    expect(svc.store.deliveryState('m1')).toBe('pending');
    now += WAITING_OVERDUE_MS + 1;
    svc.recoverStranded();
    expect(svc.store.deliveryState('m1')).toBe('unknown');
    expect(svc.deps.requests.detailForMessage('m1')).toContain('may not have been delivered'); // the app's history shows this
    expect(historyRow({ eventId: 'e', messageId: 'm1', role: 'operator', text: 'x', at: '', machineId: SELF, deliveryState: 'unknown' } as never, () => 'none', svc)).toMatchObject({ deliveryDetail: expect.stringContaining('may not have been delivered') });
    expect(historyRow({ eventId: 'e', messageId: 'm1', role: 'operator', text: 'x', at: '', machineId: SELF, deliveryState: 'delivered' } as never, () => 'none', svc).deliveryDetail).toBeUndefined();
    const after = svc.deps.requests.lookup('dev', requestId, 'h');
    expect(after).toMatchObject({ kind: 'done', status: 409, body: { error: 'outcome-unknown', outcome: 'unknown' } });
  });

  it('one the owner\'s outcome already settled keeps that outcome', () => {
    let now = Date.now();
    const { svc } = makeService({ clock: () => now });
    svc.store.append(message('m2'));
    held(svc, 'b', 'm2');
    svc.appendDelivery(KEY, 'm2', 'delivered', 'owner');
    now += WAITING_OVERDUE_MS + 1;
    svc.recoverStranded();
    expect(svc.store.deliveryState('m2')).toBe('delivered');
  });

  it('with the pool dark nothing is ever held, so nothing here runs', () => {
    let now = Date.now();
    const { svc } = makeService({ clock: () => now, pool: false });
    svc.store.append(message('m3'));
    held(svc, 'c', 'm3');
    now += WAITING_OVERDUE_MS + 1;
    svc.recoverStranded();
    expect(svc.store.deliveryState('m3')).toBe('pending');
  });
});

describe('the lease gate (§2.3)', () => {
  const gate = (over: Partial<ConstructorParameters<typeof AppLeaseGate>[0]> = {}) => {
    const stored = new Map<string, number>();
    const g = new AppLeaseGate({ holdsLease: () => true, peers: () => [PEER], status: async () => ({ appOwned: [] }), storedEpoch: (k) => stored.get(k) ?? 0, ...over });
    return { g, stored };
  };

  it('is closed until the round finishes; a no-record conversation waits', async () => {
    let release: (v: { appOwned: unknown[] }) => void = () => undefined;
    const { g } = gate({ status: () => new Promise((r) => { release = r; }) });
    const round = g.tick();
    expect(g.openFor(KEY)).toBe(false);
    release({ appOwned: [] });
    await round;
    expect(g.openFor(KEY)).toBe(true);
  });

  it('a key reported at a higher epoch is held until this store catches up', async () => {
    const { g, stored } = gate({ status: async () => ({ appOwned: [{ key: RK, epoch: 9, status: 'transferring' }] }) });
    await g.tick();
    expect(g.isOpen()).toBe(true);
    expect(g.openFor(KEY)).toBe(false);
    stored.set(RK, 9);
    expect(g.openFor(KEY)).toBe(true);
  });

  it('a machine that does not answer within the bound is treated as owning nothing', async () => {
    const { g } = gate({ status: () => new Promise(() => undefined), boundMs: 5 });
    await g.tick();
    expect(g.openFor(KEY)).toBe(true);
  });

  it('with no peers it opens without waiting; losing the lease closes it again', async () => {
    let holds = true;
    const { g } = gate({ peers: () => [], holdsLease: () => holds });
    await g.tick();
    expect(g.isOpen()).toBe(true);
    holds = false;
    g.tick();
    expect(g.isOpen()).toBe(false);
  });

  it('drops malformed appOwned rows', () => {
    expect(parseAppOwned([{ key: 'app:nope', epoch: 1 }, { key: RK, epoch: 'x' }, { key: RK, epoch: 3, status: 'active' }, null])).toEqual([{ key: RK, epoch: 3, status: 'active' }]);
    expect(parseAppOwned('nope')).toEqual([]);
  });
});

function makeRouter(view: { owner: string | null; epoch: number; status: 'active' | 'placing' | 'transferring' | null }, over: Partial<ConstructorParameters<typeof SessionRouter>[0]> = {}) {
  const decide = vi.fn();
  const queued: string[] = [];
  const cas = vi.fn(() => ({ ok: true, epoch: 1 }));
  const deliver = vi.fn(async (): Promise<DeliverAck> => ({ messageId: 'm', accepted: 'queued' }));
  const router = new SessionRouter({
    selfMachineId: SELF, placement: { decide } as never, machineRegistry: () => [], resolveOwnership: () => view, isMachineAlive: () => true,
    casClaimOwnership: cas, deliverMessage: deliver, handleLocally: async () => undefined, spawnOnMachine: vi.fn(),
    queueMessage: (_m, reason) => { queued.push(reason); return 'queued'; }, raiseAttention: vi.fn(), sleep: async () => undefined, ...over,
  });
  return { router, decide, queued, cas, deliver };
}
const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({ sessionKey: RK, messageId: 'm', payload: 'p', ...over });

describe('no placement path for an app key (§2.2)', () => {
  it('route: no record delivers here when served, waits at a closed gate, and never places', async () => {
    const open = makeRouter({ owner: null, epoch: 0, status: null }, { appNoRecordServedHere: () => true });
    expect((await open.router.route(msg())).action).toBe('handled-locally');
    expect(open.decide).not.toHaveBeenCalled();
    const closed = makeRouter({ owner: null, epoch: 0, status: null }, { appNoRecordServedHere: () => false });
    const out = await closed.router.route(msg());
    expect(out).toMatchObject({ action: 'queued', detail: 'app-lease-gate-closed', acked: true });
    expect(closed.decide).not.toHaveBeenCalled();
    expect(closed.cas).not.toHaveBeenCalled();
  });

  it('forwardToOwner never re-places: stale, not-yet and unreachable all stay queued', async () => {
    for (const accepted of ['stale-ownership', 'not-yet'] as const) {
      const r = makeRouter({ owner: PEER, epoch: 4, status: 'active' }, { deliverMessage: async () => ({ messageId: 'm', accepted }) });
      expect((await r.router.route(msg())).action).toBe('queued');
      expect(r.cas).not.toHaveBeenCalled();
      expect(r.decide).not.toHaveBeenCalled();
    }
    const dead = makeRouter({ owner: PEER, epoch: 4, status: 'active' }, { deliverMessage: async () => { throw new Error('down'); } });
    expect(await dead.router.route(msg())).toMatchObject({ action: 'queued', detail: 'app-owner-unreachable' });
    expect(dead.cas).not.toHaveBeenCalled();
  });

  it('an owner marked dead keeps the message queued, where a Telegram topic would re-place', async () => {
    const r = makeRouter({ owner: PEER, epoch: 4, status: 'active' }, { isMachineAlive: () => false });
    expect(await r.router.route(msg())).toMatchObject({ action: 'queued', detail: 'app-owner-not-answering' });
    expect(r.deliver).not.toHaveBeenCalled();
    expect(r.cas).not.toHaveBeenCalled();
  });

  it('forceReplace skips app keys; a Telegram key still runs it', async () => {
    const r = makeRouter({ owner: null, epoch: 0, status: null });
    expect(await r.router.forceReplace(msg())).toBe(false);
    expect(r.decide).not.toHaveBeenCalled();
    r.decide.mockReturnValue({ outcome: 'queued', reason: 'none' });
    await r.router.forceReplace(msg({ sessionKey: '7' }));
    expect(r.decide).toHaveBeenCalled();
  });

  it('pins refuse an app key; a Telegram key is pinned', () => {
    const set = vi.fn();
    const pinStore = { set, get: () => null, clear: vi.fn() } as never;
    setPinWithOneHlc({ pinStore }, RK, PEER);
    expect(set).not.toHaveBeenCalled();
    setPinWithOneHlc({ pinStore }, '7', PEER);
    expect(set).toHaveBeenCalledTimes(1);
  });
});

describe('messages reach the owner (§2.4)', () => {
  it('`transferring` holds an ordinary message; a stop goes to the draining owner at once', async () => {
    const r = makeRouter({ owner: PEER, epoch: 6, status: 'transferring' });
    expect(await r.router.route(msg())).toMatchObject({ action: 'queued', detail: 'transferring' });
    expect(r.deliver).not.toHaveBeenCalled();
    expect((await r.router.route(msg({ appUrgent: 'stop' }))).action).toBe('forwarded');
    expect(r.deliver).toHaveBeenCalledTimes(1);
  });

  it('a stop follows the move once by re-reading the record; it does not loop', async () => {
    const view = { owner: PEER as string | null, epoch: 6, status: 'active' as const };
    let calls = 0;
    const deliver = vi.fn(async (): Promise<DeliverAck> => { calls++; if (calls === 1) view.owner = 'm_new'; return { messageId: 'm', accepted: calls === 1 ? 'stale-ownership' : 'queued' }; });
    const { router } = makeRouter(view, { resolveOwnership: () => view, deliverMessage: deliver });
    expect(await router.route(msg({ appUrgent: 'pause' }))).toMatchObject({ action: 'forwarded', owner: 'm_new' });
    expect(calls).toBe(2);
  });

  it('a stop that can\'t land is never kept: firing later, it would stop work asked for since', async () => {
    const r = makeRouter({ owner: PEER, epoch: 4, status: 'active' }, { deliverMessage: async () => ({ messageId: 'm', accepted: 'not-yet' }) });
    expect(await r.router.route(msg({ appUrgent: 'stop' }))).toMatchObject({ action: 'queued', acked: false });
    expect(r.queued).toEqual([]);
  });

  it('a new message goes behind ones still held', async () => {
    const r = makeRouter({ owner: PEER, epoch: 4, status: 'active' });
    expect(await r.router.route(msg({ appBehindHeld: true }))).toMatchObject({ action: 'queued', detail: 'app-behind-held' });
    expect(r.deliver).not.toHaveBeenCalled();
  });

  it('a stop ends a forward between retries and one waiting its turn; a message after the stop goes through', async () => {
    let fail = true;
    const sent: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((res) => { release = res; });
    const { router } = makeRouter({ owner: PEER, epoch: 4, status: 'active' }, {
      deliverMessage: (async (_t: string, env: { messageId: string }): Promise<DeliverAck> => {
        sent.push(env.messageId);
        if (env.messageId === 'first' && fail) { fail = false; throw new Error('blip'); }
        return { messageId: env.messageId, accepted: 'queued' };
      }) as never,
      sleep: () => held,
    });
    const first = router.route(msg({ messageId: 'first' }));
    const waiting = router.route(msg({ messageId: 'waiting' }));
    await new Promise((r) => setImmediate(r));
    expect((await router.route(msg({ messageId: 'stop', appUrgent: 'stop' }))).action).toBe('forwarded');
    const after = router.route(msg({ messageId: 'after' }));
    release();
    expect(await first).toMatchObject({ detail: 'app-stopped-unknown' }); // its first attempt threw
    expect(await waiting).toMatchObject({ detail: 'app-stopped' });
    expect((await after).action).toBe('forwarded');
    expect(sent).toEqual(['first', 'stop', 'after']);
  });

  it('a send whose last attempt fails after a stop landed is not queued to run after it', async () => {
    const r = makeRouter({ owner: PEER, epoch: 4, status: 'active' });
    let failSlow: (e: Error) => void = () => undefined;
    r.deliver.mockImplementationOnce(() => new Promise<DeliverAck>((_res, rej) => { failSlow = rej; }));
    const router = new SessionRouter({
      selfMachineId: SELF, placement: {} as never, machineRegistry: () => [], resolveOwnership: () => ({ owner: PEER, epoch: 4, status: 'active' }), isMachineAlive: () => true,
      casClaimOwnership: r.cas, deliverMessage: r.deliver, handleLocally: async () => undefined, spawnOnMachine: vi.fn(),
      queueMessage: (_m, why) => { r.queued.push(why); return 'queued'; }, raiseAttention: vi.fn(), sleep: async () => undefined,
    }, { deliverMessageMaxRetries: 0, deliverMessageRetryBackoffStartMs: 1, deliverMessageRetryBackoffMaxMs: 1, maxReResolveDepth: 1 });
    const live = router.route(msg({ messageId: 'live' }));
    await new Promise((res) => setImmediate(res));
    await router.route(msg({ messageId: 'stop', appUrgent: 'stop' }));
    failSlow(new Error('timed out'));
    // The attempt threw: the owner may have it with only the answer lost, so nothing says it never arrived.
    expect(await live).toMatchObject({ detail: 'app-stopped-unknown', acked: true });
    expect(r.queued).toEqual([]);
  });

  it('a stop does not wait behind an in-flight forward', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const deliver = vi.fn(async (_t: string, env: { messageId: string }): Promise<DeliverAck> => {
      order.push(env.messageId);
      if (env.messageId === 'slow') await held;
      return { messageId: env.messageId, accepted: 'queued' };
    });
    const { router } = makeRouter({ owner: PEER, epoch: 1, status: 'active' }, { deliverMessage: deliver as never });
    const slow = router.route(msg({ messageId: 'slow' }));
    await new Promise((r) => setImmediate(r));
    await router.route(msg({ messageId: 'stop', appUrgent: 'stop' }));
    expect(order).toEqual(['slow', 'stop']);
    release();
    await slow;
  });

  const handler = (over: Partial<Parameters<typeof createDeliverMessageHandler>[0]> = {}, app: Partial<NonNullable<Parameters<typeof createDeliverMessageHandler>[0]['app']>> = {}) => {
    const accepted: string[] = [];
    const seen = new Set<string>();
    const h = createDeliverMessageHandler({
      ownerEpochOf: () => 10,
      recordReceipt: (id) => { const first = !seen.has(id); seen.add(id); return first; },
      onAccepted: (c) => accepted.push(c.messageId),
      refusal: { canServe: () => true, alreadyReceived: (id) => seen.has(id) },
      app: { isApp: (c) => c.session.startsWith('app:'), urgentAccepted: () => false, canTake: () => true, ingest: () => true, ...app },
      ...over,
    });
    const send = (id: string, epoch = 10) => h({ type: 'deliverMessage', session: RK, messageId: id, payload: {}, ownershipEpoch: epoch, senderEnvelope: { via: 'mobile-device', deviceId: 'd', eventId: 'e' } } as never, 'peer') as { accepted: string };
    return { send, accepted, seen };
  };

  it('`not-yet` while it cannot take the message; no receipt is recorded', () => {
    const { send, accepted, seen } = handler({}, { canTake: () => false });
    expect(send('a').accepted).toBe('not-yet');
    expect(accepted).toEqual([]);
    expect(seen.size).toBe(0);
  });

  it('acknowledged only after durable ingest: a failed ingest leaves no receipt, and a retry is a first time', () => {
    let ok = false;
    const { send, seen, accepted } = handler({}, { ingest: () => ok });
    expect(send('a').accepted).toBe('not-yet');
    expect(seen.size).toBe(0);
    ok = true;
    expect(send('a').accepted).toBe('queued');
    expect(accepted).toEqual(['a']);
    expect(send('a').accepted).toBe('duplicate');
  });

  it('the epoch fence still answers a stale ordinary message; a stop from the current owner passes it', () => {
    expect(handler().send('a', 3).accepted).toBe('stale-ownership');
    const { send, accepted } = handler({}, { urgentAccepted: () => true, canTake: () => false });
    expect(send('s', 3).accepted).toBe('queued');
    expect(accepted).toEqual(['s']);
  });

  it('the sender check is the event\'s paired device', () => {
    const event = { kind: 'message', conversationKey: KEY, messageId: 'm', eventId: 'e', text: 'hi', origin: { deviceId: 'd1' } };
    const payload = buildAppForward({ event: event as never, seed: 's', ownerName: null, memoryPersonId: null });
    expect(appForwardSenderValid({ via: 'mobile-device', deviceId: 'd1', eventId: 'e' }, RK, payload)).toBe(true);
    expect(appForwardSenderValid({ via: 'mobile-device', deviceId: 'd2', eventId: 'e' }, RK, payload)).toBe(false);
    expect(appForwardSenderValid({ via: 'mobile-device', deviceId: 'd1', eventId: 'other' }, RK, payload)).toBe(false);
    expect(appForwardSenderValid({ deviceId: 'd1', eventId: 'e' }, RK, payload)).toBe(false);
    expect(appForwardSenderValid({ via: 'mobile-device', deviceId: 'd1', eventId: 'e' }, `app:${KEY.replace('0f', '1f')}`, payload)).toBe(false);
  });

  it('the words for a queue loss follow its reason', () => {
    expect(appLossWords('operator-stop')).toContain('may not have been delivered');
    expect(appLossWords('ttl-expired')).toContain('Bring it back here');
    expect(appLossWords('attempts-exhausted')).toContain('Bring it back here');
    expect(appLossWords('sender-deauthorized')).toContain('refused');
    expect(appLossWords('stale-custody')).toContain('may not have been delivered');
    // Definite only where known or where the spec asks; a restart can't know, so it never says "send it again" flatly.
    for (const r of ['sender-deauthorized', 'ttl-expired', 'attempts-exhausted']) expect(appLossState(r)).toBe('refused');
    for (const r of ['operator-stop', 'stale-custody', 'dropped-overflow', 'nap-stale', 'pause-expired', 'poisoned', 'queue-dispatch-will-not-run:x', 'gate:no-mesh-identity']) expect(appLossState(r)).toBe('unknown');
  });

  it('the forward survives a queue row\'s JSON; anything else is not a forward', () => {
    const event = { kind: 'media-message', conversationKey: KEY, messageId: 'm', eventId: 'e', text: '', attachments: [] };
    const p = buildAppForward({ event: event as never, seed: 's', ownerName: 'A', memoryPersonId: 'u', urgent: 'pause' });
    expect(parseAppForward(JSON.stringify(p))).toMatchObject({ seed: 's', ownerName: 'A', memoryPersonId: 'u', urgent: 'pause' });
    expect(parseAppForward('not json')).toBeNull();
    expect(parseAppForward({ kind: 'other' })).toBeNull();
    expect(parseAppForward({ kind: 'app-forward', seed: 's', event: { kind: 'tombstone', conversationKey: KEY, messageId: 'm' } })).toBeNull();
  });

  it('what the phone hears: delivered only on acknowledgement, a bare duplicate is waiting', () => {
    const appended: string[] = [];
    const s = { appendDelivery: (_k: string, _m: string, st: string) => { appended.push(st); }, store: { deliveryState: () => 'pending' } } as never;
    const m = { key: KEY, messageId: 'm', seed: 's' };
    // The owner hasn't dispatched yet: nothing here claims delivered, so a crash can still read `unknown`.
    expect(answerRouted(s, { action: 'forwarded', acked: true }, m)).toMatchObject({ status: 200, body: { outcome: 'forwarded', forwarded: true, deliveryState: 'pending' } });
    expect(appended).toEqual([]);
    expect(answerRouted(s, { action: 'duplicate', acked: true }, m)).toMatchObject({ status: 202, body: { outcome: 'waiting' } });
    expect(answerRouted(s, { action: 'queued', acked: true }, m)).toMatchObject({ status: 202 });
    expect(answerRouted(s, { action: 'queued', detail: 'app-stopped', acked: true }, m)).toMatchObject({ status: 200, body: { deliveryState: 'refused' } });
    expect(answerRouted(s, { action: 'queued', detail: 'app-stopped-unknown', acked: true }, m)).toMatchObject({ status: 200, body: { outcome: 'unknown', deliveryState: 'unknown' } });
    appended.length = 0;
    expect(answerRouted(s, { action: 'queued', acked: false }, m)).toMatchObject({ status: 503, body: { error: 'owner-unavailable' } });
    expect(answerRouted(s, { action: 'rejected', acked: true }, m)).toMatchObject({ body: { deliveryState: 'refused' } });
    const delivered = { appendDelivery: () => undefined, store: { deliveryState: () => 'delivered' } } as never;
    expect(answerRouted(delivered, { action: 'duplicate', acked: true }, m)).toMatchObject({ status: 200, body: { deliveryState: 'delivered' } });
  });

  it('the strict Slack grammar: a forwarded app key is never a fake Slack message', () => {
    expect(isSlackConversationKey(RK)).toBe(false);
    expect(isSlackConversationKey('C0ABC123')).toBe(true);
    expect(isSlackConversationKey('C0ABC123:1730000000.000100')).toBe(true);
  });
});

describe('the journal rows and the tie rule (§2.2, §2.7)', () => {
  it('force-claim writes far above the observed epoch, with the marker; the default is still +1', () => {
    const ctx = { sessionKey: RK, nonce: 'n', now: 1 };
    const big = applyOwnershipAction(rec(), { type: 'force-claim', machineId: SELF, epochMargin: BRING_BACK_EPOCH_MARGIN, takeover: true }, ctx);
    expect(big).toMatchObject({ ok: true, next: { ownershipEpoch: 5 + BRING_BACK_EPOCH_MARGIN, ownerMachineId: SELF, takeover: true } });
    expect(applyOwnershipAction(rec(), { type: 'force-claim', machineId: SELF }, ctx)).toMatchObject({ next: { ownershipEpoch: 6 } });
    expect(applyOwnershipAction(rec(), { type: 'force-claim', machineId: SELF, epochMargin: -5 }, ctx)).toMatchObject({ next: { ownershipEpoch: 6 } });
  });

  it('a marked row wins a tie, then the lower machine id', () => {
    expect(appRowWinsTie({ owner: 'z', takeover: true }, { owner: 'a' })).toBe(true);
    expect(appRowWinsTie({ owner: 'a' }, { owner: 'z', takeover: true })).toBe(false);
    expect(appRowWinsTie({ owner: 'a' }, { owner: 'b' })).toBe(true);
    expect(appRowWinsTie({ owner: 'b' }, { owner: 'a' })).toBe(false);
  });

  it('equal-epoch adoption is its own store method, for app keys only', () => {
    const store = new InMemorySessionOwnershipStore();
    store.casWrite(rec({ ownerMachineId: 'b' }));
    expect(store.adoptAppTieWinner(rec({ ownerMachineId: 'a' }))).toBe(true);
    expect(store.read(RK)?.ownerMachineId).toBe('a');
    expect(store.adoptAppTieWinner(rec({ ownerMachineId: 'b' }))).toBe(false);
    expect(store.casWrite(rec({ ownerMachineId: 'z' })).ok).toBe(false); // casWrite stays strictly-higher
    expect(isAppTieAdoption(rec({ sessionKey: '7', ownerMachineId: 'b' }), rec({ sessionKey: '7', ownerMachineId: 'a' }))).toBe(false);
  });

  it('the durable store adopts through the same predicate and survives a reload', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'app-own-'));
    dirs.push(dir);
    const s = new LocalSessionOwnershipStore({ dir });
    s.casWrite(rec({ ownerMachineId: 'b' }));
    expect(s.adoptAppTieWinner(rec({ ownerMachineId: 'a', takeover: true }))).toBe(true);
    expect(new LocalSessionOwnershipStore({ dir }).read(RK)).toMatchObject({ ownerMachineId: 'a', takeover: true });
  });

  const entry = (data: Record<string, unknown>) => ({ machine: String(data.owner), data: { reason: 'user-move', ...data } });
  const apply = (entries: ReturnType<typeof entry>[], store = new InMemorySessionOwnershipStore()) => {
    new OwnershipApplier({ reader: { query: (o: { cursor?: string }) => ({ entries: o.cursor ? [] : entries }), cursorFor: () => 'c' }, store, selfMachineId: SELF }).tick();
    return store;
  };

  it('the applier materializes an app row by its key, and an older topic-less row is still skipped', () => {
    const store = apply([entry({ sessionKey: RK, owner: PEER, epoch: 7 }), entry({ owner: PEER, epoch: 9 })]);
    expect(store.read(RK)).toMatchObject({ ownerMachineId: PEER, ownershipEpoch: 7 });
    expect(store.all()).toHaveLength(1);
  });

  it('a bad key is ignored', () => {
    expect(apply([entry({ sessionKey: 'app:not-a-uuid', owner: PEER, epoch: 7 })]).all()).toHaveLength(0);
  });

  it('an equal epoch converges to one owner on every machine, whichever row was read first', () => {
    const a = entry({ sessionKey: RK, owner: 'm_a', epoch: 7 });
    const b = entry({ sessionKey: RK, owner: 'm_b', epoch: 7, takeover: true });
    expect(apply([a, b]).read(RK)?.ownerMachineId).toBe('m_b');
    expect(apply([b, a]).read(RK)?.ownerMachineId).toBe('m_b');
    const local = new InMemorySessionOwnershipStore();
    local.casWrite(rec({ ownerMachineId: 'm_a', ownershipEpoch: 7 }));
    expect(apply([b], local).read(RK)).toMatchObject({ ownerMachineId: 'm_b', takeover: true });
  });

  it('a takeover far above every cooperative step settles every machine on the holder', () => {
    const store = new InMemorySessionOwnershipStore();
    store.casWrite(rec({ ownerMachineId: PEER, ownershipEpoch: 40 }));
    apply([entry({ sessionKey: RK, owner: SELF, epoch: 6 + BRING_BACK_EPOCH_MARGIN, takeover: true }), entry({ sessionKey: RK, owner: PEER, epoch: 45 })], store);
    expect(store.read(RK)?.ownerMachineId).toBe(SELF);
  });
});

function cap(id: string, over: Partial<MachineCapacity> = {}): MachineCapacity {
  return { machineId: id, online: true, seamlessnessFlagsReceivedAt: new Date(2000).toISOString(), clockSkewStatus: 'ok', seamlessnessFlags: { appConversationsPool: true }, ...over } as MachineCapacity;
}

describe('the flag and the whole-pool gate (§2.6)', () => {
  const tracker = (start = 1000) => { const c = { now: start }; return { c, t: new AppFlagTracker({ now: () => c.now, holdsLease: () => true, selfId: () => SELF, intervalMs: 30_000 }) }; };
  const report = (at: number, flagged: boolean) => cap(PEER, { seamlessnessFlagsReceivedAt: new Date(at).toISOString(), seamlessnessFlags: flagged ? { appConversationsPool: true } : { ws12DrainReceive: true } });

  it('flagged; unknown until a report; unknown keeps the gate shut and never triggers enforcement', () => {
    const { t } = tracker();
    t.observe([cap(PEER)]);
    expect(t.stateOf(cap(PEER))).toBe('flagged');
    const notHeard = cap(PEER, { seamlessnessFlagsReceivedAt: new Date(500).toISOString() });
    expect(t.stateOf(notHeard)).toBe('unknown');
    expect(t.everyOnlineMachineFlagged([notHeard])).toBe(false);
    expect(t.positivelyUnflagged([notHeard])).toEqual([]);
  });

  it('a routine restart is not a downgrade: a false report followed by a true one never counts', () => {
    const { t, c } = tracker();
    t.observe([report(2000, false)]);
    expect(t.stateOf(report(2000, false))).toBe('unknown');
    c.now = 40_000;
    expect(t.stateOf(report(32_000, true))).toBe('flagged');
    c.now = 100_000;
    expect(t.stateOf(report(98_000, false))).toBe('unknown'); // the count started over
  });

  it('one false report, then silence: coarse beats keep the flags and move no clock, so it stays unknown for good', () => {
    const { t, c } = tracker();
    const once = report(2000, false);
    t.observe([once]);
    t.stateOf(once);
    c.now = 3_600_000;
    expect(t.stateOf(once)).toBe('unknown');
    expect(t.positivelyUnflagged([once])).toEqual([]);
  });

  it('an older machine: unflagged on a second report two heartbeats after the first', () => {
    const { t, c } = tracker();
    t.observe([report(2000, false)]);
    t.stateOf(report(2000, false));
    c.now = 40_000;
    expect(t.stateOf(report(32_000, false))).toBe('unknown');
    c.now = 70_000;
    expect(t.positivelyUnflagged([report(62_000, false)]).map((x) => x.machineId)).toEqual([PEER]);
  });

  it('a machine that has never sent flags says nothing', () => {
    const { t } = tracker();
    const coarse = cap(PEER, { seamlessnessFlags: undefined, seamlessnessFlagsReceivedAt: undefined });
    t.observe([coarse]);
    expect(t.stateOf(coarse)).toBe('unknown');
  });

  it('a gate answer counts until a newer report, in both directions', () => {
    const { t, c } = tracker();
    t.observe([cap(PEER)]);
    c.now = 3000;
    t.noteAnswer(PEER, true);
    expect(t.stateOf(report(2500, false))).toBe('flagged');
    t.noteAnswer(PEER, false);
    expect(t.stateOf(report(3500, true))).toBe('flagged'); // the newer report wins
  });

  it('every online machine must be flagged; an offline one does not count', () => {
    const { t } = tracker();
    expect(t.everyOnlineMachineFlagged([cap(PEER), cap('m3')])).toBe(true);
    expect(t.everyOnlineMachineFlagged([cap(PEER), cap('m3', { seamlessnessFlags: {} })])).toBe(false);
    expect(t.everyOnlineMachineFlagged([cap(PEER), cap('m3', { online: false, seamlessnessFlags: {} })])).toBe(true);
  });

  /** A tracker whose clock moves on between reads, so an unflagged reading has held long enough to count. */
  const agedFlags = () => { const f = new AppFlagTracker({ now: () => 1000, holdsLease: () => true, selfId: () => SELF }); return f; };
  const enforcer = (over: Partial<ConstructorParameters<typeof AppPoolEnforcer>[0]> & { recs?: SessionOwnershipRecord[] } = {}) => {
    const casCalls: Array<[string, string]> = [];
    const drains: Array<[string, string]> = [];
    const raised: string[] = [];
    const restored: number[] = [];
    let now = 5000;
    const e = new AppPoolEnforcer({
      selfId: () => SELF, active: () => true, selfFlagged: () => true, holdsLease: () => true, leaseHolderId: () => SELF,
      capacities: () => [], records: () => over.recs ?? [],
      cas: (k, a, why) => { casCalls.push([a.type, why]); return { ok: true, record: rec({ sessionKey: k, ownershipEpoch: 8 }) }; },
      drainRunning: () => false, moveInFlight: () => false,
      restoreDeliveryLedger: (_k, t) => { restored.push(t); },
      sendDrain: async (o, k) => { drains.push([o, k]); return { ok: true }; },
      raiseAttention: (i) => { raised.push(i.conditionKey); }, clearAttention: vi.fn(), nicknameOf: () => 'Old', now: () => now,
      transferDeadlineMs: 1000, flags: agedFlags(), ...over,
    });
    return { e, casCalls, drains, raised, restored, setNow: (n: number) => { now = n; } };
  };
  /** An older machine: each read of capacities is a newer full report, still without the flag. */
  const oldMachine = () => { let at = 2000; return () => { at += 100_000; return cap('m_old', { seamlessnessFlags: {}, seamlessnessFlagsReceivedAt: new Date(at).toISOString() }); }; };

  it('an unflagged lease holder: every owner aborts, then releases', () => {
    const { e, casCalls, restored } = enforcer({
      leaseHolderId: () => 'm_old', holdsLease: () => false, capacities: ((o) => () => [o()])(oldMachine()),
      recs: [rec({ ownerMachineId: SELF, status: 'transferring', transferTo: PEER, timestamp: 4900 }), rec({ sessionKey: `app:${KEY.replace('0f', '1f')}`, ownerMachineId: SELF })],
    });
    e.tick(); // the first reading starts its clock: nothing acts on one report
    expect(casCalls).toEqual([]);
    e.tick();
    expect(casCalls.map((c) => c[0])).toEqual(['abort-transfer', 'release', 'release']);
    expect(restored).toEqual([7]);
  });

  it('a flagged holder coming back online never triggers a release of everything', () => {
    const { e, casCalls } = enforcer({
      leaseHolderId: () => PEER, holdsLease: () => false,
      capacities: () => [cap(PEER, { seamlessnessFlagsReceivedAt: new Date(500).toISOString() })],
      recs: [rec({ ownerMachineId: SELF })],
    });
    e.tick();
    expect(casCalls).toEqual([]);
  });

  it('an unflagged machine online: drain home where the owner is flagged, force-claim where it is the old one, one notice', async () => {
    const { e, casCalls, drains, raised } = enforcer({
      capacities: ((o) => () => [o(), cap(PEER)])(oldMachine()),
      recs: [rec({ ownerMachineId: PEER }), rec({ sessionKey: `app:${KEY.replace('0f', '1f')}`, ownerMachineId: 'm_old' })],
    });
    e.tick();
    e.tick();
    e.tick();
    expect(drains).toEqual([[PEER, RK]]);
    expect(casCalls.filter((c) => c[0] === 'force-claim')).toHaveLength(2);
    expect(raised).toEqual([BROUGHT_HOME_CONDITION]);
  });

  it('an owner refusing the drain home is asked again only after the wait, not every tick', async () => {
    const h = enforcer({ capacities: ((o) => () => [o(), cap(PEER)])(oldMachine()), recs: [rec({ ownerMachineId: PEER })] });
    h.e.tick(); h.e.tick();
    await new Promise((r) => setImmediate(r));
    h.e.tick(); h.e.tick();
    await new Promise((r) => setImmediate(r));
    expect(h.drains).toHaveLength(1);
    h.setNow(5000 + 5 * 60_000 + 1);
    h.e.tick();
    expect(h.drains).toHaveLength(2);
  });

  it('a record stuck `transferring` goes back to its owner past the deadline, not while a drain runs', () => {
    const r = rec({ ownerMachineId: SELF, status: 'transferring', transferTo: PEER, timestamp: 1000 });
    const running = enforcer({ recs: [r], drainRunning: () => true, holdsLease: () => false });
    running.e.tick();
    expect(running.casCalls).toEqual([]);
    const young = enforcer({ recs: [{ ...r, timestamp: 4900 }], holdsLease: () => false });
    young.e.tick();
    expect(young.casCalls).toEqual([]);
    const stuck = enforcer({ recs: [r], holdsLease: () => false });
    stuck.e.tick();
    expect(stuck.casCalls[0][0]).toBe('abort-transfer');
    expect(stuck.restored).toEqual([7]);
  });

  it('the holder releases its own active record, unless a move is using it', () => {
    const r = rec({ ownerMachineId: SELF });
    const free = enforcer({ recs: [r] });
    free.e.tick();
    expect(free.casCalls).toEqual([['release', 'holder-serves-unmoved']]);
    const busy = enforcer({ recs: [r], moveInFlight: () => true });
    busy.e.tick();
    expect(busy.casCalls).toEqual([]);
    const notHolder = enforcer({ recs: [r], holdsLease: () => false });
    notHolder.e.tick();
    expect(notHolder.casCalls).toEqual([]);
  });

  it('a baseline left `placing` is finished, then released, so it can\'t queue messages forever', () => {
    const r = rec({ ownerMachineId: SELF, status: 'placing' });
    const stuck = enforcer({ recs: [r] });
    stuck.e.tick();
    expect(stuck.casCalls[0]).toEqual(['claim', 'stuck-placing']);
    const live = enforcer({ recs: [r], moveInFlight: () => true });
    live.e.tick();
    expect(live.casCalls).toEqual([]);
  });

  it('dark: nothing at all', () => {
    const { e, casCalls } = enforcer({ active: () => false, recs: [rec({ ownerMachineId: SELF })] });
    e.tick();
    expect(casCalls).toEqual([]);
  });
});

function moveDeps(over: Partial<AppMoveDeps> & { state?: { rec: SessionOwnershipRecord | null } } = {}) {
  const state = over.state ?? { rec: null };
  const cas: string[] = [];
  const drains: Array<[string, number]> = [];
  const inFlight: boolean[] = [];
  const reg = (k: string, a: Parameters<AppMoveDeps['cas']>[1]) => {
    cas.push(a.type);
    const t = applyOwnershipAction(state.rec, a, { sessionKey: k, nonce: 'n', now: 1 });
    if (!t.ok) return { ok: false };
    state.rec = t.next;
    return { ok: true, record: t.next };
  };
  const d: AppMoveDeps = {
    selfId: SELF,
    capacity: (m) => (m === PEER ? cap(PEER, { nickname: 'Laptop', seamlessnessFlags: { appConversationsPool: true, ws12DrainReceive: true, memoryPrivacyEnforced: false } }) : undefined),
    resolveMachine: (n) => (n === 'Laptop' || n === PEER ? PEER : n === SELF ? SELF : null),
    validNames: () => ['Laptop'],
    everyMachineFlagged: () => true, selfFlagged: () => true, selfDrainable: () => true,
    conversation: () => ({}),
    read: () => state.rec,
    cas: reg,
    sendDrain: async (owner, k, target, epoch) => {
      drains.push([owner, epoch]);
      reg(k, { type: 'transfer', to: target, drain: true });
      reg(k, { type: 'claim', machineId: target });
      return { ok: true, status: 'drained', claimLanded: true };
    },
    askOwner: async () => null,
    autonomousRun: async () => null,
    setMoveInFlight: (_k, on) => { inFlight.push(on); },
    leftBehindHere: () => ({ files: 0, notes: 0 }),
    afterMove: vi.fn(),
    lastMoveAt: () => null, noteMoved: vi.fn(), now: () => 100_000,
    ...over,
  };
  return { d, state, cas, drains, inFlight };
}
const moveInput = { conversationKey: KEY, to: 'Laptop', confirm: false };

describe('the move (§2.5)', () => {
  it('an unmoved conversation: place, claim, then a drain at the new epoch, never the baseline; no pin', async () => {
    const { d, state, cas, drains, inFlight } = moveDeps();
    const a = await runAppMove(d, moveInput);
    expect(a).toMatchObject({ status: 200, body: { ok: true, seatMoved: true, pinned: false, targetMachine: PEER, memoryNote: expect.stringContaining('starts empty') } });
    expect(cas.slice(0, 2)).toEqual(['place', 'claim']);
    expect(drains).toEqual([[SELF, 2]]);
    expect(state.rec).toMatchObject({ ownerMachineId: PEER, status: 'active' });
    expect(inFlight).toEqual([true, false]);
    expect(d.afterMove).toHaveBeenCalledWith(PEER, RK, SELF);
  });

  it('moving to where it already is writes nothing', async () => {
    const { d, cas } = moveDeps();
    const a = await runAppMove(d, { ...moveInput, to: SELF });
    expect(a.body).toMatchObject({ ok: true, action: 'noop', seatMoved: true });
    expect(cas).toEqual([]);
  });

  it('a moved conversation drains from its owner, at the record\'s epoch, without a baseline', async () => {
    const state = { rec: rec({ ownerMachineId: 'm_third', ownershipEpoch: 11 }) };
    const { d, cas, drains } = moveDeps({
      state,
      capacity: (m) => cap(m, { seamlessnessFlags: { appConversationsPool: true, ws12DrainReceive: true } }),
    });
    expect((await runAppMove(d, moveInput)).status).toBe(200);
    expect(drains).toEqual([['m_third', 11]]);
    expect(cas).not.toContain('place');
  });

  it('a failed drain answers 409 with no pin, and leaves the record for the enforcer to release', async () => {
    const { d, state } = moveDeps({ sendDrain: async () => ({ ok: false, status: 'refused-close-failed', reason: 'close-refused:open-commitment' }) });
    const a = await runAppMove(d, moveInput);
    expect(a).toMatchObject({ status: 409, body: { failedNeedsRetry: true } });
    expect(String(a.body.error)).toContain('stays where it is');
    expect(state.rec).toMatchObject({ ownerMachineId: SELF, status: 'active' });
  });

  it('a drain without its claim is a failure too', async () => {
    const { d } = moveDeps({ sendDrain: async () => ({ ok: true, status: 'drained', claimLanded: false }) });
    expect((await runAppMove(d, moveInput)).status).toBe(409);
  });

  it('the source says the claim landed after a timeout: the move completed', async () => {
    const state = { rec: rec({ ownerMachineId: 'm_third', ownershipEpoch: 11 }) };
    const { d } = moveDeps({
      state,
      capacity: (m) => cap(m, { seamlessnessFlags: { appConversationsPool: true, ws12DrainReceive: true } }),
      sendDrain: async () => { throw new Error('timed out'); },
      askOwner: async () => ({ owner: PEER, status: 'active', epoch: 13 }),
    });
    expect(await runAppMove(d, moveInput)).toMatchObject({ status: 200, body: { seatMoved: true } });
  });

  it('the source can\'t be asked: "may still complete", never a claim that it moved or stayed', async () => {
    const state = { rec: rec({ ownerMachineId: 'm_third', ownershipEpoch: 11 }) };
    const { d } = moveDeps({
      state,
      capacity: (m) => cap(m, { seamlessnessFlags: { appConversationsPool: true, ws12DrainReceive: true } }),
      sendDrain: async () => { throw new Error('timed out'); },
      askOwner: async () => null,
    });
    expect(await runAppMove(d, moveInput)).toMatchObject({ status: 409, body: { stillMayComplete: true, error: 'The move may still complete; check in a moment.' } });
  });

  it('no answer from the runner and the source still shows it moving: "may still complete", not "stays"', async () => {
    const state = { rec: rec({ ownerMachineId: 'm_third', ownershipEpoch: 11 }) };
    const { d } = moveDeps({
      state,
      capacity: (m) => cap(m, { seamlessnessFlags: { appConversationsPool: true, ws12DrainReceive: true } }),
      sendDrain: async () => ({ ok: false, reason: 'timed out' }),
      askOwner: async () => ({ owner: 'm_third', status: 'transferring', epoch: 12 }),
    });
    expect(await runAppMove(d, moveInput)).toMatchObject({ status: 409, body: { stillMayComplete: true } });
  });

  it('with the ledger hand-off on, the target must hold the new epoch before the drain; otherwise no drain and the holder keeps it', async () => {
    const seen: number[] = [];
    const ok = moveDeps({ awaitTargetRecord: async (_t, _k, e) => { seen.push(e); return true; } });
    expect((await runAppMove(ok.d, moveInput)).status).toBe(200);
    expect(seen).toEqual([2]); // the baseline's epoch, not 0
    const not = moveDeps({ awaitTargetRecord: async () => false });
    expect(await runAppMove(not.d, moveInput)).toMatchObject({ status: 409, body: { failedNeedsRetry: true } });
    expect(not.drains).toEqual([]);
    expect(not.state.rec).toMatchObject({ ownerMachineId: SELF, status: 'active' });
  });

  it('the whole-pool gate, the target flag and the owner\'s drain each refuse in words', async () => {
    for (const over of [
      { everyMachineFlagged: () => false },
      { selfFlagged: () => false },
      { selfDrainable: () => false },
      { capacity: () => cap(PEER, { seamlessnessFlags: { ws12DrainReceive: true } }) },
    ] as Array<Partial<AppMoveDeps>>) {
      const { d, cas } = moveDeps(over);
      expect(await runAppMove(d, moveInput)).toMatchObject({ status: 409, body: { code: 'needs-update', error: NEEDS_UPDATE } });
      expect(cas).toEqual([]);
    }
  });

  it('a support person\'s conversation moves only to a machine that keeps private memory', async () => {
    const without = moveDeps({ conversation: () => ({ ownerPerson: { userId: 'u' } }) });
    expect(await runAppMove(without.d, moveInput)).toMatchObject({ status: 409, body: { code: 'memory-privacy', error: NO_PRIVATE_MEMORY } });
    const withIt = moveDeps({
      conversation: () => ({ ownerPerson: { userId: 'u' } }),
      capacity: (m) => cap(m, { seamlessnessFlags: { appConversationsPool: true, ws12DrainReceive: true, memoryPrivacyEnforced: true } }),
    });
    expect((await runAppMove(withIt.d, moveInput)).status).toBe(200);
  });

  it('a target that is offline is refused, not confirmed', async () => {
    const { d, cas } = moveDeps({ capacity: (m) => cap(m, { online: false, seamlessnessFlags: { appConversationsPool: true, ws12DrainReceive: true } }) });
    expect(await runAppMove(d, { ...moveInput, confirm: true })).toMatchObject({ status: 409, body: { code: 'target-offline' } });
    expect(cas).toEqual([]);
  });

  it('a live run asks first; the challenge binds the virtual baseline; a confirmed call proceeds', async () => {
    const first = moveDeps({ autonomousRun: async () => ({ goal: 'build', remainingMinutes: 3, runKey: 'k' }) });
    const asked = await runAppMove(first.d, moveInput);
    expect(asked).toMatchObject({ status: 409, body: { needsConfirmation: true } });
    expect(String(asked.body.prompt)).toContain('starts empty');
    expect(first.cas).toEqual([]);
    const second = moveDeps({ autonomousRun: async () => ({ goal: 'build', remainingMinutes: 3, runKey: 'k' }) });
    expect((await runAppMove(second.d, { ...moveInput, confirm: true, confirmationChallenge: String(asked.body.confirmationChallenge) })).status).toBe(200);
    const wrong = moveDeps({ autonomousRun: async () => ({ goal: 'build', remainingMinutes: 3, runKey: 'k' }) });
    expect((await runAppMove(wrong.d, { ...moveInput, confirm: true, confirmationChallenge: 'x' })).status).toBe(409);
    expect(wrong.cas).toEqual([]);
  });

  it('the rate limit applies per key, in memory', async () => {
    const { d, cas } = moveDeps({ lastMoveAt: () => 99_000 });
    expect(await runAppMove(d, moveInput)).toMatchObject({ status: 409, body: { rejectReason: 'rate-limited' } });
    expect(cas).toEqual([]);
  });

  it('files and notes left on the old machine are named', async () => {
    const { d } = moveDeps({ leftBehindHere: () => ({ files: 2, notes: 1 }) });
    expect((await runAppMove(d, moveInput)).body.leftBehindWords).toBe('2 files still copying and 1 late transcript stayed on the old machine.');
  });

  it('a conversation mid-move, an unknown conversation, an unknown machine', async () => {
    const mid = moveDeps({ state: { rec: rec({ status: 'transferring', transferTo: 'x' }) } });
    expect(await runAppMove(mid.d, moveInput)).toMatchObject({ status: 409, body: { retryRequired: true } });
    const gone = moveDeps({ conversation: () => null });
    expect((await runAppMove(gone.d, moveInput)).status).toBe(404);
    const unknown = moveDeps();
    expect((await runAppMove(unknown.d, { ...moveInput, to: 'nope' })).status).toBe(404);
  });
});

describe('bring it back here (§2.2)', () => {
  const deps = (over: Partial<Parameters<typeof runBringBack>[0]> = {}) => {
    const actions: Array<{ type: string; epochMargin?: number; takeover?: boolean }> = [];
    const d: Parameters<typeof runBringBack>[0] = {
      selfId: SELF, holdsLease: () => true, read: () => rec(), conversation: () => ({}), ownerOnline: () => false,
      cas: (_k, a) => { actions.push(a as never); return { ok: true, record: rec({ ownershipEpoch: 1_000_006 }) }; },
      nicknameOf: () => 'Laptop', ...over,
    };
    return { d, actions };
  };

  it('asks first, saying what happens if the machine is still running it; nothing is written', () => {
    const { d, actions } = deps();
    expect(runBringBack(d, { conversationKey: KEY, confirmed: false })).toMatchObject({ status: 409, body: { needsConfirmation: true, prompt: bringBackWarning('Laptop') } });
    expect(actions).toEqual([]);
  });

  it('confirmed: a marked force-claim far above the epoch', () => {
    const { d, actions } = deps();
    expect(runBringBack(d, { conversationKey: KEY, confirmed: true })).toMatchObject({ status: 200, body: { broughtBack: true } });
    expect(actions).toEqual([{ type: 'force-claim', machineId: SELF, epochMargin: BRING_BACK_EPOCH_MARGIN, takeover: true }]);
  });

  it('refused while the owner answers, off the lease, or with nothing to bring', () => {
    expect(runBringBack(deps({ ownerOnline: () => true }).d, { conversationKey: KEY, confirmed: true })).toMatchObject({ status: 409, body: { code: 'owner-answering' } });
    expect(runBringBack(deps({ holdsLease: () => false }).d, { conversationKey: KEY, confirmed: true })).toMatchObject({ status: 409, body: { code: 'not-lease-holder' } });
    expect(runBringBack(deps({ read: () => null }).d, { conversationKey: KEY, confirmed: true }).body).toMatchObject({ noop: true });
    expect(runBringBack(deps({ conversation: () => null }).d, { conversationKey: KEY, confirmed: true }).status).toBe(404);
  });
});

describe('where a conversation runs (§2.2)', () => {
  const d = (over: Partial<Parameters<typeof appPlacement>[0]> = {}) => ({ selfId: SELF, holdsLease: () => true, read: () => rec(), ownerOnline: () => false, nicknameOf: () => 'Laptop', ...over });
  it('offers to bring it back only on the holder, only when the owner isn\'t answering', () => {
    expect(appPlacement(d(), KEY)).toMatchObject({ moved: true, machine: 'Laptop', answering: false, bringBack: { can: true, confirm: bringBackWarning('Laptop') } });
    expect(appPlacement(d({ ownerOnline: () => true }), KEY)).toMatchObject({ answering: true, bringBack: { can: false } });
    expect(appPlacement(d({ holdsLease: () => false }), KEY)).toMatchObject({ bringBack: { can: false } });
    expect(appPlacement(d({ read: () => null }), KEY)).toMatchObject({ moved: false, bringBack: { can: false } });
  });
});

describe('the drain seams (§2.4, §2.5)', () => {
  const runner = (over: Partial<ConstructorParameters<typeof SessionDrainRunner>[0]> = {}) => {
    const store = new InMemorySessionOwnershipStore();
    const reg = new SessionOwnershipRegistry({ store, seenNonce: () => false, recordNonce: () => undefined });
    reg.cas({ type: 'place', machineId: SELF }, { sessionKey: RK, sender: SELF, nonce: 'a' });
    reg.cas({ type: 'claim', machineId: SELF }, { sessionKey: RK, sender: SELF, nonce: 'b' });
    let n = 0;
    const r = new SessionDrainRunner({
      selfMachineId: SELF, readOwnership: (k) => reg.read(k), cas: (a, c) => reg.cas(a, { ...c, nonce: `x${++n}` }),
      suspendAutonomousRun: () => ({ suspended: false }), sessionQuiet: () => true, emergencyStopActive: () => false,
      terminateSession: async () => ({ terminated: true }), markInterrupted: () => undefined, notifyInterrupted: () => undefined,
      now: () => 0, sleep: async () => undefined, nonce: () => `n${++n}`, ...over,
    }, { drainBoundMs: 10, pollMs: 1 });
    return { r, reg };
  };

  it('a live app session the close can\'t find is a refusal, not "nothing to close": the claim never lands', async () => {
    const { r, reg } = runner({ terminateSession: async () => ({ terminated: false, skipped: 'app-session-record-missing' }) });
    const o = await r.run({ sessionKey: RK, target: PEER, senderObservedEpoch: 2 });
    expect(o.status).toBe('refused-close-failed');
    expect(reg.read(RK)).toMatchObject({ ownerMachineId: SELF, status: 'active' });
  });

  it('the emergency seam is told the key, so one conversation\'s stop aborts only its own drain; the flag clears when it ends', async () => {
    const seen: string[] = [];
    const ended: string[] = [];
    const { r, reg } = runner({ emergencyStopActive: (k) => { seen.push(k); return true; }, onDrainEnded: (k) => { ended.push(k); } });
    const o = await r.run({ sessionKey: RK, target: PEER, senderObservedEpoch: 2 });
    expect(o.status).toBe('aborted-emergency-stop');
    expect(seen[0]).toBe(RK);
    expect(ended).toEqual([RK]);
    expect(reg.read(RK)).toMatchObject({ ownerMachineId: SELF, status: 'active' });
  });

  it('isRunning holds for exactly the drain', async () => {
    let during = false;
    const holder: { r?: SessionDrainRunner } = {};
    const { r } = runner({ terminateSession: async () => { during = holder.r!.isRunning(RK); return { terminated: true }; } });
    holder.r = r;
    expect(r.isRunning(RK)).toBe(false);
    await r.run({ sessionKey: RK, target: PEER, senderObservedEpoch: 2 });
    expect(during).toBe(true);
    expect(r.isRunning(RK)).toBe(false);
  });
});

describe('the phone (§2.5)', () => {
  const ROW = { tmuxSession: 's', id: 'i', name: 'n', machineId: SELF, platform: 'headless', conversationRef: RK };
  const pool = (machines: unknown[]) => ({ status: 200, body: { selfMachineId: SELF, machines } });
  const m = (id: string, over: Record<string, unknown> = {}) => ({ machineId: id, nickname: id, online: true, seamlessnessFlags: { appConversationsPool: true }, ...over });
  const controls = (row: Record<string, unknown>, machines: unknown[]) => summarizeControls({ row, remote: false, options: null, profile: null, pool: pool(machines), peerInput: null } as never, {}, 0);

  it('offers Move with flagged targets only, naming the conversation, with the memory note', () => {
    const c = controls(ROW, [m(SELF), m(PEER)]);
    expect(c.move).toMatchObject({ state: 'ok', topic: RK, bringBack: { can: false } });
    expect((c.move as { choices: Array<{ machineId: string }> }).choices.map((x) => x.machineId)).toEqual([PEER]);
    expect((c.move as { note: string }).note).toContain('starts empty');
  });

  it('off on this agent: no machine is flagged, and it doesn\'t blame an update', () => {
    const c = controls(ROW, [m(SELF, { seamlessnessFlags: {} }), m(PEER, { seamlessnessFlags: {} })]);
    expect(c.move).toMatchObject({ state: 'not-yet', choices: [], bringBack: { can: false } });
    expect((c.move as { reason: string }).reason).toContain('isn\'t turned on for this agent yet');
  });

  it('an older machine online: said plainly, nothing offered', () => {
    const c = controls(ROW, [m(SELF), m(PEER, { seamlessnessFlags: {} })]);
    expect(c.move).toMatchObject({ state: 'not-yet', reason: NEEDS_UPDATE, topic: RK, choices: [] });
  });

  it('offers Bring it back here when the machine running it is not answering', () => {
    const c = controls({ ...ROW, machineId: PEER }, [m(SELF), m(PEER, { online: false, liveness: { state: 'unreachable' } })]);
    expect((c.move as { bringBack: { can: boolean; confirm: string } }).bringBack.can).toBe(true);
    expect((c.move as { bringBack: { confirm: string } }).bringBack.confirm).toContain('stopped as soon as it reconnects');
  });

  it('the signed line takes the reference, re-validated with real case; Slack and junk are refused', () => {
    const built = buildAction('session-move', RK, { to: PEER });
    expect(built).toMatchObject({ ok: true });
    expect(actionLine((built as { action: never }).action)).toBe(`session-move ${RK} ${PEER} none`);
    expect(buildAction('session-move', '7', { to: PEER })).toMatchObject({ ok: true });
    expect(buildAction('session-move', RK.toUpperCase(), { to: PEER })).toMatchObject({ ok: false, error: 'bad-target' });
    expect(buildAction('session-move', 'slack:T0XYZ:C0ABC', { to: PEER })).toMatchObject({ ok: false, error: 'bad-target' });
  });

  it('bring it back here is a signed action naming the conversation and whether it was confirmed', () => {
    const ask = buildAction('session-bring-back', RK, {});
    expect(actionLine((ask as { action: never }).action)).toBe(`session-bring-back ${RK} ask`);
    const yes = buildAction('session-bring-back', RK, { confirmation: 'confirmed' });
    expect(actionLine((yes as { action: never }).action)).toBe(`session-bring-back ${RK} confirmed`);
    expect(buildAction('session-bring-back', '7', {})).toMatchObject({ ok: false, error: 'bad-target' });
  });

  it('a move refused for the flag or memory says its own words', () => {
    expect(moveAnswer({ status: 409, body: { code: 'needs-update', error: NEEDS_UPDATE } }, 'Laptop')).toMatchObject({ status: 409, body: { error: 'needs-update', message: NEEDS_UPDATE } });
    expect(moveAnswer({ status: 409, body: { code: 'memory-privacy', error: NO_PRIVATE_MEMORY } }, 'Laptop').body).toMatchObject({ message: NO_PRIVATE_MEMORY });
    expect(moveAnswer({ status: 200, body: { ok: true, seatMoved: true, leftBehindWords: '1 file still copying stayed on the old machine.' } }, 'Laptop').body.message).toContain('1 file still copying');
  });
});
