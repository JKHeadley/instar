// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Feature-is-alive proof for app conversations in the pool (docs/specs/app-conversations-in-the-pool.md §6).
 *
 * Two machines over the un-stubbed replication hop (signed journal-sync over real HTTP, real journals,
 * the durable ownership store, the real applier), with the real router, deliver handler, drain runner,
 * move flow and conversation service on each. An unmoved app conversation moves; a message to it, sent
 * through the other machine, is answered by the target; the reply is visible from the first machine;
 * moving it back releases the record. Also: a stop reaches a draining owner, a takeover, and the
 * production AgentServer mounting the routes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { makeTwoNodeHarness, type HarnessNode, type TwoNodeHarness } from '../support/twoNodeOwnershipHarness.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { MobileChatRequestStore } from '../../src/core/MobileChatRequests.js';
import { SessionRouter } from '../../src/core/SessionRouter.js';
import { createDeliverMessageHandler } from '../../src/core/DeliverMessageHandler.js';
import { SessionDrainRunner } from '../../src/core/SessionDrainRunner.js';
import { AppLeaseGate, AppFlagTracker, AppPoolEnforcer, buildAppForward, createAppOwnerReceiver, appForwardSenderValid, type AppPoolHandle } from '../../src/core/appConversationPool.js';
import { runAppMove, runBringBack, type AppMoveDeps } from '../../src/core/appConversationMove.js';
import type { OwnershipAction } from '../../src/core/SessionOwnership.js';
import type { AppEvent, MessageEvent } from '../../src/core/AppConversationStore.js';
import type { AppDispatchInput } from '../../src/core/appInboundDispatch.js';
import type { MachineCapacity } from '../../src/core/types.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { summarizeControls } from '../../src/server/mobileSessionControlsRoutes.js';
import type { InstarConfig } from '../../src/core/types.js';

interface Machine {
  node: HarnessNode;
  svc: AppConversationService;
  registry: ConversationRegistry;
  router: SessionRouter;
  runner: SessionDrainRunner;
  deliver: ReturnType<typeof createDeliverMessageHandler>;
  dispatched: AppDispatchInput[];
  sessions: Map<string, boolean>;
  closes: string[];
  cas: (k: string, a: OwnershipAction, why: string) => { ok: boolean; record?: import('../../src/core/SessionOwnership.js').SessionOwnershipRecord };
  gate: AppLeaseGate;
  holds: { v: boolean };
  enforcer: AppPoolEnforcer;
  active: { v: boolean };
  outbox: AppEvent[];
}

let h: TwoNodeHarness;
let A: Machine;
let B: Machine;
const KEY = crypto.randomUUID();
const RK = `app:${KEY}`;
let n = 0;

function capsFor(self: Machine['node'], peer: () => Machine): MachineCapacity[] {
  const c = (id: string): MachineCapacity => ({ machineId: id, nickname: id === h.a.machineId ? 'Studio' : 'Laptop', online: true, clockSkewStatus: 'ok', seamlessnessFlagsReceivedAt: new Date(Date.now() + 60_000).toISOString(), seamlessnessFlags: { appConversationsPool: true, ws12DrainReceive: true, ws11DeliverReceive: true } }) as MachineCapacity;
  return [c(self.machineId), c(peer().node.machineId)];
}

function journalPlacement(node: HarnessNode, rk: string, r: { ok: boolean; record?: { ownerMachineId: string; ownershipEpoch: number; status: string; transferTo?: string; timestamp?: number; drainInFlight?: boolean; takeover?: boolean } }, reason: 'user-move' | 'released' | 'failover') {
  if (!r.ok || !r.record) return;
  const rec = r.record;
  node.journal.emitAppPlacement(rk, {
    owner: rec.ownerMachineId, epoch: rec.ownershipEpoch, reason: rec.status === 'released' ? 'released' : reason,
    ...(rec.status === 'released' ? { status: 'released' as const } : rec.status === 'transferring' ? { status: 'transferring' as const, ...(rec.transferTo ? { transferTo: rec.transferTo } : {}), ...(rec.timestamp ? { timestamp: rec.timestamp } : {}), ...(rec.drainInFlight ? { drainInFlight: true } : {}) } : {}),
    ...(rec.takeover ? { takeover: true } : {}),
  });
  node.journal.flush();
}

