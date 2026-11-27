/**
 * FoldCoordinator (context-budget-layered-summaries §9.3, §18 Tier 1): the
 * fold record state machine with CAS transitions refusing a second writer,
 * TTL expiry between steps, renewal during a step, owner-epoch change, the
 * precondition order, restart at every step (boot sweep), quarantine
 * handover, orphan carriers, the per-machine point-of-no-return slot and the
 * consecutive-rollback breaker with the judge-preempted exclusion. Real
 * Ed25519 keys and real files; only the preconditions are stubs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { KeyedLeaseLock, LocalKeyedLeaseStore } from '../../src/core/KeyedLease.js';
import {
  FoldCoordinator, FoldRecordStore, allowedTransition,
  type FoldCarrier, type FoldEvent, type FoldPreconditions, type FoldRecord, type FoldState,
} from '../../src/monitoring/FoldCoordinator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/FoldCoordinator.test.ts';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const leaseCrypto: LeaseCrypto = {
  selfMachineId: 'm_self',
  sign: (c) => crypto.sign(null, Buffer.from(c), privateKey).toString('base64'),
  verify: (c, s, h) => h === 'm_self' && crypto.verify(null, Buffer.from(c), publicKey, Buffer.from(s, 'base64')),
};

describe('FoldCoordinator', () => {
  let stateDir: string;
  let now: number;
  let owner: boolean | 'unknown';
  let sweepOwner: boolean | undefined;
  let epoch: number | null;
  let pre: { sentinel: boolean; rows: boolean; one: boolean | 'peer-unknown'; queue: boolean; layer: boolean; topicRows: boolean };
  let events: FoldEvent[];
  let released: string[];
  let carrierHeld: Array<{ topicKey: string; foldId: string }>;
  let lock: KeyedLeaseLock;
  let store: FoldRecordStore;
  let ids: number;

  const carrier: FoldCarrier = {
    kind: 'test-hold',
    release: (t, f) => { released.push(`${t}/${f}`); carrierHeld = carrierHeld.filter((c) => c.foldId !== f); },
    list: () => carrierHeld,
  };

  const make = () => {
    lock = new KeyedLeaseLock({
      fenced: new FencedLease(leaseCrypto, { leaseTtlMs: 60_000, failoverThresholdMs: 120_000 }),
      store: new LocalKeyedLeaseStore(path.join(stateDir, 'state', 'fold-leases')),
      ttlMs: 60_000, now: () => now,
    });
    store = new FoldRecordStore(stateDir);
    const preconditions: FoldPreconditions = {
      isOwner: () => owner,
      sentinelHeartbeatFresh: () => pre.sentinel,
      hasRowSource: () => pre.rows,
      exactlyOneLiveSession: () => pre.one,
      inboundQueueLive: () => pre.queue,
      layerKindPresent: () => pre.layer,
      topicRowsPresent: () => pre.topicRows,
      ...(sweepOwner !== undefined ? { isSweepOwner: () => sweepOwner as boolean } : {}),
    };
    return new FoldCoordinator({
      store, lock, machineId: 'm_self', preconditions, ownerEpoch: () => epoch,
      carriers: [carrier], now: () => now, onEvent: (e) => events.push(e),
      newFoldId: () => `fold${(ids += 1)}`,
    });
  };

  let fc: FoldCoordinator;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-coord-'));
    now = Date.parse('2026-11-10T08:00:00Z');
    owner = true; epoch = 7; sweepOwner = undefined;
    pre = { sentinel: true, rows: true, one: true, queue: true, layer: true, topicRows: true };
    events = []; released = []; carrierHeld = []; ids = 0;
    fc = make();
  });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));

  const begin = (topic = '141133') => { const r = fc.begin(topic); if (!r.ok) throw new Error(`begin skipped: ${r.reason}`); return r.record; };
  const step = (rec: FoldRecord, to: FoldState, patch = {}) => {
    const r = fc.transition(rec.topicKey, rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, to, patch);
    if (!r.ok) throw new Error(`transition refused: ${r.reason}`);
    return r.record;
  };
  const toReplacing = (rec: FoldRecord) => step(step(step(rec, 'snapshotted'), 'staged'), 'replacing');

  describe('state graph', () => {
    it('allows only the spec edges', () => {
      expect(allowedTransition('locked', 'snapshotted')).toBe(true);
      expect(allowedTransition('staged', 'replacing')).toBe(true);
      expect(allowedTransition('probing', 'committed')).toBe(true);
      expect(allowedTransition('locked', 'committed')).toBe(false); // no skipping to commit
      expect(allowedTransition('replacing', 'aborted')).toBe(false); // past PNR: roll back, never abort
      expect(allowedTransition('committed', 'rolled-back')).toBe(false); // terminal is terminal
      expect(allowedTransition('quarantined', 'committed')).toBe(false);
    });
  });

  describe('begin (step 1 preconditions, in order)', () => {
    it('opens a locked record fenced by the lock generation and the ownership epoch, files 0600', () => {
      const rec = begin();
      expect(rec).toMatchObject({ state: 'locked', seq: 1, ownerEpoch: 7, generation: 1, role: 'coordinator', machineId: 'm_self' });
      const file = path.join(store.dirFor('141133'), `${rec.foldId}.json`);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    });

    it('records the first failing precondition as the skip reason', () => {
      const cases: Array<[() => void, string]> = [
        [() => { owner = 'unknown'; }, 'owner-unknown'],
        [() => { owner = false; }, 'not-owner'],
        [() => { pre.rows = false; }, 'no-row-source'],
        [() => { pre.sentinel = false; }, 'no-sentinel'],
        [() => { pre.one = 'peer-unknown'; }, 'peer-unknown'],
        [() => { pre.one = false; }, 'not-exclusive'],
        [() => { pre.queue = false; }, 'no-hold-queue'],
        [() => { pre.layer = false; }, 'layers-not-replicated'],
        [() => { pre.topicRows = false; }, 'rows-missing'],
      ];
      for (const [set, reason] of cases) {
        owner = true; pre = { sentinel: true, rows: true, one: true, queue: true, layer: true, topicRows: true };
        set();
        expect(fc.begin('141133')).toEqual({ ok: false, reason });
      }
      expect(store.list('141133')).toHaveLength(0);
    });

    it('refuses a second fold on the same topic while one is non-terminal, but allows another topic', () => {
      begin('141133');
      expect(fc.begin('141133')).toEqual({ ok: false, reason: 'fold-in-progress' });
      expect(fc.begin('130715').ok).toBe(true);
    });

    it('the prepare variant opens at prepared and skips the exclusive-session and layer-kind checks', () => {
      pre.one = false; pre.layer = false;
      const r = fc.begin('141133', 'prepare');
      expect(r.ok && r.record.state).toBe('prepared');
    });
  });

  describe('transitions (CAS, fencing)', () => {
    it('walks the happy path to committed and releases the lock and every carrier', () => {
      const rec = begin();
      carrierHeld.push({ topicKey: '141133', foldId: rec.foldId });
      const done = step(step(toReplacing(rec), 'probing'), 'committed');
      expect(done.state).toBe('committed');
      expect(released).toEqual([`141133/${rec.foldId}`]);
      expect(lock.read('141133').lease).toMatchObject({ released: true });
      expect(fc.begin('141133').ok).toBe(true); // the topic is free again
    });

    it('refuses a second writer holding a stale view (seq mismatch)', () => {
      const rec = begin();
      step(rec, 'snapshotted');
      expect(fc.transition('141133', rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, 'snapshotted'))
        .toEqual({ ok: false, reason: 'cas-mismatch' });
    });

    it('refuses an edge outside the graph', () => {
      const rec = begin();
      expect(fc.transition('141133', rec.foldId, { state: 'locked', seq: 1, generation: 1 }, 'committed'))
        .toEqual({ ok: false, reason: 'edge-not-allowed:locked->committed' });
    });

    it('refuses once the lock expired between steps (TTL), and after another hand took the topic', () => {
      const rec = begin();
      now += 61_000;
      expect(fc.transition('141133', rec.foldId, { state: 'locked', seq: 1, generation: 1 }, 'snapshotted'))
        .toEqual({ ok: false, reason: 'lock-lost' });
      // A rollback (terminal) is still allowed on an expired-but-unsuperseded lock, so the fold can clean up.
      expect(fc.transition('141133', rec.foldId, { state: 'locked', seq: 1, generation: 1 }, 'rolled-back').ok).toBe(true);
    });

    it('never COMMITS on an expired lock, even with the generation unchanged (a hung runner waking up)', () => {
      const rec = step(toReplacing(begin()), 'probing');
      now += 61_000;
      expect(fc.transition('141133', rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, 'committed'))
        .toEqual({ ok: false, reason: 'lock-lost' });
      // the clean-up edge is still open
      expect(fc.transition('141133', rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, 'rolled-back').ok).toBe(true);
    });

    it('a renewal during a step keeps the fold fenced past the original TTL', () => {
      const rec = begin();
      now += 50_000;
      const held = lock.adopt('141133', rec.generation, 'coordinator');
      expect(held && lock.renew(held)).toBeTruthy();
      now += 50_000; // 100 s after begin, 50 s after the renewal
      expect(fc.transition('141133', rec.foldId, { state: 'locked', seq: 1, generation: 1 }, 'snapshotted').ok).toBe(true);
    });

    it('refuses when the ownership epoch changed or this machine is no longer the owner', () => {
      const rec = begin();
      epoch = 8;
      expect(fc.transition('141133', rec.foldId, { state: 'locked', seq: 1, generation: 1 }, 'snapshotted'))
        .toEqual({ ok: false, reason: 'owner-epoch-changed' });
      epoch = 7; owner = false;
      expect(fc.transition('141133', rec.foldId, { state: 'locked', seq: 1, generation: 1 }, 'snapshotted'))
        .toEqual({ ok: false, reason: 'not-owner' });
    });

    it('allows at most one fold per machine past the point of no return (machine-busy, never queued)', () => {
      toReplacing(begin('141133'));
      const other = step(step(begin('130715'), 'snapshotted'), 'staged');
      expect(fc.transition('130715', other.foldId, { state: 'staged', seq: other.seq, generation: other.generation }, 'replacing'))
        .toEqual({ ok: false, reason: 'machine-busy' });
    });

    it('lists (staged writes) live in the sidecar, never the record, and are dropped at terminal', () => {
      const rec = begin();
      fc.addStaged('141133', rec.foldId, ['layer/H1#12', 'layer/C#3']);
      expect(store.getSidecar('141133', rec.foldId).staged).toEqual(['layer/H1#12', 'layer/C#3']);
      expect(JSON.stringify(store.get('141133', rec.foldId))).not.toContain('layer/H1');
      step(rec, 'aborted');
      expect(fs.existsSync(path.join(store.dirFor('141133'), `${rec.foldId}.sidecar.json`))).toBe(false);
    });
  });

  describe('quarantine (§9.3)', () => {
    it('hands the lock to the sentinel with a new generation; containment carriers stay until rollback', () => {
      const rec = toReplacing(begin());
      carrierHeld.push({ topicKey: '141133', foldId: rec.foldId });
      now += 61_000; // the coordinator hung past its lock
      const q = fc.quarantine('141133', rec.foldId, 'step bound passed');
      if (!q.ok) throw new Error(q.reason);
      expect(q.record).toMatchObject({ state: 'quarantined', role: 'sentinel', generation: 2 });
      expect(released).toEqual([]); // non-terminal: containment stays
      // The old coordinator hand is fenced out.
      expect(fc.transition('141133', rec.foldId, { state: 'replacing', seq: rec.seq, generation: 1 }, 'probing').ok).toBe(false);
      // The sentinel rolls back (step 8) under its generation.
      const rb = fc.transition('141133', rec.foldId, { state: 'quarantined', seq: q.record.seq, generation: 2 }, 'rolled-back');
      expect(rb.ok).toBe(true);
      expect(released).toEqual([`141133/${rec.foldId}`]);
    });

    it('refuses to quarantine a fold that is not past the point of no return', () => {
      const rec = begin();
      expect(fc.quarantine('141133', rec.foldId, 'x')).toEqual({ ok: false, reason: 'not-past-pnr:locked' });
    });
  });

  describe('boot sweep (restart at every step)', () => {
    for (const at of ['locked', 'snapshotted', 'staged'] as const) {
      it(`a crash at ${at} is discarded synchronously: aborted, carriers and lock released`, () => {
        let rec = begin();
        carrierHeld.push({ topicKey: '141133', foldId: rec.foldId });
        if (at !== 'locked') rec = step(rec, 'snapshotted');
        if (at === 'staged') rec = step(rec, 'staged');
        const fresh = make(); // a new process
        const r = fresh.recoverPendingFolds();
        expect(r.aborted.map((x) => x.foldId)).toEqual([rec.foldId]);
        expect(store.get('141133', rec.foldId)?.state).toBe('aborted');
        expect(released).toContain(`141133/${rec.foldId}`);
        expect(fresh.begin('141133').ok).toBe(true);
      });
    }

    it('a crash at prepared is discarded as well', () => {
      const r0 = fc.begin('141133', 'prepare');
      if (!r0.ok) throw new Error('prepare failed');
      expect(make().recoverPendingFolds().aborted).toHaveLength(1);
    });

    for (const at of ['replacing', 'probing'] as const) {
      it(`a crash at ${at} is quarantined and handed to the sentinel, containment kept`, () => {
        let rec = toReplacing(begin());
        carrierHeld.push({ topicKey: '141133', foldId: rec.foldId });
        if (at === 'probing') rec = step(rec, 'probing');
        const r = make().recoverPendingFolds();
        expect(r.quarantined.map((x) => [x.foldId, x.state, x.role])).toEqual([[rec.foldId, 'quarantined', 'sentinel']]);
        expect(released).toEqual([]);
      });
    }

    it('a record already quarantined stays quarantined and is handed over again', () => {
      const rec = toReplacing(begin());
      fc.quarantine('141133', rec.foldId, 'x');
      const r = make().recoverPendingFolds();
      expect(r.quarantined).toHaveLength(1);
      expect(r.aborted).toHaveLength(0);
    });

    it("resolves its own crashed fold when the topic's session died with the crash (sweep owner on a dark pool)", () => {
      const rec = begin();
      owner = false; sweepOwner = true; // no live session now, but this machine is the host by default
      const r = make().recoverPendingFolds();
      expect(r.aborted.map((x) => x.foldId)).toEqual([rec.foldId]);
      expect(r.observedOnly).toEqual([]);
    });

    it('after the session died, its quarantined fold can still be rolled back by this host (sweep owner)', () => {
      const rec = toReplacing(begin());
      owner = false; sweepOwner = true;
      const fresh = make();
      const q = fresh.recoverPendingFolds().quarantined[0];
      expect(q.state).toBe('quarantined');
      const r = fresh.transition(q.topicKey, q.foldId, { state: q.state, seq: q.seq, generation: q.generation }, 'rolled-back');
      expect(r.ok).toBe(true);
      expect(store.get('141133', rec.foldId)?.state).toBe('rolled-back');
    });

    it("a record written by another machine is never moved under sweep ownership", () => {
      const rec = begin();
      const other = { ...store.get('141133', rec.foldId)!, machineId: 'm_other' };
      store.put(other);
      owner = false; sweepOwner = true;
      const r = make().transition(other.topicKey, other.foldId, { state: other.state, seq: other.seq, generation: other.generation }, 'aborted');
      expect(r).toEqual({ ok: false, reason: 'not-owner' });
    });

    it('a crash between the terminal write and the end of settle is finished at boot (lock freed)', () => {
      const rec = begin();
      carrierHeld.push({ topicKey: '141133', foldId: rec.foldId });
      store.put({ ...rec, state: 'aborted', seq: rec.seq + 1 }); // written, then the process died before settle
      expect(make().begin('141133')).toEqual({ ok: false, reason: 'lock-held' });
      const r = make().recoverPendingFolds();
      expect(r.resettled).toEqual([rec.foldId]);
      expect(r.orphans).toEqual([]); // released as the fold's own carriers, not as orphans
      expect(store.hasSidecar('141133', rec.foldId)).toBe(false);
      expect(make().begin('141133').ok).toBe(true);
      expect(make().recoverPendingFolds().resettled).toEqual([]); // idempotent
    });

    it('a live pool (sweep owner false) only observes', () => {
      const rec = begin();
      owner = 'unknown'; sweepOwner = false;
      const r = make().recoverPendingFolds();
      expect(r.observedOnly).toEqual([rec.foldId]);
      expect(store.get('141133', rec.foldId)?.state).toBe('locked');
    });

    it('releases an orphan carrier whose fold record is gone, loudly', () => {
      carrierHeld.push({ topicKey: '141133', foldId: 'ghost' });
      const r = make().recoverPendingFolds();
      expect(r.orphans).toEqual([{ kind: 'test-hold', topicKey: '141133', foldId: 'ghost' }]);
      expect(released).toEqual(['141133/ghost']);
      expect(events.some((e) => e.type === 'orphan-carrier')).toBe(true);
    });

    it('a carrier of a live fold is not an orphan', () => {
      const rec = begin();
      carrierHeld.push({ topicKey: '141133', foldId: rec.foldId });
      // Sweep from a non-owner's point of view observes only.
      owner = false;
      const r = make().recoverPendingFolds();
      expect(r.observedOnly).toEqual([rec.foldId]);
      expect(r.orphans).toEqual([]);
      expect(released).toEqual([]);
    });
  });

  describe('rollback breaker', () => {
    const rollback = (topic = '141133', judgePreempted = false) => {
      const rec = begin(topic);
      return step(rec, 'rolled-back', { judgePreempted });
    };

    it('drops the topic to shadow mode after 3 consecutive rollbacks, until re-armed', () => {
      rollback(); rollback();
      expect(fc.breaker('141133').shadowMode).toBe(false);
      rollback();
      expect(fc.breaker('141133')).toMatchObject({ consecutiveRollbacks: 3, shadowMode: true });
      expect(events.some((e) => e.type === 'breaker-tripped')).toBe(true);
      expect(fc.begin('141133')).toEqual({ ok: false, reason: 'shadow-mode' });
      fc.rearm('141133');
      expect(fc.begin('141133').ok).toBe(true);
    });

    it('a judge-preempted rollback does not count, and a commit resets the count', () => {
      rollback(); rollback();
      rollback('141133', true);
      expect(fc.breaker('141133').consecutiveRollbacks).toBe(2);
      const rec = begin();
      step(step(toReplacing(rec), 'probing'), 'committed');
      expect(fc.breaker('141133').consecutiveRollbacks).toBe(0);
    });
  });
});
