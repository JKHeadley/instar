/**
 * lease-takeover-no-shared-medium: a pair with no git remote must take over and keep the
 * lease, a named-preferred pool must not change, and the switch off must change nothing.
 * Real Ed25519 keys and the real GitLeaseStore over an in-memory registry.
 */

import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseTransport } from '../../src/core/LeaseCoordinator.js';
import { GitLeaseStore } from '../../src/core/GitLeaseStore.js';
import type { LeaseRecord, MachineRegistry } from '../../src/core/types.js';

const KEYS: Record<string, { publicKey: string; privateKey: string }> = Object.fromEntries(['A', 'B'].map((id) => [id,
  crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })]));
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

class DeadPeerTunnel implements LeaseTransport {
  peer: LeaseRecord | null = null;
  broadcast = async () => false;
  observed = () => ({ lease: this.peer, lastNonceByHolder: this.peer ? { [this.peer.holder]: this.peer.nonce } : {} });
  isReachable = () => false;
}

/** A GitLeaseStore whose push always fails, as it does with no remote. */
function noRemoteStore(self: string, opts: { final: boolean; registry?: MachineRegistry }) {
  const box = { reg: opts.registry ?? ({ machines: { A: {}, B: {} } } as unknown as MachineRegistry) };
  const store = new GitLeaseStore({
    machineId: self,
    loadRegistry: () => JSON.parse(JSON.stringify(box.reg)),
    saveRegistry: (r) => { box.reg = JSON.parse(JSON.stringify(r)); },
    registryAbsPath: '/tmp/registry.json',
    pullRebase: () => true,
    commitAndPush: () => false,
    localCommitIsFinal: () => opts.final,
  });
  return { store, box };
}

function rig(opts: { heldBack?: () => boolean; self?: string; final?: boolean; solo?: boolean; named?: boolean; preferred?: boolean; gone?: boolean; noPeers?: boolean }) {
  const self = opts.self ?? 'B';
  const clock = { mono: 1_000, wall: 1_000_000 };
  const { store, box } = noRemoteStore(self, { final: opts.final ?? true });
  const tunnel = new DeadPeerTunnel();
  const suspends: string[] = [];
  const lc = new LeaseCoordinator({
    lease: new FencedLease(crypt(self), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER }),
    store,
    tunnel,
    presumedDeadHolders: () => new Set(),
    now: () => clock.wall,
    monotonicNow: () => clock.mono,
    onSelfSuspend: (r) => suspends.push(r),
    soloCaptainHold: () => (opts.solo === false ? null : { enabled: true }),
    isPreferredAwakeAgreed: () => opts.preferred ?? false,
    survivorMayHold: () => !(opts.named ?? false) && !(opts.noPeers ?? false),
    allPeersPresumedGone: () => opts.gone ?? false,
    acquireHeldBack: () => opts.heldBack?.() ?? false,
  });
  const advance = (ms: number) => { clock.mono += ms; clock.wall += ms; };
  return { lc, store, box, tunnel, suspends, advance };
}

/** A lease signed by A that has already run out, as a standby sees it after A dies. */
function expiredLeaseFromA(epoch: number, nowMs: number): LeaseRecord {
  const a = new FencedLease(crypt('A'), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER });
  return a.signLease(epoch, new Date(nowMs - 10 * TTL).toISOString(), new Date(nowMs - TTL).toISOString(), 5);
}