function makeMachine(node: HarnessNode, peer: () => Machine, holdsLease: boolean): Machine {
  const dir = path.join(node.stateDir, 'app');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => node.machineId, isRecordingEnabled: () => true });
  const dispatched: AppDispatchInput[] = [];
  const sessions = new Map<string, boolean>();
  const closes: string[] = [];
  const holds = { v: holdsLease };
  const active = { v: true };
  const m = {} as Machine;
  const handle: AppPoolHandle = {
    active: () => active.v,
    read: (k) => node.registry.read(k),
    gateOpenFor: (k) => m.gate.openFor(k),
    drainRunning: (k) => m.runner.isRunning(k),
    sessionRunning: (s) => sessions.get(s) === true,
    closeLostSession: async (_k, s) => { closes.push(s); sessions.set(s, false); return { closed: true }; },
    route: (msg) => m.router.route(msg),
    leaseHeldElsewhere: () => !holds.v,
    dropHeld: () => undefined,
    hasHeld: () => false,
  };
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => node.machineId, registry, requests: new MobileChatRequestStore(dir), holdsLease: () => holds.v, ownerName: () => 'Justin', pool: () => handle,
    killSession: (s) => { sessions.set(s, false); return true; },
    dispatch: () => async (input) => {
      dispatched.push(input);
      const name = `sess-${node.machineId}-${input.alias}`;
      sessions.set(name, true);
      svc.channels.register(String(input.alias), name, input.title);
      return 'delivered';
    },
  });
  const outbox: AppEvent[] = [];
  svc.store.setReplicationHook((ev) => { outbox.push(ev); });
  const cas: Machine['cas'] = (k, a, why) => {
    const r = node.registry.cas(a, { sessionKey: k, sender: node.machineId, nonce: `${node.machineId}:${why}:${++n}` });
    const out = r.ok ? { ok: true, record: r.record } : { ok: false };
    journalPlacement(node, k, out, a.type === 'force-claim' ? 'failover' : 'user-move');
    return out;
  };
  const receiver = createAppOwnerReceiver({ service: () => svc, storedEpoch: (k) => node.registry.read(k)?.ownershipEpoch ?? null, markInjected: () => undefined });
  const seen = new Set<string>();
  const deliver = createDeliverMessageHandler({
    ownerEpochOf: (s) => node.registry.read(s)?.ownershipEpoch ?? null,
    recordReceipt: (id) => { const f = !seen.has(id); seen.add(id); return f; },
    validateSender: (env, s, p) => appForwardSenderValid(env, s, p),
    onAccepted: (c) => receiver.accepted(c.session, c.messageId, c.payload),
    refusal: { canServe: () => true, alreadyReceived: (id) => seen.has(id) },
    app: { isApp: (c) => receiver.isApp(c.session), urgentAccepted: (c) => receiver.urgentAccepted(c.session, c.payload, c.ownershipEpoch), canTake: (c) => receiver.canTake(c.session), ingest: (c) => receiver.ingest(c.session, c.payload) },
  });
  const router = new SessionRouter({
    selfMachineId: node.machineId, placement: { decide: () => { throw new Error('an app conversation is never placed'); } } as never, machineRegistry: () => capsFor(node, peer),
    resolveOwnership: (k) => { const r = node.registry.read(k); if (!r) return { owner: null, epoch: 0, status: null }; return { owner: r.status === 'released' ? null : r.ownerMachineId, epoch: r.ownershipEpoch, status: r.status === 'released' ? null : (r.status as 'active') }; },
    isMachineAlive: () => true, casClaimOwnership: () => { throw new Error('never placed'); },
    deliverMessage: async (_t, env) => peer().deliver({ type: 'deliverMessage', session: env.sessionKey, messageId: env.messageId, payload: env.payload, ownershipEpoch: env.ownershipEpoch, senderEnvelope: env.senderEnvelope } as never, node.machineId) as never,
    handleLocally: async () => undefined, spawnOnMachine: async () => { throw new Error('never placed'); },
    appNoRecordServedHere: (k) => svc.serves(k.slice('app:'.length)),
    queueMessage: () => 'queued', raiseAttention: () => undefined, sleep: async () => undefined,
  });
  const runner = new SessionDrainRunner({
    selfMachineId: node.machineId, readOwnership: (k) => node.registry.read(k),
    cas: (a, c) => { const r = node.registry.cas(a, c); journalPlacement(node, c.sessionKey, r.ok ? { ok: true, record: r.record } : { ok: false }, 'user-move'); return r; },
    suspendAutonomousRun: () => ({ suspended: false }),
    sessionQuiet: () => true,
    emergencyStopActive: (k) => svc.emergencyMarked(k),
    onDrainEnded: (k) => svc.clearEmergency(k),
    terminateSession: async (k) => {
      const name = svc.sessionFor(k.slice('app:'.length));
      if (!name || sessions.get(name) !== true) return { terminated: false, skipped: 'no-local-session' };
      sessions.set(name, false); closes.push(name);
      return { terminated: true };
    },
    markInterrupted: () => undefined, notifyInterrupted: () => undefined,
    now: () => Date.now(), sleep: async () => undefined, nonce: () => `${node.machineId}:drain:${++n}`,
  }, { drainBoundMs: 1000, pollMs: 1 });
  const gate = new AppLeaseGate({ holdsLease: () => holds.v, peers: () => [peer().node.machineId], status: async () => ({ appOwned: peer().node.registry.all().filter((r) => r.ownerMachineId === peer().node.machineId && (r.status === 'active' || r.status === 'transferring')).map((r) => ({ key: r.sessionKey, epoch: r.ownershipEpoch, status: r.status })) }), storedEpoch: (k) => node.registry.read(k)?.ownershipEpoch ?? 0 });
  const flags = new AppFlagTracker({ now: () => Date.now(), holdsLease: () => holds.v, selfId: () => node.machineId });
  const enforcer = new AppPoolEnforcer({
    selfId: () => node.machineId, active: () => active.v, selfFlagged: () => true, holdsLease: () => holds.v,
    leaseHolderId: () => (holds.v ? node.machineId : peer().node.machineId), capacities: () => capsFor(node, peer),
    records: () => node.registry.all().filter((r) => r.sessionKey.startsWith('app:')), cas, drainRunning: (k) => runner.isRunning(k), moveInFlight: () => false,
    restoreDeliveryLedger: () => undefined, sendDrain: async () => ({ ok: false }), raiseAttention: () => undefined, clearAttention: () => undefined, nicknameOf: () => null,
    now: () => Date.now(), transferDeadlineMs: 45_000, flags,
  });
  Object.assign(m, { node, svc, registry, router, runner, deliver, dispatched, sessions, closes, cas, gate, holds, enforcer, active, outbox });
  return m;
}

