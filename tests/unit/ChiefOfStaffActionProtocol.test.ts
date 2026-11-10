/**
 * Chief of Staff action protocol (docs/specs/chief-of-staff-topic.md §2.4) — every dep is a
 * fake, so the exact decision boundaries are driven: claim/verify/execute/settle, every refusal
 * reason, the failover races (claimed-vs-claimed, executing-vs-claimed), crash between
 * `executing` and `started`, reboot (index rebuilt from the union + registry), ownership move
 * before replication (transfer barrier), durability failure (no executor call), duplicates
 * (recorded outcome, never compensated) and compensation by exact run id only.
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { chiefOfStaffRecordStoreSchema, foldIntentState, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
import {
  ChiefOfStaffActionProtocol, decideStandDown, arbitrateClaims, canonicalCommand,
  type CosProtocolDeps, type CosActionCommand, type StandDownInputs,
} from '../../src/core/ChiefOfStaffActionProtocol.js';

const CK = 'telegram:141014';
const T0 = Date.parse('2026-11-09T12:00:00Z');
const ctx = () => ({ countDroppedField: () => {}, countJailReject: () => {} });

/** A shared in-memory "journal": every machine's emits land here, validated, with per-kind seq. */
class FakeJournal {
  entries: UnionEntry[] = [];
  seq = 0;
  durable = 0;
  failDurability = false;
  holdDurability = false;
  clock = 1000;
  emitFor(origin: string) {
    return (recordKey: string, build: (hlc: HlcTimestamp, origin: string) => Record<string, unknown> | null) => {
      const hlc: HlcTimestamp = { physical: ++this.clock, logical: 0, node: origin };
      const data = build(hlc, origin);
      if (!data) return { outcome: 'dropped' };
      const validated = chiefOfStaffRecordStoreSchema.validate(data, ctx());
      if (!validated) return { outcome: 'dropped:schema' };
      this.entries.push({ data: { ...validated, recordKey, hlc, op: 'put', origin }, origin });
      const seq = ++this.seq;
      if (!this.holdDurability) this.durable = seq;
      return { outcome: 'emitted', seq };
    };
  }
  seam(origin: string, opts: { partial?: (e: UnionEntry[]) => UnionEntry[] } = {}) {
    return {
      emit: this.emitFor(origin),
      awaitDurable: async (seq: number) => { if (this.failDurability) throw new Error('fsync failed'); if (seq > this.durable) throw new Error('timeout'); },
      flush: () => { if (!this.holdDurability) this.durable = this.seq; },
      loadUnion: () => (opts.partial ? opts.partial(this.entries) : this.entries).slice(),
    };
  }
}

interface World {
  journal: FakeJournal;
  holder: string;
  owner: Record<string, string>;
  runState: Record<string, StandDownInputs['runState']>;
  registry: Map<string, { runId: string }>;
  reconciler: Record<string, string | null>;
  queueHolds: Set<string>;
  moving: Set<string>;
  stopped: Set<string>;
  operatorLeaseLive: boolean;
  gate: Record<string, { nextActionAllowedAt: string | null; newestCheckAgeMs: number | null }>;
  started: Array<{ machine: string; key: string; kind: 'run' | 'inject' }>;
  routed: Array<{ to: string; cmd: unknown }>;
  stopped_runs: string[];
  fresh: boolean;
  enabled: boolean;
  executorThrows: boolean;
  now: number;
}

function world(): World {
  return {
    journal: new FakeJournal(), holder: 'm_a', owner: { [CK]: 'm_a' }, runState: { [CK]: 'none' }, registry: new Map(),
    reconciler: { [CK]: 'healthy' }, queueHolds: new Set(), moving: new Set(), stopped: new Set(), operatorLeaseLive: true,
    gate: { [CK]: { nextActionAllowedAt: null, newestCheckAgeMs: 1000 } }, started: [], routed: [], stopped_runs: [], fresh: true, enabled: true, executorThrows: false, now: T0,
  };
}