describe('GitLeaseStore with nowhere to push', () => {
  const candidate = { holder: 'B', epoch: 4, nonce: 9, acquiredAt: 'x', expiresAt: 'y', signature: 's' } as unknown as LeaseRecord;

  it('a local commit counts when the condition holds', () => {
    expect(noRemoteStore('B', { final: true }).store.casWrite(candidate).ok).toBe(true);
  });

  it('a failed push stays a lost CAS when it does not', () => {
    const r = noRemoteStore('B', { final: false }).store.casWrite(candidate);
    expect(r.ok).toBe(false);
  });

  it('only the exact candidate counts: a registry someone else changed is not our success', () => {
    const box = { reg: { machines: { B: {} } } as unknown as MachineRegistry };
    const store = new GitLeaseStore({
      machineId: 'B',
      loadRegistry: () => JSON.parse(JSON.stringify(box.reg)),
      saveRegistry: (r) => { box.reg = { ...JSON.parse(JSON.stringify(r)), lease: { ...candidate, nonce: 1000 } }; },
      registryAbsPath: '/tmp/r.json',
      pullRebase: () => true,
      commitAndPush: () => false,
      localCommitIsFinal: () => true,
    });
    expect(store.casWrite(candidate).ok).toBe(false);
  });

  it('a tie loser reads as expired and keeps the epoch as the floor', () => {
    const { store, box } = noRemoteStore('B', { final: true });
    store.casWrite(candidate);
    store.forceLocalExpiry();
    expect(box.reg.lease?.epoch).toBe(4);
    expect(Date.parse(box.reg.lease!.expiresAt)).toBe(0);
  });

  it('forceLocalExpiry leaves a store with a remote alone', () => {
    const { store, box } = noRemoteStore('B', { final: false, registry: { machines: {}, lease: candidate } as unknown as MachineRegistry });
    store.forceLocalExpiry();
    expect(box.reg.lease?.expiresAt).toBe('y');
  });
});

describe('takeover end to end, one coordinator, dead peer', () => {
  it('the standby takes over once, keeps serving, and the epoch stays flat', async () => {
    const r = rig({});
    r.box.reg.lease = expiredLeaseFromA(7, 1_000_000);
    expect(await r.lc.acquireIfEligible()).toBe(true);
    expect(r.lc.currentEpoch()).toBe(8);
    for (let i = 0; i < 40; i++) { // 40 x 45 s = 30 minutes
      r.advance(45_000);
      await r.lc.acquireIfEligible();
      expect(r.lc.holdsLease()).toBe(true);
    }
    expect(r.lc.currentEpoch()).toBe(8);
    expect(r.suspends).toEqual([]);
  });

  it('switch off: the failed push stays a lost CAS and nothing holds', async () => {
    const r = rig({ final: false, solo: false });
    r.box.reg.lease = expiredLeaseFromA(7, 1_000_000);
    await r.lc.acquireIfEligible();
    r.advance(TTL + 1);
    await r.lc.renew();
    expect(r.suspends.length).toBe(1);
  });

  it('a higher epoch ends the hold', async () => {
    const r = rig({});
    r.box.reg.lease = expiredLeaseFromA(7, 1_000_000);
    await r.lc.acquireIfEligible();
    const a = new FencedLease(crypt('A'), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER });
    r.tunnel.peer = a.signLease(9, new Date(1_000_000).toISOString(), new Date(1_000_000 + 10 * TTL).toISOString(), 50);
    expect(r.lc.holdsLease()).toBe(false);
    expect(r.lc.currentHolder()).toBe('A');
  });
});

describe('who may hold', () => {
  async function heldThenLapsed(o: Parameters<typeof rig>[0]) {
    const r = rig(o);
    expect(await r.lc.acquireIfEligible()).toBe(true); // own first lease, not taken from a peer
    r.advance(TTL + 1);
    await r.lc.renew();
    return r;
  }

  it('unnamed: the main machine keeps serving when the standby goes quiet, on a flat epoch', async () => {
    const r = await heldThenLapsed({});
    const epoch = r.lc.currentEpoch();
    for (let i = 0; i < 40; i++) { r.advance(45_000); await r.lc.acquireIfEligible(); expect(r.lc.holdsLease()).toBe(true); }
    expect(r.lc.currentEpoch()).toBe(epoch);
    expect(r.suspends).toEqual([]);
  });
  it('named, not the preferred machine, peers gone: self-suspends as today', async () => {
    expect((await heldThenLapsed({ named: true, gone: true })).suspends.length).toBe(1);
  });
  it('named, the preferred machine, peers gone: holds as today', async () => {
    expect((await heldThenLapsed({ named: true, preferred: true, gone: true })).suspends).toEqual([]);
  });
  it('named, the preferred machine, a peer not gone: self-suspends as today', async () => {
    expect((await heldThenLapsed({ named: true, preferred: true })).suspends.length).toBe(1);
  });
  it('named: a takeover by a non-preferred machine does not hold', async () => {
    const r = rig({ named: true });
    r.box.reg.lease = expiredLeaseFromA(7, 1_000_000);
    await r.lc.acquireIfEligible();
    r.advance(TTL + 1);
    await r.lc.renew();
    expect(r.suspends.length).toBe(1);
  });
  it('one machine, no peers: self-suspends as today', async () => {
    expect((await heldThenLapsed({ noPeers: true })).suspends.length).toBe(1);
  });
  it('switch off, unnamed: self-suspends', async () => {
    expect((await heldThenLapsed({ solo: false })).suspends.length).toBe(1);
  });
});