const moveDeps = (holder: Machine, other: Machine): AppMoveDeps => ({
  selfId: holder.node.machineId,
  capacity: (id) => capsFor(holder.node, () => other).find((c) => c.machineId === id),
  resolveMachine: (name) => capsFor(holder.node, () => other).find((c) => c.nickname === name || c.machineId === name)?.machineId ?? null,
  validNames: () => ['Studio', 'Laptop'],
  everyMachineFlagged: () => true, selfFlagged: () => true, selfDrainable: () => true,
  conversation: (k) => holder.svc.liveConversation(k), read: (k) => holder.node.registry.read(k), cas: holder.cas,
  sendDrain: async (owner, k, target, epoch) => {
    const m = owner === holder.node.machineId ? holder : other;
    const o = await m.runner.run({ sessionKey: k, target, senderObservedEpoch: epoch });
    return { ok: o.status.startsWith('drained'), status: o.status, reason: o.detail, claimLanded: o.claimLanded === true };
  },
  askOwner: async () => null, autonomousRun: async () => null, setMoveInFlight: () => undefined,
  leftBehindHere: (k) => holder.svc.leftBehind(k), afterMove: () => undefined, lastMoveAt: () => null, noteMoved: () => undefined, now: () => Date.now(),
});

const sync = async (from: Machine, to: Machine): Promise<void> => { await h.replicate(from.node, to.node); h.applierTick(to.node); };
const settle = async (): Promise<void> => { await sync(A, B); await sync(B, A); A.svc.leaseTick(); B.svc.leaseTick(); await new Promise((r) => setImmediate(r)); };

const send = (holder: Machine, text: string, urgent?: 'stop' | 'pause') => {
  const id = crypto.randomUUID();
  const event: MessageEvent = { eventId: `op-${id}`, kind: 'message', conversationKey: KEY, messageId: `msg-${id}`, role: 'operator', text, at: new Date().toISOString(), machineId: holder.node.machineId, receivedAt: new Date().toISOString() } as MessageEvent;
  holder.svc.store.append(event);
  return { event, outcome: holder.router.route({ sessionKey: RK, messageId: event.messageId, payload: buildAppForward({ event, seed: `dev\u0000${id}`, ownerName: null, memoryPersonId: null, ...(urgent ? { urgent } : {}) }), senderEnvelope: { via: 'mobile-device', deviceId: 'dev', eventId: event.eventId }, ...(urgent ? { appUrgent: urgent } : {}) }) };
};