function machine(w: World, id: string, peers: Record<string, ChiefOfStaffActionProtocol> = {}, partial?: (e: UnionEntry[]) => UnionEntry[]): ChiefOfStaffActionProtocol {
  let runCounter = 0;
  const deps: CosProtocolDeps = {
    enabled: () => w.enabled,
    now: () => w.now,
    machineId: id,
    journal: w.journal.seam(id, { partial }),
    lease: { currentHolder: () => w.holder, freshRenewalWithin: () => w.fresh, ttlMs: 30_000, currentEpoch: () => 7, holdsLease: () => w.holder === id },
    ownerOf: (ck) => w.owner[ck] ?? null,
    sign: (c) => `sig(${id}:${c})`,
    verify: (c, sig, m) => sig === `sig(${m}:${c})`,
    runRegistry: {
      stateFor: (ck) => w.runState[ck] ?? 'none',
      findByIdempotencyKey: (k) => w.registry.get(k) ?? null,
      stopRun: (runId) => { w.stopped_runs.push(runId); },
    },
    reconcilerCondition: (ck) => w.reconciler[ck] ?? null,
    resumeQueueHolds: (ck) => w.queueHolds.has(ck),
    moveInProgress: (ck) => w.moving.has(ck),
    operatorStoppedSince: (ck) => w.stopped.has(ck),
    operatorLeaseLive: () => w.operatorLeaseLive,
    actionGate: (ck) => w.gate[ck] ?? { nextActionAllowedAt: null, newestCheckAgeMs: null },
    laggingFoldMs: 30 * 60_000,
    withConversationLock: async (_ck, fn) => fn(),
    executors: {
      startRun: async ({ idempotencyKey }) => { if (w.executorThrows) throw new Error('spawn exploded'); const runId = `run-${id}-${++runCounter}`; w.registry.set(idempotencyKey, { runId }); w.started.push({ machine: id, key: idempotencyKey, kind: 'run' }); return { runId }; },
      inject: async ({ idempotencyKey }) => { if (w.executorThrows) throw new Error('inject exploded'); w.started.push({ machine: id, key: idempotencyKey, kind: 'inject' }); return { injectId: `inj-${id}-${++runCounter}` }; },
      liveSession: () => false,
    },
    route: async (to, cmd) => { w.routed.push({ to, cmd }); const peer = peers[to]; if (!peer) throw new Error('unreachable'); return cmd.type === 'cos-action' ? peer.execute(cmd) : peer.settle(cmd); },
    maxRunHours: 4,
  };
  return new ChiefOfStaffActionProtocol(deps);
}

const sealed = (c: Omit<CosActionCommand, 'holderSignature'>): CosActionCommand => ({ ...c, holderSignature: `sig(${c.holderMachineId}:${canonicalCommand(c)})` });
const states = (w: World) => [...foldIntentState(w.journal.entries).values()].map((s) => `${s.action}:${s.state}`);

describe('decideStandDown + arbitrateClaims (pure)', () => {
  const base: StandDownInputs = { runState: 'none', reconcilerCondition: 'healthy', resumeQueueHolds: false, moveInProgress: false, operatorStopped: false, otherOpenIntents: [] };
  it('null when nothing owns the slot; history records do not block', () => {
    expect(decideStandDown(base)).toBeNull();
    expect(decideStandDown({ ...base, runState: 'history' })).toBeNull();
  });
  it('every blocker in priority order, and unknown reads fail to the safe side', () => {
    expect(decideStandDown({ ...base, runState: 'unknown' })).toBe('registry-unreadable');
    expect(decideStandDown({ ...base, runState: 'open' })).toBe('run-active');
    expect(decideStandDown({ ...base, runState: 'queued' })).toBe('run-queued');
    expect(decideStandDown({ ...base, reconcilerCondition: 'debouncing' })).toBe('reconciler-non-idle');
    expect(decideStandDown({ ...base, reconcilerCondition: 'blocked-queue-owns' })).toBe('reconciler-non-idle');
    expect(decideStandDown({ ...base, resumeQueueHolds: null })).toBe('resume-queue-holds');
    expect(decideStandDown({ ...base, moveInProgress: true })).toBe('move-in-progress');
    expect(decideStandDown({ ...base, operatorStopped: null })).toBe('operator-stopped');
  });
  it('arbitration: lowest HLC proceeds among claimed-only; any executing blocks', () => {
    const mk = (key: string, physical: number, state: 'claimed' | 'executing') => ({ intentKey: key, conversationKey: CK, action: 'restart-run' as const, leaseEpoch: 1, sequence: 1, intentHlc: { physical, logical: 0, node: 'x' }, state, open: true });
    expect(arbitrateClaims(mk('a', 1, 'claimed'), [])).toEqual({ proceed: true, supersede: [] });
    const r = arbitrateClaims(mk('a', 1, 'claimed'), [mk('b', 2, 'claimed')]);
    expect(r.proceed).toBe(true); expect(r.supersede.map((s) => s.intentKey)).toEqual(['b']);
    expect(arbitrateClaims(mk('b', 2, 'claimed'), [mk('a', 1, 'claimed')]).proceed).toBe(false);
    expect(arbitrateClaims(mk('a', 1, 'claimed'), [mk('b', 2, 'executing')]).proceed).toBe(false);
  });
});

