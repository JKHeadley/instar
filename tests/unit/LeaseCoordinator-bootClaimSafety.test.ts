/**
 * takeover-ready-pool R1 — LeaseCoordinator decisions under boot claim safety, with real
 * Ed25519 leases and the real LocalLeaseStore on a temp file (lease-local.json):
 *  - a restarted former holder asks its peers first even with a preferred machine named
 *    (the conjunct that made survivorMayHold() hard-false is gone);
 *  - a non-preferred machine never claims while the preferred answers, claims only after
 *    three silent probes spanning ≥45 s, and the switch off keeps today's behaviour.
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseTransport, type BootClaimSafetySettings } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { GitLeaseStore } from '../../src/core/GitLeaseStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { PeerProbeRecord, ProbeAnswer } from '../../src/core/BootClaimHold.js';
import type { LeaseRecord, MachineRegistry } from '../../src/core/types.js';

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
const FAILOVER = 15 * 60_000;
const fl = (id: string) => new FencedLease(crypt(id), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER });

/** A scripted pull-capable transport: each pull records one probe per peer at the shared clock. */
class ScriptedTransport implements LeaseTransport {
  answers: Record<string, ProbeAnswer> = {};
  leases: Record<string, LeaseRecord | null> = {};
  pulls = 0;
  private obs: LeaseRecord | null = null;
  private probes = new Map<string, PeerProbeRecord>();
  constructor(private peers: string[], private now: () => number) {}
  broadcast = async () => this.peers.some((p) => this.answers[p] === 'signed');
  observed = () => ({ lease: this.obs, lastNonceByHolder: this.obs ? { [this.obs.holder]: this.obs.nonce } : {} });
  isReachable = () => true;
  async pullAllPeers(): Promise<void> {
    this.pulls++;
    for (const p of this.peers) {
      const a = this.answers[p] ?? 'silent';
      const r = this.probes.get(p) ?? { probes: [], unsignedSinceMs: null, firstSignedAtMs: null };
      r.probes.push({ atMs: this.now(), answer: a });
      if (a === 'signed') { r.unsignedSinceMs = null; if (r.firstSignedAtMs == null) r.firstSignedAtMs = this.now(); }
      else if (a === 'unsigned' && r.unsignedSinceMs === null) r.unsignedSinceMs = this.now();
      this.probes.set(p, r);
      const l = this.leases[p];
      if (a === 'signed' && l && (!this.obs || l.epoch >= this.obs.epoch)) this.obs = l;
    }
  }
  probeHistory = () => new Map(this.probes);
  knownPeerIds = () => [...this.peers];
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'LeaseCoordinator-bootClaimSafety-test-cleanup' }); });

