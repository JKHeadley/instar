/**
 * stall-wake-lease-reconfirm (fb-fdb55c1c-a79) — LeaseCoordinator decisions with real Ed25519
 * leases and the real LocalLeaseStore. The 2026-11-21 16:05–16:09Z case: the Studio holds epoch
 * 23760 and renews; the Laptop (standby, boot hold long over) stalls 226 s, and at wake its own
 * copy of the Studio's lease is 4 minutes old.
 *  - switch off: the Laptop claims 23761 at once (the incident, reproduced);
 *  - switch on: it pulls first, the Studio's fresh renewal lands, no claim;
 *  - a holder really dead after the stall is still taken over once the fresh pulls confirm it;
 *  - no stall: today's behaviour, pull for pull.
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseTransport } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { PeerProbe, PeerProbeRecord, ProbeAnswer } from '../../src/core/BootClaimHold.js';
import type { LeaseRecord } from '../../src/core/types.js';

const IDS = ['laptop', 'studio', 'mini'];
const KEYS = Object.fromEntries(IDS.map((id) => [id, crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})])) as Record<string, { publicKey: string; privateKey: string }>;
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
const fl = (id: string) => new FencedLease(crypt(id), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 });

/**
 * A pull-capable transport. `answers[p]` is what a pull of p records; a signed answer folds the
 * peer's current `view[p]` (the holder's own lease when it is alive) and records what it disclosed.
 */
class PeerTransport implements LeaseTransport {
  answers: Record<string, ProbeAnswer> = {};
  view: Record<string, () => LeaseRecord | null> = {};
  causes: Record<string, string | undefined> = {};
  pulls = 0;
  private obs: LeaseRecord | null = null;
  private nonces: Record<string, number> = {};
  private probes = new Map<string, PeerProbeRecord>();
  private disclosed = new Map<string, { lease: LeaseRecord | null; observedAtMs: number }>();
  constructor(private peers: string[], private now: () => number) {}
  broadcast = async () => this.peers.some((p) => this.answers[p] === 'signed');
  observed = () => ({ lease: this.obs, lastNonceByHolder: { ...this.nonces } });
  isReachable = () => true;
  /** A renewal pushed to this machine (the receive path folds it). */
  push(l: LeaseRecord): void {
    if (!this.obs || l.epoch >= this.obs.epoch) this.obs = l;
    this.nonces[l.holder] = l.nonce;
  }
  async pullAllPeers(): Promise<void> {
    this.pulls++;
    for (const p of this.peers) {
      const a = this.answers[p] ?? 'silent';
      const r = this.probes.get(p) ?? { probes: [], unsignedSinceMs: null, firstSignedAtMs: null };
      const probe: PeerProbe = { atMs: this.now(), answer: a };
      if (a === 'silent' && this.causes[p]) (probe as PeerProbe & { cause?: string }).cause = this.causes[p];
      r.probes.push(probe);
      if (a === 'signed') { r.unsignedSinceMs = null; if (r.firstSignedAtMs == null) r.firstSignedAtMs = this.now(); }
      else if (a === 'unsigned' && r.unsignedSinceMs === null) r.unsignedSinceMs = this.now();
      this.probes.set(p, r);
      if (a === 'signed') {
        const l = this.view[p]?.() ?? null;
        this.disclosed.set(p, { lease: l, observedAtMs: this.now() });
        if (l) this.push(l);
      }
    }
  }
  probeHistory = () => new Map(this.probes);
  knownPeerIds = () => [...this.peers];
  observedByPeer = () => new Map(this.disclosed);
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'LeaseCoordinator-stallReconfirm-test-cleanup' }); });