describe('ChiefOfStaffActionProtocol — local happy paths', () => {
  it('restart-run: intent → executing (durable) → started, executor called once with the intent key', async () => {
    const w = world(); const A = machine(w, 'm_a');
    const r = await A.claim({ conversationKey: CK, action: 'restart-run', payload: { durationHours: 2, text: 'continue' } });
    expect(r.outcome).toBe('started');
    expect(w.started).toHaveLength(1); expect(w.started[0].kind).toBe('run');
    expect(states(w)).toEqual(['restart-run:started']);
    const st = [...foldIntentState(w.journal.entries).values()][0];
    expect(st.runId).toMatch(/^run-m_a-/); expect(st.open).toBe(false);
  });
  it('redirect: injects into the live session and records started with an inject id', async () => {
    const w = world(); const A = machine(w, 'm_a');
    const r = await A.claim({ conversationKey: CK, action: 'redirect', payload: { text: 'back to the goal' } });
    expect(r.outcome).toBe('started'); expect(w.started[0].kind).toBe('inject');
    expect([...foldIntentState(w.journal.entries).values()][0].injectId).toMatch(/^inj-/);
  });
  it('the run duration is clamped to maxRunHours', async () => {
    const w = world(); let seen = 0;
    const A = machine(w, 'm_a');
    (A as unknown as { d: CosProtocolDeps }).d.executors.startRun = async ({ durationHours, idempotencyKey }) => { seen = durationHours!; w.registry.set(idempotencyKey, { runId: 'r' }); return { runId: 'r' }; };
    await A.claim({ conversationKey: CK, action: 'restart-run', payload: { durationHours: 99 } });
    expect(seen).toBe(4);
  });
});