/** Replication of conversation events (the `appConversations` store), a separate path from ownership. */
const copyEvents = (from: Machine, to: Machine) => {
  to.svc.ingestReplicated(from.outbox);
};

beforeAll(async () => {
  h = await makeTwoNodeHarness();
  A = makeMachine(h.a, () => B, true);
  B = makeMachine(h.b, () => A, false);
  await A.gate.tick();
  A.svc.applyCreate('dev', 'req', KEY, 'Weekend');
  copyEvents(A, B);
}, 60_000);
afterAll(async () => { await h?.teardown(); });

describe('app conversations move between machines, on the production components', () => {
  it('unmoved: the lease holder serves it with no record, exactly as before', async () => {
    expect(A.node.registry.read(RK)).toBeNull();
    expect(A.svc.serves(KEY)).toBe(true);
    expect(B.svc.serves(KEY)).toBe(false);
    const { outcome } = send(A, 'hello');
    expect((await outcome).action).toBe('handled-locally');
  });

  it('moves through a completed drain: the source closes, the target owns it on BOTH machines after one real replication hop', async () => {
    // A live session on the source.
    const alias = A.registry.appAliasFor(KEY)!;
    A.sessions.set('sess-a', true);
    A.svc.channels.register(String(alias), 'sess-a', 'Weekend');
    const answer = await runAppMove(moveDeps(A, B), { conversationKey: KEY, to: 'Laptop', confirm: false });
    expect(answer).toMatchObject({ status: 200, body: { ok: true, seatMoved: true, pinned: false, targetMachine: h.b.machineId } });
    expect(A.closes).toEqual(['sess-a']);
    expect(A.node.registry.read(RK)).toMatchObject({ ownerMachineId: h.b.machineId, status: 'active' });
    expect(B.node.registry.read(RK)).toBeNull(); // not yet: only the journal carries it
    await settle();
    expect(B.node.registry.read(RK)).toMatchObject({ ownerMachineId: h.b.machineId, status: 'active' });
    expect(B.svc.serves(KEY)).toBe(true);
    expect(A.svc.serves(KEY)).toBe(false);
    expect(B.registry.isAppBound(B.registry.appAliasFor(KEY)!)).toBe(true);
    expect(A.registry.isAppBound(alias)).toBe(false);
  }, 60_000);

  it('a message sent through the holder is answered by the target; the reply is visible from the first machine', async () => {
    const before = A.dispatched.length;
    const { event, outcome } = send(A, 'are you on the laptop?');
    expect((await outcome)).toMatchObject({ action: 'forwarded', owner: h.b.machineId });
    await new Promise((r) => setTimeout(r, 20));
    expect(A.dispatched.length).toBe(before);
    expect(B.dispatched.at(-1)).toMatchObject({ conversationKey: KEY, messageId: event.messageId, text: 'are you on the laptop?' });
    expect(B.svc.store.deliveryState(event.messageId)).toBe('delivered');
    // The session replies on its machine; the reply replicates back.
    const replyId = crypto.randomUUID();
    B.svc.store.append({ eventId: `ag-${replyId}`, kind: 'message', conversationKey: KEY, messageId: `am-${replyId}`, role: 'agent', text: 'yes, on the laptop', at: new Date().toISOString(), machineId: h.b.machineId } as AppEvent);
    copyEvents(B, A);
    expect(A.svc.store.hasEvent(KEY, `ag-${replyId}`)).toBe(true);
  });

  it('a stale copy waking on the old machine closes the moment it learns', async () => {
    A.sessions.set('sess-stale', true);
    A.svc.channels.register(String(A.registry.appAliasFor(KEY)!), 'sess-stale', 'Weekend');
    A.svc.leaseTick();
    await new Promise((r) => setImmediate(r));
    expect(A.closes).toContain('sess-stale');
  });

  it('a stop reaches a draining owner, aborts the drain, and the conversation stays', async () => {
    const epoch = B.node.registry.read(RK)!.ownershipEpoch;
    let release: () => void = () => undefined;
    const quiet = new Promise<void>((r) => { release = r; });
    // The owner mid-drain: a slow turn holds the runner in its wait.
    const slow = new SessionDrainRunner({
      selfMachineId: h.b.machineId, readOwnership: (k) => B.node.registry.read(k),
      cas: (a, c) => { const r = B.node.registry.cas(a, c); journalPlacement(B.node, c.sessionKey, r.ok ? { ok: true, record: r.record } : { ok: false }, 'user-move'); return r; },
      suspendAutonomousRun: () => ({ suspended: false }), sessionQuiet: () => false,
      emergencyStopActive: (k) => B.svc.emergencyMarked(k), onDrainEnded: (k) => B.svc.clearEmergency(k),
      terminateSession: async () => ({ terminated: true }), markInterrupted: () => undefined, notifyInterrupted: () => undefined,
      now: () => Date.now(), sleep: () => new Promise((r) => setTimeout(r, 5)), nonce: () => `slow:${++n}`,
    }, { drainBoundMs: 60_000, pollMs: 5 });
    (B as { runner: SessionDrainRunner }).runner = slow;
    const draining = slow.run({ sessionKey: RK, target: h.a.machineId, senderObservedEpoch: epoch });
    await new Promise((r) => setTimeout(r, 15));
    expect(B.node.registry.read(RK)?.status).toBe('transferring');
    // The holder still reads the old epoch (its copy lags); the stop must not lose to the fence.
    expect(A.node.registry.read(RK)?.ownershipEpoch).toBe(epoch);
    const { outcome } = send(A, 'stop', 'stop');
    expect((await outcome).action).toBe('forwarded');
    const done = await draining;
    release();
    await quiet;
    expect(done.status).toBe('aborted-emergency-stop');
    expect(B.node.registry.read(RK)).toMatchObject({ ownerMachineId: h.b.machineId, status: 'active' });
    expect(B.svc.emergencyMarked(RK)).toBe(false); // a later move isn't aborted by it
    await settle();
  }, 60_000);

  it('moving it back is a drain to the holder, then the holder releases its record; the holder serves it as unmoved', async () => {
    (B as { runner: SessionDrainRunner }).runner = new SessionDrainRunner({
      selfMachineId: h.b.machineId, readOwnership: (k) => B.node.registry.read(k),
      cas: (a, c) => { const r = B.node.registry.cas(a, c); journalPlacement(B.node, c.sessionKey, r.ok ? { ok: true, record: r.record } : { ok: false }, 'user-move'); return r; },
      suspendAutonomousRun: () => ({ suspended: false }), sessionQuiet: () => true, emergencyStopActive: () => false,
      terminateSession: async () => ({ terminated: true }), markInterrupted: () => undefined, notifyInterrupted: () => undefined,
      now: () => Date.now(), sleep: async () => undefined, nonce: () => `back:${++n}`,
    }, { drainBoundMs: 1000, pollMs: 1 });
    const answer = await runAppMove(moveDeps(A, B), { conversationKey: KEY, to: 'Studio', confirm: false });
    expect(answer).toMatchObject({ status: 200, body: { seatMoved: true, targetMachine: h.a.machineId } });
    await settle();
    expect(A.node.registry.read(RK)).toMatchObject({ ownerMachineId: h.a.machineId, status: 'active' });
    A.enforcer.tick();
    expect(A.node.registry.read(RK)?.status).toBe('released');
    await settle();
    expect(B.node.registry.read(RK)?.status).toBe('released');
    expect(A.svc.serves(KEY)).toBe(true);
    expect(B.svc.serves(KEY)).toBe(false);
    expect((await send(A, 'back home').outcome).action).toBe('handled-locally');
  }, 60_000);

  it('bring it back here: a far-side machine keeps writing, and every machine still settles on the holder', async () => {
    const moved = await runAppMove({ ...moveDeps(A, B), lastMoveAt: () => null }, { conversationKey: KEY, to: 'Laptop', confirm: false });
    expect(moved.status).toBe(200);
    await settle();
    const taken = runBringBack({ selfId: h.a.machineId, holdsLease: () => true, read: (k) => A.node.registry.read(k), conversation: (k) => A.svc.liveConversation(k), ownerOnline: () => false, cas: (k, a) => A.cas(k, a, 'takeover'), nicknameOf: () => 'Laptop' }, { conversationKey: KEY, confirmed: true });
    expect(taken).toMatchObject({ status: 200, body: { broughtBack: true } });
    // The partition's far side acts cooperatively meanwhile. It can't climb a million epochs.
    const far = B.cas(RK, { type: 'transfer', to: h.a.machineId, drain: true }, 'far');
    expect(far.ok).toBe(true);
    await settle();
    expect(B.node.registry.read(RK)).toMatchObject({ ownerMachineId: h.a.machineId, takeover: true });
    expect(A.node.registry.read(RK)?.ownerMachineId).toBe(h.a.machineId);
    expect(B.svc.serves(KEY)).toBe(false);
  }, 60_000);

  it('the receiving machine refuses a forward for a conversation it doesn\'t serve: `not-yet`, and the holder keeps it', async () => {
    const rec = B.node.registry.read(RK)!;
    const id = crypto.randomUUID();
    const event = { eventId: `op-${id}`, kind: 'message', conversationKey: KEY, messageId: `m-${id}`, role: 'operator', text: 'x', at: new Date().toISOString(), machineId: h.a.machineId, receivedAt: new Date().toISOString() };
    const ack = B.deliver({ type: 'deliverMessage', session: RK, messageId: event.messageId, payload: buildAppForward({ event: event as never, seed: 's', ownerName: null, memoryPersonId: null }), ownershipEpoch: rec.ownershipEpoch, senderEnvelope: { via: 'mobile-device', deviceId: 'dev', eventId: event.eventId } } as never, h.a.machineId) as { accepted: string };
    expect(ack.accepted).toBe('not-yet');
  });
});

