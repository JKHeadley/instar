/**
 * Tier-1 tests for LeaseCoordinator — drives FencedLease over a (fake) durable
 * store + (fake) tunnel. Covers acquisition, CAS contention, presumed-dead
 * takeover, the tunnel-renewal self-suspend, the max(tunnel,git) fencing view,
 * and unresolvable-split escalation. Real Ed25519 keys.
 */

import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseStore, type LeaseTransport } from '../../src/core/LeaseCoordinator.js';
import { GitLeaseStore } from '../../src/core/GitLeaseStore.js';
import type { LeaseRecord } from '../../src/core/types.js';

function genKey() {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}
const KEYS: Record<string, { publicKey: string; privateKey: string }> = { A: genKey(), B: genKey() };
function crypt(self: string): LeaseCrypto {
  return {
    selfMachineId: self,
    sign: (c) => crypto.sign(null, Buffer.from(c), KEYS[self].privateKey).toString('base64'),
    verify: (c, sig, holder) => {
      const pub = KEYS[holder]?.publicKey;
      if (!pub) return false;
      try { return crypto.verify(null, Buffer.from(c), pub, Buffer.from(sig, 'base64')); } catch { return false; }
    },
  };
}

const TTL = 60_000;
const FAILOVER = 15 * 60_000;

/** In-memory durable store with optional pre-write contention injection. */
class FakeStore implements LeaseStore {
  lease: LeaseRecord | null = null;
  epoch = 0;
  /** If set, runs before each casWrite to simulate a peer advancing. */
  beforeWrite?: () => void;
  /** Controls whether a same-epoch refresh push succeeds (git reachability). */
  refreshOk = true;
  read() { return { lease: this.lease, epoch: this.epoch }; }
  refresh(lease: LeaseRecord) {
    if (!this.refreshOk) return false;
    if ((this.lease?.epoch ?? 0) > lease.epoch) return false;
    this.lease = lease;
    return true;
  }
  casWrite(candidate: LeaseRecord) {
    this.beforeWrite?.();
    // Fast-forward accepted only if candidate strictly advances by exactly +1
    // over the CURRENT committed epoch (anything else = lost the race).
    if (candidate.epoch === this.epoch + 1) {
      this.lease = candidate;
      this.epoch = candidate.epoch;
      return { ok: true, observed: { lease: this.lease, epoch: this.epoch } };
    }
    return { ok: false, observed: { lease: this.lease, epoch: this.epoch } };
  }
}

function makeFlA() { return new FencedLease(crypt('A'), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER }); }
function makeFlB() { return new FencedLease(crypt('B'), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER }); }