describe('ChiefOfStaffActionProtocol — refusals (every reason, safe side)', () => {
  it('disabled / not holder / operator lease expired / stand-down refuse at claim time with no record of execution', async () => {
    const w = world(); const A = machine(w, 'm_a');
    w.enabled = false; expect((await A.claim({ conversationKey: CK, action: 'redirect', payload: {} })).outcome).toBe('disabled'); w.enabled = true;
    w.holder = 'm_b'; expect(await A.claim({ conversationKey: CK, action: 'redirect', payload: {} })).toMatchObject({ outcome: 'rejected', reason: 'not-current-holder' }); w.holder = 'm_a';
    w.operatorLeaseLive = false; expect(await A.claim({ conversationKey: CK, action: 'redirect', payload: {} })).toMatchObject({ outcome: 'rejected', reason: 'operator-lease-expired' }); w.operatorLeaseLive = true;
    w.runState[CK] = 'open'; expect(await A.claim({ conversationKey: CK, action: 'redirect', payload: {} })).toMatchObject({ outcome: 'rejected', reason: 'stand-down' }); w.runState[CK] = 'none';
    w.reconciler[CK] = 'respawned'; expect(await A.claim({ conversationKey: CK, action: 'redirect', payload: {} })).toMatchObject({ outcome: 'rejected', reason: 'stand-down' }); w.reconciler[CK] = 'healthy';
    w.queueHolds.add(CK); expect(await A.claim({ conversationKey: CK, action: 'redirect', payload: {} })).toMatchObject({ outcome: 'rejected', reason: 'stand-down' }); w.queueHolds.delete(CK);
    w.moving.add(CK); expect(await A.claim({ conversationKey: CK, action: 'redirect', payload: {} })).toMatchObject({ outcome: 'rejected', reason: 'stand-down' }); w.moving.delete(CK);
    w.stopped.add(CK); expect(await A.claim({ conversationKey: CK, action: 'redirect', payload: {} })).toMatchObject({ outcome: 'rejected', reason: 'stand-down' });
    expect(w.started).toHaveLength(0); expect(w.journal.entries).toHaveLength(0);
  });
  it('execute: forged signature, stale holder renewal, wrong holder, not owner, operator lease expired, lagging fold, backoff — each rejected and recorded, no executor call', async () => {
    const w = world(); const A = machine(w, 'm_a');
    const good: CosActionCommand = sealed({ type: 'cos-action', conversationKey: CK, action: 'redirect', leaseEpoch: 7, sequence: 1, holderMachineId: 'm_a', claimedAt: new Date(T0).toISOString(), payload: { text: 'x' } });
    expect(await A.execute({ ...good, holderSignature: 'sig(m_z:nope)' })).toMatchObject({ outcome: 'rejected', reason: 'holder-signature-invalid' });
    w.holder = 'm_b'; expect(await A.execute(good)).toMatchObject({ outcome: 'rejected', reason: 'not-current-holder' }); w.holder = 'm_a';
    w.fresh = false; expect(await A.execute(good)).toMatchObject({ outcome: 'rejected', reason: 'holder-lease-stale' }); w.fresh = true;
    w.owner[CK] = 'm_b'; expect(await A.execute(good)).toMatchObject({ outcome: 'rejected', reason: 'not-owner' }); w.owner[CK] = 'm_a';
    w.operatorLeaseLive = false; expect(await A.execute(good)).toMatchObject({ outcome: 'rejected', reason: 'operator-lease-expired' }); w.operatorLeaseLive = true;
    w.gate[CK] = { nextActionAllowedAt: null, newestCheckAgeMs: 60 * 60_000 }; expect(await A.execute(good)).toMatchObject({ outcome: 'rejected', reason: 'lagging-fold' });
    w.gate[CK] = { nextActionAllowedAt: new Date(T0 + 60_000).toISOString(), newestCheckAgeMs: 1000 }; expect(await A.execute(good)).toMatchObject({ outcome: 'rejected', reason: 'next-action-not-allowed' });
    expect(w.started).toHaveLength(0);
    // Only AUTHENTICATED refusals (not-owner, operator lease, lagging fold, backoff) leave a durable
    // `rejected`; the three pre-authentication refusals above wrote nothing.
    expect(w.journal.entries.filter((e) => e.data.recordType === 'outcome' && e.data.transition === 'rejected').length).toBe(4);
  });
  it('a verified command whose intent has not replicated yet materialises the intent from the command and proceeds', async () => {
    const w = world(); const A = machine(w, 'm_a');
    const cmd: CosActionCommand = sealed({ type: 'cos-action', conversationKey: CK, action: 'redirect', leaseEpoch: 7, sequence: 42, holderMachineId: 'm_a', claimedAt: new Date(T0).toISOString(), payload: { text: 'x' } });
    expect((await A.execute(cmd)).outcome).toBe('started');
    const st = foldIntentState(w.journal.entries).get(`${CK}:7:42`)!;
    expect(st.state).toBe('started');
    expect(w.journal.entries.find((e) => e.data.recordType === 'intent')!.data.machine).toBe('m_a');
  });
});