describe('production wiring', () => {
  const dirs: string[] = [];
  const servers: AgentServer[] = [];
  afterAll(async () => {
    for (const s of servers) await s.stop();
    for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/app-conversations-pool-alive.test.ts' });
  });

  const boot = (developmentAgent: boolean) => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'app-pool-e2e-'));
    dirs.push(dir);
    const stateDir = path.join(dir, '.instar');
    for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    const config = {
      projectName: 'app-pool-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 4, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    } as unknown as InstarConfig;
    const state = new StateManager(stateDir);
    const sessionManager = createMockSessionManager() as never as { on: () => void };
    sessionManager.on = () => undefined;
    const server = new AgentServer({ config, sessionManager, state, initiativeTracker: new InitiativeTracker(stateDir) } as never);
    servers.push(server);
    return server.getApp();
  };
  const auth = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'app-pool-e2e');

  it('is alive: the routes are mounted on a real AgentServer and answer 503 while the pool is off, never 404', async () => {
    const app = boot(true);
    expect((await auth(request(app).post('/pool/bring-back')).send({ conversation: `app:${KEY}` })).status).toBe(503);
    expect((await auth(request(app).post('/pool/bring-back')).send({ conversation: '7' })).status).toBe(400);
    const t = await auth(request(app).post('/pool/transfer')).send({ topic: `app:${KEY}`, to: 'Laptop' });
    expect(t.status).toBe(503);
  }, 60_000);

  it('off for the fleet: an agent that is not a development agent gets no move, and the menu says so without blaming an update', async () => {
    const app = boot(false);
    const t = await auth(request(app).post('/pool/transfer')).send({ topic: `app:${KEY}`, to: 'Laptop' });
    expect(t.status).toBe(503);
    expect((await auth(request(app).post('/pool/bring-back')).send({ conversation: `app:${KEY}` })).status).toBe(503);
    const server = fs.readFileSync('src/commands/server.ts', 'utf-8');
    const at = server.indexOf('const appActive = (): boolean =>');
    expect(server.slice(at, server.indexOf('\n', at))).toContain('resolveDevAgentGate(config.multiMachine?.sessionPool?.appConversations?.enabled, config)');
    const c = summarizeControls({
      row: { tmuxSession: 's', id: 'i', name: 'n', machineId: 'm1', platform: 'headless', conversationRef: `app:${KEY}` }, remote: false, options: null, profile: null, peerInput: null,
      pool: { status: 200, body: { selfMachineId: 'm1', machines: [{ machineId: 'm1', nickname: 'One', online: true, seamlessnessFlags: { appConversationsPool: false } }, { machineId: 'm2', nickname: 'Two', online: true, seamlessnessFlags: {} }] } },
    } as never, {}, 0);
    expect(c.move).toMatchObject({ state: 'not-yet', topic: `app:${KEY}`, choices: [] });
    expect((c.move as { reason: string }).reason).toContain('isn\'t turned on for this agent yet');
  }, 60_000);
});