describe('taking back an own lapsed lease after a restart', () => {
  function restarted(o: { solo?: boolean; named?: boolean; peerLeaseOnPull?: (t: DeadPeerTunnel) => void }) {
    const r = rig({ solo: o.solo, named: o.named, self: 'B' });
    const b = new FencedLease(crypt('B'), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER });
    r.box.reg.lease = b.signLease(7, new Date(1).toISOString(), new Date(2).toISOString(), 5);
    let pulls = 0;
    (r.tunnel as unknown as { pullAllPeers: () => Promise<void> }).pullAllPeers = async () => { pulls++; o.peerLeaseOnPull?.(r.tunnel); };
    return { ...r, pulls: () => pulls };
  }

  it('a takeover made meanwhile is seen, so nothing ties at the same epoch', async () => {
    const r = restarted({ peerLeaseOnPull: (t) => {
      const a = new FencedLease(crypt('A'), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER });
      t.peer = a.signLease(8, new Date(1_000_000).toISOString(), new Date(1_000_000 + TTL).toISOString(), 50);
    } });
    expect(await r.lc.acquireIfEligible()).toBe(false);
    expect(r.lc.currentHolder()).toBe('A');
    expect(r.lc.currentEpoch()).toBe(8);
  });
  it('no peer answers: it takes the lease back once and keeps it', async () => {
    const r = restarted({});
    expect(await r.lc.acquireIfEligible()).toBe(true);
    expect(r.pulls()).toBe(1);
    expect(r.lc.currentEpoch()).toBe(8);
  });
  it('a peer that never answers cannot hold up acquisition', async () => {
    vi.useFakeTimers();
    try {
      const r = restarted({});
      (r.tunnel as unknown as { pullAllPeers: () => Promise<void> }).pullAllPeers = () => new Promise(() => {});
      const acquired = r.lc.acquireIfEligible();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await acquired).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('a same-epoch tie loser on git stops holding before the winner\'s epoch arrives', async () => {
    const r = rig({});
    await r.lc.acquireIfEligible();
    expect(r.lc.holdsLease()).toBe(true);
    r.lc.relinquish();
    expect(r.lc.holdsLease()).toBe(false);
  });
  it('a named pool does not ask first', async () => {
    const r = restarted({ named: true });
    await r.lc.acquireIfEligible();
    expect(r.pulls()).toBe(0);
  });
  it('switch off does not ask first', async () => {
    const r = restarted({ solo: false });
    await r.lc.acquireIfEligible();
    expect(r.pulls()).toBe(0);
  });
});

describe('a joined machine with no proved link', () => {
  it('does not take an expired lease, and takes it the moment proof exists', async () => {
    let proved = false;
    const r = rig({ heldBack: () => !proved });
    r.box.reg = { ...r.box.reg, lease: expiredLeaseFromA(4, 1_000_000) } as unknown as MachineRegistry;
    expect(await r.lc.acquireIfEligible()).toBe(false);
    expect(r.lc.holdsLease()).toBe(false);
    expect(r.suspends).toEqual([]);
    proved = true;
    expect(await r.lc.acquireIfEligible()).toBe(true);
    expect(r.lc.holdsLease()).toBe(true);
  });
});