function rig(opts: { self: string; peers: string[]; ownLease?: (wall: number) => LeaseRecord; safety?: BootClaimSafetySettings | null; preferred?: string | null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-claim-'));
  dirs.push(dir);
  const file = path.join(dir, 'lease-local.json');
  const clock = { wall: 10_000_000, mono: 1_000 };
  if (opts.ownLease) fs.writeFileSync(file, JSON.stringify({ lease: opts.ownLease(clock.wall) }));
  const store = new LocalLeaseStore({ filePath: file });
  const tunnel = new ScriptedTransport(opts.peers, () => clock.wall);
  const logs: string[] = [];
  const preferred = opts.preferred === undefined ? 'studio' : opts.preferred;
  const lc = new LeaseCoordinator({
    lease: fl(opts.self),
    store,
    tunnel,
    presumedDeadHolders: () => new Set(),
    now: () => clock.wall,
    monotonicNow: () => clock.mono,
    // The 2026-11-20 posture: a named preferred machine makes survivorMayHold() false.
    survivorMayHold: () => !preferred,
    soloCaptainHold: () => ({ enabled: true }),
    bootClaimSafety: () => (opts.safety === undefined ? { enabled: true, preferredMachineId: preferred } : opts.safety),
    logger: (m) => logs.push(m),
  });
  const advance = (ms: number) => { clock.wall += ms; clock.mono += ms; };
  return { lc, tunnel, store, logs, advance, clock };
}

/** laptop's own lease that lapsed a while ago (lease-local.json says "holder=self, lapsed"). */
const ownLapsed = (epoch: number) => (wall: number) =>
  fl('laptop').signLease(epoch, new Date(wall - 10 * TTL).toISOString(), new Date(wall - TTL).toISOString(), 3);

describe('boot claim safety — rule 1: own lapsed lease asks first', () => {
  it('asks the peers before claiming even with a preferred machine named', async () => {
    const r = rig({ self: 'laptop', peers: ['studio'], ownLease: ownLapsed(41) });
    await r.lc.acquireIfEligible();
    expect(r.tunnel.pulls).toBeGreaterThanOrEqual(1);
  });
  it('switch off: the 2026-11-20 path — no ask, an immediate same-epoch-successor claim', async () => {
    const r = rig({ self: 'laptop', peers: ['studio'], ownLease: ownLapsed(41), safety: null });
    expect(await r.lc.acquireIfEligible()).toBe(true);
    expect(r.tunnel.pulls).toBe(0);
    expect(r.lc.currentEpoch()).toBe(42);
  });
  it('the live holder seen through the ask is adopted, never contested', async () => {
    const r = rig({ self: 'laptop', peers: ['studio'], ownLease: ownLapsed(41) });
    r.tunnel.answers.studio = 'signed';
    r.tunnel.leases.studio = fl('studio').signLease(42, new Date(r.clock.wall - 5_000).toISOString(), new Date(r.clock.wall + TTL).toISOString(), 9);
    expect(await r.lc.acquireIfEligible()).toBe(false);
    expect(r.lc.currentHolder()).toBe('studio');
    expect(r.lc.currentEpoch()).toBe(42);
    expect(r.lc.bootHoldActive()).toBe(false); // a live holder in a peer view ends the hold
  });
});

describe('boot claim safety — rules 2-4 for a non-preferred machine', () => {
  it('cannot reach the preferred for 10 s: defers (rule 2), no claim', async () => {
    const r = rig({ self: 'laptop', peers: ['studio'], ownLease: ownLapsed(41) });
    for (let t = 0; t <= 10_000; t += 5_000) {
      expect(await r.lc.acquireIfEligible()).toBe(false);
      r.advance(5_000);
    }
    expect(r.lc.holdsLease()).toBe(false);
    expect(r.logs.some((l) => l.includes('boot-hold: rule-2 defer'))).toBe(true);
  });
  it('never claims while the preferred answers and could still claim itself', async () => {
    const r = rig({ self: 'laptop', peers: ['studio'], ownLease: ownLapsed(41) });
    r.tunnel.answers.studio = 'signed'; // alive, holding nothing yet (its own boot hold)
    for (let t = 0; t <= 270_000; t += 15_000) {
      expect(await r.lc.acquireIfEligible()).toBe(false);
      r.advance(15_000);
    }
    expect(r.logs.some((l) => l.includes('boot-hold: rule-3 defer'))).toBe(true);
  });
  it('a preferred machine that answers but never claims (observe-only, held back) does not leave the pool without a holder', async () => {
    const r = rig({ self: 'laptop', peers: ['studio'], ownLease: ownLapsed(41) });
    r.tunnel.answers.studio = 'signed';
    let claimedAt: number | null = null;
    for (let t = 0; t <= 400_000 && claimedAt === null; t += 15_000) {
      if (await r.lc.acquireIfEligible()) claimedAt = t;
      else r.advance(15_000);
    }
    expect(claimedAt).not.toBeNull();
    expect(claimedAt!).toBeGreaterThan(225_000 + 45_000); // its window plus the silence span
    expect(claimedAt!).toBeLessThanOrEqual(225_000 + 45_000 + 15_000);
  });
  it('claims only once the preferred has been silent on ≥3 probes spanning ≥45 s', async () => {
    const r = rig({ self: 'laptop', peers: ['studio'], ownLease: ownLapsed(41) });
    // Each acquire pulls once (rule 1). 0 s, 22.5 s, 44.999 s: three probes, span short.
    expect(await r.lc.acquireIfEligible()).toBe(false);
    r.advance(22_500);
    expect(await r.lc.acquireIfEligible()).toBe(false);
    r.advance(22_499);
    expect(await r.lc.acquireIfEligible()).toBe(false);
    r.advance(1); // the next probe lands at 45 s
    expect(await r.lc.acquireIfEligible()).toBe(true);
    expect(r.lc.currentEpoch()).toBe(42);
    expect(r.logs.some((l) => l.includes('boot-hold: rule-4 end'))).toBe(true);
  });
  it('two silent probes over a full minute are not enough', async () => {
    const r = rig({ self: 'laptop', peers: ['studio'], ownLease: ownLapsed(41) });
    expect(await r.lc.acquireIfEligible()).toBe(false);
    r.advance(60_000);
    // Inspect without a third probe: the coordinator's verdict is still "hold".
    await r.tunnel.pullAllPeers();
    expect(r.lc.bootHoldActive()).toBe(true);
  });
  it('a wedged preferred answering unsigned 503s holds others back only for the window', async () => {
    const r = rig({ self: 'laptop', peers: ['studio'], ownLease: ownLapsed(41) });
    r.tunnel.answers.studio = 'unsigned';
    let claimedAt: number | null = null;
    const start = r.clock.wall;
    for (let i = 0; i < 80 && claimedAt === null; i++) {
      if (await r.lc.acquireIfEligible()) claimedAt = r.clock.wall - start;
      else r.advance(5_000);
    }
    expect(claimedAt).not.toBeNull();
    expect(claimedAt!).toBeGreaterThan(225_000);
    expect(claimedAt!).toBeLessThanOrEqual(225_000 + 45_000 + 10_000);
  });
  it('once the hold has ended it stays ended (later silence does not re-arm it)', async () => {
    const r = rig({ self: 'laptop', peers: ['studio'], ownLease: ownLapsed(41) });
    for (let i = 0; i < 4; i++) { await r.lc.acquireIfEligible(); r.advance(15_000); }
    expect(r.lc.bootHoldActive()).toBe(false);
    r.tunnel.answers.studio = 'signed';
    expect(r.lc.bootHoldActive()).toBe(false);
  });
});

describe('boot claim safety — the preferred machine and the no-peer case', () => {
  it('a machine with no peers claims at once (single-machine unchanged)', async () => {
    const r = rig({ self: 'laptop', peers: [] });
    expect(await r.lc.acquireIfEligible()).toBe(true);
  });
  it('the preferred machine also asks first and claims once every peer is settled', async () => {
    const r = rig({ self: 'studio', peers: ['laptop', 'mini'] });
    r.tunnel.answers.laptop = 'signed';
    r.tunnel.answers.mini = 'signed';
    expect(await r.lc.acquireIfEligible()).toBe(true);
  });
  it('the preferred machine returning adopts the survivor\'s newer epoch instead of claiming', async () => {
    const r = rig({ self: 'studio', peers: ['laptop'], ownLease: (wall) => fl('studio').signLease(41, new Date(wall - 10 * TTL).toISOString(), new Date(wall - TTL).toISOString(), 2) });
    r.tunnel.answers.laptop = 'signed';
    r.tunnel.leases.laptop = fl('laptop').signLease(42, new Date(r.clock.wall - 1_000).toISOString(), new Date(r.clock.wall + TTL).toISOString(), 4);
    expect(await r.lc.acquireIfEligible()).toBe(false);
    expect(r.lc.currentHolder()).toBe('laptop');
    expect(r.lc.currentEpoch()).toBe(42);
  });
  it('switch off: bootHoldActive() is false and nothing is logged', async () => {
    const r = rig({ self: 'laptop', peers: ['studio'], safety: { enabled: false, preferredMachineId: 'studio' } });
    expect(r.lc.bootClaimSafetyEnabled()).toBe(false);
    expect(r.lc.bootHoldActive()).toBe(false);
    expect(r.logs.some((l) => l.includes('boot-hold'))).toBe(false);
  });
});

describe('boot claim safety — only peers end the hold, never this machine\'s own copy', () => {
  it('a local record naming another machine as a live holder does not end the hold', async () => {
    const r = rig({ self: 'laptop', peers: ['studio'], ownLease: (wall) => fl('studio').signLease(42, new Date(wall - 5_000).toISOString(), new Date(wall + TTL).toISOString(), 4) });
    expect(await r.lc.acquireIfEligible()).toBe(false); // a live holder: the normal rules refuse
    expect(r.lc.bootHoldActive()).toBe(true); // …but the hold has not ended on local evidence
  });
  it('a git store with a remote: a fetched newer epoch ends the hold; with no remote the same file does not', async () => {
    for (const noRemote of [false, true]) {
      const box = { reg: { machines: {}, lease: ownLapsed(41)(10_000_000) } as unknown as MachineRegistry };
      const store = new GitLeaseStore({
        machineId: 'laptop', loadRegistry: () => JSON.parse(JSON.stringify(box.reg)), saveRegistry: (x) => { box.reg = x; },
        registryAbsPath: '/tmp/r.json', pullRebase: () => true, commitAndPush: () => false, hasNoRemote: () => noRemote,
      });
      const tunnel = new ScriptedTransport(['studio'], () => 10_000_000);
      const lc = new LeaseCoordinator({
        lease: fl('laptop'), store, tunnel, presumedDeadHolders: () => new Set(), now: () => 10_000_000, monotonicNow: () => 1,
        bootClaimSafety: () => ({ enabled: true, preferredMachineId: 'studio' }),
      });
      // What a fetch from the remote brings: studio took over at 42 (expired by now or not, it is newer).
      box.reg = { ...box.reg, lease: fl('studio').signLease(42, new Date(10_000_000 - 3 * TTL).toISOString(), new Date(10_000_000 - TTL).toISOString(), 5) } as MachineRegistry;
      expect(lc.bootHoldActive()).toBe(noRemote);
    }
  });
});

describe('boot claim safety — two machines restarting together, no preferred named', () => {
  /** Two coordinators wired to each other: each pull asks the other for its current lease. */
  it('exactly one claims; the other adopts it — no same-epoch contest', async () => {
    const clock = { wall: 20_000_000 };
    const coords: Record<string, LeaseCoordinator> = {};
    class Bridge implements LeaseTransport {
      private obs: LeaseRecord | null = null;
      private probes = new Map<string, PeerProbeRecord>();
      constructor(private self: string, private other: string) {}
      broadcast = async (l: LeaseRecord) => { (coords[this.other] as unknown as { d: { tunnel: Bridge } }).d.tunnel.receive(l); return true; };
      receive(l: LeaseRecord) { if (!this.obs || l.epoch >= this.obs.epoch) this.obs = l; }
      observed = () => ({ lease: this.obs, lastNonceByHolder: {} });
      isReachable = () => true;
      async pullAllPeers() {
        const r = this.probes.get(this.other) ?? { probes: [], unsignedSinceMs: null, firstSignedAtMs: null };
        r.probes.push({ atMs: clock.wall, answer: 'signed' });
        if (r.firstSignedAtMs == null) r.firstSignedAtMs = clock.wall;
        this.probes.set(this.other, r);
        const l = coords[this.other]?.currentLease();
        if (l && l.holder === this.other) this.receive(l);
      }
      probeHistory = () => new Map(this.probes);
      knownPeerIds = () => [this.other];
    }
    for (const [self, other] of [['laptop', 'mini'], ['mini', 'laptop']] as const) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-claim-pair-'));
      dirs.push(dir);
      const file = path.join(dir, 'lease-local.json');
      // Both held at some point; both records are stale at epoch 41.
      fs.writeFileSync(file, JSON.stringify({ lease: fl(self).signLease(41, new Date(clock.wall - 10 * TTL).toISOString(), new Date(clock.wall - TTL).toISOString(), 1) }));
      coords[self] = new LeaseCoordinator({
        lease: fl(self), store: new LocalLeaseStore({ filePath: file }), tunnel: new Bridge(self, other),
        presumedDeadHolders: () => new Set(), now: () => clock.wall, monotonicNow: () => clock.wall,
        bootClaimSafety: () => ({ enabled: true, preferredMachineId: null }),
      });
    }
    const [a, b] = await Promise.all([coords.laptop.acquireIfEligible(), coords.mini.acquireIfEligible()]);
    expect(a).toBe(true);
    expect(b).toBe(false);
    clock.wall += 5_000;
    expect(await coords.mini.acquireIfEligible()).toBe(false);
    expect(coords.mini.currentHolder()).toBe('laptop');
    expect(coords.laptop.currentEpoch()).toBe(42);
    expect(coords.mini.currentEpoch()).toBe(42);
  });
});