function rig(opts: { stallReconfirm: boolean; bootClaimSafety?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-reconfirm-'));
  dirs.push(dir);
  const clock = { wall: 1_795_000_000_000, mono: 5_000 };
  const tunnel = new PeerTransport(['studio', 'mini'], () => clock.wall);
  const logs: string[] = [];
  let studioNonce = 100;
  /** The Studio renewing: its lease as it signs it right now. */
  const studioLive = () => fl('studio').signLease(23760, new Date(clock.wall - 3.5 * 3_600_000).toISOString(), new Date(clock.wall + TTL).toISOString(), ++studioNonce);
  const lc = new LeaseCoordinator({
    lease: fl('laptop'),
    store: new LocalLeaseStore({ filePath: path.join(dir, 'lease-local.json') }),
    tunnel,
    presumedDeadHolders: () => new Set(),
    now: () => clock.wall,
    monotonicNow: () => clock.mono,
    survivorMayHold: () => false,
    bootClaimSafety: () => (opts.bootClaimSafety === false ? null : { enabled: true, preferredMachineId: 'studio' }),
    stallReconfirm: () => (opts.stallReconfirm ? { enabled: true } : null),
    logger: (m) => logs.push(m),
  });
  /** Normal awake operation: the Studio pushes a renewal, a pull loop tick runs. */
  const awakeStep = async (ms: number, studioAlive = true) => {
    clock.wall += ms; clock.mono += ms;
    if (studioAlive) tunnel.push(studioLive());
    await lc.pullFromPeers();
  };
  /** The stall: the clocks move, this process folds nothing. */
  const stall = (ms: number) => { clock.wall += ms; clock.mono += ms; };
  return { lc, tunnel, logs, clock, studioLive, awakeStep, stall };
}

/** Steady state before the stall: the boot hold is over and the Studio is seen holding. */
async function steady(r: ReturnType<typeof rig>) {
  r.tunnel.answers.studio = 'signed';
  r.tunnel.answers.mini = 'signed';
  r.tunnel.view.studio = r.studioLive;
  r.tunnel.view.mini = r.studioLive;
  await r.awakeStep(1_000);
  expect(await r.lc.acquireIfEligible()).toBe(false); // "acquire skipped: held-by-live-peer"
  expect(r.lc.bootHoldActive()).toBe(false);
  for (let i = 0; i < 3; i++) await r.awakeStep(5_000);
  expect(r.lc.currentHolder()).toBe('studio');
}

describe('tonight: the holder is renewing, the standby\'s clock jumps 226 s', () => {
  it('switch off: the stale copy is claimed within a second of waking (the incident, reproduced)', async () => {
    const r = rig({ stallReconfirm: false });
    await steady(r);
    r.stall(226_000);
    expect(await r.lc.acquireIfEligible()).toBe(true);
    expect(r.lc.currentEpoch()).toBe(23761);
  });

  it('switch on: it pulls first, the Studio\'s fresh lease lands, no claim, the holder is re-confirmed', async () => {
    const r = rig({ stallReconfirm: true });
    await steady(r);
    const pullsBefore = r.tunnel.pulls;
    r.stall(226_000);
    expect(await r.lc.acquireIfEligible()).toBe(false);
    expect(r.tunnel.pulls).toBe(pullsBefore + 1); // the fresh pull over every route
    expect(r.lc.holdsLease()).toBe(false);
    expect(r.lc.currentHolder()).toBe('studio');
    expect(r.lc.currentEpoch()).toBe(23760);
    expect(r.logs.some((l) => /stall-reconfirm: opened — this machine lost 226 s of running time .*largest gap 226 s/.test(l))).toBe(true);
    expect(r.logs.some((l) => /acquire skipped: held-by-live-peer/.test(l))).toBe(true);
    // And it keeps not claiming while the Studio renews.
    for (let i = 0; i < 20; i++) {
      await r.awakeStep(5_000);
      expect(await r.lc.acquireIfEligible()).toBe(false);
    }
    expect(r.lc.currentEpoch()).toBe(23760);
  });

  it('switch on, the Studio unreachable right after the wake: held, never claimed on the aged copy', async () => {
    const r = rig({ stallReconfirm: true });
    await steady(r);
    r.tunnel.answers.studio = 'silent'; // the first pulls after wake fail (its network still waking)
    r.tunnel.answers.mini = 'silent';
    r.stall(226_000);
    expect(await r.lc.acquireIfEligible()).toBe(false);
    expect(r.logs.some((l) => /stall-reconfirm: claim held \(waiting\)/.test(l))).toBe(true);
    // 20 s later the Studio answers again with its live lease: adopted, never contested.
    for (let i = 0; i < 4; i++) { await r.awakeStep(5_000, false); expect(await r.lc.acquireIfEligible()).toBe(false); }
    r.tunnel.answers.studio = 'signed';
    await r.awakeStep(5_000, false);
    expect(await r.lc.acquireIfEligible()).toBe(false);
    expect(r.lc.currentHolder()).toBe('studio');
    expect(r.lc.currentEpoch()).toBe(23760);
  });
});

describe('the other side: the holder really is dead after the stall', () => {
  it('taken over one TTL awake after the stall, with a completed fresh round, not before', async () => {
    const r = rig({ stallReconfirm: true });
    await steady(r);
    r.tunnel.answers.studio = 'silent';
    r.tunnel.view.mini = () => null; // the Mini sees nothing live either
    r.stall(226_000);
    const woke = r.clock.wall;
    let claimedAt: number | null = null;
    for (let i = 0; i < 30 && claimedAt === null; i++) {
      if (await r.lc.acquireIfEligible()) claimedAt = r.clock.wall - woke;
      else await r.awakeStep(5_000, false);
    }
    expect(claimedAt).not.toBeNull();
    expect(claimedAt).toBe(60_000);
    expect(r.lc.currentEpoch()).toBe(23761);
    expect(r.logs.some((l) => /stall-reconfirm: claim allowed \(awake-ttl\)/.test(l))).toBe(true);
    expect(r.lc.stallEpisodeOpen()).toBeNull();
  });

  it('a holder that answers "I hold nothing" after the stall is taken over after one TTL awake (no reply-based shortcut)', async () => {
    const r = rig({ stallReconfirm: true });
    await steady(r);
    r.tunnel.view.studio = () => null; // its server is up but it lost the lease
    r.tunnel.view.mini = () => null;
    r.stall(226_000);
    const woke = r.clock.wall;
    let claimedAt: number | null = null;
    for (let i = 0; i < 30 && claimedAt === null; i++) {
      if (await r.lc.acquireIfEligible()) claimedAt = r.clock.wall - woke;
      else await r.awakeStep(5_000, false);
    }
    expect(claimedAt).toBe(60_000);
    expect(r.lc.currentEpoch()).toBe(23761);
    expect(r.logs.some((l) => /claim allowed \(awake-ttl\)/.test(l))).toBe(true);
  });

  it('one fresh pull per episode: later held ticks rely on the pull loop', async () => {
    const r = rig({ stallReconfirm: true });
    await steady(r);
    r.tunnel.answers.studio = 'silent';
    r.stall(226_000);
    const p0 = r.tunnel.pulls;
    expect(await r.lc.acquireIfEligible()).toBe(false);
    expect(r.tunnel.pulls).toBe(p0 + 1);
    for (let i = 0; i < 3; i++) expect(await r.lc.acquireIfEligible()).toBe(false);
    expect(r.tunnel.pulls).toBe(p0 + 1);
  });

  it('silence this machine caused (a local refusal) is unknown: no takeover until a full TTL awake', async () => {
    const r = rig({ stallReconfirm: true });
    await steady(r);
    r.tunnel.answers.studio = 'silent';
    r.tunnel.causes.studio = 'local-refusal';
    r.tunnel.view.mini = () => null;
    r.stall(226_000);
    const woke = r.clock.wall;
    let claimedAt: number | null = null;
    for (let i = 0; i < 30 && claimedAt === null; i++) {
      if (await r.lc.acquireIfEligible()) claimedAt = r.clock.wall - woke;
      else await r.awakeStep(5_000, false);
    }
    expect(claimedAt).toBe(60_000);
    expect(r.logs.some((l) => /claim allowed \(awake-ttl\)/.test(l))).toBe(true);
  });
});

describe('episode lifecycle', () => {
  it('an episode whose holder stayed live ages out after one TTL awake with a completed round', async () => {
    const r = rig({ stallReconfirm: true });
    await steady(r);
    r.stall(226_000);
    expect(await r.lc.acquireIfEligible()).toBe(false);
    expect(r.lc.stallEpisodeOpen()).not.toBeNull();
    for (let i = 0; i < 13; i++) await r.awakeStep(5_000);
    expect(r.lc.stallEpisodeOpen()).toBeNull();
    expect(r.logs.some((l) => /stall-reconfirm: closed — aged out/.test(l))).toBe(true);
  });

  it('a released view after a stall gets one fresh pull before any claim, so a newer holder is seen', async () => {
    const r = rig({ stallReconfirm: true });
    await steady(r);
    // The Studio released epoch 23760; during this machine's stall the Mini took 23761.
    r.tunnel.push(fl('studio').signLease(23760, new Date(r.clock.wall - 1_000).toISOString(), new Date(r.clock.wall).toISOString(), 10_000, true));
    r.stall(226_000);
    r.tunnel.view.mini = () => fl('mini').signLease(23761, new Date(r.clock.wall - 100_000).toISOString(), new Date(r.clock.wall + TTL).toISOString(), 77);
    r.tunnel.view.studio = () => null;
    const p0 = r.tunnel.pulls;
    expect(await r.lc.acquireIfEligible()).toBe(false);
    expect(r.tunnel.pulls).toBeGreaterThan(p0);
    expect(r.lc.currentHolder()).toBe('mini');
    expect(r.lc.currentEpoch()).toBe(23761);
  });
});

describe('released view, first pull failing', () => {
  it('no claim on the released view while the pulls fail; the newer holder is adopted when one answers', async () => {
    const r = rig({ stallReconfirm: true });
    await steady(r);
    r.tunnel.push(fl('studio').signLease(23760, new Date(r.clock.wall - 1_000).toISOString(), new Date(r.clock.wall).toISOString(), 10_000, true));
    r.stall(226_000);
    r.tunnel.answers.studio = 'silent'; r.tunnel.answers.mini = 'silent'; // Wi-Fi still reconnecting
    for (let i = 0; i < 4; i++) { expect(await r.lc.acquireIfEligible()).toBe(false); await r.awakeStep(5_000, false); }
    r.tunnel.answers.mini = 'signed';
    r.tunnel.view.mini = () => fl('mini').signLease(23761, new Date(r.clock.wall - 100_000).toISOString(), new Date(r.clock.wall + TTL).toISOString(), 78);
    await r.awakeStep(5_000, false);
    expect(await r.lc.acquireIfEligible()).toBe(false);
    expect(r.lc.currentHolder()).toBe('mini');
    expect(r.lc.currentEpoch()).toBe(23761);
  });
});

describe('own lapse after a stall (the former holder)', () => {
  it('a takeover made during its stall is adopted even when the first pull fails, with or without boot claim safety', async () => {
    for (const bcs of [true, false]) {
      const r = rig({ stallReconfirm: true, bootClaimSafety: bcs });
      // The Laptop holds: claim from an empty pool.
      r.tunnel.answers.studio = 'silent'; r.tunnel.answers.mini = 'silent';
      r.tunnel.view.studio = () => null; r.tunnel.view.mini = () => null;
      for (let i = 0; i < 12 && !r.lc.holdsLease(); i++) { await r.lc.acquireIfEligible(); if (!r.lc.holdsLease()) await r.awakeStep(5_000, false); }
      expect(r.lc.holdsLease()).toBe(true);
      const ours = r.lc.currentEpoch();
      // It stalls 226 s; meanwhile the Mini took over at ours+1. The first pull after wake fails.
      r.stall(226_000);
      const miniLease = () => fl('mini').signLease(ours + 1, new Date(r.clock.wall - 100_000).toISOString(), new Date(r.clock.wall + TTL).toISOString(), Math.floor(r.clock.wall / 1000));
      expect(await r.lc.acquireIfEligible()).toBe(false);
      expect(r.lc.currentEpoch()).toBe(ours); // no reclaim on the aged own copy
      r.tunnel.answers.mini = 'signed';
      r.tunnel.view.mini = miniLease;
      await r.awakeStep(5_000, false);
      expect(await r.lc.acquireIfEligible()).toBe(false);
      expect(r.lc.currentHolder()).toBe('mini');
      expect(r.lc.currentEpoch()).toBe(ours + 1);
    }
  });
});

describe('no stall: unchanged behaviour', () => {
  for (const on of [false, true]) {
    it(`switch ${on ? 'on' : 'off'}: a holder that stops renewing is taken over when its lease lapses, with no extra pull`, async () => {
      const r = rig({ stallReconfirm: on });
      await steady(r);
      r.tunnel.answers.studio = 'silent';
      r.tunnel.view.mini = () => null;
      const start = r.clock.wall;
      let claimedAt: number | null = null;
      let pullsAtClaim = 0;
      for (let i = 0; i < 40 && claimedAt === null; i++) {
        await r.awakeStep(2_000, false);
        const before = r.tunnel.pulls;
        if (await r.lc.acquireIfEligible()) { claimedAt = r.clock.wall - start; pullsAtClaim = r.tunnel.pulls - before; }
      }
      expect(claimedAt).toBe(60_000); // the last renewal folded at start, claimed the tick its lease lapses
      expect(pullsAtClaim).toBe(0);
      expect(r.lc.stallEpisodeOpen()).toBeNull();
      expect(r.logs.some((l) => l.includes('stall-reconfirm'))).toBe(false);
    });
  }

  it('a gap at the threshold (18 s at a 60 s TTL) opens nothing', async () => {
    const r = rig({ stallReconfirm: true });
    await steady(r);
    r.stall(18_000);
    expect(await r.lc.acquireIfEligible()).toBe(false);
    expect(r.lc.stallEpisodeOpen()).toBeNull();
  });

  it('a gap just over the threshold (19 s) opens an episode', async () => {
    const r = rig({ stallReconfirm: true });
    await steady(r);
    r.stall(19_000);
    expect(await r.lc.acquireIfEligible()).toBe(false);
    expect(r.lc.stallEpisodeOpen()?.gapMs).toBe(19_000);
  });

  it('a burst of shorter stalls (00:27 PST: 11-21 s drifts) adds up inside one TTL and opens one', async () => {
    const r = rig({ stallReconfirm: true });
    await steady(r);
    for (const g of [8_000, 7_000]) { r.stall(g); await r.lc.pullFromPeers(); }
    expect(r.lc.stallEpisodeOpen()).toBeNull(); // 15 s lost
    r.stall(5_000); // below the 6 s floor: ordinary scheduling
    await r.lc.pullFromPeers();
    expect(r.lc.stallEpisodeOpen()).toBeNull();
    r.stall(6_000);
    await r.lc.pullFromPeers();
    expect(r.lc.stallEpisodeOpen()?.gapMs).toBe(21_000); // 8 + 7 + 6
  });

  it('the same stalls spread over more than one TTL never add up', async () => {
    const r = rig({ stallReconfirm: true });
    await steady(r);
    for (let i = 0; i < 4; i++) {
      r.stall(14_000);
      await r.lc.pullFromPeers();
      for (let k = 0; k < 12; k++) await r.awakeStep(5_000);
    }
    expect(r.lc.stallEpisodeOpen()).toBeNull();
  });
});
