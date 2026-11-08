/**
 * lease-restart-no-tie, at the level the loop actually happened (fb-c51067c6-148): the real
 * coordinator's pull loop and tie-break, the real lease store and transport, and the real
 * decision that restarts a machine. A machine restarts when its role differs from the one it
 * booted with, so the proof is that no role changes after a boot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { HttpLeaseTransport } from '../../src/core/HttpLeaseTransport.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { decideRoleRestart } from '../../src/core/roleFollowRestart.js';

const genKey = () => crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KEYS: Record<string, { publicKey: string; privateKey: string }> = { aaa: genKey(), bbb: genKey() };
const crypt = (self: string): LeaseCrypto => ({
  selfMachineId: self,
  sign: (c) => crypto.sign(null, Buffer.from(c), KEYS[self].privateKey).toString('base64'),
  verify: (c, sig, holder) => {
    const pub = KEYS[holder]?.publicKey;
    if (!pub) return false;
    try { return crypto.verify(null, Buffer.from(c), pub, Buffer.from(sig, 'base64')); } catch { return false; }
  },
});
const TTL = 60_000;
const PULL = 1_000;

describe('the restart loop, through the real coordinator', () => {
  let dir: string;
  let now: number;
  let seq: number;
  let renewOff: boolean;
  let ineligible: boolean;
  const up: Record<string, boolean> = {};
  const live: Record<string, { lc: LeaseCoordinator; t: HttpLeaseTransport; coord: MultiMachineCoordinator; bootAwake: boolean }> = {};

  const bridge = (async (url: string, opts: { body?: string }) => {
    const id = new URL(url).host;
    if (!up[id] || !live[id]) return { ok: false };
    if (url.endsWith('/api/lease/pull')) {
      live[id].coord.noteLeasePeerPull(); // as the route does
      return { ok: true, json: async () => ({ lease: live[id].lc.currentLease() }) };
    }
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (body?.lease) live[id].t.recordObserved(body.lease);
    return { ok: true };
  }) as unknown as typeof fetch;

  /** Boot as the server does: the coordinator claims or stands by, then the pull loop runs. */
  async function boot(self: 'aaa' | 'bbb', o: { listenLater?: boolean; sharedStore?: boolean } = {}) {
    live[self]?.coord.stop();
    const other = self === 'aaa' ? 'bbb' : 'aaa';
    const stateDir = path.join(dir, self);
    const identity = { machineId: self, signingPublicKey: 'k1', encryptionPublicKey: 'k2', name: self, platform: 'test', createdAt: new Date(2_000).toISOString(), capabilities: ['sessions'] };
    fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), JSON.stringify(identity));
    new MachineIdentityManager(stateDir).registerMachine(identity as never, 'awake');
    const t = new HttpLeaseTransport({
      selfMachineId: self, signingKeyPem: KEYS[self].privateKey,
      peers: () => [{ machineId: other, url: `http://${other}` }],
      nextSequence: () => ++seq, reachabilityWindowMs: TTL, fetchImpl: bridge, now: () => now,
    });
    const store = new LocalLeaseStore({ filePath: path.join(stateDir, 'lease-local.json') });
    if (o.sharedStore) store.hasNoSharedMedium = () => false;
    const lc = new LeaseCoordinator({
      lease: new FencedLease(crypt(self), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 }),
      store,
      tunnel: t, presumedDeadHolders: () => new Set(), now: () => now, monotonicNow: () => now,
      soloCaptainHold: () => null, survivorMayHold: () => true, isLeaseEligible: () => !ineligible,
    });
    const coord = new MultiMachineCoordinator(new StateManager(stateDir), {
      stateDir,
      multiMachine: { leasePullIntervalMs: PULL, ...(renewOff ? { leaseSelfHeal: { resilientRenew: { enabled: false } } } : {}) } as never,
    });
    coord.start();
    coord.attachLeaseCoordinator(lc);
    // A real server claims and pulls well before it listens, so nobody can reach it yet.
    up[self] = false;
    live[self] = { lc, t, coord, bootAwake: false };
    await coord.initializeLease();
    live[self].bootAwake = lc.holdsLease();
    if (!o.listenLater) up[self] = true;
    return live[self];
  }
  function down(self: string) {
    up[self] = false;
    live[self]?.coord.stop();
  }
  /** Time passing with a holder that renews, and every running pull loop ticking. */
  async function run(ms: number, holder?: LeaseCoordinator) {
    for (let t = 0; t < ms; t += PULL * 10) {
      now += PULL * 10;
      await holder?.renew();
      await vi.advanceTimersByTimeAsync(PULL * 10);
    }
  }
  const wouldRestart = (self: string) => decideRoleRestart({
    applies: true, bootAwake: live[self].bootAwake, nowAwake: live[self].lc.holdsLease(), lastRestartAtMs: null, nowMs: now,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-loop-'));
    now = 2_000;
    seq = 0;
    renewOff = false;
    ineligible = false;
    for (const k of Object.keys(up)) delete up[k];
    for (const k of Object.keys(live)) delete live[k];
  });
  afterEach(() => {
    for (const m of Object.values(live)) m.coord.stop();
    vi.useRealTimers();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lease-restart-no-tie-coordinator.test.ts' });
  });

  /** Leave each machine holding an old lease of its own, with `holder` holding now. */
  async function bothHeld(holder: 'aaa' | 'bbb') {
    const other = holder === 'aaa' ? 'bbb' : 'aaa';
    await boot(other);
    down(other);
    now += TTL * 2;
    const h = await boot(holder);
    expect(h.lc.holdsLease()).toBe(true);
    now += TTL * 2;
    await h.lc.acquireIfEligible();
    expect(h.lc.holdsLease()).toBe(true);
    return h;
  }

  for (const holder of ['aaa', 'bbb'] as const) {
    const other = holder === 'aaa' ? 'bbb' : 'aaa';
    it(`${other} restarts behind live ${holder}: no tie, no role change, nothing restarts, five times`, async () => {
      const h = await bothHeld(holder);
      const epoch = h.lc.currentEpoch();
      const relinquish = vi.spyOn(h.lc, 'relinquish');
      for (let i = 0; i < 5; i++) {
        const o = await boot(other);
        expect(o.bootAwake).toBe(false);
        await run(TTL * 2, h.lc);
        expect(o.lc.holdsLease()).toBe(false);
        expect(o.lc.currentHolder()).toBe(holder);
        expect(h.lc.holdsLease()).toBe(true);
        expect(h.lc.currentEpoch()).toBe(epoch);
        expect(wouldRestart(other)).toBe('same-as-boot');
        expect(wouldRestart(holder)).toBe('same-as-boot');
        down(other);
        now += TTL / 3;
        await h.lc.renew();
      }
      expect(relinquish).not.toHaveBeenCalled();
    });

    it(`${other} returns at ${holder}'s number with its own copy lapsed: ${holder} keeps the lease`, async () => {
      const first = await bothHeld(other);
      const reached = first.lc.currentEpoch();
      down(other);
      now += TTL * 2;
      // holder could not see the number other reached. Its own older copy takes it to the same one.
      const h = await boot(holder);
      expect(h.lc.holdsLease()).toBe(true);
      expect(h.lc.currentEpoch()).toBe(reached);
      const relinquish = vi.spyOn(h.lc, 'relinquish');
      const o = await boot(other);
      expect(o.bootAwake).toBe(false);
      expect(o.lc.currentHolder()).toBe(holder);
      await run(TTL * 2, h.lc);
      expect(h.lc.holdsLease()).toBe(true);
      expect(h.lc.currentEpoch()).toBe(reached);
      expect(o.lc.holdsLease()).toBe(false);
      expect(relinquish).not.toHaveBeenCalled();
    });
  }

  /** Fifteen minutes with nothing renewing by hand, and how many times the holder changed. */
  async function holderChangesOver15Min(h: { lc: LeaseCoordinator }): Promise<number> {
    let swaps = 0;
    let last = h.lc.holdsLease();
    for (let i = 0; i < 90; i++) {
      await run(PULL * 10);
      const nowHolds = h.lc.holdsLease();
      if (nowHolds !== last) swaps++;
      last = nowHolds;
    }
    return swaps;
  }

  it('a pair with no conversation surface keeps one holder, so nothing restarts', async () => {
    const h = await bothHeld('aaa');
    const epoch = h.lc.currentEpoch();
    await boot('bbb');
    expect(await holderChangesOver15Min(h)).toBe(0);
    expect(h.lc.holdsLease()).toBe(true);
    expect(h.lc.currentEpoch()).toBe(epoch);
  });

  it('turning renewal off explicitly still wins, and shows what the timer prevents', async () => {
    renewOff = true;
    const h = await bothHeld('aaa');
    await boot('bbb');
    expect(await holderChangesOver15Min(h)).toBeGreaterThan(2);
  });

  it.each([20, 70, 150])('a restart taking %ss to listen again leaves the holder alone, five times', async (seconds) => {
    const h = await bothHeld('aaa');
    await boot('bbb');
    await run(TTL);
    const epoch = h.lc.currentEpoch();
    for (let i = 0; i < 5; i++) {
      down('bbb');
      now += 13_000; // measured on the pair: exit to next boot
      await vi.advanceTimersByTimeAsync(13_000);
      const o = await boot('bbb', { listenLater: true });
      expect(o.bootAwake).toBe(false);
      await run(seconds * 1000);
      up.bbb = true;
      await run(TTL);
      expect(o.lc.holdsLease()).toBe(false);
      expect(h.lc.holdsLease()).toBe(true);
      expect(h.lc.currentEpoch()).toBe(epoch);
      expect(wouldRestart('bbb')).toBe('same-as-boot');
      expect(wouldRestart('aaa')).toBe('same-as-boot');
    }
  });

  it('with no pulls and no pushes the lease still runs out: a pull proves a link, nothing else does', async () => {
    const h = await bothHeld('aaa');
    await boot('bbb');
    await run(TTL);
    expect(h.lc.holdsLease()).toBe(true);
    down('bbb');
    await run(TTL * 2);
    expect(h.lc.holdsLease()).toBe(false);
  });

  it('a pull extends a lease only in its second half, and never with renewal off or for a non-holder', async () => {
    const h = await boot('aaa');
    const signed = () => h.lc.currentLease()?.nonce;
    const before = signed();
    h.coord.noteLeasePeerPull();
    expect(signed()).toBe(before); // first half: nothing to do
    now += TTL * 0.6;
    h.coord.noteLeasePeerPull();
    expect(signed()).not.toBe(before);
    expect(new Date(h.lc.currentLease()!.expiresAt).getTime()).toBe(now + TTL);

    renewOff = true;
    const off = await boot('bbb');
    expect(off.lc.holdsLease()).toBe(false);
    const name = off.lc.currentLease()?.nonce;
    off.coord.noteLeasePeerPull();
    expect(off.lc.currentLease()?.nonce).toBe(name);
  });

  describe('a pull leaves the lease alone', () => {
    const second = async (o: { sharedStore?: boolean } = {}) => {
      const h = await boot('aaa', o);
      now += TTL * 0.6;
      return { h, nonce: h.lc.currentLease()?.nonce };
    };
    it('on a store other machines also read', async () => {
      const { h, nonce } = await second({ sharedStore: true });
      h.lc.confirmHoldOnPeerPull();
      expect(h.lc.currentLease()?.nonce).toBe(nonce);
    });
    it('on an observe-only machine', async () => {
      const { h, nonce } = await second();
      (h.coord as unknown as { config: { multiMachine: Record<string, unknown> } }).config.multiMachine.leaseSelfHeal = { leaseRole: 'observe-only' };
      h.coord.noteLeasePeerPull();
      expect(h.lc.currentLease()?.nonce).toBe(nonce);
    });
    it('once the coordinator has stopped', async () => {
      const { h, nonce } = await second();
      h.coord.stop();
      h.coord.noteLeasePeerPull();
      expect(h.lc.currentLease()?.nonce).toBe(nonce);
    });
    it('on a machine that may not hold it', async () => {
      const { h, nonce } = await second();
      ineligible = true;
      h.coord.noteLeasePeerPull();
      expect(h.lc.currentLease()?.nonce).toBe(nonce);
    });
  });

  it('a signing fault during a pull still answers the pull', async () => {
    const h = await boot('aaa');
    vi.spyOn(h.lc, 'confirmHoldOnPeerPull').mockImplementation(() => { throw new Error('no key'); });
    expect(() => h.coord.noteLeasePeerPull()).not.toThrow();
  });

  it('a holder that becomes ineligible gives the lease up, though the renew timer keeps running', async () => {
    const h = await bothHeld('aaa');
    await boot('bbb');
    await run(TTL);
    expect(h.lc.holdsLease()).toBe(true);
    ineligible = true;
    await run(TTL);
    expect(h.lc.holdsLease()).toBe(false);
    // It told the peer rather than leaving it to wait out the lease.
    expect(live.bbb.lc.observedPeerLease()?.released).toBe(true);
  });

  it('a slow renewal does not replace a newer lease signed while it waited', async () => {
    const h = await boot('aaa');
    now += TTL * 0.6;
    let finish!: (ok: boolean) => void;
    vi.spyOn(h.t, 'broadcast').mockImplementation(() => new Promise<boolean>((r) => { finish = r; }));
    const renewing = h.lc.renew();
    now += 3_000;
    h.lc.confirmHoldOnPeerPull();
    const newer = h.lc.currentLease();
    finish(true);
    await renewing;
    expect(h.lc.currentLease()?.nonce).toBe(newer?.nonce);
    expect(h.lc.currentLease()?.expiresAt).toBe(newer?.expiresAt);
  });

  it('a live lease this machine renewed is not replaced because its file copy is old', async () => {
    const h = await boot('aaa');
    const epoch = h.lc.currentEpoch();
    vi.spyOn(h.t, 'broadcast').mockResolvedValue(true);
    for (let i = 0; i < 4; i++) { now += TTL / 2; await h.lc.renew(); }
    const peer = new FencedLease(crypt('bbb'), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 });
    h.t.recordObserved(peer.signLease(epoch, new Date(now).toISOString(), new Date(now + TTL * 2).toISOString(), 50));
    expect(h.lc.currentHolder()).toBe('aaa');
    expect(h.lc.holdsLease()).toBe(true);
  });

  it('one long outage may swap the roles, and short restarts after it settle them', async () => {
    const h = await bothHeld('aaa');
    await boot('bbb');
    await run(TTL);
    expect(h.lc.holdsLease()).toBe(true);
    down('bbb');
    await run(TTL * 3); // past the whole lease
    await boot('bbb', { listenLater: true });
    await run(30_000);
    up.bbb = true;
    await run(TTL);
    // Follow the real decision, each 15 minutes, with restarts of the measured length.
    const restartsByRound: number[] = [];
    for (let round = 0; round < 6; round++) {
      let restarts = 0;
      for (const id of ['aaa', 'bbb'] as const) {
        if (wouldRestart(id) !== 'restart') continue;
        restarts++;
        down(id);
        now += 13_000;
        await vi.advanceTimersByTimeAsync(13_000);
        await boot(id);
      }
      restartsByRound.push(restarts);
      await run(15 * 60_000);
    }
    expect(restartsByRound.slice(-3)).toEqual([0, 0, 0]);
    expect([live.aaa.lc.holdsLease(), live.bbb.lc.holdsLease()].filter(Boolean)).toHaveLength(1);
  });

  it('a running machine whose lease lapsed names a peer holding at its number, and stops renewing', async () => {
    const h = await boot('aaa');
    const epoch = h.lc.currentEpoch();
    const peer = new FencedLease(crypt('bbb'), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 });
    now += TTL * 2;
    const at = new Date(now).toISOString();
    h.t.recordObserved(peer.signLease(epoch, at, new Date(now + TTL).toISOString(), 50));
    expect(h.lc.currentHolder()).toBe('bbb');
    expect(h.lc.holdsLease()).toBe(false);
    expect(await h.lc.renew()).toBe(false);
  });

  it('when the holder then really dies, the standby takes over from the pull loop, not the next heartbeat', async () => {
    const h = await bothHeld('aaa');
    const o = await boot('bbb');
    await run(TTL, h.lc);
    expect(o.lc.holdsLease()).toBe(false);
    const epoch = h.lc.currentEpoch();
    down('aaa');
    // Nothing renews in this rig, so catch it at the moment it takes over. The heartbeat is 120s;
    // aaa's lease has at most one lifetime left, so this bound is only met by the pull loop.
    for (let i = 0; i < 9 && !o.lc.holdsLease(); i++) await run(PULL * 10);
    expect(o.lc.holdsLease()).toBe(true);
    expect(o.lc.currentEpoch()).toBeGreaterThan(epoch);
  });
});