describe('ChiefOfStaffActionProtocol — routing, durability, duplicates, compensation', () => {
  it('routes to the ownership machine when it is not self; the owner executes', async () => {
    const w = world(); w.owner[CK] = 'm_b';
    const B = machine(w, 'm_b'); const A = machine(w, 'm_a', { m_b: B });
    const r = await A.claim({ conversationKey: CK, action: 'restart-run', payload: {} });
    expect(r.outcome).toBe('routed'); expect(w.routed[0].to).toBe('m_b');
    expect((r as { result: { outcome: string } }).result.outcome).toBe('started');
    expect(w.started[0].machine).toBe('m_b');
  });
  it('durability failure before the side effect aborts as rejected with NO executor call', async () => {
    const w = world(); const A = machine(w, 'm_a'); w.journal.failDurability = true;
    const r = await A.claim({ conversationKey: CK, action: 'restart-run', payload: {} });
    expect(r).toMatchObject({ outcome: 'rejected', reason: 'durability-failed' });
    expect(w.started).toHaveLength(0);
  });
  it('a duplicate command returns the recorded outcome; nothing executes twice and nothing is compensated', async () => {
    const w = world(); const A = machine(w, 'm_a');
    const first = await A.claim({ conversationKey: CK, action: 'restart-run', payload: {} });
    const st = [...foldIntentState(w.journal.entries).values()][0];
    const cmd: CosActionCommand = sealed({ type: 'cos-action', conversationKey: CK, action: 'restart-run', leaseEpoch: st.leaseEpoch, sequence: st.sequence, holderMachineId: 'm_a', claimedAt: new Date(T0).toISOString(), payload: {} });
    const again = await A.execute(cmd);
    expect(again).toMatchObject({ outcome: 'started', duplicate: true, runId: (first as { runId: string }).runId });
    expect(w.started).toHaveLength(1); expect(w.stopped_runs).toEqual([]);
  });
  it('after a reboot the index is rebuilt from the union + registry and the duplicate still returns the recorded outcome', async () => {
    const w = world(); const A = machine(w, 'm_a');
    const first = await A.claim({ conversationKey: CK, action: 'restart-run', payload: {} });
    const st = [...foldIntentState(w.journal.entries).values()][0];
    const A2 = machine(w, 'm_a'); // new process, empty memory
    const cmd: CosActionCommand = sealed({ type: 'cos-action', conversationKey: CK, action: 'restart-run', leaseEpoch: st.leaseEpoch, sequence: st.sequence, holderMachineId: 'm_a', claimedAt: new Date(T0).toISOString(), payload: {} });
    expect(await A2.execute(cmd)).toMatchObject({ outcome: 'started', duplicate: true, runId: (first as { runId: string }).runId });
    expect(w.started).toHaveLength(1);
  });
  it('compensation stops a run only by the exact id the protocol started', async () => {
    const w = world(); const A = machine(w, 'm_a');
    const r = await A.claim({ conversationKey: CK, action: 'restart-run', payload: {} }) as { runId: string };
    const key = [...foldIntentState(w.journal.entries).keys()][0];
    await A.abortOwnRun(key, 'some-other-run', 'fence-failed');
    expect(w.stopped_runs).toEqual([]);
    await A.abortOwnRun(key, r.runId, 'fence-failed');
    expect(w.stopped_runs).toEqual([r.runId]);
    expect(states(w)).toEqual(['restart-run:aborted']);
  });
  it('an executor that throws records aborted and reports executor-failed', async () => {
    const w = world(); const A = machine(w, 'm_a'); w.executorThrows = true;
    expect(await A.claim({ conversationKey: CK, action: 'redirect', payload: { text: 'x' } })).toMatchObject({ outcome: 'rejected', reason: 'executor-failed' });
    expect(states(w)).toEqual(['redirect:aborted']);
  });
});