describe('LeaseCoordinator', () => {
  it('reports once at five consecutive own-candidate write read-backs and resets on success', async () => {
    let fail = true;
    const store: LeaseStore = {
      read: () => ({ lease: null, epoch: 0 }),
      refresh: () => true,
      casWrite: (candidate) => fail
        ? { ok: false, observed: { lease: candidate, epoch: candidate.epoch } }
        : { ok: true, observed: { lease: candidate, epoch: candidate.epoch } },
    };
    const report = vi.fn();
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 1_000,
      reportDegradation: report,
    });
    for (let i = 0; i < 7; i++) await lc.advanceEpochForContestedWin();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0].reason).toContain('remain unconfirmed');
    fail = false;
    await lc.advanceEpochForContestedWin();
    fail = true;
    for (let i = 0; i < 5; i++) await lc.advanceEpochForContestedWin();
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('clears the unconfirmed-write streak while its live switch is off', async () => {
    let enabled = true;
    const store: LeaseStore = {
      read: () => ({ lease: null, epoch: 0 }), refresh: () => true,
      casWrite: (candidate) => ({ ok: false, observed: { lease: candidate, epoch: candidate.epoch } }),
    };
    const report = vi.fn();
    const lc = new LeaseCoordinator({ lease: makeFlA(), store, presumedDeadHolders: () => new Set(),
      now: () => 1_000, getUnconfirmedWriteAlertEnabled: () => enabled, reportDegradation: report });
    for (let i = 0; i < 4; i++) await lc.advanceEpochForContestedWin();
    enabled = false;
    await lc.advanceEpochForContestedWin();
    enabled = true;
    for (let i = 0; i < 4; i++) await lc.advanceEpochForContestedWin();
    expect(report).not.toHaveBeenCalled();
    await lc.advanceEpochForContestedWin();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('clears the streak on an off/on lease cycle with no CAS write', async () => {
    let enabled = true;
    const store: LeaseStore = { read: () => ({ lease: null, epoch: 0 }), refresh: () => true,
      casWrite: (candidate) => ({ ok: false, observed: { lease: candidate, epoch: candidate.epoch } }) };
    const report = vi.fn();
    const lc = new LeaseCoordinator({ lease: makeFlA(), store, presumedDeadHolders: () => new Set(),
      getUnconfirmedWriteAlertEnabled: () => enabled, reportDegradation: report, now: () => 1_000 });
    for (let i = 0; i < 4; i++) await lc.advanceEpochForContestedWin();
    enabled = false;
    lc.sampleLiveness(); // ordinary cycle, no acquisition write
    enabled = true;
    lc.sampleLiveness();
    await lc.advanceEpochForContestedWin();
    expect(report).not.toHaveBeenCalled();
  });

  it('isolates throwing sampling and reporting from lease work', async () => {
    const store = new FakeStore();
    const tunnel: LeaseTransport = { broadcast: async () => true,
      observed: () => ({ lease: null, lastNonceByHolder: {} }), isReachable: () => true };
    const lc = new LeaseCoordinator({ lease: makeFlA(), store, tunnel, presumedDeadHolders: () => new Set(),
      sampleLiveness: () => { throw new Error('bad registry'); }, reportDegradation: () => { throw new Error('bad reporter'); },
      now: () => 1_000 });
    lc.sampleLiveness();
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(await lc.renew()).toBe(true);

    const failingStore: LeaseStore = { read: () => ({ lease: null, epoch: 0 }), refresh: () => true,
      casWrite: (candidate) => ({ ok: false, observed: { lease: candidate, epoch: candidate.epoch } }) };
    const reporting = new LeaseCoordinator({ lease: makeFlA(), store: failingStore, presumedDeadHolders: () => new Set(),
      reportDegradation: () => { throw new Error('bad reporter'); }, now: () => 1_000 });
    for (let i = 0; i < 5; i++) await expect(reporting.advanceEpochForContestedWin()).resolves.toEqual(expect.any(Boolean));
  });

  it('counts an own-candidate failure through acquireOnConsent', async () => {
    const store = new FakeStore();
    store.lease = makeFlB().buildAcquisition(undefined, 500, 1);
    store.epoch = 1;
    store.casWrite = (candidate) => ({ ok: false, observed: { lease: candidate, epoch: candidate.epoch } });
    const lc = new LeaseCoordinator({ lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 1_000 });
    await lc.acquireOnConsent('B');
    expect((lc as unknown as { unconfirmedWriteCount: number }).unconfirmedWriteCount).toBe(1);
  });

  it('resets own-candidate, competing-winner, own-candidate to a streak of one', async () => {
    let call = 0;
    const store: LeaseStore = { read: () => ({ lease: null, epoch: 0 }), refresh: () => true,
      casWrite: (candidate) => {
        call++;
        if (call === 2) return { ok: false, observed: { lease: makeFlB().buildAcquisition(undefined, 1_000, 1), epoch: 1 } };
        return { ok: false, observed: { lease: candidate, epoch: candidate.epoch } };
      } };
    const lc = new LeaseCoordinator({ lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 1_000 });
    await lc.advanceEpochForContestedWin();
    await lc.advanceEpochForContestedWin();
    await lc.advanceEpochForContestedWin();
    expect((lc as unknown as { unconfirmedWriteCount: number }).unconfirmedWriteCount).toBe(1);
  });

  it('does not count broadcast-only renewal failures', async () => {
    const store = new FakeStore();
    let broadcastOk = true;
    const tunnel: LeaseTransport = { broadcast: async () => broadcastOk,
      observed: () => ({ lease: null, lastNonceByHolder: {} }), isReachable: () => broadcastOk };
    const lc = new LeaseCoordinator({ lease: makeFlA(), store, tunnel, presumedDeadHolders: () => new Set(), now: () => 1_000 });
    await lc.acquireIfEligible();
    broadcastOk = false;
    await lc.renew();
    expect((lc as unknown as { unconfirmedWriteCount: number }).unconfirmedWriteCount).toBe(0);
  });

  it('acquires from empty and reports holding', async () => {
    const store = new FakeStore();
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 1_000,
    });
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(lc.holdsLease()).toBe(true);
    expect(lc.currentEpoch()).toBe(1);
    expect(lc.currentHolder()).toBe('A');
  });

  it('cannot acquire a live peer-held lease, can take a presumed-dead one', async () => {
    const store = new FakeStore();
    // B holds epoch 1.
    store.lease = makeFlB().buildAcquisition(undefined, 500, 1);
    store.epoch = 1;
    let dead = new Set<string>();
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, presumedDeadHolders: () => dead, now: () => 2_000,
    });
    expect(await lc.acquireIfEligible()).toBe(false); // B live
    dead = new Set(['B']);
    expect(await lc.acquireIfEligible()).toBe(true); // B presumed dead → A takes over
    expect(lc.currentEpoch()).toBe(2);
    expect(lc.currentHolder()).toBe('A');
  });

  it('folds a verified renewal waiting in the tunnel before reading live liveness', async () => {
    const store = new FakeStore();
    const peerLease = makeFlB().buildAcquisition(undefined, 500, 1);
    const renewed = makeFlB().signLease(peerLease.epoch, peerLease.acquiredAt, peerLease.expiresAt, 2);
    store.lease = peerLease;
    store.epoch = 1;
    const tunnel: LeaseTransport = { broadcast: async () => true,
      observed: () => ({ lease: renewed, lastNonceByHolder: { B: 2 } }), isReachable: () => true };
    let lc!: LeaseCoordinator;
    const presumedDeadHolders = vi.fn(() => lc.freshRenewalWithin('B', FAILOVER) ? new Set<string>() : new Set(['B']));
    lc = new LeaseCoordinator({ lease: makeFlA(), store, tunnel, presumedDeadHolders,
      getLivenessEnabled: () => true, now: () => 2_000, monotonicNow: () => 2_000 });
    expect(await lc.acquireIfEligible()).toBe(false);
    expect(presumedDeadHolders).toHaveBeenCalled();
    expect(store.epoch).toBe(1);
  });

  it('liveness:false keeps the pre-pull verdict across a real GitLeaseStore lost-write retry', async () => {
    let registry: any = { machines: { A: { lastSeen: new Date(0).toISOString() }, B: { lastSeen: new Date(0).toISOString() } } };
    let pulls = 0;
    const peer = makeFlB().buildAcquisition(undefined, 500, 1);
    const git = new GitLeaseStore({ machineId: 'A', registryAbsPath: '/tmp/registry.json',
      loadRegistry: () => registry, saveRegistry: (r) => { registry = r; },
      pullRebase: () => { pulls++; if (pulls === 2) registry = { ...registry, lease: peer,
        machines: { ...registry.machines, B: { ...registry.machines.B, lastSeen: new Date(2_000).toISOString() } } }; return true; },
      commitAndPush: () => pulls >= 3 });
    const deadReads: boolean[] = [];
    const lc = new LeaseCoordinator({ lease: makeFlA(), store: git, getLivenessEnabled: () => false, now: () => 2_000,
      presumedDeadHolders: () => { const dead = Date.parse(registry.machines.B.lastSeen) < 1_000; deadReads.push(dead); return dead ? new Set(['B']) : new Set(); } });
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(deadReads).toEqual([true]);
    expect(registry.lease.holder).toBe('A');
    expect(registry.lease.epoch).toBe(2);
  });

  it('reads the liveness switch once per call and applies a flip on the next call', async () => {
    const store = new FakeStore();
    store.lease = makeFlB().buildAcquisition(undefined, 500, 1);
    store.epoch = 1;
    let enabled = false;
    const seen: Array<boolean | undefined> = [];
    const lc = new LeaseCoordinator({ lease: makeFlA(), store, getLivenessEnabled: () => enabled, now: () => 2_000,
      presumedDeadHolders: (opts) => { seen.push(opts?.liveness); return opts?.liveness ? new Set(['B']) : new Set(); } });
    expect(await lc.acquireIfEligible()).toBe(false);
    enabled = true;
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(seen).toEqual([false, true]);
  });

  it('characterises a forged-once-then-stale receipt authorising takeover of an unexpired store lease', async () => {
    const store = new FakeStore();
    store.lease = makeFlB().buildAcquisition(undefined, 500, 1);
    store.epoch = 1;
    const lc = new LeaseCoordinator({ lease: makeFlA(), store, presumedDeadHolders: () => new Set(['B']),
      getLivenessEnabled: () => true, now: () => 2_000 });
    expect(store.lease.expiresAt > new Date(2_000).toISOString()).toBe(true);
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(lc.currentEpoch()).toBe(2);
  });

  it('characterises a restarted holder below its prior nonce watermark as not fresh and takeable after stale receipt', async () => {
    const store = new FakeStore();
    let mono = 0;
    let observed = makeFlB().buildAcquisition(undefined, 500, 10);
    const tunnel: LeaseTransport = { broadcast: async () => true,
      observed: () => ({ lease: observed, lastNonceByHolder: { B: 10 } }), isReachable: () => true };
    store.lease = observed;
    store.epoch = 1;
    const lc = new LeaseCoordinator({ lease: makeFlA(), store, tunnel, presumedDeadHolders: () => new Set(['B']),
      getLivenessEnabled: () => true, now: () => 2_000, monotonicNow: () => mono });
    lc.currentLease(); // establish nonce-10 freshness watermark
    mono = FAILOVER + 1;
    observed = makeFlB().buildAcquisition(store.lease, 1_000, 1); // restarted process, higher epoch but lower nonce
    store.lease = observed;
    store.epoch = observed.epoch;
    expect(lc.freshRenewalWithin('B', FAILOVER)).toBe(false);
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(lc.currentHolder()).toBe('A');
  });

  it('CAS contention: yields when a live peer advances the epoch mid-flight', async () => {
    const store = new FakeStore();
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 1_000,
    });
    // Just before A's write lands, B sneaks in epoch 1 (live, not dead).
    store.beforeWrite = () => {
      if (store.epoch === 0) {
        store.lease = makeFlB().buildAcquisition(undefined, 900, 1);
        store.epoch = 1;
      }
    };
    const got = await lc.acquireIfEligible();
    expect(got).toBe(false); // A's epoch-1 candidate is rejected; B (live) holds it
    expect(store.lease?.holder).toBe('B');
  });

  it('self-suspends when the tunnel is unreachable past leaseTtlMs', async () => {
    const store = new FakeStore();
    let reachable = true;
    let now = 1_000;
    const onSelfSuspend = vi.fn();
    const tunnel: LeaseTransport = {
      broadcast: async () => reachable,
      observed: () => ({ lease: null, lastNonceByHolder: {} }),
      isReachable: () => reachable,
    };
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, tunnel, presumedDeadHolders: () => new Set(),
      now: () => now, monotonicNow: () => now, onSelfSuspend,
    });
    expect(await lc.acquireIfEligible()).toBe(true);
    // Tunnel goes dark; advance time past TTL and renew. The self-fence is judged
    // on the monotonic clock (here tied to `now`), per spec §L−1.
    reachable = false;
    now = 1_000 + TTL + 1;
    expect(await lc.renew()).toBe(false);
    expect(onSelfSuspend).toHaveBeenCalledTimes(1);
    expect(lc.holdsLease()).toBe(false); // suspended → no authority
  });

  it('git-only: self-suspends when the durable refresh cannot push past leaseTtlMs', async () => {
    const store = new FakeStore();
    let now = 1_000;
    const onSelfSuspend = vi.fn();
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, presumedDeadHolders: () => new Set(),
      now: () => now, monotonicNow: () => now, onSelfSuspend,
    });
    expect(await lc.acquireIfEligible()).toBe(true);
    // Git push (refresh) starts failing — partitioned holder.
    store.refreshOk = false;
    now = 1_000 + TTL + 1;
    expect(await lc.renew()).toBe(false);
    expect(onSelfSuspend).toHaveBeenCalledTimes(1);
    expect(lc.holdsLease()).toBe(false);
  });

  it('a reachable tunnel keeps the lease alive across renewals', async () => {
    const store = new FakeStore();
    let now = 1_000;
    const tunnel: LeaseTransport = {
      broadcast: async () => true,
      observed: () => ({ lease: null, lastNonceByHolder: {} }),
      isReachable: () => true,
    };
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, tunnel, presumedDeadHolders: () => new Set(), now: () => now,
    });
    await lc.acquireIfEligible();
    now += TTL * 2;
    expect(await lc.renew()).toBe(true);
    expect(lc.holdsLease()).toBe(true);
  });

  it('escalates an unresolvable split (dead holder + tunnel down)', async () => {
    const store = new FakeStore();
    store.lease = makeFlB().buildAcquisition(undefined, 500, 1);
    store.epoch = 1;
    const onEscalate = vi.fn();
    const tunnel: LeaseTransport = {
      broadcast: async () => false,
      observed: () => ({ lease: null, lastNonceByHolder: {} }),
      isReachable: () => false,
    };
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, tunnel, presumedDeadHolders: () => new Set(['B']),
      now: () => 2_000, onEscalate,
    });
    lc.checkForUnresolvableSplit('episode-1');
    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(onEscalate.mock.calls[0][0].holder).toBe('B');
  });

  it('fires onEpochAdvance when the epoch moves', async () => {
    const store = new FakeStore();
    const onEpochAdvance = vi.fn();
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 1_000, onEpochAdvance,
    });
    await lc.acquireIfEligible();
    expect(onEpochAdvance).toHaveBeenCalledWith(1);
  });

  // ── Monotonic self-fence (Session Pool §L−1 — the router-lease robustness fold-in) ──
  describe('monotonic self-fence (spec §L−1)', () => {
    it('self-suspends on a backward WALL-clock jump (NTP step) once the MONOTONIC TTL elapses', async () => {
      // The exact bug class the spec §L−1 + SleepWakeDetector lesson guard against:
      // the wall clock jumps BACKWARD (e.g. NTP corrects a fast clock), so a
      // wall-clock self-suspend (`now - lastRenewOkAt > ttl`) would compute a
      // NEGATIVE elapsed and NEVER fire — a partitioned holder keeps acting.
      // The monotonic clock cannot jump backward, so the self-fence still fires.
      const store = new FakeStore();
      let wall = 100_000; // wall clock
      let mono = 100_000; // monotonic clock (separate, controllable)
      const onSelfSuspend = vi.fn();
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(),
        now: () => wall, monotonicNow: () => mono, onSelfSuspend,
      });
      expect(await lc.acquireIfEligible()).toBe(true);
      // Partition: git refresh now fails.
      store.refreshOk = false;
      // Real time elapses past the TTL (monotonic advances)...
      mono = 100_000 + TTL + 1;
      // ...but the WALL clock jumps BACKWARD (NTP correction). A wall-clock
      // self-suspend would see elapsed = (50_000 - 100_000) = -50_000 < TTL and
      // WRONGLY keep the lease. The monotonic fence ignores the wall jump.
      wall = 50_000;
      expect(await lc.renew()).toBe(false);
      expect(onSelfSuspend).toHaveBeenCalledTimes(1);
      expect(lc.holdsLease()).toBe(false);
    });

    it('holdsLease() fences a holder past the monotonic TTL even before renew() runs', async () => {
      // The hot-path authority check must not grant authority to a holder that
      // has not confirmed a renewal within the monotonic TTL — independent of
      // the wall-clock expiry (which here is frozen, so isExpired would pass).
      const store = new FakeStore();
      const wall = 100_000; // frozen wall clock → wall-clock expiry never passes
      let mono = 100_000;
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(),
        now: () => wall, monotonicNow: () => mono,
      });
      expect(await lc.acquireIfEligible()).toBe(true);
      expect(lc.holdsLease()).toBe(true); // just acquired → monotonic elapsed ~0
      // No renew happens; monotonic time passes the TTL.
      mono = 100_000 + TTL + 1;
      expect(lc.holdsLease()).toBe(false); // monotonic self-fence, despite frozen wall clock
    });

    it('uses the REAL monotonic clock by default (no injection) — production wiring integrity', async () => {
      // Proves the default `process.hrtime` path (not just the injected fake) is
      // wired: a freshly-acquired holder holds, because real monotonic elapsed is
      // ~0 ≪ TTL. This is what the server constructs (no monotonicNow injection).
      const store = new FakeStore();
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => Date.now(),
        // no monotonicNow → exercises the default process.hrtime monotonic clock
      });
      expect(await lc.acquireIfEligible()).toBe(true);
      expect(lc.holdsLease()).toBe(true);
    });

    it('a confirmed renewal resets the monotonic self-fence clock', async () => {
      const store = new FakeStore();
      const wall = 100_000;
      let mono = 100_000;
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(),
        now: () => wall, monotonicNow: () => mono,
      });
      expect(await lc.acquireIfEligible()).toBe(true);
      // Advance most of the TTL, then renew successfully (git refresh ok).
      mono = 100_000 + TTL - 10;
      expect(await lc.renew()).toBe(true);
      // The renewal reset the monotonic mark; advancing another (TTL - 10) keeps it live.
      mono = 100_000 + (TTL - 10) + (TTL - 10);
      expect(lc.holdsLease()).toBe(true);
    });
  });

  describe('acquireOnConsent (planned-handoff yield, §8 G3e)', () => {
    it('takes a LIVE peer-held lease when that peer yielded (the consent bypass)', async () => {
      const store = new FakeStore();
      store.lease = makeFlB().buildAcquisition(undefined, 500, 1); // B holds, LIVE
      store.epoch = 1;
      // No presumed-dead, B is live → ordinary acquire would refuse.
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 2_000,
      });
      expect(await lc.acquireIfEligible()).toBe(false); // B live → normal path refuses
      // But B explicitly yielded → consent path takes it, advancing the epoch.
      expect(await lc.acquireOnConsent('B')).toBe(true);
      expect(lc.holdsLease()).toBe(true);
      expect(lc.currentHolder()).toBe('A');
      expect(lc.currentEpoch()).toBe(2);
    });

    it('SECURITY: refuses a yield from a machine that is NOT the current holder', async () => {
      const store = new FakeStore();
      store.lease = makeFlB().buildAcquisition(undefined, 500, 1); // B holds
      store.epoch = 1;
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 2_000,
      });
      // A yield purporting to come from 'C' (not the holder B) must NOT grant a takeover.
      expect(await lc.acquireOnConsent('C')).toBe(false);
      expect(lc.currentHolder()).toBe('B'); // unchanged
      expect(lc.currentEpoch()).toBe(1);
    });

    it('is idempotent when this machine already holds the lease', async () => {
      const store = new FakeStore();
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 1_000,
      });
      await lc.acquireIfEligible(); // A holds epoch 1
      expect(await lc.acquireOnConsent('B')).toBe(true); // already ours → true, no change
      expect(lc.currentEpoch()).toBe(1);
    });

    it('acquires from an empty lease on consent (no prior holder to guard against)', async () => {
      const store = new FakeStore();
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 1_000,
      });
      expect(await lc.acquireOnConsent('B')).toBe(true);
      expect(lc.currentEpoch()).toBe(1);
    });
  });

  // ── Cross-Machine Coherence: active-pull accessors ──────────────────────
  describe('active-pull accessors (canPullPeers / pullFromPeers / observedPeerLease)', () => {
    it('canPullPeers reflects whether the transport implements pullAllPeers', async () => {
      const store = new FakeStore();
      const noPull: LeaseTransport = {
        broadcast: async () => true,
        observed: () => ({ lease: null, lastNonceByHolder: {} }),
        isReachable: () => true,
      };
      const lcNo = new LeaseCoordinator({ lease: makeFlA(), store, tunnel: noPull, presumedDeadHolders: () => new Set(), now: () => 1_000 });
      expect(lcNo.canPullPeers()).toBe(false);

      const withPull: LeaseTransport = { ...noPull, pullAllPeers: async () => {} };
      const lcYes = new LeaseCoordinator({ lease: makeFlA(), store: new FakeStore(), tunnel: withPull, presumedDeadHolders: () => new Set(), now: () => 1_000 });
      expect(lcYes.canPullPeers()).toBe(true);

      // No tunnel at all → cannot pull (git-only mesh).
      const lcGit = new LeaseCoordinator({ lease: makeFlA(), store: new FakeStore(), presumedDeadHolders: () => new Set(), now: () => 1_000 });
      expect(lcGit.canPullPeers()).toBe(false);
    });

    it('pullFromPeers invokes the transport and a pulled HIGHER-epoch peer fences us', async () => {
      const store = new FakeStore();
      let observed: LeaseRecord | null = null;
      const pullAllPeers = vi.fn(async () => {
        // Simulate the transport folding a peer's higher-epoch lease on pull.
        // buildAcquisition's 3rd arg is the NONCE; epoch = (currentLease.epoch ?? 0)+1,
        // so a prior {epoch:4} yields epoch 5.
        observed = makeFlB().buildAcquisition({ epoch: 4 } as LeaseRecord, 1_000, 9);
      });
      const tunnel: LeaseTransport = {
        broadcast: async () => true,
        observed: () => ({ lease: observed, lastNonceByHolder: observed ? { [observed.holder]: observed.nonce } : {} }),
        isReachable: () => true,
        pullAllPeers,
      };
      const lc = new LeaseCoordinator({ lease: makeFlA(), store, tunnel, presumedDeadHolders: () => new Set(), now: () => 2_000 });
      expect(await lc.acquireIfEligible()).toBe(true); // A holds epoch 1
      await lc.pullFromPeers();
      expect(pullAllPeers).toHaveBeenCalledTimes(1);
      // The pulled epoch-5 lease (B) is folded → A no longer holds; B is the holder.
      expect(lc.currentEpoch()).toBe(5);
      expect(lc.currentHolder()).toBe('B');
      expect(lc.holdsLease()).toBe(false);
      expect(lc.observedPeerLease()?.holder).toBe('B');
    });

    it('observedPeerLease exposes a SAME-epoch peer that currentHolder() masks (contested split-brain signal)', async () => {
      const store = new FakeStore();
      // observed is null at acquire time so A can self-issue epoch 1 unopposed; the
      // peer's SAME-epoch lease only appears afterward (the true split-brain shape:
      // both machines independently acquired epoch 1 in a git-less mesh).
      let observed: LeaseRecord | null = null;
      const tunnel: LeaseTransport = {
        broadcast: async () => true,
        observed: () => ({ lease: observed, lastNonceByHolder: observed ? { [observed.holder]: observed.nonce } : {} }),
        isReachable: () => true,
        pullAllPeers: async () => {},
      };
      const lc = new LeaseCoordinator({ lease: makeFlA(), store, tunnel, presumedDeadHolders: () => new Set(), now: () => 2_000 });
      expect(await lc.acquireIfEligible()).toBe(true); // A self-issues epoch 1 (no peer yet)
      observed = makeFlB().buildAcquisition(undefined, 1_000, 7); // B at epoch 1, nonce 7
      // effectiveView()'s tie-break: our self-issued (>=) wins, and the tunnel lease
      // is folded only when STRICTLY greater → currentHolder is A...
      expect(lc.currentHolder()).toBe('A');
      expect(lc.holdsLease()).toBe(true);
      // ...but the RAW observed peer lease still names B at the same epoch — exactly
      // the same-epoch contention the standby pull loop surfaces near-silently.
      expect(lc.observedPeerLease()?.holder).toBe('B');
      expect(lc.observedPeerLease()?.epoch).toBe(1);
    });

    it('pullFromPeers is a safe no-op when the transport cannot pull', async () => {
      const store = new FakeStore();
      const lc = new LeaseCoordinator({ lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 1_000 });
      await expect(lc.pullFromPeers()).resolves.toBeUndefined();
      expect(lc.observedPeerLease()).toBeNull();
    });
  });
});