describe('ChiefOfStaffActionProtocol — failover races and recovery', () => {
  it('claimed-vs-claimed: the lower-HLC intent executes, the other is superseded, exactly one spawn', async () => {
    const w = world(); const A = machine(w, 'm_a');
    // Two claims land before either executes: write both intents first, then execute each.
    const seam = w.journal.seam('m_a');
    const { buildIntent } = await import('../../src/core/ChiefOfStaffStore.js');
    seam.emit(`${CK}:7:1`, buildIntent({ conversationKey: CK, action: 'restart-run', leaseEpoch: 7, sequence: 1, claimedAt: new Date(T0).toISOString(), machine: 'm_a', holderSignature: 's' }));
    seam.emit(`${CK}:7:2`, buildIntent({ conversationKey: CK, action: 'restart-run', leaseEpoch: 7, sequence: 2, claimedAt: new Date(T0).toISOString(), machine: 'm_a', holderSignature: 's' }));
    const cmd = (sequence: number): CosActionCommand => sealed({ type: 'cos-action', conversationKey: CK, action: 'restart-run', leaseEpoch: 7, sequence, holderMachineId: 'm_a', claimedAt: new Date(T0).toISOString(), payload: {} });
    const second = await A.execute(cmd(2)); // the later claim arrives first
    expect(second).toMatchObject({ outcome: 'superseded', reason: 'lower-hlc-won' });
    const first = await A.execute(cmd(1));
    expect(first.outcome).toBe('started');
    expect(w.started).toHaveLength(1);
    expect(foldIntentState(w.journal.entries).get(`${CK}:7:2`)!.state).toBe('superseded');
    // And the superseded one, presented again, never executes.
    expect((await A.execute(cmd(2))).outcome).toBe('superseded');
    expect(w.started).toHaveLength(1);
  });
  it('executing-vs-claimed: an intent that reached executing blocks every other claim until settled', async () => {
    const w = world(); const A = machine(w, 'm_a'); w.journal.holdDurability = true; // nothing becomes durable ⇒ executing is written but the wait times out
    const r = await A.claim({ conversationKey: CK, action: 'restart-run', payload: {} });
    expect(r).toMatchObject({ outcome: 'rejected', reason: 'durability-failed' });
    // Simulate the crash variant instead: write executing by hand and try a second claim.
    w.journal.holdDurability = false; w.journal.durable = w.journal.seq;
    const { buildIntent, buildOutcome } = await import('../../src/core/ChiefOfStaffStore.js');
    const seam = w.journal.seam('m_a');
    seam.emit(`${CK}:7:9`, buildIntent({ conversationKey: CK, action: 'restart-run', leaseEpoch: 7, sequence: 9, claimedAt: new Date(T0).toISOString(), machine: 'm_a', holderSignature: 's' }));
    seam.emit(`${CK}:7:9:outcome:executing`, buildOutcome({ intentKey: `${CK}:7:9`, transition: 'executing', writer: 'ownership-machine', machine: 'm_a', at: new Date(T0).toISOString() }));
    expect(await A.claim({ conversationKey: CK, action: 'redirect', payload: { text: 'x' } })).toMatchObject({ outcome: 'rejected', reason: 'stand-down' });
    expect(w.started).toHaveLength(0);
  });
  it('crash between executing and started: settle finds no receipt ⇒ rejected (never started); the holder then writes lost; nothing re-executes', async () => {
    const w = world(); const A = machine(w, 'm_a');
    const { buildIntent, buildOutcome } = await import('../../src/core/ChiefOfStaffStore.js');
    const seam = w.journal.seam('m_a');
    seam.emit(`${CK}:7:3`, buildIntent({ conversationKey: CK, action: 'restart-run', leaseEpoch: 7, sequence: 3, claimedAt: new Date(T0).toISOString(), machine: 'm_a', holderSignature: 's' }));
    seam.emit(`${CK}:7:3:outcome:executing`, buildOutcome({ intentKey: `${CK}:7:3`, transition: 'executing', writer: 'ownership-machine', machine: 'm_a', at: new Date(T0).toISOString() }));
    const st = foldIntentState(w.journal.entries).get(`${CK}:7:3`)!;
    expect(st.open).toBe(true);
    expect(await A.settleOpenIntent(st)).toBe('lost');
    expect(foldIntentState(w.journal.entries).get(`${CK}:7:3`)!.state).toBe('lost');
    expect(w.started).toHaveLength(0);
    // A late-arriving command for the same key now returns the recorded (rejected) outcome.
    const cmd: CosActionCommand = sealed({ type: 'cos-action', conversationKey: CK, action: 'restart-run', leaseEpoch: 7, sequence: 3, holderMachineId: 'm_a', claimedAt: new Date(T0).toISOString(), payload: {} });
    expect((await A.execute(cmd)).outcome).toBe('rejected');
    expect(w.started).toHaveLength(0);
  });
  it('crash after the spawn but before started: settle finds the registry receipt ⇒ started with the run id', async () => {
    const w = world(); const A = machine(w, 'm_a');
    const { buildIntent, buildOutcome } = await import('../../src/core/ChiefOfStaffStore.js');
    const seam = w.journal.seam('m_a');
    seam.emit(`${CK}:7:4`, buildIntent({ conversationKey: CK, action: 'restart-run', leaseEpoch: 7, sequence: 4, claimedAt: new Date(T0).toISOString(), machine: 'm_a', holderSignature: 's' }));
    seam.emit(`${CK}:7:4:outcome:executing`, buildOutcome({ intentKey: `${CK}:7:4`, transition: 'executing', writer: 'ownership-machine', machine: 'm_a', at: new Date(T0).toISOString() }));
    w.registry.set(`${CK}:7:4`, { runId: 'run-that-spawned' });
    const st = foldIntentState(w.journal.entries).get(`${CK}:7:4`)!;
    expect(await A.settleOpenIntent(st)).toBe('started');
    expect(foldIntentState(w.journal.entries).get(`${CK}:7:4`)).toMatchObject({ state: 'started', runId: 'run-that-spawned' });
  });
  it('owner unreachable ⇒ settle is blocked, the intent stays open and keeps blocking', async () => {
    const w = world(); w.owner[CK] = 'm_gone'; const A = machine(w, 'm_a');
    const { buildIntent } = await import('../../src/core/ChiefOfStaffStore.js');
    w.journal.seam('m_a').emit(`${CK}:7:5`, buildIntent({ conversationKey: CK, action: 'restart-run', leaseEpoch: 7, sequence: 5, claimedAt: new Date(T0).toISOString(), machine: 'm_a', holderSignature: 's' }));
    const st = foldIntentState(w.journal.entries).get(`${CK}:7:5`)!;
    expect(await A.settleOpenIntent(st)).toBe('blocked');
    expect(foldIntentState(w.journal.entries).get(`${CK}:7:5`)!.open).toBe(true);
    expect(A.standDown(CK)).toBe('cos-intent-open');
  });
  it('transfer barrier: a new owner sees an open intent from the previous owner and rejects until it is settled', async () => {
    const w = world();
    // m_a (old owner) claimed + reached executing; its outcome has not replicated. m_b now owns.
    const { buildIntent, buildOutcome } = await import('../../src/core/ChiefOfStaffStore.js');
    const seamA = w.journal.seam('m_a');
    seamA.emit(`${CK}:7:6`, buildIntent({ conversationKey: CK, action: 'restart-run', leaseEpoch: 7, sequence: 6, claimedAt: new Date(T0).toISOString(), machine: 'm_a', holderSignature: 's' }));
    seamA.emit(`${CK}:7:6:outcome:executing`, buildOutcome({ intentKey: `${CK}:7:6`, transition: 'executing', writer: 'ownership-machine', machine: 'm_a', at: new Date(T0).toISOString() }));
    w.owner[CK] = 'm_b'; w.holder = 'm_b';
    const B = machine(w, 'm_b');
    expect(B.adopt(CK)).toMatchObject({ ok: false, openFromOthers: [`${CK}:7:6`] });
    const r = await B.claim({ conversationKey: CK, action: 'restart-run', payload: {} });
    expect(r).toMatchObject({ outcome: 'rejected', reason: 'stand-down' });
    expect(w.started).toHaveLength(0);
    // Once the old owner's outcome replicates (settled rejected), the barrier clears.
    seamA.emit(`${CK}:7:6:outcome:rejected`, buildOutcome({ intentKey: `${CK}:7:6`, transition: 'rejected', writer: 'ownership-machine', machine: 'm_a', at: new Date(T0 + 1000).toISOString(), reason: 'settled-no-receipt' }));
    expect(B.adopt(CK).ok).toBe(true);
    expect((await B.claim({ conversationKey: CK, action: 'restart-run', payload: {} })).outcome).toBe('started');
    expect(w.started).toHaveLength(1); expect(w.started[0].machine).toBe('m_b');
  });
  it('the dedupe index fails closed when the union cannot be read', async () => {
    const w = world(); const A = machine(w, 'm_a', {}, () => { throw new Error('disk gone'); });
    const cmd: CosActionCommand = sealed({ type: 'cos-action', conversationKey: CK, action: 'redirect', leaseEpoch: 7, sequence: 1, holderMachineId: 'm_a', claimedAt: new Date(T0).toISOString(), payload: {} });
    expect(await A.execute(cmd)).toMatchObject({ outcome: 'rejected', reason: 'dedupe-index-unreadable' });
    expect(w.started).toHaveLength(0);
  });
});

describe('ChiefOfStaffActionProtocol — replay window, signed payload, no writes before authentication', () => {
  const base = (over: Partial<Omit<CosActionCommand, 'holderSignature'>> = {}) => sealed({ type: 'cos-action', conversationKey: CK, action: 'redirect', leaseEpoch: 7, sequence: 77, holderMachineId: 'm_a', claimedAt: new Date(T0).toISOString(), payload: { text: 'continue' }, ...over });
  it('a command from a previous lease epoch is refused', async () => {
    const w = world(); const A = machine(w, 'm_a');
    expect(await A.execute(base({ leaseEpoch: 6 }))).toMatchObject({ outcome: 'rejected', reason: 'not-current-holder' });
    expect(w.started).toHaveLength(0);
  });
  it('a claim older than one run ceiling (or from the future) is refused', async () => {
    const w = world(); const A = machine(w, 'm_a');
    expect(await A.execute(base({ claimedAt: new Date(T0 - 5 * 3_600_000).toISOString() }))).toMatchObject({ outcome: 'rejected', reason: 'invalid-command' });
    expect(await A.execute(base({ claimedAt: new Date(T0 + 2 * 3_600_000).toISOString() }))).toMatchObject({ outcome: 'rejected', reason: 'invalid-command' });
  });
  it('tampering with the payload after signing breaks the signature', async () => {
    const w = world(); const A = machine(w, 'm_a');
    const cmd = base(); const tampered = { ...cmd, payload: { text: 'rm -rf everything' } };
    expect(await A.execute(tampered)).toMatchObject({ outcome: 'rejected', reason: 'holder-signature-invalid' });
    expect(w.started).toHaveLength(0);
  });
  it('unauthenticated refusals write NOTHING to the store (no pre-rejection of a future key)', async () => {
    const w = world(); const A = machine(w, 'm_a');
    await A.execute({ ...base(), holderSignature: 'sig(m_z:nope)' });
    w.holder = 'm_b'; await A.execute(base()); w.holder = 'm_a';
    w.fresh = false; await A.execute(base()); w.fresh = true;
    await A.execute(base({ leaseEpoch: 6 }));
    expect(w.journal.entries).toHaveLength(0);
    // ...whereas an authenticated refusal (operator lease expired) does leave a durable rejected record.
    w.operatorLeaseLive = false; await A.execute(base());
    expect(w.journal.entries.filter((e) => e.data.transition === 'rejected')).toHaveLength(1);
  });
  it('an unreadable union makes hasOpenIntent answer true and standDown answer registry-unreadable (stand down, never act)', () => {
    const w = world(); const A = machine(w, 'm_a', {}, () => { throw new Error('disk gone'); });
    expect(A.hasOpenIntent(CK)).toBe(true);
    expect(A.standDown(CK)).toBe('registry-unreadable');
  });
});

describe('ChiefOfStaffActionProtocol — settle is authenticated like execute', () => {
  it('a settle signed by a non-holder, or for a key nobody claimed, answers unknown and writes nothing', async () => {
    const w = world(); const A = machine(w, 'm_a');
    const { buildIntent } = await import('../../src/core/ChiefOfStaffStore.js');
    w.journal.seam('m_a').emit(`${CK}:7:8`, buildIntent({ conversationKey: CK, action: 'restart-run', leaseEpoch: 7, sequence: 8, claimedAt: new Date(T0).toISOString(), machine: 'm_a', holderSignature: 's' }));
    const before = w.journal.entries.length;
    // Signed by m_z (not the holder) for the real key.
    const { canonicalSettle } = await import('../../src/core/ChiefOfStaffActionProtocol.js');
    expect(await A.settle({ type: 'cos-settle', conversationKey: CK, intentKey: `${CK}:7:8`, holderMachineId: 'm_z', holderSignature: `sig(m_z:${canonicalSettle({ conversationKey: CK, intentKey: `${CK}:7:8` })})` })).toEqual({ settled: 'unknown' });
    // Signed by the holder but for a key nobody claimed.
    expect(await A.settle({ type: 'cos-settle', conversationKey: CK, intentKey: `${CK}:7:999`, holderMachineId: 'm_a', holderSignature: `sig(m_a:${canonicalSettle({ conversationKey: CK, intentKey: `${CK}:7:999` })})` })).toEqual({ settled: 'unknown' });
    // Holder whose renewal went stale.
    w.fresh = false;
    expect(await A.settle({ type: 'cos-settle', conversationKey: CK, intentKey: `${CK}:7:8`, holderMachineId: 'm_a', holderSignature: `sig(m_a:${canonicalSettle({ conversationKey: CK, intentKey: `${CK}:7:8` })})` })).toEqual({ settled: 'unknown' });
    w.fresh = true;
    expect(w.journal.entries.length).toBe(before);
    // The real holder settling the real (receipt-less) claim tombstones it.
    expect(await A.settle({ type: 'cos-settle', conversationKey: CK, intentKey: `${CK}:7:8`, holderMachineId: 'm_a', holderSignature: `sig(m_a:${canonicalSettle({ conversationKey: CK, intentKey: `${CK}:7:8` })})` })).toEqual({ settled: 'rejected' });
    expect(foldIntentState(w.journal.entries).get(`${CK}:7:8`)!.state).toBe('rejected');
  });
});
